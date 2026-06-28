// Local API server entry point.
//
// Opens (creating + seeding on first run) the SQLite file, wires up the video
// folder, and serves the Hono app on http://localhost:8787 via Node — no
// wrangler, no Cloudflare account, no deploy. Point the Expo app at it with
// EXPO_PUBLIC_API_BASE=http://localhost:8787.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { openDb } from './db.js';

const here = import.meta.dirname; // server/src
const root = join(here, '..'); // server/

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 so a phone on the LAN can reach it
const DB_PATH = process.env.DB_PATH || join(root, 'data', 'flowstate.sqlite');
const VIDEOS_DIR = process.env.VIDEOS_DIR || join(root, '..', 'assets', 'videos');
// B2B sponsor clips (Cursor, OpenAI, …) — large, git-ignored, repo-root local only.
const SPONSOR_VIDEOS_DIR = process.env.SPONSOR_VIDEOS_DIR || join(root, '..', 'sponsor-videos');

// Master admin token (kept for any scripted/curl access). The dashboard at
// /admin is open — no username/password login.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token';

const schemaSql = readFileSync(join(root, 'schema.sql'), 'utf8');
const seedSql = readFileSync(join(root, 'seed.sql'), 'utf8');

const db = openDb(DB_PATH, schemaSql, seedSql);

const app = createApp({ DB: db, videosDir: VIDEOS_DIR, sponsorVideosDir: SPONSOR_VIDEOS_DIR, ADMIN_TOKEN });

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Testing API  ${url}`);
  console.log(`  admin dashboard       ${url}/admin   (open — no login)`);
  console.log(`  sqlite                ${DB_PATH}`);
  console.log(`  videos                ${VIDEOS_DIR}`);
  console.log(`  sponsor videos        ${SPONSOR_VIDEOS_DIR}`);
});
