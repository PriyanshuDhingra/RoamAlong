import React, { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  GeoPoint,
  MapHighlightAction,
  QuadrantSector,
  SpatialHeartbeatResponse,
  StoryCard,
  TourRoute,
} from "../../../shared/types.js";
import { movePointByMeters } from "../../../shared/geo.js";
import {
  LocationManager,
  type LocationSnapshot,
} from "../location/LocationManager.js";

export interface MinimalMapProps {
  location: LocationSnapshot;
  locationManager: LocationManager;
  heartbeat: SpatialHeartbeatResponse | null;
  highlights: MapHighlightAction[];
  activeRoute: TourRoute | null;
  walkPath: GeoPoint[] | null;
  showQuadrantOverlay: boolean;
  onMapClickTeleport: (lat: number, lon: number) => void;
  onSelectStory: (story: StoryCard) => void;
}

function createUserLocationElement(): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "user-loc";
  for (const part of ["user-loc-beam", "user-loc-pulse", "user-loc-dot"]) {
    const el = document.createElement("div");
    el.className = part;
    root.appendChild(el);
  }
  return root;
}

const SECTOR_COLORS: Record<QuadrantSector, string> = {
  CENTER: "#f59e0b",
  NORTH: "#38bdf8",
  EAST: "#a78bfa",
  SOUTH: "#34d399",
  WEST: "#fb7185",
};

/**
 * Builds a closed GeoJSON Polygon ring around a center point if an OSM building footprint polygon
 * is not explicitly attached, so even point-based POIs extrude as a clean 3D architectural volume.
 */
function buildOctagonFootprint(
  center: GeoPoint,
  radiusMeters = 18
): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const pt = movePointByMeters(center, (i * 45) % 360, radiusMeters);
    ring.push([pt.lon, pt.lat]);
  }
  return ring;
}

function footprintForHighlight(highlight: MapHighlightAction): {
  ring: [number, number][];
  heightM: number;
} {
  const center = { lat: highlight.lat, lon: highlight.lon };
  const isPlace =
    highlight.targetType === "building" || highlight.targetType === "neighborhood";
  const geometry = highlight.geometry;
  if (isPlace && geometry && geometry.length >= 3 && isCompactFootprint(geometry)) {
    return {
      ring: ensureClosedLonLatRing(geometry),
      heightM: highlight.targetType === "neighborhood" ? 8 : 18,
    };
  }
  return {
    ring: buildOctagonFootprint(
      center,
      highlight.targetType === "neighborhood" ? 45 : 16
    ),
    heightM: 28,
  };
}

function isCompactFootprint(geometry: GeoPoint[]): boolean {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const point of geometry) {
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLon = Math.min(minLon, point.lon);
    maxLon = Math.max(maxLon, point.lon);
  }
  const heightM = (maxLat - minLat) * 111_320;
  const widthM = (maxLon - minLon) * 111_320 * Math.cos((minLat * Math.PI) / 180);
  return heightM < 180 && widthM < 180;
}

function ensureClosedLonLatRing(geometry: GeoPoint[]): [number, number][] {
  const ring: [number, number][] = geometry.map((p) => [p.lon, p.lat]);
  if (ring.length > 0) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([first[0], first[1]]);
    }
  }
  return ring;
}

