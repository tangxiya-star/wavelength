// Small, dependency-light icon set drawn with react-native-svg (Feather-style
// line icons). Renders identically on web + native — no icon fonts to load.

import type { ReactNode } from 'react';
import Svg, { Circle, Line, Path, Polygon, Polyline } from 'react-native-svg';

export interface IconProps {
  size?: number;
  color?: string;
  fill?: string;
  strokeWidth?: number;
}

function Base({ size = 24, color = '#fff', fill = 'none', strokeWidth = 2, children }: IconProps & { children: ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </Svg>
  );
}

export function ThumbsUp(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z" />
      <Path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </Base>
  );
}

export function ThumbsDown(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3z" />
      <Path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
    </Base>
  );
}

export function Bookmark(p: IconProps) {
  return (
    <Base {...p}>
      <Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </Base>
  );
}

export function MoreHorizontal(p: IconProps) {
  const c = p.color ?? '#fff';
  return (
    <Base {...p} fill={c}>
      <Circle cx="12" cy="12" r="1.6" stroke="none" />
      <Circle cx="5" cy="12" r="1.6" stroke="none" />
      <Circle cx="19" cy="12" r="1.6" stroke="none" />
    </Base>
  );
}

export function VolumeOn(p: IconProps) {
  return (
    <Base {...p}>
      <Polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <Path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </Base>
  );
}

export function VolumeOff(p: IconProps) {
  return (
    <Base {...p}>
      <Polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <Line x1="23" y1="9" x2="17" y2="15" />
      <Line x1="17" y1="9" x2="23" y2="15" />
    </Base>
  );
}

export function Check(p: IconProps) {
  return (
    <Base {...p}>
      <Polyline points="20 6 9 17 4 12" />
    </Base>
  );
}

export function Close(p: IconProps) {
  return (
    <Base {...p}>
      <Line x1="18" y1="6" x2="6" y2="18" />
      <Line x1="6" y1="6" x2="18" y2="18" />
    </Base>
  );
}
