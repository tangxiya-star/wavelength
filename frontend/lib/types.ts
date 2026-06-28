// Mirror of /contracts. Keep in sync with contracts/*.schema.json.
// This is the Holly <-> Devan interface — see prd-holly.md §3.

/** One video payload from Devan's Cloudflare API.
 *  NOTE: color_profile is NOT here — Holly extracts it client-side, keyed by video_id. */
export interface Video {
  video_id: string;
  url: string;
  characteristics: {
    audio: string; // "music" | "VO" | "music+VO"
    transcript_summary: string; // 1-3 lines incl. a short title
    cut_count: number;
    on_screen_text: string;
    subtitles?: boolean;
  };
  metadata: {
    duration_ms: number;
    created_at?: string;
    creator: string;
    likes?: number;
    shares?: number;
  };
}

/** One EEG sample from Devan's Python WebSocket, aligned to the playing clip. */
export interface EegSample {
  session_id: string;
  video_id: string;
  video_t_ms: number; // waveform x-axis
  theta_beta: number;
  interest_score: number; // 0-1, the REAL measured attention (waveform y-axis)
  predict_score?: number; // 0-1, model-predicted attention (overlaid "predict" layer)
}

/** Holly's own client-side extraction (NOT from Devan), keyed by video_id. */
export type ColorProfiles = Record<string, string[]>; // video_id -> hex[]
