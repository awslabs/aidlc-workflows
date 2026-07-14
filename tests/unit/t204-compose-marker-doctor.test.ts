// covers: subcommand:aidlc-utility:doctor
//
// t204 - the orphaned-compose-marker doctor probe. handleDoctor
// (aidlc-utility.ts) gained a read-only tripwire for
// aidlc/.aidlc-compose-pending: the conductor writes it before an in-flight
// compose gate and deletes it on resolve, so a lingering marker signals a
// crashed/abandoned gate. The probe reports a PRESENT marker (with its age + a
// remediation hint) and is SILENT when absent. Pass/fail follows the shared
// freshness window: a FRESH marker is the normal state at a live compose gate,
// so it renders as an advisory PASS row (doctor must not exit 1 on a healthy
// workspace mid-gate); only a STALE marker (older than COMPOSE_MARKER_TTL_MS,
// an orphan) renders as a FAIL row. It never deletes the marker (the Stop hook
// is the janitor for a stale one), so it is a pure read-only report row.
// Mechanism = cli: doctor terminates with process.exit and writes its report
// to stdout, so we spawn the real tool through the bun runtime and assert on
// the rendered report, exactly as the sibling doctor twin (t83) does. A bare
// temp project already fails the hook/settings checks (doctor exits 1); the
// marker row renders regardless of exit code, so we capture status for parity
// and assert on the report lines (pass rows are prefixed with the u2713 check
// mark, fail rows with the u2717 cross + the fix text). The marker path and
// the freshness window come from the shipped lib, so the test cannot drift
// from the probe's spelling.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";
import {
  composeMarkerPath,
  COMPOSE_MARKER_TTL_MS,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function freshProject(): string {
  const proj = createTestProject();
  created.push(proj);
  return proj;
}

/** Write the compose marker, optionally backdating its mtime `ageSec` seconds. */
function seedMarker(proj: string, ageSec?: number): void {
  const path = composeMarkerPath(proj);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "pending\n", "utf-8");
  if (ageSec !== undefined) {
    const when = Date.now() / 1000 - ageSec;
    utimesSync(path, when, when);
  }
}

interface DoctorResult {
  status: number;
  out: string; // combined stdout+stderr
}

function runDoctor(proj: string): DoctorResult {
  const res = spawnSync(BUN, [UTIL, "doctor", "--project-dir", proj], {
    encoding: "utf-8",
    env: { ...process.env },
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

describe("t204 doctor compose-marker probe", () => {
  test("silent when no marker is present", () => {
    const proj = freshProject();
    const { out } = runDoctor(proj);
    // No marker on disk -> nothing to report; the probe adds no row.
    expect(out).not.toContain("Compose marker present");
    expect(out).not.toContain(".aidlc-compose-pending");
  });

  test("a FRESH marker renders as an advisory PASS row (normal at a live gate)", () => {
    const proj = freshProject();
    seedMarker(proj); // written now
    const { out } = runDoctor(proj);
    expect(out).toContain("Compose marker present");
    expect(out).toContain("aidlc/.aidlc-compose-pending");
    // Advisory pass: check-mark row, ", fresh" label, and NO fix text appended
    // (only fail rows carry the remediation) - a live gate in a second
    // terminal must not contribute to a non-zero doctor exit.
    expect(out).toMatch(/\u2713\s+Compose marker present \(.*fresh\)/);
    expect(out).not.toMatch(/\u2717\s+Compose marker present/);
  });

  test("a STALE marker (past the TTL) renders as a FAIL row with the remediation", () => {
    const proj = freshProject();
    // One hour past the shared freshness window - the orphan case.
    seedMarker(proj, COMPOSE_MARKER_TTL_MS / 1000 + 60 * 60);
    const { out, status } = runDoctor(proj);
    expect(out).toMatch(/\u2717\s+Compose marker present \(.*stale\)/);
    // The remediation names the delete path (or resolving the gate).
    expect(out).toContain("rm aidlc/.aidlc-compose-pending");
    // A fail row implies the non-zero exit CI keys off.
    expect(status).toBe(1);
  });

  test("reports the marker age in hours for an older (still fresh) marker", () => {
    const proj = freshProject();
    seedMarker(proj, 3 * 60 * 60); // 3h old - inside the 24h window
    const { out } = runDoctor(proj);
    expect(out).toContain("Compose marker present");
    expect(out).toContain("3h old");
    expect(out).toMatch(/\u2713\s+Compose marker present \(.*3h old, fresh\)/);
  });
});
