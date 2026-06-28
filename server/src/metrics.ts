// Derived retention + engagement metrics (SPEC §5.2).
//
// The raw `events` firehose only becomes useful once aggregated. These queries
// turn it into the numbers the study actually compares: dwell / watch time /
// completion across media types (the headline output), a retention curve down
// the feed, and per-video / per-(participant × video) rollups for export.
//
// Every engagement metric is derived from `scroll_away` events, which carry the
// full per-impression summary in their JSON payload:
//   dwellMs  — how long the card was on screen before the user left ("click-off")
//   watchMs  — cumulative playback time (counts loops/replays)
//   pctWatched — furthest fraction of the clip reached (0..1)
//   loops    — number of replays before scrolling away

import type { Db } from './db';

// SQLite `json_extract` returns the JSON number directly; AVG/SUM skip NULLs,
// so missing keys are ignored rather than counted as zero.
const DWELL = "json_extract(e.payload,'$.dwellMs')";
const WATCH = "json_extract(e.payload,'$.watchMs')";
const PCT = "json_extract(e.payload,'$.pctWatched')";
const LOOPS = "json_extract(e.payload,'$.loops')";
const EXPOSURE = "json_extract(e.payload,'$.exposureId')";
const EEG_SYNC = "json_extract(e.payload,'$.eegSyncId')";
const SESSION_ELAPSED = "json_extract(e.payload,'$.sessionElapsedMs')";
const CLIENT_EPOCH = "json_extract(e.payload,'$.clientEpochMs')";
const FINAL_THUMB = "json_extract(e.payload,'$.finalThumb')";
const SAVED = "json_extract(e.payload,'$.saved')";
const MAX_POS = "json_extract(e.payload,'$.maxPositionMs')";

// A clip is "completed" when the viewer reached ≥90% of it.
const COMPLETE = `CASE WHEN ${PCT} >= 0.9 THEN 1.0 ELSE 0.0 END`;

const ENGAGEMENT_COLS = `
  COUNT(*)                          AS views,
  ROUND(AVG(${DWELL}) / 1000.0, 2)  AS avg_dwell_s,
  ROUND(AVG(${WATCH}) / 1000.0, 2)  AS avg_watch_s,
  ROUND(AVG(${PCT}), 3)             AS avg_pct_watched,
  ROUND(100.0 * AVG(${COMPLETE}), 1) AS completion_pct,
  ROUND(AVG(${LOOPS}), 2)           AS avg_loops`;

export type Row = Record<string, unknown>;

const all = async (db: Db, sql: string): Promise<Row[]> =>
  ((await db.prepare(sql).all()).results ?? []) as Row[];

/**
 * Net like / dislike / save counts per content type. Toggles cancel out
 * (`thumbs_up` − `thumbs_up_removed`, `save` − `unsave`) so we count the
 * final intent, not every tap.
 */
async function reactionsByContentType(db: Db): Promise<Map<string, { likes: number; dislikes: number; saves: number }>> {
  const rows = await all(
    db,
    `SELECT v.content_type AS content_type, e.event_type AS event_type, COUNT(*) AS n
       FROM events e JOIN videos v ON v.id = e.video_id
      WHERE e.event_type IN
        ('thumbs_up','thumbs_up_removed','thumbs_down','thumbs_down_removed','save','unsave')
      GROUP BY v.content_type, e.event_type`,
  );
  const map = new Map<string, { likes: number; dislikes: number; saves: number }>();
  for (const r of rows) {
    const ct = (r.content_type as string) ?? 'unknown';
    const m = map.get(ct) ?? { likes: 0, dislikes: 0, saves: 0 };
    const n = Number(r.n) || 0;
    switch (r.event_type) {
      case 'thumbs_up': m.likes += n; break;
      case 'thumbs_up_removed': m.likes -= n; break;
      case 'thumbs_down': m.dislikes += n; break;
      case 'thumbs_down_removed': m.dislikes -= n; break;
      case 'save': m.saves += n; break;
      case 'unsave': m.saves -= n; break;
    }
    map.set(ct, m);
  }
  return map;
}

