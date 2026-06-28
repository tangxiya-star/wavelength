// API client for the local API server (see ../server, SPEC §7).
//
// When EXPO_PUBLIC_API_BASE is unset the app runs in MOCK mode: access codes
// are validated locally, the playlist comes from the bundled catalog, and
// events are logged to the console + AsyncStorage instead of being POSTed.
// This lets the whole flow run end-to-end without a backend.

import { MOCK_CATALOG } from './catalog';
import type { AnalyticsEvent, Demographics, Platform, Video } from './types';

const BASE = process.env.EXPO_PUBLIC_API_BASE?.replace(/\/$/, '') ?? '';
export const IS_MOCK = BASE === '';

/** Admin dashboard URL (served by the API server at /admin). */
export const ADMIN_URL = `${BASE || 'http://localhost:8787'}/admin`;

// Mock access codes: code -> { sessionMinutes, condition }
const MOCK_CODES: Record<string, { sessionMinutes: number; condition: string | null }> = {
  DEMO: { sessionMinutes: 30, condition: null },
  FLOW30: { sessionMinutes: 30, condition: null },
  FLOW05: { sessionMinutes: 5, condition: null },
  QUICK2: { sessionMinutes: 2, condition: null },
};

export interface ValidateResult {
  ok: boolean;
  sessionMinutes: number;
  condition: string | null;
}

export interface StartSessionResult {
  sessionId: string;
  participantId: string;
  endsAt: number; // epoch ms
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  async validateCode(code: string): Promise<ValidateResult> {
    if (IS_MOCK) {
      const hit = MOCK_CODES[code.trim().toUpperCase()];
      return hit
        ? { ok: true, sessionMinutes: hit.sessionMinutes, condition: hit.condition }
        : { ok: false, sessionMinutes: 0, condition: null };
    }
    return post<ValidateResult>('/api/code/validate', { code });
  },

  async startSession(input: {
    code: string;
    participantId: string;
    platform: Platform;
    appVersion: string;
    sessionMinutes: number;
    condition: string | null;
    playlistSeed: string;
    device?: Record<string, unknown>;
  }): Promise<StartSessionResult> {
    if (IS_MOCK) {
      return {
        sessionId: `mock-sess-${input.participantId.slice(0, 8)}`,
        participantId: input.participantId,
        endsAt: Date.now() + input.sessionMinutes * 60_000,
      };
    }
    return post<StartSessionResult>('/api/session/start', input);
  },

  async submitDemographics(input: {
    participantId: string;
    demographics: Demographics;
  }): Promise<void> {
    if (IS_MOCK) {
      console.log('[mock] demographics', input.demographics);
      return;
    }
    await post('/api/demographics', input);
  },

  async getPlaylist(seed: string, _condition: string | null): Promise<Video[]> {
    if (IS_MOCK) {
      const { shuffleWithSeed } = await import('./catalog');
      return shuffleWithSeed(MOCK_CATALOG, seed);
    }
    const res = await fetch(`${BASE}/api/playlist?seed=${encodeURIComponent(seed)}`);
    if (!res.ok) throw new Error(`/api/playlist -> ${res.status}`);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    // Server stores the R2 URL in `url`; the client uses `source`.
    return rows.map((r) => ({ ...r, source: r.source ?? r.url })) as Video[];
  },

  async sendEvents(batch: AnalyticsEvent[]): Promise<void> {
    if (IS_MOCK) {
      console.log(`[mock] sendEvents (${batch.length})`, batch.map((e) => e.eventType).join(', '));
      return;
    }
    await post('/api/events', { events: batch });
  },

  async endSession(input: { sessionId: string; endReason: string }): Promise<void> {
    if (IS_MOCK) {
      console.log('[mock] endSession', input.endReason);
      return;
    }
    await post('/api/session/end', input);
  },
};
