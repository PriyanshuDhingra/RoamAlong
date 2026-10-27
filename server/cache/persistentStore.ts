import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  DirectionalSectorCache,
  QuadrantSector,
  StoryCard,
} from "../../shared/types.js";

export interface PersistedTileRecord {
  tileKey: string;
  neighborhood: string;
  currentStreet: string;
  city: string;
  countryCode: string;
  sectors: Record<QuadrantSector, DirectionalSectorCache>;
  createdAt: number;
}

interface LegacyDiskStore {
  tiles?: Record<string, PersistedTileRecord>;
  pois?: Record<string, StoryCard>;
}

const l1TileCache = new Map<string, PersistedTileRecord>();
const l1PoiCache = new Map<string, StoryCard>();
const LEGACY_DISK_FILE = path.resolve(process.cwd(), ".cache/research-store.json");
let legacyImport: Promise<void> | null = null;
const writtenSinceImport = new Set<string>();

function getUpstashConfig(): { url: string; token: string } | undefined {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (
    !url ||
    !token ||
    url.includes("your-upstash") ||
    token.includes("your-upstash")
  ) {
    return undefined;
  }
  return { url: url.replace(/\/+$/, ""), token };
}

async function upstashCommand<T>(command: unknown[]): Promise<T | undefined> {
  const cfg = getUpstashConfig();
  if (!cfg) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { result?: T };
    return data.result;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function upstashGet<T>(key: string): Promise<T | undefined> {
  const raw = await upstashCommand<string | null>(["GET", key]);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function upstashSet(key: string, value: unknown): Promise<void> {
  await upstashCommand(["SET", key, JSON.stringify(value)]);
}

async function upstashPipeline(commands: unknown[][]): Promise<void> {
  const cfg = getUpstashConfig();
  if (!cfg || commands.length === 0) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    await fetch(`${cfg.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      signal: controller.signal,
    });
  } catch {
    // The in-memory copy still serves this process. The next save retries Upstash.
  } finally {
    clearTimeout(timer);
  }
}

function ensureStoreReady(): Promise<void> {
  if (legacyImport) return legacyImport;
  legacyImport = (async () => {
    if (!existsSync(LEGACY_DISK_FILE)) return;
    try {
      const parsed = JSON.parse(readFileSync(LEGACY_DISK_FILE, "utf8")) as LegacyDiskStore;
      const commands: unknown[][] = [];
      for (const [key, record] of Object.entries(parsed.tiles ?? {})) {
        if (!l1TileCache.has(key)) l1TileCache.set(key, record);
        commands.push(["SET", `handheld:tile:${key}`, JSON.stringify(record)]);
      }
      for (const [key, story] of Object.entries(parsed.pois ?? {})) {
        if (!l1PoiCache.has(key)) l1PoiCache.set(key, story);
        commands.push(["SET", `handheld:poi:${key}`, JSON.stringify(story)]);
      }
      if (!getUpstashConfig()) return;
      void (async () => {
        for (let i = 0; i < commands.length; i += 80) {
          const batch = commands
            .slice(i, i + 80)
            .filter((command) => !writtenSinceImport.has(String(command[1])));
          await upstashPipeline(batch);
        }
      })();
    } catch {
      // A bad local file should not block the tour. New research still goes to Upstash.
    }
  })();
  return legacyImport;
}

export async function getPersistedTile(
  cacheKey: string
): Promise<PersistedTileRecord | undefined> {
  await ensureStoreReady();
  const memHit = l1TileCache.get(cacheKey);
  if (memHit) return memHit;
  const cloudHit = await upstashGet<PersistedTileRecord>(`handheld:tile:${cacheKey}`);
  if (!cloudHit) return undefined;
  l1TileCache.set(cacheKey, cloudHit);
  for (const sector of Object.values(cloudHit.sectors)) {
    for (const story of sector.stories) {
      l1PoiCache.set(story.osmId, story);
    }
  }
  return cloudHit;
}

export async function savePersistedTile(
  cacheKey: string,
  record: PersistedTileRecord
): Promise<void> {
  l1TileCache.set(cacheKey, record);
  writtenSinceImport.add(`handheld:tile:${cacheKey}`);
  await upstashSet(`handheld:tile:${cacheKey}`, record);
}

export async function getPersistedPoiStory(
  poiCacheKey: string
): Promise<StoryCard | undefined> {
  await ensureStoreReady();
  const memHit = l1PoiCache.get(poiCacheKey);
  if (memHit) return memHit;
  const cloudHit = await upstashGet<StoryCard>(`handheld:poi:${poiCacheKey}`);
  if (!cloudHit) return undefined;
  l1PoiCache.set(poiCacheKey, cloudHit);
  return cloudHit;
}

export async function savePersistedPoiStory(
  poiCacheKey: string,
  story: StoryCard
): Promise<void> {
  l1PoiCache.set(poiCacheKey, story);
  writtenSinceImport.add(`handheld:poi:${poiCacheKey}`);
  await upstashSet(`handheld:poi:${poiCacheKey}`, story);
}

export function getCacheStats() {
  return {
    l1TilesCached: l1TileCache.size,
    l1PoisCached: l1PoiCache.size,
    store: getUpstashConfig() ? "upstash" : "memory_only",
  };
}
