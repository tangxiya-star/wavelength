#!/usr/bin/env python3
"""Stage [4] FlowState pipeline — LLM video-improvement explainer.

Usage:
  python3 model/explain.py <video_id>
  python3 model/explain.py --features-json path/to/feat.json

Output:  model/out/explain_<id>.json  +  markdown to stdout.
Uses OpenAI (OPENAI_API_KEY) or Anthropic (ANTHROPIC_API_KEY), auto-loaded from
model/.env. Falls back to a deterministic heuristic if no key/SDK is available.
"""
from __future__ import annotations
import argparse, json, os, sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
FEATURES_DIR = ROOT / "model" / "features" / "videos"
OUT_DIR      = ROOT / "model" / "out"
DEFAULT_MODEL = "claude-sonnet-4-6"
_CURVE_CAP = 60  # max windows sent in prompt


# ── feature helpers ──────────────────────────────────────────────────────────

def load_features(video_id: str | None, features_json: str | None) -> dict:
    p = Path(features_json) if features_json else FEATURES_DIR / video_id / f"{video_id}.json"
    if not p.exists():
        raise FileNotFoundError(f"Features not found: {p}")
    return json.loads(p.read_text())


def _downsample(windows: list, cap: int) -> list:
    n = len(windows)
    if n <= cap:
        return windows
    stride = n // cap
    keep = set(range(0, n, stride)) | {n - 1}
    return [windows[i] for i in sorted(keep)]


def heuristic_weak_windows(features: dict) -> list[dict]:
    windows = features.get("windows") or []
    hook = features.get("hook") or {}
    dur  = features.get("duration_s", 0)
    win_s = 1.0 / (features.get("fps_sampled") or 2.0)
    weak = []
    if not hook.get("hook_face") and not hook.get("hook_text_present"):
        weak.append({"t_start": 0.0, "t_end": min(3.0, dur),
                     "why": "Hook (0–3 s) has no face and no on-screen text — high early-drop risk."})
    run_start = run_end = None
    for w in windows:
        t = w.get("t", 0)
        dull = (not w.get("face_present") and not w.get("ocr_text_present")
                and (w.get("motion") or 0) < 0.05 and (w.get("loudness_db") or 0) < -30)
        if dull:
            if run_start is None: run_start = t
            run_end = t + win_s
        else:
            if run_start is not None and (run_end or 0) - run_start >= 1.0:
                if run_start >= 3.0:
                    weak.append({"t_start": round(run_start, 2), "t_end": round(run_end, 2),
                                 "why": "Dull segment: no face, no text, low motion + quiet audio."})
            run_start = run_end = None
    if run_start is not None and (run_end or 0) - run_start >= 1.0:
        weak.append({"t_start": round(run_start, 2), "t_end": round(run_end, 2),
                     "why": "Dull segment: no face, no text, low motion + quiet audio."})
    return weak[:6]


# ── prompt builder ───────────────────────────────────────────────────────────

def build_prompt(features: dict, predicted_curve: list | None, weak_windows: list) -> str:
    vid  = features.get("video_id", "?")
    dur  = features.get("duration_s", "?")
    agg  = features.get("aggregate") or {}
    hook = features.get("hook") or {}
    compact = [
        {k: w[k] for k in ("t","loudness_db","ocr_text_present","face_present","motion","cut_in_window") if k in w}
        for w in _downsample(features.get("windows") or [], _CURVE_CAP)
    ]
    lines = [
        f"# FlowState video analysis — {vid} ({dur}s)",
        f"## Aggregate\n{json.dumps(agg, indent=2)}",
        f"## Hook (0–3 s)\n{json.dumps(hook, indent=2)}",
        f"## Per-window curve ({len(compact)} windows, 0.5 s cadence)\n"
        + "Keys: t, loudness_db, ocr_text_present, face_present, motion, cut_in_window\n"
        + json.dumps(compact, separators=(",",":")),
    ]
    if predicted_curve:
        lines.append(f"## Predicted EEG interest (0=low,1=high)\n{json.dumps(predicted_curve, separators=(',',':'))}")
    if weak_windows:
        lines.append(f"## Weak / low-engagement windows\n{json.dumps(weak_windows, indent=2)}")
    lines += [
        "## Task",
        "You are a short-form video coach. Using ONLY the feature data above, respond with ONLY valid JSON (no markdown fences) matching exactly:",
        '{"overall":"...","hook_critique":"...","weak_sections":[{"t_start":0,"t_end":0,"why":"..."}],'
        '"edits":[{"change":"...","rationale":"...","expected_effect":"..."}],"strengths":["..."]}',
        "Rules: overall=1 paragraph. hook_critique=1–2 sentences. edits=3–6 concrete short-form-specific edits "
        "(hook, pacing, text overlays, face, audio). strengths=2–4 things already working well. "
        "Be specific and actionable — no generic advice.",
    ]
    return "\n\n".join(lines)


