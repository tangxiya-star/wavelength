// Minimal design tokens for a clean, native, dark feed UI.

export const colors = {
  bg: '#0A0A0B',
  surface: '#161618',
  surfaceElevated: '#1F1F23',
  border: '#2A2A2E',
  text: '#FFFFFF',
  textMuted: '#9A9AA2',
  textFaint: '#6B6B72',
  accent: '#5B8DEF',
  accentText: '#FFFFFF',
  up: '#3DD68C',
  down: '#F2555A',
  save: '#F5C542',
  danger: '#F2555A',
  recording: '#F2555A',
  scrim: 'rgba(0,0,0,0.55)',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

export const font = {
  title: 28,
  heading: 20,
  body: 16,
  small: 13,
  tiny: 11,
} as const;
