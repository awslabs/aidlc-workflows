// predecessor-hold.ts: did a lock winner take over while its predecessor still held?
//
// A bare PID probe is not enough once the predecessor has exited: Windows hands
// a freed PID to a new process within a second, so the probe can call that
// unrelated process the robbed holder. Each predecessor renames a release record
// into place after its hold and before it exits, so the record decides whenever
// it exists. The record is read again after the probe: a predecessor can publish
// and exit between the first read and the probe. A record still missing after
// the probe means the predecessor had not exited when the probe ran, so its PID
// was still its own and the probe is exact.

export function predecessorStillHeld(
  acquiredAtMs: number,
  readReleasedAtMs: () => number | null,
  probeAlive: () => boolean,
): boolean {
  const released = readReleasedAtMs();
  if (released !== null) return acquiredAtMs < released;
  const alive = probeAlive();
  const releasedAfterProbe = readReleasedAtMs();
  return releasedAfterProbe !== null ? acquiredAtMs < releasedAfterProbe : alive;
}
