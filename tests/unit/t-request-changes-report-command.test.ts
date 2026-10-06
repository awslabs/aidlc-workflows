// covers: function:requestChangesReportArgs
// covers: function:requestChangesReportCommand
// covers: function:lifecycleResetRemedies
//
// A recovery question's Request Changes names the exact report to run, so the
// agent never has to guess its flags. Observed live on Claude Code in a solo
// unit-major walk: the review freeze offered Request Changes for Functional
// Design, the person picked it, and the agent guessed
//   report --stage functional-design --unit u2-note-tags --result rejected ...
// which the engine refuses outside team ownership ("--unit gate reporting
// requires Unit Ownership: team."), and the agent quoted that error to the
// person. A solo walk reports the stage; only a team-owned Unit gate reports
// with --unit. The same holds for finishing a revision.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActiveDirectiveGuardRemedy,
  consumeSharedDirectiveAsk,
  evaluateGuardRefusal,
  GUARD_RECOVERY_ASK_TYPE,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import * as lib from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SESSION = "t-request-changes-report-command";
const STAGE = "functional-design";
const UNIT = "u2-note-tags";

function answer(proj: string, details: string): { status: number | null; message: string; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: SESSION,
  };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const r = Bun.spawnSync({
    cmd: [BUN, LOG, "answer", "--stage", STAGE, "--checkpoint", "guard-recovery", "--details", details, "--project-dir", proj],
    cwd: proj, env, stdout: "pipe", stderr: "pipe",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const stdout = r.stdout.toString();
  let message = "";
  try {
    message = (JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { message?: string }).message ?? "";
  } catch {
    message = stdout;
  }
  return { status: r.exitCode, message, stderr: r.stderr.toString() };
}

describe("Request Changes from a recovery question names the report to run", () => {
  let proj: string;
  let content: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
    // A solo walk, one Unit at a time: no Unit Ownership line, unit-major.
    const statePath = seededStateFile(proj);
    content = readFileSync(statePath, "utf-8")
      .replace("## Runtime State\n", "## Runtime State\n- **Construction Iteration**: unit-major\n");
    writeFileSync(statePath, content);
  });
  afterEach(() => cleanupTestProject(proj));

  const remedies: ActiveDirectiveGuardRemedy[] = [
    { op: "request-changes", action: "Ask what should change" },
    { op: "lower-fence", action: "Turn the review-freeze check off for this piece of work." },
  ];
  const ask = () => writeActiveDirectiveMarker(proj, {
    kind: "ask", ask_type: GUARD_RECOVERY_ASK_TYPE, stage: STAGE, unit: UNIT,
    state_sha256: stateDigest(content), remedies,
  });

  const expectStageReport = (message: string) => {
    expect(message).toMatch(/orchestrate(\.ts)? report --stage "?functional-design"? --result rejected --user-input "Request Changes"/);
    expect(message).not.toContain("--unit");
    expect(message).toContain("--reason");
  };

  test("a bare pick: ask what should change, then run the stage's report with their words", () => {
    ask();
    expect(consumeSharedDirectiveAsk(proj, "1")).toBe(true);
    const r = answer(proj, "request-changes");
    expect(r.status, r.stderr).toBe(0);
    expect(r.message).toContain('Ask "What should change?" and end the turn');
    expectStageReport(r.message);
  });

  test("a pick that already says what should change: run the stage's report with those words", () => {
    ask();
    expect(consumeSharedDirectiveAsk(proj, 'change "tags" to "labels" in the first heading')).toBe(true);
    const r = answer(proj, 'request-changes: change "tags" to "labels" in the first heading');
    expect(r.status, r.stderr).toBe(0);
    expect(r.message).not.toContain("What should change?");
    expectStageReport(r.message);
  });
});

describe("the report's flags follow the record's ownership", () => {
  test("a solo walk reports the stage, a team-owned Unit gate reports the Unit", () => {
    const requestChangesReportArgs = (lib as Record<string, unknown>).requestChangesReportArgs as
      (stage: string, unit: string | undefined, teamGate: unknown) => string[];
    expect(typeof requestChangesReportArgs).toBe("function");
    expect(requestChangesReportArgs(STAGE, UNIT, undefined)).toEqual([
      "report", "--stage", STAGE, "--result", "rejected", "--user-input", "Request Changes",
    ]);
    expect(requestChangesReportArgs(STAGE, UNIT, { resolved: true, gateStage: "code-generation", unit: UNIT } as never))
      .toEqual([
        "report", "--stage", "code-generation", "--unit", UNIT, "--result", "rejected", "--user-input", "Request Changes",
      ]);
  });

  test("finishing a revision in a solo walk reports the stage, not the Unit", () => {
    const state = readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8")
      .replace("## Runtime State\n", "## Runtime State\n- **Construction Iteration**: unit-major\n")
      // The stage being revised is the one row for it.
      .replace(/^- \[x\] functional-design .*\n/m, "")
      .replace("- [-] functional-design", "- [R] functional-design");
    const refusal = evaluateGuardRefusal({
      code: "REVIEW_FREEZE_ACTIVE",
      blockedAction: "artifact-write:functional-spec.md",
      stage: STAGE,
      unit: UNIT,
      stateContent: state,
      invariant: "A terminal review continues to cover the bytes it certified.",
      userMessage: "",
      attempt: { recovery: "spent", summaryCoverage: "current", reviewCoverage: "current", sourceCoverage: "current" },
      humanAuthority: { freshTurn: true, unattended: false },
    });
    const finish = refusal.remedies.find((remedy) => remedy.op === "finish-revision");
    expect(finish, JSON.stringify(refusal.remedies.map((remedy) => remedy.op))).toBeDefined();
    expect(finish!.action).toMatch(/orchestrate(\.ts)? report --stage "?functional-design"? --result revised/);
    expect(finish!.action).not.toContain("--unit");
  });
});
