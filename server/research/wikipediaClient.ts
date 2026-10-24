import type { GeoPoint } from "../../shared/types.js";

export interface WikiSummary {
  title: string;
  extract: string;
  url: string;
  lat?: number;
  lon?: number;
}

const wikiSummaryCache = new Map<string, WikiSummary>();

/**
 * Fetches a concise Wikipedia summary from an OSM `wikipedia` tag (e.g. `en:E.V. Haughwout Building`)
 * or title string.
 */
export async function fetchWikipediaSummaryByTag(
  wikipediaTagOrTitle: string
): Promise<WikiSummary | undefined> {
  const key = wikipediaTagOrTitle.trim();
  if (!key) return undefined;
  if (wikiSummaryCache.has(key)) return wikiSummaryCache.get(key);

  let lang = "en";
  let title = key;
  if (key.includes(":")) {
    const [prefix, ...rest] = key.split(":");
    if (prefix.length >= 2 && prefix.length <= 5) {
      lang = prefix;
      title = rest.join(":");
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      title.replace(/ /g, "_")
    )}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "RoamAlong/1.0 (Hackathon Audio Guide)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
      coordinates?: { lat?: number; lon?: number };
    };

    if (!data.extract) return undefined;
    const summary: WikiSummary = {
      title: data.title || title,
      extract: data.extract.slice(0, 650),
      url:
        data.content_urls?.desktop?.page ||
        `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      lat: data.coordinates?.lat,
      lon: data.coordinates?.lon,
    };
    wikiSummaryCache.set(key, summary);
    return summary;
  } catch {
    return undefined;
  }
}

/**
 * Queries Wikipedia GeoSearch API for notable articles within `radiusMeters` of `point`.
 */
export async function fetchWikipediaGeoSearch(
  point: GeoPoint,
  radiusMeters = 350,
  limit = 6
): Promise<WikiSummary[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${point.lat}|${point.lon}&gsradius=${radiusMeters}&gslimit=${limit}&format=json`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "RoamAlong/1.0 (Hackathon Audio Guide)",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return [];
    const data = (await res.json()) as {
      query?: {
        geosearch?: { title: string; lat: number; lon: number }[];
      };
    };

    const hits = data.query?.geosearch ?? [];
    const summaries: (WikiSummary | undefined)[] = await Promise.all(
      hits.slice(0, 4).map(async (hit): Promise<WikiSummary | undefined> => {
        const s = await fetchWikipediaSummaryByTag(`en:${hit.title}`);
        if (s) {
          return { ...s, lat: hit.lat, lon: hit.lon };
        }
        return undefined;
      })
    );
    return summaries.filter((s): s is WikiSummary => s !== undefined);
  } catch {
    return [];
  }
}
