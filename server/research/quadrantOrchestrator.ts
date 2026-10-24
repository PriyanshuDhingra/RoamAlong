import type {
  DirectionalSectorCache,
  GeoPoint,
  QuadrantSector,
  RawOsmPoi,
  SpatialHeartbeatRequest,
  SpatialHeartbeatResponse,
  StoryCard,
  TourRoute,
  TourStop,
  TourTopic,
} from "../../shared/types.js";
import {
  angularSpanOffHeading,
  bearingDegrees,
  cardinalFromHeading,
  getSectorOffsetCenter,
  haversineMeters,
  movePointByMeters,
  relativeClockAndDirection,
  snapToSpatialTile,
} from "../../shared/geo.js";
import { fetchOverpassPoisBatch } from "../osm/overpassClient.js";
import {
  fetchOsrmWalkingRoute,
  reverseGeocodeOsm,
} from "../osm/nominatimAndOsrm.js";
import {
  fetchWikipediaGeoSearch,
  fetchWikipediaSummaryByTag,
  type WikiSummary,
} from "./wikipediaClient.js";
import { synthesizeSectorStories } from "./azureSynthesizer.js";
import {
  getPersistedPoiStorySync,
  getPersistedTile,
  savePersistedPoiStory,
  savePersistedTile,
  type PersistedTileRecord,
} from "../cache/persistentStore.js";

const ALL_SECTORS: QuadrantSector[] = [
  "CENTER",
  "NORTH",
  "SOUTH",
  "EAST",
  "WEST",
];

const inFlightTilePromises = new Map<string, Promise<PersistedTileRecord>>();

function makeProfileKey(profile: SpatialHeartbeatRequest["profile"]): string {
  return `${[...profile.topics].sort().join(",")}:${profile.story_style}`;
}

/**
 * Velocity-weighted priority ordering for the 4 directional research agents + center.
 * Prioritizes the sector aligned with the user's walking heading first so forward stories resolve fastest.
 */
export function prioritizeSectorsByHeading(
  headingDeg: number
): QuadrantSector[] {
  const norm = ((headingDeg % 360) + 360) % 360;
  let forward: QuadrantSector = "NORTH";
  if (norm >= 45 && norm < 135) forward = "EAST";
  else if (norm >= 135 && norm < 225) forward = "SOUTH";
  else if (norm >= 225 && norm < 315) forward = "WEST";

  const ordered: QuadrantSector[] = ["CENTER", forward];
  for (const s of ALL_SECTORS) {
    if (!ordered.includes(s)) ordered.push(s);
  }
  return ordered;
}

/**
 * Processes a spatial heartbeat:
 * - In Wandering Mode:
 *   1. Reuses any already-researched landmarks from `poiStoryCache` in 0ms.
 *   2. Resolves `CENTER` + the walker's `Forward` direction immediately for lowest latency,
 *      while warming the remaining peripheral sectors (`LEFT`, `RIGHT`, `BEHIND`) and the
 *      next frontier block ahead in the background.
 * - In Guided Tour Mode:
 *   All stops along the route are prefetched upfront when the route is created.
 */
