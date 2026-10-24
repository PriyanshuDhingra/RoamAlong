import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { shadow, type Theme } from './theme';

type Props = { t: Theme; live: boolean; connecting: boolean; micOn: boolean; speaking: boolean; onPress: () => void };

/** Big round primary action (Uber "Go"-style): Start the walk, then tap to talk / mute. Pulses while listening. */
export function TalkButton({ t, live, connecting, micOn, speaking, onPress }: Props) {
  const [pulse] = useState(() => new Animated.Value(0));
  const listening = live && micOn;

  useEffect(() => {
    if (!listening) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad),
                                                       useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [listening, pulse]);

  const bg = !live ? t.primary : micOn ? t.accent : t.panel;
  const fg = !live ? t.onPrimary : micOn ? '#fff' : t.ink;
  const icon = !live ? 'play.fill' : micOn ? (speaking ? 'waveform' : 'mic.fill') : 'mic.slash.fill';
  const label = connecting ? 'Connecting…' : !live ? 'Start walk' : micOn ? (speaking ? 'Guide speaking' : 'Listening')
    : 'Tap to talk';

  return (
    <View style={styles.wrap}>
      <View style={styles.btnWrap}>
        {listening ? (
          <Animated.View pointerEvents="none" style={[styles.ring, { borderColor: t.accent,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) }] }]} />
        ) : null}
        <Pressable onPress={onPress} disabled={connecting} accessibilityRole="button" accessibilityLabel={label}
          style={({ pressed }) => [styles.btn, { backgroundColor: bg, borderColor: t.line, transform: [{ scale: pressed ? 0.95 : 1 }] },
                                   live && !micOn && styles.outlined, shadow(t, 14)]}>
          <SymbolView name={icon} size={30} tintColor={fg} />
        </Pressable>
      </View>
      <Text style={[styles.label, { color: t.muted }]}>{label}</Text>
    </View>
  );
}

const SIZE = 76;
const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 6 },
  btnWrap: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  btn: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
  outlined: { borderWidth: 1 },
  ring: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 3 },
  label: { fontSize: 12, fontWeight: '600' },
});
