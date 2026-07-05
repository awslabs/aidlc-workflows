// covers: subcommand:aidlc-utility:doctor
//
// t204 - the orphaned-compose-marker doctor probe. handleDoctor
// (aidlc-utility.ts) gained a read-only tripwire for
// aidlc/.aidlc-compose-pending: the conductor writes it before an in-flight
// compose gate and deletes it on resolve, so a lingering marker signals a
// crashed/abandoned gate. The probe flags a PRESENT marker (with its age + a
// remediation hint) and is SILENT when absent. It never deletes the marker (the
// Stop hook is the janitor for a stale one), so it is a pure read-only report
// row - no behavior change. Mechanism = cli: doctor terminates with
// process.exit and writes its report to stdout, so we spawn the real tool
// through the bun runtime and assert on the rendered report, exactly as the
// sibling doctor twin (t83) does. A bare temp project already fails the
// hook/settings checks (doctor exits 1); the marker row renders regardless of
// exit code, so we capture status for parity and assert on the report lines.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";

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

/** The in-flight compose marker path (workspace-level, not per-intent). */
function markerPath(proj: string): string {
  return join(proj, "aidlc", ".aidlc-compose-pending");
}

/** Write the compose marker, optionally backdating its mtime `ageSec` seconds. */
function seedMarker(proj: string, ageSec?: number): void {
  const path = markerPath(proj);
  mkdirSync(join(proj, "aidlc"), { recursive: true });
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

  test("flags a present marker with its age and remediation hint", () => {
    const proj = freshProject();
    seedMarker(proj); // written now
    const { out } = runDoctor(proj);
    expect(out).toContain("Compose marker present");
    expect(out).toContain("aidlc/.aidlc-compose-pending");
    // The remediation names the delete path (or resolving the gate).
    expect(out).toContain("rm aidlc/.aidlc-compose-pending");
  });

  test("reports the marker age in hours for an older marker", () => {
    const proj = freshProject();
    seedMarker(proj, 3 * 60 * 60); // 3h old
    const { out } = runDoctor(proj);
    expect(out).toContain("Compose marker present");
    expect(out).toContain("3h old");
  });
});
