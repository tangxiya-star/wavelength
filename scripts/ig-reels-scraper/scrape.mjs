// Social video scraper — Instagram Reels (browser) + TikTok (yt-dlp).
// Appends every video (link + view count) into ONE combined CSV with a
// `platform` column. Run it for as many accounts / both platforms as you like;
// it all accumulates in the same file.
//
// Instagram is scraped from the reels grid in a logged-in Playwright session.
// TikTok's profile grid doesn't hydrate reliably under automation, so TikTok is
// enumerated via yt-dlp's flat playlist instead — no browser, no login needed.
//
// Usage:
//   node scrape.mjs --login                                  # one-time IG login (window opens)
//   node scrape.mjs jess.studytips                           # Instagram (default platform)
//   node scrape.mjs --ig jess.studytips studytee             # several IG accounts
//   node scrape.mjs --tiktok connor.learningspanish          # TikTok account (yt-dlp, no login)
//   node scrape.mjs --tiktok https://www.tiktok.com/@connor.learningspanish   # URLs ok too
//   node scrape.mjs --tiktok https://www.tiktok.com/@connor.learningspanish/video/123  # single post
//   node scrape.mjs --ig jess.studytips --tiktok connor.learningspanish        # mix in one run
//
// Output: ./ig-data/videos.csv
//   columns: scraped_at, platform, username, id, url, views_text, views
//
// Requires yt-dlp on PATH for any TikTok target (override with YT_DLP=/path/to/yt-dlp).

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const YT_DLP = process.env.YT_DLP || "yt-dlp";

// ---- arg parsing: handles after --ig / --tiktok belong to that platform -----
const argv = process.argv.slice(2);
const LOGIN = argv.includes("--login");
const HEADLESS = argv.includes("--headless");
const targets = []; // { platform, type: 'account'|'post', value, handle?, url? }
let current = "instagram"; // default bucket
const seenTargets = new Set();
for (const a of argv) {
  if (a === "--ig" || a === "--instagram") { current = "instagram"; continue; }
  if (a === "--tiktok" || a === "--tt") { current = "tiktok"; continue; }
  if (a.startsWith("--")) continue; // other flags

  let platform = current;
  if (/tiktok\.com/i.test(a)) platform = "tiktok";
  else if (/instagram\.com/i.test(a)) platform = "instagram";

  // individual post / reel permalink → fetch just that one's view count
  const igPost = a.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
  const ttPost = a.match(/tiktok\.com\/@([A-Za-z0-9._]+)\/video\/(\d+)/i);
  let t;
  if (igPost) t = { platform: "instagram", type: "post", value: igPost[1] };
  else if (ttPost) t = {
    platform: "tiktok", type: "post", value: ttPost[2], handle: ttPost[1],
    url: `https://www.tiktok.com/@${ttPost[1]}/video/${ttPost[2]}`,
  };
  else {
    // account handle = FIRST path segment after the domain (so .../<handle>/reels/
    // doesn't get parsed as "reels"); or a bare @handle / handle
    let handle;
    if (/instagram\.com/i.test(a)) handle = a.match(/instagram\.com\/([A-Za-z0-9._]+)/i)?.[1];
    else if (/tiktok\.com/i.test(a)) handle = a.match(/tiktok\.com\/@?([A-Za-z0-9._]+)/i)?.[1];
    else handle = a.match(/^@?([A-Za-z0-9._]+)/)?.[1];
    t = { platform, type: "account", value: (handle || a).replace(/^@/, "") };
  }
  const key = `${t.platform}:${t.type}:${t.value}`;
  if (seenTargets.has(key)) continue; // dedupe (e.g. the same post pasted twice)
  seenTargets.add(key);
  targets.push(t);
}
if (!targets.length && !LOGIN) targets.push({ platform: "instagram", type: "account", value: "jess.studytips" });

const DIR = path.resolve("./ig-data");
fs.mkdirSync(DIR, { recursive: true });
const STATE = path.join(DIR, "storageState.json");
const CSV = path.join(DIR, "videos.csv");

// ---- helpers ----------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min)); // jitter
const randf = (min, max) => min + Math.random() * (max - min);
const jitterSleep = (min, max) => sleep(rand(min, max));

// Natural scrolling: many small wheel "notches" with easing + micro-pauses,
// occasional upward re-reads, a little mouse drift, and the odd long pause —
// instead of one big teleport-jump per step.
async function naturalScroll(page) {
  await page.mouse.move(rand(150, 1100), rand(120, 820), { steps: rand(3, 9) });
  const burst = rand(5, 11); // number of wheel notches in this burst
  for (let i = 0; i < burst; i++) {
    // ease in then out across the burst so speed ramps up and slows down
    const ease = Math.sin((Math.PI * (i + 1)) / burst); // 0..1..0
    const delta = Math.round(randf(90, 240) + ease * randf(120, 360));
    await page.mouse.wheel(0, delta);
    await sleep(rand(45, 190)); // between-notch micro-pause
  }
  if (Math.random() < 0.18) {
    // human re-read: drift back up a bit, pause, continue
    await page.mouse.wheel(0, -rand(220, 800));
    await jitterSleep(550, 1500);
  }
}

