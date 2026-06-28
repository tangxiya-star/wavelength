#!/usr/bin/env node
// Select top-performing and random sample videos per creator, enrich engagement
// metadata, and optionally download the selected videos with yt-dlp.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_CSV = path.join(ROOT, "scripts/ig-reels-scraper/ig-data/videos.csv");
const DEFAULT_STATE = path.join(ROOT, "scripts/ig-reels-scraper/ig-data/storageState.json");
const DEFAULT_OUT = path.join(ROOT, "scripts/ig-reels-scraper/ig-data/selected-downloads");
const DEFAULT_SELECTED_CSV = path.join(ROOT, "scripts/ig-reels-scraper/ig-data/selected-videos.csv");
const DEFAULT_BATCH = path.join(ROOT, "scripts/ig-reels-scraper/ig-data/selected-video-urls.txt");
const SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function parseArgs(argv) {
  const args = {
    csv: DEFAULT_CSV,
    storageState: DEFAULT_STATE,
    out: DEFAULT_OUT,
    selectedCsv: DEFAULT_SELECTED_CSV,
    batchFile: DEFAULT_BATCH,
    top: 10,
    sample: 20,
    seed: 20260627,
    ytDlp: "yt-dlp",
    format: "bv*+ba/b",
    download: false,
    yes: false,
    sleepMs: 500,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--csv") args.csv = path.resolve(next());
    else if (arg === "--storage-state") args.storageState = path.resolve(next());
    else if (arg === "--out") args.out = path.resolve(next());
    else if (arg === "--selected-csv") args.selectedCsv = path.resolve(next());
    else if (arg === "--batch-file") args.batchFile = path.resolve(next());
    else if (arg === "--top") args.top = Number(next());
    else if (arg === "--sample") args.sample = Number(next());
    else if (arg === "--seed") args.seed = Number(next());
    else if (arg === "--yt-dlp") args.ytDlp = next();
    else if (arg === "--format") args.format = next();
    else if (arg === "--sleep-ms") args.sleepMs = Number(next());
    else if (arg === "--download") args.download = true;
    else if (arg === "--yes") args.yes = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: scripts/download-selected-videos.mjs [options]

Options:
  --download              Download selected videos after enrichment.
  --yes                   Do not prompt before downloading.
  --top N                 Top videos per creator by views. Default: 10.
  --sample N              Random non-top videos per creator. Default: 20.
  --seed N                Deterministic random seed. Default: 20260627.
  --csv PATH              Input videos.csv path.
  --out PATH              Download directory.
  --selected-csv PATH     Enriched selected CSV output path.
  --sleep-ms N            Delay between metadata calls. Default: 500.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      if (quoted && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines.shift() || "");
  return lines.map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""]));
  });
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function writeCsv(file, rows) {
  const columns = [
    "selection_type",
    "selection_rank",
    "username",
    "platform",
    "id",
    "url",
    "views",
    "views_text",
    "like_count",
    "comment_count",
    "shares",
    "shares_source",
    "duration",
    "filesize_bytes",
    "filesize_gib",
    "title",
    "downloaded_filename",
    "metadata_error",
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = rows.map((row) => columns.map((column) => csvCell(row[column])).join(","));
  fs.writeFileSync(file, `${columns.join(",")}\n${body.join("\n")}\n`);
}

function numeric(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeRows(rows) {
  const byUrl = new Map();
  for (const row of rows) {
    const url = String(row.url || "").trim();
    if (!url) continue;
    const previous = byUrl.get(url);
    if (!previous || numeric(row.views) >= numeric(previous.views)) byUrl.set(url, row);
  }
  return [...byUrl.values()];
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function selectRows(rows, topCount, sampleCount, seed) {
  const byCreator = new Map();
  for (const row of dedupeRows(rows)) {
    const username = row.username || "unknown";
    if (!byCreator.has(username)) byCreator.set(username, []);
    byCreator.get(username).push(row);
  }

  const selected = [];
  const random = mulberry32(seed);
  for (const [username, creatorRows] of [...byCreator.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...creatorRows].sort((a, b) => numeric(b.views) - numeric(a.views));
    const top = sorted.slice(0, topCount);
    const topUrls = new Set(top.map((row) => row.url));
    const sample = shuffle(sorted.filter((row) => !topUrls.has(row.url)), random).slice(0, sampleCount);

    top.forEach((row, index) => {
      selected.push({ ...row, selection_type: "top", selection_rank: index + 1 });
    });
    sample.forEach((row, index) => {
      selected.push({ ...row, selection_type: "random", selection_rank: index + 1 });
    });

    console.log(
      `${username}: selected ${top.length} top + ${sample.length} random from ${creatorRows.length} unique videos`,
    );
  }
  return selected;
}

function shortcodeToMediaId(shortcode) {
  let id = 0n;
  for (const char of shortcode) {
    const index = SHORTCODE_ALPHABET.indexOf(char);
    if (index < 0) return null;
    id = id * 64n + BigInt(index);
  }
  return id.toString();
}

function netscapeCookieLine(cookie) {
  const domain = String(cookie.domain);
  const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
  const secure = cookie.secure ? "TRUE" : "FALSE";
  const expires = Math.trunc(cookie.expires || 0);
  return [domain, includeSubdomains, cookie.path || "/", secure, expires, cookie.name, cookie.value || ""].join("\t");
}

function loadStateCookies(storageState) {
  // TikTok-only runs need no login, so a missing IG storageState is fine.
  if (!storageState || !fs.existsSync(storageState)) return [];
  const state = JSON.parse(fs.readFileSync(storageState, "utf8"));
  return state.cookies || [];
}

function writeYtDlpCookieFile(cookies) {
  const file = path.join(os.tmpdir(), `yt-dlp-instagram-${process.pid}-${Date.now()}.cookies`);
  const lines = ["# Netscape HTTP Cookie File"];
  for (const cookie of cookies) {
    if (cookie.domain && cookie.name) lines.push(netscapeCookieLine(cookie));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return file;
}

function instagramCookieHeader(cookies) {
  return cookies
    .filter((cookie) => String(cookie.domain || "").includes("instagram.com"))
    .map((cookie) => `${cookie.name}=${cookie.value || ""}`)
    .join("; ");
}

function selectedDownloadSize(info) {
  const requested = info.requested_downloads || [];
  if (requested.length) {
    return requested.reduce((sum, item) => sum + Number(item.filesize || item.filesize_approx || 0), 0);
  }
  return Number(info.filesize || info.filesize_approx || 0);
}

function formatGib(bytes) {
  return (bytes / 1024 ** 3).toFixed(2);
}

function runYtDlpJson(args, cookieFile, url) {
  const result = spawnSync(
    args.ytDlp,
    ["--cookies", cookieFile, "--no-playlist", "--no-warnings", "-f", args.format, "--skip-download", "--dump-single-json", url],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "yt-dlp failed").trim().split(/\r?\n/).pop();
    throw new Error(message);
  }
  return JSON.parse(result.stdout);
}

async function fetchInstagramEngagement(row, cookieHeader) {
  if (row.platform !== "instagram") return {};
  const mediaId = shortcodeToMediaId(row.id);
  if (!mediaId) return {};

  const response = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
    headers: {
      "cookie": cookieHeader,
      "user-agent": "Mozilla/5.0",
      "x-ig-app-id": "936619743392459",
    },
  });
  if (!response.ok) throw new Error(`Instagram media info HTTP ${response.status}`);
  const body = await response.json();
  const item = (body.items || [])[0] || {};
  return {
    like_count: item.like_count,
    comment_count: item.comment_count,
    shares: item.media_repost_count,
    shares_source: item.media_repost_count == null ? "" : "instagram_media_repost_count",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enrichRows(args, rows, cookieFile, cookieHeader) {
  let totalBytes = 0;
  const enriched = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    process.stdout.write(`[${i + 1}/${rows.length}] ${row.username} ${row.selection_type} ${row.url}\n`);
    const out = { ...row, metadata_error: "" };
    try {
      const info = runYtDlpJson(args, cookieFile, row.url);
      const api = await fetchInstagramEngagement(row, cookieHeader);
      const size = selectedDownloadSize(info);
      totalBytes += size;
      out.like_count = api.like_count ?? info.like_count ?? "";
      out.comment_count = api.comment_count ?? info.comment_count ?? "";
      // IG shares come from the media-info API; TikTok exposes repost_count via yt-dlp.
      out.shares = api.shares ?? info.repost_count ?? "";
      out.shares_source = api.shares_source || (info.repost_count != null ? "yt_dlp_repost_count" : "");
      out.duration = info.duration ?? "";
      out.filesize_bytes = size || "";
      out.filesize_gib = size ? formatGib(size) : "";
      out.title = info.title ?? "";
      out.downloaded_filename = "";
    } catch (error) {
      out.metadata_error = error.message;
    }
    enriched.push(out);
    if (args.sleepMs > 0 && i < rows.length - 1) await sleep(args.sleepMs);
  }
  return { rows: enriched, totalBytes };
}

function writeBatch(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => row.url).join("\n") + "\n");
}

