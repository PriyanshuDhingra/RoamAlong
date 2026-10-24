// App <-> Gateway session (protocol/README.md). JSON text frames for control, binary frames for audio.
import * as Haptics from 'expo-haptics';

import type { DownlinkMessage, UplinkMessage } from '../../../../protocol/gen/ts/messages';
import { AudioEngine } from './audio';
import { httpBase, sessionUrl } from './config';
import { emptyCollection, type TourSummary, useWander } from './store';

const APP_VERSION = '0.1.0';

export class GuideClient {
  private ws: WebSocket | null = null;
  private audio: AudioEngine;
  private closedByUser = false;
  private retry = 0;
  private placeCache = new Map<string, GeoJSON.Feature>();

  constructor() {
    this.audio = new AudioEngine(
      (pcm) => {
        if (useWander.getState().micOn && this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
      },
      (key, ms, stopped) => this.send({ type: 'playback', item_id: key, played_ms: ms, stopped }),
    );
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    const st = useWander.getState();
    st.set({ connection: 'connecting' });
    const micOk = await this.audio.start();
    if (!micOk) st.addLine({ id: `d${Date.now()}`, role: 'dbg', text: 'Microphone permission denied', final: true });
    const ws = new WebSocket(sessionUrl(st.gatewayUrl));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      const lang = (Intl.DateTimeFormat().resolvedOptions().locale || 'en').split('-')[0];
      this.send({ type: 'hello', device_id: 'ios-app', mode: 'wander', ui_lang: lang, app_version: APP_VERSION,
                  debug: true });
      useWander.getState().set({ connection: 'live' });
      this.sendFix();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.onJson(JSON.parse(e.data) as DownlinkMessage);
      else this.audio.play(e.data as ArrayBuffer);
    };
    ws.onerror = () => useWander.getState().set({ connection: 'error' });
    ws.onclose = () => {
      this.ws = null;
      const s = useWander.getState();
      s.set({ connection: this.closedByUser ? 'offline' : 'error', guideState: 'offline' });
      if (!this.closedByUser && this.retry < 5) {
        // reconnect with backoff; the gateway re-greets, the app drops any stale audio (§14.4)
        this.retry += 1;
        this.audio.flush();
        setTimeout(() => this.reconnect(), 1000 * 2 ** this.retry);
      }
    };
  }

  private reconnect(): void {
    if (this.closedByUser) return;
    void this.audio.stop().then(() => this.connect());
  }

  async disconnect(): Promise<void> {
    this.closedByUser = true;
    this.ws?.close();
    await this.audio.stop();
    useWander.getState().set({ connection: 'offline', guideState: 'offline', micOn: false });
  }

