#!/usr/bin/env python3
"""One-time generator for placeholder pilot clips (SPEC §9).

Renders a solid-color background counting 1 -> 4 in three variations (color +
pacing), as vertical 1080x1920 H.264 MP4s bundled into the app via
lib/catalog.ts. Numerals are drawn with Pillow (this machine's ffmpeg has no
drawtext), then encoded with ffmpeg.

Requires: python3 + Pillow, and ffmpeg with libx264.
Usage:  python3 scripts/gen-test-videos.py
"""
import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont

FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "assets", "videos")
W, H, FPS = 1080, 1920, 30

# (name, rgb background, seconds per number, label)
VARIATIONS = [
    ("count_a", (30, 58, 138), 2.0, "Variation A"),   # deep blue,  8s
    ("count_b", (21, 128, 61), 1.5, "Variation B"),   # green,      6s
    ("count_c", (109, 40, 217), 2.5, "Variation C"),  # violet,    10s
]


def render_frame(path, color, number, label):
    img = Image.new("RGB", (W, H), color)
    d = ImageDraw.Draw(img)
    num_font = ImageFont.truetype(FONT_PATH, 720)
    lab_font = ImageFont.truetype(FONT_PATH, 54)

    text = str(number)
    nb = d.textbbox((0, 0), text, font=num_font)
    nw, nh = nb[2] - nb[0], nb[3] - nb[1]
    d.text(((W - nw) / 2 - nb[0], (H - nh) / 2 - nb[1] - 80), text, fill="white", font=num_font)

    lb = d.textbbox((0, 0), label, font=lab_font)
    lw = lb[2] - lb[0]
    d.text(((W - lw) / 2 - lb[0], H - 320), label, fill=(255, 255, 255), font=lab_font)

    img.save(path)


def make_video(name, color, per, label):
    tmp = tempfile.mkdtemp()
    try:
        frames = []
        for n in (1, 2, 3, 4):
            fp = os.path.join(tmp, f"f{n}.png")
            render_frame(fp, color, n, label)
            frames.append(fp)

        listfile = os.path.join(tmp, "list.txt")
        with open(listfile, "w") as f:
            f.write("ffconcat version 1.0\n")
            for fp in frames:
                f.write(f"file '{fp}'\nduration {per}\n")
            f.write(f"file '{frames[-1]}'\n")  # concat demuxer needs the last entry repeated

        out = os.path.join(OUT, f"{name}.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listfile,
             "-vf", f"fps={FPS},format=yuv420p", "-c:v", "libx264",
             "-profile:v", "high", "-movflags", "+faststart", "-an",
             "-t", f"{per * 4:.3f}", out],  # trim trailing pad for an exact, clean loop
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        print(f"  {name}.mp4  {per * 4:.1f}s  {os.path.getsize(out) // 1024}KB")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    print(f"Generating countdown test videos -> {OUT}")
    for v in VARIATIONS:
        make_video(*v)
    print("done")
