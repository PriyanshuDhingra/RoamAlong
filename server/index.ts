import "dotenv/config";
import express from "express";
import cors from "cors";
import { mintBosonEphemeralToken } from "./bosonToken.js";
import {
  generateGuidedTourRoute,
  processSpatialHeartbeat,
} from "./research/quadrantOrchestrator.js";
import {
  DEFAULT_CALIBRATION_PROFILE,
  type SpatialHeartbeatRequest,
  type UserCalibrationProfile,
} from "../shared/types.js";
import {
  bearingDegrees,
  haversineMeters,
  relativeClockAndDirection,
} from "../shared/geo.js";
import {
  fetchOsrmWalkingRoute,
  reverseGeocodeOsm,
  searchPlaceNominatim,
} from "./osm/nominatimAndOsrm.js";
import { fetchWikipediaSummaryByTag } from "./research/wikipediaClient.js";
import { runOnDemandPlaceResearch } from "./research/onDemandResearch.js";
import { getCacheStats } from "./cache/persistentStore.js";
import { getToolFiller } from "./voiceFiller.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  // One line per API call, so phone sessions can be followed from the server log.
  app.use("/api", (req, _res, next) => {
    const b = req.body ?? {};
    const where = typeof b.lat === "number" ? ` @${b.lat.toFixed(5)},${b.lon.toFixed(5)}` : "";
    const mode = b.profile?.mode ? ` mode=${b.profile.mode} calibrated=${b.profile.calibrated}` : "";
    console.log(`[api] ${new Date().toISOString().slice(11, 19)} ${req.method} ${req.path}${where}${mode}`);
    next();
  });

  app.get("/api/voice/filler", async (req, res) => {
    const voice = typeof req.query.voice === "string" ? req.query.voice : "oliver";
    const filler = await getToolFiller(
      voice,
      req.query.kind === "route" ? "route" : "lookup"
    );
    if (!filler) {
      res.status(503).json({ error: "Filler unavailable" });
      return;
    }
    res.json(filler);
  });

  // 1. Ephemeral Boson Realtime Token Endpoint
  app.get("/api/token", async (_req, res) => {
    const result = await mintBosonEphemeralToken(600);
    res.status(result.status).json(result.data);
  });

  // 2. 4-Quadrant (N/S/E/W) Spatial Heartbeat & Prefetch Orchestrator
  app.post("/api/spatial/heartbeat", async (req, res) => {
    try {
      const body = req.body as Partial<SpatialHeartbeatRequest>;
      const lat = typeof body.lat === "number" ? body.lat : 43.6595;
      const lon = typeof body.lon === "number" ? body.lon : -79.3912;
      const headingDeg =
        typeof body.headingDeg === "number" ? body.headingDeg : 0;
      const speedMps = typeof body.speedMps === "number" ? body.speedMps : 0.8;
      const profile: UserCalibrationProfile = {
        ...DEFAULT_CALIBRATION_PROFILE,
        ...(body.profile ?? {}),
      };

      const data = await processSpatialHeartbeat({
        lat,
        lon,
        headingDeg,
        speedMps,
        profile,
      });
      res.json(data);
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : "Failed to process spatial heartbeat",
      });
    }
  });

  // 3. Generate or Update a Guided Tour Route via OSRM + Prefetched POIs
  app.post("/api/tour/generate", async (req, res) => {
    try {
      const { lat = 43.6595, lon = -79.3912, headingDeg = 0, profile, maxStops = 8 } =
        req.body ?? {};
      const route = await generateGuidedTourRoute(
        { lat: Number(lat), lon: Number(lon) },
        Number(headingDeg),
        { ...DEFAULT_CALIBRATION_PROFILE, ...(profile ?? {}) },
        Number(maxStops)
      );
      res.json(route);
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : "Failed to generate tour route",
      });
    }
  });

  // 4. Deep-dive lookup on a specific landmark / POI
  app.post("/api/spatial/deep-dive", async (req, res) => {
    try {
      const { name, lat = 43.6595, lon = -79.3912, profile } = req.body ?? {};
      const heartbeat = await processSpatialHeartbeat({
        lat: Number(lat),
        lon: Number(lon),
        headingDeg: 0,
        speedMps: 0,
        profile: { ...DEFAULT_CALIBRATION_PROFILE, ...(profile ?? {}) },
      });

      const allStories = Object.values(heartbeat.sectors).flatMap(
        (s) => s.stories
      );
      const queryLower = String(name || "").trim().toLowerCase();
      const matched = queryLower
        ? allStories.find(
            (s) =>
              s.name.toLowerCase().includes(queryLower) ||
              queryLower.includes(s.name.toLowerCase())
          )
        : allStories[0];

      // If the place is NOT in the prefetched 4-quadrant cache, run live on-demand research!
      if (!matched && queryLower) {
        const onDemand = await runOnDemandPlaceResearch({
          query: String(name),
          questionType: "history_and_facts",
          lat: Number(lat),
          lon: Number(lon),
          headingDeg: 0,
          profile: { ...DEFAULT_CALIBRATION_PROFILE, ...(profile ?? {}) },
        });
        res.json({
          story: onDemand.storyCard,
          wikipediaExtract: onDemand.answerSummary,
          reviewAndVibeSynthesis: onDemand.reviewAndVibeSynthesis,
          suggestWebSearchQuery: onDemand.suggestWebSearchQuery,
          neighborhood: heartbeat.neighborhood,
          currentStreet: heartbeat.currentStreet,
          fromOnDemandResearch: true,
        });
        return;
      }

      const wikiExtra = name
        ? await fetchWikipediaSummaryByTag(`en:${String(name)}`)
        : undefined;

      res.json({
        story: matched,
        wikipediaExtract: wikiExtra?.extract ?? matched?.narrativeSummary,
        neighborhood: heartbeat.neighborhood,
        currentStreet: heartbeat.currentStreet,
        fromOnDemandResearch: false,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Deep dive lookup failed",
      });
    }
  });

  // 4b. On-demand research for uncached places, restaurants, reviews, or facts
  app.post("/api/spatial/on-demand", async (req, res) => {
    try {
      const {
        query = "",
        questionType = "reviews_and_menu",
        lat = 43.6595,
        lon = -79.3912,
        headingDeg = 0,
        profile,
      } = req.body ?? {};

      const result = await runOnDemandPlaceResearch({
        query: String(query),
        questionType,
        lat: Number(lat),
        lon: Number(lon),
        headingDeg: Number(headingDeg),
        profile: { ...DEFAULT_CALIBRATION_PROFILE, ...(profile ?? {}) },
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : "On-demand research failed",
      });
    }
  });

  // 4c. Street-following walking route from the walker to the next spot
  app.post("/api/navigation/walk-route", async (req, res) => {
    const { fromLat, fromLon, toLat, toLon } = req.body ?? {};
    if (
      [fromLat, fromLon, toLat, toLon].some(
        (v) => typeof v !== "number" || Number.isNaN(v)
      )
    ) {
      res
        .status(400)
        .json({ error: "fromLat, fromLon, toLat and toLon must be numbers" });
      return;
    }
    try {
      const leg = await fetchOsrmWalkingRoute([
        { lat: fromLat, lon: fromLon },
        { lat: toLat, lon: toLon },
      ]);
      res.json(leg);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : "Walking route failed",
      });
    }
  });

  // 5. Landmark-First Relative Navigation Cue Endpoint
  app.post("/api/navigation/cue", async (req, res) => {
    try {
      const {
        lat = 43.6595,
        lon = -79.3912,
        headingDeg = 0,
        targetLat,
        targetLon,
        targetName = "next landmark",
        mode = "wandering",
      } = req.body ?? {};

      const origin = { lat: Number(lat), lon: Number(lon) };
      const geo = await reverseGeocodeOsm(origin);

      const dest =
        typeof targetLat === "number" && typeof targetLon === "number"
          ? { lat: targetLat, lon: targetLon }
          : { lat: origin.lat + 0.0006, lon: origin.lon + 0.0003 };

      const distanceMeters = Math.round(haversineMeters(origin, dest));
      const bearingDeg = Math.round(bearingDegrees(origin, dest));
      const { clockPosition, relativeDirection } = relativeClockAndDirection(
        Number(headingDeg),
        bearingDeg
      );

      const naturalWayfindingCue =
        distanceMeters <= 18
          ? `You have arrived right in front of ${targetName} on ${geo.currentStreet}.`
          : `From ${geo.currentStreet}, look ${relativeDirection} (${clockPosition})—${targetName} is about ${distanceMeters} meters away.`;

      res.json({
        mode,
        currentStreet: geo.currentStreet,
        neighborhood: geo.neighborhood,
        targetName,
        distanceMeters,
        bearingDeg,
        clockPosition,
        relativeDirection,
        naturalWayfindingCue,
        offRoute: distanceMeters > 260,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : "Failed to compute navigation cue",
      });
    }
  });

  // 6. Place search for Debug Simulator Teleport
  app.get("/api/spatial/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) {
      res.json({ results: [] });
      return;
    }
    const results = await searchPlaceNominatim(q);
    res.json({ results });
  });

  // 7. Cache & Persistence Telemetry Endpoint
  app.get("/api/cache/stats", (_req, res) => {
    res.json(getCacheStats());
  });

  return app;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server/index.ts");

if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();
  app.listen(port, () => {
    console.log(
      `[RoamAlong Server] Listening on http://localhost:${port}`
    );
  });
}