  send(msg: UplinkMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendFix(): void {
    const { fix, source } = useWander.getState();
    this.send({ type: 'location', lat: fix.lat, lon: fix.lon, accuracy_m: fix.accuracy, speed_mps: fix.speed,
                ts: Date.now(), source, ...(fix.heading != null ? { heading_deg: fix.heading, course_deg: fix.heading } : {}) });
  }

  async setMic(on: boolean): Promise<void> {
    useWander.getState().set({ micOn: on });
    if (on) await this.audio.startMic();
    else await this.audio.stopMic();
    this.send({ type: 'control', action: on ? 'unmute_mic' : 'mute_mic' });
  }

  setGuidePaused(paused: boolean): void {
    if (paused) this.audio.flush();
    this.send({ type: 'control', action: paused ? 'pause_guide' : 'resume_guide' });
    useWander.getState().set({ guidePaused: paused });
  }

  ask(text: string): void {
    this.audio.flush();
    this.send({ type: 'text', text });
    useWander.getState().addLine({ id: `u${Date.now()}`, role: 'user', text, final: true });
  }

  /** User tapped a place on the map: show its card and ask the guide about it. */
  async select(id: string): Promise<void> {
    const s = useWander.getState();
    s.set({ selectedId: id });
    const f = await this.place(id);
    if (f) {
      const p = f.properties as { name: string; summary?: string; image_url?: string | null };
      s.set({ focus: { type: 'FeatureCollection', features: [f] },
              card: { type: 'card', entity_id: id, title: p.name, subtitle: p.summary ?? '', facts: [],
                      ...(p.image_url ? { thumb_url: p.image_url } : {}) } });
    }
    this.send({ type: 'ui', action: 'tap_entity', entity_id: id });
  }

  async loadTours(): Promise<void> {
    try {
      const r = await fetch(`${httpBase(useWander.getState().gatewayUrl)}/v1/tours`);
      if (r.ok) useWander.getState().set({ tours: (await r.json()) as TourSummary[] });
    } catch {
      // gateway unreachable: the picker shows an empty state
    }
  }

  startTour(id: string): void {
    this.send({ type: 'ui', action: 'start_tour', tour_id: id });
    useWander.getState().set({ mode: 'tour' });
  }

  skipStop(): void {
    this.send({ type: 'ui', action: 'skip_stop' });
  }

  endTour(): void {
    this.send({ type: 'ui', action: 'end_tour' });
    useWander.getState().set({ tour: null, mode: 'wander', route: null });
  }

  async place(id: string): Promise<GeoJSON.Feature | null> {
    if (this.placeCache.has(id)) return this.placeCache.get(id)!;
    try {
      const r = await fetch(`${httpBase(useWander.getState().gatewayUrl)}/v1/places/${id}`);
      if (!r.ok) return null;
      const f = (await r.json()) as GeoJSON.Feature;
      this.placeCache.set(id, f);
      return f;
    } catch {
      return null;
    }
  }

  private async onJson(m: DownlinkMessage): Promise<void> {
    const s = useWander.getState();
    switch (m.type) {
      case 'state':
        s.set({ guideState: m.guide_state, language: m.language, proactivity: m.proactivity, mode: m.mode });
        break;
      case 'stop_playback':
        this.audio.flush();
        break;
      case 'transcript':
        // upsert for both roles: the same item can be reported more than once (e.g. a re-sent final transcript)
        s.upsertLine({ id: `${m.role}:${m.item_id}`, role: m.role, text: m.text, final: m.role === 'user' || m.final });
        break;
      case 'card':
        s.set({ card: m });
        break;
      case 'map_focus': {
        // geometry comes inline (no extra request); fall back to /v1/places for older gateways
        const feats = await Promise.all(m.entities.map(async (e) => {
          const f = (e.feature as GeoJSON.Feature | undefined) ?? (await this.place(e.entity_id));
          return f ? { ...f, properties: { ...f.properties, badge: e.badge ?? '' } } : null;
        }));
        s.set({ focus: { type: 'FeatureCollection', features: feats.filter(Boolean) as GeoJSON.Feature[] } });
        break;
      }
      case 'route':
        s.set({ route: m.cleared ? null : { type: 'Feature', geometry: m.geojson as GeoJSON.LineString, properties: {} } });
        break;
      case 'tour': {
        const prev = s.tour;
        s.set({ tour: m.status === 'ended' ? null : m, mode: m.status === 'ended' ? 'wander' : 'tour' });
        if (prev && m.current > prev.current) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;
      }
      case 'nav_cue':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        break;
      case 'error':
        s.addLine({ id: `e${Date.now()}`, role: 'dbg', text: `${m.code}: ${m.message}`, final: true });
        break;
      case 'debug':
        if (m.kind === 'attention_queue') {
          const top = (m.payload.top as { name: string; side: string; d: number }[]) ?? [];
          s.set({ attention: top.slice(0, 3).map((t) => `${t.name} · ${t.side} ${t.d} m`).join('\n') });
        }
        break;
      default:
        break;
    }
    if (m.type === 'stop_playback') s.set({ focus: emptyCollection });
  }
}

export const guide = new GuideClient();
