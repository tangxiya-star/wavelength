// Right-side action rail: thumbs up / down / save / options (SPEC §3.4).
// Thumbs are mutually exclusive and toggleable.

import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, space } from '../lib/theme';
import { Bookmark, type IconProps, MoreHorizontal, ThumbsDown, ThumbsUp } from './icons';

export type Thumb = 'up' | 'down' | null;

interface Props {
  thumb: Thumb;
  saved: boolean;
  onThumbUp: () => void;
  onThumbDown: () => void;
  onSave: () => void;
  onOptions: () => void;
}

function tap() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

function RailButton({
  Icon,
  label,
  active,
  activeColor,
  onPress,
}: {
  Icon: (p: IconProps) => ReactNode;
  label: string;
  active: boolean;
  activeColor: string;
  onPress: () => void;
}) {
  const color = active ? activeColor : colors.text;
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon size={32} color={color} fill={active ? activeColor : 'none'} />
      <Text style={[styles.label, active && { color: activeColor }]}>{label}</Text>
    </Pressable>
  );
}

export function ActionRail({ thumb, saved, onThumbUp, onThumbDown, onSave, onOptions }: Props) {
  return (
    <View style={styles.rail}>
      <RailButton Icon={ThumbsUp} label="Like" active={thumb === 'up'} activeColor={colors.up} onPress={onThumbUp} />
      <RailButton Icon={ThumbsDown} label="Dislike" active={thumb === 'down'} activeColor={colors.down} onPress={onThumbDown} />
      <RailButton Icon={Bookmark} label="Save" active={saved} activeColor={colors.save} onPress={onSave} />
      <RailButton Icon={MoreHorizontal} label="More" active={false} activeColor={colors.text} onPress={onOptions} />
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    alignItems: 'center',
    gap: space.lg,
  },
  button: {
    alignItems: 'center',
    gap: space.xs,
  },
  pressed: {
    opacity: 0.6,
    transform: [{ scale: 0.92 }],
  },
  label: {
    color: colors.text,
    fontSize: font.tiny,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 3,
  },
});
