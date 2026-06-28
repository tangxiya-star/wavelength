#!/usr/bin/env python3
"""Extract local video features for the selected Instagram videos (v1 / legacy).

Outputs:
  - one JSON file per analyzed video
  - analysis-summary.csv with one row per video
  - palette PNGs, one vertical color stripe per sampled frame

**Scene / pacing cuts:** this script emits `scenes` + normalized `scene_cuts` for the
legacy summary CSV. The model pipeline (schema v2 per-window curves, hook block,
aggregate pacing) lives in ``model/extract_features.py`` — use that for training
features. Pass ``--skip-scenes`` here when you only need transcript/OCR/palette.

The script uses ffmpeg/ffprobe plus optional local tools:
  - tesseract CLI for visible overlay text
  - whisper CLI only when --transcribe is passed and whisper is installed
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import shutil
import subprocess
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

try:
    from scenedetect import detect, ContentDetector, AdaptiveDetector

    _HAS_SCENEDETECT = True
except Exception:
    _HAS_SCENEDETECT = False

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SELECTED_CSV = ROOT / "scripts/ig-reels-scraper/ig-data/selected-videos.csv"
DEFAULT_DOWNLOADS = ROOT / "scripts/ig-reels-scraper/ig-data/selected-downloads"
DEFAULT_OUT = ROOT / "scripts/ig-reels-scraper/ig-data/video-analysis"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze selected downloaded videos.")
    parser.add_argument("--selected-csv", type=Path, default=DEFAULT_SELECTED_CSV)
    parser.add_argument("--downloads", type=Path, default=DEFAULT_DOWNLOADS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--limit", type=int, help="Only analyze the first N videos.")
    parser.add_argument("--ids", nargs="*", help="Only analyze these video ids.")
    parser.add_argument("--palette-fps", type=float, default=2.0)
    parser.add_argument("--ocr-every", type=float, default=2.0, help="Seconds between OCR frames.")
    parser.add_argument("--ocr-max-frames", type=int, default=20)
    parser.add_argument(
        "--scene-threshold",
        type=float,
        default=None,
        help="Detector threshold. Default: 27.0 (content), 3.0 (adaptive), 0.35 (ffmpeg).",
    )
    parser.add_argument(
        "--scene-detector",
        choices=["content", "adaptive", "ffmpeg"],
        default="content",
        help="Scene detection engine.",
    )
    parser.add_argument("--transcribe", action="store_true", help="Run whisper CLI if installed.")
    parser.add_argument("--whisper-model", default="base")
    parser.add_argument("--skip-ocr", action="store_true")
    parser.add_argument("--skip-visual", action="store_true", help="Skip visual-element detection.")
    parser.add_argument("--skip-scenes", action="store_true",
                        help="Skip scene detection (pacing cuts come from model/extract_features.py).")
    parser.add_argument(
        "--backfill-scene-cuts",
        action="store_true",
        help="Add scene_cuts to existing v1 features.json files from their scenes block (no re-analyze).",
    )
    parser.add_argument("--visual-fps", type=float, default=2.0, help="Frame sample rate for visual elements.")
    parser.add_argument("--visual-max-frames", type=int, default=40)
    parser.add_argument("--visual-width", type=int, default=200, help="Downscale width for visual analysis.")
    return parser.parse_args()


def run(cmd: list[str], *, check: bool = True, capture: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, check=check, text=True, capture_output=capture)


def read_selected(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def index_downloads(downloads: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for path in downloads.rglob("*.mp4"):
        found[path.stem] = path
    return found


def ffprobe(path: Path) -> dict[str, Any]:
    result = run([
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ])
    return json.loads(result.stdout)


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def sample_palette(path: Path, fps: float, palette_png: Path) -> dict[str, Any]:
    if fps <= 0:
        fps = 1.0
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(path),
        "-vf",
        f"fps={fps},scale=1:1:flags=area,format=rgb24",
        "-f",
        "rawvideo",
        "-",
    ]
    proc = subprocess.run(cmd, check=True, stdout=subprocess.PIPE)
    raw = proc.stdout
    colors = [tuple(raw[i : i + 3]) for i in range(0, len(raw), 3) if len(raw[i : i + 3]) == 3]
    if not colors:
        return {"sample_count": 0, "avg_rgb": None, "brightness_mean": None, "colorfulness_mean": None}

    arr = np.array(colors, dtype=np.float32)
    rg = np.abs(arr[:, 0] - arr[:, 1])
    yb = np.abs(0.5 * (arr[:, 0] + arr[:, 1]) - arr[:, 2])
    colorfulness = np.sqrt(np.var(rg) + np.var(yb)) + 0.3 * np.sqrt(np.mean(rg) ** 2 + np.mean(yb) ** 2)
    brightness = (0.2126 * arr[:, 0] + 0.7152 * arr[:, 1] + 0.0722 * arr[:, 2]) / 255.0

    palette_png.parent.mkdir(parents=True, exist_ok=True)
    width = max(1, len(colors))
    image = Image.new("RGB", (width, 160))
    for x, color in enumerate(colors):
        rgb = tuple(int(v) for v in color)
        for y in range(160):
            image.putpixel((x, y), rgb)
    image = image.resize((max(320, width), 160), resample=Image.Resampling.NEAREST)
    image.save(palette_png)

    return {
        "sample_count": len(colors),
        "avg_rgb": [round(float(v), 2) for v in np.mean(arr, axis=0)],
        "dominant_rgb": [int(v) for v in Counter(colors).most_common(1)[0][0]],
        "brightness_mean": round(float(np.mean(brightness)), 4),
        "brightness_std": round(float(np.std(brightness)), 4),
        "colorfulness_mean": round(float(colorfulness), 4),
        "palette_png": str(palette_png),
    }


def _scene_seconds(timecode: Any) -> float:
    """Seconds for a FrameTimecode, across scenedetect versions.

    0.7 exposes a `.seconds` property; older releases use `get_seconds()`.
    """
    secs = getattr(timecode, "seconds", None)
    if secs is None:
        secs = timecode.get_seconds()
    return round(secs, 3)


def detect_scenes(path: Path, detector_name: str, threshold: float | None) -> dict[str, Any]:
    """Return a per-video scene count. scene_count is the integer we care about.

    Engines: 'content'/'adaptive' use PySceneDetect (returns a scene list, so
    scene_count = len(list) with the off-by-one handled). 'ffmpeg' is a fallback.
    """
    # Auto-fallback to ffmpeg if scenedetect is unavailable.
    if detector_name in ("content", "adaptive") and not _HAS_SCENEDETECT:
        detector_name = "ffmpeg"

    if detector_name == "ffmpeg":
        thr = threshold if threshold is not None else 0.35
        return detect_scene_cuts_ffmpeg(path, thr)

    try:
        if detector_name == "adaptive":
            thr = threshold if threshold is not None else 3.0
            det = AdaptiveDetector(adaptive_threshold=thr, min_scene_len=15)
        else:  # content
            thr = threshold if threshold is not None else 27.0
            det = ContentDetector(threshold=thr, min_scene_len=15)
        scene_list = detect(str(path), det)
        # An empty list means no cuts were found -> one continuous shot.
        scene_count = len(scene_list) if scene_list else 1
        boundaries = [_scene_seconds(start) for start, _ in scene_list]
        return {
            "engine": f"pyscenedetect/{detector_name}",
            "threshold": thr,
            "scene_count": scene_count,
            "cut_count": max(0, scene_count - 1),
            "scene_boundaries": boundaries,
        }
    except Exception as exc:
        # Don't let a scene failure kill palette/audio/ocr for this video.
        return {
            "engine": f"pyscenedetect/{detector_name}",
            "threshold": threshold,
            "scene_count": None,
            "cut_count": None,
            "scene_boundaries": [],
            "error": str(exc),
        }


def detect_scene_cuts_ffmpeg(path: Path, threshold: float) -> dict[str, Any]:
    vf = f"select='gt(scene,{threshold})',showinfo"
    result = run(["ffmpeg", "-hide_banner", "-i", str(path), "-vf", vf, "-f", "null", "-"], check=False)
    text = (result.stderr or "") + (result.stdout or "")
    times = []
    for match in re.finditer(r"pts_time:([0-9.]+)", text):
        value = safe_float(match.group(1), -1.0)
        if value >= 0:
            times.append(value)
    return {
        "engine": "ffmpeg",
        "threshold": threshold,
        "scene_count": len(times) + 1,
        "cut_count": len(times),
        "scene_boundaries": [round(t, 3) for t in times],
    }


def scene_cuts_from_scenes(scenes: dict[str, Any]) -> dict[str, Any]:
    """Normalized cut list consumed by model/extract_features.py (v1 read path).

    PySceneDetect stores scene *starts* (first entry ~0 s); ffmpeg stores cut instants.
    """
    if scenes.get("enabled") is False or scenes.get("reason", "").startswith("skipped"):
        return {
            "cut_times": [],
            "cut_count": 0,
            "source": "skipped",
            "note": "Scene detection skipped; use model/extract_features.py for pacing.",
        }
    if scenes.get("error"):
        return {
            "cut_times": [],
            "cut_count": 0,
            "source": scenes.get("engine"),
            "error": scenes["error"],
        }
    boundaries = scenes.get("scene_boundaries") or []
    engine = str(scenes.get("engine") or "")
    if not boundaries:
        cut_count = scenes.get("cut_count")
        return {
            "cut_times": [],
            "cut_count": int(cut_count) if cut_count is not None else 0,
            "source": engine or None,
        }
    if "pyscenedetect" in engine and safe_float(boundaries[0]) <= 0.05:
        cut_times = [round(float(t), 3) for t in boundaries[1:]]
    else:
        cut_times = [round(float(t), 3) for t in boundaries]
    cut_times.sort()
    return {
        "cut_times": cut_times,
        "cut_count": len(cut_times),
        "source": engine or None,
    }


def extract_audio_features(path: Path) -> dict[str, Any]:
    sample_rate = 16000
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "s16le",
        "-",
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0 or not result.stdout:
        return {"audio_present": False}

    audio = np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    if audio.size == 0:
        return {"audio_present": False}

    frame = max(1, sample_rate // 2)
    frames = audio[: (audio.size // frame) * frame].reshape(-1, frame) if audio.size >= frame else audio.reshape(1, -1)
    rms = np.sqrt(np.mean(frames**2, axis=1) + 1e-12)
    rms_db = 20 * np.log10(rms + 1e-12)
    zero_crossings = np.mean(np.abs(np.diff(np.signbit(audio)))) if audio.size > 1 else 0.0

    window = audio[: min(audio.size, sample_rate * 30)]
    if window.size:
        spectrum = np.abs(np.fft.rfft(window * np.hanning(window.size)))
        freqs = np.fft.rfftfreq(window.size, d=1 / sample_rate)
        total = float(np.sum(spectrum)) + 1e-12
        centroid = float(np.sum(freqs * spectrum) / total)
        bandwidth = float(np.sqrt(np.sum(((freqs - centroid) ** 2) * spectrum) / total))
    else:
        centroid = 0.0
        bandwidth = 0.0

    dynamic_range = float(np.percentile(rms_db, 95) - np.percentile(rms_db, 10))
    return {
        "audio_present": True,
        "rms_db_mean": round(float(np.mean(rms_db)), 3),
        "rms_db_p95": round(float(np.percentile(rms_db, 95)), 3),
        "dynamic_range_db": round(dynamic_range, 3),
        "zero_crossing_rate": round(float(zero_crossings), 5),
        "spectral_centroid_hz": round(centroid, 2),
        "spectral_bandwidth_hz": round(bandwidth, 2),
        "soundscape_hint": classify_soundscape(dynamic_range, centroid, bandwidth, zero_crossings),
    }


def classify_soundscape(dynamic_range: float, centroid: float, bandwidth: float, zcr: float) -> str:
    if centroid > 2500 and bandwidth > 1800 and dynamic_range < 18:
        return "music_or_dense_bed_likely"
    if 500 <= centroid <= 2500 and zcr < 0.14:
        return "speech_or_voiceover_likely"
    if dynamic_range >= 18:
        return "high_dynamic_range"
    return "low_confidence"


def ocr_frames(path: Path, out_dir: Path, every: float, max_frames: int) -> dict[str, Any]:
    if not shutil.which("tesseract"):
        return {"enabled": False, "reason": "tesseract_not_installed"}

    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = out_dir / "frame_%04d.png"
    fps = 1.0 / max(every, 0.1)
    vf = f"fps={fps},scale=540:-1"
    run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", vf, "-frames:v", str(max_frames), str(pattern)])

    frame_results = []
    text_counter: Counter[str] = Counter()
    zone_counter: Counter[str] = Counter()
    # Per-frame timelines (one entry per sampled frame, including empty ones) so the
    # visual-element stage can tell continuous subtitles from transient pop-ups.
    per_frame_zones: list[list[str]] = []
    per_frame_text: list[str] = []
    for image_path in sorted(out_dir.glob("frame_*.png")):
        tsv = run(["tesseract", str(image_path), "stdout", "--psm", "11", "tsv"], check=False)
        words = []
        zones = []
        for row in csv.DictReader(tsv.stdout.splitlines(), delimiter="\t"):
            text = (row.get("text") or "").strip()
            conf = safe_float(row.get("conf"), -1)
            if not text or conf < 50:
                continue
            words.append(text)
            text_counter[text.lower()] += 1
            top = safe_float(row.get("top"), 0)
            height = safe_float(row.get("height"), 1)
            image_h = Image.open(image_path).height
            center = (top + height / 2) / max(1, image_h)
            if center < 0.33:
                zone = "top"
            elif center > 0.66:
                zone = "bottom"
            else:
                zone = "middle"
            zones.append(zone)
            zone_counter[zone] += 1
        if words:
            frame_results.append({"frame": image_path.name, "text": " ".join(words), "zones": zones})
        per_frame_zones.append(zones)
        per_frame_text.append(" ".join(words))

    total_frames = len(list(out_dir.glob("frame_*.png")))
    frames_with_text = len(frame_results)
    likely_subtitles = total_frames > 0 and zone_counter["bottom"] >= max(3, frames_with_text * 0.5)
    return {
        "enabled": True,
        "frames_sampled": total_frames,
        "frames_with_text": frames_with_text,
        "text_presence_ratio": round(frames_with_text / total_frames, 4) if total_frames else 0,
        "likely_subtitles": likely_subtitles,
        "text_zones": dict(zone_counter),
        "top_terms": text_counter.most_common(25),
        "sample_text": [item["text"] for item in frame_results[:10]],
        "per_frame_zones": per_frame_zones,
        "per_frame_text": per_frame_text,
    }


def find_whisper_cli() -> str | None:
    # Prefer the CTranslate2 backend (faster-whisper) when present; fall back to openai-whisper.
    # Both expose the same CLI flags and write an identical {stem}.json transcript.
    for name in ("whisper-ctranslate2", "whisper"):
        found = shutil.which(name)
        if found:
            return found
    return None


def maybe_transcribe(path: Path, out_dir: Path, model: str) -> dict[str, Any]:
    whisper = find_whisper_cli()
    if not whisper:
        return {"enabled": False, "reason": "whisper_cli_not_installed"}

    out_dir.mkdir(parents=True, exist_ok=True)
    result = run(
        [
            whisper,
            str(path),
            "--model",
            model,
            "--output_dir",
            str(out_dir),
            "--output_format",
            "json",
            "--verbose",
            "False",
        ],
        check=False,
    )
    json_path = out_dir / f"{path.stem}.json"
    if result.returncode != 0 or not json_path.exists():
        return {"enabled": True, "error": (result.stderr or result.stdout or "whisper_failed").strip()[-1000:]}
    data = json.loads(json_path.read_text())
    return {
        "enabled": True,
        "text": data.get("text", "").strip(),
        "segments": data.get("segments", []),
        "json": str(json_path),
    }


def load_existing_transcript(out_dir: Path, stem: str) -> dict[str, Any] | None:
    """Reuse a transcript from an earlier --transcribe run, if one is on disk.

    Lets runs that only re-extract other features (e.g. scene-detector tuning)
    keep the transcript instead of resetting it to "not_requested".
    """
    json_path = out_dir / f"{stem}.json"
    if not json_path.exists():
        return None
    try:
        data = json.loads(json_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return {
        "enabled": True,
        "cached": True,
        "text": (data.get("text") or "").strip(),
        "segments": data.get("segments", []),
        "json": str(json_path),
    }


# --- Visual-element detection (local heuristics, no OpenCV) ----------------------
#
# Three detectors share one low-res RGB frame stack pulled with ffmpeg:
#   1. logo / watermark  -> temporal-stability map (pixels static while scene moves)
#   2. screen recording  -> structural stats (straight lines, flat panels, synthetic palette)
#   3. subtitles / popups -> the OCR per-frame timeline (continuous vs transient text)
# Tunable thresholds live here so the stage can be calibrated without touching logic.

# Tokens that strongly imply a code editor / terminal / dev UI is on screen.
# Kept to distinctive code/terminal words; ambiguous English (true/from/main/log...)
# is excluded so ordinary captions don't read as a code screen.
UI_TEXT_TOKENS = {
    "def", "import", "const", "let", "var", "function", "return", "class",
    "public", "private", "void", "async", "await", "console", "npm", "pip",
    "git", "sudo", "https", "localhost", "json", "bash", "zsh", "terminal",
}
# Single-word calls to action that signal an on-screen prompt / overlay card.
CTA_TERMS = {
    "follow", "subscribe", "comment", "swipe", "link", "bio", "join", "signup",
    "tap", "click", "dm", "share", "save", "download",
}
# Multi-word CTA phrases (matched as substrings against joined OCR text).
CTA_PHRASES = (
    "link in bio", "swipe up", "follow for", "sign up", "out now",
    "tap the", "comment below", "drop a", "check the", "link below",
)

VE_EDGE_THR = 18.0       # |gradient| above this = an edge pixel (0-255 gray scale)
VE_FLAT_THR = 6.0        # |gradient| below this = a flat pixel
VE_STATIC_THR = 7.0      # per-pixel temporal std below this = a static pixel
VE_DYNAMIC_FLOOR = 4.0   # frame motion below this = "mostly static" clip
VE_CENTER_MOVING = 0.35  # center static ratio below this = background genuinely moves
VE_LINE_COVER = 0.6      # a full straight line spans this fraction of its axis
VE_SCREEN_SCORE = 0.5    # screen_recording.score above this -> likely


def extract_frame_stack(
    path: Path, fps: float, max_frames: int, target_w: int, src_w: Any, src_h: Any
) -> np.ndarray | None:
    """Decode a small RGB frame stack -> uint8 array (n, h, w, 3), or None on failure.

    Nearest-neighbour scaling preserves the blocky exact-colour structure of screen
    captures (real interpolation would invent unique colours and soften panel edges).
    """
    sw, sh = safe_float(src_w), safe_float(src_h)
    if sw < 1 or sh < 1:
        return None
    tw = max(2, int(target_w) - int(target_w) % 2)
    th = max(2, int(round(tw * sh / sw)))
    th -= th % 2
    vf = f"fps={fps},scale={tw}:{th}:flags=neighbor,format=rgb24"
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-vf", vf,
           "-frames:v", str(int(max_frames)), "-f", "rawvideo", "-"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE)
    frame_bytes = tw * th * 3
    n = len(proc.stdout) // frame_bytes if frame_bytes else 0
    if n < 2:
        return None
    arr = np.frombuffer(proc.stdout[: n * frame_bytes], dtype=np.uint8)
    return arr.reshape(n, th, tw, 3)


def _gray_stack(stack: np.ndarray) -> np.ndarray:
    f = stack.astype(np.float32)
    return 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]


def _zone(mask: np.ndarray, r0: float, r1: float, c0: float, c1: float) -> np.ndarray:
    h, w = mask.shape
    return mask[int(r0 * h):int(r1 * h), int(c0 * w):int(c1 * w)]


# Map a static-region zone to the kind of overlay it most likely is. Corners read as
# brand logos / @handles; the centered top/bottom bands read as pinned title/hook or
# caption cards (verified on real reels: a sharp title card up top, mush behind it).
OVERLAY_ZONES = {
    "top-left": ((0.0, 0.28, 0.0, 0.34), "logo_or_handle"),
    "top-right": ((0.0, 0.28, 0.66, 1.0), "logo_or_handle"),
    "bottom-left": ((0.72, 1.0, 0.0, 0.34), "logo_or_handle"),
    "bottom-right": ((0.72, 1.0, 0.66, 1.0), "logo_or_handle"),
    "top-center": ((0.0, 0.16, 0.30, 0.70), "title_or_caption_card"),
    "bottom-center": ((0.84, 1.0, 0.20, 0.80), "title_or_caption_card"),
}


def detect_persistent_overlays(gray: np.ndarray) -> dict[str, Any]:
    """Find persistent overlays: regions static across time while the scene moves.

    Catches brand logos / @handles and pinned title/caption cards alike — anything
    fixed on top of moving footage. The per-detection ``kind`` distinguishes a corner
    mark from a centered title band.
    """
    temporal_std = gray.std(axis=0)              # (h, w)
    motion_mean = float(temporal_std.mean())
    static_mask = temporal_std < VE_STATIC_THR
    mean_frame = gray.mean(axis=0)
    gx = np.abs(np.diff(mean_frame, axis=1))     # (h, w-1)
    gy = np.abs(np.diff(mean_frame, axis=0))     # (h-1, w)
    h, w = gray.shape[1], gray.shape[2]
    edge_mask = (gx[: h - 1, : w - 1] + gy[: h - 1, : w - 1]) > VE_EDGE_THR

    center_static = float(_zone(static_mask, 0.3, 0.7, 0.3, 0.7).mean())
    # A real overlay sits ON TOP of genuinely moving video. If the center is itself
    # mostly static (screen recording, slideshow, locked-off shot) then "static
    # corners" are just static content, not an overlay — so require a moving center.
    moving_background = center_static < VE_CENTER_MOVING and motion_mean > VE_DYNAMIC_FLOOR
    detections = []
    if moving_background:
        for name, ((r0, r1, c0, c1), kind) in OVERLAY_ZONES.items():
            s = float(_zone(static_mask, r0, r1, c0, c1).mean())
            e = float(_zone(edge_mask, r0, r1, c0, c1).mean())
            if s > 0.55 and e > 0.06:  # static here + has structure (text/mark)
                conf = round(min(1.0, 0.5 * s + 5.0 * e), 3)
                detections.append(
                    {"zone": name, "kind": kind, "static_ratio": round(s, 3),
                     "edge_density": round(e, 3), "confidence": conf}
                )
    detections.sort(key=lambda d: d["confidence"], reverse=True)
    return {
        "present": bool(detections),
        "kinds": sorted({d["kind"] for d in detections}),
        "zones": [d["zone"] for d in detections],
        "detections": detections,
        "motion_mean": round(motion_mean, 3),
        "center_static_ratio": round(center_static, 3),
        "mostly_static": motion_mean < VE_DYNAMIC_FLOOR,
    }


def detect_screen_recording(stack: np.ndarray, gray: np.ndarray, ocr_terms: set[str]) -> dict[str, Any]:
    """Score how screen-capture-like a clip is from structure + palette + dev tokens."""
    n, h, w = gray.shape
    edge_fracs, flat_fracs, line_scores = [], [], []
    for i in np.linspace(0, n - 1, min(n, 12)).astype(int):
        g = gray[i]
        dx = np.abs(np.diff(g, axis=1))          # (h, w-1) vertical edges
        dy = np.abs(np.diff(g, axis=0))          # (h-1, w) horizontal edges
        grad = dx[: h - 1, : w - 1] + dy[: h - 1, : w - 1]
        edge_fracs.append(float(np.mean(grad > VE_EDGE_THR)))
        flat_fracs.append(float(np.mean(grad < VE_FLAT_THR)))
        # Full straight lines = UI chrome / panel borders: a column (or row) where the
        # edge spans most of the frame height (or width).
        v_lines = int(np.sum(np.mean(dx > VE_EDGE_THR, axis=0) > VE_LINE_COVER))
        h_lines = int(np.sum(np.mean(dy > VE_EDGE_THR, axis=1) > VE_LINE_COVER))
        line_scores.append(min(1.0, (v_lines + h_lines) / 8.0))

    # Colour concentration: synthetic UIs reuse exact RGB values; camera footage spreads
    # across thousands of noisy colours. Fraction of pixels in the 32 most common colours.
    cc_px = stack[np.linspace(0, n - 1, min(n, 6)).astype(int)].reshape(-1, 3).astype(np.uint32)
    packed = (cc_px[:, 0] << 16) | (cc_px[:, 1] << 8) | cc_px[:, 2]
    counts = np.sort(np.unique(packed, return_counts=True)[1])
    color_concentration = float(counts[-32:].sum() / counts.sum()) if counts.size else 0.0

    tokens = sorted(t for t in ocr_terms if t in UI_TEXT_TOKENS)
    edge_density = float(np.mean(edge_fracs))  # reported only; screens are LOW-edge (flat panels)
    flat_fraction = float(np.mean(flat_fracs))
    line_score = float(np.mean(line_scores))
    # Calibrated on screen-rec vs camera clips: synthetic palette (color_concentration)
    # is by far the cleanest separator (screens ~0.8-0.97 vs camera ~0.02-0.12), with
    # flat panels second. Straight lines and dev tokens are weak corroborators.
    score = (
        0.45 * color_concentration
        + 0.30 * flat_fraction
        + 0.15 * line_score
        + 0.10 * (1.0 if tokens else 0.0)
    )
    score = round(min(1.0, score), 3)
    return {
        "likely": score >= VE_SCREEN_SCORE,
        "score": score,
        "signals": {
            "line_score": round(line_score, 3),
            "flat_region_fraction": round(flat_fraction, 3),
            "color_concentration": round(color_concentration, 3),
            "edge_density": round(edge_density, 3),
            "ui_text_tokens": tokens,
        },
    }


def classify_text_overlays(ocr: dict[str, Any]) -> dict[str, Any]:
    """Split on-screen text into continuous subtitles vs transient pop-ups/CTAs."""
    if not ocr or not ocr.get("enabled"):
        return {"subtitles": {"present": False, "reason": "no_ocr"}, "popups": {"count": 0, "reason": "no_ocr"}}
    zones_tl = ocr.get("per_frame_zones") or []
    texts = ocr.get("per_frame_text") or []
    n = len(zones_tl) or 1
    bottom_cov = sum("bottom" in z for z in zones_tl) / n
    nonbottom = [bool(set(z) & {"top", "middle"}) for z in zones_tl]
    nonbottom_cov = sum(nonbottom) / n

    if bottom_cov >= 0.7:
        style = "bottom-continuous"
    elif bottom_cov >= 0.5:
        style = "bottom-intermittent"
    else:
        style = "none"

    # Count off->on bursts of non-bottom text; treat as pop-ups only when transient
    # (present in some but not nearly all frames -> not a fixed header/branding).
    bursts, prev = 0, False
    for f in nonbottom:
        bursts += int(f and not prev)
        prev = f
    transient = 0.0 < nonbottom_cov < 0.85
    blob = " ".join(texts).lower()
    cta_terms = sorted({t for t in CTA_TERMS if re.search(rf"\b{re.escape(t)}\b", blob)})
    cta_phrases = [p for p in CTA_PHRASES if p in blob]
    return {
        "subtitles": {
            "present": bottom_cov >= 0.5,
            "style": style,
            "bottom_coverage_ratio": round(bottom_cov, 3),
        },
        "popups": {
            "count": bursts if transient else 0,
            "transient_nonbottom_text": transient,
            "nonbottom_coverage_ratio": round(nonbottom_cov, 3),
            "cta_terms": cta_terms,
            "cta_phrases": cta_phrases,
        },
    }


def detect_visual_elements(
    args: argparse.Namespace, path: Path, src_w: Any, src_h: Any, ocr: dict[str, Any]
) -> dict[str, Any]:
    stack = extract_frame_stack(path, args.visual_fps, args.visual_max_frames, args.visual_width, src_w, src_h)
    if stack is None:
        return {"enabled": False, "reason": "frame_extraction_failed"}
    gray = _gray_stack(stack)
    ocr_terms = {str(term).lower() for term, _ in (ocr.get("top_terms") or [])}
    overlays = classify_text_overlays(ocr)
    n, h, w = gray.shape
    return {
        "enabled": True,
        "method": "local-heuristics",
        "frames_analyzed": int(n),
        "frame_size": [int(w), int(h)],
        "persistent_overlay": detect_persistent_overlays(gray),
        "screen_recording": detect_screen_recording(stack, gray, ocr_terms),
        "subtitles": overlays["subtitles"],
        "popups": overlays["popups"],
    }


def analyze_video(args: argparse.Namespace, row: dict[str, str], video_path: Path) -> dict[str, Any]:
    video_id = row["id"]
    video_out = args.out / "videos" / video_id
    palette_path = args.out / "palettes" / f"{video_id}.png"
    ocr_dir = video_out / "ocr_frames"
    transcript_dir = video_out / "transcript"
    meta = ffprobe(video_path)
    format_info = meta.get("format", {})
    streams = meta.get("streams", [])
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), {})

    result: dict[str, Any] = {
        "id": video_id,
        "username": row.get("username"),
        "selection_type": row.get("selection_type"),
        "selection_rank": row.get("selection_rank"),
        "url": row.get("url"),
        "views": safe_float(row.get("views")),
        "like_count": safe_float(row.get("like_count")),
        "comment_count": safe_float(row.get("comment_count")),
        "shares": safe_float(row.get("shares")),
        "shares_source": row.get("shares_source"),
        "video_path": str(video_path),
        "duration": safe_float(format_info.get("duration") or row.get("duration")),
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "codec": video_stream.get("codec_name"),
        "palette": sample_palette(video_path, args.palette_fps, palette_path),
        "scenes": (
            {"enabled": False, "reason": "skipped (--skip-scenes); pacing from model/extract_features.py"}
            if args.skip_scenes
            else detect_scenes(video_path, args.scene_detector, args.scene_threshold)
        ),
        "audio": extract_audio_features(video_path),
        "ocr": {"enabled": False, "reason": "skipped"},
        "transcript": {"enabled": False, "reason": "not_requested"},
        "visual_elements": {"enabled": False, "reason": "skipped"},
    }
    if not args.skip_ocr:
        result["ocr"] = ocr_frames(video_path, ocr_dir, args.ocr_every, args.ocr_max_frames)
    if not args.skip_visual:
        result["visual_elements"] = detect_visual_elements(
            args, video_path, video_stream.get("width"), video_stream.get("height"), result["ocr"]
        )
    if args.transcribe:
        result["transcript"] = maybe_transcribe(video_path, transcript_dir, args.whisper_model)
    else:
        cached = load_existing_transcript(transcript_dir, video_path.stem)
        if cached is not None:
            result["transcript"] = cached

    result["scene_cuts"] = scene_cuts_from_scenes(result["scenes"])

    video_out.mkdir(parents=True, exist_ok=True)
    (video_out / "features.json").write_text(json.dumps(result, indent=2))
    return result


def flatten_summary(item: dict[str, Any]) -> dict[str, Any]:
    ocr = item.get("ocr") or {}
    audio = item.get("audio") or {}
    palette = item.get("palette") or {}
    scenes = item.get("scenes") or {}
    transcript = item.get("transcript") or {}
    ve = item.get("visual_elements") or {}
    overlay = ve.get("persistent_overlay") or {}
    screen = ve.get("screen_recording") or {}
    subs = ve.get("subtitles") or {}
    popups = ve.get("popups") or {}
    return {
        "id": item.get("id"),
        "username": item.get("username"),
        "selection_type": item.get("selection_type"),
        "selection_rank": item.get("selection_rank"),
        "views": item.get("views"),
        "like_count": item.get("like_count"),
        "comment_count": item.get("comment_count"),
        "shares": item.get("shares"),
        "duration": item.get("duration"),
        "width": item.get("width"),
        "height": item.get("height"),
        "palette_sample_count": palette.get("sample_count"),
        "avg_rgb": json.dumps(palette.get("avg_rgb")),
        "brightness_mean": palette.get("brightness_mean"),
        "brightness_std": palette.get("brightness_std"),
        "colorfulness_mean": palette.get("colorfulness_mean"),
        "scene_count": scenes.get("scene_count"),
        "cut_count": scenes.get("cut_count"),
        "scenes_per_second": (
            round(scenes["scene_count"] / item["duration"], 4)
            if scenes.get("scene_count") and item.get("duration")
            else None
        ),
        "scene_boundaries": json.dumps(scenes.get("scene_boundaries")),
        "scene_engine": scenes.get("engine"),
        "audio_present": audio.get("audio_present"),
        "rms_db_mean": audio.get("rms_db_mean"),
        "dynamic_range_db": audio.get("dynamic_range_db"),
        "spectral_centroid_hz": audio.get("spectral_centroid_hz"),
        "soundscape_hint": audio.get("soundscape_hint"),
        "ocr_frames_sampled": ocr.get("frames_sampled"),
        "ocr_frames_with_text": ocr.get("frames_with_text"),
        "ocr_text_presence_ratio": ocr.get("text_presence_ratio"),
        "likely_subtitles": ocr.get("likely_subtitles"),
        "ocr_sample_text": " | ".join((ocr.get("sample_text") or [])[:3]),
        "has_persistent_overlay": overlay.get("present"),
        "overlay_kinds": "|".join(overlay.get("kinds") or []),
        "overlay_zones": "|".join(overlay.get("zones") or []),
        "mostly_static": overlay.get("mostly_static"),
        "screen_recording_likely": screen.get("likely"),
        "screen_recording_score": screen.get("score"),
        "subtitles_present": subs.get("present"),
        "subtitle_style": subs.get("style"),
        "popup_count": popups.get("count"),
        "cta_terms": "|".join(popups.get("cta_terms") or []),
        "transcript_enabled": transcript.get("enabled"),
        "transcript_text": transcript.get("text", ""),
        "video_path": item.get("video_path"),
    }


def write_summary(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(rows[0].keys())
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def backfill_scene_cuts(out: Path) -> int:
    updated = 0
    for feat in sorted((out / "videos").glob("*/features.json")):
        try:
            data = json.loads(feat.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if "scenes" not in data:
            continue
        data["scene_cuts"] = scene_cuts_from_scenes(data["scenes"])
        feat.write_text(json.dumps(data, indent=2))
        updated += 1
    print(f"Backfilled scene_cuts on {updated} features.json files under {out / 'videos'}")
    return updated


def main() -> int:
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.backfill_scene_cuts:
        backfill_scene_cuts(args.out)
        return 0
    if args.skip_scenes:
        print("Note: --skip-scenes — pacing/cut features come from model/extract_features.py")
    else:
        print("Note: v1 scene cuts are summary-only; model pacing → model/extract_features.py")
    selected = read_selected(args.selected_csv)
    downloads = index_downloads(args.downloads)
    if args.ids:
        selected = [row for row in selected if row.get("id") in set(args.ids)]
    if args.limit:
        selected = selected[: args.limit]

    outputs = []
    missing = []
    for index, row in enumerate(selected, start=1):
        video_id = row.get("id") or ""
        video_path = downloads.get(video_id)
        if not video_path:
            missing.append(video_id)
            continue
        print(f"[{index}/{len(selected)}] analyzing {video_id} {row.get('username')}")
        try:
            outputs.append(analyze_video(args, row, video_path))
        except Exception as exc:  # Keep batch jobs moving.
            error = {
                "id": video_id,
                "username": row.get("username"),
                "video_path": str(video_path),
                "error": str(exc),
            }
            video_out = args.out / "videos" / video_id
            video_out.mkdir(parents=True, exist_ok=True)
            (video_out / "features.json").write_text(json.dumps(error, indent=2))
            print(f"  failed: {exc}")

    summary_rows = [flatten_summary(item) for item in outputs if "error" not in item]
    write_summary(args.out / "analysis-summary.csv", summary_rows)
    (args.out / "missing-downloads.json").write_text(json.dumps(missing, indent=2))
    print(f"\nAnalyzed: {len(outputs)}")
    print(f"Missing downloads: {len(missing)}")
    print(f"Summary: {args.out / 'analysis-summary.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
