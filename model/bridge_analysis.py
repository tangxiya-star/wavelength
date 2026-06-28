#!/usr/bin/env python3
"""M3 — the behavioral bridge (no EEG required).

Tests the core thesis on REAL data we already have, using in-app retention as the
human-attention stand-in for EEG until sessions run:

  A. Does in-app RETENTION predict IG VIRALITY?      (retention -> engagement)
  B. Can FEATURES predict real human RETENTION?       (features -> retention; the
     real-data proxy for stage [2], cf. the synthetic-EEG path)
  C. Reminder baseline: FEATURES -> VIRALITY is null  (from train_virality.py)

The story we expect (and report honestly with N + p-values): features predict
*attention* better than they predict *virality* directly, and attention predicts
virality — so routing virality through attention (and its deepest form, EEG) is the
right architecture.

Outputs (model/out/):
  bridge_results.json
  bridge_retention_vs_virality.png
  bridge_features_to_retention_importance.png
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.model_selection import LeaveOneGroupOut, cross_val_predict
from sklearn.pipeline import Pipeline

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "model/out"

# same feature set as train_virality.py (M1 direct baseline) for apples-to-apples
from train_virality import FEATURES  # noqa: E402  (sibling module)


def hgb() -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("m", HistGradientBoostingRegressor(
            max_depth=3, learning_rate=0.05, max_iter=300,
            l2_regularization=1.0, random_state=0)),
    ])


def corr_block(df: pd.DataFrame, retention_cols, virality_cols) -> list[dict]:
    rows = []
    for rc in retention_cols:
        for vc in virality_cols:
            d = df.dropna(subset=[rc, vc])
            if len(d) < 5:
                continue
            r = spearmanr(d[rc], d[vc])
            rows.append({"retention": rc, "virality": vc, "n": len(d),
                         "spearman": round(float(r.statistic), 3),
                         "p_value": round(float(r.pvalue), 3)})
    return rows


def predict_oof(d: pd.DataFrame, target: str):
    dd = d.dropna(subset=[target]).reset_index(drop=True)
    X = dd[FEATURES].apply(pd.to_numeric, errors="coerce")
    X["likely_subtitles"] = X["likely_subtitles"].fillna(0)
    y = dd[target].to_numpy(float)
    groups = dd["creator_id"].to_numpy()
    yhat = cross_val_predict(hgb(), X, y, groups=groups, cv=LeaveOneGroupOut())
    rho = spearmanr(y, yhat).statistic
    return dd, X, y, yhat, float(rho)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    df = pd.read_csv(ROOT / "model/datasets/video_level.csv")
    seen = df[df["n_exposures"].notna()].copy()  # videos shown in the study
    results = {"n_videos_with_app_data": int(len(seen))}

    # ---- A. retention -> virality, at increasing per-video reliability ----
    ret = ["app_pct_watched", "app_completion", "app_dwell_s"]
    vir = ["engagement_rate", "like_rate", "views_log"]
    results["A_retention_vs_virality"] = {}
    for min_exp in (1, 2, 3):
        sub = seen[seen["n_exposures"] >= min_exp]
        results["A_retention_vs_virality"][f">={min_exp}_exposures"] = {
            "n_videos": int(len(sub)), "correlations": corr_block(sub, ret, vir)}

    # ---- B. features -> real human retention (stage-2 proxy) ----
    dd, X, y, yhat, rho_ret = predict_oof(seen, "app_pct_watched")
    results["B_features_to_retention"] = {
        "target": "app_pct_watched", "n": int(len(dd)),
        "within_creator_loo_spearman": round(rho_ret, 3)}

    # ---- C. features -> virality, SAME 68-video subset (apples-to-apples baseline) ----
    _, _, _, _, rho_vir = predict_oof(seen, "engagement_rate")
    results["C_features_to_virality_same_subset"] = {
        "target": "engagement_rate", "within_creator_loo_spearman": round(rho_vir, 3)}

    # ---- plots ----
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        sub = seen[seen["n_exposures"] >= 2].dropna(subset=["app_pct_watched", "engagement_rate"])
        plt.figure(figsize=(6, 5))
        for g in pd.unique(sub.creator_id):
            m = sub.creator_id == g
            plt.scatter(sub[m].app_pct_watched, sub[m].engagement_rate, label=g, alpha=0.75)
        rr = spearmanr(sub.app_pct_watched, sub.engagement_rate)
        plt.xlabel("in-app retention (mean pct_watched)")
        plt.ylabel("IG engagement_rate")
        plt.title(f"Retention → virality  (≥2 exposures, n={len(sub)})\n"
                  f"Spearman ρ={rr.statistic:.2f}, p={rr.pvalue:.2f}")
        plt.legend(fontsize=7)
        plt.tight_layout()
        plt.savefig(OUT / "bridge_retention_vs_virality.png", dpi=130)
        plt.close()

        pipe = hgb().fit(X, y)
        imp = permutation_importance(pipe, X, y, n_repeats=20, random_state=0,
                                     scoring="neg_mean_absolute_error")
        order = np.argsort(imp.importances_mean)[-12:]
        plt.figure(figsize=(7, 5))
        plt.barh([FEATURES[i] for i in order], imp.importances_mean[order], color="#e45756")
        plt.title("What features drive REAL human retention\n(in-sample, directional)")
        plt.tight_layout()
        plt.savefig(OUT / "bridge_features_to_retention_importance.png", dpi=130)
        plt.close()
    except Exception as e:
        results["plot_error"] = str(e)

    (OUT / "bridge_results.json").write_text(json.dumps(results, indent=2))

    # ---- console summary ----
    print(f"videos with app data: {len(seen)}")
    print("\nA. RETENTION -> VIRALITY (Spearman ρ, p):")
    for thr, block in results["A_retention_vs_virality"].items():
        hits = [c for c in block["correlations"]
                if c["retention"] == "app_pct_watched" and c["virality"] in ("engagement_rate", "views_log")]
        s = "  ".join(f"{c['virality']}: ρ={c['spearman']} (p={c['p_value']})" for c in hits)
        print(f"  {thr:16s} n={block['n_videos']:3d}   pct_watched vs  {s}")
    print(f"\nB. FEATURES -> RETENTION  (within-creator LOO ρ): {rho_ret:.3f}   (n={len(dd)})")
    print(f"C. FEATURES -> VIRALITY   (same subset, baseline):  {rho_vir:.3f}")
    print("\n-> features track human ATTENTION better than they track VIRALITY directly"
          if rho_ret > rho_vir else "\n-> (features->retention not above features->virality here; note small N)")
    print(f"wrote {OUT/'bridge_results.json'} + 2 plots")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
