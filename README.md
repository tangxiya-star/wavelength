# FlowState Testing

> **Repo orientation (two lines on `main`).** This repository currently holds two parallel
> workstreams that share `main`:
> - **FlowState Expo app** (this README) — the shipped research app: `app/` · `components/` ·
>   `lib/` · `server/` · `scripts/` · `model/`.
> - **Original NeuroViral team scaffold** — `frontend/` (Holly's Next.js demo screens) ·
>   `contracts/` (shared schemas). The originally-planned `backend/` Python service shipped as
>   `server/` (TS API) + `model/` (pipeline) above.
>   See [§ Team scaffold](#team-scaffold-original-neuroviral-structure).

Internal research app for observing **retention and engagement across different kinds
of short-form media**. A Reels-style looping video feed gated behind an access code +
consent + demographics, running a silent timed session that captures rich interaction
analytics. Cross-platform via Expo (iOS / Android / web).

The sections below cover the product, stack, and architecture.

## Stack

- **Expo** (React Native + web), `expo-router`, `expo-video`
- **Local Node API server** ([`./server`](./server)) — Hono + SQLite (`better-sqlite3`) for
  analytics/forms + on-disk video. All local, no cloud. (Replaces the old Cloudflare
  Workers/D1/R2 backend.)
- Runs **fully in mock mode** until `EXPO_PUBLIC_API_BASE` is set

## Run it

```bash
npm install
npm run web      # fastest iteration in a browser
npm run ios      # iOS simulator (needs Xcode) or press 'i' from `npm start`
npm start        # dev server + QR code for Expo Go on a device
```

### Mock mode (default)

With no backend configured, the app self-serves:

- **Access codes:** `DEMO` / `FLOW30` (30 min), `FLOW05` (5 min), `QUICK2` (2 min)
- **Videos:** bundled colored countdown clips (1→4, three variations), generated locally
  by `scripts/gen-test-videos.py` and listed in `lib/catalog.ts`
- **Events:** logged to the console + buffered in AsyncStorage instead of POSTed

### With the local API server (persistence + admin dashboard)

To capture data to a real database, see an admin dashboard, and export CSVs, run
the local server ([`./server`](./server)) alongside Expo:

```bash
npm run server:install   # one-time: install the server's deps
npm run server           # http://localhost:8787  (leave running)
```

`.env.local` already points the app at `http://localhost:8787`, so just restart
Expo. Data lands in `server/data/flowstate.sqlite`; the dashboard is at
<http://localhost:8787/admin> (open — no login). See
[`server/README.md`](./server/README.md) for details and physical-device setup.

### Export data for post-analysis

```bash
npm run data:export        # writes one CSV per table to server/data/exports/
# point at a non-default API: API_BASE=http://10.38.7.176:8788 npm run data:export
```

Dumps the raw event stream (`events.csv`), the EEG-aligned event view
(`eeg_join_events.csv` — sync ids + timestamps as columns), per-participant
responses, and the derived metric tables. `server/data/` is gitignored, so the
exported participant/EEG data stays local. (The same files are also available as
download buttons in the dashboard.)

### Regenerate the test clips

```bash
python3 scripts/gen-test-videos.py   # needs python3 + Pillow and ffmpeg (libx264)
```
Writes `assets/videos/count_{a,b,c}.mp4` (vertical 1080×1920 H.264).

Use `QUICK2` to watch a session auto-end after 2 minutes.

### EEG content study workflow

The Instagram selection pipeline uses `scripts/ig-reels-scraper/ig-data/videos.csv`
as the source manifest.

```bash
npm run videos:select -- --download     # top 10 per creator + 20 random others
npm run videos:import                   # symlink selected MP4s into the local server catalog
VIDEOS_DIR="$PWD/server/data/stimulus-videos" npm run server
```

The importer adds local access codes `EEG30`, `EEG10`, and `EEG05`. The feed does
not show the withheld performance labels; public metrics stay in
`scripts/ig-reels-scraper/ig-data/selected-videos.csv` for post-study validation.

Every event now carries EEG join fields in its JSON payload:

- `eegSyncId` and `sessionId` — stable session join keys
- `clientEpochMs`, `clientTs`, `sessionElapsedMs` — align EEG timestamps in post
- `exposureId` / `activeExposureId` — one unique id per participant × video view
- `videoSlug`, `contentType`, `feedPosition`, dwell/watch/progress fields

After a session, export:

```bash
curl -H "Authorization: Bearer dev-admin-token" \
  "http://localhost:8787/api/admin/export?table=eeg_join_events" \
  -o eeg_join_events.csv

curl -H "Authorization: Bearer dev-admin-token" \
  "http://localhost:8787/api/admin/export?table=per_exposure_participant" \
  -o per_exposure_participant.csv
```

Offline video features can be generated locally:

```bash
npm run videos:analyze
```

This writes `scripts/ig-reels-scraper/ig-data/video-analysis/analysis-summary.csv`,
per-video `features.json`, and MoviePalette-style palette PNGs. It uses
`ffmpeg`/`ffprobe`, optional `tesseract` OCR, and optional Whisper CLI if later
run with `--transcribe`.

## Project layout

```
app/                 expo-router screens
  index.tsx          access code
  consent.tsx        research consent (18+)
  demographics.tsx   demographics form
  feed.tsx           the paged video viewer
  complete.tsx       session summary
components/
  VideoFeedItem.tsx  one looping video + analytics lifecycle
  ActionRail.tsx     thumbs up/down · save · options
  OptionsSheet.tsx   video-metadata sheet (§3.6)
lib/
  session.tsx        session state machine + silent timer
  events.ts          buffered/batched analytics logger
  api.ts             API-server client (mock fallback)
  catalog.ts         placeholder catalog + seeded shuffle
  types.ts  theme.ts
server/              local Node API server (Hono + SQLite + on-disk video)
  src/app.ts         routes (validate/session/playlist/events/export + /admin)
  src/db.ts          SQLite store with a D1-compatible surface
  src/metrics.ts     derived retention/engagement metrics
  schema.sql seed.sql
```

## What's stubbed vs. real

| Piece | Status |
|---|---|
| 5-screen flow, gating, consent, demographics | ✅ built |
| Paged looping feed, action rail, options sheet | ✅ built |
| Analytics event capture (all of SPEC §5.1) | ✅ built (logs locally in mock mode) |
| Silent session timer + background end | ✅ built |
| Local API server + SQLite + admin dashboard + CSV export | ✅ built (`./server`) |
| Real pilot videos | ✅ selected Instagram stimulus importer (`npm run videos:import`) |

## Next steps to TestFlight

1. Run the local API server (`npm run server`) — already wired via `EXPO_PUBLIC_API_BASE`.
2. Add real clips to `assets/videos/`, list them in `server/seed.sql` (and `lib/catalog.ts`
   for mock mode). For a device build, host the server on a reachable URL (or your LAN IP).
3. Apple Developer Program → `npx eas build -p ios` → `npx eas submit`.

---

## Team scaffold (original NeuroViral structure)

The original team layout still lives on `main` alongside the FlowState app. **NeuroViral** —
*wear an EEG, watch short-form videos, and let your own brain tell you which ones will go
viral before you spend on ads* (YC Growth Hackathon).

```
contracts/    SHARED interface (§6 schema) + mocks. Lock once; changing it = ping the other.
frontend/     HOLLY — Next.js 3-screen app (live/log/report) + components + lib + color script.
server/       DEVAN — TS API (sessions, metrics, shuffle, admin). The original plan's Python
model/        DEVAN — content → EEG-interest → virality pipeline.   `backend/` shipped as these.
```

**Merge discipline:** Holly edits `frontend/`, Devan edits `server/` + `model/`, both agree on
`contracts/` once. Work on separate branches (`holly-frontend`, `devan-backend`) → PR into `main`.

- Frontend: [`frontend/README.md`](./frontend/README.md) — runs on mocks with zero backend.
- API / model: [`server/README.md`](./server/README.md) · Interface: [`contracts/README.md`](./contracts/README.md).

**Team:** Holly (front-end / 3 screens) · Devan (model + backend) · Yuva (pitch / founder).
