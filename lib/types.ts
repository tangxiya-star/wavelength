// Shared types for the Testing app.
// Mirrors the SQLite schema in server/schema.sql.

export type Platform = 'ios' | 'android' | 'web';

export interface AccessCodeInfo {
  code: string;
  sessionMinutes: number;
  condition: string | null;
}

export interface Demographics {
  ageBand: string;
  sexAtBirth: string;
  genderIdentity: string;
  dailyShortformUse: string;
  consent18Plus: boolean;
}

export interface Video {
  id: string;
  slug: string;
  title: string;
  /** Remote URL (real mode, from R2) or a bundled require()/import (mock mode). */
  source: string | number;
  durationSeconds: number;
  /** The "kind of media" comparison dimension (SPEC §5.2). */
  contentType: string;
  /** Server-pinned prefix: rendered first, in exact server order (not shuffled/spaced). */
  pinned?: boolean;
}

/** A started, timed viewing session. */
export interface SessionRecord {
  id: string;
  participantId: string;
  accessCode: string;
  condition: string | null;
  playlistSeed: string;
  eegSyncId: string;
  startedAt: number; // epoch ms (wall-clock)
  startedAtMono: number; // monotonic ms (performance.now) at session start — EEG sync anchor
  endsAt: number; // epoch ms
}

export type EndReason = 'timeout' | 'manual' | 'background';

// ---- Analytics events (SPEC §5.1) ----

export type EventType =
  | 'session_start'
  | 'session_end'
  | 'video_impression'
  | 'video_play_start'
  | 'video_watch_progress'
  | 'video_loop'
  | 'video_exposure_end'
  | 'scroll_away'
  | 'thumbs_up'
  | 'thumbs_up_removed'
  | 'thumbs_down'
  | 'thumbs_down_removed'
  | 'save'
  | 'unsave'
  | 'options_open'
  | 'pause'
  | 'resume'
  | 'seek'
  | 'mute_toggle'
  | 'feed_recycled'
  | 'feedback_prompt'
  | 'feedback_response'
  | 'app_background'
  | 'app_foreground';

export interface AnalyticsEvent {
  id: string; // client UUID (idempotency)
  sessionId: string | null;
  participantId: string | null;
  videoId: string | null;
  eventType: EventType;
  feedPosition: number | null;
  clientTs: string; // ISO 8601
  payload: Record<string, unknown>;
}
