"use client";
// Screen 2 — Session log: per-video cards + chat/decode (Holly owns the chat API).
import { useEffect, useState } from "react";
import { getVideos } from "@/lib/api";
import type { Video } from "@/lib/types";
import VideoCard from "@/components/VideoCard";
import { demoInterest, demoNote } from "@/lib/demo";

export default function LogPage() {
  const [videos, setVideos] = useState<Video[]>([]);

  useEffect(() => {
    getVideos().then(setVideos);
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <div className="flex items-center gap-2 text-sm text-neutral-400">
        Session log
        <span className="flex items-center gap-1 text-xs text-green-400">
          <span className="rec-dot h-1.5 w-1.5 rounded-full bg-green-400" /> streaming
        </span>
      </div>

      {videos.map((v) => (
        <VideoCard
          key={v.video_id}
          video={v}
          interest={demoInterest[v.video_id]}
          note={demoNote[v.video_id]}
        />
      ))}

      {/* TODO(Holly): wire "ask" -> /api/decode (OpenAI), stream reply into the targeted card */}
      <div className="sticky bottom-4 flex gap-2 pt-2">
        <input
          className="flex-1 rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm outline-none focus:border-neutral-500"
          placeholder="ask: why did video 1 win?"
        />
        <button className="rounded-xl bg-neutral-100 px-4 text-neutral-900 hover:bg-white">↑</button>
      </div>
    </div>
  );
}
