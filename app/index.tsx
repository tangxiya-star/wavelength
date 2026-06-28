import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ADMIN_URL, api, IS_MOCK } from '../lib/api';
import { useSession } from '../lib/session';
import { colors, font, radius, space } from '../lib/theme';

export default function AccessCodeScreen() {
  const { setAccessCode, beginSession, reset } = useSession();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onContinue = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      reset();
      const res = await api.validateCode(trimmed);
      if (!res.ok) {
        setError('That access code isn’t valid.');
        setLoading(false);
        return;
      }
      // Valid code → start the session and drop straight into the feed.
      const info = { code: trimmed.toUpperCase(), sessionMinutes: res.sessionMinutes, condition: res.condition };
      setAccessCode(info);
      const started = await beginSession(
        { ageBand: '', sexAtBirth: '', genderIdentity: '', dailyShortformUse: '', consent18Plus: true },
        info,
      );
      if (started) {
        router.replace('/feed');
      } else {
        setError('Could not start the session. Please try again.');
        setLoading(false);
      }
    } catch {
      setError('Could not reach the server. Check your connection.');
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.brand}>◆ Testing</Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>Enter your access code</Text>
            <TextInput
              value={code}
              onChangeText={(t) => setCode(t.toUpperCase())}
              placeholder="ACCESS CODE"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.input}
              onSubmitEditing={onContinue}
              returnKeyType="go"
              editable={!loading}
            />
            {error && <Text style={styles.error}>{error}</Text>}

            <Pressable
              onPress={onContinue}
              disabled={loading || !code.trim()}
              style={({ pressed }) => [styles.button, (loading || !code.trim()) && styles.buttonDisabled, pressed && styles.pressed]}
            >
              {loading ? <ActivityIndicator color={colors.accentText} /> : <Text style={styles.buttonText}>Continue</Text>}
            </Pressable>

            {IS_MOCK && <Text style={styles.hint}>Demo mode — try DEMO, FLOW05, or QUICK2</Text>}
          </View>

          <Text style={styles.footer}>Invalid code? Contact the study coordinator.</Text>
          <Pressable onPress={() => Linking.openURL(ADMIN_URL).catch(() => {})} hitSlop={8}>
            <Text style={styles.adminLink}>Admin dashboard ↗</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  container: { flex: 1, paddingHorizontal: space.lg, justifyContent: 'center', gap: space.xl },
  header: { alignItems: 'center', gap: space.xs },
  brand: { color: colors.text, fontSize: font.title, fontWeight: '800', letterSpacing: 0.5 },
  sub: { color: colors.textMuted, fontSize: font.heading, fontWeight: '500' },
  form: { gap: space.md },
  label: { color: colors.text, fontSize: font.body, textAlign: 'center' },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: font.heading,
    letterSpacing: 4,
    textAlign: 'center',
    paddingVertical: space.md,
  },
  error: { color: colors.danger, fontSize: font.small, textAlign: 'center' },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
  buttonText: { color: colors.accentText, fontSize: font.body, fontWeight: '700' },
  hint: { color: colors.textFaint, fontSize: font.small, textAlign: 'center' },
  footer: { color: colors.textFaint, fontSize: font.small, textAlign: 'center' },
  adminLink: { color: colors.accent, fontSize: font.small, textAlign: 'center', marginTop: space.sm, fontWeight: '600' },
});
