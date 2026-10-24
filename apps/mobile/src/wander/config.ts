// Gateway address. Set EXPO_PUBLIC_GATEWAY_URL in apps/mobile/.env.local (e.g. wss://<tunnel>.trycloudflare.com);
// it can also be changed at runtime from the in-app debug panel when the tunnel URL changes.
export const DEFAULT_GATEWAY_URL = process.env.EXPO_PUBLIC_GATEWAY_URL ?? 'ws://localhost:8000';

export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

export const QUEENS_PARK = { lat: 43.664, lon: -79.3925 };
export const START = { lat: 43.66205, lon: -79.3956 }; // King's College Circle

// Same loop as the web debug client: UC -> Hart House -> Legislature -> park -> Victoria -> ROM -> Philosopher's Walk
export const DEMO_TRACK: [number, number][] = [
  [43.6617, -79.39535], [43.6623, -79.3955], [43.663, -79.395], [43.6636, -79.394], [43.663, -79.3932],
  [43.6627, -79.393], [43.6618, -79.392], [43.6633, -79.3919], [43.6648, -79.3922], [43.6662, -79.3926],
  [43.667, -79.392], [43.6678, -79.3935], [43.6677, -79.3951], [43.667, -79.3953], [43.6662, -79.3956],
  [43.6653, -79.3959], [43.6647, -79.3962],
];

// The URL may carry the gateway access token as `?token=…` (WANDER_ACCESS_TOKEN on the gateway).
function splitUrl(wsUrl: string): { base: string; query: string } {
  const [path, query = ''] = wsUrl.trim().split('?');
  return { base: path.replace(/\/v1\/session$/, '').replace(/\/$/, ''), query: query ? `?${query}` : '' };
}

export function httpBase(wsUrl: string): string {
  return splitUrl(wsUrl).base.replace(/^ws/, 'http');
}

export function sessionUrl(wsUrl: string): string {
  const { base, query } = splitUrl(wsUrl);
  return `${base}/v1/session${query}`;
}
