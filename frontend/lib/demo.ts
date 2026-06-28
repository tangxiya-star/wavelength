// Demo-only precomputed values for the Log + Report screens (the "scaled" story).
// Keyed by the mock video_ids in contracts/mocks/videos.json. Swap for real
// aggregates once the EEG pipeline is live.

export const demoInterest: Record<string, number> = {
  "11111111-1111-1111-1111-111111111111": 0.81,
  "22222222-2222-2222-2222-222222222222": 0.34,
  "33333333-3333-3333-3333-333333333333": 0.74,
};

export const demoNote: Record<string, string> = {
  "11111111-1111-1111-1111-111111111111":
    "Strong spike at the hook (0:02). Fast cuts + bold on-screen text sustained theta/beta.",
  "22222222-2222-2222-2222-222222222222":
    "Flat response. Slow intro, no hook in the first 3 seconds.",
  "33333333-3333-3333-3333-333333333333":
    "Punchy hook + captions throughout kept attention high until the CTA.",
};

// "Browse Clips": what the model learned from the current clip, plus clips it
// predicts will perform similarly. Demo data.
export const learnedTraits: string[] = [
  "relatable office-humor hook",
  "fast talking-head, eye contact",
  "burned-in captions throughout",
  "\"tag a coworker\" call-to-action",
];

export type RelatedClip = { title: string; creator: string; trait: string; score: number; thumb?: string; clip?: string };

// Real office-humor reels scraped across 3 accounts (thumbs in public/clips/related).
export const relatedClips: RelatedClip[] = [
  { title: "There's an “I” in “Team”…", creator: "@corporatenatalie", trait: "relatable hook", score: 0.86, thumb: "/clips/related/DSXZQd3jw7Q.jpg", clip: "/clips/related/DSXZQd3jw7Q.mp4" },
  { title: "Ep 3: Brandon gets a girlfriend", creator: "@cluely", trait: "talking-head skit", score: 0.83, thumb: "/clips/related/DO4WD7IkiHs.jpg", clip: "/clips/related/DO4WD7IkiHs.mp4" },
  { title: "The company is the womb we share", creator: "@corporate.bro", trait: "office-humor + captions", score: 0.81, thumb: "/clips/related/DGdNEU2RsEC.jpg", clip: "/clips/related/DGdNEU2RsEC.mp4" },
  { title: "Who else wants team tattoos?", creator: "@corporatenatalie", trait: "punchy CTA", score: 0.78, thumb: "/clips/related/DP81-k4kdiX.jpg", clip: "/clips/related/DP81-k4kdiX.mp4" },
  { title: "Ep 1 😭", creator: "@cluely", trait: "fast cuts", score: 0.74, thumb: "/clips/related/DOT3nOCFBZO.jpg", clip: "/clips/related/DOT3nOCFBZO.mp4" },
  { title: "Ep 12: the new guy", creator: "@cluely", trait: "tag-a-coworker", score: 0.71, thumb: "/clips/related/DSG1AeYiWap.jpg", clip: "/clips/related/DSG1AeYiWap.mp4" },
];
