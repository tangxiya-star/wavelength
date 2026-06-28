# Wavelength

> Wear an EEG, watch short-form videos, and let your own brain tell you which ones will go viral — before you spend a cent on ads.

### 🎥 Demo

**[▶ Watch the 60s demo](REPLACE_WITH_DEMO_VIDEO_URL)** · **[🌐 Live app](REPLACE_WITH_LIVE_URL)**

<!-- TODO: paste a YouTube/Loom link + a deployed URL above. Judges won't clone — this is the single highest-value line in the README. -->

## The Problem

Advertisers and creators have **no way to know if content will land before they spend on it** — they ship, wait, and read the analytics after the money is gone. Wavelength reads engagement *directly off your brain*: a rising theta/beta ratio = rising interest. Watch clips with an EEG on, and we tell you which ones will go viral — and *why* — before launch.

## Screenshots

| EEG waveform | Video feed | Report |
|:---:|:---:|:---:|
| ![EEG waveform](docs/screenshots/eeg-waveform.png) | ![Video feed](docs/screenshots/feed.png) | ![Report](docs/screenshots/report.png) |

<!-- TODO: drop the three images into docs/screenshots/ with these exact filenames.
     Neuro projects live or die on "show me the waveform" — these matter as much as the demo. -->

## Tech Stack

| Layer | Tech |
|---|---|
| **Mobile app** | Expo (React Native + Web), `expo-router`, `expo-video`, TypeScript |
| **Web app** | Next.js 14, React 18, Tailwind CSS |
| **API server** | Hono + SQLite (`better-sqlite3`), runs fully local |
| **ML / model** | Python · PyTorch · scikit-learn · SigLIP (image) + CLAP (audio) embeddings · OpenCV |
| **Signal** | Synthetic + live EEG (theta/beta interest curves), per-exposure event join keys |

## Sponsor Tracks

| Sponsor | How we use it |
|---|---|
| **OpenAI** | Neuro-marketing "decode" chat — streams a plain-language explanation of *why* a clip spiked interest from its characteristics + EEG curve (`frontend/lib/openai.ts`). |
| **Anthropic / Claude** | AI-UGC retention judge — scores sponsor/product ads with *"does this ad retain?"* against the locked stimulus set (`model/run_sponsor_report.py`). |
| **Orange Slice** | GTM integration — turns an EEG interest spike into a go-to-market brief (hooks + target persona) and stores it as a reusable Orange Slice skill (`scripts/orangeslice/gtm.mjs`). |

## Structure

```
wavelength/
│
├── app/              Expo mobile app — gated Reels-style feed
│   ├── index.tsx       access code → consent → demographics
│   ├── feed.tsx        paged looping video viewer
│   └── complete.tsx    silent-timed session summary
│
├── components/       VideoFeedItem · ActionRail · OptionsSheet
├── lib/              session state machine · buffered event logger · API client
│
├── frontend/         Next.js web demo (live / log / report screens)
│   ├── app/            live-eeg · waveform · replay · report routes
│   ├── components/     waveforms · movie-barcode · GTM panel
│   └── lib/            OpenAI decode · predict · EEG types
│
├── server/           local Node API (Hono + SQLite)
│   └── src/            routes · D1-compatible store · derived metrics + /admin
│
├── model/            content → EEG-interest → virality pipeline
│   ├── extract_*      SigLIP/CLAP embeddings + video features
│   ├── train_*        interest / retention / virality models
│   └── run_sponsor_report.py   Claude AI-UGC retention judge
│
├── contracts/        shared schemas (EEG sample + video) + mocks
└── scripts/          IG stimulus scraper · video analysis · Orange Slice GTM
```

## Run it

```bash
npm install
npm run web        # browser (fastest iteration)
npm run ios        # iOS simulator
npm run server     # local API + SQLite + admin dashboard (http://localhost:8787)
```

Runs **fully in mock mode** (local access codes `DEMO` / `QUICK2`, bundled sample clips) until `EXPO_PUBLIC_API_BASE` is set.

---

**Team:** Holly (frontend) · Devan (model + backend) · Yuva (pitch) — *YC Growth Hackathon*
