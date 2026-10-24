import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

interface DiskStoreShape {
  tiles: Record<string, PersistedTileRecord>;
  pois: Record<string, StoryCard>;
  updatedAt: number;
}

const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const DISK_FILE = path.join(CACHE_DIR, "research-store.json");

// L1 In-Memory Fast Caches (<1ms)
const l1TileCache = new Map<string, PersistedTileRecord>();
const l1PoiCache = new Map<string, StoryCard>();
let diskLoaded = false;
let diskFlushTimer: ReturnType<typeof setTimeout> | null = null;

function ensureDiskLoaded(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    if (existsSync(DISK_FILE)) {
      const raw = readFileSync(DISK_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<DiskStoreShape>;
      if (parsed.tiles) {
        for (const [k, v] of Object.entries(parsed.tiles)) {
          l1TileCache.set(k, v);
        }
      }
      if (parsed.pois) {
        for (const [k, v] of Object.entries(parsed.pois)) {
          l1PoiCache.set(k, v);
        }
      }
    }
  } catch {
    // Ignore corrupt or missing local cache file
  }
}

function scheduleDiskFlush(): void {
  if (diskFlushTimer) return;
  diskFlushTimer = setTimeout(() => {
    diskFlushTimer = null;
    try {
      if (!existsSync(CACHE_DIR)) {
        mkdirSync(CACHE_DIR, { recursive: true });
      }
      const payload: DiskStoreShape = {
        tiles: Object.fromEntries(l1TileCache.entries()),
        pois: Object.fromEntries(l1PoiCache.entries()),
        updatedAt: Date.now(),
      };
      writeFileSync(DISK_FILE, JSON.stringify(payload, null, 2), "utf8");
    } catch {
      // Ignore write error in read-only environments
    }
  }, 400);
}

/**
 * Upstash Serverless Redis REST Configuration (Free tier: https://upstash.com)
 * Uses standard HTTP REST (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`),
 * requiring zero native dependencies and working across any cloud/serverless/mobile setup.
 */
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

async function upstashGet<T>(key: string): Promise<T | undefined> {
  const cfg = getUpstashConfig();
  if (!cfg) return undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    const res = await fetch(`${cfg.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { result?: string | null };
    if (!data.result) return undefined;
    return JSON.parse(data.result) as T;
  } catch {
    return undefined;
  }
}

async function upstashSet(key: string, value: unknown): Promise<void> {
  const cfg = getUpstashConfig();
  if (!cfg) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    // Persist in Upstash Redis for 30 days (2592000 seconds) so all future tour sessions reuse it
    await fetch(
      `${cfg.url}/set/${encodeURIComponent(key)}?EX=2592000`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(value),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
  } catch {
    // Non-fatal background sync error
  }
}

/**
 * Reads a Spatial Tile from:
 * 1. L1 In-Memory Map (<1ms)
 * 2. L2 Upstash Cloud Redis (~15ms)
 * 3. L3 Local Disk JSON (`.cache/research-store.json`)
 */
export async function getPersistedTile(
  cacheKey: string
): Promise<PersistedTileRecord | undefined> {
  ensureDiskLoaded();

  // 1. L1 Memory hit (<1ms)
  const memHit = l1TileCache.get(cacheKey);
  if (memHit) return memHit;

  // 2. L2 Cloud Upstash Redis hit
  const cloudHit = await upstashGet<PersistedTileRecord>(
    `handheld:tile:${cacheKey}`
  );
  if (cloudHit) {
    l1TileCache.set(cacheKey, cloudHit);
    for (const sec of Object.values(cloudHit.sectors)) {
      for (const story of sec.stories) {
        l1PoiCache.set(story.osmId, story);
      }
    }
    scheduleDiskFlush();
    return cloudHit;
  }

  return undefined;
}

/**
 * Saves a researched Spatial Tile to L1 Memory, L3 Disk, and L2 Cloud Redis asynchronously.
 */
export async function savePersistedTile(
  cacheKey: string,
  record: PersistedTileRecord
): Promise<void> {
  ensureDiskLoaded();
  l1TileCache.set(cacheKey, record);
  scheduleDiskFlush();
  void upstashSet(`handheld:tile:${cacheKey}`, record);
}

/**
 * Reads a single Landmark `StoryCard` by `osmId + profileKey` across L1 Memory, L3 Disk, and L2 Cloud Redis.
 */
export async function getPersistedPoiStory(
  poiCacheKey: string
): Promise<StoryCard | undefined> {
  ensureDiskLoaded();
  const memHit = l1PoiCache.get(poiCacheKey);
  if (memHit) return memHit;

  const cloudHit = await upstashGet<StoryCard>(
    `handheld:poi:${poiCacheKey}`
  );
  if (cloudHit) {
    l1PoiCache.set(poiCacheKey, cloudHit);
    scheduleDiskFlush();
    return cloudHit;
  }
  return undefined;
}

export function getPersistedPoiStorySync(
  poiCacheKey: string
): StoryCard | undefined {
  ensureDiskLoaded();
  return l1PoiCache.get(poiCacheKey);
}

/**
 * Saves a synthesized Landmark `StoryCard` to L1 Memory, L3 Disk, and L2 Cloud Redis.
 */
export function savePersistedPoiStory(
  poiCacheKey: string,
  story: StoryCard
): void {
  ensureDiskLoaded();
  l1PoiCache.set(poiCacheKey, story);
  scheduleDiskFlush();
  void upstashSet(`handheld:poi:${poiCacheKey}`, story);
}

export function getCacheStats() {
  ensureDiskLoaded();
  return {
    l1TilesCached: l1TileCache.size,
    l1PoisCached: l1PoiCache.size,
    cloudProvider: getUpstashConfig()
      ? "upstash_redis_cloud"
      : "local_disk_and_memory",
    diskFile: DISK_FILE,
  };
}
