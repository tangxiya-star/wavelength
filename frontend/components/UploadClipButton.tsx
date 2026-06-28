"use client";
// Upload a new clip → run the model pipeline (/api/predict-upload: features +
// SigLIP/CLAP embeddings + predicted EEG) → hand the analyzed clip + curve up to
// /live, which makes it the active clip (plays + shows its predicted EEG line).
import { useRef, useState } from "react";
import type { Video } from "@/lib/types";
import type { PredictedCurve } from "@/lib/predict";

export default function UploadClipButton({
  onAnalyzed,
  variant = "button",
}: {
  onAnalyzed: (video: Video, curve: PredictedCurve) => void;
  variant?: "button" | "dropzone";
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = async (file: File) => {
    if (analyzing) return;
    setAnalyzing(true);
    setError(null);
    const url = URL.createObjectURL(file);
    try {
      const fd = new FormData();
      fd.append("video", file);
      const res = await fetch("/api/predict-upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `upload ${res.status}`);
      onAnalyzed(
        {
          video_id: data.video_id,
          url,
          characteristics: data.characteristics,
          metadata: { duration_ms: data.duration_ms, creator: "your upload" },
        },
        data.curve as PredictedCurve,
      );
    } catch (e) {
      URL.revokeObjectURL(url);
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="video/*"
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) handle(f);
        e.target.value = "";
      }}
    />
  );

  // Big blank-state dropzone: clicking opens the native file picker (Finder).
  if (variant === "dropzone") {
    return (
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={analyzing}
        style={{ aspectRatio: "9 / 16" }}
        className="flex h-full w-auto flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-neutral-700 bg-neutral-950/40 px-6 text-center transition-colors hover:border-[#9fe9ff]/60 hover:bg-neutral-900/50 disabled:opacity-70"
      >
        {analyzing ? (
          <>
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-[#9fe9ff]" />
            <span className="text-sm text-neutral-300">analyzing… (~15s)</span>
          </>
        ) : (
          <>
            <span className="text-3xl text-[#9fe9ff]">↑</span>
            <span className="text-base font-semibold text-neutral-100">Upload a video to analyze</span>
            <span className="text-xs text-neutral-500">click to choose a clip in Finder</span>
          </>
        )}
        {error && <span className="text-xs text-red-400">{error}</span>}
        {fileInput}
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={analyzing}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-neutral-700 bg-neutral-900/40 px-3 py-2 text-sm text-neutral-200 transition-colors hover:bg-neutral-800 disabled:opacity-60"
      >
        {analyzing ? (
          <>
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-600 border-t-[#9fe9ff]" />
            analyzing… (~15s)
          </>
        ) : (
          <>↑ upload another video</>
        )}
      </button>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {fileInput}
    </div>
  );
}
