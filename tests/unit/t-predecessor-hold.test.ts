// The t163 theft oracle decides whether a lock winner took over while its
// predecessor still held. Each case scripts the release-record reads and the
// PID probe in order, so the lifecycle interleavings are exact, not timed.
import { describe, expect, test } from "bun:test";
import { predecessorStillHeld } from "../harness/predecessor-hold.ts";

const ACQUIRED = 1_000;

// Return each scripted record read in turn; reading past the script fails.
function reads(...values: Array<number | null>): () => number | null {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error("read the release record more often than scripted");
    return values[index++];
  };
}

function probe(alive: boolean): () => boolean {
  return () => alive;
}

function noProbe(): boolean {
  throw new Error("probed the PID although the release record decides");
}

describe("predecessorStillHeld", () => {
  test("a record from before this winner acquired means a clean hand-off", () => {
    expect(predecessorStillHeld(ACQUIRED, reads(900), noProbe)).toBe(false);
  });

  test("a record from after this winner acquired means a robbed holder", () => {
    expect(predecessorStillHeld(ACQUIRED, reads(1_100), noProbe)).toBe(true);
  });

  test("a predecessor that published and exited before the probe is judged by its record, not a reused PID", () => {
    // First read misses, the predecessor releases (at 900) and exits, Windows
    // hands its PID to a new process, so the probe says alive.
    expect(predecessorStillHeld(ACQUIRED, reads(null, 900), probe(true))).toBe(false);
  });

  test("a robbed predecessor that published and exited before the probe is still caught", () => {
    // It released after this winner acquired, then exited before the probe.
    expect(predecessorStillHeld(ACQUIRED, reads(null, 1_100), probe(false))).toBe(true);
  });

  test("no record before or after the probe trusts the probe: still holding", () => {
    expect(predecessorStillHeld(ACQUIRED, reads(null, null), probe(true))).toBe(true);
  });

  test("no record before or after the probe trusts the probe: gone without a record", () => {
    expect(predecessorStillHeld(ACQUIRED, reads(null, null), probe(false))).toBe(false);
  });
});
