#!/usr/bin/env python3
"""DEMO — predict a video's EEG waveform, compare in-sample vs out-of-sample participant.

A single video was watched by two participants, A and B. We train the M2 content→interest
model on the feed-study EEG *including* A's view of this video (in-sample) but *excluding*
B's entire session (out-of-sample), then predict the video's waveform from content alone
and overlay it against both participants' recorded curves:
    • predicted (content only)
    • participant A — in-sample reference
    • participant B — out-of-sample, the real generalization test

If the predicted curve tracks B about as well as A, the model generalizes across people.
Small N — a DEMO of the mechanism, not a calibrated result.

Usage:
    python3 demo_waveform.py                 # auto-pick the best-covered shared video
    python3 demo_waveform.py --video-id <id>
"""
from __future__ import annotations

import argparse
import json
import sys

import pandas as pd

from m2_infer import M2, ENG, OUT, per_window_targets, actual_curve, curve_pearson

# The two good-quality participants, by eegSyncId per-window file.
A_FILE = ENG / "92b827c3-7a28-4cee-904f-73587d53c8d3_per_window.csv"  # in-sample (Holly)
B_FILE = ENG / "9d7b5751-bcb3-4394-9fa5-11cd43be4ca2_per_window.csv"  # held out  (Yuva)
# Other sessions that join training only (never the held-out participant).
OTHER_FILES = [
    ENG / "81707908-7ce9-4f34-b327-9710b7d86727_per_window.csv",
    ENG / "0d9666c4-574d-441e-922f-894830c48692_per_window.csv",
    ENG / "f3c6e905-3053-41fa-b962-b7849977ee80_per_window.csv",
]


def pick_demo_video(feat_ids, a_ids, b_ids, b_df) -> str:
    """A video watched by BOTH participants and present in the feature set, choosing the
    one with the most windows in B's session (B's curve is the generalization target)."""
    common = set(a_ids) & set(b_ids) & set(feat_ids)
    if not common:
        sys.exit("no video shared by participant A, B and the feature set")
    return max(common, key=lambda v: (b_df.video_id == v).sum())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video-id", default=None)
    ap.add_argument("--head", default="ridge")
    args = ap.parse_args()

    a_df, b_df = pd.read_csv(A_FILE), pd.read_csv(B_FILE)

    # Train on everything except participant B's session (A's view of the demo video stays in).
    train = pd.concat([a_df] + [pd.read_csv(p) for p in OTHER_FILES], ignore_index=True)
    targets = train.groupby(["video_id", "t"])["interest_0_1"].mean().reset_index()
    m2 = M2(head=args.head).fit(targets)

    vid = args.video_id or pick_demo_video(m2.feat.video_id, a_df.video_id, b_df.video_id, b_df)
    print(f"  demo video = {vid}")
    print(f"  trained on {m2.n_windows} windows / {m2.n_videos} videos "
          f"(participant B held out); demo video in train: {vid in targets.video_id.values}")

    t, y = m2.predict_curve(vid)
    if t is None:
        sys.exit(f"no features/embeddings for {vid}")
    ta, ya = actual_curve(A_FILE, vid)
    tb, yb = actual_curve(B_FILE, vid)
    rA, rB = curve_pearson(t, y, ta, ya), curve_pearson(t, y, tb, yb)
    print(f"  Pearson(pred, A / IN-sample)  = {rA}")
    print(f"  Pearson(pred, B / OUT-sample) = {rB}")

    plot = _plot(vid, t, y, ta, ya, rA, tb, yb, rB)
    (OUT / "m2_demo_waveform.json").write_text(json.dumps(
        {"video_id": vid, "head": args.head,
         "pearson_in_sample_A": rA, "pearson_out_sample_B": rB, "n_pred_windows": len(t),
         "plot": str(plot) if plot else None,
         "curves": {"t_pred": t.tolist(), "y_pred": [round(float(v), 4) for v in y],
                    "t_A": ta.tolist(), "y_A": [round(float(v), 4) for v in ya],
                    "t_B": tb.tolist(), "y_B": [round(float(v), 4) for v in yb]}}, indent=2))
    print(f"  wrote {OUT / 'm2_demo_waveform.json'}")


def _plot(vid, t, y, ta, ya, rA, tb, yb, rB):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return None
    fig, ax = plt.subplots(figsize=(11, 4.2))
    ax.plot(t, y, color="#FF5722", lw=2.4, ls="--", label="Predicted from video (content→EEG)")
    ax.plot(ta, ya, color="#2196F3", lw=2.0, label=f"Actual — participant A (in-sample)  r={rA}")
    ax.plot(tb, yb, color="#4CAF50", lw=2.0, label=f"Actual — participant B (OUT-of-sample)  r={rB}")
    ax.axhline(0.5, color="gray", lw=0.8, ls=":")
    # Focus on the watched window: participants scroll away early, so EEG exists only there.
    watched = max(float(ta.max()) if len(ta) else 0, float(tb.max()) if len(tb) else 0)
    ax.set_xlim(-0.3, watched + 0.7)
    ax.set_xlabel(f"Time (s)   ·   watched window 0–{watched:.0f}s (video is longer; EEG only while on-screen)")
    ax.set_ylabel("EEG interest (0–1, engagement sign)")
    ax.set_ylim(-0.02, 1.02)
    ax.legend(fontsize=8, loc="upper right")
    ax.set_title(f"M2 demo — predicted EEG waveform vs actual ({vid})\n"
                 f"trained holding out participant B  ·  DEMO, small N", fontsize=10)
    fig.tight_layout()
    out = OUT / "m2_demo_waveform.png"
    fig.savefig(out, dpi=140)
    plt.close(fig)
    print(f"  wrote {out}")
    return out


if __name__ == "__main__":
    main()
