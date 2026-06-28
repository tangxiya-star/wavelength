"use client";
// Screen 1 — Live scroll (the money shot). See prd-holly.md §2.
import { useEffect, useRef, useState } from "react";
import { subscribeEeg, subscribePredictedEeg } from "@/lib/ws";
import { getPredictedCurve, type PredictedCurve } from "@/lib/predict";
import type { Video, EegSample } from "@/lib/types";
import Waveform from "@/components/Waveform";
import CharacteristicsPanel from "@/components/CharacteristicsPanel";
import UploadClipButton from "@/components/UploadClipButton";
import ClipChat, { type ClipChatMode } from "@/components/ClipChat";
import OrangeSliceWaterfall from "@/components/OrangeSliceWaterfall";
import cluelyAnalysis from "@/lib/cluely-analysis.json";

// Demo mode — set via NEXT_PUBLIC_DEMO_MODE on the Vercel build ONLY. Preloads the
// @cluely clip + its saved curve and hides the upload button. Local `npm run dev`
// leaves it unset, so the page stays blank + upload.
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "1";
const CLUELY_CURVE = cluelyAnalysis.curve as PredictedCurve;

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function posterFor(video?: Video) {
  return video?.url === "/clips/video.mp4" ? "/clips/video-poster.jpg" : undefined;
}

// /live starts blank — the user uploads a clip (the Finder picker) to analyze it.
//   ?debug=1   → preload the @cluely demo reel so no upload is needed
//   ?url=<mp4> → skip the upload and play that clip directly
// The @cluely office-humor reel (public/clips/video.mp4), used by the debug flag.
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

// Build a minimal Video for an ad-hoc ?url= override (no catalog/curve, so the
// waveform uses the synth fallback). duration_ms fills in once the clip loads.
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

export default function LivePage() {
  const [defaultVideo, setDefaultVideo] = useState<Video | null>(DEMO_MODE ? CLUELY_VIDEO : null);
  const [curve, setCurve] = useState<PredictedCurve | null>(DEMO_MODE ? CLUELY_CURVE : null);
  const [samples, setSamples] = useState<EegSample[]>([]);
  const [started, setStarted] = useState(false); // flips on first play (sticky, for the UI reveal)
  const [playing, setPlaying] = useState(false); // true only while the clip is actually playing
  const [playbackMs, setPlaybackMs] = useState(0);
  const [uploadedVideo, setUploadedVideo] = useState<Video | null>(null); // an analyzed upload overrides the catalog clip
  const [chatMode, setChatMode] = useState<ClipChatMode>("decode");
  const screenRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sampleBufRef = useRef<EegSample[]>([]); // raw 200Hz ingest; flushed to state on rAF

  // Blank by default — the user uploads a clip. ?debug=1 (or the DEMO_MODE build)
  // preloads the @cluely reel with its saved curve; ?url=<mp4> plays that clip
  // directly (curve from the M2 model if it has one, else the synth stream).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const override = params.get("url")?.trim();
    const debug = params.get("debug") != null || DEMO_MODE;
    if (override) {
      const v = videoFromUrl(override);
      setDefaultVideo(v);
      getPredictedCurve(v.video_id).then(setCurve);
    } else if (debug) {
      setDefaultVideo(CLUELY_VIDEO);
      setCurve(CLUELY_CURVE);
    }
  }, []);

  // the waveform streams once the clip is playing. predict_score is the M2
  // model's content->EEG prediction for THIS clip, sampled at the live playback
  // time; if the clip wasn't predicted we fall back to the synth stream.
  const video = uploadedVideo ?? defaultVideo ?? undefined;

  // reset the drawn waveform only when the clip itself changes (not on pause/end)
  useEffect(() => {
    sampleBufRef.current = [];
    setSamples([]);
  }, [video?.video_id]);

  // sample the EEG only WHILE the clip is playing — pausing or reaching the end
  // stops it and freezes the line in place. The stream fires at ~200Hz; we
  // buffer into a ref and flush to state once per animation frame so the chart
  // re-renders ~60fps instead of ~200fps (one alloc + render per frame, not per
  // sample). The buffer survives pause/resume; it's cleared only on clip change.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let dirty = false;
    const onSample = (s: EegSample) => {
      const buf = sampleBufRef.current;
      buf.push(s);
      if (buf.length > 4000) buf.splice(0, buf.length - 4000);
      dirty = true;
    };
    const flush = () => {
      if (dirty) {
        dirty = false;
        setSamples(sampleBufRef.current.slice());
      }
      raf = requestAnimationFrame(flush);
    };
    raf = requestAnimationFrame(flush);
    const unsub = curve
      ? subscribePredictedEeg(curve, () => (videoRef.current?.currentTime ?? 0) * 1000, onSample)
      : subscribeEeg(onSample);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
    };
  }, [playing, curve]);

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
  // real mp4 vs mock → show <video> only for real files (mocks point at example.com)
  const isReal = !!video?.url && !video.url.includes("example.com");

  return (
    <div
      ref={screenRef}
      className="isolate relative mx-auto flex w-full max-w-[1500px] flex-col gap-5 overflow-hidden bg-black fullscreen:h-screen fullscreen:max-w-none fullscreen:p-6"
    >
      <OrangeSliceWaterfall active={chatMode === "gtm"} />
      {/* 3 columns on wide screens; stacks vertically below xl */}
      <div className="relative z-10 flex flex-col gap-6 xl:grid xl:grid-cols-[400px_1px_520px_1px_232px] xl:items-stretch xl:justify-center">
        {/* LEFT — video stage (fits a 9:16 reel or 16:9 clip via object-contain) */}
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
                setPlaying(true);
                setPlaybackMs((videoRef.current?.currentTime ?? 0) * 1000);
              }}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
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

        {/* MIDDLE — live chat from the start: the analyst narrates what the model learned, then you can ask back */}
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

          {/* once a clip is loaded this becomes "upload another"; the blank-state
              dropzone (left) is the primary entry point before that. Hidden in the
              DEMO_MODE (Vercel) build, which preloads the clip. */}
          {video && !DEMO_MODE && (
            <UploadClipButton
              onAnalyzed={(v, c) => {
                setUploadedVideo(v);
                setCurve(c);
              }}
            />
          )}
        </div>
      </div>

      {/* waveform — grid always visible (shows the feature); line streams in on play */}
      <div className="relative z-10">
        <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-neutral-500">
          <span>theta / beta predicted waveform</span>
          <span className="hidden items-center gap-1.5 normal-case tracking-normal text-neutral-600 sm:flex">
            <kbd className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">0</kbd>
            fullscreen
          </span>
        </div>
        <Waveform samples={samples} durationMs={video?.metadata.duration_ms} live={started} curve={curve} />
      </div>
    </div>
  );
}
