import type {
  GeoPoint,
  StoryCard,
  TourTopic,
  UserCalibrationProfile,
} from "../../shared/types.js";
import {
  bearingDegrees,
  classifySector,
  haversineMeters,
  relativeClockAndDirection,
} from "../../shared/geo.js";
import { reverseGeocodeOsm } from "../osm/nominatimAndOsrm.js";
import { fetchWikipediaSummaryByTag } from "./wikipediaClient.js";
import { savePersistedPoiStory } from "../cache/persistentStore.js";
import { callAzureJsonModel, getAzureConfig } from "./azureSynthesizer.js";

export interface OnDemandResearchRequest {
  query: string;
  questionType?: "reviews_and_menu" | "history_and_facts" | "nearby_search";
  lat: number;
  lon: number;
  headingDeg: number;
  profile: UserCalibrationProfile;
}

export interface OnDemandResearchResponse {
  foundInOsm: boolean;
  placeName: string;
  lat: number;
  lon: number;
  distanceMeters: number;
  relativeDirection: string;
  clockPosition: string;
  category: TourTopic;
  address?: string;
  openingHours?: string;
  cuisine?: string;
  website?: string;
  answerSummary: string;
  reviewAndVibeSynthesis: string;
  suggestWebSearchQuery?: string;
  storyCard: StoryCard;
}

