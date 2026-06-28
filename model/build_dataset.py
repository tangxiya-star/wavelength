#!/usr/bin/env python3
"""Build the unified modeling tables (P-01 + P-02).

Joins three sources, all keyed on `video_id`:
  - model/features/feature_table.csv            (aggregate + hook features, 121 videos)
  - scripts/.../selected-videos.csv             (IG market labels)
  - server/data/exports/per_exposure_participant.csv  (app behavioral labels, 145 exposures)

Outputs:
  model/datasets/ig_labels.csv       content-intrinsic IG targets (P-01)
  model/datasets/video_level.csv     one row per video: features + IG labels + app aggregates (M1, M3)
  model/datasets/exposure_level.csv  one row per exposure: video features + behavioral outcome (M2a)

The EEG side (interest_0_1 per exposure) is intentionally absent until real sessions
run; `exposure_level` is shaped so the EEG columns slot in by an `exposure_id` join.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FEATURES = ROOT / "model/features/feature_table.csv"
IG = ROOT / "scripts/ig-reels-scraper/ig-data/selected-videos.csv"
EXPOSURES = ROOT / "server/data/exports/per_exposure_participant.csv"
OUT = ROOT / "model/datasets"


def num(df: pd.DataFrame, cols: list[str]) -> None:
    for c in cols:
        df[c] = pd.to_numeric(df[c], errors="coerce")


def build_ig_labels() -> pd.DataFrame:
    ig = pd.read_csv(IG).rename(columns={"id": "video_id", "username": "creator_id"})
    num(ig, ["views", "like_count", "comment_count", "shares"])
    ig = ig[ig["views"] > 0].copy()
    # content-intrinsic engagement rates (per view) — NOT raw views (creator-confounded)
    ig["like_rate"] = ig.like_count / ig.views
    ig["comment_rate"] = ig.comment_count / ig.views
    ig["share_rate"] = ig.shares / ig.views
    eng = ig[["like_count", "comment_count", "shares"]].sum(axis=1, min_count=1)
    ig["engagement_rate"] = eng / ig.views
    ig["views_log"] = np.log10(ig.views.clip(lower=1))
    # within-creator percentile ranks: removes each creator's baseline (5 creators only)
    g = ig.groupby("creator_id")
    ig["eng_rank_in_creator"] = g["engagement_rate"].rank(pct=True)
    ig["views_rank_in_creator"] = g["views"].rank(pct=True)
    cols = ["video_id", "creator_id", "selection_type", "views", "like_count",
            "comment_count", "shares", "views_log", "like_rate", "comment_rate",
            "share_rate", "engagement_rate", "eng_rank_in_creator", "views_rank_in_creator"]
    out = ig[cols].copy()
    out.to_csv(OUT / "ig_labels.csv", index=False)
    return out


def app_aggregates() -> pd.DataFrame:
    exp = pd.read_csv(EXPOSURES)
    num(exp, ["pct_watched", "dwell_ms", "watch_ms", "loops", "saved"])
    agg = exp.groupby("video_id").agg(
        n_exposures=("exposure_id", "count"),
        app_pct_watched=("pct_watched", "mean"),
        app_completion=("pct_watched", lambda s: float((s >= 0.9).mean())),
        app_dwell_s=("dwell_ms", lambda s: s.mean() / 1000.0),
        app_watch_s=("watch_ms", lambda s: s.mean() / 1000.0),
        app_loops=("loops", "mean"),
        app_save_rate=("saved", lambda s: float(s.fillna(0).mean())),
    ).reset_index()
    return agg, exp


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    feat = pd.read_csv(FEATURES)
    ig = build_ig_labels()
    agg, exp = app_aggregates()

    # P-02 video_level: features (carry creator_id/selection_type) + IG labels + app aggregates
    video = feat.merge(ig.drop(columns=["creator_id", "selection_type"]), on="video_id", how="left")
    video = video.merge(agg, on="video_id", how="left")
    video.to_csv(OUT / "video_level.csv", index=False)

    # M2a exposure_level: per-exposure behavioral outcome + that video's aggregate features
    feat_only = feat.drop(columns=["creator_id", "selection_type"])
    exposure = exp.merge(feat_only, on="video_id", how="left")
    exposure.to_csv(OUT / "exposure_level.csv", index=False)

    print(f"ig_labels.csv      : {len(ig)} videos")
    print(f"video_level.csv    : {len(video)} videos "
          f"({video.engagement_rate.notna().sum()} with IG labels, "
          f"{video.n_exposures.notna().sum()} seen in study)")
    print(f"exposure_level.csv : {len(exposure)} exposures "
          f"({exposure.face_present_frac.notna().sum()} matched to features)")
    print(f"creators: {video.creator_id.nunique()}  |  "
          f"engagement_rate range: {ig.engagement_rate.min():.4f}–{ig.engagement_rate.max():.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
