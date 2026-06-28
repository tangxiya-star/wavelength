#!/usr/bin/env python3
"""Reconstruct per-video behavioral retention (drop-off) curves from app events.

Uses `video_watch_progress` heartbeats (positionMs) and `scroll_away` boundaries to
build exposure-level max playback position, then aggregates to a per-window
"still watching" curve aligned to the 0.5 s feature cadence.

Target column: retention_0_1 — fraction of exposures with max_position >= t.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
FEATURES_DIR = ROOT / "model" / "features" / "videos"
WINDOW_S = 0.5

EXPOSURE_START = {"video_impression"}
EXPOSURE_START_FALLBACK = {"video_play_start"}
EXPOSURE_END = {"scroll_away"}
HEARTBEAT = {"video_watch_progress", "video_loop"}


def _start_exposure(row: pd.Series, video_id: str, sess: str) -> dict:
    return {
        "session_id": sess,
        "participant_id": row.get("participant_id"),
        "video_id": video_id,
        "feed_position": row.get("feed_position"),
        "heartbeats_ms": [],
        "scroll_payload": {},
    }


def parse_payload(raw: Any) -> dict:
    if raw is None or (isinstance(raw, float) and np.isnan(raw)):
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}


def load_events(events_csv: Path) -> pd.DataFrame:
    df = pd.read_csv(events_csv)
    if "client_ts" in df.columns:
        df["client_ts"] = pd.to_datetime(df["client_ts"], utc=True, errors="coerce")
    return df.sort_values(["session_id", "client_ts"], na_position="last").reset_index(drop=True)


def _session_key(row: pd.Series) -> str:
    sid = row.get("session_id")
    if isinstance(sid, str) and sid.strip():
        return sid.strip()
    pid = row.get("participant_id")
    if isinstance(pid, str) and pid.strip():
        return f"anon_{pid.strip()}"
    return "anon_import"


def _walk_session(rows: pd.DataFrame, sess: str) -> list[dict]:
    """Segment exposures within one session."""
    exposures: list[dict] = []
    current: Optional[dict] = None

    for _, row in rows.iterrows():
        et = row.get("event_type")
        if not isinstance(et, str):
            continue

        payload = parse_payload(row.get("payload"))
        video_id = row.get("video_id")
        if et not in EXPOSURE_START | EXPOSURE_START_FALLBACK | EXPOSURE_END | HEARTBEAT:
            continue
        if not isinstance(video_id, str) or not video_id.strip():
            continue
        video_id = video_id.strip()

        if et in EXPOSURE_START:
            if current is not None:
                exposures.append(current)
            current = _start_exposure(row, video_id, sess)
        elif current is None and et in EXPOSURE_START_FALLBACK:
            current = _start_exposure(row, video_id, sess)
        elif current is None:
            if et in HEARTBEAT:
                current = _start_exposure(row, video_id, sess)
            else:
                continue

        if current is None:
            continue

        if et in EXPOSURE_START and current["video_id"] != video_id:
            exposures.append(current)
            current = _start_exposure(row, video_id, sess)

        if et in HEARTBEAT:
            pos = payload.get("positionMs") or payload.get("position_ms")
            if pos is not None:
                try:
                    current["heartbeats_ms"].append(int(float(pos)))
                except (TypeError, ValueError):
                    pass
            max_pos = payload.get("maxPositionMs") or payload.get("max_position_ms")
            if max_pos is not None:
                try:
                    current["heartbeats_ms"].append(int(float(max_pos)))
                except (TypeError, ValueError):
                    pass

        if et in EXPOSURE_END:
            current["scroll_payload"] = payload
            exposures.append(current)
            current = None

    if current is not None:
        exposures.append(current)
    return exposures


def segment_exposures(events: pd.DataFrame) -> list[dict]:
    """Walk the event stream and return one dict per exposure."""
    events = events.copy()
    events["_sess"] = events.apply(_session_key, axis=1)
    exposures: list[dict] = []
    for sess, grp in events.groupby("_sess", sort=False):
        exposures.extend(_walk_session(grp.sort_values("client_ts"), str(sess)))
    return exposures


def exposure_max_position_ms(exposure: dict, duration_s: float) -> int:
    """Furthest playback position reached during the exposure (ms)."""
    duration_ms = max(int(duration_s * 1000), 1)
    hb_max = max(exposure.get("heartbeats_ms") or [0])
    payload = exposure.get("scroll_payload") or {}

    candidates = [hb_max]
    for key in ("maxPositionMs", "max_position_ms", "finalPositionMs", "final_position_ms"):
        val = payload.get(key)
        if val is not None:
            try:
                candidates.append(int(float(val)))
            except (TypeError, ValueError):
                pass

    pct = payload.get("pctWatched") or payload.get("pct_watched")
    if pct is not None:
        try:
            candidates.append(int(float(pct) * duration_ms))
        except (TypeError, ValueError):
            pass

    return int(min(max(candidates), duration_ms))


def load_durations(features_dir: Path = FEATURES_DIR) -> dict[str, float]:
    durations: dict[str, float] = {}
    if not features_dir.is_dir():
        return durations
    for vdir in sorted(features_dir.iterdir()):
        if not vdir.is_dir():
            continue
        vid = vdir.name
        jpath = vdir / f"{vid}.json"
        if not jpath.exists():
            continue
        feat = json.loads(jpath.read_text())
        dur = float(feat.get("duration_s") or 0.0)
        if dur > 0:
            durations[vid] = dur
    return durations


def build_retention_table(
    events_csv: Path,
    features_dir: Path = FEATURES_DIR,
    window_s: float = WINDOW_S,
    min_exposures: int = 1,
) -> tuple[pd.DataFrame, dict]:
    """
    Return per-(video_id, t) retention targets and a summary dict for logging.

    Columns: video_id, t, retention_0_1, n_exposures
    """
    events = load_events(events_csv)
    exposures = segment_exposures(events)
    durations = load_durations(features_dir)

    by_video: dict[str, list[int]] = {}
    skipped_no_duration = set()
    for exp in exposures:
        vid = exp["video_id"]
        if vid not in durations:
            skipped_no_duration.add(vid)
            continue
        max_ms = exposure_max_position_ms(exp, durations[vid])
        by_video.setdefault(vid, []).append(max_ms)

    rows = []
    for vid, max_list in sorted(by_video.items()):
        if len(max_list) < min_exposures:
            continue
        dur = durations[vid]
        n_windows = max(int(np.ceil(dur / window_s)), 1)
        max_arr = np.array(max_list, dtype=float)
        for i in range(n_windows):
            t = round(i * window_s, 3)
            threshold_ms = t * 1000.0
            retention = float(np.mean(max_arr >= threshold_ms))
            rows.append({
                "video_id": vid,
                "t": t,
                "retention_0_1": retention,
                "n_exposures": len(max_list),
            })

    df = pd.DataFrame(rows)
    summary = {
        "events_csv": str(events_csv),
        "n_events": int(len(events)),
        "n_exposures_total": len(exposures),
        "n_exposures_used": int(sum(len(v) for v in by_video.values())),
        "n_videos_with_curves": int(df["video_id"].nunique()) if len(df) else 0,
        "n_windows": int(len(df)),
        "videos_skipped_no_features": sorted(skipped_no_duration),
        "n_videos_skipped_no_features": len(skipped_no_duration),
    }
    return df, summary


def default_events_path() -> Optional[Path]:
    for candidate in (
        ROOT / "server" / "data" / "exports" / "events.csv",
        ROOT / "demo-log-events.csv",
    ):
        if candidate.exists():
            return candidate
    return None
