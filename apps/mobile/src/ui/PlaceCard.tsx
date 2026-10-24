import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Card } from '../../../../protocol/gen/ts/messages';
import type { Theme } from './theme';

/** Airbnb-style place card: photo, name, one-line summary; tap to expand sourced facts. */
export function PlaceCard({ card, t, onClose }: { card: Card; t: Theme; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen(!open)} style={[styles.card, { backgroundColor: t.panel }]}>
      <View style={styles.row}>
        {card.thumb_url ? (
          <Image source={{ uri: card.thumb_url }} style={styles.photo} contentFit="cover" transition={200} />
        ) : (
          <View style={[styles.photo, styles.noPhoto, { backgroundColor: t.chip }]}>
            <SymbolView name="building.columns" size={26} tintColor={t.faint} />
          </View>
        )}
        <View style={styles.body}>
          <Text style={[styles.title, { color: t.ink }]} numberOfLines={2}>{card.title}</Text>
          {card.subtitle ? (
            <Text style={[styles.sub, { color: t.muted }]} numberOfLines={open ? 6 : 2}>{card.subtitle}</Text>
          ) : null}
          {!open && card.facts.length ? (
            <Text style={[styles.more, { color: t.ink }]}>{card.facts.length} sourced facts · tap</Text>
          ) : null}
        </View>
        <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close card">
          <SymbolView name="xmark" size={14} tintColor={t.muted} />
        </Pressable>
      </View>
      {open ? card.facts.map((f, i) => (
        <View key={i} style={[styles.fact, { borderTopColor: t.line }]}>
          <Text style={[styles.factText, { color: t.ink }]}>{f.text}</Text>
          {f.source_url ? (
            <Text style={[styles.src, { color: t.muted }]} onPress={() => Linking.openURL(f.source_url!)}>
              {hostOf(f.source_url)} ↗</Text>
          ) : f.source_title ? <Text style={[styles.src, { color: t.muted }]}>{f.source_title}</Text> : null}
        </View>
      )) : null}
    </Pressable>
  );
}

function hostOf(url: string): string {
  const m = url.match(/^https?:\/\/([^/]+)/);
  return m ? m[1].replace(/^www\./, '') : 'source';
}

const styles = StyleSheet.create({
  card: { borderRadius: 18 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  photo: { width: 84, height: 84, borderRadius: 14 },
  noPhoto: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 3 },
  title: { fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
  sub: { fontSize: 14, lineHeight: 19 },
  more: { fontSize: 13, fontWeight: '600', marginTop: 2, textDecorationLine: 'underline' },
  fact: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 10, paddingTop: 10, gap: 3 },
  factText: { fontSize: 14, lineHeight: 20 },
  src: { fontSize: 12 },
});
