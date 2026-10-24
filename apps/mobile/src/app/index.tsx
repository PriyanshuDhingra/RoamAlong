// Main screen (IMPLEMENTATION_PLAN.md §12.4): full-screen map, floating mode switch, bottom sheet with the guide's
// caption, the place being discussed, tours, and the big talk button. Voice first: glanceable in one second.
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomPanel } from '@/ui/BottomPanel';
import { SettingsSheet } from '@/ui/SettingsSheet';
import { useTheme } from '@/ui/theme';
import { TopBar } from '@/ui/TopBar';
import { WanderMap, type WanderMapRef } from '@/ui/WanderMap';
import { httpBase, START } from '@/wander/config';
import { startGps, stopAll, teleport } from '@/wander/location';
import { guide } from '@/wander/session';
import { emptyCollection, useWander } from '@/wander/store';

const SHEET_GUESS = 300; // camera padding until the sheet reports its height

export default function Home() {
  useKeepAwake();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const map = useRef<WanderMapRef>(null);
  const followPausedUntil = useRef(0);
  const [sheetH, setSheetH] = useState(SHEET_GUESS);
  const [heroes, setHeroes] = useState<GeoJSON.FeatureCollection>(emptyCollection);
  const [settings, setSettings] = useState(false);
  const gatewayUrl = useWander((s) => s.gatewayUrl);
  const connection = useWander((s) => s.connection);
  const fix = useWander((s) => s.fix);
  const focus = useWander((s) => s.focus);
  const route = useWander((s) => s.route);

  // Hero outlines and the tour list (static data from the gateway)
  useEffect(() => {
    fetch(`${httpBase(gatewayUrl)}/v1/places/heroes`)
      .then((r) => r.json())
      .then(setHeroes)
      .catch(() => setHeroes(emptyCollection));
    void guide.loadTours();
  }, [gatewayUrl, connection]);

  // Real GPS by default; the King's College Circle start point if permission is refused
  useEffect(() => {
    startGps().then((ok) => {
      if (!ok) teleport(START.lat, START.lon);
    });
    return stopAll;
  }, []);

  // Follow the user unless they panned away or the camera is framing something
  useEffect(() => {
    if (Date.now() > followPausedUntil.current) map.current?.recenter();
  }, [fix.lat, fix.lon]);

  // Frame the user and the place being talked about
  useEffect(() => {
    const coords = focus.features.flatMap((f) => flatten(f.geometry));
    if (!coords.length) return;
    const { lat, lon } = useWander.getState().fix;
    followPausedUntil.current = Math.max(followPausedUntil.current, Date.now() + 15000);
    map.current?.frame([...coords, [lon, lat]], sheetH);
  }, [focus, sheetH]);

  // A new walking leg: show the whole route once
  useEffect(() => {
    if (!route) return;
    followPausedUntil.current = Math.max(followPausedUntil.current, Date.now() + 10000);
    map.current?.frame(flatten(route.geometry), sheetH);
  }, [route, sheetH]);

  const onMode = (mode: 'wander' | 'tour') => {
    useWander.getState().set({ mode });
    if (mode === 'tour') void guide.loadTours();
  };

  return (
    <View style={[styles.fill, { backgroundColor: t.bg }]}>
      <WanderMap ref={map} heroes={heroes} onUserPan={() => { followPausedUntil.current = Infinity; }} />

      <SafeAreaView edges={['top']} style={styles.top} pointerEvents="box-none">
        <TopBar onMode={onMode} onSettings={() => setSettings(true)} />
      </SafeAreaView>

      <View style={styles.bottom} pointerEvents="box-none" onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}>
        <BottomPanel t={t} bottomInset={insets.bottom}
          onRecenter={() => { followPausedUntil.current = 0; map.current?.recenter(); }} />
      </View>

      {settings ? <SettingsSheet t={t} onClose={() => setSettings(false)} /> : null}
    </View>
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 6 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
