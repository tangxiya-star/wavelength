"use client";
// Session-log card (Screen 2): characteristics + interest + LLM one-liner.
import type { Video } from "@/lib/types";
import ColorBar from "./ColorBar";
import InterestBar from "./InterestBar";
import colorProfiles from "@/public/color-profiles.json";

export default function VideoCard({ video, interest, note }: {
  video: Video;
  interest?: number;
  note?: string; // from the chat/decode API
}) {
  const colors = (colorProfiles as Record<string, string[]>)[video.video_id] ?? [];
  const title = video.characteristics.transcript_summary.split("—")[0].slice(0, 44).trim();
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-9 shrink-0 items-center justify-center rounded bg-neutral-800 text-neutral-500">▣</div>
          <div>
            <div className="text-sm font-medium leading-tight">{title}…</div>
            <div className="text-xs text-neutral-500">{video.metadata.creator}</div>
          </div>
        </div>
        <ColorBar colors={colors} />
      </div>
      <div className="mt-3 flex items-center gap-3 text-xs text-neutral-400">
        <span className="tabular-nums">interest {interest?.toFixed(2) ?? "—"}</span>
        <InterestBar value={interest ?? 0} className="w-40" />
      </div>
      <p className="mt-2 text-sm text-neutral-300">
        <span className="text-neutral-500">↳</span> {note ?? <span className="text-neutral-600">decode pending — wire the chat API</span>}
      </p>
    </div>
  );
}