/**
 * The headline output: engagement compared across media types. Combines the
 * dwell/watch/completion rollup with net reaction rates (per 100 views).
 */
export async function byContentType(db: Db): Promise<Row[]> {
  const [base, reactions] = await Promise.all([
    all(
      db,
      `SELECT v.content_type AS content_type, ${ENGAGEMENT_COLS}
         FROM events e JOIN videos v ON v.id = e.video_id
        WHERE e.event_type = 'scroll_away'
        GROUP BY v.content_type
        ORDER BY avg_watch_s DESC`,
    ),
    reactionsByContentType(db),
  ]);
  return base.map((r) => {
    const views = Number(r.views) || 0;
    const m = reactions.get(r.content_type as string) ?? { likes: 0, dislikes: 0, saves: 0 };
    const per100 = (x: number) => (views ? Math.round((1000 * x) / views) / 10 : 0);
    return {
      ...r,
      likes: Math.max(0, m.likes),
      dislikes: Math.max(0, m.dislikes),
      saves: Math.max(0, m.saves),
      like_rate_pct: per100(Math.max(0, m.likes)),
      save_rate_pct: per100(Math.max(0, m.saves)),
    };
  });
}

/**
 * Retention curve: average engagement at each depth in the feed. Rising
 * click-off / falling completion as feed_position grows is where the session
 * is losing people.
 */
export function retentionCurve(db: Db): Promise<Row[]> {
  return all(
    db,
    `SELECT e.feed_position AS feed_position,
            COUNT(*)                          AS views,
            ROUND(AVG(${DWELL}) / 1000.0, 2)  AS avg_dwell_s,
            ROUND(AVG(${WATCH}) / 1000.0, 2)  AS avg_watch_s,
            ROUND(AVG(${PCT}), 3)             AS avg_pct_watched
       FROM events e
      WHERE e.event_type = 'scroll_away' AND e.feed_position IS NOT NULL
      GROUP BY e.feed_position
      ORDER BY e.feed_position`,
  );
}

/** Per-video rollup (same engagement columns, grouped by clip). */
export function byVideo(db: Db): Promise<Row[]> {
  return all(
    db,
    `SELECT v.slug AS slug, v.title AS title, v.content_type AS content_type, ${ENGAGEMENT_COLS}
       FROM events e JOIN videos v ON v.id = e.video_id
      WHERE e.event_type = 'scroll_away'
      GROUP BY e.video_id
      ORDER BY v.content_type, v.slug`,
  );
}

/**
 * Per (participant × video) grain (SPEC §5.2) — one row per clip a participant
 * saw, summed across repeat impressions. Intended for export / external stats.
 */
export function perVideoParticipant(db: Db): Promise<Row[]> {
  return all(
    db,
    `SELECT e.session_id AS session_id, e.participant_id AS participant_id, v.id AS video_id,
            v.slug AS slug, v.content_type AS content_type,
            COUNT(*)                          AS impressions,
            ROUND(SUM(${WATCH}) / 1000.0, 2)  AS total_watch_s,
            ROUND(SUM(${DWELL}) / 1000.0, 2)  AS total_dwell_s,
            ROUND(MAX(${PCT}), 3)             AS max_pct_watched,
            SUM(${LOOPS})                     AS total_loops
       FROM events e JOIN videos v ON v.id = e.video_id
      WHERE e.event_type = 'scroll_away'
      GROUP BY e.session_id, e.participant_id, e.video_id
      ORDER BY e.session_id, e.participant_id, v.content_type, v.slug`,
  );
}

/**
 * One row per video exposure, designed for joining EEG windows in post.
 * `exposure_start_ms` and `exposure_end_ms` are client-relative offsets from
 * app session start; use `eeg_sync_id` and `session_id` as the stable join keys.
 */
