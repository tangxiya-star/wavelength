"use client";
// Drop-in "real live EEG" waveform block for the /live-eeg demo. Self-contained:
// it owns the subscribeLiveEeg subscription (so the heavy host page doesn't
// re-render at the ~10 Hz tick rate) and renders the same rolling LiveWaveform
// used by /monitor, plus a LIVE status header and an interest / θβ readout.
// Unlike /live's predicted waveform, this streams the wearer's actual brain
// signal continuously while the recorder is up — independent of clip playback.
import { useEffect, useState } from "react";
import LiveWaveform from "@/components/LiveWaveform";
import { subscribeLiveEeg, type ConnState, type LiveSnapshot } from "@/lib/live-eeg";

export default function LiveEegWaveform({
  label = "live eeg · theta / beta",
  headerRight,
}: {
  label?: string;
  headerRight?: React.ReactNode;
}) {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");

  useEffect(() => subscribeLiveEeg(setSnap, setConn), []);

  const live = conn === "live";
  const tick = snap?.tick;
  const interest = tick?.interest ?? 0;
  const dotColor = live ? "#22c55e" : conn === "connecting" ? "#f59e0b" : "#ef4444";
  const statusText = live ? "live" : conn === "connecting" ? "connecting" : "offline";

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-neutral-500">
        <span className="flex items-center gap-2.5">
          <span
            className={`inline-block h-2 w-2 rounded-full ${live || conn === "connecting" ? "rec-dot" : ""}`}
            style={{ backgroundColor: dotColor }}
          />
          {label}
          <span className="normal-case tracking-normal text-neutral-600">
            {live ? (
              <span className="tabular-nums">
                interest {interest.toFixed(2)} · θ/β {tick ? tick.ratio.toFixed(2) : "—"}
              </span>
            ) : (
              statusText
            )}
          </span>
        </span>
        {headerRight ? <span>{headerRight}</span> : null}
      </div>

      <LiveWaveform value={interest} live={live} />

      {!live ? (
        <div className="mt-2 text-[11px] text-neutral-600">
          EEG recorder offline — start it on :8090 (the page auto-reconnects).
        </div>
      ) : null}
    </div>
  );
}