interface OverpassHit {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Performs a live on-demand lookup when the user asks about a specific restaurant, building,
 * review, or fact that was NOT covered by the prefetched 4-quadrant cache.
 * Throws transparently if Azure OpenAI or Nominatim fails.
 */
export async function runOnDemandPlaceResearch(
  req: OnDemandResearchRequest
): Promise<OnDemandResearchResponse> {
  const origin: GeoPoint = { lat: req.lat, lon: req.lon };
  const geo = await reverseGeocodeOsm(origin);
  const cleanQuery = req.query.trim();
  if (!cleanQuery) {
    throw new Error("On-demand research requires a non-empty query string.");
  }

  const osmHit = await searchTargetedOverpass(origin, cleanQuery, 600);
  const wiki = await fetchWikipediaSummaryByTag(`en:${cleanQuery}`);

  const targetLat = osmHit?.lat ?? wiki?.lat ?? origin.lat;
  const targetLon = osmHit?.lon ?? wiki?.lon ?? origin.lon;
  const targetPoint: GeoPoint = { lat: targetLat, lon: targetLon };

  const distanceMeters = Math.round(haversineMeters(origin, targetPoint));
  const bearing = Math.round(bearingDegrees(origin, targetPoint));
  const { clockPosition, relativeDirection } = relativeClockAndDirection(
    req.headingDeg,
    bearing
  );
  const { sector } = classifySector(origin, targetPoint);

  const tags = osmHit?.tags ?? {};
  const placeName = tags["name:en"] || tags.name || wiki?.title || cleanQuery;
  const cuisine = tags.cuisine?.replace(/;/g, ", ");
  const openingHours = tags.opening_hours;
  const website = tags.website || tags["contact:website"];
  const address = tags["addr:street"]
    ? `${tags["addr:housenumber"] ?? ""} ${tags["addr:street"]}`.trim()
    : geo.currentStreet;

  const category: TourTopic =
    req.questionType === "reviews_and_menu" ||
    tags.amenity === "restaurant" ||
    tags.amenity === "cafe" ||
    tags.amenity === "bar" ||
    tags.cuisine
      ? "food"
      : tags.historic
      ? "history"
      : tags["building:architecture"] || tags.architect
      ? "architecture"
      : "trivia";

  const synthesized = await synthesizeOnDemandAnswer({
    placeName,
    query: cleanQuery,
    questionType: req.questionType ?? "history_and_facts",
    neighborhood: geo.neighborhood,
    city: geo.city,
    tags,
    wikiExtract: wiki?.extract,
    profile: req.profile,
  });

  const storyCard: StoryCard = {
    id: `ondemand_${osmHit?.id ?? Date.now()}`,
    osmId: osmHit ? `${osmHit.type}/${osmHit.id}` : `ondemand/${Date.now()}`,
    name: placeName,
    lat: targetLat,
    lon: targetLon,
    sector,
    categories: [category],
    sensoryHook: synthesized.sensoryHook,
    narrativeSummary: synthesized.answerSummary,
    hiddenTrivia: synthesized.reviewAndVibeSynthesis,
    followUpQuestion: synthesized.followUpQuestion,
    address,
    wikipediaUrl: wiki?.url,
    score: 92,
  };

  const profileKey = `${[...req.profile.topics].sort().join(",")}:${
    req.profile.story_style
  }`;
  savePersistedPoiStory(`${storyCard.osmId}:${profileKey}`, storyCard);
  savePersistedPoiStory(`ondemand:${cleanQuery.toLowerCase()}`, storyCard);

  return {
    foundInOsm: Boolean(osmHit),
    placeName,
    lat: targetLat,
    lon: targetLon,
    distanceMeters,
    relativeDirection,
    clockPosition,
    category,
    address,
    openingHours,
    cuisine,
    website,
    answerSummary: synthesized.answerSummary,
    reviewAndVibeSynthesis: synthesized.reviewAndVibeSynthesis,
    suggestWebSearchQuery: `${placeName} ${geo.neighborhood} ${geo.city} Google Maps reviews ratings popular dishes`,
    storyCard,
  };
}

async function searchTargetedOverpass(
  origin: GeoPoint,
  queryText: string,
  _radiusMeters: number
): Promise<{
  type: "node" | "way" | "relation";
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
} | null> {
  // Use Nominatim's indexed bounded viewbox search (~1km around walker) with extratags & addressdetails
  const d = 0.012;
  const viewbox = `${origin.lon - d},${origin.lat + d},${origin.lon + d},${
    origin.lat - d
  }`;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(
    queryText
  )}&viewbox=${viewbox}&bounded=1&extratags=1&addressdetails=1&limit=3`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "RoamAlong/1.0 (Hackathon Audio Guide)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(
        `Nominatim bounded place search failed with HTTP ${res.status}`
      );
    }

    const items = (await res.json()) as {
      osm_type?: "node" | "way" | "relation";
      osm_id?: number;
      lat?: string;
      lon?: string;
      name?: string;
      category?: string;
      type?: string;
      address?: Record<string, string>;
      extratags?: Record<string, string>;
    }[];

    const hit = items[0];
    if (!hit || !hit.lat || !hit.lon) return null;

    const tags: Record<string, string> = {
      ...(hit.extratags ?? {}),
      name: hit.name || queryText,
    };
    if (hit.category && hit.type) {
      tags[hit.category] = hit.type;
    }
    if (hit.address?.road) {
      tags["addr:street"] = hit.address.road;
    }
    if (hit.address?.house_number) {
      tags["addr:housenumber"] = hit.address.house_number;
    }

    return {
      type: hit.osm_type || "node",
      id: hit.osm_id || Date.now(),
      lat: Number(hit.lat),
      lon: Number(hit.lon),
      tags,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function synthesizeOnDemandAnswer(params: {
  placeName: string;
  query: string;
  questionType: string;
  neighborhood: string;
  city: string;
  tags: Record<string, string>;
  wikiExtract?: string;
  profile: UserCalibrationProfile;
}): Promise<{
  sensoryHook: string;
  answerSummary: string;
  reviewAndVibeSynthesis: string;
  followUpQuestion: string;
}> {
  const azure = getAzureConfig();
  const content = await callAzureJsonModel({
    azure,
    systemPrompt:
      "You are an on-demand local research agent for a live walking tour. Use web_search to find real reviews, popular dishes, ratings, and historical facts. Synthesize a concise spoken answer (2-3 sentences), local review/vibe consensus, a visual sensory hook, and a follow-up question. Return ONLY a JSON object with keys: sensoryHook, answerSummary, reviewAndVibeSynthesis, followUpQuestion.",
    userPayload: params,
    useWebSearch: true,
    timeoutMs: 25000,
  });

  const parsed = JSON.parse(content) as {
    sensoryHook?: string;
    answerSummary?: string;
    reviewAndVibeSynthesis?: string;
    followUpQuestion?: string;
  };

  if (!parsed.answerSummary) {
    throw new Error(
      `Azure on-demand research returned JSON without answerSummary for "${params.query}".`
    );
  }

  return {
    sensoryHook: parsed.sensoryHook || "",
    answerSummary: parsed.answerSummary,
    reviewAndVibeSynthesis: parsed.reviewAndVibeSynthesis || "",
    followUpQuestion: parsed.followUpQuestion || "",
  };
}
