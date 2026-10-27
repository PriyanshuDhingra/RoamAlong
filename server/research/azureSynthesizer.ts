import type {
  PlaceNote,
  QuadrantSector,
  RawOsmPoi,
  StoryCard,
  TourTopic,
  UserCalibrationProfile,
} from "../../shared/types.js";
import type { WikiSummary } from "./wikipediaClient.js";

export interface SectorSynthesisInput {
  sector: QuadrantSector;
  neighborhood: string;
  city: string;
  countryCode: string;
  pois: (RawOsmPoi & { wiki?: WikiSummary })[];
  profile: UserCalibrationProfile;
  /** Search the web before writing. Used for the block the walker is heading toward. */
  useWebSearch?: boolean;
}

export function getAzureConfig() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = process.env.AZURE_OPENAI_API_KEY?.trim();
  const deployment =
    process.env.AZURE_OPENAI_DEPLOYMENT?.trim() || "gpt-5-mini";

  if (
    !endpoint ||
    !apiKey ||
    endpoint.includes("your-resource-name") ||
    apiKey === "your-azure-openai-api-key"
  ) {
    throw new Error(
      "Missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY in environment (.env)."
    );
  }

  const normalized = endpoint.replace(/\/+$/, "");
  if (!normalized.endsWith("/responses")) {
    throw new Error(
      "AZURE_OPENAI_ENDPOINT must be an Azure Responses API URL ending in /responses so the research agents can search the web."
    );
  }

  return {
    endpoint: normalized,
    apiKey,
    deployment,
  };
}

/**
 * Calls the Azure Responses API with web search and returns the raw JSON string.
 */
