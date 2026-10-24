import type {
  GeoPoint,
  MapHighlightAction,
  NavigationCue,
  QuadrantSector,
  SpatialHeartbeatResponse,
  StoryCard,
  ToolResult,
  TourMode,
  TourRoute,
  TourTopic,
  UserCalibrationProfile,
} from "../../../shared/types.js";
import {
  angularSpanOffHeading,
  bearingDegrees,
  cardinalFromHeading,
  haversineMeters,
  relativeClockAndDirection,
} from "../../../shared/geo.js";

/**
 * Tool definitions sent in `session.update` (`session.tools`).
 * Combines Boson's server-side `{ type: "web_search" }` with 6 client-side function tools.
 */
export const BOSON_SESSION_TOOLS = [
  { type: "web_search" },
  {
    type: "function",
    name: "save_calibration_profile",
    description:
      "Save or update the user's personalized tour preferences, topic interests, and storytelling vibe whenever they share what they want to experience. The Wander / Tours toggle on screen controls the mode. Do not ask about language. Say a brief confirmation when calling.",
    parameters: {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "history",
              "architecture",
              "art",
              "engineering",
              "food",
              "nature",
              "music",
              "trivia",
              "news",
            ],
          },
          description: "Topics the user wants to focus on.",
        },
        story_style: {
          type: "string",
          enum: [
            "deep_historical",
            "witty_local_friend",
            "architectural_detective",
            "culinary_explorer",
          ],
        },
        proactivity: {
          type: "string",
          enum: ["high", "balanced", "on_demand"],
        },
        mode: {
          type: "string",
          enum: ["wandering", "guided_tour"],
        },
      },
      required: ["topics", "story_style"],
    },
  },
  {
    type: "function",
    name: "get_spatial_briefing",
    description:
      "Fetch the prefetched N/S/E/W spatial stories and landmarks around the user's current location and heading. Call this whenever the user asks what is around them, what is ahead/left/right, or where they should walk next.",
    parameters: {
      type: "object",
      properties: {
        direction_filter: {
          type: "string",
          enum: ["ALL", "CENTER", "NORTH", "SOUTH", "EAST", "WEST", "AHEAD"],
          description: "Which directional sector to inspect.",
        },
        topic_filter: {
          type: "string",
          description: "Optional topic filter such as food, architecture, history, or art.",
        },
      },
      required: ["direction_filter"],
    },
  },
  {
    type: "function",
    name: "deep_dive_poi",
    description:
      "Look up detailed historical, architectural, engineering, or culinary stories and Wikipedia facts about a specific building or landmark the user asks about (even if not in the prefetched cache). Say a brief acknowledgement before calling.",
    parameters: {
      type: "object",
      properties: {
        landmark_name: {
          type: "string",
          description: "Name or description of the building or place.",
        },
      },
      required: ["landmark_name"],
    },
  },
  {
    type: "function",
    name: "lookup_place_reviews_and_facts",
    description:
      "Call this whenever the user asks about a specific named place (building, statue, monument, artwork, restaurant, cafe, shop) or a local fact that is NOT word-for-word covered in your briefing or an earlier tool result, even if you think you know it, and even before they agree to a tour. Never answer such a question from memory; OR when they ask for reviews, ratings, popular dishes, or opening hours for a nearby place. Pair this with `web_search` if live Google Maps / Yelp reviews or current web facts are needed.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The name of the restaurant, place, cuisine, or specific fact the user is asking about.",
        },
        question_type: {
          type: "string",
          enum: ["reviews_and_menu", "history_and_facts", "nearby_search"],
          description: "Whether the user is asking for reviews/food, history/facts, or searching for a nearby spot.",
        },
      },
      required: ["query", "question_type"],
    },
  },
  {
    type: "function",
    name: "highlight_on_map",
    description:
      "Light up the one place you are talking about. The previous highlight leaves the map. Call it once for the current place, not for every place you mention.",
    parameters: {
      type: "object",
      properties: {
        target_type: {
          type: "string",
          enum: ["building", "street", "neighborhood", "direction_cone"],
        },
        label: {
          type: "string",
          description: "Title of the building, street, or area to display on the spotlight card.",
        },
        subtitle: {
          type: "string",
          description: "1-line visual cue or architectural/historical hook.",
        },
        osm_id: {
          type: "string",
          description: "Optional OSM ID from the spatial briefing.",
        },
        clear_others: {
          type: "boolean",
          description: "Ignored. Only one place is highlighted at a time.",
        },
      },
      required: ["target_type", "label"],
    },
  },
  {
    type: "function",
    name: "plan_or_update_route",
    description:
      "Plan a new guided walk from the user's saved preferences, or switch back to wandering. Call this to create the first route and again when they ask for a new route, different places, or a different number of stops. The default tour has 8 stops. Do not call this when they accept the current tour and want to start walking. Say a short preamble before calling.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["wandering", "guided_tour"],
        },
        max_stops: {
          type: "number",
          description: "How many stops, from 2 to 12. Omit it for the default of 8. Set it when they ask for a shorter or longer tour during the review.",
        },
      },
      required: ["mode"],
    },
  },
  {
    type: "function",
    name: "get_navigation_cue",
    description:
      "Get landmark-relative wayfinding directions (clock-face bearing, distance, and street name) to guide the user naturally toward a landmark or the next tour stop.",
    parameters: {
      type: "object",
      properties: {
        target_name: {
          type: "string",
          description: "Name of the destination landmark or next stop.",
        },
      },
      required: ["target_name"],
    },
  },
];

