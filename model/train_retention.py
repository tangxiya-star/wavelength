#!/usr/bin/env python3
"""M2a — Behavioral retention-curve model  (pipeline stage [2], EEG-free hero).

Reconstruct per-video drop-off curves from positionMs heartbeats, join to feature
windows[], train features -> retention_0_1 with leave-one-video-out CV.

Demo visual: predicted drop-off vs actual behavioral drop-off for a held-out video.

Data:
  --events CSV   Raw events export (default: demo-log-events.csv or server export)

Outputs (model/out/):
  m2a_results.json
  m2a_curve_overlay.png   <- HERO: predicted vs actual behavioral drop-off
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
from sklearn.metrics import mean_absolute_error, r2_score

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "model" / "out"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from behavioral_curves import build_retention_table, default_events_path  # noqa: E402
from train_interest import (  # noqa: E402
    FEATURES_DIR,
    SCHEMA_VERSION,
    WINDOW_FEATURES,
    build_model,
    leave_one_video_out_cv,
    load_feature_windows,
    per_video_pearson,
)

TARGET = "retention_0_1"


def load_behavioral_targets(feat_df: pd.DataFrame, events_csv: Path) -> tuple[pd.DataFrame, dict]:
    beh, summary = build_retention_table(events_csv, FEATURES_DIR)
    print(f"  Events: {summary['n_events']} rows -> {summary['n_exposures_used']} exposures")
    print(f"  Behavioral curves: {summary['n_videos_with_curves']} videos, "
          f"{summary['n_windows']} windows")
    if summary["n_videos_skipped_no_features"]:
        print(f"  Skipped {summary['n_videos_skipped_no_features']} event videos "
              f"(no feature JSON / duration)")

    merged = feat_df.merge(beh[["video_id", "t", TARGET, "n_exposures"]],
                           on=["video_id", "t"], how="inner")
    merged["_synthetic"] = False
    dropped_videos = set(feat_df["video_id"].unique()) - set(merged["video_id"].unique())
    if dropped_videos:
        print(f"  Feature videos without behavioral data: {len(dropped_videos)}")
    print(f"  Joined: {len(merged)} per-window rows across {merged['video_id'].nunique()} videos")
    summary["n_merged_windows"] = int(len(merged))
    summary["n_merged_videos"] = int(merged["video_id"].nunique())
    return merged, summary


def plot_curve_overlay(
    df: pd.DataFrame,
    y_pred_all: np.ndarray,
    vid_col: np.ndarray,
    out_dir: Path,
    held_out_hint: Optional[str] = None,
) -> Optional[str]:
    """HERO: predicted vs actual behavioral drop-off for one held-out video."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return None

    videos, counts = np.unique(vid_col, return_counts=True)
    if held_out_hint and held_out_hint in videos:
        best_vid = held_out_hint
    else:
        # Prefer a video with a non-flat curve (drop-off visible) and enough windows.
        best_vid = videos[np.argmax(counts)]
        best_score = -1.0
        for v in videos:
            mask = vid_col == v
            if mask.sum() < 6:
                continue
            y = df[TARGET].to_numpy(dtype=float)[mask]
            spread = float(np.nanmax(y) - np.nanmin(y))
            score = spread * mask.sum()
            if score > best_score:
                best_score = score
                best_vid = v

    mask = vid_col == best_vid
    t_vals = df["t"].to_numpy()[mask]
    y_true = df[TARGET].to_numpy(dtype=float)[mask]
    y_pred = y_pred_all[mask]
    n_exp = int(df.loc[mask, "n_exposures"].iloc[0]) if mask.any() else 0
    order = np.argsort(t_vals)
    t_vals, y_true, y_pred = t_vals[order], y_true[order], y_pred[order]

    fig, ax = plt.subplots(figsize=(11, 4))
    ax.plot(t_vals, y_true, color="#2196F3", linewidth=2.0, label="Behavioral drop-off (actual)")
    ax.plot(t_vals, y_pred, color="#FF5722", linewidth=2.0, linestyle="--",
            label="Predicted (LOVO)")
    ax.fill_between(t_vals, y_true, y_pred, alpha=0.12, color="gray")
    ax.set_xlabel("Time (s)", fontsize=11)
    ax.set_ylabel("retention_0_1  (fraction still watching)", fontsize=11)
    ax.set_ylim(-0.02, 1.02)
    ax.legend(fontsize=9)
    ax.set_title(
        f"M2a behavioral retention overlay — {best_vid}\n"
        f"(n={n_exp} exposures, LOVO held-out curve)",
        fontsize=11,
    )
    fig.tight_layout()
    out_path = out_dir / "m2a_curve_overlay.png"
    fig.savefig(out_path, dpi=130)
    plt.close(fig)
    return str(out_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Train M2a behavioral retention curve (stage [2] EEG-free)")
    parser.add_argument("--events", type=Path, default=None,
                        help="Events CSV (default: server export or demo-log-events.csv)")
    args = parser.parse_args()

    events_csv = args.events or default_events_path()
    if events_csv is None or not events_csv.exists():
        print("ERROR: no events CSV found. Pass --events or export with npm run data:export")
        return 1

    OUT.mkdir(parents=True, exist_ok=True)

    print()
    print("=" * 60)
    print("M2a TRAIN — BEHAVIORAL RETENTION (real app data, EEG-free)")
    print(f"   feature_schema_version = {SCHEMA_VERSION}")
    print(f"   events = {events_csv}")
    print("=" * 60)

    print("\n[1/4] Loading feature windows ...")
    feat_df = load_feature_windows(FEATURES_DIR)

    print("\n[2/4] Reconstructing behavioral drop-off curves ...")
    df, beh_summary = load_behavioral_targets(feat_df, events_csv)
    if len(df) < 10 or df["video_id"].nunique() < 2:
        print("ERROR: not enough merged data to train (need >=2 videos, >=10 windows)")
        return 1

    print(f"\n  Training table: {len(df)} rows x {len(WINDOW_FEATURES)} features")
    print(f"  Videos: {df['video_id'].nunique()}   Creators: {df['creator_id'].nunique()}")
    print(f"  Window features: {WINDOW_FEATURES}")
    print(f"  Target: {TARGET}")

    print("\n[3/4] Leave-one-video-out CV ...")
    y_true, y_pred, vid_col = leave_one_video_out_cv(df, target=TARGET)

    print("\n[4/4] Computing metrics ...")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        pooled_rho = float(spearmanr(y_true, y_pred).statistic)
        pooled_r, _ = pearsonr(y_true, y_pred)
    mean_vid_pearson = per_video_pearson(y_true, y_pred, vid_col)
    mae = float(mean_absolute_error(y_true, y_pred))
    r2 = float(r2_score(y_true, y_pred))

    videos = df["video_id"].unique()
    base_pred = np.empty_like(y_true)
    for held_vid in videos:
        mask_te = vid_col == held_vid
        mask_tr = ~mask_te
        base_pred[mask_te] = y_true[mask_tr].mean() if mask_tr.any() else 1.0
    base_mae = float(mean_absolute_error(y_true, base_pred))
    base_r2 = float(r2_score(y_true, base_pred))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        base_rho = float(spearmanr(y_true, base_pred).statistic)

    # Pick held-out video with median per-video Pearson for the hero plot annotation
    vid_pearsons = []
    for v in pd.unique(vid_col):
        mask = vid_col == v
        if mask.sum() < 4:
            continue
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            r, _ = pearsonr(y_true[mask], y_pred[mask])
        if not np.isnan(r):
            vid_pearsons.append((v, float(r)))
    hero_vid = sorted(vid_pearsons, key=lambda x: x[1])[len(vid_pearsons) // 2][0] if vid_pearsons else None

    results = {
        "model": "M2a",
        "data_source": "REAL behavioral (video_watch_progress + scroll_away)",
        "synthetic": False,
        "feature_schema_version": SCHEMA_VERSION,
        "events_csv": str(events_csv),
        "behavioral_summary": beh_summary,
        "n_windows": int(len(df)),
        "n_videos": int(df["video_id"].nunique()),
        "window_features": WINDOW_FEATURES,
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
        "hero_video_id": hero_vid,
    }

    plot_path = plot_curve_overlay(df, y_pred, vid_col, OUT, held_out_hint=hero_vid)

    print()
    print("=" * 60)
    print(f"M2a LOVO results  ({df['video_id'].nunique()} videos, {len(df)} windows):")
    print(f"  Pooled Spearman rho        = {pooled_rho:+.4f}")
    print(f"  Pooled Pearson r           = {pooled_r:+.4f}")
    print(f"  Mean per-video Pearson r   = {mean_vid_pearson:+.4f}")
    print(f"  MAE                        = {mae:.4f}")
    print(f"  R2                         = {r2:.4f}")
    print()
    print("  Baseline (LOVO training mean retention):")
    print(f"    MAE  = {base_mae:.4f}   R2 = {base_r2:.4f}   rho = {base_rho:+.4f}")

    results_path = OUT / "m2a_results.json"
    results_path.write_text(json.dumps(results, indent=2))
    print(f"\nWrote {results_path}")
    if plot_path:
        print(f"Wrote {plot_path}  <- HERO plot (predicted vs actual drop-off)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
