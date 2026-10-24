import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { startDemoWalk, startGps } from '@/wander/location';
import { guide } from '@/wander/session';
import { useWander } from '@/wander/store';

import type { Theme } from './theme';

/** Settings & debug: gateway URL (tunnel), location source, ask by text, what the Director is considering. */
export function SettingsSheet({ t, onClose }: { t: Theme; onClose: () => void }) {
  const st = useWander();
  const [question, setQuestion] = useState('');
  const ask = () => {
    if (!question.trim()) return;
    guide.ask(question.trim());
    setQuestion('');
  };
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdrop}>
      <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close settings" />
      <View style={[styles.sheet, { backgroundColor: t.panel }]}>
        <View style={[styles.grabber, { backgroundColor: t.line }]} />
        <ScrollView contentContainerStyle={{ gap: 6 }} keyboardShouldPersistTaps="handled">
          <Text style={[styles.title, { color: t.ink }]}>Settings</Text>

          <Text style={[styles.label, { color: t.muted }]}>Gateway</Text>
          <TextInput value={st.gatewayUrl} onChangeText={(v) => st.set({ gatewayUrl: v.trim() })} autoCapitalize="none"
            autoCorrect={false} style={[styles.input, { color: t.ink, backgroundColor: t.chip }]} />
          <Text style={[styles.note, { color: t.muted }]}>Status: {st.connection}. For walks outside, paste the tunnel
            address (wss://…?token=…).</Text>

          <Text style={[styles.label, { color: t.muted }]}>Location</Text>
          <View style={styles.row}>
            <Chip t={t} label="Real GPS" on={st.source === 'gps'} onPress={() => void startGps()} />
            <Chip t={t} label="Demo walk 2×" onPress={() => { startDemoWalk(2); onClose(); }} />
            <Chip t={t} label="Demo walk 4×" onPress={() => { startDemoWalk(4); onClose(); }} />
          </View>
          <Text style={[styles.note, { color: t.muted }]}>
            Long-press the map to teleport. Location accuracy now: {Math.round(st.fix.accuracy)} m.</Text>

          <Text style={[styles.label, { color: t.muted }]}>Ask by text</Text>
          <TextInput value={question} onChangeText={setQuestion} placeholder="What's that building?"
            placeholderTextColor={t.faint} returnKeyType="send" onSubmitEditing={ask}
            style={[styles.input, { color: t.ink, backgroundColor: t.chip }]} />

          <Text style={[styles.label, { color: t.muted }]}>Guide is considering</Text>
          <Text style={[styles.mono, { color: t.ink }]}>{st.attention || '—'}</Text>

          <Text style={[styles.label, { color: t.muted }]}>Conversation</Text>
          {st.lines.slice(-14).map((l) => (
            <Text key={l.id} style={[styles.log, { color: l.role === 'dbg' ? t.muted : t.ink }]}>
              <Text style={{ fontWeight: '700' }}>{l.role === 'user' ? 'You  ' : l.role === 'assistant' ? 'Guide  ' : ''}</Text>
              {l.text}</Text>
          ))}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

function Chip({ t, label, onPress, on }: { t: Theme; label: string; onPress: () => void; on?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, { backgroundColor: on ? t.primary : t.chip }]}>
      <Text style={{ color: on ? t.onPrimary : t.ink, fontSize: 14, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingTop: 8, paddingBottom: 40,
           maxHeight: '85%' },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, marginBottom: 10 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  label: { fontSize: 12, fontWeight: '700', marginTop: 14, textTransform: 'uppercase', letterSpacing: 0.6 },
  note: { fontSize: 12, lineHeight: 17 },
  input: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, lineHeight: 18 },
  log: { fontSize: 13, lineHeight: 19, marginVertical: 1 },
});
