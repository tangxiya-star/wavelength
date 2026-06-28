#!/usr/bin/env python3
"""M1-via-EEG -- Virality regressor via EEG summary vector  (pipeline stage [3]).

EEG summary vector {mean_interest, auc, hook_interest, peak, dip, slope,
frac_above_0.5} -> IG engagement_rate / like_rate.

Evaluation: leave-one-creator-out CV -- identical protocol to the direct-
features M1 baseline (train_virality.py) so results are directly comparable.
Anti-leakage: group CV by creator_id; a creator never spans train + test.

Data sources (pick one):
  --synthetic         Derives EEG summary vectors from synth_eeg.py curves.
                      WARNING: PLUMBING CHECK ONLY -- no accuracy claims.
                      All output labeled SYNTHETIC.
  --eeg-summary CSV   Real per-video EEG summary (mean over participants):
                        video_id, mean_interest, auc, hook_interest,
                        peak, dip, slope, frac_above_0.5
                      Produce from hardware/analysis/ by averaging
                      per-exposure EEG summaries by video_id.

Outputs (model/out/):
  m3_eeg_results.json
  m3_eeg_pred_vs_actual_<target>.png
  Side-by-side console printout vs M1 direct baseline (m1_results.json).

WHAT TO CHANGE WHEN REAL EEG ARRIVES:
  1. Average hardware/analysis/out/<id>_per_exposure.csv by video_id ->
     real per-video EEG summary CSV.
  2. python3 model/train_virality_from_eeg.py --eeg-summary <csv>
  Nothing else changes.
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import LeaveOneGroupOut, cross_val_predict
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "model" / "out"
SCHEMA_VERSION = "2.0"

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Stage [2]->[3] summary vector
EEG_SUMMARY_FEATURES = [
    "mean_interest",   # mean interest_0_1 over all windows
    "auc",             # trapezoidal AUC / duration
    "hook_interest",   # mean interest_0_1 for t < 3.0 s
    "peak",            # max interest_0_1
    "dip",             # min interest_0_1
    "slope",           # linear-regression slope of interest_0_1 vs t
    "frac_above_0.5",  # fraction of windows with interest_0_1 > 0.5
]

TARGETS = ["engagement_rate", "like_rate"]


# ── models ────────────────────────────────────────────────────────────────────

def _models():
    return {
        "hgb": Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("m", HistGradientBoostingRegressor(
                max_depth=3, learning_rate=0.05, max_iter=300,
                l2_regularization=1.0, random_state=0,
            )),
        ]),
        "ridge": Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("m", Ridge(alpha=2.0)),
        ]),
    }


def _within_group_spearman(y, yhat, groups) -> float:
    vals, weights = [], []
    for g in pd.unique(groups):
        mask = groups == g
        if mask.sum() < 4:
            continue
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            rho = spearmanr(y[mask], yhat[mask]).statistic
        if not np.isnan(rho):
            vals.append(rho)
            weights.append(int(mask.sum()))
    return float(np.average(vals, weights=weights)) if vals else float("nan")


# ── data loading ──────────────────────────────────────────────────────────────

def _load_ig_labels() -> pd.DataFrame:
    path = ROOT / "model" / "datasets" / "ig_labels.csv"
    df = pd.read_csv(path)
    print(f"  IG labels: {len(df)} videos, {df['creator_id'].nunique()} creators")
    return df


def load_synth_eeg_summaries() -> pd.DataFrame:
    """Build EEG summary vectors for all feature videos using synth_eeg.py."""
    from synth_eeg import build_synth_dataset, eeg_summary_vector

    print()
    print("!" * 60)
    print("!  DATA SOURCE: SYNTHETIC EEG -- NOT REAL BRAIN DATA        !")
    print("!  Results are PLUMBING VALIDATION ONLY.                    !")
    print("!  No accuracy claims.                                       !")
    print("!" * 60)

    eeg_df = build_synth_dataset()
    rows = []
    for vid, grp in eeg_df.groupby("video_id"):
        sv = eeg_summary_vector(grp.to_dict("records"))
        sv["video_id"] = vid
        sv["_synthetic"] = True
        rows.append(sv)
    df = pd.DataFrame(rows)
    print(f"  Built synthetic EEG summary vectors for {len(df)} videos")
    return df


def load_real_eeg_summaries(eeg_summary_csv: Path) -> pd.DataFrame:
    """
    Load real per-video EEG summary CSV.

    Expected schema (averages over participants):
        video_id, mean_interest, auc, hook_interest, peak, dip, slope, frac_above_0.5

    Produce this file by:
        hardware/analysis/join_eeg.py -> per_exposure CSV
        group by video_id, mean() each EEG summary field
        write CSV with the columns above.
    """
    df = pd.read_csv(eeg_summary_csv)
    required = {"video_id"} | set(EEG_SUMMARY_FEATURES)
    missing = required - set(df.columns)
    if missing:
        raise ValueError(
            f"--eeg-summary CSV missing required columns: {missing}\n"
            f"  Expected: video_id + {EEG_SUMMARY_FEATURES}"
        )
    df["_synthetic"] = False
    print(f"  Real EEG summaries: {len(df)} videos loaded from {eeg_summary_csv}")
    return df


# ── evaluation ────────────────────────────────────────────────────────────────

def _evaluate_target(df: pd.DataFrame, target: str):
    d = df.dropna(subset=[target]).reset_index(drop=True)
    X = d[EEG_SUMMARY_FEATURES].apply(pd.to_numeric, errors="coerce")
    y = d[target].to_numpy(dtype=float)
    groups = d["creator_id"].to_numpy()
    logo = LeaveOneGroupOut()

    result = {
        "target": target,
        "n": int(len(d)),
        "creators": int(d["creator_id"].nunique()),
        "eeg_features": EEG_SUMMARY_FEATURES,
    }
    preds = {}
    for name, pipe in _models().items():
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            yhat = cross_val_predict(pipe, X, y, groups=groups, cv=logo)
        preds[name] = yhat
        result[name] = {
            "within_creator_spearman": round(_within_group_spearman(y, yhat, groups), 4),
            "pooled_spearman": round(float(spearmanr(y, yhat).statistic), 4),
            "mae": round(float(mean_absolute_error(y, yhat)), 5),
            "r2": round(float(r2_score(y, yhat)), 4),
        }

    # Baseline: per-fold training mean
    base = np.empty_like(y)
    for tr, te in logo.split(X, y, groups):
        base[te] = y[tr].mean()
    result["baseline_globalmean"] = {
        "pooled_spearman": 0.0,
        "mae": round(float(mean_absolute_error(y, base)), 5),
        "r2": round(float(r2_score(y, base)), 4),
    }
    return result, d, y, preds


# ── plots ─────────────────────────────────────────────────────────────────────

def _plot_pred(d, y, yhat, target, synthetic, out_dir):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return
    fig, ax = plt.subplots(figsize=(6, 6))
    for g in pd.unique(d["creator_id"]):
        mask = d["creator_id"].to_numpy() == g
        ax.scatter(y[mask], yhat[mask], label=g, alpha=0.75)
    lo = float(min(y.min(), yhat.min()))
    hi = float(max(y.max(), yhat.max()))
    ax.plot([lo, hi], [lo, hi], "k--", lw=1)
    ax.set_xlabel(f"actual {target}", fontsize=11)
    ax.set_ylabel("predicted (leave-one-creator-out)", fontsize=11)
    synth_tag = "  [SYNTHETIC]" if synthetic else ""
    ax.set_title(f"M1-via-EEG -- {target}{synth_tag}", fontsize=11)
    ax.legend(fontsize=7)
    fig.tight_layout()
    fig.savefig(out_dir / f"m3_eeg_pred_vs_actual_{target}.png", dpi=130)
    plt.close(fig)


# ── side-by-side comparison ───────────────────────────────────────────────────

def _print_side_by_side(eeg_results, m1_baseline, synthetic):
    print()
    print("=" * 72)
    print("  SIDE-BY-SIDE: M1-via-EEG  vs  M1-direct-features baseline")
    if synthetic:
        print("  WARNING: EEG PATH USES SYNTHETIC DATA -- NO ACCURACY CLAIMS")
    print("=" * 72)
    hdr = f"  {'Model':<36s}  {'within-creator rho':>18s}  {'pooled rho':>10s}  {'MAE':>10s}"
    sep = "  " + "-" * 78
    for eeg_res in eeg_results:
        target = eeg_res["target"]
        print(f"\n  Target: {target}   (n={eeg_res['n']} videos, {eeg_res['creators']} creators)")
        print(hdr)
        print(sep)
        best_eeg = max(
            ("hgb", "ridge"),
            key=lambda m: eeg_res[m]["within_creator_spearman"]
            if not np.isnan(eeg_res[m]["within_creator_spearman"]) else -9,
        )
        er = eeg_res[best_eeg]
        synth_tag = " [SYNTH]" if synthetic else ""
        print(
            f"  {'M1-via-EEG ('+best_eeg+')'+synth_tag:<36s}"
            f"  {er['within_creator_spearman']:>18.4f}"
            f"  {er['pooled_spearman']:>10.4f}"
            f"  {er['mae']:>10.5f}"
        )
        if m1_baseline:
            m1 = next((r for r in m1_baseline if r["target"] == target), None)
            if m1:
                best_m1 = max(
                    ("hgb", "ridge"),
                    key=lambda m: m1[m]["within_creator_spearman"]
                    if not np.isnan(m1[m]["within_creator_spearman"]) else -9,
                )
                mr = m1[best_m1]
                print(
                    f"  {'M1-direct-features ('+best_m1+')':<36s}"
                    f"  {mr['within_creator_spearman']:>18.4f}"
                    f"  {mr['pooled_spearman']:>10.4f}"
                    f"  {mr['mae']:>10.5f}"
                )
        bl = eeg_res["baseline_globalmean"]
        print(
            f"  {'baseline (global mean)':<36s}"
            f"  {'--':>18s}"
            f"  {0.0:>10.4f}"
            f"  {bl['mae']:>10.5f}"
        )
    if synthetic:
        print()
        print("  NOTE: With synthetic data, EEG summary vectors carry feature")
        print("  signal (the synthetic formula IS a function of features), so")
        print("  some predictive lift is expected.  Compare only after real EEG.")
    print()


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Train M1-via-EEG virality model (stage [3])"
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--synthetic", action="store_true",
                     help="Use synthetic EEG summaries (plumbing check only)")
    src.add_argument("--eeg-summary", type=Path, metavar="CSV",
                     help="Real per-video EEG summary CSV")
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    synthetic = args.synthetic

    print()
    print("=" * 60)
    if synthetic:
        print("WARNING: M1-via-EEG -- SYNTHETIC EEG MODE -- NOT REAL BRAIN DATA")
    else:
        print("M1-via-EEG -- REAL EEG MODE")
    print(f"   feature_schema_version = {SCHEMA_VERSION}")
    print("=" * 60)

    print("\n[1/4] Loading EEG summary vectors ...")
    if synthetic:
        eeg_df = load_synth_eeg_summaries()
    else:
        eeg_df = load_real_eeg_summaries(args.eeg_summary)

    print("\n[2/4] Loading IG labels ...")
    ig = _load_ig_labels()

    print("\n[3/4] Joining and running leave-one-creator-out CV ...")
    df = eeg_df.merge(
        ig[["video_id", "creator_id"] + TARGETS + ["eng_rank_in_creator"]],
        on="video_id", how="inner",
    )
    n_eeg = eeg_df["video_id"].nunique()
    n_ig = ig["video_id"].nunique()
    n_joined = df["video_id"].nunique()
    print(f"  Join: {n_eeg} EEG videos x {n_ig} IG videos = {n_joined} matched")
    print(f"  EEG features: {EEG_SUMMARY_FEATURES}")
    if n_joined == 0:
        print("ERROR: No rows after join -- check video_id alignment.")
        return 1

    all_results = []
    for target in TARGETS:
        res, d, y, preds = _evaluate_target(df, target)
        res["data_source"] = "SYNTHETIC -- plumbing only" if synthetic else "REAL EEG"
        res["synthetic"] = synthetic
        all_results.append(res)
        best = max(
            ("hgb", "ridge"),
            key=lambda m: res[m]["within_creator_spearman"]
            if not np.isnan(res[m]["within_creator_spearman"]) else -9,
        )
        _plot_pred(d, y, preds[best], target, synthetic, OUT)

    print("\n[4/4] Loading M1 direct-features baseline for comparison ...")
    m1_path = OUT / "m1_results.json"
    m1_baseline = None
    if m1_path.exists():
        m1_baseline = json.loads(m1_path.read_text())
        print(f"  Loaded {m1_path}")
    else:
        print(f"  {m1_path} not found -- run train_virality.py first for comparison")

    print()
    print("=" * 60)
    if synthetic:
        print("WARNING: RESULTS ARE SYNTHETIC -- PLUMBING VALIDATION ONLY")
    print(f"M1-via-EEG  ({df['video_id'].nunique()} videos, {df['creator_id'].nunique()} creators):")
    for res in all_results:
        target = res["target"]
        print(f"\n  {target}  (n={res['n']}):")
        for m in ("hgb", "ridge", "baseline_globalmean"):
            r = res[m]
            wc = r.get("within_creator_spearman", "--")
            ps = r.get("pooled_spearman", "--")
            print(f"    {m:<22s}  within-creator rho={wc!s:>7}  "
                  f"pooled rho={ps!s:>7}  MAE={r['mae']:.5f}  R2={r['r2']}")

    _print_side_by_side(all_results, m1_baseline, synthetic)

    out_path = OUT / "m3_eeg_results.json"
    out_path.write_text(json.dumps(all_results, indent=2))
    print(f"Wrote {out_path}")
    for t in TARGETS:
        print(f"Wrote {OUT / f'm3_eeg_pred_vs_actual_{t}.png'}")

    if synthetic:
        print()
        print("WARNING: SYNTHETIC DATA -- NOT REAL BRAIN DATA")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
