# frontend/ — Holly's 3 demo screens

Next.js + TypeScript + Tailwind. Holly's 3 demo screens (live / log / report).

## Run
```bash
cd frontend
npm install
cp .env.local.example .env.local   # fill OpenAI key; leave API/WS unset to use mocks
npm run dev                         # http://localhost:3000 -> /live
```
With `NEXT_PUBLIC_VIDEO_API_BASE` / `NEXT_PUBLIC_EEG_WS_URL` unset, the app runs entirely on the
shared mocks in `../contracts/mocks` — so you can build before Devan's API/headset are ready.

## Layout
```
app/live    Screen 1 — video reel + live waveform + characteristics (the money shot)
app/log     Screen 2 — per-video cards + chat/decode (you own the chat API)
app/report  Screen 3 — top performers / what wins / who wins (precomputed)
components/  Waveform, ColorBar, CharacteristicsPanel, VideoCard
lib/         types (mirror of /contracts), api (videos), ws (EEG), openai (decode prompt)
scripts/     extract-color.mjs — your color_profile extraction -> public/color-profiles.json
```

## Contract with Devan
You only depend on [`../contracts`](../contracts). Don't edit `server/` or `model/`. Color profile is yours,
client-side, keyed by `video_id`.

## Priority
Screen 1 > Screen 2 > Screen 3. Auto-scale the waveform. No typing on stage.
