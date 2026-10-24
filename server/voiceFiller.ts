import { loadBosonApiKey } from "./bosonToken.js";

const LINES = {
  lookup: "One sec, I'm checking.",
  route: "Give me a moment while I sketch out a route for you.",
} as const;
export type FillerKind = keyof typeof LINES;
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
  const name = (voice || "oliver").toLowerCase();
  return VOICES.has(name) ? name : "oliver";
}

export async function getToolFiller(
  voice: string | undefined,
  kind: FillerKind = "lookup"
): Promise<{ text: string; audioBase64: string } | null> {
  const LINE = LINES[kind];
  const key = `${normalizeFillerVoice(voice)}:${kind}`;
  const cached = cache.get(key);
  if (cached) return { text: LINE, audioBase64: cached };

  let job = pending.get(key);
  if (!job) {
    job = synthesize(normalizeFillerVoice(voice), LINE, key).finally(() => pending.delete(key));
    pending.set(key, job);
  }
  const audioBase64 = await job;
  if (!audioBase64) return null;
  return { text: LINE, audioBase64 };
}

async function synthesize(
  voice: string,
  line: string,
  cacheKey: string
): Promise<string | null> {
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
      input: line,
      voice,
      response_format: "pcm",
      stream: true,
    }),
  });
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) return null;
  const audioBase64 = bytes.toString("base64");
  cache.set(cacheKey, audioBase64);
  return audioBase64;
}
