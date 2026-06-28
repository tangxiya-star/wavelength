// Predicted EEG interest waveforms from the M2 content->EEG model.
// Source of truth: model/predict_waveforms_batch.py writes the lookup served at
// /predicted-waveforms.json (public/). Keyed by catalog video_id; each entry is
// the model's per-0.5s predicted interest curve (engagement sign, 0-1) over the
// clip.

export interface PredictedCurve {
  t: number[]; // window centers, seconds
  interest: number[]; // predicted interest 0-1, aligned to t
  peak_t: number; // time of max predicted interest
}

type CurveMap = Record<string, PredictedCurve>;

let cache: Promise<CurveMap> | null = null;

function loadAll(): Promise<CurveMap> {
  if (!cache) {
    cache = fetch("/predicted-waveforms.json", { cache: "force-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<CurveMap>) : ({} as CurveMap)))
      .catch((e) => {
        console.warn("[predict] could not load predicted waveforms", e);
        return {} as CurveMap;
      });
  }
  return cache;
}

/** The model's predicted interest curve for a clip, or null if it wasn't
 *  predicted (no features/embeddings) — caller falls back to the synth stream. */
export async function getPredictedCurve(videoId: string): Promise<PredictedCurve | null> {
  const all = await loadAll();
  return all[videoId] ?? null;
}

/** Linear-interpolate the model's predicted interest at a playback time (sec). */
export function sampleCurve(curve: PredictedCurve, tSec: number): number {
  const { t, interest } = curve;
  if (t.length === 0) return 0.5;
  if (tSec <= t[0]) return interest[0];
  if (tSec >= t[t.length - 1]) return interest[interest.length - 1];
  let i = 1;
  while (i < t.length && t[i] < tSec) i++;
  const t0 = t[i - 1];
  const t1 = t[i];
  const f = t1 === t0 ? 0 : (tSec - t0) / (t1 - t0);
  return interest[i - 1] + f * (interest[i] - interest[i - 1]);
}
