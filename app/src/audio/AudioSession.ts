import {
  base64ToInt16,
  createResampler,
  floatTo16BitPCM,
  int16ToBase64,
} from "./resample.js";

export const BOSON_AUDIO_RATE = 24000;

const PLAYBACK_WORKLET_CODE = `
class PlaybackRingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * 60);
    this.ring = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.played = 0;
    this.queued = 0;
    this.tick = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "push") {
        const samples = msg.samples;
        this.queued += samples.length;
        for (let i = 0; i < samples.length; i++) {
          this.ring[this.write] = samples[i];
          this.write = (this.write + 1) % this.size;
          if (this.available < this.size) {
            this.available++;
          } else {
            this.read = (this.read + 1) % this.size;
          }
        }
      } else if (msg.type === "reset_turn") {
        this.played = 0;
        this.queued = 0;
      } else if (msg.type === "flush") {
        const playedCount = this.played;
        this.available = 0;
        this.read = this.write;
        this.played = 0;
        this.queued = 0;
        this.port.postMessage({ type: "flushed", played: playedCount, id: msg.id });
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      if (this.available > 0) {
        out[i] = this.ring[this.read];
        this.read = (this.read + 1) % this.size;
        this.available--;
        this.played++;
      } else {
        out[i] = 0;
      }
    }
    this.tick += out.length;
    if (this.tick >= 2048) {
      this.tick = 0;
      this.port.postMessage({
        type: "progress",
        played: this.played,
        queued: this.queued,
        available: this.available,
      });
    }
    return true;
  }
}
registerProcessor("boson-playback-processor", PlaybackRingProcessor);

class CaptureFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.targetSize = Math.round(sampleRate * 0.05);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.buffer.push(input[i]);
    }
    if (this.buffer.length >= this.targetSize) {
      const frame = Float32Array.from(this.buffer);
      this.buffer = [];
      this.port.postMessage({ type: "frame", frame });
    }
    return true;
  }
}
registerProcessor("boson-capture-processor", CaptureFrameProcessor);
`;

type NavigatorWithAudioSession = Navigator & {
  audioSession?: { type: string };
};

/**
 * One AudioContext at the device's native sample rate drives both playback and mic capture.
 * iOS Safari only runs a single hardware rate and only starts audio from inside a user gesture,
 * so `unlock()` must be called synchronously from the tap handler before any `await`.
 */
export class AudioSession {
  private ctx: AudioContext | null = null;
  private modulesLoaded: Promise<void> | null = null;
  private playbackNode: AudioWorkletNode | null = null;
  private playbackResampler: ((block: Float32Array) => Float32Array) | null =
    null;
  private captureNode: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private flushReqId = 0;
  private flushResolvers = new Map<number, (playedMs: number) => void>();
  public onPlaybackProgress?: (progress: {
    played: number;
    queued: number;
    available: number;
  }) => void;

  unlock(): void {
    if (typeof window === "undefined" || typeof AudioContext === "undefined") {
      return;
    }

    const nav = navigator as NavigatorWithAudioSession;
    if (nav.audioSession) {
      try {
        // "playback" keeps sound on when the ringer is silent, but iOS then refuses the microphone.
        // "play-and-record" is the category a voice conversation needs.
        nav.audioSession.type = "play-and-record";
      } catch {
        // Unsupported audio session type on this browser
      }
    }

    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    void this.ctx.resume();

    const silent = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const src = this.ctx.createBufferSource();
    src.buffer = silent;
    src.connect(this.ctx.destination);
    src.start(0);
  }

  private async ensureModules(): Promise<AudioContext> {
    if (!this.ctx) {
      throw new Error(
        "Audio engine not unlocked. Call unlock() from the tap handler first."
      );
    }
    const ctx = this.ctx;
    if (!ctx.audioWorklet) {
      throw new Error(
        "AudioWorklet is unavailable. Open the app over HTTPS (or localhost) so the browser allows audio processing."
      );
    }
    if (!this.modulesLoaded) {
      const blob = new Blob([PLAYBACK_WORKLET_CODE], {
        type: "application/javascript",
      });
      const url = URL.createObjectURL(blob);
      this.modulesLoaded = ctx.audioWorklet
        .addModule(url)
        .finally(() => URL.revokeObjectURL(url));
    }
    await this.modulesLoaded;
    return ctx;
  }

