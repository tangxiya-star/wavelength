"use client";
// Live "movie barcode" — appends one vertical stripe per tick, building the
// classic film-palette strip in real time (prd-holly: color_profile is extracted
// client-side, keyed by video_id — NOT precomputed by Devan).
//
// Source priority per stripe:
//   1. If a <video> is playing and its frames are readable, the stripe is the
//      AVERAGE color of the current frame (true real-time extraction).
//   2. Otherwise (mock placeholder / cross-origin-tainted frame) the stripe is
//      SYNTHESIZED as an evolving film palette — warm neutrals with the
//      occasional cool accent — so the strip is always live, never static.
import { useEffect, useState, type RefObject } from "react";

const MAX = 200; // stripes kept on screen (older ones scroll off the left)
const TICK = 120; // ms per stripe

export default function MovieBarcode({
  videoRef,
  seed,
  height = 44,
  className = "",
}: {
  videoRef?: RefObject<HTMLVideoElement | null>;
  seed?: string;
  height?: number;
  className?: string;
}) {
  const [stripes, setStripes] = useState<string[]>([]);

  useEffect(() => {
    setStripes([]); // reset when the source clip changes
    let cancelled = false;

    // tiny offscreen canvas for frame sampling
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    // Sample the REAL current video frame's average color. Returns null if the
    // video isn't playing/decodable yet — we never synthesize fake colors.
    const sampleVideo = (): string | null => {
      const v = videoRef?.current;
      if (!v || v.paused || v.readyState < 2 || v.videoWidth === 0 || !ctx) return null;
      try {
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let r = 0, g = 0, b = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        return enhance(r / n, g / n, b / n);
      } catch {
        return null; // tainted canvas (cross-origin frame)
      }
    };

    const id = setInterval(() => {
      if (cancelled) return;
      const color = sampleVideo();
      if (!color) return; // only real frames; nothing until the clip plays
      setStripes((prev) => {
        const next = prev.length >= MAX ? prev.slice(prev.length - MAX + 1) : prev.slice();
        next.push(color);
        return next;
      });
    }, TICK);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [videoRef, seed]);

  return (
    <div
      className={`flex w-full overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 ${className}`}
      style={{ height }}
    >
      {stripes.length === 0 ? (
        <div className="flex w-full items-center justify-center text-[10px] text-neutral-600">extracting palette…</div>
      ) : (
        stripes.map((c, i) => <div key={i} className="h-full flex-1" style={{ background: c }} />)
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

// Gently lift the real frame color so brightness/cut variation is visible,
// while keeping the actual hue — it should look like the clip, not a rainbow.
function enhance(r: number, g: number, b: number): string {
  const [h, s, l] = rgb2hsl(r, g, b);
  const s2 = clamp(s * 1.5, 0, 1); // mild saturation lift, true hue
  const l2 = clamp(0.5 + (l - 0.5) * 1.3, 0.03, 0.97); // mild contrast stretch
  const [rr, gg, bb] = hsl2rgb(h, s2, l2);
  return `rgb(${rr} ${gg} ${bb})`;
}

function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
