import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { guide } from '@/wander/session';
import { type TourSummary, useWander } from '@/wander/store';

import { PlaceCard } from './PlaceCard';
import { TalkButton } from './TalkButton';
import { shadow, type Theme } from './theme';

type Props = { t: Theme; bottomInset: number; onRecenter: () => void };

/** Bottom sheet (§12.4): caption + place card in Wander mode, tour picker or tour progress in Tours mode. */
export function BottomPanel({ t, bottomInset, onRecenter }: Props) {
  const mode = useWander((s) => s.mode);
  const tour = useWander((s) => s.tour);
  const card = useWander((s) => s.card);
  const set = useWander((s) => s.set);
  const picking = mode === 'tour' && !tour; // the tour picker gets the whole sheet

  return (
    <View style={[styles.sheet, { backgroundColor: t.panel, paddingBottom: bottomInset + 12 }, shadow(t, 18)]}>
      <View style={[styles.grabber, { backgroundColor: t.line }]} />
      {mode === 'tour' && !tour ? <TourPicker t={t} /> : null}
      {mode === 'tour' && tour ? <TourProgress t={t} /> : null}
      {picking ? null : (
        <>
          {card && card.entity_id !== tour?.stops[tour.current]?.entity_id ? ( // the tour row already shows the stop
            <PlaceCard card={card} t={t} onClose={() => set({ card: null, selectedId: null })} />
          ) : null}
          <Caption t={t} />
        </>
      )}
      <Controls t={t} onRecenter={onRecenter} />
    </View>
  );
}

function Caption({ t }: { t: Theme }) {
  const lines = useWander((s) => s.lines);
  const live = useWander((s) => s.connection === 'live');
  const guideState = useWander((s) => s.guideState);
  const last = [...lines].reverse().find((l) => l.role === 'assistant');
  if (!live && !last) {
    return <Text style={[styles.hint, { color: t.muted }]}>Put your earbuds in and start a walk. Your guide will tell you
      about what you pass, and you can ask about anything.</Text>;
  }
  const state = String(guideState).toLowerCase().replaceAll('_', ' ');
  return (
    <View style={styles.caption}>
      <Text style={[styles.state, { color: t.accent }]}>{live ? state : 'offline'}</Text>
      {last ? (
        <Text style={[styles.captionText, { color: t.ink, opacity: last.final ? 1 : 0.75 }]} numberOfLines={3}>
          {last.text}</Text>
      ) : null}
    </View>
  );
}

function Controls({ t, onRecenter }: { t: Theme; onRecenter: () => void }) {
  const connection = useWander((s) => s.connection);
  const micOn = useWander((s) => s.micOn);
  const guidePaused = useWander((s) => s.guidePaused);
  const guideState = useWander((s) => s.guideState);
  const live = connection === 'live';
  return (
    <View style={styles.controls}>
      <SideButton t={t} icon={guidePaused ? 'speaker.slash.fill' : 'speaker.wave.2.fill'}
        label={guidePaused ? 'Quiet' : 'Guide on'} active={guidePaused} disabled={!live}
        onPress={() => guide.setGuidePaused(!guidePaused)} />
      <TalkButton t={t} live={live} connecting={connection === 'connecting'} micOn={micOn}
        speaking={guideState === 'NARRATING' || guideState === 'ANSWERING'}
        onPress={() => (live ? guide.setMic(!micOn) : guide.connect())} />
      <SideButton t={t} icon="location.fill" label="Me" onPress={onRecenter} />
    </View>
  );
}

function SideButton({ t, icon, label, onPress, active, disabled }:
  { t: Theme; icon: string; label: string; onPress: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityLabel={label}
      style={[styles.side, { opacity: disabled ? 0.4 : 1 }]}>
      <View style={[styles.sideCircle, { backgroundColor: active ? t.primary : t.chip }]}>
        <SymbolView name={icon as never} size={18} tintColor={active ? t.onPrimary : t.ink} />
      </View>
      <Text style={[styles.sideLabel, { color: t.muted }]}>{label}</Text>
    </Pressable>
  );
}

function TourPicker({ t }: { t: Theme }) {
  const tours = useWander((s) => s.tours);
  const live = useWander((s) => s.connection === 'live');
  if (!tours.length) return <Text style={[styles.hint, { color: t.muted }]}>Loading tours…</Text>;
  return (
    <View style={{ gap: 10 }}>
      <Text style={[styles.h2, { color: t.ink }]}>Guided tours nearby</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
        {tours.map((tr) => <TourCard key={tr.id} tour={tr} t={t} live={live} />)}
      </ScrollView>
    </View>
  );
}

