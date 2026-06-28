#!/usr/bin/env python3
"""M2 - Interest / EEG-curve regression  (pipeline stage [2]).

Feature windows[] -> per-window interest_0_1 curve.

Evaluation: leave-one-video-out (LOVO) cross-validation.
Anti-leakage: no video appears in both train and test splits.
Feature schema version: "2.0"  (pinned; fails loudly on mismatch).

Data sources (pick one):
  --synthetic          Generate targets with synth_eeg.py on the fly.
                       WARNING: PLUMBING CHECK ONLY - no accuracy claims.
                       All output is labeled SYNTHETIC.
  --per-window  CSV    Real EEG, P-03 export:
                         hardware/analysis/out/<eegSyncId>_per_window.csv
                       Schema: exposure_id, video_id, t, interest_0_1
                               [, coverage, quality]
                       If multiple exposures per video, interest_0_1 is
                       averaged across participants before joining.

Outputs (model/out/):
  m2_results.json
  m2_curve_overlay.png   <- HERO visual: predicted vs truth for one held-out video

WHAT TO CHANGE WHEN REAL EEG ARRIVES:
  Drop --synthetic, pass --per-window hardware/analysis/out/<id>_per_window.csv
  Nothing else changes.  Re-run and compare m2_results.json.
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from scipy.stats import pearsonr, spearmanr
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.pipeline import Pipeline

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "model" / "out"
FEATURES_DIR = ROOT / "model" / "features" / "videos"
SCHEMA_VERSION = "2.0"

# add model/ to path so `import synth_eeg` / `import embed_store` works
sys.path.insert(0, str(Path(__file__).resolve().parent))

from embed_store import (  # noqa: E402
    EMB_DIR,
    align_window_embeddings,
    lovo_cv_matrix,
    make_embed_pipeline,
)

# Per-window features fed to the regressor.
# All map directly to keys in features.windows[] plus t_norm derived from t.
WINDOW_FEATURES = [
    "t_norm",           # t / duration_s  -- removes duration confound
    "face_present",
    "face_size_frac",
    "face_centrality",
    "motion",
    "loudness_db",
    "ocr_text_present",
    "brightness",
    "colorfulness",
    "saturation",
    "contrast",
    "cut_in_window",
]
TARGET = "interest_0_1"


# ── data loading ──────────────────────────────────────────────────────────────

def load_feature_windows(features_dir: Path = FEATURES_DIR) -> pd.DataFrame:
    """Return a flat per-window DataFrame from all feature JSON files."""
    rows = []
    skipped = 0
    for vdir in sorted(features_dir.iterdir()):
        if not vdir.is_dir():
            continue
        vid = vdir.name
        jpath = vdir / f"{vid}.json"
        if not jpath.exists():
            continue
        feat = json.loads(jpath.read_text())
        vsn = feat.get("feature_schema_version")
        if vsn != SCHEMA_VERSION:
            print(f"  SKIP {vid}: feature_schema_version '{vsn}' != '{SCHEMA_VERSION}'")
            skipped += 1
            continue
        dur = float(feat.get("duration_s") or 1.0)
        creator = feat.get("creator_id", "unknown")
        for w in feat.get("windows", []):
            row = {
                "video_id": vid,
                "creator_id": creator,
                "duration_s": dur,
                "t": float(w["t"]),
                "t_norm": float(w["t"]) / dur if dur > 0 else 0.0,
            }
            for k in [
                "face_present", "face_size_frac", "face_centrality",
                "motion", "loudness_db", "ocr_text_present",
                "brightness", "colorfulness", "saturation",
                "contrast", "cut_in_window",
            ]:
                row[k] = w.get(k)
            rows.append(row)
    df = pd.DataFrame(rows)
    if skipped:
        print(f"  Skipped {skipped} videos (schema mismatch)")
    print(f"  Loaded {len(df)} feature windows for {df['video_id'].nunique()} videos")
    return df


def load_synth_targets(feat_df: pd.DataFrame) -> pd.DataFrame:
    """Join synthetic EEG interest targets onto feature windows."""
    from synth_eeg import build_synth_dataset  # deferred to avoid import at top level

    print()
    print("!" * 60)
    print("!  DATA SOURCE: SYNTHETIC EEG -- NOT REAL BRAIN DATA        !")
    print("!  Results are PLUMBING VALIDATION ONLY.                    !")
    print("!  No accuracy claims.                                       !")
    print("!" * 60)

    eeg_df = build_synth_dataset()
    merged = feat_df.merge(eeg_df[["video_id", "t", TARGET]], on=["video_id", "t"], how="inner")
    merged["_synthetic"] = True
    dropped = len(feat_df) - len(merged)
    if dropped:
        print(f"  Note: {dropped} feature rows had no matching synthetic target (t mismatch)")
    print(f"  Merged: {len(merged)} per-window rows with synthetic targets")
    return merged


def load_real_targets(feat_df: pd.DataFrame, per_window_csv: Path) -> pd.DataFrame:
    """
    Load real EEG per-window CSV (P-03 export) and join onto feature windows.

    Expected columns: exposure_id, video_id, t, interest_0_1 [, coverage, quality]
    Averages interest_0_1 across participants per (video_id, t) before merging.
    Low-quality rows are LOGGED (not silently dropped) -- caller decides filtering.
    """
    eeg = pd.read_csv(per_window_csv)
    required = {"video_id", "t", "interest_0_1"}
    missing = required - set(eeg.columns)
    if missing:
        raise ValueError(f"--per-window CSV missing required columns: {missing}")
    if "coverage" in eeg.columns:
        low = (eeg["coverage"] < 0.5).sum()
        print(f"  EEG rows with coverage < 0.5: {low} / {len(eeg)} (logged, not dropped)")
    if "quality" in eeg.columns:
        print(f"  mean_channel_quality: {eeg['quality'].mean():.3f}")
    n_exp = eeg["exposure_id"].nunique() if "exposure_id" in eeg.columns else "?"
    print(f"  Real EEG: {len(eeg)} rows, {eeg['video_id'].nunique()} videos, {n_exp} exposures")
    eeg_agg = eeg.groupby(["video_id", "t"])["interest_0_1"].mean().reset_index()
    merged = feat_df.merge(eeg_agg, on=["video_id", "t"], how="inner")
    merged["_synthetic"] = False
    print(f"  Joined: {len(merged)} per-window rows across {merged['video_id'].nunique()} videos")
    return merged


# ── model ─────────────────────────────────────────────────────────────────────

def build_model() -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("m", HistGradientBoostingRegressor(
            max_depth=3, learning_rate=0.05, max_iter=200,
            l2_regularization=1.0, random_state=0,
        )),
    ])


# ── cross-validation ──────────────────────────────────────────────────────────

def leave_one_video_out_cv(df: pd.DataFrame, target: str = TARGET):
    """
    Leave-one-video-out CV.
    Returns (y_true, y_pred, vid_col) -- same length as df.
    """
    videos = df["video_id"].unique()
    n = len(df)
    y_true_all = df[target].to_numpy(dtype=float)
    y_pred_all = np.empty(n, dtype=float)
    vid_col = df["video_id"].to_numpy()
    X_all = df[WINDOW_FEATURES].apply(pd.to_numeric, errors="coerce").to_numpy()

    print(f"  LOVO CV over {len(videos)} videos ...")
    for i, held_vid in enumerate(videos):
        mask_te = vid_col == held_vid
        mask_tr = ~mask_te
        if mask_tr.sum() < 5:
            # fallback: predict training mean
            y_pred_all[mask_te] = y_true_all[mask_tr].mean() if mask_tr.any() else 0.5
        else:
            pipe = build_model()
            pipe.fit(X_all[mask_tr], y_true_all[mask_tr])
            y_pred_all[mask_te] = pipe.predict(X_all[mask_te])
        if (i + 1) % 30 == 0 or (i + 1) == len(videos):
            print(f"    {i + 1}/{len(videos)} videos done")

    return y_true_all, y_pred_all, vid_col


# ── metrics ───────────────────────────────────────────────────────────────────

def per_video_pearson(y: np.ndarray, yhat: np.ndarray, vid_col: np.ndarray) -> float:
    """n-weighted mean Pearson r across videos with >= 4 windows."""
    vals, weights = [], []
    for v in pd.unique(vid_col):
        mask = vid_col == v
        if mask.sum() < 4:
            continue
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            r, _ = pearsonr(y[mask], yhat[mask])
        if not np.isnan(r):
            vals.append(r)
            weights.append(int(mask.sum()))
    return float(np.average(vals, weights=weights)) if vals else float("nan")


# ── plots ─────────────────────────────────────────────────────────────────────

def plot_curve_overlay(
    df: pd.DataFrame,
    y_pred_all: np.ndarray,
    vid_col: np.ndarray,
    synthetic: bool,
    out_dir: Path,
) -> Optional[str]:
    """HERO: predicted vs ground-truth interest curve for the longest video."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return None

    videos, counts = np.unique(vid_col, return_counts=True)
    best_vid = videos[np.argmax(counts)]
    mask = vid_col == best_vid

    t_vals = df["t"].to_numpy()[mask]
    y_true = df[TARGET].to_numpy(dtype=float)[mask]
    y_pred = y_pred_all[mask]
    order = np.argsort(t_vals)
    t_vals, y_true, y_pred = t_vals[order], y_true[order], y_pred[order]

    fig, ax = plt.subplots(figsize=(11, 4))
    ax.plot(t_vals, y_true, color="#2196F3", linewidth=2.0, label="EEG interest (truth)")
    ax.plot(t_vals, y_pred, color="#FF5722", linewidth=2.0, linestyle="--",
            label="Predicted (LOVO)")
    ax.fill_between(t_vals, y_true, y_pred, alpha=0.12, color="gray")
    ax.axhline(0.5, color="gray", linewidth=0.8, linestyle=":")
    ax.set_xlabel("Time (s)", fontsize=11)
    ax.set_ylabel("interest_0_1", fontsize=11)
    ax.set_ylim(-0.02, 1.02)
    ax.legend(fontsize=9)
    synth_tag = "  [SYNTHETIC -- plumbing only]" if synthetic else ""
    ax.set_title(
        f"M2 interest-curve overlay -- {best_vid}{synth_tag}\n"
        f"(EEG interest: provisional / relative)",
        fontsize=11,
    )
    fig.tight_layout()
    out_path = out_dir / "m2_curve_overlay.png"
    fig.savefig(out_path, dpi=130)
    plt.close(fig)
    return str(out_path)


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="Train M2 interest-curve regressor (stage [2])")
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--synthetic", action="store_true",
                     help="Use synthetic EEG targets (plumbing check; no accuracy claims)")
    src.add_argument("--per-window", type=Path, metavar="CSV",
                     help="Real EEG per-window CSV (P-03 export)")
    parser.add_argument("--embeddings", action="store_true",
                        help="append SigLIP+CLAP per-window embeddings (run extract_embeddings.py first)")
    parser.add_argument("--emb-kinds", default="siglip,clap",
                        help="comma list of embedding kinds to use (siglip,clap)")
    parser.add_argument("--emb-pca", type=int, default=48, help="PCA dim for embedding block")
    parser.add_argument("--emb-dir", type=Path, default=EMB_DIR)
    parser.add_argument("--head", default="ridge", choices=["ridge", "hgb"],
                        help="estimator head for the embedding model")
    parser.add_argument("--no-hand", action="store_true",
                        help="embeddings only (drop the hand-crafted window features)")
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    synthetic = args.synthetic

    print()
    print("=" * 60)
    if synthetic:
        print("WARNING: M2 -- SYNTHETIC EEG MODE -- NOT REAL BRAIN DATA")
    else:
        print("M2 TRAIN -- REAL EEG MODE")
    print(f"   feature_schema_version = {SCHEMA_VERSION}")
    print("=" * 60)

    print("\n[1/4] Loading feature windows ...")
    feat_df = load_feature_windows(FEATURES_DIR)

    print("\n[2/4] Loading EEG targets ...")
    if synthetic:
        df = load_synth_targets(feat_df)
    else:
        df = load_real_targets(feat_df, args.per_window)

    print(f"\n  Training table: {len(df)} rows x {len(WINDOW_FEATURES)} features")
    print(f"  Videos: {df['video_id'].nunique()}   Creators: {df['creator_id'].nunique()}")
    print(f"  Window features: {WINDOW_FEATURES}")
    print(f"  Target: {TARGET}")

    feature_set = "hand"
    hand_cols = WINDOW_FEATURES
    n_emb = 0
    if args.embeddings:
        kinds = tuple(k.strip() for k in args.emb_kinds.split(",") if k.strip())
        print(f"\n[2b/4] Aligning {'+'.join(kinds)} embeddings ({args.emb_dir}) ...")
        X_emb, _emb_cols, ok = align_window_embeddings(df, args.emb_dir, kinds)
        if ok.sum() < len(df):
            print(f"  Embedding align: {int(ok.sum())}/{len(df)} window rows matched; "
                  f"dropping {int((~ok).sum())} unmatched (no silent fill)")
        df = df.loc[ok].reset_index(drop=True)
        X_emb = X_emb[ok]
        n_emb = X_emb.shape[1]
        hand_cols = [] if args.no_hand else WINDOW_FEATURES
        feature_set = ("emb" if args.no_hand else "hand+emb") + f"[{'+'.join(kinds)}]"

    print("\n[3/4] Leave-one-video-out CV ...")
    if args.embeddings:
        X_hand = (df[hand_cols].apply(pd.to_numeric, errors="coerce").to_numpy()
                  if hand_cols else np.empty((len(df), 0)))
        X = np.hstack([X_hand, X_emb])
        y_true = df[TARGET].to_numpy(dtype=float)
        vid_col = df["video_id"].to_numpy()
        print(f"  matrix: {X.shape[0]} rows x {X.shape[1]} cols "
              f"({len(hand_cols)} hand + {n_emb} emb -> PCA {args.emb_pca}); head={args.head}")
        model_fn = lambda: make_embed_pipeline(  # noqa: E731
            len(hand_cols), n_emb, head=args.head, pca_dim=args.emb_pca)
        y_pred = lovo_cv_matrix(X, y_true, vid_col, model_fn)
    else:
        y_true, y_pred, vid_col = leave_one_video_out_cv(df)

    print("\n[4/4] Computing metrics ...")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        pooled_rho = float(spearmanr(y_true, y_pred).statistic)
        pooled_r, _ = pearsonr(y_true, y_pred)
    mean_vid_pearson = per_video_pearson(y_true, y_pred, vid_col)
    mae = float(mean_absolute_error(y_true, y_pred))
    r2 = float(r2_score(y_true, y_pred))

    # Baseline: per-fold training mean (predict train mean for test windows)
    videos = df["video_id"].unique()
    base_pred = np.empty_like(y_true)
    for held_vid in videos:
        mask_te = vid_col == held_vid
        mask_tr = ~mask_te
        base_pred[mask_te] = y_true[mask_tr].mean() if mask_tr.any() else 0.5
    base_mae = float(mean_absolute_error(y_true, base_pred))
    base_r2 = float(r2_score(y_true, base_pred))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        base_rho = float(spearmanr(y_true, base_pred).statistic)

    results = {
        "data_source": ("SYNTHETIC -- plumbing only, no accuracy claims" if synthetic else "REAL EEG"),
        "synthetic": synthetic,
        "feature_schema_version": SCHEMA_VERSION,
        "n_windows": int(len(df)),
        "n_videos": int(df["video_id"].nunique()),
        "feature_set": feature_set,
        "window_features": (hand_cols if args.embeddings else WINDOW_FEATURES),
        "n_embedding_dims": int(n_emb),
        "emb_pca": (args.emb_pca if args.embeddings else None),
        "head": (args.head if args.embeddings else "hgb"),
        "target": TARGET,
        "lovo_cv": {
            "pooled_spearman": round(pooled_rho, 4),
            "pooled_pearson": round(pooled_r, 4),
            "mean_per_video_pearson": (round(mean_vid_pearson, 4) if not np.isnan(mean_vid_pearson) else None),
            "mae": round(mae, 4),
            "r2": round(r2, 4),
        },
        "baseline_lovo_train_mean": {
            "pooled_spearman": (round(base_rho, 4) if not np.isnan(base_rho) else None),
            "mae": round(base_mae, 4),
            "r2": round(base_r2, 4),
        },
    }

    plot_path = plot_curve_overlay(df, y_pred, vid_col, synthetic, OUT)

    print()
    print("=" * 60)
    if synthetic:
        print("WARNING: RESULTS ARE SYNTHETIC -- PLUMBING VALIDATION ONLY")
    print(f"M2 LOVO results  ({df['video_id'].nunique()} videos, {len(df)} windows):")
    print(f"  Pooled Spearman rho        = {pooled_rho:+.4f}")
    print(f"  Pooled Pearson r           = {pooled_r:+.4f}")
    print(f"  Mean per-video Pearson r   = {mean_vid_pearson:+.4f}")
    print(f"  MAE                        = {mae:.4f}")
    print(f"  R2                         = {r2:.4f}")
    print()
    print(f"  Baseline (LOVO training mean):")
    print(f"    MAE  = {base_mae:.4f}   R2 = {base_r2:.4f}")
    if synthetic:
        print()
        print("  NOTE: Some predictive signal is expected with synthetic data.")
        print("  The target IS a function of the features, so the model can")
        print("  partially learn it.  This only proves the plumbing works.")

    results_path = OUT / "m2_results.json"
    results_path.write_text(json.dumps(results, indent=2))
    print(f"\nWrote {results_path}")
    if plot_path:
        print(f"Wrote {plot_path}  <- HERO plot")

    if synthetic:
        print()
        print("WARNING: SYNTHETIC DATA -- NOT REAL BRAIN DATA")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
