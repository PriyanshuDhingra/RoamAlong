import "dotenv/config";
import { describe, expect, it } from "vitest";
import {
  bearingDegrees,
  classifySector,
  haversineMeters,
  relativeClockAndDirection,
  snapToSpatialTile,
} from "../shared/geo.js";
import { createResampler } from "../app/src/audio/resample.js";
import {
  prioritizeSectorsByHeading,
  processSpatialHeartbeat,
} from "../server/research/quadrantOrchestrator.js";
import {
  DEFAULT_CALIBRATION_PROFILE,
  type MapHighlightAction,
  type SpatialHeartbeatResponse,
  type TourRoute,
  type UserCalibrationProfile,
} from "../shared/types.js";
import { executeClientTool } from "../app/src/realtime/tools.js";
import { ProactivityPacer } from "../app/src/location/ProactivityPacer.js";
import { runOnDemandPlaceResearch } from "../server/research/onDemandResearch.js";

describe("Spatial Geometry & Landmark-First Relative Bearings", () => {
  it("classifies CENTER, NORTH, EAST, SOUTH, WEST sectors accurately", () => {
    const origin = { lat: 40.7244, lon: -74.0005 };
    const centerPt = { lat: 40.7245, lon: -74.0005 };
    const northPt = { lat: 40.726, lon: -74.0005 };
    const eastPt = { lat: 40.7244, lon: -73.9985 };
    const southPt = { lat: 40.7225, lon: -74.0005 };
    const westPt = { lat: 40.7244, lon: -74.0025 };

    expect(classifySector(origin, centerPt).sector).toBe("CENTER");
    expect(classifySector(origin, northPt).sector).toBe("NORTH");
    expect(classifySector(origin, eastPt).sector).toBe("EAST");
    expect(classifySector(origin, southPt).sector).toBe("SOUTH");
    expect(classifySector(origin, westPt).sector).toBe("WEST");
  });

  it("computes relative clock-face and body directions for natural wayfinding", () => {
    const straight = relativeClockAndDirection(90, 95);
    expect(straight.relativeDirection).toBe("straight ahead");
    expect(straight.clockPosition).toBe("12 o'clock");

    const right = relativeClockAndDirection(0, 90);
    expect(right.relativeDirection).toBe("on your right");
    expect(right.clockPosition).toBe("3 o'clock");

    const left = relativeClockAndDirection(0, 270);
    expect(left.relativeDirection).toBe("on your left");
    expect(left.clockPosition).toBe("9 o'clock");
  });

  it("snaps nearby coordinates within 150m to the same deterministic tile key", () => {
    const a = snapToSpatialTile({ lat: 40.72441, lon: -74.00051 });
    const b = snapToSpatialTile({ lat: 40.72448, lon: -74.00054 });
    expect(a.tileKey).toBe(b.tileKey);
    expect(haversineMeters(a.snappedCenter, b.snappedCenter)).toBe(0);
  });

  it("prioritizes forward directional research sector based on user heading", () => {
    expect(prioritizeSectorsByHeading(10)[1]).toBe("NORTH");
    expect(prioritizeSectorsByHeading(85)[1]).toBe("EAST");
    expect(prioritizeSectorsByHeading(175)[1]).toBe("SOUTH");
    expect(prioritizeSectorsByHeading(260)[1]).toBe("WEST");
  });
});

describe("Audio Anti-Aliasing Low-Pass Resampler (48kHz -> 24kHz)", () => {
  it("attenuates 20kHz ultrasonic tones above the 12kHz Nyquist limit instead of aliasing", () => {
    const inputRate = 48000;
    const outputRate = 24000;
    const resampler = createResampler(inputRate, outputRate);

    const makeTone = (freqHz: number, length = 4800) => {
      const buf = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        buf[i] = Math.sin((2 * Math.PI * freqHz * i) / inputRate);
      }
      return buf;
    };

    const rms = (arr: Float32Array) => {
      let sum = 0;
      for (let i = 100; i < arr.length; i++) sum += arr[i] * arr[i];
      return Math.sqrt(sum / (arr.length - 100));
    };

    const voiceToneOut = resampler(makeTone(1000));
    const resamplerHigh = createResampler(inputRate, outputRate);
    const highToneOut = resamplerHigh(makeTone(20000));

    expect(rms(voiceToneOut)).toBeGreaterThan(0.6);
    expect(rms(highToneOut)).toBeLessThan(0.12);
  });

  it("maintains continuous phase across 100ms streaming blocks without boundary clicks", () => {
    const resampler = createResampler(48000, 24000);
    const full = new Float32Array(9600);
    for (let i = 0; i < full.length; i++) {
      full[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    }

    const block1 = resampler(full.subarray(0, 4800));
    const block2 = resampler(full.subarray(4800, 9600));

    const stepAtSeam = Math.abs(block2[0] - block1[block1.length - 1]);
    expect(stepAtSeam).toBeLessThan(0.15);
  });
});

