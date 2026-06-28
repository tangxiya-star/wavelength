#!/usr/bin/env python3
"""Estimate and download videos listed in a CSV with yt-dlp.

Default behavior is estimate-only. Use --download to fetch files after the
estimate is printed.
"""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV = ROOT / "scripts" / "ig-reels-scraper" / "ig-data" / "videos.csv"
DEFAULT_STORAGE_STATE = (
    ROOT / "scripts" / "ig-reels-scraper" / "ig-data" / "storageState.json"
)
DEFAULT_OUT = ROOT / "scripts" / "ig-reels-scraper" / "ig-data" / "downloads"
DEFAULT_ARCHIVE = DEFAULT_OUT / "download-archive.txt"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Estimate total size and optionally download CSV videos with yt-dlp."
    )
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV, help="CSV path.")
    parser.add_argument("--url-column", default="url", help="CSV column containing video URLs.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Download directory.")
    parser.add_argument(
        "--storage-state",
        type=Path,
        default=DEFAULT_STORAGE_STATE,
        help="Playwright storageState.json to reuse Instagram login cookies.",
    )
    parser.add_argument("--yt-dlp", default="yt-dlp", help="yt-dlp executable.")
    parser.add_argument(
        "--format",
        default="bv*+ba/b",
        help="yt-dlp format selector used for estimate and download.",
    )
    parser.add_argument(
        "--download",
        action="store_true",
        help="Download after estimating. Without this, the script only estimates.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Do not prompt before downloading when --download is set.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Only process the first N unique URLs. Useful for testing.",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=1.0,
        help="Seconds to sleep between metadata requests during estimate.",
    )
    parser.add_argument(
        "--no-cookies",
        action="store_true",
        help="Do not pass cookies to yt-dlp.",
    )
    return parser.parse_args()


def load_urls(csv_path: Path, url_column: str, limit: int | None) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    with csv_path.open(newline="") as f:
        reader = csv.DictReader(f)
        if url_column not in (reader.fieldnames or []):
            fields = ", ".join(reader.fieldnames or [])
            raise SystemExit(f"CSV column {url_column!r} not found. Available columns: {fields}")

        for row in reader:
            url = (row.get(url_column) or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            urls.append(url)
            if limit and len(urls) >= limit:
                break

    return urls


def netscape_cookie_line(cookie: dict[str, Any]) -> str:
    domain = str(cookie["domain"])
    include_subdomains = "TRUE" if domain.startswith(".") else "FALSE"
    path = str(cookie.get("path") or "/")
    secure = "TRUE" if cookie.get("secure") else "FALSE"
    expires = int(cookie.get("expires") or 0)
    name = str(cookie["name"])
    value = str(cookie.get("value") or "")
    return "\t".join([domain, include_subdomains, path, secure, str(expires), name, value])


def make_cookie_file(storage_state: Path | None) -> tempfile.NamedTemporaryFile[str] | None:
    if not storage_state or not storage_state.exists():
        return None

    state = json.loads(storage_state.read_text())
    cookies = state.get("cookies") or []
    if not cookies:
        return None

    cookie_file = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False)
    cookie_file.write("# Netscape HTTP Cookie File\n")
    for cookie in cookies:
        if "domain" in cookie and "name" in cookie:
            cookie_file.write(netscape_cookie_line(cookie) + "\n")
    cookie_file.flush()
    return cookie_file


def bytes_to_gib(num_bytes: int | float) -> float:
    return float(num_bytes) / (1024**3)


def format_size(num_bytes: int | float) -> str:
    gib = bytes_to_gib(num_bytes)
    if gib >= 1:
        return f"{gib:.2f} GiB"
    return f"{float(num_bytes) / (1024**2):.1f} MiB"


def yt_dlp_base(args: argparse.Namespace, cookie_path: str | None) -> list[str]:
    cmd = [args.yt_dlp, "--no-playlist", "--no-warnings", "-f", args.format]
    if cookie_path:
        cmd.extend(["--cookies", cookie_path])
    return cmd


def selected_download_sizes(info: dict[str, Any]) -> tuple[int, bool]:
    requested = info.get("requested_downloads") or []
    if requested:
        total = 0
        exact = True
        for item in requested:
            size = item.get("filesize") or item.get("filesize_approx")
            if not size:
                exact = False
                continue
            total += int(size)
            if not item.get("filesize"):
                exact = False
        return total, exact

    size = info.get("filesize") or info.get("filesize_approx")
    if size:
        return int(size), bool(info.get("filesize"))

    return 0, False


