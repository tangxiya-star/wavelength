// GET /api/eeg-live — same-origin proxy for the EEG recorder's live SSE feed.
//
// The recorder (hardware/capture/record.py) serves Server-Sent Events at
// http://localhost:8090/stream but sets NO CORS headers, so the browser can't
// open an EventSource straight to it. This route fetches that upstream stream
// and pipes it through same-origin, so /monitor's EventSource("/api/eeg-live")
// just works. Point it at a different recorder with EEG_STREAM_URL.
//
// When the recorder is down the upstream fetch throws (or returns non-200); we
// answer 503 so the client's EventSource errors out, shows "recorder offline",
// and retries. The recorder emits the FULL snapshot per tick (see
// LiveSnapshot in lib/live-eeg.ts), not just the `tick` field.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = process.env.EEG_STREAM_URL || "http://localhost:8090/stream";

function offline(status: number, detail: unknown) {
  return new Response(JSON.stringify({ error: "eeg recorder offline", upstream: UPSTREAM, detail }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function GET(req: Request) {
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      headers: { Accept: "text/event-stream" },
      // abort the upstream stream when the browser closes the EventSource
      signal: req.signal,
      cache: "no-store",
    });
  } catch (err) {
    return offline(503, String(err));
  }

  if (!upstream.ok || !upstream.body) {
    return offline(503, { status: upstream.status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // disable proxy buffering so ticks arrive in real time
      "X-Accel-Buffering": "no",
    },
  });
}