describe("4-Quadrant Prefetch Orchestrator, Client Tool Registry & ProactivityPacer", () => {
  it("populates all 5 sectors (CENTER, NORTH, SOUTH, EAST, WEST) and executes client tools", async () => {
    let profile: UserCalibrationProfile = { ...DEFAULT_CALIBRATION_PROFILE };
    let heartbeat: SpatialHeartbeatResponse | null = await processSpatialHeartbeat({
      lat: 43.6595,
      lon: -79.3912,
      headingDeg: 0,
      speedMps: 0.9,
      profile,
    });
    let activeRoute: TourRoute | null = null;
    let lastHighlight: MapHighlightAction | null = null;

    expect(heartbeat.sectors.CENTER).toBeDefined();
    expect(heartbeat.sectors.NORTH).toBeDefined();
    expect(heartbeat.sectors.SOUTH).toBeDefined();
    expect(heartbeat.sectors.EAST).toBeDefined();
    expect(heartbeat.sectors.WEST).toBeDefined();

    const ctx = {
      apiBaseUrl: "http://localhost:3000",
      getLocation: () => ({
        lat: 43.6595,
        lon: -79.3912,
        headingDeg: 0,
        speedMps: 0.9,
      }),
      getProfile: () => profile,
      setProfile: (next: UserCalibrationProfile) => {
        profile = next;
      },
      getLatestHeartbeat: () => heartbeat,
      setLatestHeartbeat: (hb: SpatialHeartbeatResponse) => {
        heartbeat = hb;
      },
      getActiveRoute: () => activeRoute,
      setActiveRoute: (r: TourRoute | null) => {
        activeRoute = r;
      },
      onMapHighlight: (hl: MapHighlightAction) => {
        lastHighlight = hl;
      },
    };

    // 1. Calibration tool
    const calRes = await executeClientTool(
      "save_calibration_profile",
      {
        topics: ["architecture", "food", "engineering"],
        story_style: "architectural_detective",
        mode: "wandering",
        languages: ["English", "French"],
      },
      ctx
    );
    expect(calRes.error).toBeUndefined();
    expect(profile.calibrated).toBe(true);
    expect(profile.topics).toContain("engineering");

    // 2. Spatial briefing tool (caps spoken items at 3 and spotlights top POI)
    const briefRes = await executeClientTool(
      "get_spatial_briefing",
      { direction_filter: "ALL" },
      ctx
    );
    expect(briefRes.summary).toContain("results near");
    expect(lastHighlight).not.toBeNull();

    // 3. Map highlight tool
    const hlRes = await executeClientTool(
      "highlight_on_map",
      {
        target_type: "building",
        label: "Stewart Building",
        subtitle: "1894 E. J. Lennox Romanesque landmark",
      },
      ctx
    );
    expect(hlRes.summary).toContain("Highlighted");

    // 4. ProactivityPacer evaluates proactive moment when right next to a landmark, then passive context update on step
    const pacer = new ProactivityPacer();
    const firstEval = pacer.evaluate({
      location: {
        lat: 43.6595,
        lon: -79.3912,
        headingDeg: 0,
        speedMps: 0.2,
        source: "simulated",
        timestamp: Date.now(),
      },
      heartbeat,
      profile,
      activeRoute: null,
      isGuideBusy: false,
    });
    expect(firstEval.type).toBe("proactive_spoken_moment");

    const secondEval = pacer.evaluate({
      location: {
        lat: 43.6597,
        lon: -79.3912,
        headingDeg: 0,
        speedMps: 1.0,
        source: "simulated",
        timestamp: Date.now(),
      },
      heartbeat,
      profile,
      activeRoute: null,
      isGuideBusy: false,
    });
    expect(secondEval.type).toBe("passive_context_update");

    // 5. On-demand research for uncached restaurants, Google Maps review queries, or facts
    const onDemand = await runOnDemandPlaceResearch({
      query: "Mercatto",
      questionType: "reviews_and_menu",
      lat: 43.6595,
      lon: -79.3912,
      headingDeg: 0,
      profile,
    });
    expect(onDemand.placeName.toLowerCase()).toContain("mercatto");
    expect(onDemand.suggestWebSearchQuery).toContain("Google Maps reviews");
    expect(onDemand.storyCard.categories).toContain("food");
  }, 30000);
});
