// Chat / decode API — Holly owns this. Devan supplies the decode semantics for the prompt.
// Build the system prompt from a video's characteristics + its interest curve, then stream
// a plain-language explanation of WHY it spiked. Call this from a route handler (server-side)
// so OPENAI_API_KEY never reaches the browser.
import type { Video, EegSample } from "./types";

export function buildDecodePrompt(video: Video, samples: EegSample[]): string {
  const peak = Math.max(0, ...samples.map((s) => s.interest_score));
  const peakAt = samples.find((s) => s.interest_score === peak)?.video_t_ms ?? 0;
  return [
    "You are a neuro-marketing analyst. A rising theta/beta ratio = rising engagement.",
    "Explain in 1-2 plain sentences WHY this clip drove (or failed to drive) interest,",
    "citing its hook timing, pacing/cuts, and on-screen text.",
    "",
    `Clip: ${video.characteristics.transcript_summary}`,
    `Cuts: ${video.characteristics.cut_count} | Audio: ${video.characteristics.audio} | Text: "${video.characteristics.on_screen_text}"`,
    `Peak interest ${peak.toFixed(2)} at ${peakAt}ms.`,
  ].join("\n");
}

// TODO(Holly): wire this in app/log via a /api/decode route using the `openai` SDK + OPENAI_API_KEY.
// Keep the key server-side. See .env.local.example.
