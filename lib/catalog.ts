// Placeholder video catalog + deterministic shuffle.
//
// Clips are bundled, locally-generated colored countdowns (1->4) in three
// variations — produced by scripts/gen-test-videos.py (SPEC §9). This catalog
// is used in mock mode; with the local API server running, the app uses the
// /api/playlist response instead. `contentType` is the cross-media comparison
// dimension (SPEC §5.2).

import countA from '../assets/videos/count_a.mp4';
import countB from '../assets/videos/count_b.mp4';
import countC from '../assets/videos/count_c.mp4';
import type { Video } from './types';

export const MOCK_CATALOG: Video[] = [
  { id: 'v1', slug: 'count_a_01', title: 'Counting · Variation A', source: countA, durationSeconds: 8, contentType: 'counting_a' },
  { id: 'v2', slug: 'count_b_01', title: 'Counting · Variation B', source: countB, durationSeconds: 6, contentType: 'counting_b' },
  { id: 'v3', slug: 'count_c_01', title: 'Counting · Variation C', source: countC, durationSeconds: 10, contentType: 'counting_c' },
  { id: 'v4', slug: 'count_a_02', title: 'Counting · Variation A', source: countA, durationSeconds: 8, contentType: 'counting_a' },
  { id: 'v5', slug: 'count_b_02', title: 'Counting · Variation B', source: countB, durationSeconds: 6, contentType: 'counting_b' },
  { id: 'v6', slug: 'count_c_02', title: 'Counting · Variation C', source: countC, durationSeconds: 10, contentType: 'counting_c' },
];

/** Hash an arbitrary string to a uint32 seed (FNV-1a). */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic PRNG. */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic Fisher-Yates shuffle keyed by `seed`. The same seed always
 * reproduces the same order, so a stored `playlistSeed` recreates exactly what
 * a participant saw (SPEC §4, §6).
 */
export function shuffleWithSeed<T>(items: readonly T[], seed: string): T[] {
  const rng = mulberry32(hashSeed(seed));
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
