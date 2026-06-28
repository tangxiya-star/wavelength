#!/usr/bin/env python3
"""Generate a HyperFrames composition: screen recording + synced EEG interest waveform.

Builds an index.html identical in format to hyperframes/e10-third-demo, but driven by
data so it works for any feed-study session:

  * exposure order + per-exposure on-screen dwell come from the SQLite events
    (video_impression, ordered by first client_ts).
  * each exposure's waveform shape is its EEG interest curve (interest_0_1, per 0.5 s
    window) from the session's engagement per_window CSV.
  * SEGMENTS[i].start = session_elapsed_i + OFFSET, the visual-sync offset measured by
    matching distinctive frames (e.g. the Codex ad / Fruit Island / sponsor cards)
    against the impression timeline. recording_time = elapsed + OFFSET (slope ~1).

Waveform geometry matches the original e10 composition (reverse-engineered, corr -0.998):
  viewBox 1760 x 240 ;  x = i/(N-1)*1760 ;  y = 216.4 - 54.16 * clip(interest, 0, 1)
  smooth Catmull-Rom -> cubic bezier through the 0.5 s sample points.

Usage:
  python3 gen_waveform_composition.py \
    --session 8deffb93 \
    --eeg-csv ../hardware/analysis/out/engagement/9d7b5751-..._per_window.csv \
    --offset 0.2 --video-duration 272.262 \
    --screen-recording "/abs/path/to/recording.mp4" \
    --out-dir ../hyperframes/8deff-second-demo
"""
from __future__ import annotations
import argparse, csv, json, os, sqlite3
from pathlib import Path

# --- waveform geometry (reverse-engineered from e10-third-demo) ---
WIDTH, HEIGHT = 1760.0, 240.0
Y_AT_0, Y_AT_1 = 216.4, 162.24          # interest 0 -> y216.4, interest 1 -> y162.24
SLOPE = Y_AT_1 - Y_AT_0                  # -54.16

def y_of(interest: float) -> float:
    i = max(0.0, min(1.0, interest))
    return Y_AT_0 + SLOPE * i

def catmull_rom_path(points):
    """points: list of (x,y). Return SVG path 'd' using Catmull-Rom -> cubic bezier."""
    n = len(points)
    if n == 0:
        return ""
    if n == 1:
        x, y = points[0]
        return f"M {x:.1f} {y:.2f} L {x+0.5:.1f} {y:.2f}"
    d = [f"M {points[0][0]:.2f} {points[0][1]:.2f}"]
    for i in range(n - 1):
        p0 = points[i - 1] if i - 1 >= 0 else points[0]
        p1 = points[i]
        p2 = points[i + 1]
        p3 = points[i + 2] if i + 2 < n else points[n - 1]
        c1x = p1[0] + (p2[0] - p0[0]) / 6.0
        c1y = p1[1] + (p2[1] - p0[1]) / 6.0
        c2x = p2[0] - (p3[0] - p1[0]) / 6.0
        c2y = p2[1] - (p3[1] - p1[1]) / 6.0
        d.append(f"C {c1x:.2f} {c1y:.2f}, {c2x:.2f} {c2y:.2f}, {p2[0]:.2f} {p2[1]:.2f}")
    return " ".join(d)


def load_exposures(sqlite_path: str, session_like: str):
    con = sqlite3.connect(sqlite_path)
    con.row_factory = sqlite3.Row
    row = con.execute(
        "select id, started_at from sessions where id like ?", (session_like + "%",)
    ).fetchone()
    sid, started_at = row["id"], row["started_at"]
    rows = con.execute(
        """
        select e.feed_position as pos, e.video_id as vid, v.title as title,
               min(e.client_ts) as first_ts,
               (julianday(min(e.client_ts)) - julianday(s.started_at)) * 86400.0 as elapsed
        from events e
        left join videos v on v.id = e.video_id
        join sessions s on s.id = e.session_id
        where e.session_id = ? and e.event_type = 'video_impression'
        group by e.feed_position, e.video_id
        order by elapsed
        """,
        (sid,),
    ).fetchall()
    con.close()
    return sid, started_at, [dict(r) for r in rows]


