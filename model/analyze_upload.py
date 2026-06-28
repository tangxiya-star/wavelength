#!/usr/bin/env python3
"""Analyze an uploaded clip end-to-end for the NeuroViral web frontend.

Runs the product pipeline — extract_features -> extract_embeddings ->
predict_waveform — on a single uploaded video, then prints ONE JSON line to
stdout with the parsed content characteristics + the model's predicted EEG
interest curve. All progress/logging goes to stderr so stdout is clean JSON.

  python3 analyze_upload.py --video /path/to/<id>.mp4 --id <id>

The video file MUST be named <id>.<ext> (extract_embeddings looks it up by id).
"""
from __future__ import annotations
import argparse, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, cwd=REPO, stdout=sys.stderr, stderr=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--id", required=True)
    args = ap.parse_args()
    vid = args.id
    vpath = Path(args.video).resolve()
    vdir = vpath.parent
    py = sys.executable

    # 1) content features  -> model/features/videos/<id>/<id>.json
    run([py, str(ROOT / "extract_features.py"), "--videos", f"{vid}={vpath}", "--videos-only", "--out", str(ROOT / "features")])
    # 2) SigLIP/CLAP embeddings -> model/embeddings/<id>.npz
    run([py, str(ROOT / "extract_embeddings.py"), "--features-dir", str(ROOT / "features" / "videos"),
         "--videos-dir", str(vdir), "--out-dir", str(ROOT / "embeddings"), "--overwrite"])
    # 3) predicted EEG waveform -> model/out/predicted_waveform_<id>.json
    run([py, str(ROOT / "predict_waveform.py"), "--video-id", vid])

    feat = json.loads((ROOT / "features" / "videos" / vid / f"{vid}.json").read_text())
    agg = feat.get("aggregate", {})
    pred = json.loads((ROOT / "out" / f"predicted_waveform_{vid}.json").read_text())

    music, speech = agg.get("music_present"), agg.get("speech_present")
    audio = "music+VO" if music and speech else "VO" if speech else "music" if music else "ambient"
    kind = "talking-head" if agg.get("is_talking_head") else "visual"
    characteristics = {
        "audio": audio,
        "transcript_summary": f"Uploaded {kind} clip",
        "cut_count": int(agg.get("scene_cut_count") or 0),
        "on_screen_text": "captions" if agg.get("likely_subtitles") else "",
        "subtitles": bool(agg.get("likely_subtitles")),
    }
    out = {
        "video_id": vid,
        "duration_ms": int(round(float(feat.get("duration_s") or 0) * 1000)),
        "characteristics": characteristics,
        "curve": {"t": pred["t"], "interest": pred["interest"], "peak_t": pred["peak_t"]},
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