// "1.2M" -> 1200000, "12.3K" -> 12300, "1,234" -> 1234, "987" -> 987
function parseCount(text) {
  if (!text) return null;
  const m = String(text).trim().replace(/,/g, "").match(/([\d.]+)\s*([KMB]?)/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const suf = (m[2] || "").toUpperCase();
  if (suf === "K") n *= 1e3;
  else if (suf === "M") n *= 1e6;
  else if (suf === "B") n *= 1e9;
  return Math.round(n);
}

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function igLoggedIn(context) {
  const cookies = await context.cookies("https://www.instagram.com");
  return cookies.some((c) => c.name === "sessionid" && c.value);
}

// ---- TikTok via yt-dlp ------------------------------------------------------
// Flat-playlist enumeration returns one entry per video with id + url + view
// count, for either an account URL (all videos) or a single /video/ URL.
function scrapeTikTok(targetUrl, handleHint) {
  const res = spawnSync(
    YT_DLP,
    [
      "--flat-playlist",
      "--no-warnings",
      "--ignore-errors",
      "--print", "%(id)s\t%(webpage_url)s\t%(view_count)s",
      targetUrl,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const stdout = res.stdout || "";
  if (!stdout.trim()) {
    if (res.error && res.error.code === "ENOENT") {
      throw new Error(`yt-dlp not found (looked for "${YT_DLP}"). Install it or set YT_DLP=/path/to/yt-dlp.`);
    }
    const msg = (res.stderr || "yt-dlp returned no videos").trim().split(/\r?\n/).pop();
    throw new Error(msg);
  }
  const out = [];
  const seen = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [id, vurl, vc] = line.split("\t");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const views = vc && vc !== "NA" ? Number(vc) : null;
    out.push({
      id,
      url: vurl && vurl !== "NA" ? vurl : `https://www.tiktok.com/@${handleHint}/video/${id}`,
      views_text: Number.isFinite(views) ? String(views) : "",
      views: Number.isFinite(views) ? views : null,
    });
  }
  return out;
}

// ---- platform config (Instagram browser path) ------------------------------
const PLATFORMS = {
  instagram: {
    url: (h) => `https://www.instagram.com/${h}/reels/`,
    // each reel tile is an <a href="/reel/CODE/"> whose overlay text is the view count
    extract: () => {
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/reel/"]')) {
        const m = (a.getAttribute("href") || "").match(/\/reel\/([^/?]+)/);
        if (!m) continue;
        out.push({ id: m[1], url: `https://www.instagram.com/reel/${m[1]}/`, text: (a.innerText || "").replace(/\s+/g, " ").trim() });
      }
      return out;
    },
  },
};

// ---- lazy browser (only launched for Instagram targets / --login) ----------
let browser = null;
let context = null;
let page = null;
async function ensureBrowser() {
  if (page) return page;
  const haveStateFile = fs.existsSync(STATE);
  const needLogin = LOGIN || !haveStateFile;
  browser = await chromium.launch({ headless: HEADLESS && !needLogin });
  context = haveStateFile && !LOGIN
    ? await browser.newContext({ storageState: STATE, viewport: { width: 1280, height: 900 } })
    : await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();

  if (needLogin) {
    await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });
    console.log("\n>> A browser window is open. Log into Instagram manually (handles 2FA/captcha).");
    console.log(">> Waiting for login to complete (up to 5 min)...\n");
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      if (await igLoggedIn(context)) break;
      await sleep(2000);
    }
    if (!(await igLoggedIn(context))) {
      console.error("Login not detected within 5 minutes. Re-run with --login.");
      await browser.close();
      process.exit(1);
    }
    await jitterSleep(1500, 3000);
    await context.storageState({ path: STATE });
    console.log("✓ Session saved.\n");
  }
  return page;
}

// ---- scrape one Instagram account ------------------------------------------
async function scrapeAccount({ platform, value: handle }) {
  const cfg = PLATFORMS[platform];
  console.log(`\nScraping [${platform}] @${handle} ...`);
  await page.goto(cfg.url(handle), { waitUntil: "domcontentloaded" });
  await jitterSleep(3500, 5500); // let the grid hydrate

  const collected = new Map(); // id -> { url, text }
  let stable = 0;
  let lastSize = 0;
  let step = 0;
  while (stable < 6) {
    let items = [];
    try {
      items = await page.evaluate(cfg.extract);
    } catch { /* transient nav */ }
    for (const it of items) {
      const prev = collected.get(it.id);
      if (!prev || (it.text && !prev.text)) collected.set(it.id, { url: it.url, text: it.text });
    }
    if (collected.size === lastSize) stable++; else stable = 0;
    lastSize = collected.size;
    process.stdout.write(`\r  loaded ${collected.size} videos...`);

    // natural scrolling + a randomized "reading" pause between bursts
    await naturalScroll(page);
    await jitterSleep(800, 2300);
    if (++step % rand(4, 7) === 0) await jitterSleep(2400, 5600); // occasional long pause
  }
  console.log("");
  return [...collected.entries()].map(([id, v]) => ({
    id, url: v.url, views_text: v.text, views: parseCount(v.text),
  }));
}

