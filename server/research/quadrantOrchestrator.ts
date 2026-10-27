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
  classifySector,
  haversineMeters,
  movePointByMeters,
  relativeClockAndDirection,
  snapToSpatialTile,
} from "../../shared/geo.js";
import { fetchOverpassPoisBatch } from "../osm/overpassClient.js";
import {
  fetchOsrmWalkingRoute,
  reverseGeocodeOsm,
  type ReverseGeocodeResult,
} from "../osm/nominatimAndOsrm.js";
import { synthesizeSectorStories } from "./azureSynthesizer.js";
import {
  getPersistedPoiStory,
  savePersistedPoiStory,
  type PersistedTileRecord,
} from "../cache/persistentStore.js";

const ALL_SECTORS: QuadrantSector[] = [
  "CENTER",
  "NORTH",
  "SOUTH",
  "EAST",
  "WEST",
];

const CURRENT_RADIUS_M = 100;
const AHEAD_RADIUS_M = 100;
const AHEAD_CENTER_M = 150;
const ROUTE_CORRIDOR_M = 100;
const RESEARCH_BATCH = 8;

interface DiskResearch {
  stories: StoryCard[];
  neighborhood: string;
  currentStreet: string;
  city: string;
  countryCode: string;
}

const diskResults = new Map<string, DiskResearch>();
const diskInFlight = new Map<string, Promise<DiskResearch>>();

function diskKey(point: GeoPoint, radius: number): string {
  return `${point.lat.toFixed(3)},${point.lon.toFixed(3)}:${radius}`;
}

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

function emptyGeo(): ReverseGeocodeResult {
  return {
    currentStreet: "this street",
    neighborhood: "this area",
    city: "",
    countryCode: "",
    displayName: "",
  };
}

async function researchPois(
  pois: RawOsmPoi[],
  profile: SpatialHeartbeatRequest["profile"],
  geo: ReverseGeocodeResult,
  useWebSearch: boolean
): Promise<StoryCard[]> {
  const profileKey = makeProfileKey(profile);
  const stories: StoryCard[] = [];
  const pending: RawOsmPoi[] = [];
  for (const poi of pois) {
    const existing =
      (await getPersistedPoiStory(poi.osmId)) ??
      (await getPersistedPoiStory(`${poi.osmId}:${profileKey}`));
    const hasNotes = (existing?.notes?.length ?? 0) > 0;
    if (existing && (!useWebSearch || (existing.webResearched && hasNotes))) {
      stories.push(existing);
    } else if (poi.name.trim()) {
      pending.push(poi);
    }
  }

  const chunks: RawOsmPoi[][] = [];
  for (let i = 0; i < pending.length; i += RESEARCH_BATCH) {
    chunks.push(pending.slice(i, i + RESEARCH_BATCH));
  }

  const written = await Promise.all(
    chunks.map(async (chunk) => {
      const input = {
        sector: chunk[0]?.sector ?? ("CENTER" as QuadrantSector),
        neighborhood: geo.neighborhood,
        city: geo.city,
        countryCode: geo.countryCode,
        pois: chunk,
        profile,
      };
      return await synthesizeSectorStories({ ...input, useWebSearch: true });
    })
  );

  for (const res of written) {
    for (const story of res.stories) {
      await savePersistedPoiStory(story.osmId, story);
      stories.push(story);
    }
  }
  return stories;
}

async function researchDisk(
  center: GeoPoint,
  radius: number,
  profile: SpatialHeartbeatRequest["profile"],
  useWebSearch: boolean
): Promise<DiskResearch> {
  const key = diskKey(center, radius);
  const cached = diskResults.get(key);
  if (cached) return cached;
  const pending = diskInFlight.get(key);
  if (pending) return pending;

  const job = (async () => {
    let geo = emptyGeo();
    try {
      geo = await reverseGeocodeOsm(center);
    } catch {
      geo = emptyGeo();
    }
    let pois: RawOsmPoi[] = [];
    try {
      pois = await fetchOverpassPoisBatch(center, radius, {
        skipFullMap: true,
        timeoutMs: 8000,
      });
    } catch {
      pois = [];
    }
    const nearest = [...pois].sort(
      (a, b) => haversineMeters(center, a) - haversineMeters(center, b)
    );
    const stories = await researchPois(
      nearest.slice(0, RESEARCH_BATCH * 2),
      profile,
      geo,
      useWebSearch
    );
    return {
      stories,
      neighborhood: geo.neighborhood,
      currentStreet: geo.currentStreet,
      city: geo.city,
      countryCode: geo.countryCode,
    };
  })().then((result) => {
    diskResults.set(key, result);
    return result;
  });

  diskInFlight.set(key, job);
  try {
    return await job;
  } finally {
    diskInFlight.delete(key);
  }
}

