// Color profile extraction (Holly owns this). For each clip, sample frames and compute an
// average color per scene, writing public/color-profiles.json keyed by video_id.
//
// Requires ffmpeg on PATH. This is a stub showing the shape — fill in the ffmpeg calls.
//   npm run extract-color
//
// Approach:
//   1) read contracts/mocks/videos.json (or Devan's live list) for {video_id, url, cut_count}
//   2) for each clip: ffmpeg -i clip.mp4 -vf "select='eq(pict_type,I)',scale=1:1" -f rawvideo ...
//      (scale to 1x1 = average color of the frame) for ~cut_count sample points
//   3) collect hex colors -> { [video_id]: ["#rrggbb", ...] }
//   4) write public/color-profiles.json

import { readFile, writeFile } from "node:fs/promises";

const videos = JSON.parse(await readFile(new URL("../../contracts/mocks/videos.json", import.meta.url)));

const out = {};
for (const v of videos) {
  // TODO(Holly): replace this placeholder with real ffmpeg-derived colors.
  out[v.video_id] = ["#888888"];
  console.log(`extracted (stub) ${v.video_id}`);
}

await writeFile(new URL("../public/color-profiles.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("wrote public/color-profiles.json");
