// Session state machine + silent timer (SPEC §2, §4, §8).
//
// Holds the participant/session lifecycle: access code -> consent -> demographics
// -> active timed session -> ended. The countdown runs here silently (never
// rendered) and ends the session on timeout or a long background. Navigation
// stays in the screens, which react to `status`.

import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import * as Device from 'expo-device';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import { api } from './api';
import { TIME_ORIGIN, monoNow } from './clock';
import { events } from './events';
import type { AccessCodeInfo, Demographics, EndReason, Platform as AppPlatform, SessionRecord } from './types';

type Status = 'idle' | 'active' | 'ended';

interface Summary {
  videosViewed: number;
  elapsedMs: number;
  likes: number;
  dislikes: number;
  saves: number;
}

type InteractionKind = 'like' | 'dislike' | 'save';

interface SessionContextValue {
  status: Status;
  accessCode: AccessCodeInfo | null;
  consented: boolean;
  session: SessionRecord | null;
  endReason: EndReason | null;
  summary: Summary | null;
  setAccessCode: (info: AccessCodeInfo) => void;
  setConsent: (value: boolean) => void;
  beginSession: (demographics: Demographics, codeInfo?: AccessCodeInfo) => Promise<boolean>;
  markVideoViewed: (videoId: string) => void;
  recordInteraction: (kind: InteractionKind) => void;
  endSession: (reason: EndReason) => void;
  reset: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function appPlatform(): AppPlatform {
  return Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('idle');
  const [accessCode, setAccessCodeState] = useState<AccessCodeInfo | null>(null);
  const [consented, setConsented] = useState(false);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [endReason, setEndReason] = useState<EndReason | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  const sessionRef = useRef<SessionRecord | null>(null);
  const statusRef = useRef<Status>('idle');
  const viewedRef = useRef<Set<string>>(new Set());
  const interactionsRef = useRef({ likes: 0, dislikes: 0, saves: 0 });
  const bgSinceRef = useRef<number | null>(null);

  sessionRef.current = session;
  statusRef.current = status;

  useEffect(() => {
    void events.init();
  }, []);

  const endSession = useCallback((reason: EndReason) => {
    if (statusRef.current !== 'active') return;
    const s = sessionRef.current;
    statusRef.current = 'ended';
    const elapsedMs = s ? Date.now() - s.startedAt : 0;
    events.log('session_end', { endReason, elapsedMs });
    void events.flush();
    if (s) void api.endSession({ sessionId: s.id, endReason: reason });
    setSummary({
      videosViewed: viewedRef.current.size,
      elapsedMs,
      likes: interactionsRef.current.likes,
      dislikes: interactionsRef.current.dislikes,
      saves: interactionsRef.current.saves,
    });
    setEndReason(reason);
    setStatus('ended');
  }, []);

  // Background/foreground analytics only, while active. The feed runs endlessly:
  // the session ends *only* when the user ends it (manual end in the options
  // sheet) — there is no silent timeout and no background auto-end.
  useEffect(() => {
    if (status !== 'active') return;

    const onAppState = (next: AppStateStatus) => {
      if (statusRef.current !== 'active') return;
      if (next === 'background' || next === 'inactive') {
        if (bgSinceRef.current === null) {
          bgSinceRef.current = Date.now();
          events.log('app_background', {});
          void events.flush();
        }
      } else if (next === 'active') {
        const since = bgSinceRef.current;
        bgSinceRef.current = null;
        if (since !== null) {
          const awayMs = Date.now() - since;
          events.log('app_foreground', { awayMs });
        }
      }
    };

    const sub = AppState.addEventListener('change', onAppState);
    return () => sub.remove();
  }, [status]);

  const setAccessCode = useCallback((info: AccessCodeInfo) => setAccessCodeState(info), []);
  const setConsent = useCallback((value: boolean) => setConsented(value), []);

  const beginSession = useCallback(
    async (demographics: Demographics, codeInfo?: AccessCodeInfo): Promise<boolean> => {
      // Accept the code directly so a caller can validate + begin in one tick,
      // before setAccessCode's state update has propagated into this closure.
      const code = codeInfo ?? accessCode;
      if (!code) return false;
      const participantId = randomUUID();
      const playlistSeed = randomUUID();
      const eegSyncId = randomUUID();
      const clientSessionStartedAt = Date.now();
      const clientSessionStartedAtMono = monoNow(); // monotonic anchor for EEG sync
      try {
        const res = await api.startSession({
          code: code.code,
          participantId,
          platform: appPlatform(),
          appVersion: Constants.expoConfig?.version ?? '1.0.0',
          sessionMinutes: code.sessionMinutes,
          condition: code.condition,
          playlistSeed,
          device: {
            brand: Device.brand,
            modelName: Device.modelName,
            deviceName: Device.deviceName,
            osName: Device.osName,
            osVersion: Device.osVersion,
            deviceType: Device.deviceType,
          },
        });
        const record: SessionRecord = {
          id: res.sessionId,
          participantId: res.participantId,
          accessCode: code.code,
          condition: code.condition,
          playlistSeed,
          eegSyncId,
          startedAt: clientSessionStartedAt,
          startedAtMono: clientSessionStartedAtMono,
          endsAt: res.endsAt,
        };
        events.configureSession(record);
        await api.submitDemographics({ participantId: record.participantId, demographics });
        viewedRef.current = new Set();
        interactionsRef.current = { likes: 0, dislikes: 0, saves: 0 };
        setSession(record);
        sessionRef.current = record;
        events.log('session_start', {
          sessionMinutes: code.sessionMinutes,
          condition: code.condition,
          playlistSeed,
          eegSyncId,
          clientSessionStartedAt,
          clientSessionStartedAtIso: new Date(clientSessionStartedAt).toISOString(),
          clientSessionStartedAtMono,
          timeOrigin: TIME_ORIGIN, // wall-clock epoch of the monotonic origin → maps monoMs to absolute time
          postStudyJoinKey: `${record.id}:${eegSyncId}`,
        });
        setStatus('active');
        return true;
      } catch (err) {
        console.warn('beginSession failed', err);
        return false;
      }
    },
    [accessCode],
  );

  const markVideoViewed = useCallback((videoId: string) => {
    viewedRef.current.add(videoId);
  }, []);

  const recordInteraction = useCallback((kind: InteractionKind) => {
    if (kind === 'like') interactionsRef.current.likes += 1;
    else if (kind === 'dislike') interactionsRef.current.dislikes += 1;
    else interactionsRef.current.saves += 1;
  }, []);

  const reset = useCallback(() => {
    setAccessCodeState(null);
    setConsented(false);
    setSession(null);
    setEndReason(null);
    setSummary(null);
    setStatus('idle');
    viewedRef.current = new Set();
    interactionsRef.current = { likes: 0, dislikes: 0, saves: 0 };
    bgSinceRef.current = null;
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      accessCode,
      consented,
      session,
      endReason,
      summary,
      setAccessCode,
      setConsent,
      beginSession,
      markVideoViewed,
      recordInteraction,
      endSession,
      reset,
    }),
    [status, accessCode, consented, session, endReason, summary, setAccessCode, setConsent, beginSession, markVideoViewed, recordInteraction, endSession, reset],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within <SessionProvider>');
  return ctx;
}