function downloadSelected(args, cookieFile) {
  fs.mkdirSync(args.out, { recursive: true });
  const archive = path.join(args.out, "download-archive.txt");
  const result = spawnSync(
    args.ytDlp,
    [
      "--cookies", cookieFile,
      "--no-playlist",
      "-f", args.format,
      "--batch-file", args.batchFile,
      "--paths", args.out,
      "--output", "%(uploader_id|unknown-uploader)s/%(id)s.%(ext)s",
      "--download-archive", archive,
      "--merge-output-format", "mp4",
      "--no-overwrites",
      "--sleep-interval", "1",
      "--max-sleep-interval", "4",
    ],
    { encoding: "utf8", stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`yt-dlp download failed with exit code ${result.status}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputRows = readCsv(args.csv);
  const selected = selectRows(inputRows, args.top, args.sample, args.seed);
  const cookies = loadStateCookies(args.storageState);
  const cookieFile = writeYtDlpCookieFile(cookies);
  const cookieHeader = instagramCookieHeader(cookies);

  try {
    const { rows, totalBytes } = await enrichRows(args, selected, cookieFile, cookieHeader);
    writeCsv(args.selectedCsv, rows);
    writeBatch(args.batchFile, rows);
    const failures = rows.filter((row) => row.metadata_error).length;

    console.log("\nSelection summary");
    console.log(`  selected videos: ${rows.length}`);
    console.log(`  metadata failures: ${failures}`);
    console.log(`  estimated selected download size: ${formatGib(totalBytes)} GiB (${(totalBytes / 1_000_000_000).toFixed(2)} GB)`);
    console.log(`  enriched CSV: ${args.selectedCsv}`);
    console.log(`  URL batch: ${args.batchFile}`);

    if (!args.download) {
      console.log("\nEstimate/enrich-only mode. Re-run with --download to fetch the selected videos.");
      return;
    }

    if (!args.yes) {
      process.stdout.write("\nDownload selected videos now? [y/N] ");
      const answer = fs.readFileSync(0, "utf8").trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        console.log("Download cancelled.");
        return;
      }
    }

    downloadSelected(args, cookieFile);
    console.log(`\nDownloads saved under ${args.out}`);
  } finally {
    fs.rmSync(cookieFile, { force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
