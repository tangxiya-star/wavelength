import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check } from '../components/icons';
import { useSession } from '../lib/session';
import { colors, font, radius, space } from '../lib/theme';

function fmtElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export default function CompleteScreen() {
  const { status, summary, reset } = useSession();

  useEffect(() => {
    if (status === 'idle') router.replace('/');
  }, [status]);

  const onClose = () => {
    reset();
    router.replace('/');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.body}>
          <View style={styles.checkCircle}>
            <Check size={40} color={colors.up} strokeWidth={3} />
          </View>
          <Text style={styles.heading}>Session complete</Text>
          <Text style={styles.para}>Thanks for participating. Your responses have been recorded.</Text>

          <View style={styles.stats}>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Videos viewed</Text>
              <Text style={styles.statValue}>{summary?.videosViewed ?? 0}</Text>
            </View>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Time in feed</Text>
              <Text style={styles.statValue}>{fmtElapsed(summary?.elapsedMs ?? 0)}</Text>
            </View>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Liked</Text>
              <Text style={styles.statValue}>{summary?.likes ?? 0}</Text>
            </View>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Disliked</Text>
              <Text style={styles.statValue}>{summary?.dislikes ?? 0}</Text>
            </View>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Saved</Text>
              <Text style={styles.statValue}>{summary?.saves ?? 0}</Text>
            </View>
          </View>
        </View>

        <Pressable onPress={onClose} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <Text style={styles.buttonText}>Close</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, padding: space.lg, justifyContent: 'space-between' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  checkCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  heading: { color: colors.text, fontSize: font.title, fontWeight: '800' },
  para: { color: colors.textMuted, fontSize: font.body, textAlign: 'center', lineHeight: 24, paddingHorizontal: space.md },
  stats: { alignSelf: 'stretch', marginTop: space.lg, gap: space.sm },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
  },
  statLabel: { color: colors.textMuted, fontSize: font.body },
  statValue: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  button: { backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center' },
  pressed: { opacity: 0.8 },
  buttonText: { color: colors.accentText, fontSize: font.body, fontWeight: '700' },
});
