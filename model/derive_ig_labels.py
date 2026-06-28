#!/usr/bin/env python3
"""Derive content-intrinsic IG labels from selected-videos.csv (Task P-01).

Formulas (02-PIPELINE-AND-MODELS.md, Table 1):
  like_rate = like_count / views
  share_rate = shares / views
  comment_rate = comment_count / views
  engagement_rate = (like_count + comment_count + shares) / views
  views_log = log10(views)
  views_rank_within_creator = rank by views inside each creator_id (1 = highest)
"""

from __future__ import annotations

import argparse
import csv
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "scripts/ig-reels-scraper/ig-data/selected-videos.csv"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "datasets" / "ig_labels.csv"

OUTPUT_FIELDS = [
    "video_id",
    "creator_id",
    "selection_type",
    "views",
    "like_count",
    "comment_count",
    "shares",
    "like_rate",
    "share_rate",
    "comment_rate",
    "engagement_rate",
    "views_log",
    "views_rank_within_creator",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Derive content-intrinsic IG labels (P-01).")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def parse_count(value: str | None) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    return int(float(value))


def rate(numerator: int | None, views: int) -> float | None:
    if views <= 0 or numerator is None:
        return None
    return numerator / views


def fmt(value: float | int | None) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:.10g}"
    return str(value)


def rank_within_creator(rows: list[dict[str, object]]) -> None:
    by_creator: dict[str, list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        by_creator[str(row["creator_id"])].append(row)

    for creator_rows in by_creator.values():
        creator_rows.sort(key=lambda r: (-int(r["views"]), str(r["video_id"])))
        for rank, row in enumerate(creator_rows, start=1):
            row["views_rank_within_creator"] = rank


def derive_labels(input_path: Path) -> list[dict[str, object]]:
    with input_path.open(newline="") as f:
        source_rows = list(csv.DictReader(f))

    derived: list[dict[str, object]] = []
    for row in source_rows:
        views = parse_count(row.get("views"))
        if views is None:
            raise ValueError(f"Missing views for video {row.get('id')}")

        likes = parse_count(row.get("like_count")) or 0
        comments = parse_count(row.get("comment_count")) or 0
        shares = parse_count(row.get("shares"))
        shares_for_engagement = shares if shares is not None else 0

        derived.append(
            {
                "video_id": row["id"],
                "creator_id": row.get("username") or "unknown",
                "selection_type": row.get("selection_type") or "",
                "views": views,
                "like_count": likes,
                "comment_count": comments,
                "shares": shares if shares is not None else "",
                "like_rate": rate(likes, views),
                "share_rate": rate(shares, views),
                "comment_rate": rate(comments, views),
                "engagement_rate": rate(likes + comments + shares_for_engagement, views),
                "views_log": math.log10(views) if views > 0 else None,
            }
        )

    rank_within_creator(derived)
    return derived


def write_labels(output_path: Path, rows: list[dict[str, object]]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: fmt(row.get(field)) for field in OUTPUT_FIELDS})


def main() -> None:
    args = parse_args()
    if not args.input.is_file():
        raise SystemExit(f"Input not found: {args.input}")

    rows = derive_labels(args.input)
    write_labels(args.output, rows)
    print(f"Wrote {len(rows)} rows → {args.output}")


if __name__ == "__main__":
    main()
