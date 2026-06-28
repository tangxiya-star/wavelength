#!/usr/bin/env python3
"""predict.py — the end-to-end FlowState demo.

  video ──▶ [1] features ──▶ [2] predicted interest curve ──▶ [3] virality estimate
                                                          └──▶ [4] LLM improvement advice

Chains the four stages of the product pipeline.

HONESTY: stages [1] features and [4] LLM advice are REAL. Stages [2] interest curve
and [3] virality are **SYNTHETIC / UNCALIBRATED** until real EEG sessions exist — the
curve uses synth_eeg as a transparent placeholder for the EEG-trained stage-[2] model,
and every such field is flagged "synthetic": true. When real EEG lands, swap stage [2]
for the trained train_interest.py model and stage [3] for train_virality_from_eeg.py;
the rest of this file is unchanged.

Usage:
  python3 model/predict.py --video-id <id>        # use already-extracted features
  python3 model/predict.py --video path/to.mp4    # extract features on the fly
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "model"))
import extract_features as ef       # noqa: E402
import synth_eeg as se              # noqa: E402

OUT = ROOT / "model/out"
FEAT_DIR = ROOT / "model/features/videos"
IG_LABELS = ROOT / "model/datasets/ig_labels.csv"
SUMMARY_KEYS = ["mean_interest", "auc", "hook_interest", "peak", "dip", "slope", "frac_above_0.5"]


def get_features(video_id: str | None, video: str | None) -> dict:
    if video_id:
        f = FEAT_DIR / video_id / f"{video_id}.json"
        if not f.exists():
            sys.exit(f"no features for {video_id} — run extract_features.py first, or pass --video")
        return json.loads(f.read_text())
    path = Path(video)
    cfg = {"out": str(OUT), "v1_dir": str(ef.DEFAULT_V1_ANALYSIS),
           "sample_fps": ef.SAMPLE_FPS, "width": ef.FRAME_WIDTH,
           "hook_seconds": ef.HOOK_SECONDS, "hook_cut_seconds": ef.HOOK_CUT_SECONDS,
           "ocr_every": ef.OCR_EVERY_SECONDS, "skip_ocr": False}
    row = {"id": path.stem, "username": "upload", "selection_type": "upload"}
    print(f"[1] extracting features from {path.name} …")
    return ef.analyze_one(cfg, row, path)


def annotate_windows(curve: list[dict], hook_s: float = 3.0) -> tuple[list, list]:
    """Lowest contiguous interest stretches (weak) + single strongest peak."""
    vs = np.array([r["interest_0_1"] for r in curve], float)
    ts = np.array([r["t"] for r in curve], float)
    if len(vs) < 2:
        return [], []
    thresh = float(np.nanpercentile(vs, 30))
    weak, run = [], []
    for i, v in enumerate(vs):
        if v <= thresh:
            run.append(i)
        elif run:
            weak.append(run); run = []
    if run:
        weak.append(run)
    weak_windows = [{"t_start": round(float(ts[r[0]]), 1), "t_end": round(float(ts[r[-1]] + 0.5), 1),
                     "mean_interest": round(float(vs[r].mean()), 3),
                     "in_hook": bool(ts[r[0]] < hook_s)} for r in weak if len(r) >= 2]
    peak_i = int(np.nanargmax(vs))
    peaks = [{"t": round(float(ts[peak_i]), 1), "interest": round(float(vs[peak_i]), 3)}]
    return weak_windows, peaks


def estimate_virality(this_id: str, summary: dict, target: str = "engagement_rate") -> dict:
    """Stage [3]: fit the cohort's SYNTHETIC summary -> real IG engagement, predict this
    video (leave-it-out). SYNTHETIC + UNCALIBRATED until real EEG exists."""
    ig = pd.read_csv(IG_LABELS).set_index("video_id")
    rows, ids = [], []
    for jf in FEAT_DIR.glob("*/*.json"):
        d = json.loads(jf.read_text())
        if "windows" not in d or d["video_id"] not in ig.index:
            continue
        curve = se.synth_interest_curve(d["windows"], d["video_id"], d.get("duration_s"))
        sv = se.eeg_summary_vector(curve)
        sv["video_id"] = d["video_id"]; sv[target] = ig.loc[d["video_id"], target]
        rows.append(sv); ids.append(d["video_id"])
    coh = pd.DataFrame(rows).dropna(subset=[target])
    train = coh[coh.video_id != this_id]
    pipe = Pipeline([("i", SimpleImputer(strategy="median")),
                     ("m", HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05,
                                                          max_iter=300, random_state=0))])
    pipe.fit(train[SUMMARY_KEYS], train[target].astype(float))
    x = pd.DataFrame([{k: summary.get(k, np.nan) for k in SUMMARY_KEYS}])
    pred = float(pipe.predict(x)[0])
    pctile = float((coh[target].astype(float) < pred).mean() * 100)
    return {"synthetic": True, "calibrated": False, "target": target,
            "predicted_value": round(pred, 5), "cohort_percentile": round(pctile, 1),
            "note": "SYNTHETIC interest curve -> uncalibrated; replace stage [2] with EEG-trained model"}


def run_explain(features_path: Path, vid: str, curve: list[dict], weak: list) -> dict | None:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as cf:
        json.dump([{"t": r["t"], "interest_0_1": r["interest_0_1"]} for r in curve], cf)
        curve_path = cf.name
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as wf:
        json.dump([{"t_start": w["t_start"], "t_end": w["t_end"]} for w in weak], wf)
        weak_path = wf.name
    cmd = [sys.executable, str(ROOT / "model/explain.py"), "--features-json", str(features_path),
           "--predicted-curve", curve_path, "--weak-windows", weak_path]
    subprocess.run(cmd, capture_output=True, text=True)
    out = OUT / f"explain_{vid}.json"
    return json.loads(out.read_text()) if out.exists() else None


def plot(curve, weak, peaks, vid, hook_s=3.0):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return None
    ts = [r["t"] for r in curve]; vs = [r["interest_0_1"] for r in curve]
    plt.figure(figsize=(9, 3.5))
    plt.plot(ts, vs, color="#4c78a8", lw=2, label="predicted interest (SYNTHETIC)")
    plt.axvspan(0, hook_s, color="#ffd966", alpha=0.25, label="hook 0–3s")
    for w in weak:
        plt.axvspan(w["t_start"], w["t_end"], color="#e45756", alpha=0.18)
    for p in peaks:
        plt.scatter([p["t"]], [p["interest"]], color="#54a24b", zorder=5, label="peak")
    plt.ylim(0, 1); plt.xlabel("seconds"); plt.ylabel("interest_0_1")
    plt.title(f"Predicted interest curve — {vid}  (SYNTHETIC / uncalibrated)")
    plt.legend(fontsize=7, loc="upper right"); plt.tight_layout()
    out = OUT / f"predict_{vid}_curve.png"
    plt.savefig(out, dpi=130); plt.close()
    return str(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--video-id")
    g.add_argument("--video")
    ap.add_argument("--target", default="engagement_rate")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    feats = get_features(args.video_id, args.video)
    vid = feats["video_id"]
    feat_path = FEAT_DIR / vid / f"{vid}.json"
    if not feat_path.exists():            # new upload: persist features so explain.py can read them
        feat_path.parent.mkdir(parents=True, exist_ok=True)
        feat_path.write_text(json.dumps(feats, indent=2))

    print("[2] predicting interest curve (synthetic placeholder) …")
    curve = se.synth_interest_curve(feats["windows"], vid, feats.get("duration_s"))
    summary = se.eeg_summary_vector(curve)
    weak, peaks = annotate_windows(curve)

    print("[3] estimating virality from the curve (synthetic/uncalibrated) …")
    virality = estimate_virality(vid, summary, args.target)

    print("[4] generating LLM improvement advice …")
    explanation = run_explain(feat_path, vid, curve, weak)

    report = {
        "video_id": vid, "creator_id": feats.get("creator_id"), "duration_s": feats.get("duration_s"),
        "stages_real": ["1_features", "4_llm_advice"],
        "stages_synthetic": ["2_interest_curve", "3_virality"],
        "predicted_interest_curve": [{"t": r["t"], "interest_0_1": round(r["interest_0_1"], 4)} for r in curve],
        "curve_synthetic": True,
        "interest_summary": summary,
        "weak_windows": weak, "peaks": peaks,
        "virality_estimate": virality,
        "explanation": explanation,
    }
    (OUT / f"predict_{vid}.json").write_text(json.dumps(report, indent=2))
    plot_path = plot(curve, weak, peaks, vid)

    print(f"\n── {vid} ──  ({feats.get('creator_id')}, {feats.get('duration_s')}s)")
    print(f"  interest: mean {summary['mean_interest']:.2f}  hook {summary['hook_interest']:.2f}  "
          f"auc {summary['auc']:.2f}  (SYNTHETIC)")
    print(f"  virality (synthetic/uncalibrated): {virality['predicted_value']} {args.target}  "
          f"~{virality['cohort_percentile']}th pctile")
    print(f"  weak windows: {len(weak)}  |  hook weak: {sum(w['in_hook'] for w in weak)}")
    if explanation:
        print(f"  llm_used: {explanation.get('llm_used')}  edits: {len(explanation.get('edits') or [])}")
    print(f"  report: model/out/predict_{vid}.json" + (f"  plot: {plot_path}" if plot_path else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
