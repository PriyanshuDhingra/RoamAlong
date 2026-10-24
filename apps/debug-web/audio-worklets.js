// AudioWorklet processors for the debug client. The AudioContext runs at 24 kHz (Boson's output rate), so playback
// needs no resampling and the mic is downsampled 24 kHz -> 16 kHz here.

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // 1.5 at 24 kHz
    this.pos = 0; // fractional read position into the carried-over input
    this.carry = new Float32Array(0);
    this.frame = new Int16Array(320); // 20 ms at 16 kHz
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const buf = new Float32Array(this.carry.length + ch.length);
    buf.set(this.carry);
    buf.set(ch, this.carry.length);
    let p = this.pos;
    while (p + 1 < buf.length) {
      const i = Math.floor(p);
      const s = buf[i] + (buf[i + 1] - buf[i]) * (p - i);
      this.frame[this.n++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (this.n === this.frame.length) {
        this.port.postMessage(this.frame.buffer.slice(0));
        this.n = 0;
      }
      p += this.ratio;
    }
    const keep = Math.floor(p);
    this.carry = buf.slice(keep);
    this.pos = p - keep;
    return true;
  }
}

class Player extends AudioWorkletProcessor {
  // Queue of {key, samples(Float32Array), offset}. Reports played ms per item key every ~250 ms and on flush.
  constructor() {
    super();
    this.queue = [];
    this.played = new Map(); // key -> samples played
    this.sinceReport = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "chunk") {
        const pcm = new Int16Array(m.pcm);
        const f = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
        this.queue.push({ key: m.key, samples: f, offset: 0 });
      } else if (m.type === "flush") {
        this.queue = [];
        this.report(true);
      } else if (m.type === "drop") {
        this.queue = this.queue.filter((q) => q.key !== m.key);
      }
    };
  }

  report(stopped) {
    for (const [key, n] of this.played) {
      this.port.postMessage({ type: "played", key, ms: Math.round((n / sampleRate) * 1000), stopped });
    }
    if (stopped) this.played.clear();
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length && this.queue.length) {
      const q = this.queue[0];
      const n = Math.min(out.length - i, q.samples.length - q.offset);
      out.set(q.samples.subarray(q.offset, q.offset + n), i);
      q.offset += n;
      i += n;
      this.played.set(q.key, (this.played.get(q.key) || 0) + n);
      if (q.offset >= q.samples.length) this.queue.shift();
    }
    out.fill(0, i);
    this.sinceReport += out.length;
    if (this.sinceReport >= sampleRate / 4) {
      this.sinceReport = 0;
      if (this.played.size) this.report(false);
      this.port.postMessage({ type: "level", queued: this.queue.length });
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCapture);
registerProcessor("player", Player);
