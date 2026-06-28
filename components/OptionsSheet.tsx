// Options (...) bottom sheet — video metadata + end-session (double confirm).

import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, space } from '../lib/theme';
import type { Video } from '../lib/types';
import { Close } from './icons';

interface Props {
  visible: boolean;
  video: Video | null;
  feedPosition: number | null;
  onClose: () => void;
  onEndSession: () => void;
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export function OptionsSheet({ visible, video, feedPosition, onClose, onEndSession }: Props) {
  const [confirming, setConfirming] = useState(false);

  // Reset the confirm step whenever the sheet opens/closes.
  useEffect(() => {
    if (!visible) setConfirming(false);
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grabber} />
          {video && (
            <>
              <Text style={styles.title}>{video.title}</Text>
              <View style={styles.rows}>
                <Row label="Type" value={video.contentType} />
                <Row label="Length" value={fmtDuration(video.durationSeconds)} />
                <Row label="Clip ID" value={video.slug} />
                <Row label="Position" value={feedPosition !== null ? `#${feedPosition + 1} in feed` : '—'} />
              </View>
            </>
          )}

          {!confirming ? (
            <Pressable style={styles.endBtn} onPress={() => setConfirming(true)} accessibilityRole="button">
              <Text style={styles.endText}>End session</Text>
            </Pressable>
          ) : (
            <View style={styles.confirmBox}>
              <Text style={styles.confirmTitle}>End your session now?</Text>
              <Text style={styles.confirmMsg}>This can’t be undone. Your responses are already saved.</Text>
              <Pressable style={styles.endConfirmBtn} onPress={onEndSession} accessibilityRole="button">
                <Text style={styles.endConfirmText}>Yes, end session</Text>
              </Pressable>
              <Pressable style={styles.keepBtn} onPress={() => setConfirming(false)} accessibilityRole="button">
                <Text style={styles.keepText}>Keep watching</Text>
              </Pressable>
            </View>
          )}

          <Pressable style={styles.closeBtn} onPress={onClose} accessibilityRole="button">
            <Close size={18} color={colors.text} />
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surfaceElevated,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xl,
    gap: space.md,
  },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: radius.pill, backgroundColor: colors.border, marginBottom: space.sm },
  title: { color: colors.text, fontSize: font.heading, fontWeight: '700' },
  rows: { gap: space.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { color: colors.textMuted, fontSize: font.body },
  rowValue: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  endBtn: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  endText: { color: colors.danger, fontSize: font.body, fontWeight: '700' },
  confirmBox: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  confirmTitle: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  confirmMsg: { color: colors.textMuted, fontSize: font.small, lineHeight: 18 },
  endConfirmBtn: { backgroundColor: colors.danger, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: space.xs },
  endConfirmText: { color: '#fff', fontSize: font.body, fontWeight: '700' },
  keepBtn: { paddingVertical: space.sm, alignItems: 'center' },
  keepText: { color: colors.textMuted, fontSize: font.body, fontWeight: '600' },
  closeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: space.md,
    marginTop: space.sm,
  },
  closeText: { color: colors.text, fontSize: font.body, fontWeight: '600' },
});
