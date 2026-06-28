// FlowState Testing — local API (ported from the Cloudflare Worker, SPEC §7).
//
// Same routes as the Worker — access-code validation, session lifecycle,
// demographics, playlist, batched event ingestion, video streaming, and a
// token-gated CSV export + admin dashboard — but backed by a local SQLite file
// and the on-disk `assets/videos/` folder instead of D1 + R2. Bindings are
// captured in a closure (`env`) rather than read off `c.env`, so it runs on
// @hono/node-server with no Cloudflare runtime.

import { createReadStream, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ADMIN_HTML } from './admin.js';
import type { Db } from './db.js';
import { computeMetrics, DERIVED_EXPORTS } from './metrics.js';
import { shuffleWithSeed } from './shuffle.js';

export interface AppEnv {
  DB: Db;
  /** Directory containing the .mp4 files served at /video/:key. */
  videosDir: string;
  /** Extra directory searched when a key isn't in `videosDir` (B2B sponsor clips). */
  sponsorVideosDir?: string;
  ADMIN_TOKEN: string;
}

export function createApp(env: AppEnv): Hono {
  const app = new Hono();
  const db = env.DB;

  app.use('*', cors());

  app.get('/', (c) => c.json({ ok: true, service: 'flowstate-testing' }));

  // --- POST /api/code/validate ---
  app.post('/api/code/validate', async (c) => {
    const { code } = await c.req.json<{ code?: string }>();
    const row = await db
      .prepare('SELECT session_minutes, condition, max_uses, uses_count, active, expires_at FROM access_codes WHERE code = ?')
      .bind((code ?? '').trim().toUpperCase())
      .first<{ session_minutes: number; condition: string | null; max_uses: number | null; uses_count: number; active: number; expires_at: string | null }>();

    const ok =
      !!row &&
      row.active === 1 &&
      (row.expires_at == null || row.expires_at > new Date().toISOString()) &&
      (row.max_uses == null || row.uses_count < row.max_uses);

    if (!ok || !row) return c.json({ ok: false, sessionMinutes: 0, condition: null });
    return c.json({ ok: true, sessionMinutes: row.session_minutes, condition: row.condition });
  });

  // --- POST /api/session/start ---
  app.post('/api/session/start', async (c) => {
    const b = await c.req.json<{
      code: string;
      participantId: string;
      platform?: string;
      appVersion?: string;
      sessionMinutes?: number;
      playlistSeed?: string;
      device?: unknown;
    }>();
    const code = (b.code ?? '').trim().toUpperCase();

    const row = await db
      .prepare('SELECT session_minutes, condition, max_uses, uses_count, active FROM access_codes WHERE code = ?')
      .bind(code)
      .first<{ session_minutes: number; condition: string | null; max_uses: number | null; uses_count: number; active: number }>();

    if (!row || row.active !== 1 || (row.max_uses != null && row.uses_count >= row.max_uses)) {
      return c.json({ error: 'invalid_code' }, 403);
    }

    const minutes = b.sessionMinutes ?? row.session_minutes;
    const now = Date.now();
    const endsAt = now + minutes * 60_000;
    const sessionId = crypto.randomUUID();
    const nowIso = new Date(now).toISOString();

    await db.batch([
      db.prepare('UPDATE access_codes SET uses_count = uses_count + 1 WHERE code = ?').bind(code),
      db
        .prepare('INSERT OR IGNORE INTO participants (id, access_code, platform, app_version, device, created_at) VALUES (?,?,?,?,?,?)')
        .bind(b.participantId, code, b.platform ?? null, b.appVersion ?? null, b.device ? JSON.stringify(b.device) : null, nowIso),
      db
        .prepare('INSERT INTO sessions (id, participant_id, access_code, condition, playlist_seed, started_at, ends_at) VALUES (?,?,?,?,?,?,?)')
        .bind(sessionId, b.participantId, code, row.condition ?? null, b.playlistSeed ?? null, nowIso, new Date(endsAt).toISOString()),
    ]);

    return c.json({ sessionId, participantId: b.participantId, endsAt });
  });

  // --- POST /api/demographics ---
  app.post('/api/demographics', async (c) => {
    const { participantId, demographics: d } = await c.req.json<{ participantId: string; demographics: Record<string, unknown> }>();
    await db
      .prepare(
        `INSERT OR REPLACE INTO demographics
           (participant_id, age_band, sex_at_birth, gender_identity, daily_shortform_use, consent_18plus, submitted_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(
        participantId,
        (d.ageBand as string) ?? null,
        (d.sexAtBirth as string) ?? null,
        (d.genderIdentity as string) ?? null,
        (d.dailyShortformUse as string) ?? null,
        d.consent18Plus ? 1 : 0,
        new Date().toISOString(),
      )
      .run();
    return c.json({ ok: true });
  });

  // --- GET /api/playlist?seed=... ---
  // Pinned videos (pinned=1) lead the feed FIRST, in ascending sort_order,
  // un-shuffled. Everything else (the endless "rest" pool) is shuffled by seed
  // and appended. This applies hollyordering.csv as the start of the feed.
  app.get('/api/playlist', async (c) => {
    const seed = c.req.query('seed') ?? 'default';
    const { results } = await db
      .prepare('SELECT id, slug, title, r2_key, duration_seconds, content_type, pinned FROM videos WHERE active = 1 ORDER BY sort_order')
      .all<{ id: string; slug: string; title: string; r2_key: string; duration_seconds: number; content_type: string; pinned: number }>();

    const origin = new URL(c.req.url).origin;
    const toVideo = (r: { id: string; slug: string; title: string; r2_key: string; duration_seconds: number; content_type: string; pinned: number }) => {
      const url = `${origin}/video/${r.r2_key}`;
      return { id: r.id, slug: r.slug, title: r.title, url, source: url, durationSeconds: r.duration_seconds, contentType: r.content_type, pinned: !!r.pinned };
    };

    const rows = results ?? [];
    // Already sorted by sort_order, so pinned come out in ascending order.
    const pinnedInOrder = rows.filter((r) => r.pinned).map(toVideo);
    const shuffledRest = shuffleWithSeed(rows.filter((r) => !r.pinned).map(toVideo), seed);
    return c.json([...pinnedInOrder, ...shuffledRest]);
  });

  // --- GET /api/videos ---
  // Catalog endpoint for the NeuroViral web frontend (Holly's /live, /report,
  // /log). Returns the active catalog shaped to the shared `Video` contract
  // (frontend/lib/types.ts): real streamable `url`, `title`, `duration_ms`, and
  // `creator` derived from the slug. Characteristics this catalog doesn't carry
  // (cut_count, on-screen text, subtitles, audio mix) come back as safe defaults
  // — /live's movie-barcode + waveform are computed client-side, so the demo
  // stays driven by the real clips rather than these fields.
  app.get('/api/videos', async (c) => {
    const { results } = await db
      .prepare('SELECT id, slug, title, r2_key, duration_seconds FROM videos WHERE active = 1 ORDER BY sort_order')
      .all<{ id: string; slug: string; title: string; r2_key: string; duration_seconds: number }>();

    const origin = new URL(c.req.url).origin;
    // slug is "<creator_handle>_<shortcode>" — drop the trailing id token.
    const creatorOf = (slug: string | null) => {
      if (!slug) return '';
      const parts = slug.split('_');
      return parts.length > 1 ? `@${parts.slice(0, -1).join('_')}` : `@${slug}`;
    };

    const videos = (results ?? []).map((r) => ({
      video_id: r.id,
      url: `${origin}/video/${r.r2_key}`,
      characteristics: {
        audio: 'music+VO',
        transcript_summary: r.title ?? '',
        cut_count: 0,
        on_screen_text: '',
        subtitles: false,
      },
      metadata: {
        duration_ms: Math.round((r.duration_seconds ?? 0) * 1000),
        creator: creatorOf(r.slug),
      },
    }));
    return c.json(videos);
  });

  // --- POST /api/events  (batch) ---
  app.post('/api/events', async (c) => {
    const { events } = await c.req.json<{ events: Array<Record<string, unknown>> }>();
    if (!Array.isArray(events) || events.length === 0) return c.json({ ok: true, count: 0 });

    const serverTs = new Date().toISOString();
    const stmts = events.map((e) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO events
             (id, session_id, participant_id, video_id, event_type, feed_position, client_ts, server_ts, payload)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          e.id,
          (e.sessionId as string) ?? null,
          (e.participantId as string) ?? null,
          (e.videoId as string) ?? null,
          e.eventType,
          (e.feedPosition as number) ?? null,
          (e.clientTs as string) ?? null,
          serverTs,
          JSON.stringify(e.payload ?? {}),
        ),
    );
    await db.batch(stmts);
    return c.json({ ok: true, count: events.length });
  });

  // --- POST /api/session/end ---
  app.post('/api/session/end', async (c) => {
    const { sessionId, endReason } = await c.req.json<{ sessionId: string; endReason?: string }>();
    await db
      .prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?')
      .bind(new Date().toISOString(), endReason ?? null, sessionId)
      .run();
    return c.json({ ok: true });
  });

  // --- GET /video/:key  (stream from the local assets/videos folder) ---
  app.get('/video/:key', (c) => {
    const key = c.req.param('key');
    // Defend against path traversal: only a bare filename, resolved inside a known dir.
    if (!/^[\w.-]+$/.test(key)) return c.notFound();

    // Resolve the first existing file across the main catalog dir and the
    // sponsor (B2B) dir, each guarded against escaping its own root.
    const dirs = [env.videosDir, env.sponsorVideosDir].filter((d): d is string => !!d);
    let filePath: string | undefined;
    let size = 0;
    for (const dir of dirs) {
      const candidate = normalize(join(dir, key));
      if (!candidate.startsWith(normalize(dir))) continue;
      try {
        size = statSync(candidate).size;
        filePath = candidate;
        break;
      } catch {
        // not in this dir — try the next
      }
    }
    if (!filePath) return c.notFound();

    const contentType = key.endsWith('.webm') ? 'video/webm' : key.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
    const baseHeaders: Record<string, string> = {
      'content-type': contentType,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=3600',
    };

    // Honor Range requests so <video> scrubbing / seeking works.
    const range = c.req.header('range');
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start > end || start >= size) {
        return new Response('Range Not Satisfiable', { status: 416, headers: { 'content-range': `bytes */${size}` } });
      }
      const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as unknown as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: { ...baseHeaders, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
      });
    }

    const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream;
    return new Response(stream, { status: 200, headers: { ...baseHeaders, 'content-length': String(size) } });
  });

  // ---- Admin: dashboard + management (open — no login) ----

  app.get('/admin', (c) => c.html(ADMIN_HTML));

  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  function genCode(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    let s = '';
    for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return s;
  }

  // Generate one or more access codes.
  app.post('/api/admin/codes', async (c) => {
    const b = await c.req.json<{ label?: string; sessionMinutes?: number; condition?: string; maxUses?: number; count?: number }>();
    const minutes = Number(b.sessionMinutes) || 30;
    const count = Math.min(Math.max(Number(b.count) || 1, 1), 100);
    const maxUses = b.maxUses != null ? Number(b.maxUses) : null;
    const created: string[] = [];
    for (let i = 0; i < count; i++) {
      let code = genCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await db
            .prepare('INSERT INTO access_codes (code, label, condition, session_minutes, max_uses) VALUES (?,?,?,?,?)')
            .bind(code, b.label ?? null, b.condition ?? null, minutes, maxUses)
            .run();
          break;
        } catch {
          code = genCode(); // collision — retry
        }
      }
      created.push(code);
    }
    return c.json({ codes: created });
  });

  // List access codes.
  app.get('/api/admin/codes', async (c) => {
    const { results } = await db
      .prepare('SELECT code, label, condition, session_minutes, max_uses, uses_count, active, created_at FROM access_codes ORDER BY created_at DESC')
      .all();
    return c.json(results ?? []);
  });

  // Near-real-time summary counts.
  app.get('/api/admin/summary', async (c) => {
    const num = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
    const [participants, sessions, completed, events] = await Promise.all([
      num('SELECT count(*) n FROM participants'),
      num('SELECT count(*) n FROM sessions'),
      num('SELECT count(*) n FROM sessions WHERE ended_at IS NOT NULL'),
      num('SELECT count(*) n FROM events'),
    ]);
    const byType = (await db.prepare('SELECT event_type, count(*) n FROM events GROUP BY event_type ORDER BY n DESC').all()).results ?? [];
    return c.json({ participants, sessions, completed, events, byType });
  });

  // Recent sessions with demographics, device, and event counts.
  app.get('/api/admin/sessions', async (c) => {
    const { results } = await db
      .prepare(
        `SELECT s.id, s.access_code, s.started_at, s.ended_at, s.end_reason, s.condition,
                p.platform, p.device,
                d.age_band, d.sex_at_birth, d.gender_identity, d.daily_shortform_use,
                (SELECT count(*) FROM events e WHERE e.session_id = s.id) AS event_count
           FROM sessions s
           LEFT JOIN participants p ON p.id = s.participant_id
           LEFT JOIN demographics d ON d.participant_id = s.participant_id
          ORDER BY s.started_at DESC LIMIT 100`,
      )
      .all();
    return c.json(results ?? []);
  });

  // Derived retention + engagement metrics (SPEC §5.2).
  app.get('/api/admin/metrics', async (c) => {
    return c.json(await computeMetrics(db));
  });

  // CSV export. Raw tables (events, responses) plus the derived metric tables.
  app.get('/api/admin/export', async (c) => {
    const table = c.req.query('table') ?? 'events';
    let rows: Array<Record<string, unknown>> = [];
    if (table in DERIVED_EXPORTS) {
      rows = await DERIVED_EXPORTS[table](db);
    } else if (table === 'responses') {
      const r = await db
        .prepare(
          `SELECT p.id AS participant_id, p.access_code, p.platform, p.app_version, p.device, p.created_at,
                  d.age_band, d.sex_at_birth, d.gender_identity, d.daily_shortform_use, d.consent_18plus,
                  s.id AS session_id, s.condition, s.playlist_seed, s.started_at, s.ends_at, s.ended_at, s.end_reason
             FROM participants p
             LEFT JOIN demographics d ON d.participant_id = p.id
             LEFT JOIN sessions s ON s.participant_id = p.id
            ORDER BY p.created_at`,
        )
        .all();
      rows = (r.results ?? []) as Array<Record<string, unknown>>;
    } else {
      const r = await db
        .prepare(
          `SELECT id, session_id, participant_id, video_id, event_type, feed_position, client_ts, server_ts, payload
             FROM events ORDER BY server_ts`,
        )
        .all();
      rows = (r.results ?? []) as Array<Record<string, unknown>>;
    }
    return new Response(toCsv(rows), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${table}.csv"`,
      },
    });
  });

  return app;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((row) => cols.map((k) => esc(row[k])).join(','))].join('\n');
}
