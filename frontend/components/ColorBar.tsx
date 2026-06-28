"use client";
// Renders the per-scene average-color bar. Colors come from Holly's client-side
// extraction (scripts/extract-color.mjs), keyed by video_id — NOT from Devan.

export default function ColorBar({ colors }: { colors: string[] }) {
  if (!colors?.length) return <span className="text-neutral-600">—</span>;
  return (
    <span className="inline-flex h-3 w-32 overflow-hidden rounded">
      {colors.map((c, i) => (
        <span key={i} style={{ background: c }} className="flex-1" />
      ))}
    </span>
  );
}
