#!/usr/bin/env python3
"""M2 content→EEG-interest inference — the shared core behind the waveform demos.

One model answers one question: *given a video's content, what does the per-0.5 s EEG
interest curve look like?* The features are hand-crafted window descriptors (motion,
faces, loudness, cuts, …) concatenated with SigLIP (vision) + CLAP (audio) embeddings;
the head is a ridge regressor (see embed_store.make_embed_pipeline). Interest uses the
engagement sign (high frontal theta/beta = engaged).

The fit/predict mechanics are identical no matter *which* EEG you train on, so they live
here once. Callers differ only in the target set they pass to `M2.fit`:
  - predict_waveform.py      → all stimulus EEG (the product model)
  - predict_waveforms_batch.py → same, batched over the catalog
  - demo_waveform.py         → stimulus EEG minus one held-out participant

Usage:
    m2 = M2().fit(per_window_targets(STIM))     # train once
    t, y = m2.predict_curve("DXz3KrEj-2t")      # any video with features + embeddings

Small N — a DEMO of the mechanism, not a calibrated absolute interest.
"""
from __future__ import annotations

import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
np.seterr(all="ignore")  # PCA on near-constant embedding dims emits harmless matmul warnings

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import train_interest as ti  # noqa: E402  (WINDOW_FEATURES, FEATURES_DIR, load_feature_windows, OUT)
from embed_store import align_window_embeddings, make_embed_pipeline  # noqa: E402

# Canonical locations, shared by every caller.
ENG = ROOT.parent / "hardware" / "analysis" / "out" / "engagement"
STIM = ENG / "STIMULUS_per_window.csv"   # feed-study app windows (baseline reels excluded)
EMB_DIR = ROOT / "embeddings"
KINDS = ("siglip", "clap")
OUT = ti.OUT


def per_window_targets(per_window_csv: Path | str) -> pd.DataFrame:
    """Training targets from a per-window EEG CSV: mean interest per (video_id, t).

    Averaging over rows collapses multiple participants who saw the same video into one
    curve, which is what the content→interest model regresses onto.
    """
    eeg = pd.read_csv(per_window_csv)
    return eeg.groupby(["video_id", "t"])["interest_0_1"].mean().reset_index()


def actual_curve(per_window_csv: Path | str, video_id: str):
    """The recorded EEG interest curve (t, interest) for one video, sorted by time."""
    df = pd.read_csv(per_window_csv)
    d = df[df.video_id == video_id][["t", "interest_0_1"]].dropna().sort_values("t")
    return d.t.to_numpy(), d.interest_0_1.to_numpy()


def curve_pearson(t_pred, y_pred, t_actual, y_actual, min_overlap: int = 4):
    """Pearson r between a predicted and an actual curve on their shared window times.

    The two curves are sampled on the same 0.5 s grid but may span different durations
    (a participant scrolls away before the clip ends), so we correlate only where both
    exist. Returns None if they overlap on fewer than `min_overlap` windows.
    """
    actual = {round(t, 3): v for t, v in zip(t_actual, y_actual)}
    pairs = [(y_pred[i], actual[round(t_pred[i], 3)])
             for i in range(len(t_pred)) if round(t_pred[i], 3) in actual]
    if len(pairs) < min_overlap:
        return None
    from scipy.stats import pearsonr
    pred, act = zip(*pairs)
    return round(float(pearsonr(pred, act)[0]), 3)


class M2:
    """Content→interest curve regressor (hand features + SigLIP/CLAP embeddings → ridge).

    Holds the full feature-window table once so a video's curve can be predicted without
    re-reading it. Fit on any per-window target set; predict any video that has both a
    feature JSON and an embedding .npz.
    """

    def __init__(self, head: str = "ridge", pca_dim: int = 48,
                 emb_dir: Path = EMB_DIR, kinds=KINDS):
        self.head, self.pca_dim, self.emb_dir, self.kinds = head, pca_dim, emb_dir, kinds
        self.feat = ti.load_feature_windows(ti.FEATURES_DIR)
        self.model = None
        self.n_videos = self.n_windows = 0

    def _design(self, df: pd.DataFrame):
        """[hand features | embeddings] for window rows that have an embedding.

        Returns (X, df_kept) where df_kept drops rows whose video lacks embeddings — no
        silent zero-fill, so the model never trains or predicts on fabricated vectors.
        """
        emb, _, ok = align_window_embeddings(df, self.emb_dir, self.kinds)
        df, emb = df.loc[ok].reset_index(drop=True), emb[ok]
        hand = df[ti.WINDOW_FEATURES].apply(pd.to_numeric, errors="coerce").to_numpy()
        return np.hstack([hand, emb]), df

    def fit(self, targets: pd.DataFrame) -> "M2":
        """Train on per-window targets (columns: video_id, t, interest_0_1)."""
        df = self.feat.merge(targets, on=["video_id", "t"], how="inner")
        X, df = self._design(df)
        n_hand = len(ti.WINDOW_FEATURES)
        self.model = make_embed_pipeline(n_hand, X.shape[1] - n_hand,
                                         head=self.head, pca_dim=self.pca_dim)
        self.model.fit(X, df["interest_0_1"].to_numpy(float))
        self.n_windows, self.n_videos = len(df), df.video_id.nunique()
        return self

    def predict_curve(self, video_id: str):
        """Predicted per-0.5 s interest curve (t, y) for a video, clipped to [0, 1].

        Returns (None, None) if the video has no feature windows or no embeddings — the
        caller decides how to surface that (the UI falls back to the synth stream).
        """
        dv = self.feat[self.feat.video_id == video_id].sort_values("t").reset_index(drop=True)
        if dv.empty:
            return None, None
        X, dv = self._design(dv)
        if len(dv) == 0:
            return None, None
        return dv["t"].to_numpy(), np.clip(self.model.predict(X), 0.0, 1.0)