export async function processSpatialHeartbeat(
  req: SpatialHeartbeatRequest
): Promise<SpatialHeartbeatResponse> {
  const origin: GeoPoint = { lat: req.lat, lon: req.lon };
  const { tileKey, snappedCenter } = snapToSpatialTile(origin);
  // Key spatial tiles by geographic tileKey (`tile_row_col`) so calibrating topics mid-session
  // never invalidates the cached tile or triggers a 20s cold re-synthesis!
  const cacheKey = tileKey;
  const profileKey = makeProfileKey(req.profile);

  // 1. Check L1 Memory + L2 Upstash Cloud Redis + L3 Disk persistent store
  let entry = await getPersistedTile(cacheKey);
  if (!entry) {
    let pending = inFlightTilePromises.get(cacheKey);
    if (!pending) {
      pending = buildTileEntry(tileKey, snappedCenter, req, profileKey).finally(
        () => {
          inFlightTilePromises.delete(cacheKey);
        }
      );
      inFlightTilePromises.set(cacheKey, pending);
    }
    entry = await pending;
    await savePersistedTile(cacheKey, entry);
  }

  // If the user is actively walking in Wandering Mode (>0.6 m/s), silently pre-warm the next tile ahead
  if (req.profile.mode === "wandering" && req.speedMps >= 0.6) {
    const lookaheadPoint = movePointByMeters(origin, req.headingDeg, 155);
    const nextTile = snapToSpatialTile(lookaheadPoint);
    const nextCacheKey = nextTile.tileKey;
    if (
      nextTile.tileKey !== tileKey &&
      !inFlightTilePromises.has(nextCacheKey)
    ) {
      void getPersistedTile(nextCacheKey).then((existingNext) => {
        if (!existingNext && !inFlightTilePromises.has(nextCacheKey)) {
          const bgPromise = buildTileEntry(
            nextTile.tileKey,
            nextTile.snappedCenter,
            { ...req, lat: lookaheadPoint.lat, lon: lookaheadPoint.lon },
            profileKey
          )
            .then(async (res) => {
              await savePersistedTile(nextCacheKey, res);
              return res;
            })
            .finally(() => {
              inFlightTilePromises.delete(nextCacheKey);
            });
          inFlightTilePromises.set(nextCacheKey, bgPromise);
        }
      });
    }
  }

  return formatHeartbeatResponse(origin, req.headingDeg, entry, req.profile);
}

async function buildTileEntry(
  tileKey: string,
  center: GeoPoint,
  req: SpatialHeartbeatRequest,
  profileKey: string
): Promise<PersistedTileRecord> {
  const startedAt = Date.now();
  const [geoInfo, rawPois, geoWikiArticles] = await Promise.all([
    reverseGeocodeOsm(center),
    fetchOverpassPoisBatch(center, 360),
    fetchWikipediaGeoSearch(center, 360, 6),
  ]);

  // Attach Wikipedia extracts to POIs that have wikipedia tags or matching geosearch titles
  const enrichedPois: (RawOsmPoi & { wiki?: WikiSummary })[] =
    await Promise.all(
      rawPois.slice(0, 24).map(async (poi: RawOsmPoi) => {
        if (poi.wikipediaTag) {
          const wiki = await fetchWikipediaSummaryByTag(poi.wikipediaTag);
          return { ...poi, wiki };
        }
        const match = geoWikiArticles.find(
          (w) =>
            w.title.toLowerCase().includes(poi.name.toLowerCase()) ||
            poi.name.toLowerCase().includes(w.title.toLowerCase())
        );
        return { ...poi, wiki: match };
      })
    );

  // Group POIs into CENTER + the 4 cardinal quadrants (NORTH, SOUTH, EAST, WEST)
  const grouped: Record<QuadrantSector, typeof enrichedPois> = {
    CENTER: [],
    NORTH: [],
    SOUTH: [],
    EAST: [],
    WEST: [],
  };

  for (const poi of enrichedPois) {
    const sector: QuadrantSector = poi.sector ?? "CENTER";
    grouped[sector].push(poi);
  }

  // Ensure every directional sector has at least 1 candidate if total POIs exist
  for (const sector of ["NORTH", "SOUTH", "EAST", "WEST"] as QuadrantSector[]) {
    if (grouped[sector].length === 0 && enrichedPois.length > 0) {
      const targetCenter = getSectorOffsetCenter(center, sector, 130);
      const closest = [...enrichedPois].sort(
        (a, b) =>
          haversineMeters(targetCenter, a) - haversineMeters(targetCenter, b)
      )[0];
      if (closest) {
        grouped[sector].push({ ...closest, sector });
      }
    }
  }

  const prioritizedSectors = prioritizeSectorsByHeading(req.headingDeg);
  const immediateSectors = prioritizedSectors.slice(0, 2); // CENTER + Forward walking sector
  const peripheralSectors = prioritizedSectors.slice(2); // Left, Right, Behind sectors
  const sectors = {} as Record<QuadrantSector, DirectionalSectorCache>;

  const runSectorSynthesis = async (sector: QuadrantSector) => {
    const sectorStart = Date.now();
    const sectorPois = grouped[sector];

    // Check which POIs in this sector are ALREADY in poiStoryCache from an adjacent tile's prefetch
    const cachedStories: StoryCard[] = [];
    const uncachedPois: typeof sectorPois = [];

    for (const poi of sectorPois) {
      const existing =
        getPersistedPoiStorySync(poi.osmId) ??
        getPersistedPoiStorySync(`${poi.osmId}:${profileKey}`);
      if (existing) {
        cachedStories.push({
          ...existing,
          sector,
          id: `${sector}_${poi.osmId}`,
        });
      } else {
        uncachedPois.push(poi);
      }
    }

    let freshStories: StoryCard[] = [];
    const synthesizedBy: "azure_openai" = "azure_openai";

    if (uncachedPois.length > 0) {
      const res = await synthesizeSectorStories({
        sector,
        neighborhood: geoInfo.neighborhood,
        city: geoInfo.city,
        countryCode: geoInfo.countryCode,
        pois: uncachedPois,
        profile: req.profile,
      });
      freshStories = res.stories;

      for (const s of freshStories) {
        savePersistedPoiStory(s.osmId, s);
      }
    }

    const combinedStories = [...cachedStories, ...freshStories].sort(
      (a, b) => b.score - a.score
    );

    sectors[sector] = {
      sector,
      tileKey: `${tileKey}_${sector}`,
      center: getSectorOffsetCenter(center, sector, 130),
      stories: combinedStories,
      status: "ready",
      synthesizedBy,
      updatedAt: Date.now(),
      latencyMs: Date.now() - sectorStart,
    };
  };

  // Stage 1: Await CENTER + Forward sector immediately so voice guide has zero lag
  await Promise.all(immediateSectors.map((s) => runSectorSynthesis(s)));

  // Stage 2: Populate fast heuristic placeholders for peripheral sectors immediately,
  // and let any remaining Azure OpenAI peripheral calls finish in parallel
  await Promise.all(peripheralSectors.map((s) => runSectorSynthesis(s)));

  return {
    tileKey,
    neighborhood: geoInfo.neighborhood,
    currentStreet: geoInfo.currentStreet,
    city: geoInfo.city,
    countryCode: geoInfo.countryCode,
    sectors,
    createdAt: startedAt,
  };
}

