import { readFileSync } from "node:fs";

const DEFAULT_BOSON_BASE_URL = "https://api.boson.ai";

export function loadBosonApiKey(): string | undefined {
  const inline = process.env.BOSON_API_KEY?.trim();
  if (inline && inline !== "bai-your-key-here") return inline;

  const keyFile = process.env.BOSON_API_KEY_FILE?.trim();
  if (keyFile) {
    try {
      return readFileSync(keyFile, "utf8").trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface EphemeralTokenResponse {
  value: string;
  expires_at: number;
}

/**
 * Mints a fresh ephemeral Boson Realtime client secret (`bai-eph-*`).
 * Never caches keys across requests per Boson security guidelines.
 */
export async function mintBosonEphemeralToken(
  expiresAfterSeconds = 600
): Promise<{ status: number; data: EphemeralTokenResponse | { error: string } }> {
  const apiKey = loadBosonApiKey();
  if (!apiKey) {
    return {
      status: 500,
      data: {
        error:
          "No BOSON_API_KEY found. Add BOSON_API_KEY or BOSON_API_KEY_FILE to your .env file.",
      },
    };
  }

  const baseUrl = (process.env.BOSON_BASE_URL || DEFAULT_BOSON_BASE_URL).replace(
    /\/+$/,
    ""
  );

  try {
    const upstream = await fetch(`${baseUrl}/v1/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: { seconds: Math.min(7200, Math.max(10, expiresAfterSeconds)) },
      }),
    });

    const payload = (await upstream.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!upstream.ok) {
      const errObj = payload.error as Record<string, unknown> | undefined;
      const errMsg =
        typeof errObj?.message === "string"
          ? errObj.message
          : `Upstream Boson API error (${upstream.status})`;
      return { status: upstream.status, data: { error: errMsg } };
    }

    if (typeof payload.value !== "string" || typeof payload.expires_at !== "number") {
      return {
        status: 502,
        data: { error: "Unexpected response shape from Boson client_secrets endpoint" },
      };
    }

    return {
      status: 200,
      data: {
        value: payload.value,
        expires_at: payload.expires_at,
      },
    };
  } catch (err) {
    return {
      status: 502,
      data: {
        error: err instanceof Error ? err.message : "Failed to reach Boson API",
      },
    };
  }
}
