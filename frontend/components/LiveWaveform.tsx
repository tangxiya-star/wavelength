"use client";
// Rolling LIVE EEG waveform — the hero of the /monitor live demo. Same visual
// language as components/ExposureWaveform (white line on black, faint grid,
// Catmull-Rom smoothing) but instead of drawing a fixed-duration exposure in,
// it scrolls a wall-clock time window right→left so the newest sample is always
// pinned at the right edge. Drives itself off an internal rAF loop so the line
// keeps gliding smoothly between the ~10 Hz recorder ticks.
import { useEffect, useRef, useState } from "react";

const WIDTH = 1600;
const HEIGHT = 260;
const TOP = 24;
const BOTTOM = HEIGHT - 24;
const PUSH_MS = 40; // append a buffer point ~25 Hz (render is per-frame)

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function smoothPath(points: Array<{ x: number; y: number }>) {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} L ${points[1].x.toFixed(1)} ${points[1].y.toFixed(1)}`;
  }
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/** `value` = latest interest (0-1). `live` gates whether new points are appended
 *  (when the feed drops, the trace simply scrolls off to the left). */
export default function LiveWaveform({
  value,
  live,
  windowMs = 18000,
}: {
  value: number;
  live: boolean;
  windowMs?: number;
}) {
  // refs so the rAF loop always reads the freshest props without re-subscribing
  const latestRef = useRef(value);
  latestRef.current = value;
  const liveRef = useRef(live);
  liveRef.current = live;

  const bufRef = useRef<Array<{ t: number; v: number }>>([]);
  const [, force] = useState(0);

  useEffect(() => {
    let raf = 0;
    let lastPush = 0;
    const loop = () => {
      const now = performance.now();
      const buf = bufRef.current;
      if (liveRef.current && now - lastPush >= PUSH_MS) {
        lastPush = now;
        buf.push({ t: now, v: clamp(latestRef.current, 0, 1) });
      }
      const cutoff = now - windowMs - 500;
      while (buf.length && buf[0].t < cutoff) buf.shift();
      force((f) => (f + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [windowMs]);

  const now = performance.now();
  const x = (t: number) => ((t - (now - windowMs)) / windowMs) * WIDTH;
  const y = (v: number) => BOTTOM - clamp(v, 0, 1) * (BOTTOM - TOP);

  const points = bufRef.current
    .filter((p) => p.t >= now - windowMs - 200)
    .map((p) => ({ x: x(p.t), y: y(p.v) }));
  const path = smoothPath(points);
  const head = points.length ? points[points.length - 1] : null;

  return (
    <div className="h-[260px] w-full max-w-[1600px] border border-white/70 bg-black">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-full w-full" preserveAspectRatio="none">
        {Array.from({ length: 6 }).map((_, index) => (
          <line
            key={`h-${index}`}
            x1="0"
            x2={WIDTH}
            y1={(index / 5) * HEIGHT}
            y2={(index / 5) * HEIGHT}
            stroke="rgba(255,255,255,0.10)"
          />
        ))}
        {Array.from({ length: 16 }).map((_, index) => (
          <line
            key={`v-${index}`}
            x1={(index / 15) * WIDTH}
            x2={(index / 15) * WIDTH}
            y1="0"
            y2={HEIGHT}
            stroke="rgba(255,255,255,0.08)"
          />
        ))}

        {path ? (
          <path
            d={path}
            fill="none"
            stroke="#ffffff"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={live ? 1 : 0.4}
          />
        ) : null}

        {head && live ? (
          <circle cx={head.x} cy={head.y} r="6" fill="#ffffff">
            <animate attributeName="r" values="5;9;5" dur="1.2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="1;0.5;1" dur="1.2s" repeatCount="indefinite" />
          </circle>
        ) : null}
      </svg>
    </div>
  );
}
