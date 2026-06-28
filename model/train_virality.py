#!/usr/bin/env python3
"""M1 — virality / engagement regressor.

Predicts content-intrinsic IG engagement from offline video features. With only 5
creators (all study-niche), the honest evaluation is **leave-one-creator-out**: the
model must score a creator it never trained on. The headline metric is the
**mean within-held-out-creator Spearman** — "for a creator we've never seen, do our
predicted scores rank their videos in the right order?" — plus pooled Spearman, MAE
and R2 vs a global-mean baseline.

Outputs (model/out/):
  m1_results.json                      metrics per target × model
  m1_importance_<target>.png           permutation importance (in-sample, directional)
  m1_pred_vs_actual_<target>.png       OOF predictions vs actual, coloured by creator
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scipy.stats import spearmanr
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import LeaveOneGroupOut, cross_val_predict
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "model/out"

CONTROL = ["duration_s", "aspect_ratio", "src_fps"]
PACING = ["cuts_per_sec", "time_to_first_cut", "mean_shot_len", "shot_len_std", "scene_cut_count"]
VISUAL = ["motion_mean", "face_present_frac", "is_talking_head",
          "brightness_mean", "colorfulness_mean", "saturation_mean", "contrast_mean"]
AUDIO = ["loudness_mean_db", "silence_fraction", "onset_density",
         "spectral_centroid_hz", "dynamic_range_db", "speech_present", "music_present"]
TEXT = ["ocr_text_presence_ratio", "likely_subtitles", "transcript_wps_mean"]
HOOK = ["hook_face", "hook_text_present", "hook_cuts", "hook_loudness", "opening_curiosity"]
FEATURES = CONTROL + PACING + VISUAL + AUDIO + TEXT + HOOK

TARGETS = ["engagement_rate", "like_rate", "eng_rank_in_creator"]


def models() -> dict[str, Pipeline]:
    return {
        "hgb": Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("m", HistGradientBoostingRegressor(
                max_depth=3, learning_rate=0.05, max_iter=300,
                l2_regularization=1.0, random_state=0)),
        ]),
        "ridge": Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("m", Ridge(alpha=2.0)),
        ]),
    }


def within_group_spearman(y, yhat, groups) -> float:
    """Mean Spearman computed inside each held-out group (>=4 samples), n-weighted."""
    vals, weights = [], []
    for g in pd.unique(groups):
        mask = groups == g
        if mask.sum() < 4:
            continue
        rho = spearmanr(y[mask], yhat[mask]).statistic
        if not np.isnan(rho):
            vals.append(rho)
            weights.append(mask.sum())
    return float(np.average(vals, weights=weights)) if vals else float("nan")


def evaluate(df: pd.DataFrame, target: str, emb_cols: list[str] | None = None,
             head: str = "ridge", pca: int = 24) -> dict:
    d = df.dropna(subset=[target]).reset_index(drop=True)
    feats = FEATURES + (emb_cols or [])
    X = d[feats].apply(pd.to_numeric, errors="coerce")
    X["likely_subtitles"] = X["likely_subtitles"].fillna(0)
    X_arr = X.to_numpy(dtype=float)
    y = d[target].to_numpy(dtype=float)
    groups = d["creator_id"].to_numpy()
    logo = LeaveOneGroupOut()

    if emb_cols:
        from embed_store import make_embed_pipeline
        mdls = {f"{head}_emb": make_embed_pipeline(
            len(FEATURES), len(emb_cols), head=head, pca_dim=pca)}
    else:
        mdls = models()

    result = {"target": target, "n": len(d), "creators": int(d.creator_id.nunique())}
    preds = {}
    for name, pipe in mdls.items():
        yhat = cross_val_predict(pipe, X_arr, y, groups=groups, cv=logo)
        preds[name] = yhat
        result[name] = {
            "within_creator_spearman": round(within_group_spearman(y, yhat, groups), 4),
            "pooled_spearman": round(float(spearmanr(y, yhat).statistic), 4),
            "mae": round(float(mean_absolute_error(y, yhat)), 5),
            "r2": round(float(r2_score(y, yhat)), 4),
        }
    # baseline: per-fold global mean (creator held out -> predicts other creators' mean)
    base = np.empty_like(y)
    for tr, te in logo.split(X, y, groups):
        base[te] = y[tr].mean()
    result["baseline_globalmean"] = {
        "pooled_spearman": 0.0,
        "mae": round(float(mean_absolute_error(y, base)), 5),
        "r2": round(float(r2_score(y, base)), 4),
    }
    return result, d, X, y, preds


def plot_importance(X, y, target):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return
    pipe = models()["hgb"].fit(X, y)
    imp = permutation_importance(pipe, X, y, n_repeats=20, random_state=0,
                                 scoring="neg_mean_absolute_error")
    order = np.argsort(imp.importances_mean)[-15:]
    plt.figure(figsize=(7, 5))
    plt.barh([FEATURES[i] for i in order], imp.importances_mean[order], color="#4c78a8")
    plt.title(f"M1 permutation importance — {target}\n(in-sample, directional)")
    plt.xlabel("mean MAE increase when shuffled")
    plt.tight_layout()
    plt.savefig(OUT / f"m1_importance_{target}.png", dpi=130)
    plt.close()


def plot_pred(d, y, yhat, target):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return
    plt.figure(figsize=(6, 6))
    for g in pd.unique(d.creator_id):
        m = d.creator_id.to_numpy() == g
        plt.scatter(y[m], yhat[m], label=g, alpha=0.7)
    lo, hi = float(min(y.min(), yhat.min())), float(max(y.max(), yhat.max()))
    plt.plot([lo, hi], [lo, hi], "k--", lw=1)
    plt.xlabel(f"actual {target}")
    plt.ylabel("predicted (leave-one-creator-out)")
    plt.title(f"M1 OOF predictions — {target}")
    plt.legend(fontsize=7)
    plt.tight_layout()
    plt.savefig(OUT / f"m1_pred_vs_actual_{target}.png", dpi=130)
    plt.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="Train M1 virality/engagement regressor")
    ap.add_argument("--embeddings", action="store_true",
                    help="append pooled SigLIP+CLAP embeddings (run extract_embeddings.py first)")
    ap.add_argument("--emb-kinds", default="siglip,clap")
    ap.add_argument("--emb-pca", type=int, default=24, help="PCA dim for pooled embedding block")
    ap.add_argument("--head", default="ridge", choices=["ridge", "hgb"])
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(ROOT / "model/datasets/video_level.csv")

    emb_cols = None
    if args.embeddings:
        from embed_store import EMB_DIR, video_pooled_embeddings
        kinds = tuple(k.strip() for k in args.emb_kinds.split(",") if k.strip())
        pooled, emb_cols = video_pooled_embeddings(df["video_id"].tolist(), EMB_DIR, kinds)
        df = df.merge(pooled, on="video_id", how="left")
        before = len(df)
        df = df[df[emb_cols[0]].notna()].reset_index(drop=True)
        print(f"  embeddings ({'+'.join(kinds)}): {len(df)}/{before} videos covered "
              f"(pooled mean+std, {len(emb_cols)} dims -> PCA {args.emb_pca}); head={args.head}")

    all_results = []
    for target in TARGETS:
        res, d, X, y, preds = evaluate(df, target, emb_cols, args.head, args.emb_pca)
        all_results.append(res)
        model_names = list(preds.keys())
        best = max(model_names, key=lambda m: res[m]["within_creator_spearman"]
                   if not np.isnan(res[m]["within_creator_spearman"]) else -9)
        if not emb_cols:
            plot_importance(X, y, target)
        plot_pred(d, y, preds[best], target)
        print(f"\n=== {target}  (n={res['n']}, {res['creators']} creators) ===")
        for m in model_names + ["baseline_globalmean"]:
            r = res[m]
            wc = r.get("within_creator_spearman", "—")
            print(f"  {m:20s} within-creator ρ={wc!s:>7}  pooled ρ={r.get('pooled_spearman','—')!s:>7}  "
                  f"MAE={r['mae']:.5f}  R²={r['r2']}")

    out_name = "m1_results_emb.json" if emb_cols else "m1_results.json"
    (OUT / out_name).write_text(json.dumps(all_results, indent=2))
    print(f"\nwrote {OUT/out_name}" + ("" if emb_cols else " + importance/pred plots"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
