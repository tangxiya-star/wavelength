// High-resolution monotonic clock for precise event timing (EEG sync).
//
// Why not Date.now(): it's whole-millisecond and wall-clock, so it can jump or
// step backward when the OS adjusts the clock (NTP). EEG is recorded on a
// separate device sampling at 250–1000 Hz (1–4 ms/sample), so we need a stable,
// sub-millisecond timeline to align the two streams post-hoc.
//
// performance.now() is monotonic and sub-millisecond, measured from a fixed
// origin (TIME_ORIGIN). Together they give, for any event:
//   • monotonic session timeline:   monoNow() - sessionStartMono
//   • absolute wall-clock (sub-ms):  TIME_ORIGIN + monoNow()
// The absolute form survives an app restart (it's baked into each event at log
// time); the monotonic form is the precise reference for within-session sync.

const perf: Pick<Performance, 'now'> & { timeOrigin?: number } | undefined =
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance : undefined;

/**
 * Wall-clock epoch (ms) of the monotonic origin, sub-ms where the platform
 * exposes performance.timeOrigin (web). On React Native it's typically absent,
 * so we derive it once at module load: now − elapsed-since-origin.
 */
export const TIME_ORIGIN: number =
  perf && typeof perf.timeOrigin === 'number' && perf.timeOrigin > 0
    ? perf.timeOrigin
    : Date.now() - (perf ? perf.now() : 0);

/** Monotonic high-resolution milliseconds since TIME_ORIGIN. */
export function monoNow(): number {
  return perf ? perf.now() : Date.now() - TIME_ORIGIN;
}