export const MinimalMap: React.FC<MinimalMapProps> = ({
  location,
  locationManager,
  heartbeat,
  highlights,
  activeRoute,
  walkPath,
  showQuadrantOverlay,
  onMapClickTeleport,
  onSelectStory,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleLoadedRef = useRef(false);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const stopMarkersRef = useRef<maplibregl.Marker[]>([]);
  const lastHighlightKeyRef = useRef<string>("");
  const followPausedUntilRef = useRef(0);
  const liveLocationRef = useRef(location);
  const syncRef = useRef<() => void>(() => {});

  const onMapClickRef = useRef(onMapClickTeleport);
  onMapClickRef.current = onMapClickTeleport;
  const onSelectStoryRef = useRef(onSelectStory);
  onSelectStoryRef.current = onSelectStory;

  // Initialize MapLibre GL 3D Vector Map (OpenFreeMap Dark Vector Tiles — 100% free, no API key)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [location.lon, location.lat],
      zoom: 16.4,
      pitch: 45,
      bearing: 0,
      attributionControl: false,
    });

    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "bottom-right"
    );

    map.on("click", (e: maplibregl.MapMouseEvent) => {
      onMapClickRef.current(e.lngLat.lat, e.lngLat.lng);
    });

    map.on("load", () => {
      styleLoadedRef.current = true;
      const here = liveLocationRef.current;
      map.setCenter([here.lon, here.lat]);

      // Positron already draws flat building footprints. No extrusion.
      map.addSource("tour-route-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "tour-route-casing",
        type: "line",
        source: "tour-route-source",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "tour-route-line",
        type: "line",
        source: "tour-route-source",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#111111", "line-width": 5 },
      });

      // 3. Street-following walking route to the next spot (navigation-app blue with white casing)
      map.addSource("walk-route-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "walk-route-casing",
        type: "line",
        source: "walk-route-source",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": 9,
          "line-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "walk-route-line",
        type: "line",
        source: "walk-route-source",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#111111",
          "line-width": 5,
        },
      });

      // One raised highlight for the place being talked about
      map.addSource("spotlight-3d-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "spotlight-extrusion",
        type: "fill-extrusion",
        source: "spotlight-3d-source",
        paint: {
          "fill-extrusion-color": "#FF385C",
          "fill-extrusion-opacity": 0.85,
          "fill-extrusion-height": ["coalesce", ["get", "height_m"], 14],
          "fill-extrusion-base": 0,
        },
      });

      // 5. Optional N/S/E/W Quadrant Debug Layer (only visible when showQuadrantOverlay is true)
      map.addSource("quadrant-debug-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "quadrant-debug-circles",
        type: "circle",
        source: "quadrant-debug-source",
        paint: {
          "circle-radius": 6,
          "circle-color": ["get", "color"],
          "circle-stroke-color": "#0f172a",
          "circle-stroke-width": 1.5,
        },
      });

      syncRef.current();
    });

    // Apple/Google-style blue location dot: lies flat on the map and rotates with the walker's heading
    userMarkerRef.current = new maplibregl.Marker({
      element: createUserLocationElement(),
      rotationAlignment: "map",
      pitchAlignment: "viewport",
    })
      .setLngLat([location.lon, location.lat])
      .setRotation(location.headingDeg)
      .addTo(map);

    mapRef.current = map;

    return () => {
      styleLoadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    return locationManager.subscribe((snap) => {
      liveLocationRef.current = snap;
      userMarkerRef.current
        ?.setLngLat([snap.lon, snap.lat])
        .setRotation(snap.headingDeg);
      const map = mapRef.current;
      if (!map || !styleLoadedRef.current) return;
      if (Date.now() <= followPausedUntilRef.current) return;
      map.stop();
      map.setCenter([snap.lon, snap.lat]);
    });
  }, [locationManager]);

  const syncAllLayers = () => {
    const map = mapRef.current;
    if (!map || !styleLoadedRef.current) return;

    // The user dot and camera follow LocationManager directly.
    // B. Update Walking Route to the Next Spot
    const walkSource = map.getSource(
      "walk-route-source"
    ) as maplibregl.GeoJSONSource | undefined;
    walkSource?.setData({
      type: "FeatureCollection",
      features:
        walkPath && walkPath.length >= 2
          ? [
              {
                type: "Feature",
                properties: {},
                geometry: {
                  type: "LineString",
                  coordinates: walkPath.map((p) => [p.lon, p.lat]),
                },
              },
            ]
          : [],
    });

    // C. One 3D highlight. A building footprint is extruded once. A walking
    // line is not also filled, so the route and the place are not drawn twice.
    const spotlight3dSource = map.getSource(
      "spotlight-3d-source"
    ) as maplibregl.GeoJSONSource | undefined;

    spotlight3dSource?.setData({
      type: "FeatureCollection",
      features: highlights.map((item) => {
        const footprint = footprintForHighlight(item);
        return {
          type: "Feature" as const,
          properties: { name: item.label, height_m: footprint.heightM },
          geometry: {
            type: "Polygon" as const,
            coordinates: [footprint.ring],
          },
        };
      }),
    });

    // D. Update Guided Tour Route Polyline & Stop Badges
    const routeSource = map.getSource(
      "tour-route-source"
    ) as maplibregl.GeoJSONSource | undefined;
    stopMarkersRef.current.forEach((m) => m.remove());
    stopMarkersRef.current = [];

    if (activeRoute && activeRoute.polyline.length >= 2) {
      routeSource?.setData({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: activeRoute.polyline.map((p) => [p.lon, p.lat]),
            },
          },
        ],
      });

      activeRoute.stops.forEach((stop, idx) => {
        const isCurrent = idx === activeRoute.currentStopIndex;
        const badge = document.createElement("div");
        badge.textContent = `${stop.order}`;
        badge.style.width = isCurrent ? "30px" : "24px";
        badge.style.height = isCurrent ? "30px" : "24px";
        badge.style.borderRadius = "50%";
        badge.style.display = "flex";
        badge.style.alignItems = "center";
        badge.style.justifyContent = "center";
        badge.style.fontSize = "13px";
        badge.style.fontWeight = "700";
        badge.style.cursor = "pointer";
        badge.style.color = "#ffffff";
        badge.style.background = stop.visited
          ? "#B0B0B0"
          : isCurrent
          ? "#FF385C"
          : "#111111";
        badge.style.border = "3px solid #ffffff";
        badge.style.boxShadow = "none";
        badge.title = `#${stop.order} ${stop.poi.name}`;
        badge.onclick = (ev) => {
          ev.stopPropagation();
          onSelectStoryRef.current(stop.poi);
        };

        const m = new maplibregl.Marker({ element: badge })
          .setLngLat([stop.poi.lon, stop.poi.lat])
          .addTo(map);
        stopMarkersRef.current.push(m);
      });
    } else {
      routeSource?.setData({ type: "FeatureCollection", features: [] });
    }

    // E. Update Optional N/S/E/W Quadrant Inspector Dots
    const quadSource = map.getSource(
      "quadrant-debug-source"
    ) as maplibregl.GeoJSONSource | undefined;
    if (heartbeat && showQuadrantOverlay) {
      const features = Object.values(heartbeat.sectors).flatMap((sec) =>
        sec.stories.map((story) => ({
          type: "Feature" as const,
          properties: {
            name: story.name,
            sector: sec.sector,
            color: SECTOR_COLORS[sec.sector],
          },
          geometry: {
            type: "Point" as const,
            coordinates: [story.lon, story.lat],
          },
        }))
      );
      quadSource?.setData({ type: "FeatureCollection", features });
    } else {
      quadSource?.setData({ type: "FeatureCollection", features: [] });
    }
  };
  syncRef.current = syncAllLayers;

  // Sync layers and tilt the camera so the raised highlight stays in view.
  useEffect(() => {
    syncAllLayers();

    const map = mapRef.current;
    if (!map || !styleLoadedRef.current) return;

    const highlightKey = highlights
      .map((item) => item.osmId || item.label)
      .join("|");

    if (highlights.length > 0 && highlightKey !== lastHighlightKeyRef.current) {
      lastHighlightKeyRef.current = highlightKey;
      followPausedUntilRef.current = Date.now() + 15000;
      const here = liveLocationRef.current;
      const bounds = new maplibregl.LngLatBounds(
        [here.lon, here.lat],
        [here.lon, here.lat]
      );
      for (const item of highlights) bounds.extend([item.lon, item.lat]);
      map.fitBounds(bounds, {
        padding: { top: 130, bottom: 300, left: 40, right: 40 },
        pitch: 45,
        bearing: 0,
        duration: 700,
        maxZoom: 17,
      });
    }
  }, [highlights, activeRoute, walkPath, heartbeat, showQuadrantOverlay]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        background: "#f2efe9",
      }}
    />
  );
};
