"use client";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";

const FALL = { durationMs: 2360 };
const SLICES = [
  { left: 7, size: 54, delay: 0, duration: 1320, drift: -22, start: -16, end: 126 },
  { left: 15, size: 92, delay: 90, duration: 1610, drift: 28, start: 12, end: 224 },
  { left: 23, size: 66, delay: 210, duration: 1420, drift: -14, start: -38, end: 176 },
  { left: 31, size: 112, delay: 35, duration: 1760, drift: 36, start: 28, end: 252 },
  { left: 39, size: 48, delay: 310, duration: 1240, drift: -30, start: 44, end: 188 },
  { left: 47, size: 82, delay: 150, duration: 1560, drift: 18, start: -8, end: 214 },
  { left: 55, size: 126, delay: 260, duration: 1880, drift: -40, start: -24, end: 268 },
  { left: 63, size: 62, delay: 70, duration: 1380, drift: 22, start: 36, end: 196 },
  { left: 71, size: 98, delay: 360, duration: 1660, drift: -18, start: -48, end: 232 },
  { left: 79, size: 58, delay: 190, duration: 1350, drift: 32, start: 18, end: 162 },
  { left: 87, size: 116, delay: 115, duration: 1820, drift: -34, start: 52, end: 282 },
  { left: 94, size: 72, delay: 285, duration: 1480, drift: 16, start: -30, end: 204 },
];

export default function OrangeSliceWaterfall({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(active);
  const [wave, setWave] = useState(0);

  useEffect(() => {
    if (active) {
      setVisible(true);
      setWave((n) => n + 1);
      const t = window.setTimeout(() => setVisible(false), FALL.durationMs + 120);
      return () => window.clearTimeout(t);
    }

    const t = window.setTimeout(() => setVisible(false), 620);
    return () => window.clearTimeout(t);
  }, [active]);

  if (!visible) return null;

  return (
    <div
      key={wave}
      className={`orange-slice-waterfall ${active ? "orange-slice-waterfall--active" : "orange-slice-waterfall--exit"}`}
      aria-hidden="true"
    >
      {SLICES.map((slice, i) => (
        <span
          key={i}
          className="orange-slice-waterfall__slice"
          style={{
            left: `${slice.left}%`,
            width: slice.size,
            height: slice.size,
            animationDelay: `${slice.delay}ms`,
            animationDuration: `${slice.duration}ms`,
            "--orange-drift": `${slice.drift}px`,
            "--orange-start-rotate": `${slice.start}deg`,
            "--orange-mid-rotate": `${Math.round((slice.start + slice.end) / 2)}deg`,
            "--orange-end-rotate": `${slice.end}deg`,
          } as CSSProperties}
        >
          <img src="/orange-slice.svg" alt="" draggable={false} />
        </span>
      ))}
    </div>
  );
}