function formatHeartbeatResponse(
  origin: GeoPoint,
  headingDeg: number,
  entry: PersistedTileRecord,
  profile?: SpatialHeartbeatRequest["profile"]
): SpatialHeartbeatResponse {
  const allStories: StoryCard[] = Object.values(entry.sectors).flatMap(
    (s) => s.stories
  );
  const preferredTopics = new Set(profile?.topics ?? []);

  // Score immediate POIs by proximity + alignment with user's heading cone + calibrated topic match
  const scoredImmediate = allStories
    .map((story) => {
      const dist = haversineMeters(origin, story);
      const bearing = bearingDegrees(origin, story);
      const { angleDiff } = relativeClockAndDirection(headingDeg, bearing);
      const inForwardCone = Math.abs(angleDiff) <= 65 ? 18 : 0;
      const proximityScore = Math.max(0, 60 - dist * 0.35);
      const topicBonus = story.categories.some((c) => preferredTopics.has(c))
        ? 25
        : 0;
      return {
        story,
        totalScore: story.score + inForwardCone + proximityScore + topicBonus,
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore);

  const recommendedImmediatePoi = scoredImmediate[0]?.story;

  // Deterministic backend gaze ray-cast: tests which building footprint or landmark
  // sits directly in the walker's line of sight (within ±28° of headingDeg, up to 160m).
  const gazeMatches = allStories
    .map((story) => {
      const dist = Math.round(haversineMeters(origin, story));
      const { minAbsAngleDeg } = angularSpanOffHeading(
        origin,
        headingDeg,
        story,
        story.geometry
      );
      const bearing = bearingDegrees(origin, story);
      const { clockPosition } = relativeClockAndDirection(headingDeg, bearing);
      // Lower cost = tighter gaze alignment + closer distance
      const gazeCost = minAbsAngleDeg * 2.4 + dist * 0.45;
      return {
        story,
        distanceMeters: dist,
        angleOffGazeDeg: Math.round(minAbsAngleDeg),
        clockPosition,
        gazeCost,
      };
    })
    .filter((m) => m.angleOffGazeDeg <= 28 && m.distanceMeters <= 160)
    .sort((a, b) => a.gazeCost - b.gazeCost);

  const gazeCandidate = gazeMatches[0]
    ? {
        story: gazeMatches[0].story,
        distanceMeters: gazeMatches[0].distanceMeters,
        angleOffGazeDeg: gazeMatches[0].angleOffGazeDeg,
        clockPosition: gazeMatches[0].clockPosition,
      }
    : undefined;

  const directionHooks: SpatialHeartbeatResponse["directionHooks"] = [];
  for (const sector of ["NORTH", "EAST", "SOUTH", "WEST"] as QuadrantSector[]) {
    const topStory = entry.sectors[sector]?.stories[0];
    if (!topStory) continue;
    const bearing = bearingDegrees(origin, topStory);
    const { relativeDirection, clockPosition } = relativeClockAndDirection(
      headingDeg,
      bearing
    );
    directionHooks.push({
      sector,
      relativeDirection: `${relativeDirection} (${clockPosition})`,
      topPoiName: topStory.name,
      teaser: topStory.sensoryHook,
    });
  }

  return {
    tileKey: entry.tileKey,
    neighborhood: entry.neighborhood,
    currentStreet: entry.currentStreet,
    city: entry.city,
    countryCode: entry.countryCode,
    headingDeg: Math.round(((headingDeg % 360) + 360) % 360),
    headingCardinal: cardinalFromHeading(headingDeg),
    sectors: entry.sectors,
    recommendedImmediatePoi,
    gazeCandidate,
    directionHooks,
  };
}

function storyForPoi(poi: RawOsmPoi, known?: StoryCard): StoryCard {
  if (known) return known;
  return {
    id: `tour_${poi.osmId}`,
    osmId: poi.osmId,
    name: poi.name,
    lat: poi.lat,
    lon: poi.lon,
    sector: poi.sector ?? "CENTER",
    categories: [poi.category],
    sensoryHook: `A ${poi.category} place you can pick out from the sidewalk.`,
    narrativeSummary: `${poi.name} fits this walk because it is about ${poi.category}.`,
    hiddenTrivia: "",
    followUpQuestion: `What do you notice first about ${poi.name}?`,
    geometry: poi.geometry,
    score: 70,
  };
}

/**
 * Picks stops whose category matches the user's topics, one topic at a time,
 * so a food walk and an architecture walk are not the same four landmarks.
 */
async function selectStopsForTopics(
  origin: GeoPoint,
  knownStories: StoryCard[],
  topics: TourTopic[],
  maxStops: number
): Promise<StoryCard[]> {
  const wanted = new Set(topics);
  const knownById = new Map(knownStories.map((story) => [story.osmId, story]));
  const fallback = [...knownStories]
    .sort((a, b) => {
      const aMatch = a.categories.some((topic) => wanted.has(topic)) ? 100 : 0;
      const bMatch = b.categories.some((topic) => wanted.has(topic)) ? 100 : 0;
      return bMatch + b.score - (aMatch + a.score);
    })
    .slice(0, maxStops);

  let pois: RawOsmPoi[] = [];
  try {
    pois = await fetchOverpassPoisBatch(origin, 450);
  } catch {
    return fallback;
  }

  const buckets = new Map<TourTopic, RawOsmPoi[]>();
  const seenNames = new Set<string>();
  for (const poi of pois) {
    if (!wanted.has(poi.category)) continue;
    const nameKey = poi.name.trim().toLowerCase();
    if (!nameKey || seenNames.has(nameKey)) continue;
    const dist = haversineMeters(origin, poi);
    if (dist < 30 || dist > 650) continue;
    seenNames.add(nameKey);
    const list = buckets.get(poi.category) ?? [];
    list.push(poi);
    buckets.set(poi.category, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => haversineMeters(origin, a) - haversineMeters(origin, b));
  }

  const topicOrder = topics.filter((topic) => (buckets.get(topic)?.length ?? 0) > 0);
  const picked: RawOsmPoi[] = [];
  while (picked.length < maxStops) {
    let added = false;
    for (const topic of topicOrder) {
      if (picked.length >= maxStops) break;
      const list = buckets.get(topic);
      const next = list?.shift();
      if (!next) continue;
      if (picked.some((poi) => haversineMeters(poi, next) < 45)) continue;
      picked.push(next);
      added = true;
    }
    if (!added) break;
  }

  if (picked.length < 2) return fallback;
  return picked.map((poi) => storyForPoi(poi, knownById.get(poi.osmId)));
}

/**
 * Guided Tour Mode: Generates a curated walking route and prefetches all stops along the route upfront
 * so every stop has zero latency when the user arrives.
 */
export async function generateGuidedTourRoute(
  origin: GeoPoint,
  headingDeg: number,
  profile: SpatialHeartbeatRequest["profile"],
  maxStops = 4
): Promise<TourRoute> {
  const heartbeat = await processSpatialHeartbeat({
    lat: origin.lat,
    lon: origin.lon,
    headingDeg,
    speedMps: 0,
    profile,
  });

  const uniqueStories = new Map<string, StoryCard>();
  for (const sector of Object.values(heartbeat.sectors)) {
    for (const story of sector.stories) {
      if (!uniqueStories.has(story.osmId)) {
        uniqueStories.set(story.osmId, story);
      }
    }
  }

  const selected = await selectStopsForTopics(
    origin,
    [...uniqueStories.values()],
    profile.topics,
    maxStops
  );

  // Order stops by nearest-neighbor walking loop starting from user's origin
  const orderedStops: StoryCard[] = [];
  const remaining = [...selected];
  let cursor: GeoPoint = origin;
  while (remaining.length > 0) {
    remaining.sort(
      (a, b) => haversineMeters(cursor, a) - haversineMeters(cursor, b)
    );
    const next = remaining.shift()!;
    orderedStops.push(next);
    cursor = next;
  }

  // Prefetch Wikipedia & spatial tiles for every stop along the Guided Tour route upfront
  const profileKey = makeProfileKey(profile);
  await Promise.all(
    orderedStops.map(async (stop) => {
      const wiki = await fetchWikipediaSummaryByTag(`en:${stop.name}`);
      if (wiki?.extract && wiki.extract.length > stop.narrativeSummary.length) {
        stop.narrativeSummary = wiki.extract;
        stop.wikipediaUrl = wiki.url;
      }
      savePersistedPoiStory(`${stop.osmId}:${profileKey}`, stop);
    })
  );

  const waypoints: GeoPoint[] = [
    origin,
    ...orderedStops.map((s) => ({ lat: s.lat, lon: s.lon })),
  ];
  const osrmLeg = await fetchOsrmWalkingRoute(waypoints);

  const stops: TourStop[] = orderedStops.map((poi, idx) => ({
    order: idx + 1,
    poi,
    arrivalRadiusMeters: 22,
    visited: false,
    walkingBridgeStory:
      idx === 0
        ? `As we set off down ${heartbeat.currentStreet} toward ${poi.name}, notice the shift in street rhythm.`
        : `Walking from ${orderedStops[idx - 1].name} toward ${
            poi.name
          }, we connect ${orderedStops[idx - 1].categories[0]} with ${
            poi.categories[0]
          }.`,
  }));

  return {
    id: `tour_${Date.now()}`,
    title: `${heartbeat.neighborhood} ${
      profile.topics.slice(0, 2).join(" & ") || "Explorer"
    } Walk`,
    theme: `A personalized ${profile.story_style.replace(
      /_/g,
      " "
    )} route through ${heartbeat.neighborhood}`,
    mode: "guided_tour",
    stops,
    currentStopIndex: 0,
    polyline: osrmLeg.polyline,
    totalDistanceMeters: osrmLeg.totalDistanceMeters,
    estimatedDurationMinutes: osrmLeg.estimatedDurationMinutes,
    nextStepInstruction: osrmLeg.steps[0]?.instruction,
  };
}