function spawnAheadResearch(
  origin: GeoPoint,
  headingDeg: number,
  profile: SpatialHeartbeatRequest["profile"]
): void {
  const center = movePointByMeters(origin, headingDeg, AHEAD_CENTER_M);
  const key = diskKey(center, AHEAD_RADIUS_M);
  if (diskResults.has(key) || diskInFlight.has(key)) return;
  void researchDisk(center, AHEAD_RADIUS_M, profile, true).catch(() => undefined);
}

function heartbeatFromDisk(
  origin: GeoPoint,
  headingDeg: number,
  disk: DiskResearch,
  profile: SpatialHeartbeatRequest["profile"]
): SpatialHeartbeatResponse {
  const { tileKey } = snapToSpatialTile(origin);
  const sectors = {} as PersistedTileRecord["sectors"];
  for (const sector of ALL_SECTORS) {
    sectors[sector] = {
      sector,
      tileKey: `${tileKey}_${sector}`,
      center: origin,
      stories: [],
      status: "ready",
      synthesizedBy: "azure_openai",
      updatedAt: Date.now(),
      latencyMs: 0,
    };
  }
  for (const story of disk.stories) {
    const sector = classifySector(origin, story).sector;
    sectors[sector].stories.push({ ...story, sector });
  }
  return formatHeartbeatResponse(
    origin,
    headingDeg,
    {
      tileKey,
      neighborhood: disk.neighborhood,
      currentStreet: disk.currentStreet,
      city: disk.city,
      countryCode: disk.countryCode,
      sectors,
      createdAt: Date.now(),
    },
    profile
  );
}

/**
 * Wandering: research the 100 m around the walker, then spawn the next 100 m
 * along their heading without waiting. Each later heartbeat repeats that cycle.
 * Guided: the route corridor is prefetched when the route is built. A heartbeat
 * only fills the 100 m around the walker from that store.
 */
