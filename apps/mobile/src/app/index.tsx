// Main screen (IMPLEMENTATION_PLAN.md §12.4): full-screen map, status pill, big buttons, caption chip.
// Voice first: the screen only answers "where am I, what is it talking about, where am I going".
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map,
} from '@maplibre/maplibre-react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { httpBase, MAP_STYLE, START } from '@/wander/config';
import { startDemoWalk, startGps, stopAll, teleport } from '@/wander/location';
import { guide } from '@/wander/session';
import { emptyCollection, useWander } from '@/wander/store';

const ACCENT = '#d9480f';
const USER = '#1c64f2';

export default function Home() {
  useKeepAwake();
  const dark = useColorScheme() === 'dark';
  const c = dark ? darkColors : lightColors;
  const st = useWander();
  const camera = useRef<CameraRef>(null);
  const [heroes, setHeroes] = useState<GeoJSON.FeatureCollection>(emptyCollection);
  const [settings, setSettings] = useState(false);
  // Camera follows the user except after a manual pan (until "Me") or briefly while framing a focus.
  const followPausedUntil = useRef(0);
  const [question, setQuestion] = useState('');
  const [cardOpen, setCardOpen] = useState(false);

  // Hero outlines for the map (cheap, static)
  useEffect(() => {
    fetch(`${httpBase(st.gatewayUrl)}/v1/places/heroes`)
      .then((r) => r.json())
      .then(setHeroes)
      .catch(() => setHeroes(emptyCollection));
  }, [st.gatewayUrl, st.connection]);

  // Start on GPS; fall back to the simulated start point if permission is refused
  useEffect(() => {
    startGps().then((ok) => {
      if (!ok) teleport(START.lat, START.lon);
    });
    return stopAll;
  }, []);

  // Follow the user unless they panned away
  useEffect(() => {
    if (Date.now() > followPausedUntil.current) {
      camera.current?.easeTo({ center: [st.fix.lon, st.fix.lat], duration: 500 });
    }
  }, [st.fix.lat, st.fix.lon]);

  // Frame the user and whatever is being talked about
  useEffect(() => {
    const coords = st.focus.features.flatMap((f) => flatten(f.geometry));
    if (!coords.length) return;
    const { lat, lon } = useWander.getState().fix;
    coords.push([lon, lat]);
    const lons = coords.map((p) => p[0]);
    const lats = coords.map((p) => p[1]);
    followPausedUntil.current = Math.max(followPausedUntil.current, Date.now() + 15000);
    camera.current?.fitBounds([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      { padding: { top: 140, bottom: 260, left: 50, right: 90 }, duration: 600, maxZoom: 17.5 } as never);
  }, [st.focus]);

  const user = useMemo<GeoJSON.Feature>(() => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [st.fix.lon, st.fix.lat] },
    properties: { heading: st.fix.heading ?? 0, hasHeading: st.fix.heading != null },
  }), [st.fix]);

  const live = st.connection === 'live';
  const lastGuide = [...st.lines].reverse().find((l) => l.role === 'assistant');
  const stateLabel = live ? String(st.guideState).toLowerCase().replaceAll('_', ' ') : st.connection;

  return (
    <View style={styles.fill}>
      <Map
        style={styles.fill}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution
        compass={false}
        onLongPress={(e) => teleport(e.nativeEvent.lngLat[1], e.nativeEvent.lngLat[0])}
        onRegionWillChange={(e) => {
          if (e.nativeEvent.userInteraction) followPausedUntil.current = Infinity;
        }}>
        <Camera ref={camera} initialViewState={{ center: [START.lon, START.lat], zoom: 16.4, pitch: 40 }} />

        <GeoJSONSource id="heroes" data={heroes}>
          <Layer type="fill" id="hero-fill" paint={{ 'fill-color': ACCENT, 'fill-opacity': 0.1 }} />
          <Layer type="line" id="hero-line" paint={{ 'line-color': ACCENT, 'line-opacity': 0.5, 'line-width': 1.2 }} />
          <Layer type="symbol" id="hero-label" layout={{ 'text-field': ['get', 'name'], 'text-size': 11,
            'text-font': ['Noto Sans Regular'], 'text-optional': true, 'text-offset': [0, 1] }}
            paint={{ 'text-color': '#8a3a12', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 }} />
        </GeoJSONSource>

        {st.route ? (
          <GeoJSONSource id="route" data={st.route}>
            <Layer type="line" id="route-line" paint={{ 'line-color': USER, 'line-width': 5, 'line-opacity': 0.8 }}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }} />
          </GeoJSONSource>
        ) : null}

        <GeoJSONSource id="focus" data={st.focus}>
          <Layer type="fill-extrusion" id="focus-3d" paint={{ 'fill-extrusion-color': ACCENT,
            'fill-extrusion-opacity': 0.8, 'fill-extrusion-height': ['coalesce', ['get', 'height_m'], 14] }} />
          <Layer type="line" id="focus-line" filter={['==', ['geometry-type'], 'LineString']}
            paint={{ 'line-color': ACCENT, 'line-width': 6, 'line-dasharray': [1, 1] }} />
          <Layer type="circle" id="focus-point" filter={['==', ['geometry-type'], 'Point']}
            paint={{ 'circle-radius': 9, 'circle-color': ACCENT, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 }} />
          <Layer type="symbol" id="focus-badge" layout={{ 'text-field': ['get', 'badge'], 'text-size': 18,
            'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true }}
            paint={{ 'text-color': '#fff', 'text-halo-color': ACCENT, 'text-halo-width': 3 }} />
        </GeoJSONSource>

        <GeoJSONSource id="user" data={user}>
          <Layer type="circle" id="user-halo" paint={{ 'circle-radius': 18, 'circle-color': USER, 'circle-opacity': 0.15 }} />
          <Layer type="symbol" id="user-heading" filter={['==', ['get', 'hasHeading'], true]}
            layout={{ 'text-field': '▲', 'text-size': 16, 'text-rotate': ['get', 'heading'],
              'text-rotation-alignment': 'map', 'text-offset': [0, -1.5], 'text-allow-overlap': true,
              'text-font': ['Noto Sans Bold'] }} paint={{ 'text-color': USER }} />
          <Layer type="circle" id="user-dot" paint={{ 'circle-radius': 8, 'circle-color': USER,
            'circle-stroke-color': '#fff', 'circle-stroke-width': 3 }} />
        </GeoJSONSource>
      </Map>

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        {/* status pill */}
        <View style={styles.topRow} pointerEvents="box-none">
          <Pressable onPress={() => setSettings(true)} style={[styles.pill, { backgroundColor: c.panel }]}>
            <View style={[styles.dot, { backgroundColor: live ? (st.micOn ? '#2b8a3e' : ACCENT) : '#999' }]} />
            <Text style={[styles.pillText, { color: c.ink }]}>
              Wander · {stateLabel} · {st.language.toUpperCase()} · {st.source === 'sim' ? 'SIM' : 'GPS'}
            </Text>
          </Pressable>
        </View>

        {/* big right-edge buttons */}
        <View style={styles.buttons} pointerEvents="box-none">
          <RoundButton label={live ? 'End' : 'Start'} active={live} color={c} onPress={() =>
            live || st.connection === 'connecting' ? guide.disconnect() : guide.connect()} />
          <RoundButton label={st.micOn ? 'Mic on' : 'Mic off'} active={st.micOn} disabled={!live} color={c}
            onPress={() => guide.setMic(!st.micOn)} />
          <RoundButton label={st.guidePaused ? 'Resume' : 'Quiet'} active={st.guidePaused} disabled={!live} color={c}
            onPress={() => guide.setGuidePaused(!st.guidePaused)} />
          <RoundButton label="Me" color={c} onPress={() => {
            followPausedUntil.current = 0;
            camera.current?.easeTo({ center: [st.fix.lon, st.fix.lat], zoom: 16.5, duration: 500 });
          }} />
        </View>

        {/* caption chip */}
        <View style={styles.bottom} pointerEvents="box-none">
          {st.card ? (
            <Pressable onPress={() => setCardOpen(!cardOpen)} style={[styles.card, { backgroundColor: c.panel }]}>
              <Text style={[styles.cardTitle, { color: c.ink }]}>{st.card.title}</Text>
              {st.card.subtitle ? <Text style={[styles.cardSub, { color: c.muted }]} numberOfLines={cardOpen ? 4 : 1}>
                {st.card.subtitle}</Text> : null}
              {cardOpen ? st.card.facts.map((f, i) => (
                <Text key={i} style={[styles.fact, { color: c.ink }]}>
                  • {f.text}{' '}
                  {f.source_url ? <Text style={{ color: c.muted }} onPress={() => Linking.openURL(f.source_url!)}>
                    (source)</Text> : f.source_title ? <Text style={{ color: c.muted }}>({f.source_title})</Text> : null}
                </Text>
              )) : null}
            </Pressable>
          ) : null}
          {lastGuide ? (
            <View style={[styles.caption, { backgroundColor: c.panel }]}>
              <Text style={[styles.captionText, { color: c.ink, opacity: lastGuide.final ? 1 : 0.7 }]} numberOfLines={4}>
                {lastGuide.text}</Text>
            </View>
          ) : null}
        </View>
      </SafeAreaView>

      {settings ? (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetWrap}>
          <Pressable style={styles.fill} onPress={() => setSettings(false)} />
          <View style={[styles.sheet, { backgroundColor: c.panel }]}>
            <Text style={[styles.sheetTitle, { color: c.ink }]}>Settings & debug</Text>
            <Text style={[styles.label, { color: c.muted }]}>Gateway URL</Text>
            <TextInput value={st.gatewayUrl} onChangeText={(v) => st.set({ gatewayUrl: v.trim() })} autoCapitalize="none"
              autoCorrect={false} style={[styles.input, { color: c.ink, borderColor: c.line }]} />
            <Text style={[styles.label, { color: c.muted }]}>Location</Text>
            <View style={styles.row}>
              <SmallButton label="Real GPS" color={c} onPress={() => startGps()} />
              <SmallButton label="Demo walk 2×" color={c} onPress={() => startDemoWalk(2)} />
              <SmallButton label="Demo walk 4×" color={c} onPress={() => startDemoWalk(4)} />
            </View>
            <Text style={[styles.hint, { color: c.muted }]}>Long-press the map to teleport there.</Text>
            <Text style={[styles.label, { color: c.muted }]}>Ask by text</Text>
            <View style={styles.row}>
              <TextInput value={question} onChangeText={setQuestion} placeholder="What's that building?"
                placeholderTextColor={c.muted} style={[styles.input, styles.flex, { color: c.ink, borderColor: c.line }]}
                onSubmitEditing={() => { if (question.trim()) { guide.ask(question.trim()); setQuestion(''); } }} />
            </View>
            <Text style={[styles.label, { color: c.muted }]}>Attention queue</Text>
            <Text style={[styles.mono, { color: c.ink }]}>{st.attention || '—'}</Text>
            <ScrollView style={styles.log}>
              {st.lines.slice(-12).map((l) => (
                <Text key={l.id} style={[styles.logLine, { color: l.role === 'dbg' ? c.muted : c.ink }]}>
                  {l.role === 'user' ? 'You: ' : l.role === 'assistant' ? 'Guide: ' : ''}{l.text}</Text>
              ))}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      ) : null}
    </View>
  );
}

