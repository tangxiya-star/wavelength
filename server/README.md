# FlowState Testing — Local API Server

Local replacement for the old Cloudflare Worker (SPEC §6–§7). Same routes and
the same admin dashboard, but everything runs on your machine:

- **Node + Hono** (via `@hono/node-server`) instead of Workers
- **SQLite file** (`better-sqlite3`) at `data/flowstate.sqlite` instead of D1
- **`../assets/videos/`** on disk, streamed with HTTP Range support, instead of R2

No `wrangler`, no Cloudflare account, no deploy. On `localhost` it's effectively
instant.

## Run

```bash
cd server
npm install
npm run dev            # http://localhost:8787  (auto-reloads on change)
```

On first start it creates `data/flowstate.sqlite`, applies `schema.sql`, and
seeds the starter access codes + video catalog from `seed.sql`.

Point the app at it — `../.env.local` already contains:

```
EXPO_PUBLIC_API_BASE=http://localhost:8787
```

…then restart Expo. Use `npm start` (no watch) for a stable run.

> **Physical device?** `localhost` won't reach your laptop. The server binds to
> `0.0.0.0`, so set `EXPO_PUBLIC_API_BASE=http://<your-LAN-IP>:8787` (e.g.
> `http://192.168.1.20:8787`). iOS Simulator / web / Android emulator can use
> `localhost` as-is.

## Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/code/validate` | POST | Validate access code → `{ ok, sessionMinutes, condition }` |
| `/api/session/start` | POST | Create participant + session → `{ sessionId, participantId, endsAt }` |
| `/api/demographics` | POST | Store consent + demographics |
| `/api/playlist?seed=` | GET | Full pool, shuffled by seed (URLs point at `/video/:key`) |
| `/api/events` | POST | Batch-ingest events (`{ events: [...] }`) |
| `/api/session/end` | POST | Close a session with `endReason` |
| `/video/:key` | GET | Stream a clip from `../assets/videos/` (supports `Range`) |
| `/admin` | GET | Admin dashboard (open — no login) |
| `/api/admin/export?table=…` | GET | CSV export |

## Admin dashboard

Open <http://localhost:8787/admin>. It loads straight into the dashboard — there
is no username/password login (this is a local LAN testing tool).

## Export data from the CLI

```bash
curl "http://localhost:8787/api/admin/export?table=events" -o events.csv
curl "http://localhost:8787/api/admin/export?table=responses" -o responses.csv
```

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | bind address |
| `DB_PATH` | `./data/flowstate.sqlite` | SQLite file location |
| `VIDEOS_DIR` | `../assets/videos` | folder served at `/video/:key` |
| `ADMIN_TOKEN` | `dev-admin-token` | master token (kept for scripts; dashboard needs no login) |

## Reset

Delete the database and restart — it re-creates and re-seeds:

```bash
rm -rf data && npm run dev
```
