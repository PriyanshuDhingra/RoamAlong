import type {
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
}

export function getAzureConfig() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = process.env.AZURE_OPENAI_API_KEY?.trim();
  const deployment =
    process.env.AZURE_OPENAI_DEPLOYMENT?.trim() || "gpt-5-mini";
  const apiVersion =
    process.env.AZURE_OPENAI_API_VERSION?.trim() || "2025-08-07";

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

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKey,
    deployment,
    apiVersion,
  };
}

/**
 * Calls either Azure AI Foundry `/openai/v1/responses` or classic Azure OpenAI `/openai/deployments/.../chat/completions`,
 * returning the raw JSON string or throwing a transparent error with the upstream status & body.
 */
export async function callAzureJsonModel(params: {
  azure: ReturnType<typeof getAzureConfig>;
  systemPrompt: string;
  userPayload: unknown;
  useWebSearch?: boolean;
  timeoutMs?: number;
}): Promise<string> {
  const {
    azure,
    systemPrompt,
    userPayload,
    useWebSearch = false,
    timeoutMs = 18000,
  } = params;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const isResponsesApi = azure.endpoint.endsWith("/responses");

    if (isResponsesApi) {
      const bodyPayload: Record<string, unknown> = {
        model: azure.deployment,
        instructions: systemPrompt,
        input: `Respond in valid JSON format: ${JSON.stringify(userPayload)}`,
        reasoning: { effort: useWebSearch ? "low" : "minimal" },
      };

      if (useWebSearch) {
        bodyPayload.tools = [{ type: "web_search" }];
      } else {
        bodyPayload.text = { format: { type: "json_object" } };
      }

      const response = await fetch(azure.endpoint, {
        method: "POST",
        headers: {
          "api-key": azure.apiKey,
          Authorization: `Bearer ${azure.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });

      clearTimeout(timer);
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
    }

    const url = `${azure.endpoint}/openai/deployments/${encodeURIComponent(
      azure.deployment
    )}/chat/completions?api-version=${encodeURIComponent(azure.apiVersion)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": azure.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `Azure OpenAI Chat Completions HTTP ${response.status}: ${errBody.slice(
          0,
          400
        )}`
      );
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Azure OpenAI Chat Completions returned empty content.");
    }
    return content;
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

const MAX_POIS_PER_SECTOR = 5;
const SECTOR_TIMEOUT_MS = 30000;

async function callAzureOpenAiSectorAgent(
  azure: ReturnType<typeof getAzureConfig>,
  input: SectorSynthesisInput
): Promise<StoryCard[]> {
  // 5 POIs per sector keeps one synthesis around 10 s (8 POIs measured ~12 s before Wikipedia extracts were
  // added, which pushed real requests past the old 14 s timeout).
  const topPois = input.pois.slice(0, MAX_POIS_PER_SECTOR).map((p) => ({
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
    `Return valid JSON matching: { "stories": [ { "osmId", "name", "categories", "sensoryHook", "narrativeSummary", "hiddenTrivia", "followUpQuestion", "localLanguagePhrase": { "phrase", "language", "meaning" }, "score" } ] }`,
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
    useWebSearch: false,
    timeoutMs: SECTOR_TIMEOUT_MS,
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
      localLanguagePhrase: item.localLanguagePhrase,
      geometry: source.geometry,
      address: source.tags["addr:street"]
        ? `${source.tags["addr:housenumber"] ?? ""} ${
            source.tags["addr:street"]
          }`.trim()
        : undefined,
      wikipediaUrl: source.wiki?.url,
      score: typeof item.score === "number" ? item.score : 85 - idx * 5,
    };
  });
}
