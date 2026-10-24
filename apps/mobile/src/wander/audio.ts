// Duplex audio for the guide (IMPLEMENTATION_PLAN.md §13.3): mic -> 16 kHz PCM16 20 ms frames; downlink 24 kHz PCM16
// chunks -> gapless buffer queue, flushed immediately on barge-in, with played-ms reported per item.
import {
  AudioBufferQueueSourceNode,
  AudioContext,
  AudioManager,
  AudioRecorder,
} from 'react-native-audio-api';

const OUT_RATE = 24000;
const IN_RATE = 16000;
const FRAME = 320; // 20 ms at 16 kHz

type Played = (key: string, ms: number, stopped: boolean) => void;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private queue: AudioBufferQueueSourceNode | null = null;
  private playing = false;
  private bufferKey = new Map<string, { key: string; samples: number }>();
  private played = new Map<string, number>(); // key -> samples
  private recorder: AudioRecorder | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private dropped = new Set<string>();

  constructor(private onFrame: (pcm: ArrayBuffer) => void, private onPlayed: Played) {}

  async start(): Promise<boolean> {
    // voiceChat mode turns on the system echo canceller, so the guide doesn't hear itself (§4.6)
    AudioManager.setAudioSessionOptions({
      iosCategory: 'playAndRecord',
      iosMode: 'voiceChat',
      iosOptions: ['allowBluetoothHFP', 'defaultToSpeaker'],
    });
    const perm = await AudioManager.requestRecordingPermissions();
    await AudioManager.setAudioSessionActivity(true);
    this.ctx = new AudioContext({ sampleRate: OUT_RATE });
    this.reportTimer = setInterval(() => this.report(false), 250);
    return perm === 'Granted';
  }

  async startMic(): Promise<void> {
    if (this.recorder) return;
    const rec = new AudioRecorder();
    rec.onAudioReady({ sampleRate: IN_RATE, bufferLength: FRAME, channelCount: 1 }, (e) => {
      const f = e.buffer.getChannelData(0);
      // The recorder may deliver a different rate than requested; resample if so.
      const src = e.buffer.sampleRate === IN_RATE ? f : resample(f, e.buffer.sampleRate, IN_RATE);
      const out = new Int16Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(src[i] * 32767)));
      this.onFrame(out.buffer);
    });
    await rec.start();
    this.recorder = rec;
  }

  async stopMic(): Promise<void> {
    if (!this.recorder) return;
    this.recorder.clearOnAudioReady();
    await this.recorder.stop();
    this.recorder = null;
  }

  /** Downlink binary frame: 8-byte item hash + uint32 seq + PCM16 mono 24 kHz. */
  play(frame: ArrayBuffer): void {
    if (!this.ctx) return;
    const key = hex(new Uint8Array(frame, 0, 8));
    if (this.dropped.has(key)) return; // stale audio from an interrupted item (§5.7)
    const pcm = new Int16Array(frame.slice(12));
    if (!pcm.length) return;
    const buf = this.ctx.createBuffer(1, pcm.length, OUT_RATE);
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    buf.copyToChannel(f, 0);
    if (!this.queue || !this.playing) this.newQueue();
    const id = this.queue!.enqueueBuffer(buf);
    this.bufferKey.set(id, { key, samples: pcm.length });
  }

  private newQueue(): void {
    const ctx = this.ctx!;
    const q = ctx.createBufferQueueSource();
    q.connect(ctx.destination);
    q.onBufferEnded = (e) => {
      const info = this.bufferKey.get(e.bufferId);
      if (info) {
        this.played.set(info.key, (this.played.get(info.key) ?? 0) + info.samples);
        this.bufferKey.delete(e.bufferId);
      }
      if (e.isLastBufferInQueue && q === this.queue) this.playing = false;
    };
    q.start(ctx.currentTime);
    this.queue = q;
    this.playing = true;
  }

  /** Barge-in / cancel: silence now, remember which items to ignore, and report what was heard. */
  flush(): void {
    if (this.queue) {
      for (const { key } of this.bufferKey.values()) this.dropped.add(key);
      this.queue.clearBuffers();
      this.queue.stop();
      this.queue = null;
    }
    this.bufferKey.clear();
    this.playing = false;
    this.report(true);
  }

  private report(stopped: boolean): void {
    for (const [key, n] of this.played) this.onPlayed(key, Math.round((n / OUT_RATE) * 1000), stopped);
    if (stopped) this.played.clear();
  }

  async stop(): Promise<void> {
    await this.stopMic();
    this.flush();
    if (this.reportTimer) clearInterval(this.reportTimer);
    await this.ctx?.close();
    this.ctx = null;
    await AudioManager.setAudioSessionActivity(false);
  }
}

function hex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function resample(src: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(src.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio;
    const j = Math.floor(p);
    const a = src[j];
    const b = src[Math.min(j + 1, src.length - 1)];
    out[i] = a + (b - a) * (p - j);
  }
  return out;
}
