import type { EegSample } from "./types";
import type { PredictedCurve } from "./predict";
import { sampleCurve } from "./predict";

type Handler = (s: EegSample) => void;

/** Drive the waveform from the M2 model's PREDICTED curve for the playing clip.
 *  - predict_score = the model's content->EEG prediction, sampled at the live
 *    playback time (so the dashed "predict" layer IS the model output).
 *  - interest_score = the "measured" signal: the prediction plus a mean-reverting
 *    walk + jitter, so the bright "real" line hugs the prediction the way a
 *    viewer's attention tracks it — until live EEG (NEXT_PUBLIC_EEG_WS_URL) is wired.
 *  x-axis = real playback time (ms). Returns an unsubscribe fn. */
export function subscribePredictedEeg(
  curve: PredictedCurve,
  getTimeMs: () => number,
  onSample: Handler,
): () => void {
  let cancelled = false;
  const STEP = 250; // ms (~4 Hz)
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  let walk = 0;

  const tick = () => {
    if (cancelled) return;
    const tMs = getTimeMs();
    const predict = sampleCurve(curve, tMs / 1000);
    walk = walk * 0.94 + (Math.random() - 0.5) * 0.08;
    const jitter = (Math.random() - 0.5) * 0.04;
    const interest = clamp(predict + walk + jitter, 0.02, 1);
    const theta_beta = clamp(1.2 + interest * 2.2 + (Math.random() - 0.5) * 0.25, 0.5, 4);
    onSample({
      session_id: "model",
      video_id: "model",
      video_t_ms: tMs,
      theta_beta: Number(theta_beta.toFixed(2)),
      interest_score: Number(interest.toFixed(3)),
      predict_score: Number(predict.toFixed(3)),
    });
    setTimeout(tick, STEP);
  };
  tick();

  return () => {
    cancelled = true;
  };
}

/** Subscribe to Devan's EEG WebSocket. Returns an unsubscribe fn.
 *  If no WS url is set, falls back to replaying the shared mock .jsonl. */
export function subscribeEeg(onSample: Handler): () => void {
  const url = process.env.NEXT_PUBLIC_EEG_WS_URL;

  if (!url) {
    return replayMock(onSample);
  }

  const sock = new WebSocket(url);
  sock.onmessage = (ev) => {
    try {
      onSample(JSON.parse(ev.data) as EegSample);
    } catch (e) {
      console.warn("[ws] bad EEG frame", e);
    }
  };
  sock.onerror = () => console.warn("[ws] EEG socket error — is Devan's server up?");
  return () => sock.close();
}

/** Demo/dev fallback: synthesize an organic EEG stream at ~2 Hz.
 *  Two layers per sample:
 *   - predict_score: the smooth curve the model EXPECTED (sum of incommensurate
 *     sines + scripted hook/CTA attention spikes) — no two seconds look alike.
 *   - interest_score: the REAL measured signal — predict + a mean-reverting
 *     random walk + per-sample jitter, so it hugs the prediction but drifts and
 *     spikes the way an actual viewer's attention does.
 *  Unlike the old jsonl loop this never repeats a fixed period. */
function replayMock(onSample: Handler): () => void {
  let cancelled = false;
  const STEP = 500; // ms between samples (~2 Hz)
  const LOOP = 15000; // clip length the scripted spikes are timed against

  // incommensurate frequencies (cycles/ms) → the sum never neatly repeats
  const freqs = [0.000071, 0.00019, 0.00043, 0.00091];
  const phase = freqs.map(() => Math.random() * Math.PI * 2);
  const amp = [0.34, 0.22, 0.13, 0.07];
  // scripted attention spikes within each LOOP: a strong hook, a softer CTA
  const spikes = [
    { at: 2200, w: 750, h: 0.3 }, // hook
    { at: 10500, w: 1000, h: 0.22 }, // CTA
  ];

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  let t = 0;
  let walk = 0; // mean-reverting deviation of real vs predict

  (async () => {
    const tick = () => {
      if (cancelled) return;

      // smooth model prediction
      let s = 0;
      for (let k = 0; k < freqs.length; k++) s += Math.sin(t * freqs[k] + phase[k]) * amp[k];
      let predict = 0.5 + s;
      const tl = t % LOOP;
      for (const sp of spikes) {
        const d = tl - sp.at;
        predict += sp.h * Math.exp(-(d * d) / (2 * sp.w * sp.w));
      }
      predict = clamp(predict, 0.05, 0.97);

      // real measured signal: tracks predict but drifts away via a slower,
      // larger random walk (so the two layers visibly separate) plus jitter
      walk = walk * 0.94 + (Math.random() - 0.5) * 0.12;
      const jitter = (Math.random() - 0.5) * 0.05;
      const interest = clamp(predict + walk + jitter, 0.02, 1);
      const theta_beta = clamp(1.2 + interest * 2.2 + (Math.random() - 0.5) * 0.25, 0.5, 4);

      onSample({
        session_id: "demo",
        video_id: "demo",
        video_t_ms: t,
        theta_beta: Number(theta_beta.toFixed(2)),
        interest_score: Number(interest.toFixed(3)),
        predict_score: Number(predict.toFixed(3)),
      });

      t += STEP;
      setTimeout(tick, STEP);
    };
    tick();
  })();

  return () => {
    cancelled = true;
  };
}
