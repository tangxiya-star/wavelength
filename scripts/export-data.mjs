#!/usr/bin/env node
// Dump all study data to CSV for post-analysis.
//
// Pulls every export the admin API offers (raw events + responses, plus the
// derived metric tables and the EEG-aligned event view) and writes one CSV per
// table into server/data/exports/. Re-run anytime to refresh as sessions land.
//
//   npm run data:export                       # uses http://localhost:8788
//   API_BASE=http://10.38.7.176:8788 npm run data:export
//
// server/data/ is gitignored, so exported participant/EEG data stays local.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'server', 'data', 'exports');
const BASE = (process.env.API_BASE || process.env.EXPO_PUBLIC_API_BASE || 'http://localhost:8788').replace(/\/$/, '');

// Order matters only for readability of the summary.
const TABLES = [
  ['events', 'Raw event stream — the master record (one row per logged event).'],
  ['responses', 'One row per participant: demographics + session metadata.'],
  ['metrics_by_content', 'Engagement rolled up per content type.'],
  ['metrics_by_video', 'Engagement rolled up per individual video.'],
  ['retention_curve', 'Avg dwell / % watched by feed position (drop-off curve).'],
  ['per_video_participant', 'One row per (participant, video) exposure summary.'],
  ['per_exposure_participant', 'One row per individual exposure (re-watches counted separately).'],
  ['eeg_join_events', 'EEG-aligned event view: sync ids + timestamps for post-hoc alignment.'],
];

function countRows(csv) {
  if (!csv.trim()) return 0;
  // header + data rows; quoted newlines are rare here, so a line count is fine.
  return Math.max(0, csv.replace(/\n$/, '').split('\n').length - 1);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Exporting from ${BASE}\n  -> ${OUT_DIR}\n`);

  // Fail fast with a clear message if the API isn't up.
  try {
    const ping = await fetch(`${BASE}/`);
    if (!ping.ok) throw new Error(`status ${ping.status}`);
  } catch (e) {
    console.error(`Cannot reach the API at ${BASE} (${e.message}).`);
    console.error('Start it with `npm run server` (or set API_BASE) and try again.');
    process.exit(1);
  }

  let total = 0;
  for (const [table, desc] of TABLES) {
    try {
      const res = await fetch(`${BASE}/api/admin/export?table=${encodeURIComponent(table)}`);
      if (!res.ok) {
        console.log(`  ✗ ${table.padEnd(26)} HTTP ${res.status}`);
        continue;
      }
      const csv = await res.text();
      const file = join(OUT_DIR, `${table}.csv`);
      writeFileSync(file, csv);
      const rows = countRows(csv);
      total += rows;
      console.log(`  ✓ ${table.padEnd(26)} ${String(rows).padStart(6)} rows  — ${desc}`);
    } catch (e) {
      console.log(`  ✗ ${table.padEnd(26)} ${e.message}`);
    }
  }

  console.log(`\nDone. ${total} data rows across ${TABLES.length} files in:\n  ${OUT_DIR}`);
}

main();
