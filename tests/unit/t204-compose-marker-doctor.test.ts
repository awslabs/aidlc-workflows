// covers: subcommand:aidlc-utility:doctor
//
// t204 - the orphaned transient-marker doctor probes. handleDoctor
// (aidlc-utility.ts) reports the compose and background-subagent workspace
// markers with the same read-only freshness discipline: absent is silent,
// fresh is an advisory PASS row, and stale is a FAIL row with exact removal
// guidance. Doctor never deletes either marker; the Stop hook is their stale
// marker janitor.
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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";
import {
  composeMarkerPath,
  COMPOSE_MARKER_TTL_MS,
  markSubagentInflight,
  subagentInflightMarkerPath,
  SUBAGENT_INFLIGHT_TTL_MS,
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

/** Write one background-subagent ledger entry, optionally backdating it. */
function seedSubagentLedger(proj: string, ageSec?: number): string {
  const path = subagentInflightMarkerPath(proj);
  expect(markSubagentInflight(proj, "doctor-session")).toBe(true);
  if (ageSec !== undefined) {
    const ledger = JSON.parse(readFileSync(path, "utf-8")) as {
      entries: Array<{ startedAtMs: number }>;
    };
    ledger.entries[0].startedAtMs = Date.now() - ageSec * 1000;
    writeFileSync(path, `${JSON.stringify(ledger)}\n`, "utf-8");
  }
  return path;
}

interface DoctorResult {
  status: number;
  out: string; // combined stdout+stderr
}

function runDoctor(proj: string): DoctorResult {
  const res = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", proj], {
    encoding: "utf-8",
    env: { ...process.env },
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

describe("t204 doctor transient-marker probes", () => {
  test("silent when neither marker is present", () => {
    const proj = freshProject();
    const { out } = runDoctor(proj);
    expect(out).not.toContain("Compose marker present");
    expect(out).not.toContain(".aidlc-compose-pending");
    expect(out).not.toContain("Background-subagent ledger present");
    expect(out).not.toContain(".aidlc-subagent-inflight");
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
    expect(out).toMatch(/ok\s+Compose marker present \(.*fresh\)/);
    expect(out).not.toMatch(/fail\s+Compose marker present/);
  });

  test("a STALE marker (past the TTL) renders as a FAIL row with the remediation", () => {
    const proj = freshProject();
    // One hour past the shared freshness window - the orphan case.
    seedMarker(proj, COMPOSE_MARKER_TTL_MS / 1000 + 60 * 60);
    const { out, status } = runDoctor(proj);
    expect(out).toMatch(/fail\s+Compose marker present \(.*stale\)/);
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
    expect(out).toMatch(/ok\s+Compose marker present \(.*3h old, fresh\)/);
  });

  test("a FRESH background-subagent ledger renders as an advisory PASS row and is not deleted", () => {
    const proj = freshProject();
    const marker = seedSubagentLedger(proj);
    const { out } = runDoctor(proj);
    expect(out).toContain("Background-subagent ledger present");
    expect(out).toContain("aidlc/.aidlc-subagent-inflight");
    expect(out).toMatch(
      /ok\s+Background-subagent ledger present \(.*1 fresh, 0 stale/,
    );
    expect(out).not.toMatch(
      /fail\s+Background-subagent ledger present/,
    );
    expect(existsSync(marker)).toBe(true);
  });

  test("a STALE background-subagent entry renders as a FAIL row with rm remediation and is not deleted", () => {
    const proj = freshProject();
    const marker = seedSubagentLedger(
      proj,
      SUBAGENT_INFLIGHT_TTL_MS / 1000 + 60 * 60,
    );
    const { out, status } = runDoctor(proj);
    expect(out).toMatch(
      /fail\s+Background-subagent ledger present \(.*0 fresh, 1 stale/,
    );
    expect(out).toContain("rm aidlc/.aidlc-subagent-inflight");
    expect(status).toBe(1);
    expect(existsSync(marker)).toBe(true);
  });
});
