#!/usr/bin/env python3
"""Schema-v2 time-resolved video feature extractor (FlowState model).

Offline precomputation for the FlowState virality/retention model. Produces, per
video, a per-window feature **curve** (default 2 Hz) + a 0-3s **hook** block +
**aggregate** scalars.

Design for speed: ONE frame-decode pass (ffmpeg -> temp PNGs at the sample
cadence) feeds colour + motion + faces + OCR; ONE audio pass feeds the loudness
curve and audio semantics. Scene cuts and transcript are NOT recomputed here -
they are read from the v1 analysis (scripts/.../video-analysis/videos/<id>/
features.json, produced by `npm run videos:analyze`), since those are "done".
If a v1 file is missing, cuts fall back to a local scene pass and transcript is
left null.

Faces use OpenCV's Haar cascade (mediapipe not required). Decoding is done via
ffmpeg subprocess (not cv2.VideoCapture) to avoid the cv2/av libavdevice clash.

Outputs:
  model/features/<id>.json        full v2 record (windows[] + hook + aggregate)
  model/features/feature_table.csv  one flat row per video (aggregate + hook) for M1
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import numpy as np

# cv2 import emits a harmless objc duplicate-class warning (cv2 + av both ship
# libavdevice). We only use cv2 for Haar face detection on numpy arrays, never
# its video/av decode path, so the clash does not affect us.
import cv2  # noqa: E402

FEATURE_SCHEMA_VERSION = "2.0"

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SELECTED_CSV = ROOT / "scripts/ig-reels-scraper/ig-data/selected-videos.csv"
DEFAULT_DOWNLOADS = ROOT / "scripts/ig-reels-scraper/ig-data/selected-downloads"
DEFAULT_V1_ANALYSIS = ROOT / "scripts/ig-reels-scraper/ig-data/video-analysis/videos"
DEFAULT_OUT = ROOT / "model/features"

SAMPLE_FPS = 2.0          # window cadence: 0.5 s windows
FRAME_WIDTH = 320         # working width for colour/motion/faces (px)
HOOK_SECONDS = 3.0        # the 0-3s hook block
HOOK_CUT_SECONDS = 5.0    # hook_cuts counts cuts in the first 5 s
OCR_EVERY_SECONDS = 1.0   # OCR cadence (coarser than the frame cadence)
SILENCE_FLOOR_DB = -45.0
AUDIO_SR = 16000

_CASCADE: cv2.CascadeClassifier | None = None  # lazy per-worker


# ----------------------------------------------------------------------------- utils
def run(cmd: list[str], *, check: bool = True, capture: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=check, text=True, capture_output=capture)


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def ffprobe_meta(path: Path) -> dict[str, Any]:
    out = run(["ffprobe", "-v", "error", "-print_format", "json",
               "-show_format", "-show_streams", str(path)]).stdout
    meta = json.loads(out)
    fmt = meta.get("format", {})
    streams = meta.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    num, _, den = (v.get("avg_frame_rate") or "0/1").partition("/")
    fps = safe_float(num) / safe_float(den, 1.0) if safe_float(den, 1.0) else 0.0
    return {
        "duration": safe_float(fmt.get("duration") or v.get("duration")),
        "width": v.get("width"),
        "height": v.get("height"),
        "codec": v.get("codec_name"),
        "src_fps": round(fps, 3),
        "has_audio": has_audio,
    }


def index_downloads(downloads: Path) -> dict[str, Path]:
    return {p.stem: p for p in downloads.rglob("*.mp4")}


def get_cascade() -> cv2.CascadeClassifier:
    global _CASCADE
    if _CASCADE is None:
        _CASCADE = cv2.CascadeClassifier(
            str(Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml")
        )
    return _CASCADE


# --------------------------------------------------------------------------- frames
def decode_frames(path: Path, fps: float, width: int, tmp: Path) -> list[Path]:
    """One ffmpeg pass -> PNG frames at `fps`, scaled to `width` (even height).

    PNGs carry their own dimensions (rotation-safe) and double as OCR input.
    """
    tmp.mkdir(parents=True, exist_ok=True)
    pattern = tmp / "f_%05d.png"
    run(["ffmpeg", "-v", "error", "-i", str(path),
         "-vf", f"fps={fps},scale={width}:-2", str(pattern)])
    return sorted(tmp.glob("f_*.png"))


def frame_features(bgr: np.ndarray, prev_gray: np.ndarray | None) -> tuple[dict[str, Any], np.ndarray]:
    """Per-frame colour + motion + face metrics from a BGR uint8 frame."""
    h, w = bgr.shape[:2]
    rgb = bgr[:, :, ::-1].astype(np.float32)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]

    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    brightness = float(luma.mean()) / 255.0
    contrast = float(luma.std()) / 255.0

    rgmb = r - g
    ybmb = 0.5 * (r + g) - b
    colorfulness = float(
        math.sqrt(rgmb.var() + ybmb.var())
        + 0.3 * math.sqrt(rgmb.mean() ** 2 + ybmb.mean() ** 2)
    )

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    hsv_s = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)[:, :, 1]
    saturation = float(hsv_s.mean()) / 255.0

    motion = (
        float(np.abs(gray.astype(np.float32) - prev_gray.astype(np.float32)).mean()) / 255.0
        if prev_gray is not None else 0.0
    )

    faces = get_cascade().detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5,
        minSize=(max(20, int(0.06 * w)), max(20, int(0.06 * w))),
    )
    face_count = len(faces)
    if face_count:
        areas = [(fw * fh, fx, fy, fw, fh) for (fx, fy, fw, fh) in faces]
        area, fx, fy, fw, fh = max(areas)
        face_size_frac = area / float(w * h)
        cx, cy = fx + fw / 2.0, fy + fh / 2.0
        dist = math.hypot(cx - w / 2.0, cy - h / 2.0) / math.hypot(w / 2.0, h / 2.0)
        face_centrality = round(1.0 - min(1.0, dist), 4)
    else:
        face_size_frac = 0.0
        face_centrality = 0.0

    return ({
        "brightness": round(brightness, 4),
        "colorfulness": round(colorfulness, 3),
        "saturation": round(saturation, 4),
        "contrast": round(contrast, 4),
        "motion": round(motion, 4),
        "face_present": int(face_count > 0),
        "face_count": face_count,
        "face_size_frac": round(face_size_frac, 4),
        "face_centrality": face_centrality,
    }, gray)


# ---------------------------------------------------------------------------- audio
def audio_features(path: Path, n_windows: int, win_s: float) -> dict[str, Any]:
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1",
           "-ar", str(AUDIO_SR), "-f", "s16le", "-"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or not proc.stdout:
        return {"audio_present": False, "loudness_curve": [None] * n_windows}
    audio = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    if audio.size == 0:
        return {"audio_present": False, "loudness_curve": [None] * n_windows}

    win = max(1, int(AUDIO_SR * win_s))
    usable = (audio.size // win) * win
    frames = audio[:usable].reshape(-1, win) if usable else audio.reshape(1, -1)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    rms_db = 20 * np.log10(rms + 1e-12)

    # per-window loudness curve aligned to the video windows (clamp/forward-fill)
    curve = [round(float(rms_db[min(i, len(rms_db) - 1)]), 2) for i in range(n_windows)]

    zcr = float(np.mean(np.abs(np.diff(np.signbit(audio))))) if audio.size > 1 else 0.0
    window = audio[: min(audio.size, AUDIO_SR * 30)]
    spectrum = np.abs(np.fft.rfft(window * np.hanning(window.size)))
    freqs = np.fft.rfftfreq(window.size, d=1 / AUDIO_SR)
    total = float(np.sum(spectrum)) + 1e-12
    centroid = float(np.sum(freqs * spectrum) / total)
    bandwidth = float(np.sqrt(np.sum(((freqs - centroid) ** 2) * spectrum) / total))
    dyn_range = float(np.percentile(rms_db, 95) - np.percentile(rms_db, 10))

    music = centroid > 2500 and bandwidth > 1800 and dyn_range < 18
    speech = 500 <= centroid <= 2500 and zcr < 0.14
    silence_fraction = float(np.mean(rms_db < SILENCE_FLOOR_DB))
    # onset proxy: windows where loudness jumps > 6 dB vs the previous window
    onsets = int(np.sum(np.diff(rms_db) > 6.0)) if rms_db.size > 1 else 0
    onset_density = onsets / max(1e-6, (rms_db.size * win_s))

    return {
        "audio_present": True,
        "loudness_curve": curve,
        "rms_db_mean": round(float(np.mean(rms_db)), 3),
        "loudness_mean_db": round(float(np.mean(rms_db)), 3),
        "dynamic_range_db": round(dyn_range, 3),
        "spectral_centroid_hz": round(centroid, 2),
        "spectral_bandwidth_hz": round(bandwidth, 2),
        "zero_crossing_rate": round(zcr, 5),
        "speech_present": int(speech),
        "music_present": int(music),
        "silence_fraction": round(silence_fraction, 4),
        "onset_density": round(onset_density, 4),
    }


# ------------------------------------------------------------------------------ OCR
def ocr_frame(png: Path) -> tuple[bool, str | None]:
    """Tesseract presence + dominant vertical zone for one frame PNG."""
    res = run(["tesseract", str(png), "stdout", "--psm", "11", "tsv"], check=False)
    img_h = None
    zones: Counter[str] = Counter()
    present = False
    for row in csv.DictReader(res.stdout.splitlines(), delimiter="\t"):
        text = (row.get("text") or "").strip()
        # conf>=60 and >=2 alphanumeric chars: drops watermark/noise single glyphs
        if not text or safe_float(row.get("conf"), -1) < 60:
            continue
        if sum(c.isalnum() for c in text) < 2:
            continue
        present = True
        if img_h is None:
            img_h = cv2.imread(str(png)).shape[0]
        center = (safe_float(row.get("top")) + safe_float(row.get("height")) / 2) / max(1, img_h)
        zones["top" if center < 0.33 else "bottom" if center > 0.66 else "middle"] += 1
    dom = zones.most_common(1)[0][0] if zones else None
    return present, dom


# --------------------------------------------------------------------------- v1 read
def read_v1(v1_dir: Path, video_id: str) -> dict[str, Any]:
    """Read scene cuts + transcript from the v1 analysis (already done)."""
    f = v1_dir / video_id / "features.json"
    if not f.exists():
        return {}
    try:
        return json.loads(f.read_text())
    except (json.JSONDecodeError, OSError):
        return {}  # v1 may still be writing this file; treat as absent


def ffmpeg_cuts(path: Path, threshold: float = 0.35) -> list[float]:
    vf = f"scale=320:-2,select='gt(scene,{threshold})',showinfo"
    res = run(["ffmpeg", "-hide_banner", "-i", str(path), "-vf", vf, "-f", "null", "-"], check=False)
    text = (res.stderr or "") + (res.stdout or "")
    return [round(safe_float(m.group(1)), 3) for m in re.finditer(r"pts_time:([0-9.]+)", text)]


def scenedetect_cuts(path: Path, threshold: float = 27.0) -> list[float] | None:
    """PySceneDetect ContentDetector cut times (start of each scene after the first)."""
    try:
        from scenedetect import detect, ContentDetector
        scenes = detect(str(path), ContentDetector(threshold=threshold))
        return sorted(round(start.get_seconds(), 3) for start, _ in scenes[1:])
    except Exception:
        return None


def v1_cut_times(v1: dict[str, Any]) -> list[float] | None:
    """Read normalized cut times from v1 features.json (scene_cuts or legacy scenes block)."""
    sc = v1.get("scene_cuts") or {}
    if isinstance(sc.get("cut_times"), list):
        return sorted(float(t) for t in sc["cut_times"])

    scenes = v1.get("scenes") or {}
    if scenes.get("enabled") is False or scenes.get("error"):
        return None
    boundaries = scenes.get("scene_boundaries") or []
    if not boundaries:
        return None
    engine = str(scenes.get("engine") or "")
    if "pyscenedetect" in engine and safe_float(boundaries[0]) <= 0.05:
        cuts = [round(float(t), 3) for t in boundaries[1:]]
    else:
        cuts = [round(float(t), 3) for t in boundaries]
    return sorted(cuts) if cuts else []


def compute_cuts(path: Path, v1: dict[str, Any]) -> tuple[list[float], str]:
    """Cuts from v1 when present, else PySceneDetect, else ffmpeg scene-filter fallback."""
    v1_cuts = v1_cut_times(v1)
    if v1_cuts is not None:
        source = (v1.get("scene_cuts") or {}).get("source") or (v1.get("scenes") or {}).get("engine") or "v1"
        return v1_cuts, f"v1/{source}"
    sd = scenedetect_cuts(path)
    if sd is not None:
        return sd, "scenedetect"
    return sorted(ffmpeg_cuts(path)), "ffmpeg_fallback"


# --------------------------------------------------------------------- curiosity gap
_CURIOSITY = re.compile(
    r"\b(how|why|what|when|secret|stop|never|mistake|nobody|reason|this is why|here'?s|did you know)\b",
    re.IGNORECASE,
)


def opening_curiosity(transcript: dict[str, Any]) -> int | None:
    segs = transcript.get("segments") or []
    text = (segs[0].get("text") if segs else transcript.get("text") or "").strip()
    if not text:
        return None
    return int(bool(_CURIOSITY.search(text)) or "?" in text or bool(re.match(r"^\s*\d", text)))


# ------------------------------------------------------------------------- assemble
def analyze_one(cfg: dict[str, Any], row: dict[str, str], video_path: Path) -> dict[str, Any]:
    video_id = row["id"]
    meta = ffprobe_meta(video_path)
    duration = meta["duration"]
    fps = cfg["sample_fps"]
    win_s = 1.0 / fps

    with tempfile.TemporaryDirectory(prefix=f"feat_{video_id}_") as td:
        frames = decode_frames(video_path, fps, cfg["width"], Path(td))
        n = len(frames)
        ocr_stride = max(1, round(fps * cfg["ocr_every"]))
        do_ocr = (not cfg["skip_ocr"]) and shutil.which("tesseract") is not None

        per_frame: list[dict[str, Any]] = []
        prev_gray = None
        ocr_present_samples: list[tuple[int, bool, str | None]] = []
        for i, png in enumerate(frames):
            bgr = cv2.imread(str(png))
            if bgr is None:
                per_frame.append({})
                continue
            feats, prev_gray = frame_features(bgr, prev_gray)
            per_frame.append(feats)
            if do_ocr and i % ocr_stride == 0:
                ocr_present_samples.append((i, *ocr_frame(png)))

    audio = (audio_features(video_path, n, win_s) if meta["has_audio"]
             else {"audio_present": False, "loudness_curve": [None] * n})

    # transcript comes from the v1 pass; cuts prefer v1 scene_cuts/scenes when present.
    v1 = read_v1(Path(cfg["v1_dir"]), video_id)
    transcript = v1.get("transcript") or {}
    cut_times, cuts_source = compute_cuts(video_path, v1)

    # OCR forward-fill across windows
    ocr_present = [0] * n
    ocr_zone = [None] * n
    if ocr_present_samples:
        last = (0, None)
        s_idx = 0
        for i in range(n):
            while s_idx < len(ocr_present_samples) and ocr_present_samples[s_idx][0] <= i:
                last = (int(ocr_present_samples[s_idx][1]), ocr_present_samples[s_idx][2])
                s_idx += 1
            ocr_present[i], ocr_zone[i] = last

    # build windows[]
    windows = []
    for i in range(n):
        t = round(i / fps, 3)
        cuts_in = sum(1 for c in cut_times if t <= c < t + win_s)
        w = {"t": t, "cut_in_window": cuts_in,
             "loudness_db": audio["loudness_curve"][i] if i < len(audio["loudness_curve"]) else None,
             "ocr_text_present": ocr_present[i]}
        w.update(per_frame[i])
        windows.append(w)

    def col(key: str) -> np.ndarray:
        return np.array([w[key] for w in windows if w.get(key) is not None], dtype=np.float32)

    def mean(key: str) -> float | None:
        a = col(key)
        return round(float(a.mean()), 4) if a.size else None

    # hook (0-3s) block
    hook_idx = [i for i in range(n) if i / fps < cfg["hook_seconds"]]
    hook_loud = [windows[i]["loudness_db"] for i in hook_idx if windows[i]["loudness_db"] is not None]
    hook = {
        "hook_text_present": int(any(windows[i]["ocr_text_present"] for i in hook_idx)),
        "hook_face": int(any(windows[i].get("face_present") for i in hook_idx)),
        "hook_cuts": sum(1 for c in cut_times if c < cfg["hook_cut_seconds"]),
        "hook_loudness": round(float(np.mean(hook_loud)), 2) if hook_loud else None,
        "opening_curiosity": opening_curiosity(transcript),
    }

    # aggregate block (feeds M1)
    cut_count = len(cut_times)
    boundaries = [0.0] + cut_times + [duration]
    shot_lens = np.diff(boundaries) if duration > 0 else np.array([])
    face_frac = float(np.mean([w.get("face_present", 0) for w in windows])) if n else 0.0
    motion_mean = mean("motion") or 0.0
    ocr_ratio = (sum(1 for _, p, _ in ocr_present_samples if p) / len(ocr_present_samples)
                 if ocr_present_samples else None)
    zone_counter = Counter(z for _, p, z in ocr_present_samples if p and z)
    transcript_words = len((transcript.get("text") or "").split())

    aggregate = {
        "cuts_per_sec": round(cut_count / duration, 4) if duration else None,
        "time_to_first_cut": round(cut_times[0], 3) if cut_times else None,
        "mean_shot_len": round(float(shot_lens.mean()), 3) if shot_lens.size else None,
        "shot_len_std": round(float(shot_lens.std()), 3) if shot_lens.size else None,
        "scene_cut_count": cut_count,
        "brightness_mean": mean("brightness"),
        "colorfulness_mean": mean("colorfulness"),
        "saturation_mean": mean("saturation"),
        "contrast_mean": mean("contrast"),
        "motion_mean": round(motion_mean, 4),
        "loudness_mean_db": audio.get("loudness_mean_db"),
        "speech_present": audio.get("speech_present"),
        "music_present": audio.get("music_present"),
        "silence_fraction": audio.get("silence_fraction"),
        "onset_density": audio.get("onset_density"),
        "spectral_centroid_hz": audio.get("spectral_centroid_hz"),
        "dynamic_range_db": audio.get("dynamic_range_db"),
        "audio_present": audio.get("audio_present"),
        "face_present_frac": round(face_frac, 4),
        "is_talking_head": int(
            face_frac > 0.5 and motion_mean < 0.10
            and bool(audio.get("speech_present") or transcript.get("text"))
        ),
        "ocr_text_presence_ratio": round(ocr_ratio, 4) if ocr_ratio is not None else None,
        "likely_subtitles": bool(zone_counter and zone_counter.most_common(1)[0][0] == "bottom"),
        "ocr_dominant_zone": zone_counter.most_common(1)[0][0] if zone_counter else None,
        "transcript_present": bool(transcript.get("text")),
        "transcript_wps_mean": round(transcript_words / duration, 3) if duration and transcript_words else None,
    }

    return {
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "video_id": video_id,
        "creator_id": row.get("username"),
        "selection_type": row.get("selection_type"),
        "duration_s": round(duration, 3),
        "width": meta["width"], "height": meta["height"],
        "aspect_ratio": round(meta["width"] / meta["height"], 4) if meta.get("height") else None,
        "src_fps": meta["src_fps"], "fps_sampled": fps, "n_windows": n,
        "cuts_source": cuts_source,
        "windows": windows,
        "hook": hook,
        "aggregate": aggregate,
        "video_path": str(video_path),
    }


def _worker(payload: tuple[dict[str, Any], dict[str, str], str]) -> dict[str, Any]:
    cfg, row, video_path = payload
    video_id = row.get("id", "")
    t0 = time.time()
    try:
        result = analyze_one(cfg, row, Path(video_path))
        result["extract_seconds"] = round(time.time() - t0, 2)
        out = Path(cfg["out"]) / "videos" / video_id
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{video_id}.json").write_text(json.dumps(result, indent=2))
        return {"id": video_id, "ok": True, "seconds": result["extract_seconds"],
                "n_windows": result["n_windows"]}
    except Exception as exc:  # keep the batch moving
        out = Path(cfg["out"]) / "videos" / video_id
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{video_id}.json").write_text(json.dumps({"video_id": video_id, "error": str(exc)}, indent=2))
        return {"id": video_id, "ok": False, "error": str(exc)}


# ------------------------------------------------------------------------- flattening
def flatten(result_json: Path) -> dict[str, Any] | None:
    try:
        d = json.loads(result_json.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if "error" in d or "aggregate" not in d:
        return None
    base = {k: d.get(k) for k in
            ("video_id", "creator_id", "selection_type", "duration_s",
             "width", "height", "aspect_ratio", "src_fps", "n_windows", "cuts_source")}
    base.update(d.get("hook", {}))          # hook keys are already prefixed (hook_face, ...)
    base.update(d.get("aggregate", {}))
    return base


def write_feature_table(out: Path) -> int:
    rows = [r for p in sorted((out / "videos").glob("*/*.json")) if (r := flatten(p))]
    if not rows:
        return 0
    fields = list({k for r in rows for k in r})
    ordered = [f for f in (
        "video_id", "creator_id", "selection_type", "duration_s", "width", "height",
        "aspect_ratio", "src_fps", "n_windows", "cuts_source") if f in fields]
    ordered += [f for f in fields if f not in ordered]
    with (out / "feature_table.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ordered)
        w.writeheader()
        w.writerows(rows)
    return len(rows)


# ------------------------------------------------------------------------------ main
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--selected-csv", type=Path, default=DEFAULT_SELECTED_CSV)
    p.add_argument("--downloads", type=Path, default=DEFAULT_DOWNLOADS)
    p.add_argument("--v1-dir", type=Path, default=DEFAULT_V1_ANALYSIS)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--limit", type=int)
    p.add_argument("--ids", nargs="*")
    p.add_argument("--jobs", type=int, default=min(6, max(1, (__import__('os').cpu_count() or 2) - 2)))
    p.add_argument("--sample-fps", type=float, default=SAMPLE_FPS)
    p.add_argument("--width", type=int, default=FRAME_WIDTH)
    p.add_argument("--hook-seconds", type=float, default=HOOK_SECONDS)
    p.add_argument("--hook-cut-seconds", type=float, default=HOOK_CUT_SECONDS)
    p.add_argument("--ocr-every", type=float, default=OCR_EVERY_SECONDS)
    p.add_argument("--skip-ocr", action="store_true")
    p.add_argument("--table-only", action="store_true", help="Only rebuild feature_table.csv from existing JSONs.")
    p.add_argument(
        "--videos", nargs="*", metavar="ID=PATH",
        help="Ad-hoc videos outside selected-videos.csv (e.g. sponsor_cursor=/path/Cursor.mp4).",
    )
    p.add_argument(
        "--videos-only", action="store_true",
        help="Process only --videos entries; skip selected-videos.csv.",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    if args.table_only:
        n = write_feature_table(args.out)
        print(f"feature_table.csv: {n} rows")
        return 0

    selected = [] if args.videos_only else list(csv.DictReader(args.selected_csv.open(newline="")))
    downloads = index_downloads(args.downloads)
    if args.ids:
        selected = [r for r in selected if r.get("id") in set(args.ids)]
    if args.limit:
        selected = selected[: args.limit]

    cfg = {
        "out": str(args.out), "v1_dir": str(args.v1_dir),
        "sample_fps": args.sample_fps, "width": args.width,
        "hook_seconds": args.hook_seconds, "hook_cut_seconds": args.hook_cut_seconds,
        "ocr_every": args.ocr_every, "skip_ocr": args.skip_ocr,
    }

    payloads = []
    missing = []
    for r in selected:
        vid = r.get("id") or ""
        path = downloads.get(vid)
        if not path:
            missing.append(vid)
            continue
        payloads.append((cfg, r, str(path)))

    for spec in args.videos or []:
        vid, _, path_str = spec.partition("=")
        if not vid or not path_str:
            raise SystemExit(f"Bad --videos spec (want ID=PATH): {spec!r}")
        path = Path(path_str)
        if not path.is_file():
            raise SystemExit(f"Video not found for {vid}: {path}")
        row = {"id": vid, "username": "sponsor", "selection_type": "sponsor"}
        payloads.append((cfg, row, str(path)))

    print(f"videos: {len(payloads)}  missing downloads: {len(missing)}  jobs: {args.jobs}")
    t0 = time.time()
    done = fail = 0
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futures = [ex.submit(_worker, p) for p in payloads]
        for k, fut in enumerate(as_completed(futures), 1):
            res = fut.result()
            if res["ok"]:
                done += 1
                print(f"[{k}/{len(payloads)}] {res['id']}  {res['seconds']}s  {res['n_windows']}w")
            else:
                fail += 1
                print(f"[{k}/{len(payloads)}] {res['id']}  FAILED: {res.get('error')}")

    n_rows = write_feature_table(args.out)
    elapsed = time.time() - t0
    (args.out / "extract-run.json").write_text(json.dumps({
        "videos": len(payloads), "ok": done, "failed": fail, "missing": missing,
        "elapsed_s": round(elapsed, 1), "schema": FEATURE_SCHEMA_VERSION,
    }, indent=2))
    print(f"\nok {done}  failed {fail}  missing {len(missing)}")
    print(f"feature_table.csv: {n_rows} rows  ·  total {elapsed:.1f}s  ({elapsed / max(1, len(payloads)):.1f}s/video)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
