import "dotenv/config";
import WebSocket from "ws";
import { loadBosonApiKey } from "../server/bosonToken.js";
import { BOSON_SESSION_TOOLS, executeClientTool } from "../app/src/realtime/tools.js";
import { buildTourSystemPrompt } from "../app/src/realtime/systemPrompt.js";
import {
  DEFAULT_CALIBRATION_PROFILE,
  type SpatialHeartbeatResponse,
  type TourRoute,
  type UserCalibrationProfile,
} from "../shared/types.js";
import { processSpatialHeartbeat } from "../server/research/quadrantOrchestrator.js";

/**
 * Headless Boson Realtime protocol & tool-calling probe (`npm run probe`).
 * Opens a real WebSocket session to `wss://api.boson.ai/v1/realtime` (if BOSON_API_KEY is configured)
 * or runs a local spatial & tool-execution dry-run verification.
 */
async function main() {
  const args = process.argv.slice(2);
  const sayIdx = args.indexOf("--say");
  const utterance =
    sayIdx >= 0 && args[sayIdx + 1]
      ? args[sayIdx + 1]
      : "We're standing at 700 University Avenue in Toronto. What buildings, hospitals, Queen's Park landmarks, or coffee/food spots are right around me?";

  let profile: UserCalibrationProfile = {
    ...DEFAULT_CALIBRATION_PROFILE,
    calibrated: true,
  };
  let latestHeartbeat: SpatialHeartbeatResponse | null = null;
  let activeRoute: TourRoute | null = null;
  const location = {
    lat: 43.6595,
    lon: -79.3912,
    headingDeg: 0,
    speedMps: 0.9,
  };

  console.log("[Probe] 1. Prefetching 4-Quadrant (N/S/E/W) Spatial Tile...");
  latestHeartbeat = await processSpatialHeartbeat({
    ...location,
    profile,
  });
  console.log(
    `[Probe] Prefetched tile ${latestHeartbeat.tileKey} (${latestHeartbeat.neighborhood}) with sectors:`,
    Object.entries(latestHeartbeat.sectors)
      .map(([k, v]) => `${k}=${v.stories.length} (${v.latencyMs}ms)`)
      .join(", ")
  );

  const apiKey = loadBosonApiKey();
  if (!apiKey) {
    console.log(
      "[Probe] No BOSON_API_KEY configured in .env; running local tool-registry verification..."
    );
    const toolRes = await executeClientTool(
      "get_spatial_briefing",
      { direction_filter: "ALL" },
      {
        apiBaseUrl: "http://localhost:3000",
        getLocation: () => location,
        getProfile: () => profile,
        setProfile: (p) => {
          profile = p;
        },
        getLatestHeartbeat: () => latestHeartbeat,
        setLatestHeartbeat: (hb) => {
          latestHeartbeat = hb;
        },
        getActiveRoute: () => activeRoute,
        setActiveRoute: (r) => {
          activeRoute = r;
        },
        onMapHighlight: (hl) => {
          console.log(`[Probe] Map Highlight Triggered: ${hl.label} (${hl.targetType})`);
        },
      }
    );
    console.log("[Probe] Tool Result Summary:", toolRes.summary);
    return;
  }

  console.log("[Probe] 2. Connecting to wss://api.boson.ai/v1/realtime...");
  const ws = new WebSocket("wss://api.boson.ai/v1/realtime", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const start = Date.now();
  const handledCalls = new Set<string>();

  ws.on("open", () => {
    console.log(`[${Date.now() - start}ms] WebSocket open, sending session.update`);
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          model: "higgs-realtime",
          instructions: buildTourSystemPrompt(profile, {
            neighborhood: latestHeartbeat!.neighborhood,
            currentStreet: latestHeartbeat!.currentStreet,
            city: latestHeartbeat!.city,
          }),
          output_modalities: ["audio"],
          tools: BOSON_SESSION_TOOLS,
          audio: {
          input: { format: { type: "audio/pcm", rate: 24000 } },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: profile.voice || "mia",
          },
          },
        },
      })
    );

    ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: utterance }],
        },
      })
    );
    ws.send(JSON.stringify({ type: "response.create" }));
  });

  ws.on("message", async (raw) => {
    const event = JSON.parse(String(raw)) as Record<string, unknown>;
    const elapsed = String(Date.now() - start).padStart(6, " ");

    if (event.type === "response.output_audio.delta") {
      return;
    }

    console.log(`[${elapsed}ms] ${event.type}`);

    if (event.type === "response.output_audio_transcript.done") {
      console.log(`        ↳ Guide: "${event.transcript}"`);
    }

    if (event.type === "response.done") {
      const resp = event.response as { output?: Record<string, unknown>[] } | undefined;
      const outputs = resp?.output ?? [];
      const serverWebSearches = outputs.filter(
        (i) => i.type === "function_call" && i.executor === "server"
      );
      const calls = outputs.filter(
        (i) => i.type === "function_call" && i.executor !== "server"
      );

      if (serverWebSearches.length > 0 && calls.length === 0) {
        const searchArgs = serverWebSearches[0]?.arguments;
        console.log(
          `        ↳ Boson Server Web Search Running: ${String(searchArgs || "")} (waiting for server search result...)`
        );
        return;
      }

      if (calls.length === 0) {
        ws.close(1000, "Probe complete");
        return;
      }

      for (const call of calls) {
        const callId = String(call.call_id);
        if (handledCalls.has(callId)) continue;
        handledCalls.add(callId);
        const name = String(call.name);
        const parsedArgs = JSON.parse(String(call.arguments || "{}"));
        console.log(`        ↳ Tool Call: ${name}(${JSON.stringify(parsedArgs)})`);

        const result = await executeClientTool(name, parsedArgs, {
          apiBaseUrl: "http://localhost:3000",
          getLocation: () => location,
          getProfile: () => profile,
          setProfile: (p) => {
            profile = p;
          },
          getLatestHeartbeat: () => latestHeartbeat,
          setLatestHeartbeat: (hb) => {
            latestHeartbeat = hb;
          },
          getActiveRoute: () => activeRoute,
          setActiveRoute: (r) => {
            activeRoute = r;
          },
          onMapHighlight: (hl) => {
            console.log(`        ↳ Map Spotlight: ${hl.label}`);
          },
        });

        ws.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify(result),
            },
          })
        );
      }
      ws.send(JSON.stringify({ type: "response.create" }));
    }
  });
}

void main();