type Colors = typeof lightColors;

function RoundButton({ label, onPress, active, disabled, color }:
  { label: string; onPress: () => void; active?: boolean; disabled?: boolean; color: Colors }) {
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={[styles.round, { backgroundColor: active ? ACCENT : color.panel, opacity: disabled ? 0.45 : 1 }]}>
      <Text style={[styles.roundText, { color: active ? '#fff' : color.ink }]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ label, onPress, color }: { label: string; onPress: () => void; color: Colors }) {
  return (
    <Pressable onPress={onPress} style={[styles.small, { borderColor: color.line }]}>
      <Text style={{ color: color.ink, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function flatten(g: GeoJSON.Geometry): number[][] {
  switch (g.type) {
    case 'Point': return [g.coordinates];
    case 'LineString': case 'MultiPoint': return g.coordinates;
    case 'Polygon': case 'MultiLineString': return g.coordinates.flat();
    case 'MultiPolygon': return g.coordinates.flat(2);
    default: return [];
  }
}

const lightColors = { panel: 'rgba(255,255,255,0.96)', ink: '#1d1d1b', muted: '#6b6b66', line: '#e3e3de' };
const darkColors = { panel: 'rgba(31,31,29,0.96)', ink: '#ecece8', muted: '#9a9a93', line: '#3a3a35' };

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill },
  topRow: { paddingHorizontal: 16, paddingTop: 8, flexDirection: 'row' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8,
          borderRadius: 999, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  pillText: { fontSize: 13, fontWeight: '600' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  buttons: { position: 'absolute', right: 16, top: 120, gap: 12 },
  round: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center',
           shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  roundText: { fontSize: 13, fontWeight: '700' },
  bottom: { position: 'absolute', left: 16, right: 16, bottom: 28, gap: 8 },
  card: { borderRadius: 14, padding: 12, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  cardSub: { fontSize: 13, marginTop: 2 },
  fact: { fontSize: 13, marginTop: 6 },
  caption: { borderRadius: 14, padding: 12 },
  captionText: { fontSize: 15, lineHeight: 20 },
  sheetWrap: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 36, maxHeight: '80%' },
  sheetTitle: { fontSize: 17, fontWeight: '700', marginBottom: 8 },
  label: { fontSize: 12, marginTop: 12, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  hint: { fontSize: 12, marginTop: 4 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  small: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12 },
  log: { marginTop: 10, maxHeight: 160 },
  logLine: { fontSize: 12, marginVertical: 2 },
});
