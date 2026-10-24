import { AudioSession, BOSON_AUDIO_RATE } from "../audio/AudioSession.js";
import { buildTourSystemPrompt } from "./systemPrompt.js";
import {
  BOSON_SESSION_TOOLS,
  executeClientTool,
  type ToolExecutionContext,
} from "./tools.js";

const BOSON_WS_URL = "wss://api.boson.ai/v1/realtime";
const SLOW_TOOLS = new Set([
  "get_spatial_briefing",
  "deep_dive_poi",
  "lookup_place_reviews_and_facts",
  "plan_or_update_route",
  "get_navigation_cue",
  "web_search",
]);

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

function revealWords(text: string, ratio: number): string {
  if (ratio >= 1) return text;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const count = Math.max(1, Math.ceil(words.length * ratio));
  return words.slice(0, count).join(" ");
}

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
  private responseInFlight = false;
  private toolBatchInFlight = false;
  private activeResponseId: string | null = null;
  private cancelledResponseId: string | null = null;
  private currentAssistantItemId: string | null = null;
  private toolCtx: ToolExecutionContext;
  private onStateChange?: () => void;
  private onEventLog?: (event: ServerEvent) => void;
  private onTranscriptUpdate?: (items: TranscriptItem[]) => void;
  private onMicLevel?: (rms: number) => void;
  private transcriptItems: TranscriptItem[] = [];
  private transcriptById = new Map<string, TranscriptItem>();
  private fullTextById = new Map<string, string>();
  private turnAudioDone = false;
  private responseSpoke = false;
  private fillerEpoch = 0;
  private fillerTimer: ReturnType<typeof setTimeout> | null = null;
  private fillerActive = false;
  private answerHold: string[] | null = null;

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
    this.audio.onPlaybackProgress = ({ played, queued, available }) => {
      this.syncCaptionWithPlayback(played, queued, available);
    };
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
        this.responseInFlight = true;
        this.setState("open");
        this.setActivity("thinking");

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
        const voice = freshSessionProfile.voice;
        const guideName =
          voice && voice !== "default"
            ? voice.charAt(0).toUpperCase() + voice.slice(1)
            : null;
        const streetHint = hb
          ? `right here on ${hb.currentStreet} in ${hb.neighborhood}, ${hb.city}`
          : "right here on the street";
        const introduction = guideName
          ? `Start with "Hi, I'm ${guideName}, and I'll be your tour guide."`
          : "Start with hi, then say you will be my tour guide.";
        this.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `[SESSION_START_CALIBRATION] I just started a new walking tour session ${streetHint}. ${introduction} Then, in the same short greeting, ask what topics or vibe I'm into today (like history, architecture, food, art, or trivia). The Wander / Tours button on screen already sets the mode, so don't ask about wandering vs guided tour. Don't ask which language I want. Speak in whatever language I use.`,
              },
            ],
          },
        });
        this.send({ type: "response.create" });
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
        this.responseInFlight = false;
        this.toolBatchInFlight = false;
        this.activeResponseId = null;
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
        if (this.state === "open" && !this.toolBatchInFlight) {
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
    if (triggerResponse && (this.responseInFlight || this.toolBatchInFlight)) {
      return;
    }
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
      this.responseInFlight = true;
      this.setActivity("thinking");
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
      this.responseInFlight ||
      this.toolBatchInFlight ||
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
        const resp = event.response as { id?: string } | undefined;
        this.activeResponseId = resp?.id ? String(resp.id) : null;
        this.responseInFlight = true;
        this.turnAudioDone = false;
        this.responseSpoke = false;
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
          this.scheduleToolFiller(250);
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
        const respId = event.response_id ? String(event.response_id) : null;
        if (respId && this.isStaleResponse(respId)) {
          break;
        }
        const delta = String(event.delta || "");
        if (delta) this.playAnswerAudio(delta);
        break;
      }

      case "response.output_audio_transcript.delta": {
        const respId = event.response_id ? String(event.response_id) : null;
        if (respId && this.isStaleResponse(respId)) {
          break;
        }
        const itemId = String(event.item_id || "assistant_current");
        const delta = String(event.delta || "");
        this.currentAssistantItemId = itemId;
        this.fullTextById.set(itemId, (this.fullTextById.get(itemId) || "") + delta);
        if (!this.transcriptById.has(itemId)) {
          this.appendTranscript({
            id: itemId,
            role: "assistant",
            text: "",
            timestamp: Date.now(),
            status: "in_progress",
          });
        }
        break;
      }

      case "response.output_audio_transcript.done": {
        const itemId = String(event.item_id || "assistant_current");
        const transcript = String(event.transcript || "");
        if (transcript) {
          this.fullTextById.set(itemId, transcript);
        }
        if (!this.transcriptById.has(itemId) && transcript) {
          this.appendTranscript({
            id: itemId,
            role: "assistant",
            text: "",
            timestamp: Date.now(),
            status: "in_progress",
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
          this.turnAudioDone = true;
        }
        break;
      }

      case "error": {
        this.responseInFlight = false;
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
    if (
      !this.responseSpoke &&
      validCalls.some((call) => SLOW_TOOLS.has(String(call.name)))
    ) {
      this.scheduleToolFiller(0);
    }
    this.toolBatchInFlight = true;
    this.responseInFlight = true;
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
    this.toolBatchInFlight = false;
    this.send({ type: "response.create" });
  }

  /**
   * Sub-second barge-in handler:
   * 1. Flushes the local 24kHz ring buffer immediately.
   * 2. Sends `conversation.item.truncate` with the exact `audio_end_ms` heard by the user.
   */
  private isStaleResponse(respId: string): boolean {
    if (this.cancelledResponseId && respId === this.cancelledResponseId) {
      return true;
    }
    return Boolean(this.activeResponseId && respId !== this.activeResponseId);
  }

  private scheduleToolFiller(delayMs: number): void {
    if (this.responseSpoke || this.fillerActive || this.fillerTimer) return;
    this.fillerTimer = setTimeout(() => {
      this.fillerTimer = null;
      if (!this.responseSpoke) void this.playToolFiller();
    }, delayMs);
  }

  private async playToolFiller(): Promise<void> {
    const epoch = ++this.fillerEpoch;
    const voice = this.toolCtx.getProfile().voice || "mia";
    try {
      const res = await fetch(
        `${this.toolCtx.apiBaseUrl}/api/voice/filler?voice=${encodeURIComponent(voice)}`
      );
      if (!res.ok || epoch !== this.fillerEpoch || this.responseSpoke) return;
      const data = (await res.json()) as { text?: string; audioBase64?: string };
      if (!data.audioBase64 || epoch !== this.fillerEpoch || this.responseSpoke) return;
      this.fillerActive = true;
      this.setActivity("speaking");
      const id = `filler_${epoch}`;
      const text = data.text || "One sec, I'm checking.";
      this.currentAssistantItemId = id;
      this.fullTextById.set(id, text);
      this.appendTranscript({
        id,
        role: "assistant",
        text: "",
        timestamp: Date.now(),
        status: "in_progress",
      });
      this.audio.pushBase64Pcm16(data.audioBase64);
    } catch {
      // The tool result is still spoken when the lookup finishes.
    }
  }

  private playAnswerAudio(delta: string): void {
    this.responseSpoke = true;
    if (this.fillerTimer) {
      clearTimeout(this.fillerTimer);
      this.fillerTimer = null;
    }
    this.fillerEpoch++;
    if (this.fillerActive) {
      this.fillerActive = false;
      this.answerHold = [delta];
      void this.audio.flushPlayback().then(() => {
        const held = this.answerHold;
        this.answerHold = null;
        if (!held) return;
        for (const chunk of held) this.audio.pushBase64Pcm16(chunk);
      });
      return;
    }
    if (this.answerHold) {
      this.answerHold.push(delta);
      return;
    }
    this.setActivity("speaking");
    this.audio.pushBase64Pcm16(delta);
  }

  private cancelToolFiller(): void {
    if (this.fillerTimer) {
      clearTimeout(this.fillerTimer);
      this.fillerTimer = null;
    }
    this.fillerEpoch++;
    const wasPlaying = this.fillerActive;
    this.fillerActive = false;
    this.answerHold = null;
    if (wasPlaying) void this.audio.flushPlayback();
  }

  private async handleBargeIn(): Promise<void> {
    this.cancelToolFiller();
    if (this.toolBatchInFlight) return;
    if (this.activeResponseId) {
      this.cancelledResponseId = this.activeResponseId;
    }
    this.turnAudioDone = false;
    this.responseInFlight = false;
    this.activeResponseId = null;
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

  private syncCaptionWithPlayback(
    played: number,
    queued: number,
    available: number
  ): void {
    const id = this.currentAssistantItemId;
    if (id) {
      const full = this.fullTextById.get(id) || "";
      const item = this.transcriptById.get(id);
      if (item && full) {
        const ratio =
          this.turnAudioDone && available === 0
            ? 1
            : queued > 0
              ? Math.min(1, played / queued)
              : 0;
        const nextText = revealWords(full, ratio);
        const nextStatus =
          this.turnAudioDone && available === 0 ? "done" : "in_progress";
        if (item.text !== nextText || item.status !== nextStatus) {
          item.text = nextText;
          item.status = nextStatus;
          this.emitTranscript();
        }
      }
    }
    if (this.turnAudioDone && available === 0 && this.responseInFlight) {
      this.turnAudioDone = false;
      this.responseInFlight = false;
      this.setActivity("listening");
    }
  }

  async disconnect(): Promise<void> {
    this.connecting = false;
    this.cancelToolFiller();
    this.responseInFlight = false;
    this.toolBatchInFlight = false;
    this.activeResponseId = null;
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