export function perExposureParticipant(db: Db): Promise<Row[]> {
  return all(
    db,
    `SELECT e.session_id AS session_id,
            e.participant_id AS participant_id,
            ${EEG_SYNC} AS eeg_sync_id,
            ${EXPOSURE} AS exposure_id,
            e.video_id AS video_id,
            v.slug AS slug,
            v.title AS title,
            v.content_type AS content_type,
            e.feed_position AS feed_position,
            ROUND(${SESSION_ELAPSED} / 1000.0, 3) AS exposure_end_s,
            ROUND((${SESSION_ELAPSED} - ${DWELL}) / 1000.0, 3) AS exposure_start_s,
            ${CLIENT_EPOCH} AS exposure_end_epoch_ms,
            ${DWELL} AS dwell_ms,
            ${WATCH} AS watch_ms,
            ${PCT} AS pct_watched,
            ${MAX_POS} AS max_position_ms,
            ${LOOPS} AS loops,
            ${FINAL_THUMB} AS final_thumb,
            ${SAVED} AS saved
       FROM events e JOIN videos v ON v.id = e.video_id
      WHERE e.event_type = 'scroll_away'
      ORDER BY e.session_id, e.client_ts`,
  );
}

/** Flat event stream for high-resolution EEG alignment/debugging. */
export function eegJoinEvents(db: Db): Promise<Row[]> {
  return all(
    db,
    `SELECT e.id AS event_id,
            e.session_id AS session_id,
            e.participant_id AS participant_id,
            ${EEG_SYNC} AS eeg_sync_id,
            ${EXPOSURE} AS exposure_id,
            e.video_id AS video_id,
            v.slug AS slug,
            v.content_type AS content_type,
            e.event_type AS event_type,
            e.feed_position AS feed_position,
            e.client_ts AS client_ts,
            e.server_ts AS server_ts,
            ${CLIENT_EPOCH} AS client_epoch_ms,
            ${SESSION_ELAPSED} AS session_elapsed_ms,
            json_extract(e.payload,'$.positionMs') AS position_ms,
            json_extract(e.payload,'$.dwellMs') AS dwell_ms,
            ${WATCH} AS watch_ms,
            ${PCT} AS pct_watched,
            ${LOOPS} AS loops,
            e.payload AS payload
       FROM events e LEFT JOIN videos v ON v.id = e.video_id
      ORDER BY e.session_id, e.client_ts`,
  );
}

/** Top-line totals across all engagement, for the dashboard header. */
export async function overall(db: Db): Promise<Row> {
  const r = await db
    .prepare(
      `SELECT COUNT(*)                          AS views,
              COUNT(DISTINCT e.participant_id)  AS participants,
              ROUND(AVG(${DWELL}) / 1000.0, 2)  AS avg_dwell_s,
              ROUND(AVG(${WATCH}) / 1000.0, 2)  AS avg_watch_s,
              ROUND(100.0 * AVG(${COMPLETE}), 1) AS completion_pct
         FROM events e
        WHERE e.event_type = 'scroll_away'`,
    )
    .first<Row>();
  return r ?? { views: 0, participants: 0, avg_dwell_s: 0, avg_watch_s: 0, completion_pct: 0 };
}

/** Everything the dashboard's metrics view needs, in one round of queries. */
export async function computeMetrics(db: Db) {
  const [total, contentType, curve, videos] = await Promise.all([
    overall(db),
    byContentType(db),
    retentionCurve(db),
    byVideo(db),
  ]);
  return {
    overall: total,
    byContentType: contentType,
    retentionCurve: curve,
    byVideo: videos,
  };
}

/** Derived tables exposed via CSV export, keyed by the `?table=` query param. */
export const DERIVED_EXPORTS: Record<string, (db: Db) => Promise<Row[]>> = {
  metrics_by_content: byContentType,
  metrics_by_video: byVideo,
  retention_curve: retentionCurve,
  per_video_participant: perVideoParticipant,
  per_exposure_participant: perExposureParticipant,
  eeg_join_events: eegJoinEvents,
};
