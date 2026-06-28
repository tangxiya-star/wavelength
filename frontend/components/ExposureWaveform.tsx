"use client";
// The scrolling EEG-waveform design, shared by the /replay scroll feed and the
// focused /waveform single-exposure preview. This is the single source of truth
// for the wave SVG look — edit the design here and both surfaces update (it is
// also the design that gets ported into the HyperFrames e10 composition).

export interface ReplaySample {
  tMs: number;
  interest: number;
}

export interface ReplayItem {
  exposureId: string;
  dwellMs: number;
  samples: ReplaySample[];
}

export function durationFor(item?: { dwellMs: number; samples: ReplaySample[] }) {
  if (!item) return 1000;
  const lastSampleMs = item.samples.at(-1)?.tMs ?? 0;
  return Math.max(1000, Math.min(item.dwellMs, lastSampleMs + 500));
}

/** The set of points revealed up to `elapsedMs` — drives the draw-in animation. */
export function samplesUntil(samples: ReplaySample[], elapsedMs: number, durationMs: number) {
  const endMs = Math.min(elapsedMs, durationMs);
  const frameStepMs = 1000 / 60;
  const visible: ReplaySample[] = [];

  for (let tMs = 0; tMs < endMs; tMs += frameStepMs) {
    visible.push({ tMs, interest: sampleAt(samples, tMs) });
  }

  if (endMs > 0) {
    visible.push({ tMs: endMs, interest: sampleAt(samples, endMs) });
  }

  return smoothSamples(visible);
}

function sampleAt(samples: ReplaySample[], tMs: number) {
  if (!samples.length) return 0.5;
  if (tMs <= samples[0].tMs) return samples[0].interest;
  const last = samples.at(-1);
  if (!last || tMs >= last.tMs) return last?.interest ?? 0.5;

  const nextIndex = samples.findIndex((sample) => sample.tMs >= tMs);
  const previous = samples[Math.max(0, nextIndex - 1)];
  const next = samples[nextIndex];
  const span = next.tMs - previous.tMs || 1;
  const rawProgress = (tMs - previous.tMs) / span;
  const progress = rawProgress * rawProgress * (3 - 2 * rawProgress);
  return previous.interest + (next.interest - previous.interest) * progress;
}

function smoothSamples(samples: ReplaySample[]) {
  const pass = samples.map((sample, index) => {
    const before2 = samples[Math.max(0, index - 2)]?.interest ?? sample.interest;
    const before1 = samples[Math.max(0, index - 1)]?.interest ?? sample.interest;
    const after1 = samples[Math.min(samples.length - 1, index + 1)]?.interest ?? sample.interest;
    const after2 = samples[Math.min(samples.length - 1, index + 2)]?.interest ?? sample.interest;
    return {
      tMs: sample.tMs,
      interest: before2 * 0.08 + before1 * 0.22 + sample.interest * 0.4 + after1 * 0.22 + after2 * 0.08,
    };
  });

  let previous = pass[0]?.interest ?? 0.5;
  return pass.map((sample) => {
    previous = previous * 0.82 + sample.interest * 0.18;
    return { tMs: sample.tMs, interest: previous };
  });
}

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

export function ExposureWaveform({
  durationMs,
  sourceSamples,
  samples,
}: {
  durationMs: number;
  sourceSamples: ReplaySample[];
  samples: ReplaySample[];
}) {
  const width = 1600;
  const height = 260;
  const topLimit = 21;
  const bottomLimit = height - 21;
  const startY = height * 0.68;
  const startInterest = sourceSamples[0]?.interest ?? 0.5;
  const positiveRange = Math.max(0.08, ...sourceSamples.map((sample) => sample.interest - startInterest));
  const negativeRange = Math.max(0.08, ...sourceSamples.map((sample) => startInterest - sample.interest));
  const yScale = Math.min((startY - topLimit) / positiveRange, (bottomLimit - startY) / negativeRange);

  const points = samples.map((sample) => ({
    x: (sample.tMs / durationMs) * width,
    y: clamp(startY - (sample.interest - startInterest) * yScale, topLimit, bottomLimit),
  }));
  const path = smoothPath(points);

  return (
    <div className="h-[260px] w-full max-w-[1600px] border border-white/70 bg-black">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" preserveAspectRatio="none">
        {Array.from({ length: 6 }).map((_, index) => (
          <line
            key={`h-${index}`}
            x1="0"
            x2={width}
            y1={(index / 5) * height}
            y2={(index / 5) * height}
            stroke="rgba(255,255,255,0.10)"
          />
        ))}
        {Array.from({ length: 16 }).map((_, index) => (
          <line
            key={`v-${index}`}
            x1={(index / 15) * width}
            x2={(index / 15) * width}
            y1="0"
            y2={height}
            stroke="rgba(255,255,255,0.08)"
          />
        ))}
        {path ? (
          <path d={path} fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        ) : null}
      </svg>
    </div>
  );
}
