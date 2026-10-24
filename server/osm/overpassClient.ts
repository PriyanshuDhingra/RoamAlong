import type { GeoPoint, RawOsmPoi, TourTopic } from "../../shared/types.js";
import { classifySector } from "../../shared/geo.js";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

const EXCLUDED_AMENITIES = new Set([
  "parking",
  "parking_entrance",
  "bicycle_parking",
  "bench",
  "waste_basket",
  "recycling",
  "toilets",
  "atm",
  "bank",
  "pharmacy",
  "dentist",
  "doctors",
  "clinic",
  "post_box",
  "vending_machine",
  "telephone",
  "charging_station",
  "fast_food",
  "fuel",
]);

function isTourWorthyPoi(tags: Record<string, string>): boolean {
  if (tags.amenity && EXCLUDED_AMENITIES.has(tags.amenity)) {
    return false;
  }
  if (
    tags.historic ||
    tags.heritage ||
    tags.memorial ||
    tags.wikipedia ||
    tags.wikidata ||
    tags["building:architecture"] ||
    tags.architect
  ) {
    return true;
  }
  if (
    tags.tourism &&
    ["attraction", "museum", "gallery", "artwork", "viewpoint"].includes(
      tags.tourism
    )
  ) {
    return true;
  }
  if (
    tags.amenity &&
    [
      "place_of_worship",
      "theatre",
      "arts_centre",
      "music_venue",
      "marketplace",
      "cafe",
      "restaurant",
      "bakery",
      "pub",
      "bar",
      "library",
      "university",
      "college",
    ].includes(tags.amenity)
  ) {
    return true;
  }
  if (tags.leisure && ["park", "garden", "nature_reserve"].includes(tags.leisure)) {
    return true;
  }
  if (
    tags.building &&
    tags.building !== "yes" &&
    tags.building !== "residential" &&
    tags.building !== "garage" &&
    Boolean(tags.name) &&
    looksLikeLandmarkName(tags)
  ) {
    return true;
  }
  return false;
}

function inferCategoryFromTags(tags: Record<string, string>): TourTopic {
  if (
    tags.historic ||
    tags.heritage ||
    tags["historic:civilization"] ||
    tags.memorial
  ) {
    return "history";
  }
  if (
    tags["building:architecture"] ||
    tags.architect ||
    tags.building === "cathedral" ||
    tags.building === "church" ||
    tags.building === "synagogue" ||
    tags.building === "temple" ||
    tags.building === "civic" ||
    tags.building === "university" ||
    tags.building === "public"
  ) {
    return "architecture";
  }
  if (
    tags.tourism === "museum" ||
    tags.tourism === "gallery" ||
    tags.tourism === "artwork" ||
    tags.artwork_type ||
    tags.amenity === "arts_centre"
  ) {
    return "art";
  }
  if (
    tags.man_made === "bridge" ||
    tags.man_made === "tower" ||
    tags.man_made === "water_tower" ||
    tags.man_made === "lighthouse" ||
    tags.bridge ||
    tags.industrial
  ) {
    return "engineering";
  }
  if (
    tags.amenity === "restaurant" ||
    tags.amenity === "cafe" ||
    tags.amenity === "bakery" ||
    tags.amenity === "bar" ||
    tags.amenity === "pub" ||
    tags.amenity === "marketplace" ||
    tags.shop === "bakery" ||
    tags.shop === "coffee" ||
    tags.shop === "deli" ||
    tags.cuisine
  ) {
    return "food";
  }
  if (
    tags.natural ||
    tags.leisure === "park" ||
    tags.leisure === "garden" ||
    tags.tourism === "viewpoint" ||
    tags.geological
  ) {
    return "nature";
  }
  if (
    tags.amenity === "music_venue" ||
    tags.amenity === "theatre" ||
    tags.amenity === "nightclub" ||
    tags.club === "music" ||
    tags.music
  ) {
    return "music";
  }
  return "trivia";
}