  async initPlayback(): Promise<void> {
    if (typeof window === "undefined" || typeof AudioContext === "undefined") {
      return;
    }
    const ctx = await this.ensureModules();

    if (!this.playbackNode) {
      this.playbackNode = new AudioWorkletNode(ctx, "boson-playback-processor");
      this.playbackNode.port.onmessage = (e) => {
        if (e.data?.type === "flushed") {
          const playedMs = Math.round(
            (Number(e.data.played ?? 0) / ctx.sampleRate) * 1000
          );
          const resolver = this.flushResolvers.get(e.data.id);
          if (resolver) {
            this.flushResolvers.delete(e.data.id);
            resolver(playedMs);
          }
        } else if (e.data?.type === "progress") {
          this.onPlaybackProgress?.({
            played: Number(e.data.played ?? 0),
            queued: Number(e.data.queued ?? 0),
            available: Number(e.data.available ?? 0),
          });
        }
      };
      this.playbackNode.connect(ctx.destination);
      this.playbackResampler = createResampler(BOSON_AUDIO_RATE, ctx.sampleRate);
    }

    if (ctx.state !== "running") {
      await ctx.resume();
    }
    if (ctx.state !== "running") {
      throw new Error(
        `Browser blocked audio playback (AudioContext is "${ctx.state}"). Tap "Start Live Voice Tour" again.`
      );
    }
  }

  resetTurnCounter(): void {
    this.playbackNode?.port.postMessage({ type: "reset_turn" });
  }

  pushBase64Pcm16(base64Delta: string): void {
    if (!this.playbackNode || !this.playbackResampler) return;
    const int16 = base64ToInt16(base64Delta);
    const floats = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      floats[i] = int16[i] / 32768;
    }
    const samples = this.playbackResampler(floats);
    this.playbackNode.port.postMessage({ type: "push", samples }, [
      samples.buffer,
    ]);
  }

  /**
   * Immediately flushes the playback ring buffer on user barge-in (`input_audio_buffer.speech_started`)
   * and returns the milliseconds of audio that actually reached the user's speakers.
   */
  async flushPlayback(): Promise<number> {
    if (!this.playbackNode) return 0;
    const id = ++this.flushReqId;
    return new Promise<number>((resolve) => {
      const timeout = setTimeout(() => {
        this.flushResolvers.delete(id);
        resolve(0);
      }, 250);
      this.flushResolvers.set(id, (ms) => {
        clearTimeout(timeout);
        resolve(ms);
      });
      this.playbackNode!.port.postMessage({ type: "flush", id });
    });
  }

  async startMicrophone(
    onBase64Frame: (base64Pcm: string) => void,
    onMicLevel?: (rms: number) => void
  ): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      throw new Error(
        "Microphone capture is unavailable. Open the app over HTTPS (or localhost)."
      );
    }
    const ctx = await this.ensureModules();

    if (this.mediaStream) {
      this.stopMicrophone();
    }
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    if (ctx.state !== "running") {
      await ctx.resume();
    }

    const resampler = createResampler(ctx.sampleRate, BOSON_AUDIO_RATE);
    this.sourceNode = ctx.createMediaStreamSource(this.mediaStream);
    this.captureNode = new AudioWorkletNode(ctx, "boson-capture-processor");

    this.captureNode.port.onmessage = (e) => {
      if (e.data?.type !== "frame") return;
      const rawFrame = e.data.frame as Float32Array;
      let sum = 0;
      for (let i = 0; i < rawFrame.length; i++) {
        sum += rawFrame[i] * rawFrame[i];
      }
      onMicLevel?.(Math.min(1, Math.sqrt(sum / rawFrame.length) * 4));

      const pcm16 = floatTo16BitPCM(resampler(rawFrame));
      onBase64Frame(int16ToBase64(pcm16));
    };

    this.sourceNode.connect(this.captureNode);
    this.captureNode.connect(ctx.destination);
  }

  stopMicrophone(): void {
    this.sourceNode?.disconnect();
    this.captureNode?.disconnect();
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.sourceNode = null;
    this.captureNode = null;
    this.mediaStream = null;
  }

  async destroy(): Promise<void> {
    this.stopMicrophone();
    this.playbackNode?.disconnect();
    this.playbackNode = null;
    this.playbackResampler = null;
    this.modulesLoaded = null;
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }
}
