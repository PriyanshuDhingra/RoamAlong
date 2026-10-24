import { AudioSession, BOSON_AUDIO_RATE } from "../audio/AudioSession.js";
import { buildTourSystemPrompt } from "./systemPrompt.js";
import {
  BOSON_SESSION_TOOLS,
  executeClientTool,
  type ToolExecutionContext,
} from "./tools.js";

const BOSON_WS_URL = "wss://api.boson.ai/v1/realtime";

export interface ServerEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

export interface TranscriptItem {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  timestamp: number;
  toolName?: string;
  status?: "in_progress" | "done";
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "open"
  | "error";

export type GuideActivityState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "searching";

export function describeCloseCode(code: number, reason?: string): string {
  switch (code) {
    case 1000:
      return reason
        ? `Session ended (${reason}). Ready to reconnect.`
        : "Session closed normally.";
    case 1013:
      return "Boson Realtime server is at max concurrency (1013). Retrying shortly.";
    case 3000:
      return "Ephemeral key expired or invalid (3000). Minting a fresh key on reconnect.";
    case 4429:
      return "Billing quota or credit limit reached (4429). Check your Boson Workspace credits.";
    default:
      return `Connection closed (code ${code}${reason ? `: ${reason}` : ""}).`;
  }
}

export class BosonRealtimeClient {
  private ws: WebSocket | null = null;
  private connecting = false;
  public state: ConnectionState = "disconnected";
  public activity: GuideActivityState = "idle";
  private audio = new AudioSession();
  private handledCallIds = new Set<string>();
  private currentAssistantItemId: string | null = null;
  private toolCtx: ToolExecutionContext;
  private onStateChange?: () => void;
  private onEventLog?: (event: ServerEvent) => void;
  private onTranscriptUpdate?: (items: TranscriptItem[]) => void;
  private onMicLevel?: (rms: number) => void;
  private transcriptItems: TranscriptItem[] = [];
  private transcriptById = new Map<string, TranscriptItem>();

  constructor(
    toolCtx: ToolExecutionContext,
    callbacks?: {
      onStateChange?: () => void;
      onEventLog?: (event: ServerEvent) => void;
      onTranscriptUpdate?: (items: TranscriptItem[]) => void;
      onMicLevel?: (rms: number) => void;
    }
  ) {
    this.toolCtx = toolCtx;
    this.onStateChange = callbacks?.onStateChange;
    this.onEventLog = callbacks?.onEventLog;
    this.onTranscriptUpdate = callbacks?.onTranscriptUpdate;
    this.onMicLevel = callbacks?.onMicLevel;
  }

  /**
   * Connects to Boson Higgs Realtime using a fresh ephemeral `bai-eph-*` token.
   * Includes StrictMode / double-click guard per Boson Tutorial Part 1.
   */
  async connect(): Promise<void> {
    if (
      this.connecting ||
      this.state === "open" ||
      this.state === "connecting"
    ) {
      return;
    }
    this.connecting = true;
    this.audio.unlock();
    this.setState("connecting");

    try {
      await this.audio.initPlayback();

      const tokenRes = await fetch(`${this.toolCtx.apiBaseUrl}/api/token`);
      const tokenData = (await tokenRes.json()) as {
        value?: string;
        error?: string;
      };
      if (!tokenRes.ok || !tokenData.value) {
        throw new Error(
          tokenData.error || `Token endpoint failed (${tokenRes.status})`
        );
      }

      const ws = new WebSocket(BOSON_WS_URL, [
        "realtime",
        `bai-client-secret.${tokenData.value}`,
      ]);
      this.ws = ws;

      ws.onopen = () => {
        this.connecting = false;
        this.setState("open");
        this.setActivity("listening");

        // Every new session starts in Calibration Mode so the guide asks the user how they want to personalize their walk
        const freshSessionProfile = {
          ...this.toolCtx.getProfile(),
          calibrated: false,
          updatedAt: Date.now(),
        };
        this.toolCtx.setProfile(freshSessionProfile);

        this.sendSessionUpdate();

        // Trigger the voice calibration greeting at the start of every new session
        const hb = this.toolCtx.getLatestHeartbeat();
        const streetHint = hb
          ? `right here on ${hb.currentStreet} in ${hb.neighborhood}, ${hb.city}`
          : "right here on the street";
        this.sendUserText(
          `[SESSION_START_CALIBRATION] I just started a new walking tour session ${streetHint}. Greet me warmly with fun energy in 1-2 short sentences, and ask me how I want to personalize our walk today (what topics I'm into like history, architecture, food, art, or trivia, and whether I want Wandering Mode or a Guided Tour).`,
          true,
          true
        );
      };

      ws.onmessage = (msg) => {
        try {
          const event = JSON.parse(String(msg.data)) as ServerEvent;
          this.handleServerEvent(event);
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onerror = () => {
        this.setState("error");
      };

      ws.onclose = (ev) => {
        this.connecting = false;
        this.ws = null;
        this.setState("disconnected");
        this.setActivity("idle");
        this.appendTranscript({
          id: `close_${Date.now()}`,
          role: "system",
          text: describeCloseCode(ev.code, ev.reason),
          timestamp: Date.now(),
          status: "done",
        });
      };
    } catch (err) {
      this.connecting = false;
      this.setState("error");
      this.appendTranscript({
        id: `err_${Date.now()}`,
        role: "system",
        text: err instanceof Error ? err.message : "Failed to connect",
        timestamp: Date.now(),
        status: "done",
      });
    }
  }

  sendSessionUpdate(): void {
    const hb = this.toolCtx.getLatestHeartbeat();
    const profile = this.toolCtx.getProfile();
    const instructions = buildTourSystemPrompt(
      profile,
      hb
        ? {
            neighborhood: hb.neighborhood,
            currentStreet: hb.currentStreet,
            city: hb.city,
          }
        : undefined
    );

    this.send({
      type: "session.update",
      session: {
        model: "higgs-realtime",
        instructions,
        temperature: 0.85,
        output_modalities: ["audio"],
        tools: BOSON_SESSION_TOOLS,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: BOSON_AUDIO_RATE },
            transcription: { model: "higgs-stt-3.1" },
            turn_detection: {
              type: "semantic_vad",
              threshold: 0.55,
              prefix_padding_ms: 300,
              silence_duration_ms: 420,
              min_speech_duration: 0.125,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: BOSON_AUDIO_RATE },
            voice: profile.voice || "mia",
          },
        },
      },
    });
  }

