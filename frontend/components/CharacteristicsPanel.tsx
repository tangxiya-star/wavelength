"use client";
import type { RefObject } from "react";
import type { Video } from "@/lib/types";
import MovieBarcode from "./MovieBarcode";

// The 5-field characteristics panel (Screen 1). color_profile is extracted client-side,
// live, as a movie-barcode strip from the REAL playing video (via videoRef).
export default function CharacteristicsPanel({
  video,
  videoRef,
}: {
  video: Video;
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  const c = video.characteristics;
  return (
    <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-xs">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">characteristics</div>
      <div className="reveal flex items-center gap-2.5" style={{ animationDelay: "0ms" }}>
        <span className="w-10 shrink-0 text-neutral-500">color</span>
        <MovieBarcode videoRef={videoRef} seed={video.video_id} height={18} />
      </div>
      <Row label="cuts" delay={140}><span className="tabular-nums">{c.cut_count}</span></Row>
      <Row label="audio" delay={280}>{c.audio}</Row>
      <Row label="subs" delay={420}>{c.subtitles ? "yes" : "no"}</Row>
    </div>
  );
}

function Row({ label, children, delay = 0 }: { label: string; children: React.ReactNode; delay?: number }) {
  return (
    <div className="reveal flex items-center gap-2.5" style={{ animationDelay: `${delay}ms` }}>
      <span className="w-10 shrink-0 text-neutral-500">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}
