import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useWander } from '@/wander/store';

import { shadow, useTheme } from './theme';

type Props = { onMode: (mode: 'wander' | 'tour') => void; onSettings: () => void };

/** Floating header: mode switch (Wander | Tours) and a settings button with a connection dot. */
export function TopBar({ onMode, onSettings }: Props) {
  const t = useTheme();
  const mode = useWander((s) => s.mode);
  const connection = useWander((s) => s.connection);
  const source = useWander((s) => s.source);
  const dot = connection === 'live' ? t.success : connection === 'connecting' ? '#F5A623' : t.faint;

  return (
    <View style={styles.row} pointerEvents="box-none">
      <View style={[styles.segment, { backgroundColor: t.panel }, shadow(t, 10)]}>
        {(['wander', 'tour'] as const).map((m) => {
          const on = mode === m;
          return (
            <Pressable key={m} onPress={() => onMode(m)} accessibilityRole="tab" accessibilityState={{ selected: on }}
              style={[styles.segBtn, on && { backgroundColor: t.primary }]}>
              <SymbolView name={m === 'wander' ? 'figure.walk' : 'map'} size={15}
                tintColor={on ? t.onPrimary : t.ink} />
              <Text style={[styles.segText, { color: on ? t.onPrimary : t.ink }]}>{m === 'wander' ? 'Wander' : 'Tours'}</Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable onPress={onSettings} accessibilityLabel="Settings"
        style={[styles.circle, { backgroundColor: t.panel }, shadow(t, 10)]}>
        <SymbolView name="slider.horizontal.3" size={18} tintColor={t.ink} />
        <View style={[styles.dot, { backgroundColor: dot, borderColor: t.panel }]} />
        {source === 'sim' ? <Text style={[styles.sim, { backgroundColor: t.accent }]}>SIM</Text> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16 },
  segment: { flexDirection: 'row', borderRadius: 999, padding: 4, gap: 2 },
  segBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 10,
            borderRadius: 999 },
  segText: { fontSize: 15, fontWeight: '600' },
  circle: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', top: 9, right: 9, width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
  sim: { position: 'absolute', bottom: -8, color: '#fff', fontSize: 9, fontWeight: '800', paddingHorizontal: 5,
         paddingVertical: 1, borderRadius: 4, overflow: 'hidden' },
});