// ---- scrape a single IG post/reel (view count + owner) ----------------------
// The single-post page returns view_count:null, but the media-info API returns
// play_count. Shortcode decodes locally to the media id, so no page load needed
// per post — just one credentialed fetch from the instagram.com origin.
const SC_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function shortcodeToMediaId(sc) {
  let id = 0n;
  for (const c of sc) {
    const i = SC_ALPHABET.indexOf(c);
    if (i < 0) return null;
    id = id * 64n + BigInt(i);
  }
  return id.toString();
}

let igOriginReady = false;
async function scrapeIgPost(shortcode) {
  const url = `https://www.instagram.com/reel/${shortcode}/`;
  const pk = shortcodeToMediaId(shortcode);
  if (!pk) return { id: shortcode, url, owner: null, views_raw: null };
  if (!igOriginReady) {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
    await jitterSleep(1500, 3000);
    igOriginReady = true;
  }
  const info = await page.evaluate(async (pk) => {
    try {
      const r = await fetch(`https://www.instagram.com/api/v1/media/${pk}/info/`, {
        headers: { "x-ig-app-id": "936619743392459" },
        credentials: "include",
      });
      if (!r.ok) return { status: r.status };
      const j = await r.json();
      const m = (j.items && j.items[0]) || {};
      return { user: m.user && m.user.username, play_count: m.play_count ?? m.ig_play_count ?? m.view_count ?? null };
    } catch (e) { return { error: String(e) }; }
  }, pk);
  await jitterSleep(1500, 3500); // polite pacing between API calls
  return { id: shortcode, url, owner: (info && info.user) || null, views_raw: (info && info.play_count) ?? null };
}

// ---- run --------------------------------------------------------------------
const now = new Date().toISOString();
if (!fs.existsSync(CSV)) {
  fs.writeFileSync(CSV, "scraped_at,platform,username,id,url,views_text,views\n");
}

// --login: run the login flow up front, then exit if there's nothing to scrape.
if (LOGIN) {
  await ensureBrowser();
  if (!targets.length) { if (browser) await browser.close(); process.exit(0); }
}

let grandTotal = 0;
for (let i = 0; i < targets.length; i++) {
  const t = targets[i];

  if (t.type === "post") {
    if (t.platform === "tiktok") {
      try {
        console.log(`\nFetching [tiktok post] ${t.value} ...`);
        const vids = scrapeTikTok(t.url, t.handle);
        for (const v of vids) {
          fs.appendFileSync(
            CSV,
            [now, "tiktok", t.handle, v.id, v.url, v.views_text, v.views ?? ""].map(csvCell).join(",") + "\n"
          );
        }
        grandTotal += vids.length;
        console.log(`  ✓ [tiktok post] ${t.value} (${vids.length} appended)`);
      } catch (e) {
        console.error(`  ! failed for tiktok post ${t.value}: ${e.message}`);
      }
      if (i < targets.length - 1) await jitterSleep(2000, 5000);
      continue;
    }

    // Instagram post
    try {
      await ensureBrowser();
      console.log(`\nFetching [post] ${t.value} ...`);
      const p = await scrapeIgPost(t.value);
      const viewsNum = typeof p.views_raw === "number" ? p.views_raw : parseCount(p.views_raw);
      fs.appendFileSync(
        CSV,
        [now, "instagram", p.owner || "", p.id, p.url, p.views_raw ?? "", viewsNum ?? ""].map(csvCell).join(",") + "\n"
      );
      grandTotal += 1;
      console.log(`  ✓ [post] ${p.id}  owner=@${p.owner || "?"}  views=${viewsNum ?? "?"}`);
    } catch (e) {
      console.error(`  ! failed for post ${t.value}: ${e.message}`);
    }
    if (i < targets.length - 1) await jitterSleep(8000, 20000);
    continue;
  }

  // account
  let vids = [];
  try {
    if (t.platform === "tiktok") {
      console.log(`\nScraping [tiktok] @${t.value} via yt-dlp ...`);
      vids = scrapeTikTok(`https://www.tiktok.com/@${t.value}`, t.value);
      console.log(`  enumerated ${vids.length} videos`);
    } else {
      await ensureBrowser();
      vids = await scrapeAccount(t);
    }
  } catch (e) {
    console.error(`  ! failed for [${t.platform}] @${t.value}: ${e.message}`);
    continue;
  }
  if (!vids.length) {
    console.error(`  ! 0 videos for [${t.platform}] @${t.value} (login expired / wrong handle / layout change)`);
  } else {
    fs.appendFileSync(
      CSV,
      vids.map((v) => [now, t.platform, t.value, v.id, v.url, v.views_text, v.views ?? ""].map(csvCell).join(",")).join("\n") + "\n"
    );
    grandTotal += vids.length;
    console.log(`  ✓ [${t.platform}] @${t.value}: ${vids.length} videos appended`);
  }
  if (i < targets.length - 1) await jitterSleep(8000, 20000); // polite gap between IG accounts
}

console.log(`\n✓ Done. ${grandTotal} videos written to ${CSV}`);
if (browser) await browser.close();
