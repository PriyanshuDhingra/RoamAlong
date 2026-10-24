/**
 * Stateful 2nd-order Butterworth low-pass filter + linear interpolation resampler.
 * Prevents aliasing when downsampling 48kHz browser microphone capture to Boson's 24kHz PCM16 rate,
 * and carries state across 100ms audio blocks to avoid boundary clicks.
 */
export function createLowpass(cutoffHz: number, sampleRate: number) {
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  const sn = Math.sin(omega);
  const cs = Math.cos(omega);
  const alpha = sn / Math.sqrt(2);

  const b0 = (1 - cs) / 2;
  const b1 = 1 - cs;
  const b2 = (1 - cs) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cs;
  const a2 = 1 - alpha;

  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;

  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  return function filter(input: Float32Array): Float32Array {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
    return out;
  };
}

export function createResampler(inputRate: number, outputRate: number) {
  if (inputRate === outputRate) {
    return (block: Float32Array) => block;
  }

  const ratio = inputRate / outputRate;
  const lowpass =
    ratio > 1 ? createLowpass(outputRate * 0.45, inputRate) : null;

  let prev = 0;
  let havePrev = false;
  let pos = 0;

  return function resample(rawBlock: Float32Array): Float32Array {
    if (rawBlock.length === 0) return new Float32Array(0);
    const block = lowpass ? lowpass(rawBlock) : rawBlock;

    const out: number[] = [];
    if (!havePrev) {
      prev = block[0];
      havePrev = true;
      pos = 0;
    }

    while (pos < block.length) {
      if (pos < 0) {
        const frac = pos + 1;
        out.push(prev + frac * (block[0] - prev));
      } else {
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const s0 = block[idx];
        const s1 = idx + 1 < block.length ? block[idx + 1] : s0;
        out.push(s0 + frac * (s1 - s0));
      }
      pos += ratio;
    }

    pos -= block.length;
    prev = block[block.length - 1];
    return Float32Array.from(out);
  };
}

export function floatTo16BitPCM(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

export function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}
