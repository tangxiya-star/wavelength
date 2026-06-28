"use client";
// /monitor — the LIVE EEG demo platform. Streams the raw headset signal from the
// recorder (hardware/capture/record.py → /api/eeg-live proxy) and draws it as a
// rolling waveform in the same display language as /replay and /waveform.
//
// This is distinct from /live (Holly's content→EEG model-prediction demo). Here
// the line is a real person's brain on stage. Start the recorder first:
//   cd hardware/capture && ./.venv/bin/python record.py \
//        --eeg-sync-id live-demo --synthetic --port 8090
// (drop --synthetic for the real Ganglion). The page auto-reconnects.
import { useEffect, useState } from "react";
import LiveWaveform from "@/components/LiveWaveform";
import { subscribeLiveEeg, type ConnState, type LiveSnapshot } from "@/lib/live-eeg";

type Badge = { label: string; color: string; pulse: boolean };

function statusBadge(conn: ConnState, snap: LiveSnapshot | null): Badge {
  if (conn === "offline") return { label: "OFFLINE", color: "#ef4444", pulse: false };
  if (conn === "connecting" || !snap) return { label: "CONNECTING", color: "#f59e0b", pulse: true };
  switch (snap.stream_status) {
    case "streaming":
    case "recovered":
      return { label: "LIVE", color: "#22c55e", pulse: true };
    case "reconnecting":
      return { label: "RECONNECTING", color: "#f59e0b", pulse: true };
    case "failed":
      return { label: "STREAM FAILED", color: "#ef4444", pulse: false };
    default:
      return { label: "CONNECTING", color: "#f59e0b", pulse: true };
  }
}

function qualityColor(q: number) {
  if (q >= 0.6) return "#22c55e";
  if (q >= 0.3) return "#f59e0b";
  return "#ef4444";
}

function Readout({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-[0.22em] text-neutral-500">{label}</div>
      <div className="text-2xl font-medium tabular-nums text-neutral-100">{value}</div>
      {sub ? <div className="text-[11px] tabular-nums text-neutral-500">{sub}</div> : null}
    </div>
  );
}

export default function MonitorPage() {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");

  useEffect(() => subscribeLiveEeg(setSnap, setConn), []);

  const live = conn === "live";
  const tick = snap?.tick;
  const interest = tick?.interest ?? 0;
  const badge = statusBadge(conn, snap);
  const recording = live && (snap?.samples_written ?? 0) > 0;
  const degraded = live && tick && tick.window_ok === false;
  const channels = tick
    ? [tick.quality.ch1, tick.quality.ch2, tick.quality.ch3, tick.quality.ch4]
    : [0, 0, 0, 0];

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-black px-8">
      {/* header */}
      <div className="flex w-full max-w-[1600px] items-end justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${badge.pulse ? "rec-dot" : ""}`}
              style={{ backgroundColor: badge.color }}
            />
            <span className="text-[13px] font-semibold uppercase tracking-[0.28em] text-neutral-200">
              {badge.label}
            </span>
            {recording ? (
              <span className="ml-3 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.2em] text-red-400">
                <span className="rec-dot inline-block h-1.5 w-1.5 rounded-full bg-red-500" /> rec
              </span>
            ) : null}
          </div>
          <div className="mt-2 text-2xl font-medium tracking-tight text-neutral-100">
            Live EEG monitor
          </div>
          <div className="text-[11px] uppercase tracking-[0.24em] text-neutral-500">
            theta / beta · forehead · 4ch · 200 Hz
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-[0.22em] text-neutral-500">session</div>
          <div className="text-sm tabular-nums text-neutral-300">
            {snap?.eeg_sync_id || "—"}
          </div>
        </div>
      </div>

      {/* hero waveform */}
      <div className="relative w-full max-w-[1600px]">
        <LiveWaveform value={interest} live={live} />
        {!live ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="max-w-xl rounded-xl border border-neutral-800 bg-black/85 p-6 text-center backdrop-blur">
              <div className="text-sm font-medium text-neutral-200">EEG recorder offline</div>
              <p className="mt-2 text-[13px] leading-relaxed text-neutral-400">
                Start the capture server, then this page reconnects on its own.
              </p>
              <pre className="mt-3 overflow-x-auto rounded-lg bg-neutral-900 px-3 py-2 text-left text-[11px] leading-relaxed text-neutral-300">
{`cd hardware/capture
./.venv/bin/python record.py \\
  --eeg-sync-id live-demo --synthetic --port 8090`}
              </pre>
              <p className="mt-2 text-[11px] text-neutral-600">
                drop <code className="text-neutral-400">--synthetic</code> for the real Ganglion ·
                override the source with <code className="text-neutral-400">EEG_STREAM_URL</code>
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {/* readouts */}
      <div className="flex w-full max-w-[1600px] items-end justify-between gap-8">
        <div className="flex items-end gap-12">
          <Readout label="interest" value={live ? interest.toFixed(2) : "—"} sub="0–1 attention" />
          <Readout label="θ / β ratio" value={live && tick ? tick.ratio.toFixed(2) : "—"} />
          <Readout
            label="link rate"
            value={live && snap ? `${snap.health.effective_hz.toFixed(0)}` : "—"}
            sub={live && snap ? `/ ${snap.health.expected_hz} Hz` : "Hz"}
          />
          <Readout
            label="samples"
            value={live && snap ? snap.samples_written.toLocaleString() : "—"}
            sub={degraded ? "⚠ window degraded" : undefined}
          />
        </div>

        {/* per-channel contact quality */}
        <div className="flex items-end gap-3">
          <div className="mr-1 text-[10px] uppercase tracking-[0.22em] text-neutral-500">contact</div>
          {channels.map((q, i) => (
            <div key={i} className="flex flex-col items-center gap-1.5">
              <div className="flex h-10 w-2.5 items-end overflow-hidden rounded-sm bg-neutral-900">
                <div
                  className="w-full rounded-sm transition-[height] duration-200"
                  style={{ height: `${Math.round(clamp01(q) * 100)}%`, backgroundColor: qualityColor(q) }}
                />
              </div>
              <div className="text-[9px] tabular-nums text-neutral-600">{i + 1}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}
