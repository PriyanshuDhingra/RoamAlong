import { create } from 'zustand';

import type { Card, GuideState, Proactivity, Tour } from '../../../../protocol/gen/ts/messages';
import { DEFAULT_GATEWAY_URL, START } from './config';

export type Line = { id: string; role: 'user' | 'assistant' | 'dbg'; text: string; final: boolean };
export type Fix = { lat: number; lon: number; heading: number | null; speed: number; accuracy: number };
export type LocationSource = 'gps' | 'sim';
export type Mode = 'wander' | 'tour';

/** GET /v1/tours item */
export type TourSummary = {
  id: string; title: string; subtitle: string; theme: string; duration_min: number; distance_m: number;
  image_url: string | null;
  stops: { entity_id: string; name: string; lat: number; lon: number; image_url: string | null; summary: string }[];
};

type State = {
  gatewayUrl: string;
  connection: 'offline' | 'connecting' | 'live' | 'error';
  guideState: GuideState | 'offline';
  language: string;
  proactivity: Proactivity;
  mode: Mode;
  micOn: boolean;
  guidePaused: boolean;
  source: LocationSource;
  fix: Fix;
  lines: Line[];
  card: Card | null;
  selectedId: string | null; // place the user tapped (shows its card even when the guide isn't talking about it)
  focus: GeoJSON.FeatureCollection;
  route: GeoJSON.Feature | null;
  tours: TourSummary[];
  tour: Tour | null;
  attention: string;
  set: (p: Partial<State>) => void;
  addLine: (l: Line) => void;
  upsertLine: (l: Line) => void;
};

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export const useWander = create<State>((set) => ({
  gatewayUrl: DEFAULT_GATEWAY_URL,
  connection: 'offline',
  guideState: 'offline',
  language: 'en',
  proactivity: 'balanced',
  mode: 'wander',
  micOn: false,
  guidePaused: false,
  source: 'gps',
  fix: { lat: START.lat, lon: START.lon, heading: null, speed: 0, accuracy: 50 },
  lines: [],
  card: null,
  selectedId: null,
  focus: EMPTY,
  route: null,
  tours: [],
  tour: null,
  attention: '',
  set: (p) => set(p),
  addLine: (l) => set((s) => ({ lines: [...s.lines.slice(-60), l] })),
  upsertLine: (l) =>
    set((s) => {
      const i = s.lines.findIndex((x) => x.id === l.id);
      if (i < 0) return { lines: [...s.lines.slice(-60), l] };
      const lines = s.lines.slice();
      lines[i] = l;
      return { lines };
    }),
}));

export const emptyCollection = EMPTY;
