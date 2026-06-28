#!/usr/bin/env python3
"""Embedding loader + sklearn helpers shared by M1 / M2 / transfer.

extract_embeddings.py writes one npz per video. This module loads them and
aligns them to (video_id, t) feature rows, plus builds the leakage-safe
pipelines (PCA fit *inside* each CV fold, never on the held-out data).

Two grains:
  - per-window  -> M2 / transfer   (align to feature windows)
  - per-video   -> M1              (mean+std pooled over windows)

Kinds: "siglip" (image), "clap" (audio), or both concatenated.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
EMB_DIR = ROOT / "model" / "embeddings"
EMB_SCHEMA = "emb-1.0"


def embeddings_available(emb_dir: Path = EMB_DIR) -> bool:
    return emb_dir.exists() and any(emb_dir.glob("*.npz"))


def _load_one(emb_dir: Path, vid: str):
    p = emb_dir / f"{vid}.npz"
    if not p.exists():
        return None
    z = np.load(p, allow_pickle=False)
    return {
        "t": z["t"].astype(np.float64),
        "siglip": z["siglip"].astype(np.float32),
        "clap": z["clap"].astype(np.float32),
    }


def _stack_kinds(rec: dict, kinds: Iterable[str]) -> np.ndarray:
    return np.concatenate([rec[k] for k in kinds], axis=1)


# ── per-window alignment (M2 / transfer) ──────────────────────────────────────

def align_window_embeddings(
    df: pd.DataFrame,
    emb_dir: Path = EMB_DIR,
    kinds: tuple[str, ...] = ("siglip", "clap"),
    round_t: int = 2,
) -> tuple[np.ndarray, list[str], np.ndarray]:
    """Return (X_emb [n_rows, D], col_names, ok_mask [n_rows]) aligned to df rows.

    df must have columns video_id, t. Rows whose (video_id, t) has no embedding
    get NaN and ok_mask=False (caller decides whether to drop or impute).
    """
    cache: dict[str, dict] = {}
    dim = None
    kind_dims: dict[str, int] = {}
    rows, ok = [], []
    for vid, t in zip(df["video_id"].to_numpy(), df["t"].to_numpy()):
        if vid not in cache:
            cache[vid] = _load_one(emb_dir, vid) or {}
        rec = cache[vid]
        if not rec:
            rows.append(None); ok.append(False); continue
        if not kind_dims:
            kind_dims = {k: rec[k].shape[1] for k in kinds}
        M = _stack_kinds(rec, kinds)
        dim = M.shape[1]
        idx = np.where(np.round(rec["t"], round_t) == round(float(t), round_t))[0]
        if len(idx) == 0:
            rows.append(None); ok.append(False)
        else:
            rows.append(M[idx[0]]); ok.append(True)
    if dim is None:
        raise FileNotFoundError(f"no embeddings found in {emb_dir} for these videos")
    X = np.vstack([r if r is not None else np.full(dim, np.nan) for r in rows])
    cols = [f"emb_{k}_{i}" for k in kinds for i in range(kind_dims[k])]
    return X, cols, np.asarray(ok, dtype=bool)


# ── per-video pooling (M1) ────────────────────────────────────────────────────

def video_pooled_embeddings(
    video_ids: Iterable[str],
    emb_dir: Path = EMB_DIR,
    kinds: tuple[str, ...] = ("siglip", "clap"),
) -> tuple[pd.DataFrame, list[str]]:
    """mean+std pooled embedding per video. Returns (df[video_id, p_*], col_names)."""
    recs, vids = [], []
    for vid in video_ids:
        rec = _load_one(emb_dir, vid)
        if not rec:
            continue
        M = _stack_kinds(rec, kinds)
        recs.append(np.concatenate([M.mean(0), M.std(0)]))
        vids.append(vid)
    if not recs:
        raise FileNotFoundError(f"no embeddings found in {emb_dir}")
    D = len(recs[0]) // 2
    cols = ([f"pmean_{i}" for i in range(D)] + [f"pstd_{i}" for i in range(D)])
    out = pd.DataFrame(np.vstack(recs), columns=cols)
    out.insert(0, "video_id", vids)
    return out, cols


# ── leakage-safe pipeline (PCA fits inside the fold) ──────────────────────────

def make_embed_pipeline(
    n_hand: int,
    n_emb: int,
    head: str = "ridge",
    pca_dim: int = 48,
    alpha: float = 2.0,
):
    """Pipeline over a matrix whose first n_hand cols are hand features and last
    n_emb cols are embeddings. Hand cols -> impute+scale; embedding cols ->
    impute+PCA(pca_dim). PCA is part of the estimator, so cross_val_predict /
    per-fold .fit refit it on training rows only (no leakage)."""
    from sklearn.compose import ColumnTransformer
    from sklearn.decomposition import PCA
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    hand_idx = list(range(n_hand))
    emb_idx = list(range(n_hand, n_hand + n_emb))
    eff_pca = max(2, min(pca_dim, n_emb))

    branches = []
    if n_hand:
        branches.append(("hand", Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
        ]), hand_idx))
    branches.append(("emb", Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("pca", PCA(n_components=eff_pca, random_state=0)),
    ]), emb_idx))

    ct = ColumnTransformer(branches, remainder="drop")
    if head == "hgb":
        est = HistGradientBoostingRegressor(
            max_depth=3, learning_rate=0.05, max_iter=300,
            l2_regularization=1.0, random_state=0)
        return Pipeline([("ct", ct), ("m", est)])
    return Pipeline([("ct", ct), ("scale", StandardScaler()), ("m", Ridge(alpha=alpha))])


def lovo_cv_matrix(X: np.ndarray, y: np.ndarray, vid_col: np.ndarray, model_fn):
    """Leave-one-video-out CV over a precomputed feature matrix.

    model_fn() -> a fresh sklearn estimator/pipeline. Returns y_pred (same order).
    """
    y = np.asarray(y, dtype=float)
    y_pred = np.empty(len(y), dtype=float)
    for held in pd.unique(vid_col):
        te = vid_col == held
        tr = ~te
        if tr.sum() < 5:
            y_pred[te] = y[tr].mean() if tr.any() else float(np.nanmean(y))
            continue
        est = model_fn()
        est.fit(X[tr], y[tr])
        y_pred[te] = est.predict(X[te])
    return y_pred
