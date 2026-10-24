import type {
  SpatialHeartbeatResponse,
  StoryCard,
  TourRoute,
  UserCalibrationProfile,
} from "../../../shared/types.js";
import {
  bearingDegrees,
  haversineMeters,
  relativeClockAndDirection,
} from "../../../shared/geo.js";
import type { LocationSnapshot } from "./LocationManager.js";

export type PacerDecision =
  | { type: "none"; reason: string }
  | { type: "passive_context_update"; contextText: string; reason: string }
  | {
      type: "proactive_spoken_moment";
      promptText: string;
      poi?: StoryCard;
      reason: string;
    };

/**
 * The "Read the Room" Engine for Wandering Mode & Guided Tour Mode.
 * Tracks every 15m of movement, walking speed, dwell time near landmarks, tile changes, and cooldowns
 * so the guide updates context continuously as the user moves and speaks up naturally at landmarks.
 */
export class ProactivityPacer {
  private lastSpokenTriggerAt = 0;
  private lastPassiveUpdateAt = 0;
  private lastTileKey = "";
  private lastStreet = "";
  private lastContextAnchor: { lat: number; lon: number; headingDeg: number } | null = null;
  private narratedPoiIds = new Set<string>();
  private lingerStartAt: number | null = null;
  private lingerAnchor: { lat: number; lon: number } | null = null;

