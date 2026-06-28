#!/usr/bin/env python3
"""M2b-transfer — beat the small EEG N by pretraining on a large-N source.

The EEG interest target is tiny (~20 videos). Embeddings give a *shared* feature
space, so we can pretrain an embedding->retention head on a much larger source
and carry that prior into the EEG model. This script reports an honest ablation:

  [0] baseline        LOVO train-mean of EEG interest
  [1] hand            hand-crafted window features only          (the current bar)
  [2] emb             SigLIP+CLAP embeddings only (no transfer)
  [3] hand+emb        both, no transfer
  [4] transfer        hand + a source-pretrained prior feature   (the lift)

Transfer method = prior-feature stacking (robust at tiny N, scale-invariant):
per held-out EEG video V, fit the source head on source rows EXCLUDING V, use
its prediction on each window as one extra feature for the EEG ridge. V never
informs its own prior -> no leakage.

Source options (--source):
  behavioral   app drop-off curves (build_retention_table on events.csv).
               Runs now, no download. Large-N, same stimulus videos.
  external     a folder of embedded external videos + a label CSV
               (video_id,target). Use with MicroLens; see fetch_microlens.py.

Target EEG CSV (--per-window): hardware/analysis/out/ALL_per_window.csv
  (columns: video_id, t, interest_0_1 [, eeg_coverage_frac, mean_channel_quality]).

Outputs (model/out/):
  m2t_results.json     ablation metrics + N + provenance
  m2t_ablation.png     within-video Pearson per variant
  m2t_overlay.png      transfer prediction vs EEG truth, hero held-out video
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import pearsonr, spearmanr
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "model" / "out"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from behavioral_curves import build_retention_table, default_events_path  # noqa: E402
from embed_store import (  # noqa: E402
    EMB_DIR,
    align_window_embeddings,
    make_embed_pipeline,
)
from train_interest import (  # noqa: E402
    FEATURES_DIR,
    WINDOW_FEATURES,
    load_feature_windows,
    load_real_targets,
    per_video_pearson,
)

EEG_TARGET = "interest_0_1"
DEFAULT_EEG = ROOT / "hardware" / "analysis" / "out" / "ALL_per_window.csv"


# ── small helpers ─────────────────────────────────────────────────────────────

def hand_pipe(alpha: float = 2.0) -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("m", Ridge(alpha=alpha)),
    ])


def lovo(X, y, vid, make_pipe):
    """Leave-one-video-out predictions for a precomputed matrix."""
    y = np.asarray(y, float)
    pred = np.empty(len(y))
    for v in pd.unique(vid):
        te = vid == v
        tr = ~te
        if tr.sum() < 5:
            pred[te] = y[tr].mean() if tr.any() else float(np.nanmean(y))
            continue
        p = make_pipe()
        p.fit(X[tr], y[tr])
        pred[te] = p.predict(X[te])
    return pred


def lovo_transfer(X_hand, X_emb, y, vid, src_emb, src_y, src_vid, n_emb, pca, with_emb=False):
    """Transfer LOVO: per held EEG video, fit source head on source-minus-V,
    append its window prediction as a prior feature, then EEG ridge."""
    y = np.asarray(y, float)
    pred = np.empty(len(y))
    for v in pd.unique(vid):
        te = vid == v
        tr = ~te
        # source head excludes the held EEG video (leakage guard)
        s_keep = src_vid != v
        src_head = make_embed_pipeline(0, n_emb, head="ridge", pca_dim=pca)
        src_head.fit(src_emb[s_keep], np.asarray(src_y, float)[s_keep])
        prior = src_head.predict(X_emb).reshape(-1, 1)  # prior for every EEG row

        blocks = [X_hand, prior] + ([X_emb] if with_emb else [])
        Xf = np.hstack(blocks)
        if tr.sum() < 5:
            pred[te] = y[tr].mean() if tr.any() else float(np.nanmean(y))
            continue
        if with_emb:
            mp = make_embed_pipeline(X_hand.shape[1] + 1, n_emb, head="ridge", pca_dim=pca)
        else:
            mp = hand_pipe()
        mp.fit(Xf[tr], y[tr])
        pred[te] = mp.predict(Xf[te])
    return pred


def metrics(y, yhat, vid) -> dict:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        rho = float(spearmanr(y, yhat).statistic)
        r = float(pearsonr(y, yhat)[0])
    return {
        "pooled_spearman": round(rho, 4),
        "pooled_pearson": round(r, 4),
        "mean_per_video_pearson": round(per_video_pearson(y, yhat, vid), 4),
        "mae": round(float(mean_absolute_error(y, yhat)), 4),
        "r2": round(float(r2_score(y, yhat)), 4),
    }


# ── source builders ───────────────────────────────────────────────────────────

def build_source_behavioral(feat_df, events_csv, emb_dir, kinds):
    beh, summary = build_retention_table(events_csv, FEATURES_DIR)
    df = feat_df.merge(beh[["video_id", "t", "retention_0_1"]], on=["video_id", "t"], how="inner")
    X_emb, _, ok = align_window_embeddings(df, emb_dir, kinds)
    df = df.loc[ok].reset_index(drop=True)
    X_emb = X_emb[ok]
    print(f"  source(behavioral): {len(df)} windows, {df['video_id'].nunique()} videos "
          f"(events: {summary['n_exposures_used']} exposures)")
    return X_emb, df["retention_0_1"].to_numpy(float), df["video_id"].to_numpy()


def build_source_external(label_csv, emb_dir, kinds):
    labels = pd.read_csv(label_csv)
    if not {"video_id", "target"} <= set(labels.columns):
        raise ValueError("--source-labels CSV needs columns: video_id,target")
    # external embeddings are per-window; pool to per-video here would lose the
    # curve, so we expand labels to window grain by repeating the video target.
    rows = []
    for _, r in labels.iterrows():
        vid = str(r["video_id"])
        p = emb_dir / f"{vid}.npz"
        if not p.exists():
            continue
        z = np.load(p)
        for t in z["t"]:
            rows.append((vid, float(t), float(r["target"])))
    df = pd.DataFrame(rows, columns=["video_id", "t", "target"])
    if df.empty:
        raise FileNotFoundError(f"no external embeddings matched {label_csv} in {emb_dir}")
    X_emb, _, ok = align_window_embeddings(df, emb_dir, kinds)
    df = df.loc[ok].reset_index(drop=True)
    X_emb = X_emb[ok]
    print(f"  source(external): {len(df)} windows, {df['video_id'].nunique()} videos")
    return X_emb, df["target"].to_numpy(float), df["video_id"].to_numpy()


# ── plots ─────────────────────────────────────────────────────────────────────

def plot_ablation(rows, out_dir):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return None
    names = [r["variant"] for r in rows]
    vals = [r["metrics"]["mean_per_video_pearson"] for r in rows]
    colors = ["#9e9e9e", "#90a4ae", "#64b5f6", "#42a5f5", "#ff7043"][:len(rows)]
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.bar(names, vals, color=colors)
    ax.axhline(0, color="k", lw=0.8)
    ax.set_ylabel("mean per-video Pearson r (LOVO)")
    ax.set_title("M2b transfer ablation — does pretraining lift EEG-curve prediction?\n"
                 "(EEG interest: provisional / relative)")
    for i, v in enumerate(vals):
        ax.text(i, v + (0.01 if v >= 0 else -0.03), f"{v:+.3f}", ha="center", fontsize=9)
    fig.tight_layout()
    p = out_dir / "m2t_ablation.png"
    fig.savefig(p, dpi=130)
    plt.close(fig)
    return str(p)


def plot_overlay(df, y, yhat, vid, out_dir):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return None
    # hero = video with median per-video pearson (representative, not cherry-picked)
    scored = []
    for v in pd.unique(vid):
        m = vid == v
        if m.sum() < 4:
            continue
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            scored.append((v, float(pearsonr(y[m], yhat[m])[0])))
    if not scored:
        return None
    hero = sorted(scored, key=lambda x: x[1])[len(scored) // 2][0]
    m = vid == hero
    t = df["t"].to_numpy()[m]
    o = np.argsort(t)
    fig, ax = plt.subplots(figsize=(11, 4))
    ax.plot(t[o], y[m][o], color="#2196F3", lw=2, label="EEG interest (truth)")
    ax.plot(t[o], yhat[m][o], color="#FF5722", lw=2, ls="--", label="Predicted (transfer, LOVO)")
    ax.fill_between(t[o], y[m][o], yhat[m][o], alpha=0.12, color="gray")
    ax.set_xlabel("Time (s)"); ax.set_ylabel("interest_0_1"); ax.set_ylim(-0.02, 1.02)
    ax.legend(fontsize=9)
    ax.set_title(f"M2b transfer overlay — {hero}\n(EEG interest: provisional / relative)")
    fig.tight_layout()
    p = out_dir / "m2t_overlay.png"
    fig.savefig(p, dpi=130)
    plt.close(fig)
    return str(p)


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="M2b transfer: pretrain on large-N source, eval on EEG")
    ap.add_argument("--per-window", type=Path, default=DEFAULT_EEG, help="EEG per-window CSV (target)")
    ap.add_argument("--source", choices=["behavioral", "external"], default="behavioral")
    ap.add_argument("--source-events", type=Path, default=None, help="events CSV for behavioral source")
    ap.add_argument("--source-labels", type=Path, default=None, help="video_id,target CSV for external source")
    ap.add_argument("--emb-dir", type=Path, default=EMB_DIR)
    ap.add_argument("--src-emb-dir", type=Path, default=None, help="embeddings dir for external source")
    ap.add_argument("--emb-kinds", default="siglip,clap")
    ap.add_argument("--emb-pca", type=int, default=48)
    ap.add_argument("--prior-only", action="store_true",
                    help="transfer variant uses ONLY hand+prior (drops raw embeddings); "
                         "default keeps embeddings so transfer is tested as a fair add-on")
    args = ap.parse_args()
    with_emb = not args.prior_only

    OUT.mkdir(parents=True, exist_ok=True)
    kinds = tuple(k.strip() for k in args.emb_kinds.split(",") if k.strip())

    print("=" * 60)
    print("M2b TRANSFER — pretrain on", args.source, "-> eval on EEG interest")
    print("=" * 60)

    print("\n[1/5] Loading feature windows + EEG target ...")
    feat_df = load_feature_windows(FEATURES_DIR)
    if not args.per_window.exists():
        print(f"ERROR: EEG per-window CSV not found: {args.per_window}")
        return 1
    eeg = load_real_targets(feat_df, args.per_window)

    print("\n[2/5] Aligning embeddings to EEG windows ...")
    X_emb_eeg, _, ok = align_window_embeddings(eeg, args.emb_dir, kinds)
    if ok.sum() < len(eeg):
        print(f"  matched {int(ok.sum())}/{len(eeg)} EEG windows; dropping {int((~ok).sum())}")
    eeg = eeg.loc[ok].reset_index(drop=True)
    X_emb_eeg = X_emb_eeg[ok]
    n_emb = X_emb_eeg.shape[1]
    X_hand = eeg[WINDOW_FEATURES].apply(pd.to_numeric, errors="coerce").to_numpy()
    y = eeg[EEG_TARGET].to_numpy(float)
    vid = eeg["video_id"].to_numpy()
    print(f"  EEG: {len(eeg)} windows, {eeg['video_id'].nunique()} videos, {n_emb} emb dims")
    if eeg["video_id"].nunique() < 3:
        print("  WARNING: <3 EEG videos — numbers are indicative only.")

    print("\n[3/5] Building source + pretraining head ...")
    if args.source == "behavioral":
        events = args.source_events or default_events_path()
        if events is None or not Path(events).exists():
            print("ERROR: no events CSV for behavioral source"); return 1
        src_emb, src_y, src_vid = build_source_behavioral(feat_df, Path(events), args.emb_dir, kinds)
    else:
        if not args.source_labels:
            print("ERROR: --source external needs --source-labels"); return 1
        src_emb, src_y, src_vid = build_source_external(
            Path(args.source_labels), args.src_emb_dir or args.emb_dir, kinds)

    print("\n[4/5] Running ablation (LOVO over EEG videos) ...")
    variants = []

    def add(name, yhat):
        variants.append({"variant": name, "metrics": metrics(y, yhat, vid)})
        m = variants[-1]["metrics"]
        print(f"  {name:10s} per-video r={m['mean_per_video_pearson']:+.3f}  "
              f"pooled ρ={m['pooled_spearman']:+.3f}  MAE={m['mae']:.3f}  R²={m['r2']:+.3f}")
        return yhat

    # [0] baseline
    base = np.empty_like(y)
    for v in pd.unique(vid):
        te = vid == v
        base[te] = y[~te].mean() if (~te).any() else float(np.nanmean(y))
    add("baseline", base)
    # [1] hand
    add("hand", lovo(X_hand, y, vid, hand_pipe))
    # [2] emb
    add("emb", lovo(X_emb_eeg, y, vid, lambda: make_embed_pipeline(0, n_emb, "ridge", args.emb_pca)))
    # [3] hand+emb
    add("hand+emb", lovo(np.hstack([X_hand, X_emb_eeg]), y, vid,
                         lambda: make_embed_pipeline(X_hand.shape[1], n_emb, "ridge", args.emb_pca)))
    # [4] transfer
    yhat_t = lovo_transfer(X_hand, X_emb_eeg, y, vid, src_emb, src_y, src_vid,
                           n_emb, args.emb_pca, with_emb=with_emb)
    add("transfer" + ("" if with_emb else "(prior-only)"), yhat_t)

    print("\n[5/5] Writing artifacts ...")
    abl_png = plot_ablation(variants, OUT)
    ovl_png = plot_overlay(eeg, y, yhat_t, vid, OUT)

    hand_r = next(v["metrics"]["mean_per_video_pearson"] for v in variants if v["variant"] == "hand")
    he_r = next(v["metrics"]["mean_per_video_pearson"] for v in variants if v["variant"] == "hand+emb")
    tr_r = next(v["metrics"]["mean_per_video_pearson"] for v in variants if v["variant"].startswith("transfer"))
    results = {
        "model": "M2b-transfer",
        "transfer_method": "prior-feature stacking (source head excludes held EEG video)",
        "source": args.source,
        "eeg_target": EEG_TARGET,
        "eeg_note": "interest_0_1 is provisional / relative (inverted theta-beta)",
        "emb_kinds": list(kinds),
        "emb_pca": args.emb_pca,
        "n_eeg_windows": int(len(eeg)),
        "n_eeg_videos": int(eeg["video_id"].nunique()),
        "n_source_windows": int(len(src_y)),
        "n_source_videos": int(len(pd.unique(src_vid))),
        "ablation": variants,
        "emb_lift_vs_hand_per_video_r": round(he_r - hand_r, 4),
        "transfer_lift_vs_hand_emb_per_video_r": round(tr_r - he_r, 4),
    }
    (OUT / "m2t_results.json").write_text(json.dumps(results, indent=2))
    print(f"\nWrote {OUT/'m2t_results.json'}")
    if abl_png:
        print(f"Wrote {abl_png}  <- ablation bar")
    if ovl_png:
        print(f"Wrote {ovl_png}  <- transfer overlay (hero)")
    print(f"\nEmbeddings lift vs hand (per-video r):       {he_r - hand_r:+.4f}")
    print(f"Transfer add-on lift vs hand+emb (per-video r): {tr_r - he_r:+.4f}")
    print("(EEG N is small — read this as directional plumbing, not a calibrated claim.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