export interface ToolExecutionContext {
  apiBaseUrl: string;
  getLocation: () => { lat: number; lon: number; headingDeg: number; speedMps: number };
  getProfile: () => UserCalibrationProfile;
  setProfile: (profile: UserCalibrationProfile) => void;
  getLatestHeartbeat: () => SpatialHeartbeatResponse | null;
  setLatestHeartbeat: (hb: SpatialHeartbeatResponse) => void;
  getActiveRoute: () => TourRoute | null;
  setActiveRoute: (route: TourRoute | null) => void;
  onMapHighlight: (action: MapHighlightAction, clearOthers?: boolean) => void;
}

/**
 * Executes a client function tool called by Higgs Realtime and formats the output
 * following Boson Tutorial Part 4 (`{ summary, detail, error }`, capped at max 3 spoken items, never throwing).
 */
export async function executeClientTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  try {
    switch (name) {
      case "save_calibration_profile":
        return handleSaveCalibration(args, ctx);
      case "get_spatial_briefing":
        return await handleGetSpatialBriefing(args, ctx);
      case "deep_dive_poi":
        return await handleDeepDivePoi(args, ctx);
      case "lookup_place_reviews_and_facts":
        return await handleLookupPlaceReviewsAndFacts(args, ctx);
      case "highlight_on_map":
        return handleHighlightOnMap(args, ctx);
      case "plan_or_update_route":
        return await handlePlanOrUpdateRoute(args, ctx);
      case "get_navigation_cue":
        return await handleGetNavigationCue(args, ctx);
      default:
        return {
          summary: `Tool ${name} is not registered on the client.`,
          error: "unknown_tool",
        };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      summary: `Tool error in ${name}: ${errMsg}`,
      error: errMsg,
    };
  }
}

async function handleSaveCalibration(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const current = ctx.getProfile();
  // Higgs sometimes sends topics as one string ("architecture, history") instead of an array.
  const topics = Array.isArray(args.topics)
    ? (args.topics as TourTopic[])
    : typeof args.topics === "string" && args.topics.trim()
      ? (args.topics
          .split(/[,;]|\band\b/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean) as TourTopic[])
      : current.topics;
  const story_style =
    typeof args.story_style === "string"
      ? (args.story_style as UserCalibrationProfile["story_style"])
      : current.story_style;
  const proactivity =
    typeof args.proactivity === "string"
      ? (args.proactivity as UserCalibrationProfile["proactivity"])
      : current.proactivity;
  const languages =
    Array.isArray(args.languages) && args.languages.length > 0
      ? (args.languages as string[])
      : current.languages;
  const mode = current.mode;

  const updated: UserCalibrationProfile = {
    calibrated: true,
    topics,
    story_style,
    proactivity,
    languages,
    mode,
    voice: current.voice || "oliver",
    updatedAt: Date.now(),
  };
  ctx.setProfile(updated);

  const saved = `Saved calibration profile: ${mode.replace(
    "_",
    " "
  )} mode focusing on ${topics.join(", ")} in a ${story_style.replace(
    /_/g,
    " "
  )} style (languages: ${languages.join(", ")}).`;

  if (updated.mode !== "guided_tour") {
    return { summary: saved, detail: updated };
  }

  const routeResult = await handlePlanOrUpdateRoute(
    { mode: "guided_tour", max_stops: 8 },
    ctx,
    updated
  );
  return {
    summary: `${saved} ${routeResult.summary}`,
    detail: { profile: updated, route: routeResult.detail },
    error: routeResult.error,
  };
}

