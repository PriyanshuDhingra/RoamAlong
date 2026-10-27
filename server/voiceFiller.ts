import { loadBosonApiKey } from "./bosonToken.js";

const FALLBACK = "One sec, I'm checking.";
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

export function fillerSentence(
  kind: string | undefined,
  subject: string | undefined,
  step: number
): string {
  const name = cleanSubject(subject);
  const about = contextualLine(kind, name);
  const rotation = [about, "Still on it.", "Almost there."];
  return rotation[Math.max(0, step) % rotation.length] || FALLBACK;
}

function contextualLine(kind: string | undefined, name: string): string {
  switch (kind) {
    case "route":
      return "Still putting the walk together.";
    case "way":
      return name ? `Still working out the way to ${name}.` : "Still working out the way there.";
    case "around":
      return "Still checking what's around you.";
    case "place":
      return name ? `Still reading up on ${name}.` : "Still looking that up.";
    case "web":
      return name ? `Still searching for ${name}.` : "Still searching.";
    default:
      return name ? `One sec, I'm checking on ${name}.` : FALLBACK;
  }
}

function cleanSubject(raw: string | undefined): string {
  const text = (raw || "")
    .replace(/[^\p{L}\p{N}\s'’-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 2 || text.length > 42) return "";
  return text;
}

export async function getToolFiller(
  voice: string | undefined,
  kind?: string,
  subject?: string,
  step = 0
): Promise<{ text: string; audioBase64: string } | null> {
  const voiceKey = normalizeFillerVoice(voice);
  const line = fillerSentence(kind, subject, step);
  const cacheKey = `${voiceKey}:${line}`;
  const cached = cache.get(cacheKey);
  if (cached) return { text: line, audioBase64: cached };

  let job = pending.get(cacheKey);
  if (!job) {
    job = synthesize(voiceKey, line).finally(() => pending.delete(cacheKey));
    pending.set(cacheKey, job);
  }
  const audioBase64 = await job;
  if (!audioBase64) return null;
  return { text: line, audioBase64 };
}

async function synthesize(voice: string, line: string): Promise<string | null> {
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
  cache.set(`${voice}:${line}`, audioBase64);
  return audioBase64;
}