def estimate(args: argparse.Namespace, urls: list[str], cookie_path: str | None) -> dict[str, Any]:
    total = 0
    exact_count = 0
    approx_count = 0
    unknown: list[str] = []
    failures: list[tuple[str, str]] = []

    for index, url in enumerate(urls, start=1):
        cmd = yt_dlp_base(args, cookie_path) + ["--skip-download", "--dump-single-json", url]
        print(f"[{index}/{len(urls)}] estimating {url}", flush=True)
        result = subprocess.run(cmd, text=True, capture_output=True)
        if result.returncode != 0:
            message = (result.stderr or result.stdout or "").strip().splitlines()
            failures.append((url, message[-1] if message else "yt-dlp failed"))
            continue

        try:
            info = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            failures.append((url, f"could not parse yt-dlp JSON: {exc}"))
            continue

        size, exact = selected_download_sizes(info)
        if size:
            total += size
            if exact:
                exact_count += 1
            else:
                approx_count += 1
            print(f"    {format_size(size)}", flush=True)
        else:
            unknown.append(url)
            print("    size unavailable from metadata", flush=True)

        if args.sleep > 0 and index < len(urls):
            time.sleep(args.sleep)

    return {
        "total_bytes": total,
        "exact_count": exact_count,
        "approx_count": approx_count,
        "unknown": unknown,
        "failures": failures,
    }


def print_estimate_summary(summary: dict[str, Any], url_count: int) -> None:
    known_count = summary["exact_count"] + summary["approx_count"]
    print("\nEstimate summary")
    print(f"  URLs: {url_count}")
    print(f"  Known sizes: {known_count}")
    print(f"  Exact sizes: {summary['exact_count']}")
    print(f"  Approx sizes: {summary['approx_count']}")
    print(f"  Unknown sizes: {len(summary['unknown'])}")
    print(f"  Metadata failures: {len(summary['failures'])}")
    print(f"  Known total: {format_size(summary['total_bytes'])}")
    print(f"  Known total in GB: {summary['total_bytes'] / 1_000_000_000:.2f} GB")
    if summary["unknown"]:
        print("  Note: URLs with unknown sizes are not included in the total.")


def download(args: argparse.Namespace, urls: list[str], cookie_path: str | None) -> None:
    args.out.mkdir(parents=True, exist_ok=True)
    archive = DEFAULT_ARCHIVE if args.out == DEFAULT_OUT else args.out / "download-archive.txt"

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as batch:
        for url in urls:
            batch.write(url + "\n")
        batch_path = batch.name

    try:
        cmd = yt_dlp_base(args, cookie_path) + [
            "--batch-file",
            batch_path,
            "--paths",
            str(args.out),
            "--output",
            "%(uploader_id|unknown-uploader)s/%(id)s.%(ext)s",
            "--download-archive",
            str(archive),
            "--merge-output-format",
            "mp4",
            "--no-overwrites",
            "--sleep-interval",
            "1",
            "--max-sleep-interval",
            "4",
        ]
        subprocess.run(cmd, check=True)
    finally:
        Path(batch_path).unlink(missing_ok=True)


def main() -> int:
    args = parse_args()
    urls = load_urls(args.csv, args.url_column, args.limit)
    if not urls:
        raise SystemExit("No URLs found.")

    cookie_file = None
    if not args.no_cookies:
        cookie_file = make_cookie_file(args.storage_state)

    cookie_path = cookie_file.name if cookie_file else None
    if cookie_path:
        print(f"Using cookies from {args.storage_state}")
    else:
        print("No cookies supplied to yt-dlp.")

    try:
        summary = estimate(args, urls, cookie_path)
        print_estimate_summary(summary, len(urls))

        if not args.download:
            print("\nEstimate-only mode. Re-run with --download to fetch the videos.")
            return 0

        if not args.yes:
            answer = input("\nDownload now? [y/N] ").strip().lower()
            if answer not in {"y", "yes"}:
                print("Download cancelled.")
                return 0

        download(args, urls, cookie_path)
        print(f"\nDownloads saved under {args.out}")
        return 0
    finally:
        if cookie_file:
            cookie_file.close()
            Path(cookie_file.name).unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
