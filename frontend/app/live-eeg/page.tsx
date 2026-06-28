"use client";
// /live-eeg — the REAL live demo. Same UI as /live (video stage + analyst chat +
// characteristics) but the bottom waveform is the wearer's ACTUAL brain signal,
// streamed from the headset recorder (hardware/capture/record.py → /api/eeg-live)
// via <LiveEegWaveform>, instead of /live's M2 content→EEG prediction.
//
// Built for the live-demo instance on :5678 (npm run dev:live). The recorder must
// be up on :8090; the waveform streams continuously while connected (not gated on
// clip playback). The M2 curve is still fetched, but only for the chat peak hint.
import { useEffect, useRef, useState } from "react";
import { getPredictedCurve, type PredictedCurve } from "@/lib/predict";
import type { Video } from "@/lib/types";
import CharacteristicsPanel from "@/components/CharacteristicsPanel";
import UploadClipButton from "@/components/UploadClipButton";
import ClipChat, { type ClipChatMode } from "@/components/ClipChat";
import OrangeSliceWaterfall from "@/components/OrangeSliceWaterfall";
import LiveEegWaveform from "@/components/LiveEegWaveform";

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function posterFor(video?: Video) {
  return video?.url === "/clips/video.mp4" ? "/clips/video-poster.jpg" : undefined;
}

// Same blank-start UX as /live: upload a clip, or ?debug=1 / ?url=<mp4>.
const CLUELY_VIDEO: Video = {
  video_id: "11111111-1111-1111-1111-111111111111",
  url: "/clips/video.mp4",
  characteristics: {
    audio: "music+VO",
    transcript_summary: "Tag that one coworker with no filter — office-humor skit by @cluely (#coworkersbelike).",
    cut_count: 29,
    on_screen_text: "can't you read the sign?",
    subtitles: true,
  },
  metadata: { duration_ms: 55030, created_at: "2026-05-14", creator: "@cluely", likes: 312000, shares: 8483 },
};

function videoFromUrl(url: string): Video {
  return {
    video_id: `url:${url}`,
    url,
    characteristics: {
      audio: "audio",
      transcript_summary: "Custom clip — passed in via ?url=",
      cut_count: 0,
      on_screen_text: "",
      subtitles: false,
    },
    metadata: { duration_ms: 0, creator: "custom url" },
  };
}