export async function callAzureJsonModel(params: {
  azure: ReturnType<typeof getAzureConfig>;
  systemPrompt: string;
  userPayload: unknown;
  timeoutMs?: number;
}): Promise<string> {
  const { azure, systemPrompt, userPayload, timeoutMs = 24000 } = params;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(azure.endpoint, {
      method: "POST",
      headers: {
        "api-key": azure.apiKey,
        Authorization: `Bearer ${azure.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: azure.deployment,
        instructions: systemPrompt,
        input: `Respond in valid JSON format: ${JSON.stringify(userPayload)}`,
        reasoning: { effort: "low" },
        tools: [{ type: "web_search" }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `Azure Responses API HTTP ${response.status}: ${errBody.slice(0, 400)}`
      );
    }

    const data = (await response.json()) as {
      output_text?: string;
      output?: {
        type?: string;
        content?: { type?: string; text?: string }[];
      }[];
    };

    let rawText: string | undefined =
      typeof data.output_text === "string" && data.output_text
        ? data.output_text
        : undefined;

    if (!rawText) {
      for (const item of data.output ?? []) {
        if (item.type === "message") {
          for (const part of item.content ?? []) {
            if (part.type === "output_text" && part.text) {
              rawText = part.text;
              break;
            }
          }
        }
      }
    }

    if (!rawText) {
      throw new Error("Azure Responses API returned empty output_text.");
    }

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    return jsonMatch ? jsonMatch[0] : rawText;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Synthesizes structured StoryCards for a single directional sector (CENTER, NORTH, SOUTH, EAST, or WEST)
 * strictly using Azure OpenAI (no silent heuristic fallback). Throws transparently if Azure fails.
 */
export async function synthesizeSectorStories(
  input: SectorSynthesisInput
): Promise<{
  stories: StoryCard[];
  synthesizedBy: "azure_openai";
}> {
  if (input.pois.length === 0) {
    return { stories: [], synthesizedBy: "azure_openai" };
  }

  const azure = getAzureConfig();
  const stories = await callAzureOpenAiSectorAgent(azure, input);
  return { stories, synthesizedBy: "azure_openai" };
}

function normalizeNotes(raw: unknown): PlaceNote[] {
  if (!Array.isArray(raw)) return [];
  const notes: PlaceNote[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const claim = String((item as { claim?: unknown }).claim ?? "").trim();
    const source = String((item as { source?: unknown }).source ?? "").trim();
    if (claim.length < 8) continue;
    notes.push(source ? { claim, source } : { claim });
    if (notes.length >= 8) break;
  }
  return notes;
}

async function callAzureOpenAiSectorAgent(
  azure: ReturnType<typeof getAzureConfig>,
  input: SectorSynthesisInput
): Promise<StoryCard[]> {
  const topPois = input.pois.slice(0, 8).map((p) => ({
    osmId: p.osmId,
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    category: p.category,
    tags: p.tags,
    wikiExtract: p.wiki?.extract,
  }));

  const systemPrompt = [
    `You are the ${input.sector} Quadrant Spatial Research Agent for a live handheld walking tour in ${input.neighborhood}, ${input.city}.`,
    `Follow Freeman Tilden's Principles of Heritage Interpretation:`,
    `1. Sensory Hook: Start with a physical detail the walker can see, hear, or smell right from the sidewalk.`,
    `2. Revelation over Dry Facts: Craft a vivid 2-to-3 sentence spoken story tailored to the user's preferred style (${input.profile.story_style}) and topics (${input.profile.topics.join(", ")}).`,
    `3. Provocation: Include a short 1-sentence follow-up question that invites 2-way conversation.`,
    `4. Multilingual Touch: Include a relevant local phrase, architectural term, or culinary expression in its original language or one of the user's languages (${input.profile.languages.join(", ")}).`,
    "Use web_search on each place before you write. Ground the story in a real fact from that search: what it is known for, why people go, or what reviewers say. Do not invent ratings, hours, or history. Also keep up to 8 notes: { claim, source }. claim is one factual sentence. source is the page or publication name. Only include claims the search actually supported.",
    `Return ONLY a JSON object matching: { "stories": [ { "osmId", "name", "categories", "sensoryHook", "narrativeSummary", "hiddenTrivia", "followUpQuestion", "localLanguagePhrase": { "phrase", "language", "meaning" }, "notes": [ { "claim", "source" } ], "score" } ] }`,
  ].join(" ");

  const rawContent = await callAzureJsonModel({
    azure,
    systemPrompt,
    userPayload: {
      sector: input.sector,
      neighborhood: input.neighborhood,
      city: input.city,
      userTopics: input.profile.topics,
      pois: topPois,
    },
    timeoutMs: 24000,
  });

  const parsed = JSON.parse(rawContent) as {
    stories?: Partial<StoryCard>[];
  };

  if (!Array.isArray(parsed.stories)) {
    throw new Error(
      `Azure Research Agent for ${input.sector} returned JSON without a 'stories' array.`
    );
  }

  const byId = new Map(input.pois.map((p) => [p.osmId, p]));

  return parsed.stories.map((item, idx) => {
    const source =
      (item.osmId ? byId.get(item.osmId) : undefined) ??
      input.pois[idx] ??
      input.pois[0];
    return {
      id: `${input.sector}_${source.osmId}`,
      osmId: source.osmId,
      name: item.name || source.name,
      lat: source.lat,
      lon: source.lon,
      sector: input.sector,
      categories:
        Array.isArray(item.categories) && item.categories.length > 0
          ? (item.categories as TourTopic[])
          : [source.category],
      sensoryHook: item.sensoryHook || "",
      narrativeSummary: item.narrativeSummary || "",
      hiddenTrivia: item.hiddenTrivia || "",
      followUpQuestion: item.followUpQuestion || "",
      notes: normalizeNotes(item.notes),
      localLanguagePhrase: item.localLanguagePhrase,
      geometry: source.geometry,
      address: source.tags["addr:street"]
        ? `${source.tags["addr:housenumber"] ?? ""} ${
            source.tags["addr:street"]
          }`.trim()
        : undefined,
      wikipediaUrl: source.wiki?.url,
      webResearched: true,
      score: typeof item.score === "number" ? item.score : 85 - idx * 5,
    };
  });
}
