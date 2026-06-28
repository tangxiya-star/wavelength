#!/usr/bin/env python3
"""Batch product inference for the web frontend.

Trains the M2 content->interest model ONCE (hand features + SigLIP/CLAP
embeddings, ridge head) on all feed-study stimulus EEG, then predicts the
per-0.5s EEG interest waveform for every video that has features + embeddings,
and writes a single lookup the NeuroViral frontend serves statically:

    frontend/public/predicted-waveforms.json
    { "<video_id>": { "t": [...], "interest": [...], "peak_t": <s> }, ... }

This is the same model/path as predict_waveform.py (single-video), batched so the
/live screen can show the model's predicted brainwave for whatever clip is on
stage without running Python at request time.

Regenerate after the catalog or model changes:
    python3 model/predict_waveforms_batch.py
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
import warnings, numpy as np, pandas as pd
warnings.filterwarnings("ignore"); np.seterr(all="ignore")

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import train_interest as ti
from embed_store import align_window_embeddings, make_embed_pipeline

ENG = ROOT.parent / "hardware/analysis/out/engagement"
STIM = ENG / "STIMULUS_per_window.csv"          # app feed-study windows (not baseline reels)
EMB_DIR = ROOT / "embeddings"
KINDS = ("siglip", "clap")
OUT_JSON = ROOT.parent / "frontend" / "public" / "predicted-waveforms.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--head", default="ridge")
    ap.add_argument("--out", default=str(OUT_JSON))
    args = ap.parse_args()

    # ---- train M2 once on all stimulus EEG ----
    feat = ti.load_feature_windows(ti.FEATURES_DIR)
    eeg = pd.read_csv(STIM)
    tgt = eeg.groupby(["video_id", "t"])["interest_0_1"].mean().reset_index()
    df = feat.merge(tgt, on=["video_id", "t"], how="inner")
    Xe, _, ok = align_window_embeddings(df, EMB_DIR, KINDS)
    df, Xe = df.loc[ok].reset_index(drop=True), Xe[ok]
    Xh = df[ti.WINDOW_FEATURES].apply(pd.to_numeric, errors="coerce").to_numpy()
    model = make_embed_pipeline(len(ti.WINDOW_FEATURES), Xe.shape[1], head=args.head, pca_dim=48)
    model.fit(np.hstack([Xh, Xe]), df["interest_0_1"].to_numpy(float))
    print(f"  trained on {len(df)} windows / {df.video_id.nunique()} stimulus videos")

    # ---- predict every video that has features + embeddings ----
    out: dict[str, dict] = {}
    skipped = 0
    for vid in sorted(feat.video_id.unique()):
        dv = feat[feat.video_id == vid].sort_values("t").reset_index(drop=True)
        if dv.empty:
            continue
        try:
            Xe_v, _, okv = align_window_embeddings(dv, EMB_DIR, KINDS)
        except FileNotFoundError:
            skipped += 1  # video has features but no SigLIP/CLAP embedding
            continue
        if okv.sum() == 0:
            skipped += 1
            continue
        dv, Xe_v = dv.loc[okv].reset_index(drop=True), Xe_v[okv]
        Xh_v = dv[ti.WINDOW_FEATURES].apply(pd.to_numeric, errors="coerce").to_numpy()
        t = dv["t"].to_numpy()
        y = np.clip(model.predict(np.hstack([Xh_v, Xe_v])), 0, 1)
        out[str(vid)] = {
            "t": [round(float(x), 3) for x in t],
            "interest": [round(float(v), 4) for v in y],
            "peak_t": round(float(t[int(np.argmax(y))]), 2),
        }

    dest = Path(args.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, separators=(",", ":")))
    print(f"  wrote {len(out)} predicted waveforms -> {dest}  ({skipped} skipped, no embeddings)")


if __name__ == "__main__":
    main()
