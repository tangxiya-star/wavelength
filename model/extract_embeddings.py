#!/usr/bin/env python3
"""Pretrained-embedding extractor  (feature-layer upgrade for M1/M2).

Runs a frozen SigLIP image encoder per sampled frame and a frozen CLAP audio
encoder per window, at the SAME 0.5s cadence as `model/features/<id>/<id>.json`,
so every embedding row aligns 1:1 with an existing hand-crafted feature window.

Why: hand-crafted brightness/colorfulness/loudness have a low predictive ceiling
and overfit at N~120. Frozen large-model embeddings import visual/audio priors
learned from billions of examples; a small ridge head on top is the canonical
small-N recipe. Embeddings are ALSO a *shared* feature space across datasets,
which is what makes the transfer step (train_interest_transfer.py) possible.

Output (one file per video, gitignored):
  model/embeddings/<video_id>.npz
    t        float32 [W]        window centres (mirror of features.windows[].t)
    siglip   float16 [W, Di]    L2-normalised per-frame image embedding
    clap     float16 [W, Da]    L2-normalised per-window audio embedding
    + scalar metadata: video_id, creator_id, duration_s, siglip_model,
      clap_model, emb_schema
  model/embeddings/manifest.json   roll-up (dims, models, which videos done)

Usage:
  python3 model/extract_embeddings.py                 # all videos w/ features
  python3 model/extract_embeddings.py --limit 5       # quick smoke test
  python3 model/extract_embeddings.py --overwrite      # recompute existing
  python3 model/extract_embeddings.py --device cpu     # force CPU

Deps: torch, transformers (SigLIP + CLAP), opencv-python, Pillow, ffmpeg on PATH.
First run downloads the two model checkpoints (~1GB total) from HuggingFace.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# MPS safety: fall back to CPU for any op the Apple GPU backend lacks.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
FEATURES_DIR = ROOT / "model" / "features" / "videos"
VIDEOS_DIR = ROOT / "server" / "data" / "stimulus-videos"
OUT_DIR = ROOT / "model" / "embeddings"

EMB_SCHEMA = "emb-1.0"
DEFAULT_SIGLIP = "google/siglip-base-patch16-224"   # 768-d image features
DEFAULT_CLAP = "laion/clap-htsat-unfused"           # 512-d audio features
AUDIO_SR = 48000          # CLAP expects 48 kHz
AUDIO_WIN_S = 1.5         # audio clip length centred on each window t


# ── audio / frames ──────────────────────────────────────────────────────────

def decode_audio(video_path: Path, sr: int = AUDIO_SR) -> np.ndarray:
    """Decode the whole audio track to mono float32 at `sr` via ffmpeg.

    Returns an empty array if the video has no audio stream.
    """
    cmd = [
        "ffmpeg", "-v", "error", "-i", str(video_path),
        "-ac", "1", "-ar", str(sr), "-f", "f32le", "pipe:1",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, check=False)
    except FileNotFoundError:
        raise RuntimeError("ffmpeg not found on PATH")
    if proc.returncode != 0 or not proc.stdout:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


def window_clips(audio: np.ndarray, t_list, sr: int = AUDIO_SR, win_s: float = AUDIO_WIN_S):
    """Slice `audio` into one clip per window centre t (zero-padded at edges)."""
    half = int(win_s * sr / 2)
    n = len(audio)
    clips = []
    for t in t_list:
        c = int(round(t * sr))
        lo, hi = c - half, c + half
        seg = np.zeros(2 * half, dtype=np.float32)
        s0, s1 = max(lo, 0), min(hi, n)
        if s1 > s0 and n > 0:
            seg[(s0 - lo):(s0 - lo) + (s1 - s0)] = audio[s0:s1]
        clips.append(seg)
    return clips


def sample_frames(video_path: Path, t_list):
    """Grab one RGB frame per window centre t. Returns (list[PIL.Image], ok_mask)."""
    import cv2
    from PIL import Image

    cap = cv2.VideoCapture(str(video_path))
    frames, ok = [], []
    last = None
    for t in t_list:
        cap.set(cv2.CAP_PROP_POS_MSEC, float(t) * 1000.0)
        got, frame = cap.read()
        if not got or frame is None:
            frames.append(last if last is not None else Image.new("RGB", (224, 224)))
            ok.append(last is not None)
            continue
        img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        frames.append(img)
        ok.append(True)
        last = img
    cap.release()
    return frames, np.array(ok, dtype=bool)


# ── encoders ──────────────────────────────────────────────────────────────────

def pick_device(requested: str) -> str:
    import torch
    if requested != "auto":
        return requested
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


class Encoders:
    """Lazily-loaded frozen SigLIP + CLAP encoders."""

    def __init__(self, siglip_id: str, clap_id: str, device: str):
        import torch
        from transformers import AutoModel, AutoProcessor, ClapModel, ClapProcessor

        self.torch = torch
        self.device = device
        print(f"  loading SigLIP {siglip_id} ...", flush=True)
        self.sig_proc = AutoProcessor.from_pretrained(siglip_id)
        self.sig = AutoModel.from_pretrained(siglip_id).to(device).eval()
        print(f"  loading CLAP {clap_id} ...", flush=True)
        self.clap_proc = ClapProcessor.from_pretrained(clap_id)
        self.clap = ClapModel.from_pretrained(clap_id).to(device).eval()
        self.siglip_id, self.clap_id = siglip_id, clap_id

    def _norm(self, x):
        return x / x.norm(dim=-1, keepdim=True).clamp_min(1e-8)

    def _emb(self, out):
        """Extract the pooled embedding tensor across transformers versions.

        Newer transformers return a *_features() call as an output object
        (BaseModelOutputWithPooling); older versions return a bare tensor.
        """
        if self.torch.is_tensor(out):
            t = out
        elif getattr(out, "pooler_output", None) is not None:
            t = out.pooler_output
        elif getattr(out, "image_embeds", None) is not None:
            t = out.image_embeds
        elif getattr(out, "audio_embeds", None) is not None:
            t = out.audio_embeds
        elif getattr(out, "last_hidden_state", None) is not None:
            t = out.last_hidden_state.mean(dim=1)
        else:
            t = out[0]
        return self._norm(t)

    def encode_frames(self, frames, batch: int = 32) -> np.ndarray:
        out = []
        with self.torch.no_grad():
            for i in range(0, len(frames), batch):
                chunk = frames[i:i + batch]
                inp = self.sig_proc(images=chunk, return_tensors="pt").to(self.device)
                feat = self._emb(self.sig.get_image_features(**inp))
                out.append(feat.float().cpu().numpy())
        return np.concatenate(out, axis=0) if out else np.zeros((0, 768), np.float32)

    def encode_audio(self, clips, batch: int = 16) -> np.ndarray:
        out = []
        with self.torch.no_grad():
            for i in range(0, len(clips), batch):
                chunk = clips[i:i + batch]
                inp = self.clap_proc(audio=chunk, sampling_rate=AUDIO_SR,
                                     return_tensors="pt").to(self.device)
                feat = self._emb(self.clap.get_audio_features(**inp))
                out.append(feat.float().cpu().numpy())
        return np.concatenate(out, axis=0) if out else np.zeros((0, 512), np.float32)


# ── driver ────────────────────────────────────────────────────────────────────

def list_targets(features_dir: Path, videos_dir: Path):
    """(video_id, json_path, video_path) for every feature video that has an mp4."""
    targets = []
    for vdir in sorted(features_dir.iterdir()):
        if not vdir.is_dir():
            continue
        vid = vdir.name
        jpath = vdir / f"{vid}.json"
        vpath = videos_dir / f"{vid}.mp4"
        if jpath.exists() and vpath.exists():
            targets.append((vid, jpath, vpath))
    return targets


def process_video(vid, jpath, vpath, enc: Encoders) -> dict:
    feat = json.loads(jpath.read_text())
    windows = feat.get("windows", [])
    t_list = [float(w["t"]) for w in windows]
    if not t_list:
        return {"video_id": vid, "skipped": "no windows"}

    frames, ok = sample_frames(vpath, t_list)
    siglip = enc.encode_frames(frames)
    audio = decode_audio(vpath)
    clap = enc.encode_audio(window_clips(audio, t_list))

    # align lengths defensively
    W = len(t_list)
    siglip = siglip[:W] if len(siglip) >= W else np.pad(siglip, ((0, W - len(siglip)), (0, 0)))
    clap = clap[:W] if len(clap) >= W else np.pad(clap, ((0, W - len(clap)), (0, 0)))

    out_path = OUT_DIR / f"{vid}.npz"
    np.savez_compressed(
        out_path,
        t=np.asarray(t_list, np.float32),
        siglip=siglip.astype(np.float16),
        clap=clap.astype(np.float16),
        frame_ok=ok,
        has_audio=np.array(int(len(audio) > 0)),
        video_id=np.array(vid),
        creator_id=np.array(str(feat.get("creator_id", "unknown"))),
        duration_s=np.array(float(feat.get("duration_s") or 0.0)),
        siglip_model=np.array(enc.siglip_id),
        clap_model=np.array(enc.clap_id),
        emb_schema=np.array(EMB_SCHEMA),
    )
    return {
        "video_id": vid, "n_windows": W,
        "siglip_dim": int(siglip.shape[1]), "clap_dim": int(clap.shape[1]),
        "frames_ok": int(ok.sum()), "has_audio": bool(len(audio) > 0),
    }


def main() -> int:
    global OUT_DIR
    ap = argparse.ArgumentParser(description="Extract SigLIP+CLAP per-window embeddings")
    ap.add_argument("--features-dir", type=Path, default=FEATURES_DIR)
    ap.add_argument("--videos-dir", type=Path, default=VIDEOS_DIR)
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    ap.add_argument("--siglip-model", default=DEFAULT_SIGLIP)
    ap.add_argument("--clap-model", default=DEFAULT_CLAP)
    ap.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    ap.add_argument("--limit", type=int, default=0, help="process at most N videos")
    ap.add_argument("--overwrite", action="store_true", help="recompute existing npz")
    args = ap.parse_args()

    OUT_DIR = args.out_dir
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    targets = list_targets(args.features_dir, args.videos_dir)
    if not args.overwrite:
        targets = [t for t in targets if not (OUT_DIR / f"{t[0]}.npz").exists()]
    if args.limit:
        targets = targets[:args.limit]

    print("=" * 60)
    print(f"Embedding extraction  ({EMB_SCHEMA})")
    print(f"  videos to process : {len(targets)}")
    if not targets:
        print("  nothing to do (all done; use --overwrite to recompute)")
        return 0

    device = pick_device(args.device)
    print(f"  device            : {device}")
    enc = Encoders(args.siglip_model, args.clap_model, device)

    done = []
    for i, (vid, jpath, vpath) in enumerate(targets, 1):
        try:
            info = process_video(vid, jpath, vpath, enc)
            done.append(info)
            tag = "" if info.get("has_audio", True) else "  (no audio)"
            print(f"  [{i}/{len(targets)}] {vid}  W={info.get('n_windows','?')}{tag}", flush=True)
        except Exception as e:  # noqa: BLE001 - keep going, report at end
            print(f"  [{i}/{len(targets)}] {vid}  FAILED: {e}", flush=True)

    manifest = {
        "emb_schema": EMB_SCHEMA,
        "siglip_model": args.siglip_model,
        "clap_model": args.clap_model,
        "siglip_dim": done[0]["siglip_dim"] if done else None,
        "clap_dim": done[0]["clap_dim"] if done else None,
        "n_videos": len(list(OUT_DIR.glob("*.npz"))),
        "videos": sorted(p.stem for p in OUT_DIR.glob("*.npz")),
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nWrote {len(done)} npz + manifest.json to {OUT_DIR}")
    print(f"Total embedded videos: {manifest['n_videos']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
