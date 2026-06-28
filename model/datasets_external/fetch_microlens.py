#!/usr/bin/env python3
"""MicroLens hook — turn external open short-video data into a transfer source.

MicroLens (westlake-repl/MicroLens) is an open micro-video recommendation dataset
that ships RAW videos + interactions. Because it has raw videos, we can run the
SAME SigLIP+CLAP extractor over it, so its embeddings live in the same space as
the FlowState stimulus videos — which is exactly what train_interest_transfer.py
needs as a pretrain source (`--source external`).

This script does NOT bulk-download on its own (the raw-video archive is multi-GB
and gated behind the authors' cloud links). It does two things:

  1. `--print-instructions`  show exactly where to get the data and the 3 commands
     to wire it in.
  2. `--interactions FILE --videos-dir DIR`  derive a per-video engagement target
     (mean watch-ratio, or like-rate fallback) from a MicroLens interactions file
     for the videos you actually downloaded, and write `labels.csv` (video_id,target)
     ready for `--source external`.

End-to-end once you have a folder of MicroLens .mp4s + the interactions file:

  python3 model/datasets_external/fetch_microlens.py \
      --interactions MicroLens-100k_pairs.csv \
      --videos-dir model/datasets_external/videos/microlens
  python3 model/extract_embeddings.py \
      --videos-dir model/datasets_external/videos/microlens \
      --features-dir model/datasets_external/videos/microlens \
      --out-dir model/datasets_external/emb/microlens
  python3 model/train_interest_transfer.py --source external \
      --source-labels model/datasets_external/labels.csv \
      --src-emb-dir model/datasets_external/emb/microlens

NOTE: step 2 expects a per-video feature JSON to know window cadence. For external
videos without one, pass --make-feature-stubs to emit minimal 0.5s-cadence stubs.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
INSTRUCTIONS = """
MicroLens — how to get the raw videos
─────────────────────────────────────
1. Repo + download links (OneDrive / Google Drive, request form):
       https://github.com/westlake-repl/MicroLens
   Grab the SMALLEST split that has raw videos (e.g. a MicroLens-100k video
   sample) — you do NOT need the full 1M set for a pretrain prior. A few
   hundred to ~2k short videos is plenty to learn a transferable head.
2. Unzip the .mp4s into:
       model/datasets_external/videos/microlens/
3. Put the interactions/pairs file (user,item,watch_ratio/like) somewhere handy.
4. Run this script with --interactions / --videos-dir to build labels.csv.
5. Then the 3 commands in this file's docstring (extract → transfer).

Why MicroLens and not KuaiRec: KuaiRec has richer logs but NO raw videos, so we
can't embed its items into our SigLIP/CLAP space — it can't feed the MP4 demo.
"""

WATCH_COLS = ["watch_ratio", "watchratio", "play_ratio", "completion", "watch_time"]
LIKE_COLS = ["like", "is_like", "click", "is_click"]
ITEM_COLS = ["item", "item_id", "video_id", "video", "vid"]


def _pick(cols, candidates):
    low = {c.lower(): c for c in cols}
    for c in candidates:
        if c in low:
            return low[c]
    return None


def build_labels(interactions: Path, videos_dir: Path, out_csv: Path) -> int:
    import pandas as pd

    have = {p.stem for p in videos_dir.glob("*.mp4")}
    if not have:
        print(f"  no .mp4 found in {videos_dir} — download MicroLens videos there first")
        return 1
    df = pd.read_csv(interactions)
    item_col = _pick(df.columns, ITEM_COLS)
    if item_col is None:
        print(f"  could not find an item column in {list(df.columns)[:8]}...")
        return 1
    target_col = _pick(df.columns, WATCH_COLS) or _pick(df.columns, LIKE_COLS)
    if target_col is None:
        print("  no watch_ratio/like-like column found; cannot derive a target")
        return 1
    df[item_col] = df[item_col].astype(str)
    df = df[df[item_col].isin(have)]
    if df.empty:
        print("  none of the interactions match downloaded videos (id mismatch?)")
        return 1
    agg = df.groupby(item_col)[target_col].mean().reset_index()
    agg.columns = ["video_id", "target"]
    # normalise target to 0..1 for a clean retention-like prior
    lo, hi = agg["target"].min(), agg["target"].max()
    if hi > lo:
        agg["target"] = (agg["target"] - lo) / (hi - lo)
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    agg.to_csv(out_csv, index=False)
    print(f"  wrote {out_csv}: {len(agg)} videos, target='{target_col}' (normalised 0..1)")
    return 0


def make_feature_stubs(videos_dir: Path, features_dir: Path, cadence: float = 0.5) -> None:
    """Emit minimal schema-2.0 feature JSONs (cadence-only) so extract_embeddings
    knows the window grid for external videos lacking real feature extraction."""
    import subprocess
    features_dir.mkdir(parents=True, exist_ok=True)
    for mp4 in sorted(videos_dir.glob("*.mp4")):
        vid = mp4.stem
        d = features_dir / vid
        d.mkdir(exist_ok=True)
        out = d / f"{vid}.json"
        if out.exists():
            continue
        try:
            dur = float(subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", str(mp4)],
                capture_output=True, text=True).stdout.strip())
        except Exception:
            dur = 0.0
        n = max(1, int(dur / cadence))
        out.write_text(json.dumps({
            "feature_schema_version": "2.0", "video_id": vid,
            "creator_id": "microlens", "duration_s": dur,
            "windows": [{"t": round(i * cadence, 2)} for i in range(n)],
        }))
    print(f"  stubs written to {features_dir}")


def main() -> int:
    ap = argparse.ArgumentParser(description="MicroLens transfer-source hook")
    ap.add_argument("--print-instructions", action="store_true")
    ap.add_argument("--interactions", type=Path)
    ap.add_argument("--videos-dir", type=Path, default=HERE / "videos" / "microlens")
    ap.add_argument("--out", type=Path, default=HERE / "labels.csv")
    ap.add_argument("--make-feature-stubs", action="store_true")
    ap.add_argument("--features-dir", type=Path, default=None)
    args = ap.parse_args()

    if args.print_instructions or (not args.interactions and not args.make_feature_stubs):
        print(INSTRUCTIONS)
        return 0
    if args.make_feature_stubs:
        make_feature_stubs(args.videos_dir, args.features_dir or args.videos_dir)
    if args.interactions:
        return build_labels(args.interactions, args.videos_dir, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
