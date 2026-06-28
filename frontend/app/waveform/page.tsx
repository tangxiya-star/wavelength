"use client";
// Focused single-exposure preview — loads waveform-third-exposure.json (the
// OpenAI Codex exposure, e10 segment @ 32.681s) and draws its EEG waveform with
// the SAME design as the /replay scroll feed. Use this to view + iterate on the
// wave SVG design in isolation; the look lives in components/ExposureWaveform.tsx.
import { useEffect, useMemo, useRef, useState } from "react";
import { ExposureWaveform, durationFor, samplesUntil, type ReplaySample } from "@/components/ExposureWaveform";

interface Exposure {
  title: string;
  durationMs: number;
  watchMs: number;
  samples: ReplaySample[];
}

export default function WaveformPreviewPage() {
  const [exposure, setExposure] = useState<Exposure | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef(0);

  useEffect(() => {
    fetch("/waveform-third-exposure.json")
      .then((res) => res.json() as Promise<Exposure>)
      .then(setExposure)
      .catch((error) => console.warn("[waveform] could not load exposure", error));
  }, []);

  const durationMs = useMemo(
    () => durationFor(exposure ? { dwellMs: exposure.watchMs, samples: exposure.samples } : undefined),
    [exposure],
  );

  // draw-in loop: sweep 0 -> durationMs, hold a beat, then restart
  useEffect(() => {
    if (!exposure) return;
    startedAtRef.current = performance.now();
    let frame = 0;
    const tick = () => {
      const t = performance.now() - startedAtRef.current;
      if (t >= durationMs + 1200) startedAtRef.current = performance.now();
      setElapsedMs(Math.min(t, durationMs));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [exposure, durationMs]);

  const samples = exposure ? samplesUntil(exposure.samples, elapsedMs, durationMs) : [];

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-black px-8">
      <div className="w-full max-w-[1600px]">
        <div className="text-[11px] uppercase tracking-[0.24em] text-neutral-500">single-exposure preview</div>
        <div className="mt-1 text-lg font-medium text-neutral-200">{exposure?.title ?? "loading…"}</div>
      </div>

      <ExposureWaveform durationMs={durationMs} sourceSamples={exposure?.samples ?? []} samples={samples} />

      <div className="flex w-full max-w-[1600px] items-center justify-between text-xs tabular-nums text-neutral-500">
        <span>{(elapsedMs / 1000).toFixed(1)}s / {(durationMs / 1000).toFixed(1)}s</span>
        <button
          onClick={() => (startedAtRef.current = performance.now())}
          className="rounded-full border border-neutral-700 px-3 py-1 text-neutral-300 hover:border-neutral-500"
        >
          replay ↺
        </button>
      </div>
    </div>
  );
}
