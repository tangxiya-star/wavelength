# contracts/ — the Holly ↔ Devan interface (source of truth)

This is the **only** place both sides depend on. Lock it once, then build in parallel.
The schemas and mocks in this folder are the source of truth.

| File | What | Producer → Consumer |
| --- | --- | --- |
| `video.schema.json` | One video payload (MP4 url + characteristics + metadata) | Devan (Cloudflare API) → Holly (front-end) |
| `eeg-sample.schema.json` | One EEG sample, aligned to the clip timeline | Devan (Python WebSocket) → Holly (waveform) |
| `mocks/videos.json` | Sample `GET /api/videos` response — **build against this** | shared |
| `mocks/eeg-sample.jsonl` | Recorded EEG stream (one JSON per line) — replay it | shared |

**Rules**
- `color_profile` is **NOT** in `video.schema.json` — Holly extracts it client-side, keyed by `video_id`.
- Changing a schema = ping the other person. This file changing is the only thing that can break both sides.
- Frontend mirrors these types in `frontend/lib/types.ts`. Keep them in sync.
