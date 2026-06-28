"use client";
// Reusable 0–1 interest meter (the ▮▮▮▮▮▮▮▯▯ bar from the mockups).

export default function InterestBar({ value, className = "" }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className={`inline-block h-2 overflow-hidden rounded-full bg-neutral-800 ${className}`}>
      <span
        className="block h-full rounded-full bg-gradient-to-r from-green-500 to-green-300"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
