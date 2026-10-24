import type { GeoPoint } from "../../shared/types.js";

export interface ReverseGeocodeResult {
  currentStreet: string;
  neighborhood: string;
  city: string;
  countryCode: string;
  displayName: string;
}

const reverseGeocodeCache = new Map<string, ReverseGeocodeResult>();

export async function reverseGeocodeOsm(
  point: GeoPoint
): Promise<ReverseGeocodeResult> {
  const key = `${point.lat.toFixed(4)}_${point.lon.toFixed(4)}`;
  const cached = reverseGeocodeCache.get(key);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${point.lat}&lon=${point.lon}&zoom=18&addressdetails=1`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "RoamAlong/1.0 (Hackathon Audio Guide)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(
        `Nominatim reverse geocode failed with HTTP ${res.status} for (${point.lat}, ${point.lon})`
      );
    }

    const data = (await res.json()) as {
      display_name?: string;
      address?: Record<string, string>;
    };
    const addr = data.address ?? {};
    const result: ReverseGeocodeResult = {
      currentStreet:
        addr.road ||
        addr.pedestrian ||
        addr.footway ||
        addr.square ||
        addr.neighbourhood ||
        "Unnamed Street",
      neighborhood:
        addr.neighbourhood ||
        addr.suburb ||
        addr.quarter ||
        addr.city_district ||
        addr.borough ||
        "Downtown",
      city:
        addr.city ||
        addr.town ||
        addr.village ||
        addr.municipality ||
        addr.county ||
        "Unknown City",
      countryCode: (addr.country_code || "CA").toUpperCase(),
      displayName:
        data.display_name || `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`,
    };
    reverseGeocodeCache.set(key, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchPlaceNominatim(
  query: string
): Promise<{ name: string; lat: number; lon: number }[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
    query
  )}&limit=5`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "RoamAlong/1.0 (Hackathon Audio Guide)",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Nominatim search failed with HTTP ${res.status}`);
  }
  const items = (await res.json()) as {
    display_name: string;
    lat: string;
    lon: string;
  }[];
  return items.map((i) => ({
    name: i.display_name,
    lat: Number(i.lat),
    lon: Number(i.lon),
  }));
}

export interface OsrmWalkingLeg {
  polyline: GeoPoint[];
  totalDistanceMeters: number;
  estimatedDurationMinutes: number;
  steps: {
    instruction: string;
    streetName: string;
    distanceMeters: number;
    bearingDeg: number;
    location: GeoPoint;
  }[];
}

export async function fetchOsrmWalkingRoute(
  waypoints: GeoPoint[]
): Promise<OsrmWalkingLeg> {
  if (waypoints.length < 2) {
    return {
      polyline: waypoints,
      totalDistanceMeters: 0,
      estimatedDurationMinutes: 0,
      steps: [],
    };
  }

  const coordsString = waypoints
    .map((pt) => `${pt.lon.toFixed(6)},${pt.lat.toFixed(6)}`)
    .join(";");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  try {
    // router.project-osrm.org only serves the car profile; FOSSGIS hosts the real pedestrian graph
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coordsString}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`OSRM routing failed with HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      routes?: {
        distance: number;
        duration: number;
        geometry?: { coordinates: [number, number][] };
        legs?: {
          steps?: {
            distance: number;
            name: string;
            maneuver?: {
              type?: string;
              modifier?: string;
              bearing_after?: number;
              location?: [number, number];
            };
          }[];
        }[];
      }[];
    };

    const route = data.routes?.[0];
    if (!route) {
      throw new Error("OSRM returned no walking route for waypoints");
    }

    const polyline: GeoPoint[] = (route.geometry?.coordinates ?? []).map(
      ([lon, lat]) => ({ lat, lon })
    );
    const steps =
      route.legs?.flatMap((leg) =>
        (leg.steps ?? []).map((s) => {
          const loc = s.maneuver?.location;
          const modifier = s.maneuver?.modifier
            ? ` (${s.maneuver.modifier})`
            : "";
          return {
            instruction: `${s.maneuver?.type ?? "continue"}${modifier} onto ${
              s.name || "the walkway"
            }`,
            streetName: s.name || "walkway",
            distanceMeters: Math.round(s.distance),
            bearingDeg: s.maneuver?.bearing_after ?? 0,
            location: loc
              ? { lat: loc[1], lon: loc[0] }
              : waypoints[0],
          };
        })
      ) ?? [];

    return {
      polyline: polyline.length > 0 ? polyline : waypoints,
      totalDistanceMeters: Math.round(route.distance),
      estimatedDurationMinutes: Math.max(1, Math.round(route.duration / 60)),
      steps,
    };
  } finally {
    clearTimeout(timer);
  }
}
