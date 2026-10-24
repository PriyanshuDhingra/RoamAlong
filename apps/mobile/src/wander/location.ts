// Location providers (IMPLEMENTATION_PLAN.md §13.4): real GPS + compass, or a simulated walk for indoor testing.
// Both feed the same store and the same gateway pipeline; fixes carry `source` so logs show SIM.
import * as Location from 'expo-location';

import { DEMO_TRACK } from './config';
import { guide } from './session';
import { useWander } from './store';

let gpsSub: Location.LocationSubscription | null = null;
let headingSub: Location.LocationSubscription | null = null;
let simTimer: ReturnType<typeof setInterval> | null = null;
let lastSent = 0;

function update(p: Partial<ReturnType<typeof useWander.getState>['fix']>, force = false): void {
  const s = useWander.getState();
  s.set({ fix: { ...s.fix, ...p } });
  const now = Date.now();
  if (force || now - lastSent > 900) {
    lastSent = now;
    guide.sendFix();
  }
}

export async function startGps(): Promise<boolean> {
  stopAll();
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return false;
  useWander.getState().set({ source: 'gps' });
  gpsSub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 2, timeInterval: 1000 },
    (loc) => {
      const speed = Math.max(0, loc.coords.speed ?? 0);
      const course = loc.coords.heading != null && loc.coords.heading >= 0 && speed > 0.5 ? loc.coords.heading : null;
      update({ lat: loc.coords.latitude, lon: loc.coords.longitude, accuracy: loc.coords.accuracy ?? 30, speed,
               ...(course != null ? { heading: course } : {}) });
    },
  );
  // Standing still: use the compass, since people turn to look at things (§7.1)
  headingSub = await Location.watchHeadingAsync((h) => {
    const s = useWander.getState();
    if (s.fix.speed <= 0.5 && h.accuracy >= 1) update({ heading: h.trueHeading >= 0 ? h.trueHeading : h.magHeading });
  });
  return true;
}

export function teleport(lat: number, lon: number): void {
  stopAll();
  const s = useWander.getState();
  const heading = bearing(s.fix.lat, s.fix.lon, lat, lon);
  s.set({ source: 'sim' });
  update({ lat, lon, heading, speed: 0, accuracy: 6 }, true);
}

export function startDemoWalk(multiplier = 2): void {
  stopAll();
  useWander.getState().set({ source: 'sim' });
  const pts = DEMO_TRACK.map(([lat, lon]) => ({ lat, lon }));
  update({ ...pts[0], speed: 1.3, accuracy: 6 }, true);
  let i = 1;
  simTimer = setInterval(() => {
    const s = useWander.getState();
    let step = 1.3 * 0.25 * multiplier;
    let { lat, lon, heading } = s.fix;
    while (step > 0 && i < pts.length) {
      const t = pts[i];
      const d = dist(lat, lon, t.lat, t.lon);
      if (d <= step) { lat = t.lat; lon = t.lon; step -= d; i++; continue; }
      heading = bearing(lat, lon, t.lat, t.lon);
      lat += ((t.lat - lat) * step) / d;
      lon += ((t.lon - lon) * step) / d;
      step = 0;
    }
    const done = i >= pts.length;
    update({ lat, lon, heading, speed: done ? 0 : 1.3, accuracy: 6 }, done);
    if (done) stopAll();
  }, 250);
}

export function stopAll(): void {
  gpsSub?.remove();
  headingSub?.remove();
  gpsSub = headingSub = null;
  if (simTimer) clearInterval(simTimer);
  simTimer = null;
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
function dist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
