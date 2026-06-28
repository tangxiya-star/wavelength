#!/usr/bin/env python3
"""Sponsor / product-demo retention report (AI-UGC judge showcase).

Runs extract_features.py + explain.py on B2B sponsor clips and answers
"does this ad retain?" with a heuristic retention proxy benchmarked against
the locked stimulus set.

Usage:
  python3 model/run_sponsor_report.py
  python3 model/run_sponsor_report.py --sponsor-dir ../sponsor-videos --skip-extract

Outputs:
  model/out/sponsor_report.md
  model/out/sponsor_retention_<id>.png   (one per ad)
  model/out/explain_<id>.json            (from explain.py)
  model/features/videos/sponsor_*/       (from extract_features.py)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "model"
FEATURES_DIR = MODEL / "features" / "videos"
OUT_DIR = MODEL / "out"
DEFAULT_SPONSOR_DIR = ROOT / "sponsor-videos"

# Matches server/data/sponsor-videos.sql + other local sponsor clips.
SPONSOR_CLIPS: list[tuple[str, str, str]] = [
    ("sponsor_cursor", "Cursor.mp4", "Cursor"),
    ("sponsor_openai_codex", "OpenAI_Codex.mp4", "OpenAI Codex"),
    ("sponsor_convex", "Convex.mp4", "Convex"),
    ("sponsor_corgi", "Corgi.mp4", "Corgi"),
    ("sponsor_fiber_ai", "Fiber_AI.mp4", "Fiber AI"),
]

HOOK_WINDOWS = 6  # 3 s @ 2 Hz


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--sponsor-dir", type=Path, default=DEFAULT_SPONSOR_DIR)
    p.add_argument("--out-dir", type=Path, default=OUT_DIR)
    p.add_argument("--skip-extract", action="store_true")
    p.add_argument("--skip-explain", action="store_true")
    p.add_argument("--jobs", type=int, default=2)
    return p.parse_args()


def window_retention_score(w: dict) -> float:
    """Heuristic 0–1 retention proxy per 0.5 s window (no EEG required)."""
    score = 0.0
    if w.get("face_present"):
        score += 0.35
    if w.get("ocr_text_present"):
        score += 0.20
    motion = float(w.get("motion") or 0)
    score += min(motion * 2.0, 0.25)
    loud = w.get("loudness_db")
    if loud is not None:
        score += max(0.0, min(0.20, (float(loud) + 50.0) / 200.0))
    if w.get("cut_in_window"):
        score += 0.05
    return min(1.0, score)


def retention_curve(features: dict) -> list[dict[str, float]]:
    return [
        {"t": float(w.get("t", 0)), "retention_0_1": round(window_retention_score(w), 4)}
        for w in (features.get("windows") or [])
    ]


def retention_summary(curve: list[dict[str, float]], duration: float) -> dict[str, float]:
    if not curve:
        return {"hook": 0.0, "overall": 0.0, "auc": 0.0, "completion_proxy": 0.0}
    scores = [c["retention_0_1"] for c in curve]
    hook = float(np.mean(scores[:HOOK_WINDOWS])) if scores else 0.0
    overall = float(np.mean(scores))
    ts = np.array([c["t"] for c in curve])
    ys = np.array(scores)
    auc_fn = getattr(np, "trapezoid", np.trapz)
    auc = float(auc_fn(ys, ts) / duration) if duration > 0 else overall
    # completion proxy: fraction of video above median engagement
    med = float(np.median(scores))
    completion_proxy = float(np.mean(ys >= med))
    return {
        "hook": round(hook, 4),
        "overall": round(overall, 4),
        "auc": round(auc, 4),
        "completion_proxy": round(completion_proxy, 4),
    }


def load_stimulus_benchmark() -> dict[str, float]:
    """Median retention metrics across the locked IG stimulus set."""
    hooks, overalls, aucs = [], [], []
    for p in sorted(FEATURES_DIR.glob("*/*.json")):
        if p.parent.name.startswith("sponsor_"):
            continue
        try:
            feat = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if "windows" not in feat:
            continue
        s = retention_summary(retention_curve(feat), float(feat.get("duration_s") or 0))
        hooks.append(s["hook"])
        overalls.append(s["overall"])
        aucs.append(s["auc"])
    if not hooks:
        return {"hook": 0.55, "overall": 0.50, "auc": 0.50}
    return {
        "hook": round(float(np.median(hooks)), 4),
        "overall": round(float(np.median(overalls)), 4),
        "auc": round(float(np.median(aucs)), 4),
        "n": len(hooks),
    }


def verdict(summary: dict[str, float], bench: dict[str, float]) -> tuple[str, str]:
    """Return (short label, one-line rationale)."""
    hook_delta = summary["hook"] - bench["hook"]
    overall_delta = summary["overall"] - bench["overall"]
    if hook_delta >= 0.05 and overall_delta >= 0:
        return "Strong retain", "Hook and mid-roll engagement beat the stimulus median."
    if hook_delta >= -0.05 and overall_delta >= -0.05:
        return "Moderate retain", "Near stimulus median — watch hook and pacing for drop-off risk."
    if hook_delta < -0.10:
        return "Hook at risk", "First 3 s underperform the study median; high early swipe risk."
    return "Weak retain", "Below stimulus median on hook and/or sustained engagement."


def run_extract(sponsor_dir: Path, jobs: int) -> None:
    specs = []
    for vid, fname, _ in SPONSOR_CLIPS:
        path = sponsor_dir / fname
        if not path.is_file():
            print(f"[skip] missing {path}", file=sys.stderr)
            continue
        specs.append(f"{vid}={path}")

    if not specs:
        raise SystemExit(f"No sponsor MP4s found in {sponsor_dir}")

    cmd = [
        sys.executable, str(MODEL / "extract_features.py"),
        "--out", str(MODEL / "features"),
        "--jobs", str(jobs),
        "--videos-only",
        "--skip-ocr",
        "--videos", *specs,
    ]
    print(f"[extract] {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def run_explain(video_id: str, out_dir: Path) -> dict[str, Any]:
    from explain import explain  # noqa: WPS433 — sibling module

    return explain(video_id=video_id, out_dir=out_dir)


def plot_retention(
    video_id: str,
    title: str,
    curve: list[dict[str, float]],
    bench: dict[str, float],
    out_path: Path,
) -> None:
    if not curve:
        return
    ts = [c["t"] for c in curve]
    ys = [c["retention_0_1"] for c in curve]
    fig, ax = plt.subplots(figsize=(8, 3))
    ax.plot(ts, ys, color="#6366f1", linewidth=2, label="Ad (heuristic proxy)")
    ax.axhline(bench["overall"], color="#94a3b8", linestyle="--", linewidth=1,
               label=f"Stimulus median ({bench['overall']:.2f})")
    hook_end = min(3.0, ts[-1] if ts else 3.0)
    ax.axvspan(0, hook_end, alpha=0.08, color="#f59e0b", label="Hook (0–3 s)")
    ax.set_xlim(0, ts[-1] if ts else 1)
    ax.set_ylim(0, 1)
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Retention proxy (0–1)")
    ax.set_title(f"{title} — does this ad retain?")
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def build_report(
    results: list[dict[str, Any]],
    bench: dict[str, float],
    out_path: Path,
) -> None:
    lines = [
        "# Sponsor Ad Retention Report",
        "",
        "> **Question:** Does this ad retain?",
        "> Heuristic retention proxy (face + text + motion + audio energy per 0.5 s window),",
        f"> benchmarked against the locked IG stimulus set (n={bench.get('n', '?')}).",
        "> Provisional — real EEG interest curves replace this when sessions land.",
        "",
        "## Summary",
        "",
        "| Ad | Duration | Hook (0–3 s) | Overall | AUC | vs stimulus | Verdict |",
        "|---|---:|---:|---:|---:|---|---|",
    ]

    for r in results:
        s = r["summary"]
        vlabel, _ = verdict(s, bench)
        hook_cmp = f"{s['hook']:.2f} ({s['hook'] - bench['hook']:+.2f})"
        lines.append(
            f"| {r['title']} | {r['duration_s']:.0f}s | {hook_cmp} | "
            f"{s['overall']:.2f} | {s['auc']:.2f} | "
            f"{'↑' if s['overall'] >= bench['overall'] else '↓'} median | **{vlabel}** |"
        )

    lines += ["", "---", ""]

    for r in results:
        vlabel, rationale = verdict(r["summary"], bench)
        lines += [
            f"## {r['title']} (`{r['video_id']}`)",
            "",
            f"**Does this ad retain?** **{vlabel}** — {rationale}",
            "",
            f"- Hook retention (0–3 s): **{r['summary']['hook']:.2f}** "
            f"(stimulus median {bench['hook']:.2f})",
            f"- Overall engagement proxy: **{r['summary']['overall']:.2f}** "
            f"(median {bench['overall']:.2f})",
            f"- Completion proxy: **{r['summary']['completion_proxy']:.0%}** of windows "
            f"at/above median energy",
            f"- Retention curve: `model/out/sponsor_retention_{r['video_id']}.png`",
            "",
        ]

        expl = r.get("explain") or {}
        if expl.get("overall"):
            lines += [f"**Coach summary:** {expl['overall']}", ""]
        if expl.get("hook_critique"):
            lines += [f"**Hook critique:** {expl['hook_critique']}", ""]

        edits = expl.get("edits") or []
        if edits:
            lines.append("**Top edits:**")
            for i, e in enumerate(edits[:3], 1):
                lines.append(f"{i}. {e.get('change', '')}")
            lines.append("")

        weak = expl.get("weak_sections") or []
        if weak:
            lines.append("**Weak sections:**")
            for w in weak[:3]:
                lines.append(f"- {w.get('t_start')}–{w.get('t_end')}s: {w.get('why', '')}")
            lines.append("")

        lines += ["---", ""]

    out_path.write_text("\n".join(lines))
    print(f"[report] wrote {out_path}")


def main() -> int:
    args = parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    if not args.skip_extract:
        run_extract(args.sponsor_dir, args.jobs)

    bench = load_stimulus_benchmark()
    print(f"[benchmark] stimulus medians: hook={bench['hook']} overall={bench['overall']} n={bench.get('n')}")

    results: list[dict[str, Any]] = []
    for vid, fname, title in SPONSOR_CLIPS:
        feat_path = FEATURES_DIR / vid / f"{vid}.json"
        if not feat_path.is_file():
            print(f"[skip] no features for {vid}", file=sys.stderr)
            continue

        features = json.loads(feat_path.read_text())
        if "error" in features:
            print(f"[skip] extract error for {vid}: {features['error']}", file=sys.stderr)
            continue

        curve = retention_curve(features)
        duration = float(features.get("duration_s") or 0)
        summary = retention_summary(curve, duration)

        plot_retention(
            vid, title, curve, bench,
            args.out_dir / f"sponsor_retention_{vid}.png",
        )

        explain_out: dict[str, Any] = {}
        if not args.skip_explain:
            sys.path.insert(0, str(MODEL))
            explain_out = run_explain(vid, args.out_dir)

        results.append({
            "video_id": vid,
            "title": title,
            "duration_s": duration,
            "summary": summary,
            "explain": explain_out,
        })
        vlabel, _ = verdict(summary, bench)
        print(f"[{title}] hook={summary['hook']:.2f} overall={summary['overall']:.2f} → {vlabel}")

    if not results:
        print("[error] no sponsor features produced", file=sys.stderr)
        return 1

    build_report(results, bench, args.out_dir / "sponsor_report.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