export default function LiveEegPage() {
  const [defaultVideo, setDefaultVideo] = useState<Video | null>(null);
  const [curve, setCurve] = useState<PredictedCurve | null>(null);
  const [started, setStarted] = useState(false); // flips on first play (sticky, for the UI reveal)
  const [playbackMs, setPlaybackMs] = useState(0);
  const [uploadedVideo, setUploadedVideo] = useState<Video | null>(null);
  const [chatMode, setChatMode] = useState<ClipChatMode>("decode");
  const screenRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Pull the M2 curve (peak hint for the chat) the same way /live does. Unlike
  // /live, the curve does NOT drive the waveform here — the real EEG does.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const override = params.get("url")?.trim();
    const debug = params.get("debug") != null;
    const v = override ? videoFromUrl(override) : debug ? CLUELY_VIDEO : null;
    if (!v) return;
    setDefaultVideo(v);
    getPredictedCurve(v.video_id).then(setCurve);
  }, []);

  const video = uploadedVideo ?? defaultVideo ?? undefined;

  // `0` toggles fullscreen — same stage shortcut as /live.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "0" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      if (document.fullscreenElement) {
        void document.exitFullscreen();
        return;
      }
      void screenRef.current?.requestFullscreen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const title = video?.characteristics.transcript_summary.split("—")[0].trim();
  const summaryDetail = video?.characteristics.transcript_summary.includes("—")
    ? video.characteristics.transcript_summary.split("—").slice(1).join("—").trim()
    : video?.characteristics.transcript_summary;
  const displayPeakT = curve?.peak_t ?? (video ? 2.2 : null);
  const isReal = !!video?.url && !video.url.includes("example.com");

  return (
    <div
      ref={screenRef}
      className="isolate relative mx-auto flex w-full max-w-[1500px] flex-col gap-5 overflow-hidden bg-black fullscreen:h-screen fullscreen:max-w-none fullscreen:p-6"
    >
      <OrangeSliceWaterfall active={chatMode === "gtm"} />
      <div className="relative z-10 flex flex-col gap-6 xl:grid xl:grid-cols-[400px_1px_520px_1px_232px] xl:items-stretch xl:justify-center">
        {/* LEFT — video stage */}
        <div className="flex h-[640px] items-center justify-center">
          {!video ? (
            <UploadClipButton
              variant="dropzone"
              onAnalyzed={(v, c) => {
                setUploadedVideo(v);
                setCurve(c);
              }}
            />
          ) : isReal ? (
            <video
              ref={videoRef}
              src={video!.url}
              poster={posterFor(video)}
              className="h-full w-auto max-w-[390px] rounded-2xl border border-neutral-800 bg-black object-contain"
              playsInline controls preload="metadata"
              controlsList="nodownload"
              onLoadedMetadata={() => setPlaybackMs((videoRef.current?.currentTime ?? 0) * 1000)}
              onTimeUpdate={() => setPlaybackMs((videoRef.current?.currentTime ?? 0) * 1000)}
              onSeeked={() => setPlaybackMs((videoRef.current?.currentTime ?? 0) * 1000)}
              onPlay={() => {
                setStarted(true);
                setPlaybackMs((videoRef.current?.currentTime ?? 0) * 1000);
              }}
            />
          ) : (
            <div className="relative flex h-full w-auto items-end overflow-hidden rounded-2xl border border-neutral-800 bg-gradient-to-b from-neutral-800 to-neutral-950"
                 style={{ aspectRatio: "9 / 16" }}>
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-4xl text-neutral-700">▶</div>
              <div className="relative w-full bg-gradient-to-t from-black/80 to-transparent p-3 text-xs text-neutral-300">
                {title ?? "loading…"}
              </div>
            </div>
          )}
        </div>

        <div className="hidden bg-neutral-800/80 xl:block" />

        {/* MIDDLE — analyst chat */}
        <div className="min-h-[552px] pr-2 xl:h-[640px]">
          <ClipChat video={video} peakT={displayPeakT} mode={chatMode} onModeChange={setChatMode} />
        </div>

        <div className="hidden bg-neutral-800/80 xl:block" />

        {/* RIGHT — now playing + characteristics */}
        <div className="space-y-3 pr-2 xl:h-[640px] xl:overflow-y-auto">
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/55 p-3.5">
            <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-wide text-neutral-500">
              <span>now playing</span>
              <span className="tabular-nums">{fmt(playbackMs)} / {video ? fmt(video.metadata.duration_ms) : "0:00"}</span>
            </div>
            <div className="mt-1.5 text-base font-semibold leading-tight text-neutral-100">{title ?? "—"}</div>
            <div className="mt-1 text-xs text-neutral-500">{video?.metadata.creator}</div>

            {!started && (
              <div className="mt-3 space-y-3 border-t border-neutral-800 pt-3">
                {summaryDetail && <p className="text-xs leading-relaxed text-neutral-400">{summaryDetail}</p>}
                <div className="grid grid-cols-[0.9fr_1.1fr] gap-2">
                  <div className="rounded-lg border border-[#2f8fd6]/30 bg-[#2f8fd6]/10 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-[#9fe9ff]/70">peak</div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-[#9fe9ff]">
                      {displayPeakT != null ? fmt(displayPeakT * 1000) : "ready"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-neutral-800 bg-black/25 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-neutral-500">signals</div>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-neutral-300">
                      <span className="rounded-full border border-neutral-700 px-2 py-0.5">{video?.characteristics.subtitles ? "captions" : "no captions"}</span>
                      <span className="rounded-full border border-neutral-700 px-2 py-0.5">{video?.characteristics.cut_count ?? "--"} cuts</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {started ? (
            <div className="reveal" style={{ animationDelay: "60ms" }}>
              {video && <CharacteristicsPanel video={video} videoRef={videoRef} />}
            </div>
          ) : null}

          {video && (
            <UploadClipButton
              onAnalyzed={(v, c) => {
                setUploadedVideo(v);
                setCurve(c);
              }}
            />
          )}
        </div>
      </div>

      {/* waveform — REAL live EEG from the headset, streaming continuously */}
      <div className="relative z-10">
        <LiveEegWaveform
          headerRight={
            <span className="hidden items-center gap-1.5 normal-case tracking-normal text-neutral-600 sm:flex">
              <kbd className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">0</kbd>
              fullscreen
            </span>
          }
        />
      </div>
    </div>
  );
}
