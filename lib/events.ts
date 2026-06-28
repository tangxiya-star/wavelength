// Buffered, batched analytics logger (SPEC §5).
//
// Events are queued in memory, persisted to AsyncStorage (so a crash or offline
// period never loses data), and flushed to the Worker in batches: on an interval,
// when the queue passes a threshold, and on demand (scroll / background / session
// end). Each event carries a client UUID for idempotency.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { api } from './api';
import { TIME_ORIGIN, monoNow } from './clock';
import type { AnalyticsEvent, EventType, SessionRecord } from './types';

const STORAGE_KEY = 'fs.events.queue';
const FLUSH_INTERVAL_MS = 5_000; // push to the cloud frequently for near-real-time
const BATCH_THRESHOLD = 5; // ...or after just a few events, whichever comes first

class EventLogger {
  private queue: AnalyticsEvent[] = [];
  private sessionId: string | null = null;
  private participantId: string | null = null;
  private sessionStartedAt: number | null = null;
  private sessionStartedAtMono: number | null = null;
  private sessionStartedAtIso: string | null = null;
  private eegSyncId: string | null = null;
  private activeVideoId: string | null = null;
  private activeFeedPosition: number | null = null;
  private activeExposureId: string | null = null;
  private activeVideoStartedAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  /** Load any events persisted from a previous run and start the flush loop. */
  async init(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) this.queue = JSON.parse(raw) as AnalyticsEvent[];
    } catch {
      // ignore corrupt cache
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
    void this.flush();
  }

  configureSession(session: SessionRecord): void {
    this.sessionId = session.id;
    this.participantId = session.participantId;
    this.sessionStartedAt = session.startedAt;
    this.sessionStartedAtMono = session.startedAtMono;
    this.sessionStartedAtIso = new Date(session.startedAt).toISOString();
    this.eegSyncId = session.eegSyncId;
  }

  setActiveVideo(videoId: string | null, feedPosition: number | null, exposureId?: string | null): void {
    const changedVideo = videoId !== this.activeVideoId || feedPosition !== this.activeFeedPosition;
    this.activeVideoId = videoId;
    this.activeFeedPosition = feedPosition;
    if (exposureId !== undefined) {
      this.activeExposureId = exposureId;
      this.activeVideoStartedAt = exposureId ? Date.now() : null;
    } else if (changedVideo) {
      this.activeExposureId = null;
      this.activeVideoStartedAt = null;
    }
  }

  log(eventType: EventType, payload: Record<string, unknown> = {}, videoIdOverride?: string): void {
    const now = Date.now();
    const mono = monoNow(); // high-res monotonic ms — the EEG-sync reference clock
    const activeVideoElapsedMs = this.activeVideoStartedAt ? now - this.activeVideoStartedAt : null;
    const payloadFeedPosition = typeof payload.feedPosition === 'number' ? payload.feedPosition : null;
    const payloadExposureId = typeof payload.exposureId === 'string' ? payload.exposureId : null;
    const event: AnalyticsEvent = {
      id: randomUUID(),
      sessionId: this.sessionId,
      participantId: this.participantId,
      videoId: videoIdOverride ?? this.activeVideoId,
      eventType,
      feedPosition: payloadFeedPosition ?? this.activeFeedPosition,
      clientTs: new Date().toISOString(),
      payload: {
        ...payload,
        clientEpochMs: now,
        // EEG-sync timestamps: monotonic (sub-ms, NTP-immune) + absolute wall-clock
        // derived from it. sessionElapsedMonoMs is the precise within-session time.
        clientMonoMs: mono,
        clientPerfEpochMs: TIME_ORIGIN + mono,
        sessionElapsedMonoMs: this.sessionStartedAtMono != null ? mono - this.sessionStartedAtMono : null,
        clientTimezoneOffsetMin: new Date().getTimezoneOffset(),
        sessionElapsedMs: this.sessionStartedAt ? now - this.sessionStartedAt : null,
        sessionStartedAtIso: this.sessionStartedAtIso,
        eegSyncId: this.eegSyncId,
        activeExposureId: payloadExposureId ?? this.activeExposureId,
        activeVideoElapsedMs,
      },
    };
    this.queue.push(event);
    void this.persist();
    if (this.queue.length >= BATCH_THRESHOLD) void this.flush();
  }

  /** Send everything currently queued; on failure leave it queued for retry. */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.slice();
    try {
      await api.sendEvents(batch);
      // Drop the events we just sent (queue may have grown meanwhile).
      this.queue = this.queue.slice(batch.length);
      await this.persist();
    } catch {
      // keep queued; will retry on next interval
    } finally {
      this.flushing = false;
    }
  }

  private async persist(): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.queue));
    } catch {
      // best-effort
    }
  }
}

export const events = new EventLogger();