  async startMicrophone(): Promise<void> {
    this.audio.unlock();
    try {
      await this.audio.startMicrophone((base64Pcm) => {
        if (this.state === "open") {
          this.send({
            type: "input_audio_buffer.append",
            audio: base64Pcm,
          });
        }
      }, this.onMicLevel);
    } catch (err) {
      this.appendTranscript({
        id: `mic_err_${Date.now()}`,
        role: "system",
        text: `Microphone error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
        status: "done",
      });
      throw err;
    }
  }

  stopMicrophone(): void {
    this.audio.stopMicrophone();
  }

  /**
   * Sends a user text turn.
   * When `silent` is true, appends `[SPATIAL_CONTEXT]` to the conversation memory WITHOUT
   * calling `response.create`, allowing zero-latency passive location awareness.
   */
  sendUserText(text: string, silent = false, triggerResponse = true): void {
    if (this.state !== "open") return;
    if (!silent) {
      this.appendTranscript({
        id: `user_${Date.now()}`,
        role: "user",
        text,
        timestamp: Date.now(),
        status: "done",
      });
    }
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    if (triggerResponse) {
      this.send({ type: "response.create" });
    }
  }

  /**
   * Injects passive spatial context into the session without triggering spoken output.
   */
  injectPassiveSpatialContext(contextText: string): void {
    this.sendUserText(`[SPATIAL_CONTEXT] ${contextText}`, true, false);
  }

  /**
   * Triggers a proactive spoken observation when the Read-the-Room ProactivityPacer detects
   * a dwell moment or waypoint arrival.
   */
  triggerProactiveMoment(momentPrompt: string): void {
    if (
      this.state !== "open" ||
      this.activity === "speaking" ||
      this.activity === "thinking" ||
      this.activity === "searching"
    ) {
      return;
    }
    this.sendUserText(`[PROACTIVE_MOMENT] ${momentPrompt}`, true, true);
  }

  private async handleServerEvent(event: ServerEvent): Promise<void> {
    this.onEventLog?.(event);

    switch (event.type) {
      case "response.created": {
        this.audio.resetTurnCounter();
        this.setActivity("thinking");
        break;
      }

      case "response.output_item.added": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "message" && item?.role === "assistant") {
          this.currentAssistantItemId = String(item.id || "");
        } else if (
          item?.type === "function_call" &&
          item?.name === "web_search"
        ) {
          this.setActivity("searching");
          this.appendTranscript({
            id: String(item.call_id || `search_${Date.now()}`),
            role: "tool",
            toolName: "web_search (Boson server)",
            text: "Searching live web...",
            timestamp: Date.now(),
            status: "in_progress",
          });
        }
        break;
      }

      case "input_audio_buffer.speech_started": {
        await this.handleBargeIn();
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = String(event.transcript || "").trim();
        if (transcript) {
          this.appendTranscript({
            id: String(event.item_id || `utt_${Date.now()}`),
            role: "user",
            text: transcript,
            timestamp: Date.now(),
            status: "done",
          });
        }
        break;
      }

      case "response.output_audio.delta": {
        const delta = String(event.delta || "");
        if (delta) {
          this.setActivity("speaking");
          this.audio.pushBase64Pcm16(delta);
        }
        break;
      }

      case "response.output_audio_transcript.delta": {
        const itemId = String(event.item_id || "assistant_current");
        const delta = String(event.delta || "");
        const existing = this.transcriptById.get(itemId);
        if (existing) {
          existing.text += delta;
          this.emitTranscript();
        } else {
          this.appendTranscript({
            id: itemId,
            role: "assistant",
            text: delta,
            timestamp: Date.now(),
            status: "in_progress",
          });
        }
        break;
      }

      case "response.output_audio_transcript.done": {
        const itemId = String(event.item_id || "assistant_current");
        const transcript = String(event.transcript || "");
        const existing = this.transcriptById.get(itemId);
        if (existing) {
          existing.text = transcript || existing.text;
          existing.status = "done";
          this.emitTranscript();
        } else if (transcript) {
          this.appendTranscript({
            id: itemId,
            role: "assistant",
            text: transcript,
            timestamp: Date.now(),
            status: "done",
          });
        }
        break;
      }

      case "response.done": {
        const resp = event.response as
          | { output?: Record<string, unknown>[] }
          | undefined;
        const outputItems = resp?.output ?? [];
        const clientCalls = outputItems.filter(
          (item) =>
            item.type === "function_call" && item.executor !== "server"
        );

        if (clientCalls.length > 0) {
          await this.handleClientToolBatch(clientCalls);
        } else {
          this.setActivity("listening");
        }
        break;
      }

      case "error": {
        const errObj = event.error as Record<string, unknown> | undefined;
        const msg = String(errObj?.message || "Boson Realtime error");
        this.appendTranscript({
          id: `err_${Date.now()}`,
          role: "system",
          text: `Realtime notice: ${msg}`,
          timestamp: Date.now(),
          status: "done",
        });
        break;
      }
    }
  }

  /**
   * Executes parallel client function calls in a single batch (`Promise.all`)
   * and sends exactly one `response.create` after all outputs are attached (Boson Tutorial Part 4).
   */
  private async handleClientToolBatch(
    calls: Record<string, unknown>[]
  ): Promise<void> {
    const validCalls = calls.filter((c) => {
      const callId = String(c.call_id || "");
      if (!callId || this.handledCallIds.has(callId)) return false;
      this.handledCallIds.add(callId);
      return true;
    });

    if (validCalls.length === 0) return;
    this.setActivity("thinking");

    const outputs = await Promise.all(
      validCalls.map(async (c) => {
        const callId = String(c.call_id);
        const name = String(c.name);
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(String(c.arguments || "{}"));
        } catch {
          parsedArgs = {};
        }

        this.appendTranscript({
          id: `tool_${callId}`,
          role: "tool",
          toolName: name,
          text: `Running ${name}...`,
          timestamp: Date.now(),
          status: "in_progress",
        });

        const result = await executeClientTool(name, parsedArgs, this.toolCtx);

        const existing = this.transcriptById.get(`tool_${callId}`);
        if (existing) {
          existing.text = result.summary;
          existing.status = "done";
          this.emitTranscript();
        }

        // If calibration profile changed, update session instructions dynamically
        if (name === "save_calibration_profile") {
          this.sendSessionUpdate();
        }

        return {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(result),
          },
        };
      })
    );

    for (const out of outputs) {
      this.send(out);
    }
    this.send({ type: "response.create" });
  }

  /**
   * Sub-second barge-in handler:
   * 1. Flushes the local 24kHz ring buffer immediately.
   * 2. Sends `conversation.item.truncate` with the exact `audio_end_ms` heard by the user.
   */
  private async handleBargeIn(): Promise<void> {
    this.setActivity("listening");
    const playedMs = await this.audio.flushPlayback();
    if (this.currentAssistantItemId && playedMs > 0) {
      this.send({
        type: "conversation.item.truncate",
        item_id: this.currentAssistantItemId,
        content_index: 0,
        audio_end_ms: playedMs,
      });
    }
    this.currentAssistantItemId = null;
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private setState(next: ConnectionState): void {
    this.state = next;
    this.onStateChange?.();
  }

  private setActivity(next: GuideActivityState): void {
    this.activity = next;
    this.onStateChange?.();
  }

  private appendTranscript(item: TranscriptItem): void {
    this.transcriptById.set(item.id, item);
    this.transcriptItems = [...this.transcriptById.values()];
    this.emitTranscript();
  }

  private emitTranscript(): void {
    this.onTranscriptUpdate?.([...this.transcriptItems]);
  }

  async disconnect(): Promise<void> {
    this.connecting = false;
    this.audio.stopMicrophone();
    await this.audio.flushPlayback();
    if (this.ws) {
      this.ws.close(1000, "User disconnected");
      this.ws = null;
    }
    this.setState("disconnected");
    this.setActivity("idle");
  }
}
