// Client subscription to the LIVE EEG recorder feed (hardware/capture/record.py),
// proxied same-origin through /api/eeg-live. This is the raw headset signal — a
// different thing from lib/ws.ts's subscribeEeg (the per-clip model prediction
// for Holly's /live demo). Used by the /monitor live demo page.
//
// The recorder pushes the FULL state snapshot ~10 Hz (every 100 ms) as one SSE
// `data:` frame. Shape mirrors LiveState.snapshot() in record.py.

export type StreamStatus =
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "recovered"
  | "failed";

/** Latest computed tick. `interest` is the smoothed adaptive 0-1 attention
 *  readout (the waveform y-axis); `ratio` is the raw theta/beta. */
export interface LiveTick {
  ts: number | null;
  interest: number;
  ratio: number;
  theta: number;
  beta: number;
  quality: { ch1: number; ch2: number; ch3: number; ch4: number };
  window_ok: boolean;
}

/** Read-only link-quality (drives the degraded/greyed states). */
export interface LiveHealth {
  effective_hz: number;
  expected_hz: number;
  dropped_packets: number;
  drop_rate: number;
  packet_id_mode: number | null;
  window_span_s: number | null;
  window_ok: boolean;
  recoveries: number;
}

export interface LiveSnapshot {
  connected: boolean;
  stream_status: StreamStatus;
  eeg_sync_id: string;
  recording_path: string;
  samples_written: number;
  started_at_unix_ms: number | null;
  tick: LiveTick;
  health: LiveHealth;
}

/** Our view of the pipe to the recorder (distinct from stream_status, which is
 *  the recorder's view of the BLE link). */
export type ConnState = "connecting" | "live" | "offline";

const ENDPOINT = "/api/eeg-live";
const RETRY_MS = 2500;

/** Subscribe to the live EEG snapshot stream. Calls `onSnapshot` per tick and
 *  `onConn` on connect/disconnect. Auto-reconnects while the recorder is down.
 *  Returns an unsubscribe fn. */
export function subscribeLiveEeg(
  onSnapshot: (snap: LiveSnapshot) => void,
  onConn?: (state: ConnState) => void,
): () => void {
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    onConn?.("connecting");
    es = new EventSource(ENDPOINT);

    es.onmessage = (ev) => {
      try {
        const snap = JSON.parse(ev.data) as LiveSnapshot;
        onConn?.("live");
        onSnapshot(snap);
      } catch (e) {
        console.warn("[live-eeg] bad frame", e);
      }
    };

    // 503 from the proxy (recorder down) or a dropped pipe both land here.
    es.onerror = () => {
      onConn?.("offline");
      es?.close();
      es = null;
      if (!closed && retry === null) {
        retry = setTimeout(() => {
          retry = null;
          connect();
        }, RETRY_MS);
      }
    };
  };

  connect();

  return () => {
    closed = true;
    if (retry !== null) clearTimeout(retry);
    es?.close();
  };
}