/**
 * Fetches all tour-worthy POIs and building polygons within `radiusMeters` of `origin` using:
 * 1. Official OpenStreetMap REST API v0.6 (`https://api.openstreetmap.org/api/0.6/map.json?bbox=...`) — ~800ms, CDN-backed, includes full building footprint geometry.
 * 2. Indexed Overpass bbox query if the primary OSM v0.6 endpoint returns an error.
 * Throws a transparent error if all endpoints fail.
 */
export async function fetchOverpassPoisBatch(
  origin: GeoPoint,
  radiusMeters = 320,
  options?: { skipFullMap?: boolean; timeoutMs?: number }
): Promise<RawOsmPoi[]> {
  const lat = Number(origin.lat.toFixed(6));
  const lon = Number(origin.lon.toFixed(6));
  const dLat = Number((radiusMeters / 111320).toFixed(5));
  const dLon = Number(
    (radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180))).toFixed(5)
  );

  const errors: string[] = [];
  const endpoints = OVERPASS_ENDPOINTS;
  const overpassTimeoutMs = options?.timeoutMs ?? 14000;

  // 1. Primary: Official OpenStreetMap API v0.6 bbox JSON (<900ms, never rate-limited like Overpass QL)
  // A tour plan skips this. A downtown bbox is a huge download and the guide sits silent until it finishes.
  const osmBbox = `${(lon - dLon).toFixed(5)},${(lat - dLat).toFixed(5)},${(
    lon + dLon
  ).toFixed(5)},${(lat + dLat).toFixed(5)}`;
  const osmApiUrl = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${osmBbox}`;

  if (!options?.skipFullMap) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(osmApiUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "HandheldBosonTour/1.0 (Hackathon Audio Guide)",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      const json = (await res.json()) as { elements?: OsmElement[] };
      const elements = json.elements ?? [];
      const pois = parseOsmElementsWithNodeIndex(origin, elements);
      if (pois.length > 0) {
        return pois;
      }
    } else {
      errors.push(`api.openstreetmap.org returned HTTP ${res.status}`);
    }
  } catch (err) {
    errors.push(
      `api.openstreetmap.org failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  }

  // 2. Secondary: Indexed BBox Overpass QL across mirrors
  const overpassBbox = `${(lat - dLat).toFixed(5)},${(lon - dLon).toFixed(
    5
  )},${(lat + dLat).toFixed(5)},${(lon + dLon).toFixed(5)}`;
  const query = `
[out:json][timeout:15][bbox:${overpassBbox}];
(
  node["historic"];
  way["historic"];
  node["tourism"];
  way["tourism"];
  node["wikipedia"];
  way["wikipedia"];
  node["amenity"="cafe"];
  node["amenity"="restaurant"];
  node["amenity"="pub"];
  node["amenity"="place_of_worship"];
  node["leisure"="park"];
  way["leisure"="park"];
);
out center tags 120;
`.trim();

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), overpassTimeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "HandheldBosonTour/1.0 (Hackathon Audio Guide)",
        },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        errors.push(`${endpoint} returned HTTP ${res.status}`);
        continue;
      }

      const json = (await res.json()) as { elements?: OsmElement[] };
      const elements = json.elements ?? [];
      return parseOsmElementsWithNodeIndex(origin, elements);
    } catch (err) {
      errors.push(
        `${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `OpenStreetMap spatial query failed across all endpoints: ${errors.join(
      "; "
    )}`
  );
}

const SERVICE_WORDS =
  /\b(caretaking|maintenance|facilities|services|facility|storage|parking|garage|loading|plant|utility|utilities|substation|shed|annex|annexe|portable|trailer|mechanical|boiler|office)\b/i;

/**
 * Named university/commercial buildings include back-of-house names like "Caretaking" that are not landmarks.
 * A building without a notability tag needs a multi-word, non-service name to count.
 */
function looksLikeLandmarkName(tags: Record<string, string>): boolean {
  if (tags.wikidata || tags.wikipedia || tags.historic || tags.heritage || tags.tourism) return true;
  const name = (tags["name:en"] || tags.name || "").trim();
  if (SERVICE_WORDS.test(name)) return false;
  return name.split(/\s+/).length >= 2;
}

function parseOsmElementsWithNodeIndex(
  origin: GeoPoint,
  elements: OsmElement[]
): RawOsmPoi[] {
  // Build O(1) coordinate lookup table for all nodes in the response so ways get exact centroids + footprints
  const nodeCoords = new Map<number, GeoPoint>();
  for (const el of elements) {
    if (
      el.type === "node" &&
      typeof el.lat === "number" &&
      typeof el.lon === "number"
    ) {
      nodeCoords.set(el.id, { lat: el.lat, lon: el.lon });
    }
  }

  const seenNames = new Set<string>();
  const results: RawOsmPoi[] = [];

  for (const el of elements) {
    const tags = el.tags;
    if (!tags || !isTourWorthyPoi(tags)) continue;

    const name = tags["name:en"] || tags.name;
    if (!name || name.trim().length < 2) continue;

    const normName = name.trim().toLowerCase();
    if (seenNames.has(normName)) continue;

    let lat = el.lat ?? el.center?.lat;
    let lon = el.lon ?? el.center?.lon;
    let geometry: GeoPoint[] | undefined;

    if (el.geometry && el.geometry.length >= 3) {
      geometry = el.geometry.map((pt) => ({ lat: pt.lat, lon: pt.lon }));
      if (typeof lat !== "number" || typeof lon !== "number") {
        lat = geometry[0].lat;
        lon = geometry[0].lon;
      }
    } else if (el.nodes && el.nodes.length > 0) {
      const resolvedPts = el.nodes
        .map((id) => nodeCoords.get(id))
        .filter((pt): pt is GeoPoint => pt !== undefined);
      if (resolvedPts.length > 0) {
        const sum = resolvedPts.reduce(
          (acc, p) => ({ lat: acc.lat + p.lat, lon: acc.lon + p.lon }),
          { lat: 0, lon: 0 }
        );
        lat = sum.lat / resolvedPts.length;
        lon = sum.lon / resolvedPts.length;
        if (resolvedPts.length >= 3) {
          geometry = resolvedPts;
        }
      }
    }

    if (typeof lat !== "number" || typeof lon !== "number") continue;

    seenNames.add(normName);

    const { distanceMeters, bearingDeg, sector } = classifySector(origin, {
      lat,
      lon,
    });

    results.push({
      osmId: `${el.type}/${el.id}`,
      osmType: el.type,
      name: name.trim(),
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      category: inferCategoryFromTags(tags),
      tags,
      geometry,
      wikipediaTag: tags.wikipedia,
      wikidataId: tags.wikidata,
      distanceMeters: Math.round(distanceMeters),
      bearingDeg: Math.round(bearingDeg),
      sector,
    });
  }

  return results.sort((a, b) => {
    const scoreA =
      (a.wikipediaTag || a.wikidataId ? 35 : 0) +
      (a.tags.historic || a.tags.memorial ? 25 : 0) +
      (a.tags.architect || a.tags["building:architecture"] ? 25 : 0) +
      (a.tags.start_date ? 15 : 0) +
      (a.geometry ? 10 : 0);
    const scoreB =
      (b.wikipediaTag || b.wikidataId ? 35 : 0) +
      (b.tags.historic || b.tags.memorial ? 25 : 0) +
      (b.tags.architect || b.tags["building:architecture"] ? 25 : 0) +
      (b.tags.start_date ? 15 : 0) +
      (b.geometry ? 10 : 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (a.distanceMeters ?? 999) - (b.distanceMeters ?? 999);
  });
}