async function handleGetSpatialBriefing(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const loc = ctx.getLocation();
  let hb = ctx.getLatestHeartbeat();
  if (!hb) {
    const res = await fetch(`${ctx.apiBaseUrl}/api/spatial/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: loc.lat,
        lon: loc.lon,
        headingDeg: loc.headingDeg,
        speedMps: loc.speedMps,
        profile: ctx.getProfile(),
      }),
    });
    if (res.ok) {
      hb = (await res.json()) as SpatialHeartbeatResponse;
      ctx.setLatestHeartbeat(hb);
    }
  }

  if (!hb) {
    return {
      summary: "No nearby spatial stories found yet.",
      error: "no_spatial_data",
    };
  }

  const directionFilter = String(args.direction_filter || "ALL").toUpperCase();
  const topicFilter = args.topic_filter
    ? String(args.topic_filter).toLowerCase()
    : undefined;

  let candidateStories: StoryCard[] = [];
  if (
    directionFilter === "CENTER" ||
    directionFilter === "NORTH" ||
    directionFilter === "SOUTH" ||
    directionFilter === "EAST" ||
    directionFilter === "WEST"
  ) {
    candidateStories = hb.sectors[directionFilter as QuadrantSector]?.stories ?? [];
  } else {
    candidateStories = Object.values(hb.sectors).flatMap((s) => s.stories);
  }

  // Deduplicate by osmId
  const uniqueMap = new Map<string, StoryCard>();
  for (const s of candidateStories) {
    if (!uniqueMap.has(s.osmId)) uniqueMap.set(s.osmId, s);
  }
  let pool = [...uniqueMap.values()];

  if (topicFilter) {
    const filtered = pool.filter(
      (s) =>
        s.categories.some((c) => c.toLowerCase().includes(topicFilter)) ||
        s.narrativeSummary.toLowerCase().includes(topicFilter)
    );
    if (filtered.length > 0) pool = filtered;
  }

  const origin: GeoPoint = { lat: loc.lat, lon: loc.lon };
  const enriched = pool.map((story) => {
    const dist = Math.round(haversineMeters(origin, story));
    const bearing = Math.round(bearingDegrees(origin, story));
    const { clockPosition, relativeDirection, angleDiff } =
      relativeClockAndDirection(loc.headingDeg, bearing);
    const { minAbsAngleDeg } = angularSpanOffHeading(
      origin,
      loc.headingDeg,
      story,
      story.geometry
    );
    return {
      story,
      dist,
      clockPosition,
      relativeDirection,
      angleDiff,
      gazeAngleDeg: Math.round(minAbsAngleDeg),
    };
  });

  if (directionFilter === "AHEAD") {
    const aheadOnly = enriched.filter((e) => e.gazeAngleDeg <= 65);
    if (aheadOnly.length > 0) {
      enriched.splice(0, enriched.length, ...aheadOnly);
    }
    enriched.sort(
      (a, b) => a.gazeAngleDeg * 2.4 + a.dist * 0.45 - (b.gazeAngleDeg * 2.4 + b.dist * 0.45)
    );
  } else {
    enriched.sort((a, b) => a.dist - b.dist);
  }

  // Cap spoken list at 3 items and put true total in summary (per Boson Tutorial Part 4)
  const shown = enriched.slice(0, 3);
  const more = Math.max(0, enriched.length - shown.length);

  const spotlight = shown[0];
  if (spotlight) {
    ctx.onMapHighlight({
      targetType: "building",
      osmId: spotlight.story.osmId,
      label: spotlight.story.name,
      subtitle: spotlight.story.sensoryHook,
      lat: spotlight.story.lat,
      lon: spotlight.story.lon,
      geometry: spotlight.story.geometry,
      category: spotlight.story.categories[0],
      timestamp: Date.now(),
    });
  }

  const headingCardinal = cardinalFromHeading(loc.headingDeg);
  const inFront =
    hb.gazeCandidate ??
    (() => {
      const hit = enriched.find((e) => e.gazeAngleDeg <= 28 && e.dist <= 160);
      return hit
        ? {
            story: hit.story,
            distanceMeters: hit.dist,
            angleOffGazeDeg: hit.gazeAngleDeg,
            clockPosition: hit.clockPosition,
          }
        : undefined;
    })();
  const inFrontText = inFront
    ? `Building directly in front of user (12 o'clock): ${inFront.story.name} (${inFront.distanceMeters}m ahead: ${inFront.story.sensoryHook}). `
    : "";

  const summary =
    shown.length === 0
      ? `Heading ${headingCardinal} (${loc.headingDeg} deg) on ${hb.currentStreet}. 0 results found.`
      : `Heading ${headingCardinal} (${loc.headingDeg} deg) on ${hb.currentStreet} in ${hb.neighborhood}. ${inFrontText}${enriched.length} nearby landmarks: ` +
        shown
          .map(
            (item) =>
              `${item.story.name} (${item.dist}m ${item.relativeDirection} at ${item.clockPosition}, sector ${item.story.sector}): ${item.story.sensoryHook} ${item.story.narrativeSummary}`
          )
          .join("; ") +
        (more > 0 ? `; and ${more} more prefetched nearby.` : ".");

  return {
    summary,
    detail: {
      currentStreet: hb.currentStreet,
      neighborhood: hb.neighborhood,
      headingDeg: loc.headingDeg,
      headingCardinal,
      buildingInFront: inFront
        ? {
            osmId: inFront.story.osmId,
            name: inFront.story.name,
            distanceMeters: inFront.distanceMeters,
            angleOffGazeDeg: inFront.angleOffGazeDeg,
            sensoryHook: inFront.story.sensoryHook,
            narrativeSummary: inFront.story.narrativeSummary,
          }
        : null,
      shown: shown.map((s) => ({
        osmId: s.story.osmId,
        name: s.story.name,
        distanceMeters: s.dist,
        direction: `${s.relativeDirection} (${s.clockPosition})`,
        sensoryHook: s.story.sensoryHook,
        narrativeSummary: s.story.narrativeSummary,
        hiddenTrivia: s.story.hiddenTrivia,
        followUpQuestion: s.story.followUpQuestion,
        localLanguagePhrase: s.story.localLanguagePhrase,
      })),
      directionHooks: hb.directionHooks,
    },
  };
}

async function handleDeepDivePoi(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const landmarkName = String(args.landmark_name || "");
  const loc = ctx.getLocation();

  const res = await fetch(`${ctx.apiBaseUrl}/api/spatial/deep-dive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: landmarkName,
      lat: loc.lat,
      lon: loc.lon,
      profile: ctx.getProfile(),
    }),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      summary: `Deep-dive error for ${landmarkName}: ${
        errBody.error || `HTTP ${res.status}`
      }`,
      error: errBody.error || "deep_dive_failed",
    };
  }

  const data = (await res.json()) as {
    story?: StoryCard;
    wikipediaExtract?: string;
    neighborhood?: string;
  };

  if (data.story) {
    ctx.onMapHighlight({
      targetType: "building",
      osmId: data.story.osmId,
      label: data.story.name,
      subtitle: data.story.hiddenTrivia,
      lat: data.story.lat,
      lon: data.story.lon,
      geometry: data.story.geometry,
      category: data.story.categories[0],
      timestamp: Date.now(),
    });
  }

  const story = data.story;
  const summary = story
    ? `${story.name}: ${story.sensoryHook} ${
        data.wikipediaExtract || story.narrativeSummary
      } Hidden trivia: ${story.hiddenTrivia}. Optional aside, not a required question: ${
        story.followUpQuestion
      }`
    : `Found background on ${landmarkName}: ${
        data.wikipediaExtract || "A notable landmark in this neighborhood."
      }`;

  return {
    summary,
    detail: data,
  };
}

async function handleLookupPlaceReviewsAndFacts(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const query = String(args.query || "").trim();
  const questionType = String(args.question_type || "reviews_and_menu");
  const loc = ctx.getLocation();

  const res = await fetch(`${ctx.apiBaseUrl}/api/spatial/on-demand`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      questionType,
      lat: loc.lat,
      lon: loc.lon,
      headingDeg: loc.headingDeg,
      profile: ctx.getProfile(),
    }),
  });

  if (!res.ok) {
    return {
      summary: `Could not find local OSM data for "${query}". Call web_search to look up live web reviews or facts for "${query}".`,
      error: "on_demand_lookup_failed",
    };
  }

  const data = (await res.json()) as {
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
    answerSummary: string;
    reviewAndVibeSynthesis: string;
    suggestWebSearchQuery?: string;
    storyCard: StoryCard;
  };

  // Spotlight the newly researched place on the minimalist map!
  ctx.onMapHighlight({
    targetType: "building",
    osmId: data.storyCard.osmId,
    label: data.placeName,
    subtitle: `${data.distanceMeters}m ${data.relativeDirection} (${data.clockPosition}) · ${data.answerSummary.slice(0, 90)}`,
    lat: data.lat,
    lon: data.lon,
    geometry: data.storyCard.geometry,
    category: data.category,
    timestamp: Date.now(),
  });

  // Also inject the newly discovered StoryCard into the current CENTER sector cache so future turns know it
  const hb = ctx.getLatestHeartbeat();
  if (hb && hb.sectors.CENTER) {
    const exists = hb.sectors.CENTER.stories.some(
      (s) => s.name.toLowerCase() === data.placeName.toLowerCase()
    );
    if (!exists) {
      hb.sectors.CENTER.stories.unshift(data.storyCard);
      ctx.setLatestHeartbeat({ ...hb });
    }
  }

  const hoursText = data.openingHours ? ` Hours: ${data.openingHours}.` : "";
  const cuisineText = data.cuisine ? ` Cuisine: ${data.cuisine}.` : "";

  return {
    // Without an OSM match the server has no real position, so it reports 0 m; don't let the guide say "right here".
    summary: `${data.placeName} (${
      data.foundInOsm
        ? `${data.distanceMeters}m ${data.relativeDirection} at ${data.clockPosition}`
        : "exact position unknown"
    }${data.address ? `, ${data.address}` : ""}): ${data.answerSummary}${cuisineText}${hoursText} Vibe & reviews: ${
      data.reviewAndVibeSynthesis
    } (If the user asked for specific Google Maps ratings or live customer quotes, also call web_search with "${
      data.suggestWebSearchQuery
    }").`,
    detail: data,
  };
}

function handleHighlightOnMap(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): ToolResult<MapHighlightAction> {
  const loc = ctx.getLocation();
  const hb = ctx.getLatestHeartbeat();
  const label = String(args.label || "Highlighted Landmark");
  const targetType =
    (args.target_type as MapHighlightAction["targetType"]) || "building";
  const osmId = args.osm_id ? String(args.osm_id) : undefined;

  const allStories = hb
    ? Object.values(hb.sectors).flatMap((s) => s.stories)
    : [];
  const matched = allStories.find(
    (s) =>
      (osmId && s.osmId === osmId) ||
      s.name.toLowerCase().includes(label.toLowerCase()) ||
      label.toLowerCase().includes(s.name.toLowerCase())
  );

  const action: MapHighlightAction = {
    targetType,
    osmId: matched?.osmId ?? osmId,
    label: matched?.name ?? label,
    subtitle:
      typeof args.subtitle === "string"
        ? args.subtitle
        : matched?.sensoryHook ?? `Spotlight on ${label}`,
    lat: matched?.lat ?? loc.lat,
    lon: matched?.lon ?? loc.lon,
    geometry: matched?.geometry,
    bearingDeg: loc.headingDeg,
    category: matched?.categories[0],
    timestamp: Date.now(),
  };

  ctx.onMapHighlight(action, true);

  return {
    summary: `Highlighted ${action.label} (${action.targetType}) on the user's map. Any earlier highlight is gone.`,
    detail: action,
  };
}

async function handlePlanOrUpdateRoute(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  savedProfile?: UserCalibrationProfile
): Promise<ToolResult> {
  const current = savedProfile ?? ctx.getProfile();
  // Keep the current mode unless the model asks for one; a bare "make it 5 stops" must not drop the tour.
  const mode: TourMode =
    args.mode === "guided_tour" || args.mode === "wandering" ? args.mode : current.mode;
  const maxStops = Math.min(12, Math.max(2, Number(args.max_stops || 8)));

  if (mode === "guided_tour" && !current.calibrated) {
    return {
      summary:
        "No route yet. The user has not shared what they want to hear about. Ask for topics and vibe, call save_calibration_profile, and only then plan the tour. Do not invent stops.",
    };
  }

  const updatedProfile: UserCalibrationProfile = {
    ...current,
    mode,
    updatedAt: Date.now(),
  };
  ctx.setProfile(updatedProfile);

  if (mode === "wandering") {
    ctx.setActiveRoute(null);
    return {
      summary:
        "Switched to free Wandering Mode. The 4 N/S/E/W research agents are prefetching ahead of your footsteps so you can walk wherever curiosity takes you.",
      detail: { mode: "wandering" },
    };
  }

  const loc = ctx.getLocation();
  const res = await fetch(`${ctx.apiBaseUrl}/api/tour/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lat: loc.lat,
      lon: loc.lon,
      headingDeg: loc.headingDeg,
      profile: updatedProfile,
      maxStops,
    }),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      summary: `Route generation error: ${
        errBody.error || `HTTP ${res.status}`
      }`,
      error: errBody.error || "route_generation_failed",
    };
  }

  const route = (await res.json()) as TourRoute;
  ctx.setActiveRoute(route);

  const firstStop = route.stops[0]?.poi;
  if (firstStop) {
    ctx.onMapHighlight(
      {
        targetType: "building",
        osmId: firstStop.osmId,
        label: route.title,
        subtitle: `Stop 1: ${firstStop.name} (${route.estimatedDurationMinutes} min walk)`,
        lat: firstStop.lat,
        lon: firstStop.lon,
        geometry: firstStop.geometry,
        timestamp: Date.now(),
      },
      true
    );
  }

  const stopNames = route.stops
    .map((s) => `${s.order}. ${s.poi.name}`)
    .join(", ");

  return {
    summary: `Guided tour "${route.title}" is ready: ${route.stops.length} stops, about ${route.estimatedDurationMinutes} minutes, ${Math.round(route.totalDistanceMeters)} meters. Stops (for your reference, do not read them all out): ${stopNames}. Review it once in two short sentences: stop count, time, and the first two stops only, then ask if it sounds good. They can ask for fewer or more stops before they agree; then call this again with max_stops. If they already agreed, guide them to stop 1 and do not replan.`,
    detail: route,
  };
}

async function handleGetNavigationCue(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolResult<NavigationCue>> {
  const loc = ctx.getLocation();
  const route = ctx.getActiveRoute();
  const hb = ctx.getLatestHeartbeat();
  const requestedName = String(args.target_name || "").trim();

  let targetLat: number | undefined;
  let targetLon: number | undefined;
  let targetName = requestedName || "next landmark";

  if (route && route.stops[route.currentStopIndex]) {
    const stop = route.stops[route.currentStopIndex].poi;
    targetLat = stop.lat;
    targetLon = stop.lon;
    targetName = stop.name;
  } else if (hb) {
    const all = Object.values(hb.sectors).flatMap((s) => s.stories);
    const match =
      all.find((s) =>
        s.name.toLowerCase().includes(requestedName.toLowerCase())
      ) ?? hb.recommendedImmediatePoi ?? all[0];
    if (match) {
      targetLat = match.lat;
      targetLon = match.lon;
      targetName = match.name;
    }
  }

  const res = await fetch(`${ctx.apiBaseUrl}/api/navigation/cue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lat: loc.lat,
      lon: loc.lon,
      headingDeg: loc.headingDeg,
      targetLat,
      targetLon,
      targetName,
      mode: ctx.getProfile().mode,
    }),
  });

  const cue = (await res.json()) as NavigationCue;
  return {
    summary: cue.naturalWayfindingCue,
    detail: cue,
  };
}