# ── LLM call ─────────────────────────────────────────────────────────────────

def _load_dotenv(path: Path = ROOT / "model" / ".env") -> None:
    """Load KEY=VALUE lines from model/.env into os.environ (zero-dependency)."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and v and k not in os.environ:
            os.environ[k] = v


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = "\n".join(l for l in text.splitlines() if not l.startswith("```")).strip()
    return text


def _call_openai(prompt: str, model: str) -> dict | None:
    try:
        from openai import OpenAI  # type: ignore
    except ImportError:
        return None
    try:
        resp = OpenAI().chat.completions.create(
            model=model, max_completion_tokens=4096,   # newer models reject legacy max_tokens
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are a short-form video growth expert. Reply with ONLY valid JSON — no prose, no markdown fences."},
                {"role": "user", "content": prompt},
            ],
        )
        return json.loads(_strip_fences(resp.choices[0].message.content))
    except Exception as e:
        print(f"[explain] OpenAI call failed: {e}", file=sys.stderr)
        return None


def _call_anthropic(prompt: str, model: str) -> dict | None:
    try:
        import anthropic  # type: ignore
    except ImportError:
        return None
    try:
        resp = anthropic.Anthropic().messages.create(
            model=model, max_tokens=2048,
            messages=[{"role": "user", "content": prompt}])
        return json.loads(_strip_fences(resp.content[0].text))
    except Exception as e:
        print(f"[explain] Anthropic call failed: {e}", file=sys.stderr)
        return None


def call_llm(prompt: str, model: str) -> dict | None:
    """Prefer OpenAI (OPENAI_API_KEY), else Anthropic (ANTHROPIC_API_KEY), else None."""
    _load_dotenv()
    if os.environ.get("OPENAI_API_KEY"):
        return _call_openai(prompt, os.environ.get("OPENAI_MODEL", "gpt-4o"))
    if os.environ.get("ANTHROPIC_API_KEY"):
        return _call_anthropic(prompt, os.environ.get("ANTHROPIC_MODEL", model))
    return None


# ── heuristic fallback report ─────────────────────────────────────────────────

def heuristic_report(features: dict, weak_windows: list) -> dict:
    agg  = features.get("aggregate") or {}
    hook = features.get("hook") or {}
    edits = []
    if not hook.get("hook_face"):
        edits.append({"change": "Add a face/talking-head shot in the first 0.5 s.",
                      "rationale": "Face in hook is the strongest UGC retention signal.",
                      "expected_effect": "Reduces early drop-off at 1–3 s."})
    if not hook.get("hook_text_present"):
        edits.append({"change": "Overlay a bold text hook or question in the first 2 s.",
                      "rationale": "On-screen text retains silent viewers.",
                      "expected_effect": "Improves silent-watch completion rate."})
    if not hook.get("opening_curiosity"):
        edits.append({"change": "Open with a curiosity-gap line: a question, number, or 'stop doing X'.",
                      "rationale": "Curiosity gaps increase scroll-stopping probability.",
                      "expected_effect": "Higher hook retention at the 3-second mark."})
    if (agg.get("cuts_per_sec") or 0) < 0.15:
        edits.append({"change": "Add scene cuts — aim for one cut every 3–5 s.",
                      "rationale": "Pacing variety prevents attention fatigue.",
                      "expected_effect": "Increases mid-video retention."})
    if (agg.get("face_present_frac") or 0) < 0.4:
        edits.append({"change": "Show a face for at least 40 % of the video.",
                      "rationale": "Face drives emotional connection and comment engagement.",
                      "expected_effect": "Higher comment and share rates."})
    strengths = ([s for s in [
        "Face in hook — strong opening." if hook.get("hook_face") else "",
        "On-screen text in hook — good for silent viewers." if hook.get("hook_text_present") else "",
        "Consistent face throughout." if (agg.get("face_present_frac") or 0) >= 0.7 else "",
        "Subtitles detected — accessibility win." if agg.get("likely_subtitles") else "",
    ] if s] or ["Video has audio and visual variety — foundation to build on."])[:4]
    fp = round((agg.get("face_present_frac") or 0) * 100)
    cuts = agg.get("scene_cut_count", 0)
    return {
        "overall": (f"This {features.get('duration_s','?')}s video has {fp}% face presence and "
                    f"{cuts} cut(s). Pacing is {'fast' if (agg.get('cuts_per_sec') or 0)>0.3 else 'slow'}. "
                    f"Hook {'has' if hook.get('hook_text_present') else 'lacks'} text overlay. "
                    f"[Heuristic mode — LLM unavailable]"),
        "hook_critique": (
            "Hook has face and text — solid foundation." if hook.get("hook_face") and hook.get("hook_text_present")
            else "Hook is missing " + (
                "both face and text" if not hook.get("hook_face") and not hook.get("hook_text_present")
                else "face presence" if not hook.get("hook_face") else "on-screen text"
            ) + " — high early-drop risk."),
        "weak_sections": weak_windows,
        "edits": edits[:6],
        "strengths": strengths,
    }


# ── stdout summary ─────────────────────────────────────────────────────────

def print_markdown(report: dict, video_id: str, llm_used: bool) -> None:
    mode = "LLM" if llm_used else "heuristic"
    print(f"\n## FlowState explain — {video_id}  [{mode}]\n")
    print(f"**Overall:** {report.get('overall','')}\n")
    print(f"**Hook critique:** {report.get('hook_critique','')}\n")
    if (weak := report.get("weak_sections") or []):
        print("### Weak sections")
        for s in weak:
            print(f"  • {s.get('t_start')}–{s.get('t_end')}s: {s.get('why')}")
        print()
    if (edits := report.get("edits") or []):
        print("### Suggested edits")
        for i, e in enumerate(edits, 1):
            print(f"  {i}. **{e.get('change')}**")
            print(f"     _{e.get('rationale')}_ → {e.get('expected_effect')}")
        print()
    if (st := report.get("strengths") or []):
        print("### Strengths")
        for s in st: print(f"  ✓ {s}")
    print()


# ── public API ────────────────────────────────────────────────────────────────

def explain(
    video_id: str | None = None,
    *,
    features_json: str | None = None,
    predicted_curve: list | None = None,
    weak_windows: list | None = None,
    model: str = DEFAULT_MODEL,
    out_dir: Path | str = OUT_DIR,
) -> dict[str, Any]:
    """Importable entry point. Returns output dict (also written to out_dir)."""
    features = load_features(video_id, features_json)
    vid = features.get("video_id") or video_id or "unknown"
    effective_weak = weak_windows if weak_windows is not None else heuristic_weak_windows(features)
    prompt = build_prompt(features, predicted_curve, effective_weak)
    llm_result = call_llm(prompt, model)
    llm_used = llm_result is not None
    report = llm_result if llm_used else heuristic_report(features, effective_weak)
    used_model = (os.environ.get("OPENAI_MODEL", "gpt-4o") if os.environ.get("OPENAI_API_KEY")
                  else os.environ.get("ANTHROPIC_MODEL", model) if os.environ.get("ANTHROPIC_API_KEY")
                  else None)
    output = {"video_id": vid, "llm_used": llm_used, "model": used_model if llm_used else None, **report}
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"explain_{vid}.json"
    out_path.write_text(json.dumps(output, indent=2))
    print_markdown(report, vid, llm_used)
    print(f"[explain] wrote {out_path}")
    return output


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("video_id", nargs="?")
    p.add_argument("--features-json")
    p.add_argument("--predicted-curve", help="JSON array [{t, interest_0_1}]")
    p.add_argument("--weak-windows",    help="JSON array [{t_start, t_end}]")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--out-dir", default=str(OUT_DIR))
    args = p.parse_args()

    def _json_arg(v):
        # accept either a path to a JSON file or an inline JSON string
        if not v:
            return None
        if os.path.exists(v):
            with open(v) as fh:
                return json.load(fh)
        return json.loads(v)

    try:
        explain(
            video_id=args.video_id,
            features_json=args.features_json,
            predicted_curve=_json_arg(args.predicted_curve),
            weak_windows=_json_arg(args.weak_windows),
            model=args.model, out_dir=args.out_dir,
        )
    except FileNotFoundError as e:
        print(f"[explain] ERROR: {e}", file=sys.stderr); return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
