#!/usr/bin/env python3
"""Product inference: a video → its predicted EEG interest waveform.

Trains the M2 content→interest model on all feed-study stimulus EEG, then predicts the
per-0.5 s interest waveform for one video. This is the "upload a video, get a predicted
EEG waveform" path; demo_waveform.py is the in/out-of-sample comparison variant, and
predict_waveforms_batch.py is the catalog-wide batch that feeds the UI.

A brand-new upload must be processed first:
    python3 extract_features.py   --videos <id>=<path.mp4> --videos-only --out features
    python3 extract_embeddings.py --features-dir features/videos --videos-dir <dir>
    python3 predict_waveform.py   --video-id <id> [--actual <per_window.csv>]

--actual overlays the recorded EEG curve (when the video was also watched) and reports
the predicted-vs-actual Pearson r. Small N — a DEMO of the mechanism, not calibrated.
"""
from __future__ import annotations

import argparse
import json
import sys

from m2_infer import M2, STIM, OUT, per_window_targets, actual_curve, curve_pearson


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video-id", required=True)
    ap.add_argument("--head", default="ridge")
    ap.add_argument("--actual", default=None,
                    help="per_window CSV to overlay the video's ACTUAL EEG curve")
    args = ap.parse_args()

    m2 = M2(head=args.head).fit(per_window_targets(STIM))
    print(f"  trained on {m2.n_windows} windows / {m2.n_videos} stimulus videos")

    t, y = m2.predict_curve(args.video_id)
    if t is None:
        sys.exit(f"no features/embeddings for {args.video_id} — "
                 "run extract_features.py + extract_embeddings.py first")
    peak_t = float(t[int(y.argmax())])
    print(f"  predicted waveform: {len(t)} windows, peak at t={peak_t:.1f}s, "
          f"mean={y.mean():.3f}, hook(0-3s) mean={y[t <= 3].mean():.3f}")

    # Optional overlay: the recorded curve for a video the model didn't train on.
    ta = ya = r_actual = None
    if args.actual:
        ta, ya = actual_curve(args.actual, args.video_id)
        if len(ta):
            r_actual = curve_pearson(t, y, ta, ya)
            print(f"  actual EEG overlaid: {len(ta)} windows; Pearson(pred, actual) = {r_actual}")
        else:
            ta = None

    plot = _plot(args.video_id, t, y, ta, ya, r_actual)
    (OUT / f"predicted_waveform_{args.video_id}.json").write_text(json.dumps(
        {"video_id": args.video_id, "t": t.tolist(),
         "interest": [round(float(v), 4) for v in y],
         "peak_t": peak_t, "pearson_vs_actual": r_actual,
         "plot": str(plot) if plot else None}, indent=2))


def _plot(video_id, t, y, ta, ya, r_actual):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return None
    fig, ax = plt.subplots(figsize=(11, 3.8))
    ax.plot(t, y, color="#FF5722", lw=2.4, ls=("--" if ta is not None else "-"),
            label="Predicted from video (content→EEG)")
    ax.fill_between(t, 0, y, alpha=0.10, color="#FF5722")
    if ta is not None:
        ax.plot(ta, ya, color="#4CAF50", lw=2.0, label=f"Actual EEG (not in training)  r={r_actual}")
        ax.legend(fontsize=8, loc="upper right")
    ax.axhline(0.5, color="gray", lw=0.8, ls=":")
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("EEG interest (0–1, engagement sign)")
    ax.set_ylim(-0.02, 1.02)
    ax.set_title(f"Predicted EEG waveform{' vs actual' if ta is not None else ''} — "
                 f"{video_id}  ·  DEMO (small N)", fontsize=9.5)
    fig.tight_layout()
    out = OUT / f"predicted_waveform_{video_id}.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"  wrote {out}")
    return out


if __name__ == "__main__":
    main()
