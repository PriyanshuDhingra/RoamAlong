import { loadBosonApiKey } from "./bosonToken.js";

const LINE = "One sec, I'm checking.";
const VOICES = new Set([
  "mia",
  "chloe",
  "marcus",
  "jake",
  "nora",
  "eleanor",
  "oliver",
  "berlinda",
  "default",
]);

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

export function normalizeFillerVoice(voice: string | undefined): string {
  const name = (voice || "mia").toLowerCase();
  return VOICES.has(name) ? name : "mia";
}

export async function getToolFiller(
  voice: string | undefined
): Promise<{ text: string; audioBase64: string } | null> {
  const key = normalizeFillerVoice(voice);
  const cached = cache.get(key);
  if (cached) return { text: LINE, audioBase64: cached };

  let job = pending.get(key);
  if (!job) {
    job = synthesize(key).finally(() => pending.delete(key));
    pending.set(key, job);
  }
  const audioBase64 = await job;
  if (!audioBase64) return null;
  return { text: LINE, audioBase64 };
}

async function synthesize(voice: string): Promise<string | null> {
  const apiKey = loadBosonApiKey();
  if (!apiKey) return null;
  const base = (process.env.BOSON_BASE_URL || "https://api.boson.ai").replace(
    /\/+$/,
    ""
  );
  const res = await fetch(`${base}/v1/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "higgs-tts-3",
      input: LINE,
      voice,
      response_format: "pcm",
      stream: true,
    }),
  });
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) return null;
  const audioBase64 = bytes.toString("base64");
  cache.set(voice, audioBase64);
  return audioBase64;
}
