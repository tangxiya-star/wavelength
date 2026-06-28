"use client";
// Live interest waveform — the most-watched element on stage.
// A single clean white line drawn against the full duration of the clip: the
// x-axis is the whole video timeline (0 → duration), so the line animates in
// from left to right as playback advances and fills the chart by the end.
// Width is measured from the container (ResizeObserver) so the chart fills the
// full grid width crisply at any size.
import { useEffect, useRef, useState } from "react";
import type { EegSample } from "@/lib/types";
import type { PredictedCurve } from "@/lib/predict";

const H = 220;
const LEFT = 34; // y-axis gutter for ratio tick labels
const RIGHT = 16;
const TOP = 20; // small reserved band so the leading dot/halo never clips
const BOTTOM = 22; // x-axis gutter for time tick labels
const NY = 4; // horizontal gridlines
const NX = 6; // vertical gridlines (full-duration time axis)

function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function Waveform({
  samples,
  durationMs,
  live = true,
  curve,
}: {
  samples: EegSample[];
  durationMs?: number;
  live?: boolean;
  curve?: PredictedCurve | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(1000);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Before the clip plays there's no signal yet — we still render the full grid
  // + axes so the feature reads as "live monitor, armed".
  const hasData = live && samples.length >= 2;
  const lastSample = samples.length ? samples[samples.length - 1] : undefined;

  // x-axis spans the full clip duration so the line draws across the whole
  // timeline as it plays. Fall back to the last sample time, then 1s.
  const lastT = lastSample?.video_t_ms ?? 0;
  const span = Math.max(durationMs || 0, lastT, 1000);

  // The predicted curve is drawn immediately (so the wave is visible before the
  // clip plays); the live samples overlay on top once they stream in.
  const hasCurve = !!(curve && curve.t.length >= 2);

  // y auto-scale from whatever signal we have — union of the predicted curve and
  // the live samples — with a minimum visual span + padding. Default 0..1 before
  // any data. Loop (not Math.min(...real)) — the sample buffer holds up to 4000
  // points and a spread that wide can overflow the call stack.
  let lo = Infinity;
  let hi = -Infinity;
  if (hasCurve) {
    for (const v of curve!.interest) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (hasData) {
    for (const s of samples) {
      const v = s.interest_score;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (hi - lo < 0.25) {
    const c = (hi + lo) / 2;
    lo = c - 0.125;
    hi = c + 0.125;
  }
  const pad = hasCurve || hasData ? (hi - lo) * 0.15 : 0;
  const min = lo - pad;
  const max = hi + pad;
  const range = max - min || 1;

  const X = (tMs: number) => LEFT + (Math.min(Math.max(tMs, 0), span) / span) * (W - LEFT - RIGHT);
  const Y = (v: number) => H - BOTTOM - ((v - min) / range) * (H - BOTTOM - TOP);

  // Decimate to at most ~1 point per horizontal pixel — drawing all 4000 buffer
  // points into one polyline is invisible detail the screen can't resolve and
  // re-parses a huge string every frame. Always keep the last (head) point.
  const plotW = Math.max(1, W - LEFT - RIGHT);
  const stride = Math.max(1, Math.ceil(samples.length / plotW));
  const pts: string[] = [];
  for (let i = 0; i < samples.length; i += stride) {
    const s = samples[i];
    pts.push(`${X(s.video_t_ms).toFixed(1)},${Y(s.interest_score).toFixed(1)}`);
  }
  if (lastSample && (samples.length - 1) % stride !== 0) {
    pts.push(`${X(lastSample.video_t_ms).toFixed(1)},${Y(lastSample.interest_score).toFixed(1)}`);
  }
  const realLine = pts.join(" ");

  // predicted curve across the full timeline — drawn from the model's per-0.5s
  // interest so the wave is on screen the moment a clip loads.
  const predLine = hasCurve
    ? curve!.t.map((t, i) => `${X(t * 1000).toFixed(1)},${Y(curve!.interest[i]).toFixed(1)}`).join(" ")
    : "";

  const yTicks = Array.from({ length: NY + 1 }, (_, k) => {
    const v = min + (k / NY) * range;
    return { v, y: Y(v) };
  });
  const xTicks = Array.from({ length: NX + 1 }, (_, k) => {
    const frac = k / NX;
    return { x: LEFT + frac * (W - LEFT - RIGHT), t: frac * span };
  });

  const headX = X(lastT);
  const headY = Y(lastSample?.interest_score ?? 0);

  return (
    <div ref={ref} className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        className="h-[220px] w-full rounded-xl border border-neutral-800 bg-neutral-900/60"
      >
        <g>
          {yTicks.map((t, k) => (
            <g key={`y${k}`}>
              <line x1={LEFT} y1={t.y} x2={W - RIGHT} y2={t.y} stroke="#ffffff" strokeOpacity="0.06" strokeWidth="1" />
              <text x={LEFT - 5} y={t.y + 3} fill="#64748b" fontSize="9" textAnchor="end">
                {t.v.toFixed(2)}
              </text>
            </g>
          ))}
          {xTicks.map((t, k) => (
            <g key={`x${k}`}>
              <line x1={t.x} y1={TOP} x2={t.x} y2={H - BOTTOM} stroke="#ffffff" strokeOpacity="0.05" strokeWidth="1" />
              <text
                x={t.x}
                y={H - BOTTOM + 13}
                fill="#64748b"
                fontSize="9"
                textAnchor={k === 0 ? "start" : k === NX ? "end" : "middle"}
              >
                {clock(t.t)}
              </text>
            </g>
          ))}
        </g>

        {hasCurve && (
          <polyline
            points={predLine}
            fill="none"
            stroke="#9fe9ff"
            strokeOpacity={hasData ? 0.4 : 0.9}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {hasData && (
          <>
            <polyline
              className="wf-draw"
              points={realLine}
              pathLength={1}
              fill="none"
              stroke="#ffffff"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            <circle cx={headX} cy={headY} r="3.5" fill="#ffffff">
              <animate attributeName="r" values="3;5.5;3" dur="1.2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="1;0.55;1" dur="1.2s" repeatCount="indefinite" />
            </circle>
          </>
        )}
      </svg>
    </div>
  );
}