  evaluate(params: {
    location: LocationSnapshot;
    heartbeat: SpatialHeartbeatResponse | null;
    profile: UserCalibrationProfile;
    activeRoute: TourRoute | null;
    isGuideBusy: boolean;
  }): PacerDecision {
    const { location, heartbeat, profile, activeRoute, isGuideBusy } = params;
    if (!heartbeat) {
      return { type: "none", reason: "Waiting for initial spatial prefetch" };
    }

    const now = Date.now();

    // Track lingering / stationary behavior (<0.45 m/s)
    if (location.speedMps <= 0.45) {
      if (
        !this.lingerAnchor ||
        haversineMeters(this.lingerAnchor, location) > 12
      ) {
        this.lingerAnchor = { lat: location.lat, lon: location.lon };
        this.lingerStartAt = now;
      }
    } else {
      this.lingerAnchor = null;
      this.lingerStartAt = null;
    }

    const lingerSeconds = this.lingerStartAt
      ? Math.round((now - this.lingerStartAt) / 1000)
      : 0;

    // 1. Guided Tour Mode Priority: Check arrival at current tour stop FIRST
    if (profile.mode === "guided_tour" && activeRoute) {
      const currentStop = activeRoute.stops[activeRoute.currentStopIndex];
      if (currentStop && !currentStop.visited) {
        const distToStop = Math.round(
          haversineMeters(location, currentStop.poi)
        );
        const bearing = Math.round(bearingDegrees(location, currentStop.poi));
        const { clockPosition } = relativeClockAndDirection(
          location.headingDeg,
          bearing
        );

        if (distToStop <= currentStop.arrivalRadiusMeters) {
          currentStop.visited = true;
          if (activeRoute.currentStopIndex < activeRoute.stops.length - 1) {
            activeRoute.currentStopIndex += 1;
          }
          this.lastSpokenTriggerAt = now;
          this.narratedPoiIds.add(currentStop.poi.osmId);
          return {
            type: "proactive_spoken_moment",
            poi: currentStop.poi,
            reason: `Arrived at Guided Stop #${currentStop.order}: ${currentStop.poi.name}`,
            promptText: `The walker has just arrived right in front of Guided Tour Stop #${currentStop.order}, ${currentStop.poi.name} (${distToStop}m away at ${clockPosition}). Call highlight_on_map for "${currentStop.poi.name}" and share its sensory hook ("${currentStop.poi.sensoryHook}") and story ("${currentStop.poi.narrativeSummary}"), then ask "${currentStop.poi.followUpQuestion}"`,
          };
        }
      }
    }

    // 2. Wandering & Guided Proximity Arrival: Check if walker stepped within 35m of a new landmark
    // Wait until voice calibration is complete (profile.calibrated === true) OR the walker has actively moved >=15m
    const hasActivelyMoved =
      this.lastContextAnchor !== null &&
      haversineMeters(this.lastContextAnchor, location) >= 15;

    if (
      !isGuideBusy &&
      (profile.calibrated || hasActivelyMoved) &&
      profile.proactivity !== "on_demand"
    ) {
      const cooldownMs = profile.proactivity === "high" ? 12000 : 18000;
      if (now - this.lastSpokenTriggerAt >= cooldownMs) {
        const allStories = Object.values(heartbeat.sectors).flatMap(
          (s) => s.stories
        );
        const unseenStories = allStories
          .filter((s) => !this.narratedPoiIds.has(s.osmId))
          .map((s) => {
            const dist = Math.round(haversineMeters(location, s));
            const bearing = Math.round(bearingDegrees(location, s));
            const { relativeDirection, clockPosition, angleDiff } =
              relativeClockAndDirection(location.headingDeg, bearing);
            return {
              story: s,
              dist,
              relativeDirection,
              clockPosition,
              angleDiff,
            };
          })
          .sort((a, b) => a.dist - b.dist);

        const closest = unseenStories[0];
        if (closest) {
          const isCloseArrival =
            closest.dist <= 35 && Math.abs(closest.angleDiff) <= 95;
          const isLingeringCurious = lingerSeconds >= 5 && closest.dist <= 70;

          if (isCloseArrival || isLingeringCurious) {
            this.lastSpokenTriggerAt = now;
            this.narratedPoiIds.add(closest.story.osmId);

            const altHook = heartbeat.directionHooks.find(
              (h) => h.topPoiName !== closest.story.name
            );

            return {
              type: "proactive_spoken_moment",
              poi: closest.story,
              reason: isLingeringCurious
                ? `Lingered ${lingerSeconds}s near ${closest.story.name}`
                : `Walked within ${closest.dist}m of ${closest.story.name}`,
              promptText: `The walker just walked up to ${closest.story.name} (${closest.dist}m ${closest.relativeDirection} at ${closest.clockPosition}). Call highlight_on_map for "${closest.story.name}", point out its sensory hook ("${closest.story.sensoryHook}"), share the story ("${closest.story.narrativeSummary}"), and ask "${closest.story.followUpQuestion}"${
                altHook
                  ? ` or tease ${altHook.topPoiName} (${altHook.relativeDirection})`
                  : ""
              }.`,
            };
          }
        }
      }
    }

    // 3. Continuous Movement Context Sync:
    // Whenever the walker moves >=15m, turns >=35 degrees, or enters a new street/tile,
    // push a fresh `[SPATIAL_CONTEXT]` update with updated distances & clock-face bearings!
    const movedMeters = this.lastContextAnchor
      ? Math.round(haversineMeters(this.lastContextAnchor, location))
      : 999;
    const turnedDeg = this.lastContextAnchor
      ? Math.abs(
          ((location.headingDeg - this.lastContextAnchor.headingDeg + 540) %
            360) -
            180
        )
      : 999;
    const streetOrTileChanged =
      heartbeat.currentStreet !== this.lastStreet ||
      heartbeat.tileKey !== this.lastTileKey;

    if (
      (streetOrTileChanged || movedMeters >= 15 || turnedDeg >= 35) &&
      now - this.lastPassiveUpdateAt >= 2000
    ) {
      this.lastStreet = heartbeat.currentStreet;
      this.lastTileKey = heartbeat.tileKey;
      this.lastPassiveUpdateAt = now;
      this.lastContextAnchor = {
        lat: location.lat,
        lon: location.lon,
        headingDeg: location.headingDeg,
      };

      const sortedByProximity = Object.values(heartbeat.sectors)
        .flatMap((s) => s.stories)
        .map((s) => {
          const d = Math.round(haversineMeters(location, s));
          const b = Math.round(bearingDegrees(location, s));
          const { relativeDirection, clockPosition } =
            relativeClockAndDirection(location.headingDeg, b);
          return { s, d, relativeDirection, clockPosition };
        })
        .sort((a, b) => a.d - b.d);

      const topStories = sortedByProximity
        .slice(0, 4)
        .map(
          ({ s, d, relativeDirection, clockPosition }) =>
            `${s.name} (${d}m ${relativeDirection} at ${clockPosition}: ${s.sensoryHook})`
        )
        .join(" | ");

      const guidedStopInfo =
        profile.mode === "guided_tour" &&
        activeRoute &&
        activeRoute.stops[activeRoute.currentStopIndex]
          ? ` Next Guided Tour Stop #${
              activeRoute.currentStopIndex + 1
            }: ${
              activeRoute.stops[activeRoute.currentStopIndex].poi.name
            } (${Math.round(
              haversineMeters(
                location,
                activeRoute.stops[activeRoute.currentStopIndex].poi
              )
            )}m away).`
          : "";

      return {
        type: "passive_context_update",
        reason: `Updated context (${movedMeters < 900 ? `moved ${movedMeters}m on ` : ""}${heartbeat.currentStreet})`,
        contextText: `Walker moved to (${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}) on ${heartbeat.currentStreet} in ${heartbeat.neighborhood}, facing ${location.headingDeg} deg.${guidedStopInfo} Closest landmarks right now: ${topStories}`,
      };
    }

    return { type: "none", reason: `Strolling ${heartbeat.currentStreet}` };
  }

  markNarrated(osmId: string): void {
    this.narratedPoiIds.add(osmId);
    this.lastSpokenTriggerAt = Date.now();
  }

  resetHistory(): void {
    this.narratedPoiIds.clear();
    this.lastSpokenTriggerAt = 0;
  }
}