export async function processSpatialHeartbeat(
  req: SpatialHeartbeatRequest
): Promise<SpatialHeartbeatResponse> {
  const origin: GeoPoint = { lat: req.lat, lon: req.lon };
  const disk = await researchDisk(origin, CURRENT_RADIUS_M, req.profile, true);
  if (req.profile.mode !== "guided_tour") {
    spawnAheadResearch(origin, req.headingDeg, req.profile);
  }
  return heartbeatFromDisk(origin, req.headingDeg, disk, req.profile);
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

async function loadFreshTourPois(origin: GeoPoint): Promise<RawOsmPoi[]> {
  try {
    const indexed = await fetchOverpassPoisBatch(origin, 700, {
      skipFullMap: true,
      timeoutMs: 8000,
    });
    if (indexed.length >= 8) return indexed;
  } catch {
    // The indexed lookup can time out. The map download below is the backup.
  }
  try {
    return await fetchOverpassPoisBatch(origin, 450, { timeoutMs: 8000 });
  } catch {
    return [];
  }
}

/**
 * Fetches a fresh set of stops for this tour. Saved stories are only used
 * when one of those places already has a writeup. The old four-place cache
 * is not the stop list.
 */
async function selectStopsForTopics(
  origin: GeoPoint,
  knownStories: StoryCard[],
  topics: TourTopic[],
  maxStops: number
): Promise<StoryCard[]> {
  const wanted = new Set(topics);
  const knownById = new Map(knownStories.map((story) => [story.osmId, story]));
  const pois = await loadFreshTourPois(origin);
  if (pois.length === 0) {
    return knownStories.slice(0, maxStops);
  }

  const pool = pois
    .filter((poi) => {
      const nameKey = poi.name.trim().toLowerCase();
      if (!nameKey) return false;
      const dist = haversineMeters(origin, poi);
      return dist >= 30 && dist <= 900;
    })
    .sort((a, b) => {
      const aMatch = wanted.has(a.category) ? 0 : 1;
      const bMatch = wanted.has(b.category) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return haversineMeters(origin, a) - haversineMeters(origin, b);
    });

  const picked: StoryCard[] = [];
  for (const gap of [80, 40, 0]) {
    for (const poi of pool) {
      if (picked.length >= maxStops) break;
      const nameKey = poi.name.trim().toLowerCase();
      if (
        picked.some(
          (story) =>
            story.osmId === poi.osmId ||
            story.name.trim().toLowerCase() === nameKey
        )
      ) {
        continue;
      }
      if (gap > 0 && picked.some((story) => haversineMeters(story, poi) < gap)) {
        continue;
      }
      if (gap > 0 && !wanted.has(poi.category) && picked.length < maxStops) {
        const topicLeft = pool.some(
          (other) =>
            wanted.has(other.category) &&
            !picked.some((story) => story.osmId === other.osmId)
        );
        if (topicLeft) continue;
      }
      picked.push(storyForPoi(poi, knownById.get(poi.osmId)));
    }
  }
  return picked.slice(0, maxStops);
}

function distanceToPath(point: GeoPoint, path: GeoPoint[]): number {
  let best = Infinity;
  for (const vertex of path) {
    const distance = haversineMeters(point, vertex);
    if (distance < best) best = distance;
  }
  return best;
}

function samplePath(path: GeoPoint[], spacingM: number): GeoPoint[] {
  if (path.length === 0) return [];
  const samples = [path[0]];
  let since = 0;
  for (let i = 1; i < path.length; i++) {
    since += haversineMeters(path[i - 1], path[i]);
    if (since >= spacingM) {
      samples.push(path[i]);
      since = 0;
    }
  }
  const last = path[path.length - 1];
  if (haversineMeters(samples[samples.length - 1], last) > 1) samples.push(last);
  return samples;
}

async function prefetchRouteCorridor(
  path: GeoPoint[],
  stops: StoryCard[],
  profile: SpatialHeartbeatRequest["profile"],
  geo: ReverseGeocodeResult
): Promise<StoryCard[]> {
  const anchors = [
    ...samplePath(path, 200),
    ...stops.map((stop) => ({ lat: stop.lat, lon: stop.lon })),
  ];
  const lists = await Promise.all(
    anchors.map((point) =>
      fetchOverpassPoisBatch(point, 200, {
        skipFullMap: true,
        timeoutMs: 8000,
      }).catch(() => [] as RawOsmPoi[])
    )
  );
  const byId = new Map<string, RawOsmPoi>();
  for (const poi of lists.flat()) {
    if (distanceToPath(poi, path) <= ROUTE_CORRIDOR_M) byId.set(poi.osmId, poi);
  }
  for (const stop of stops) {
    if (!byId.has(stop.osmId)) {
      byId.set(stop.osmId, {
        osmId: stop.osmId,
        osmType: "node",
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        category: stop.categories[0] ?? "trivia",
        tags: { name: stop.name },
        geometry: stop.geometry,
        sector: stop.sector,
      });
    }
  }
  const stopIds = new Set(stops.map((stop) => stop.osmId));
  const ranked = [...byId.values()].sort((a, b) => {
    const aStop = stopIds.has(a.osmId) ? 0 : 1;
    const bStop = stopIds.has(b.osmId) ? 0 : 1;
    if (aStop !== bStop) return aStop - bStop;
    return distanceToPath(a, path) - distanceToPath(b, path);
  });
  const chosen = [
    ...ranked.filter((poi) => stopIds.has(poi.osmId)),
    ...ranked.filter((poi) => !stopIds.has(poi.osmId)).slice(0, 16),
  ];
  try {
    return await researchPois(chosen, profile, geo, true);
  } catch {
    return stops;
  }
}

/**
 * Guided Tour Mode: builds the route, then prefetches every place within 100 m of it.
 */
export async function generateGuidedTourRoute(
  origin: GeoPoint,
  headingDeg: number,
  profile: SpatialHeartbeatRequest["profile"],
  maxStops = 8
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

  if (orderedStops.length < 2) {
    throw new Error("Not enough places nearby to build a tour yet.");
  }

  const waypoints: GeoPoint[] = [
    origin,
    ...orderedStops.map((s) => ({ lat: s.lat, lon: s.lon })),
  ];
  const osrmLeg = await fetchOsrmWalkingRoute(waypoints);
  const corridor = await prefetchRouteCorridor(
    osrmLeg.polyline.length > 1 ? osrmLeg.polyline : waypoints,
    orderedStops,
    profile,
    {
      currentStreet: heartbeat.currentStreet,
      neighborhood: heartbeat.neighborhood,
      city: heartbeat.city,
      countryCode: heartbeat.countryCode,
      displayName: heartbeat.neighborhood,
    }
  );
  const byOsm = new Map(corridor.map((story) => [story.osmId, story]));
  for (let i = 0; i < orderedStops.length; i++) {
    const researched = byOsm.get(orderedStops[i].osmId);
    if (!researched) continue;
    const previous = orderedStops[i];
    orderedStops[i] = {
      ...previous,
      ...researched,
      id: previous.id,
      lat: previous.lat,
      lon: previous.lon,
      geometry: previous.geometry ?? researched.geometry,
      sector: previous.sector,
    };
  }

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