def load_eeg_curves(eeg_csv: str):
    """video_id -> sorted list of (t, interest_0_1)."""
    curves = {}
    with open(eeg_csv) as f:
        for r in csv.DictReader(f):
            vid = r["video_id"]
            try:
                t = float(r["t"]); itr = float(r["interest_0_1"])
            except (TypeError, ValueError):
                continue
            curves.setdefault(vid, []).append((t, itr))
    for vid in curves:
        curves[vid].sort(key=lambda p: p[0])
    return curves


def build(session_like, eeg_csv, offset, video_dur, sqlite_path):
    sid, started_at, exps = load_exposures(sqlite_path, session_like)
    curves = load_eeg_curves(eeg_csv)

    segments, layers, report = [], [], []
    out_index = 0
    for i, e in enumerate(exps):
        start = e["elapsed"] + offset
        if start >= video_dur:
            continue
        nxt = exps[i + 1]["elapsed"] if i + 1 < len(exps) else None
        gap = (nxt - e["elapsed"]) if nxt is not None else (video_dur - start)
        dwell = min(gap, video_dur - start)        # visible on-screen time
        if dwell <= 0.2:
            continue
        raw = curves.get(e["vid"], [])
        samp = [(t, itr) for (t, itr) in raw if t <= dwell + 0.001]
        if len(samp) < 2:
            samp = raw[:2] if len(raw) >= 2 else raw
        if len(samp) < 2:
            continue
        N = len(samp)
        pts = [(k / (N - 1) * WIDTH, y_of(itr)) for k, (t, itr) in enumerate(samp)]
        d = catmull_rom_path(pts)
        layers.append((out_index, d))
        segments.append({"index": out_index, "start": round(start, 3),
                         "duration": round(dwell, 3)})
        report.append({"pos": e["pos"], "vid": e["vid"], "title": e["title"],
                       "elapsed": round(e["elapsed"], 3), "start": round(start, 3),
                       "dwell": round(dwell, 3), "n_samples": N})
        out_index += 1
    return sid, segments, layers, report


