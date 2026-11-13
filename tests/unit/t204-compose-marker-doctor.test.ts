// covers: subcommand:aidlc-utility:doctor, function:shownSubagentInflightPath
//
// t204 - doctor's transient-state probes. handleDoctor (aidlc-utility.ts)
// reports the in-flight compose question and the background-subagent
// workspace ledger read-only. The compose question is the engine's own record
// (composeGateOpen): open, it is an advisory PASS row; the file an earlier
// version had the agent write for it is named as left over, an advisory PASS
// row, and never deleted. The ledger keeps its freshness discipline: absent is
// silent, fresh is an advisory PASS row, and stale is a FAIL row with exact
// removal guidance; the Stop hook is its stale-entry janitor.
// Mechanism = cli: doctor terminates with process.exit and writes its report
// to stdout, so we spawn the real tool through the bun runtime and assert on
// the rendered report, exactly as the sibling doctor twin (t83) does. A bare
// temp project already fails the hook/settings checks (doctor exits 1); the
// rows render regardless of exit code, so we capture status for parity and
// assert on the report lines (pass rows are prefixed with the u2713 check
// mark, fail rows with the u2717 cross + the fix text).

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  runOrchestrateNext,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  markSubagentInflight,
  subagentInflightMarkerPath,
  SUBAGENT_INFLIGHT_TTL_MS,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
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

// Running work where the person asked for a reshape: `next compose` has
// handed out the composer, so the compose question is open.
function askedCompose(): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  created.push(proj);
  const tools = join(proj, ".claude", "tools");
  const createdWork = spawnSync(BUN, [join(tools, "aidlc-utility.ts"), "intent-create", "--scope", "feature", "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: proj,
  });
  expect(createdWork.status, `${createdWork.stdout}${createdWork.stderr}`).toBe(0);
  const compose = runOrchestrateNext(join(tools, "aidlc-orchestrate.ts"), proj, ["compose", "what else can we cut?"]);
  expect(compose.directive?.kind).toBe("print");
  return proj;
}

const OLD_FILE = (proj: string): string => join(proj, "aidlc", ".aidlc-compose-pending");

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
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env },
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

describe("t204 doctor transient-marker probes", () => {
  test("silent when no compose question is open and no ledger entry exists", () => {
    const proj = freshProject();
    const { out } = runDoctor(proj);
    expect(out).not.toContain("proposed plan change");
    expect(out).not.toContain(".aidlc-compose-pending");
    expect(out).not.toContain("Background-subagent ledger present");
    expect(out).not.toContain("subagent-inflight");
  });

  test("an open compose question renders as an advisory PASS row (normal at a live gate)", () => {
    const proj = askedCompose();
    const { out } = runDoctor(proj);
    expect(out).toMatch(/ok\s+A proposed plan change is waiting for the person's answer \(approve, edit or reject\)/);
    expect(out).not.toMatch(/fail\s+A proposed plan change/);
    expect(out).not.toContain(".aidlc-compose-pending");
  });

  test("the file an earlier version had the agent write is named as left over, an advisory PASS row, and left on disk", () => {
    const proj = freshProject();
    mkdirSync(dirname(OLD_FILE(proj)), { recursive: true });
    writeFileSync(OLD_FILE(proj), "pending\n", "utf-8");
    const { out } = runDoctor(proj);
    expect(out).toMatch(/ok\s+Left over from an earlier AI-DLC version and no longer read: aidlc\/\.aidlc-compose-pending \(safe to delete\)/);
    expect(out).not.toMatch(/fail\s+Left over/);
    expect(out).not.toContain("proposed plan change");
    expect(existsSync(OLD_FILE(proj))).toBe(true);
  });

  test("a FRESH background-subagent ledger renders as an advisory PASS row and is not deleted", () => {
    const proj = freshProject();
    const marker = seedSubagentLedger(proj);
    const { out } = runDoctor(proj);
    expect(out).toContain("Background-subagent ledger present");
    expect(out).toContain("aidlc/.aidlc-sessions/subagent-inflight.json");
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
    expect(out).toContain("delete aidlc/.aidlc-sessions/subagent-inflight.json yourself.");
    expect(status).toBe(1);
    expect(existsSync(marker)).toBe(true);
  });
});