function TourCard({ tour, t, live }: { tour: TourSummary; t: Theme; live: boolean }) {
  return (
    <View style={styles.tourCard}>
      {tour.image_url ? <Image source={{ uri: tour.image_url }} style={styles.tourPhoto} contentFit="cover" transition={200} />
        : <View style={[styles.tourPhoto, { backgroundColor: t.chip }]} />}
      <Text style={[styles.tourTitle, { color: t.ink }]} numberOfLines={1}>{tour.title}</Text>
      <Text style={[styles.tourSub, { color: t.muted }]} numberOfLines={2}>{tour.subtitle}</Text>
      <Text style={[styles.tourMeta, { color: t.ink }]}>
        {tour.stops.length} stops · {tour.duration_min} min · {(tour.distance_m / 1000).toFixed(1)} km</Text>
      <Pressable onPress={() => (live ? guide.startTour(tour.id) : guide.connect().then(() => guide.startTour(tour.id)))}
        style={[styles.startBtn, { backgroundColor: t.primary }]}>
        <Text style={[styles.startText, { color: t.onPrimary }]}>Start tour</Text>
      </Pressable>
    </View>
  );
}

function TourProgress({ t }: { t: Theme }) {
  const tour = useWander((s) => s.tour)!;
  const stop = tour.stops[tour.current];
  return (
    <View style={{ gap: 10 }}>
      <View style={styles.tourHead}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.kicker, { color: t.accent }]}>{tour.title.toUpperCase()}</Text>
          <Text style={[styles.h2, { color: t.ink }]}>Stop {tour.current + 1} of {tour.stops.length}</Text>
        </View>
        {tour.leg_eta_min != null ? (
          <View style={[styles.eta, { backgroundColor: t.chip }]}>
            <Text style={[styles.etaBig, { color: t.ink }]}>{tour.leg_eta_min} min</Text>
            {tour.leg_distance_m != null ? <Text style={[styles.etaSmall, { color: t.muted }]}>{tour.leg_distance_m} m</Text> : null}
          </View>
        ) : null}
      </View>
      <View style={styles.dots}>
        {tour.stops.map((s, i) => (
          <View key={s.entity_id} style={[styles.dotBar, { backgroundColor: s.status === 'done' ? t.primary
            : s.status === 'current' ? t.accent : t.line, flex: i === tour.current ? 2 : 1 }]} />
        ))}
      </View>
      <View style={styles.stopRow}>
        {stop.image_url ? <Image source={{ uri: stop.image_url }} style={styles.stopThumb} contentFit="cover" /> : null}
        <View style={{ flex: 1 }}>
          <Text style={[styles.stopName, { color: t.ink }]} numberOfLines={1}>{stop.name}</Text>
          <Text style={[styles.tourSub, { color: t.muted }]} numberOfLines={1}>
            {stop.status === 'done' ? 'Visited' : 'Follow the line on the map'}</Text>
        </View>
        <Pressable onPress={() => guide.skipStop()} style={[styles.pill, { backgroundColor: t.chip }]}>
          <Text style={[styles.pillText, { color: t.ink }]}>Skip</Text></Pressable>
        <Pressable onPress={() => guide.endTour()} style={[styles.pill, { backgroundColor: t.chip }]}>
          <Text style={[styles.pillText, { color: t.ink }]}>End</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28,
           paddingHorizontal: 20, paddingTop: 8, gap: 14 },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, marginBottom: 2 },
  hint: { fontSize: 15, lineHeight: 21 },
  caption: { gap: 4 },
  state: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  captionText: { fontSize: 16, lineHeight: 22 },
  controls: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 12 },
  side: { alignItems: 'center', gap: 6, width: 64, paddingTop: 14 },
  sideCircle: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  sideLabel: { fontSize: 12, fontWeight: '600' },
  h2: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  kicker: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  tourCard: { width: 236, gap: 4 },
  tourPhoto: { width: 236, height: 132, borderRadius: 16, marginBottom: 6 },
  tourTitle: { fontSize: 16, fontWeight: '700' },
  tourSub: { fontSize: 13, lineHeight: 18 },
  tourMeta: { fontSize: 13, fontWeight: '600', marginTop: 2 },
  startBtn: { marginTop: 8, borderRadius: 12, paddingVertical: 11, alignItems: 'center' },
  startText: { fontSize: 15, fontWeight: '700' },
  tourHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  eta: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' },
  etaBig: { fontSize: 17, fontWeight: '800' },
  etaSmall: { fontSize: 12 },
  dots: { flexDirection: 'row', gap: 4 },
  dotBar: { height: 4, borderRadius: 2 },
  stopRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stopThumb: { width: 44, height: 44, borderRadius: 10 },
  stopName: { fontSize: 16, fontWeight: '700' },
  pill: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  pillText: { fontSize: 14, fontWeight: '600' },
});