HEAD = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {{ box-sizing: border-box; margin: 0; padding: 0; }}
      html, body {{ width: 1920px; height: 1080px; overflow: hidden; background: #000; color: #e5e7eb; font-family: Inter, sans-serif; }}
      #root {{ position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #000; }}
      #screen {{ position: absolute; top: 24px; left: 0; width: 1920px; height: 740px; object-fit: contain; display: block; background: #000; }}
      #wave-panel {{ position: absolute; left: 80px; right: 80px; bottom: 48px; height: 240px; border: 2px solid rgba(229, 231, 235, 0.72); background: #000; overflow: hidden; }}
      #wave-svg {{ width: 100%; height: 100%; display: block; }}
      .grid-line {{ stroke: rgba(156, 163, 175, 0.16); stroke-width: 1; }}
      .wave-layer {{ opacity: 0; transform-box: fill-box; transform-origin: center; }}
      .wave-glow {{ fill: none; stroke: rgba(255, 255, 255, 0.24); stroke-width: 18; stroke-linecap: round; stroke-linejoin: round; }}
      .wave-line {{ fill: none; stroke: #ffffff; stroke-width: 4; stroke-linecap: round; stroke-linejoin: round; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{dur}" data-width="1920" data-height="1080">
      <video id="screen" class="clip" data-start="0" data-duration="{dur}" data-track-index="0" src="assets/chrome-demo.mp4" muted playsinline></video>
      <audio id="screen-audio" class="clip" data-start="0" data-duration="{dur}" data-track-index="2" src="assets/chrome-demo.mp4" data-volume="1"></audio>
      <div id="wave-panel">
        <svg id="wave-svg" viewBox="0 0 1760 240" preserveAspectRatio="none">
          <g id="wave-grid"></g>
"""

SCRIPT = """        </svg>
      </div>
    </div>
    <script>
      window.__timelines = window.__timelines || {{}};
      const WIDTH = 1760;
      const HEIGHT = 240;
      // Sync to {sid} DEMO session. recording_time = session_elapsed + {offset}s
      // (pure offset, slope ~1.0, no drift; anchors matched visually against the impression timeline).
      const SEGMENTS = {segments};
      const grid = document.getElementById("wave-grid");
      for (let i = 1; i < 6; i += 1) {{
        const y = (i / 6) * HEIGHT;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("class", "grid-line");
        line.setAttribute("x1", "0"); line.setAttribute("x2", String(WIDTH));
        line.setAttribute("y1", String(y)); line.setAttribute("y2", String(y));
        grid.appendChild(line);
      }}
      for (let i = 1; i < 16; i += 1) {{
        const x = (i / 16) * WIDTH;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("class", "grid-line");
        line.setAttribute("x1", String(x)); line.setAttribute("x2", String(x));
        line.setAttribute("y1", "0"); line.setAttribute("y2", String(HEIGHT));
        grid.appendChild(line);
      }}

      const tl = gsap.timeline({{ paused: true }});
      SEGMENTS.forEach((segment, i) => {{
        const layer = document.getElementById(`wave-${{segment.index}}`);
        const line = document.getElementById(`wave-line-${{segment.index}}`);
        const glow = document.getElementById(`wave-glow-${{segment.index}}`);
        const total = line.getTotalLength();
        line.style.strokeDasharray = String(total);
        line.style.strokeDashoffset = String(total);
        glow.style.strokeDasharray = String(total);
        glow.style.strokeDashoffset = String(total);

        tl.set(layer, {{ opacity: 1, y: 260 }}, segment.start);
        tl.to(layer, {{ y: 0, duration: 0.42, ease: "power3.out", overwrite: "auto" }}, segment.start);
        tl.to([line, glow], {{ strokeDashoffset: 0, duration: segment.duration, ease: "none" }}, segment.start);
        const next = SEGMENTS[i + 1];
        if (next) {{
          tl.to(layer, {{ y: -260, opacity: 0, duration: 0.42, ease: "power2.in", overwrite: "auto" }}, next.start - 0.08);
        }}
      }});
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
"""


def render_html(sid, segments, layers, offset, dur):
    parts = [HEAD.format(dur=dur)]
    for idx, d in layers:
        parts.append(f'          <g id="wave-{idx}" class="wave-layer">\n')
        parts.append(f'            <path id="wave-glow-{idx}" class="wave-glow" d="{d}" />\n')
        parts.append(f'            <path id="wave-line-{idx}" class="wave-line" d="{d}" />\n')
        parts.append('          </g>\n')
    parts.append(SCRIPT.format(sid=sid, offset=offset,
                               segments=json.dumps(segments, separators=(",", ":"))))
    return "".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--eeg-csv", required=True)
    ap.add_argument("--offset", type=float, required=True)
    ap.add_argument("--video-duration", type=float, required=True)
    ap.add_argument("--sqlite", default=str(Path(__file__).resolve().parent.parent / "server/data/flowstate.sqlite"))
    ap.add_argument("--screen-recording", default=None, help="abs path to mp4 to symlink as assets/chrome-demo.mp4")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    sid, segments, layers, report = build(
        args.session, args.eeg_csv, args.offset, args.video_duration, args.sqlite)

    out = Path(args.out_dir)
    (out / "assets").mkdir(parents=True, exist_ok=True)
    html = render_html(sid, segments, layers, args.offset, args.video_duration)
    (out / "index.html").write_text(html)

    if args.screen_recording:
        link = out / "assets" / "chrome-demo.mp4"
        if link.exists() or link.is_symlink():
            link.unlink()
        os.symlink(args.screen_recording, link)

    print(f"session {sid}: {len(segments)} segments, offset {args.offset}s, dur {args.video_duration}s")
    print(f"wrote {out/'index.html'}")
    for r in report:
        print(f"  pos{r['pos']:>2} start={r['start']:>7.2f} dwell={r['dwell']:>6.2f} "
              f"n={r['n_samples']:>3}  {r['title']}")


if __name__ == "__main__":
    main()
