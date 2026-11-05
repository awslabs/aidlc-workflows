// covers: subcommand:aidlc-utility:doctor, function:classifyStateVersion, function:bringStateUpToDate
//
// The state-version gate and the bring-up beside it. v8 renamed the Inception
// `application-design` stage to `domain-design` and added `contract-design`. A
// v7 record (2.1.x to 2.3.0) is brought up in place the first time the engine
// reads it: the real records those releases wrote (tests/fixtures/state-v7)
// resume where they stood, approvals kept, the original kept beside it, one
// audit row, nothing said; doctor and status show it on purpose. A version no
// step brings up (below 7, newer, unparseable) is still refused by `next`,
// `report` and doctor alike, without the old archive-and-start-again advice.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, afterEach, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  REPO_ROOT,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function stateWithVersion(version: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: state-version doctor test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: ${version}
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0

## Stage Progress

### INCEPTION PHASE
- [-] domain-design — EXECUTE

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: domain-design
- **Status**: Running
`;
}

function runDoctor(version: string): { status: number; out: string } {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), stateWithVersion(version), "utf-8");
  const res = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

describe("t282 state-version doctor gate", () => {
  test("a v6 state, which no step brings up, fails the state-version row without archive advice", () => {
    const { status, out } = runDoctor("6");
    expect(out).toMatch(/state version current/);
    expect(out).not.toMatch(/State Version: 8/);
    expect(out).not.toContain("mv aidlc");
    expect(out).not.toContain("aidlc-docs");
    // The message explains WHY (the renamed Inception graph).
    expect(out).toMatch(/domain-design/);
    expect(status).not.toBe(0);
  });

  test("a v7 state passes the state-version row: AI-DLC brings it up at its next step", () => {
    const { out } = runDoctor("7");
    expect(out).toMatch(/State Version: 7 \(AI-DLC brings this record up to 8 at its next step\)/);
    expect(out).not.toMatch(/state version current/);
    expect(out).not.toContain("mv aidlc");
  });

  test("a current v8 state passes the state-version row", () => {
    const { out } = runDoctor("8");
    expect(out).toMatch(/State Version: 8/);
    expect(out).not.toMatch(/state version current/);
  });

  // Doctor must classify malformed and future numeric versions the SAME way the
  // runtime guard does (both call the shared classifyStateVersion in aidlc-lib).
  // Malformed values must NOT receive stale-version wording, and future values
  // must receive upgrade guidance (not archive-and-reinit).
  test("a MALFORMED (non-numeric) state fails the readable row, not the past-version row", () => {
    const { status, out } = runDoctor("not-a-number");
    expect(out).toMatch(/state version readable/);
    expect(out).not.toMatch(/state version current/);
    expect(out).toMatch(/missing, empty, or unparseable/);
    expect(status).not.toBe(0);
  });

  test("a FUTURE (v9) state fails the compatible row with upgrade guidance, not archive-and-reinit", () => {
    const { status, out } = runDoctor("9");
    expect(out).toMatch(/state version compatible/);
    expect(out).not.toMatch(/state version current/);
    expect(out).toMatch(/is newer than the current/);
    expect(out).toMatch(/Upgrade the framework/);
    // The past-version's archive path template ('mv aidlc aidlc.v9-archive')
    // MUST NOT appear — that would be the wrong remediation for a future state.
    expect(out).not.toMatch(/aidlc\.v9-archive/);
    expect(status).not.toBe(0);
  });

  test("a state with TRAILING CONTENT on the version line is unparseable, not v8", () => {
    const { status, out } = runDoctor("8 garbage");
    expect(out).toMatch(/state version readable/);
    expect(out).toMatch(/missing, empty, or unparseable/);
    expect(out).not.toMatch(/State Version: 8/);
    expect(status).not.toBe(0);
  });
});

// The v8 gate must ALSO fire on runtime/mutating commands, not only `doctor`.
// Before the fix, `next` against a v7 state exited 0 with a normal
// load-steering directive and advanced until it hit the removed
// `application-design` row. `next` and `report` must refuse a stale state up
// front with an error directive.
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

function runOrchestrate(sub: string, version: string): { status: number; kind: string; out: string } {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), stateWithVersion(version), "utf-8");
  const args = sub === "report"
    ? [ORCH, "report", "--stage", "domain-design", "--result", "approved", "--project-dir", proj]
    : [ORCH, "next", "--project-dir", proj];
  const res = spawnSync(BUN, args, { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: { ...process.env } });
  const out = `${res.stdout ?? ""}`;
  let kind = "";
  try { kind = JSON.parse(out.trim()).kind ?? ""; } catch { kind = ""; }
  return { status: res.status ?? -1, kind, out: `${out}${res.stderr ?? ""}` };
}

function runOrchestrateWithState(sub: string, stateContent: string): { status: number; kind: string; out: string } {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), stateContent, "utf-8");
  const args = sub === "report"
    ? [ORCH, "report", "--stage", "domain-design", "--result", "approved", "--project-dir", proj]
    : [ORCH, "next", "--project-dir", proj];
  const res = spawnSync(BUN, args, { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: { ...process.env } });
  const out = `${res.stdout ?? ""}`;
  let kind = "";
  try { kind = JSON.parse(out.trim()).kind ?? ""; } catch { kind = ""; }
  return { status: res.status ?? -1, kind, out: `${out}${res.stderr ?? ""}` };
}

describe("t282 runtime state-version guard (next / report)", () => {
  test("`next` refuses a v6 state, which no step brings up, with an error directive and no archive advice", () => {
    const r = runOrchestrate("next", "6");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(/State Version 6 predates the current/);
    expect(r.out).not.toContain("mv aidlc");
    expect(r.out).not.toMatch(/"kind":\s*"load-steering"/);
  });

  test("`report` refuses a v6 state with an error directive", () => {
    const r = runOrchestrate("report", "6");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(/State Version 6 predates the current/);
  });

  test("`report` on a v7 state brings it up first instead of refusing", () => {
    const r = runOrchestrate("report", "7");
    expect(r.out).not.toMatch(/predates the current/);
  });

  test("a current v8 state is NOT blocked by the runtime guard", () => {
    const r = runOrchestrate("next", "8");
    expect(r.kind).not.toBe("error");
  });

  // Runtime must align with `--doctor`, which rejects a state whose version is
  // missing, empty, or unparseable - not only an explicit stale one. Assertions
  // pin the EXACT remediation branch, not generic wording, so a future regression
  // that trips the wrong branch is caught.
  const UNPARSEABLE = /State Version field is missing, empty, or unparseable/;

  test("`next` refuses a state whose State Version field is MISSING (exact unparseable remediation)", () => {
    const stateNoVersion = stateWithVersion("8").replace(
      /^- \*\*State Version\*\*:.*\n/m,
      "",
    );
    const r = runOrchestrateWithState("next", stateNoVersion);
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    expect(r.out).not.toMatch(/predates the current/);
    expect(r.out).not.toMatch(/"kind":\s*"load-steering"/);
  });

  test("`next` refuses a state whose State Version value is EMPTY (and does not capture the next bullet's `-`)", () => {
    const r = runOrchestrate("next", "");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    // The `[ \t]*` parser must NOT span the newline and capture "-" from the
    // next state bullet as a bogus version, mislabeling it as a stale version.
    expect(r.out).not.toMatch(/State Version - predates/);
  });

  test("`report` refuses a state whose State Version value is MALFORMED (non-numeric → unparseable)", () => {
    const r = runOrchestrate("report", "not-a-number");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    expect(r.out).not.toMatch(/predates the current/);
  });

  test("`next` refuses a PRESENT but zero-byte state file (not skipped as absent)", () => {
    const r = runOrchestrateWithState("next", "");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    expect(r.out).not.toMatch(/"kind":\s*"load-steering"/);
  });

  test("`report` refuses a PRESENT but zero-byte state file", () => {
    const r = runOrchestrateWithState("report", "");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
  });

  // A FUTURE numeric schema (v9) is incompatible with THIS build's v8 graph, but
  // it does not "predate" v8 — it must be reported as newer, with upgrade (not
  // archive-and-reinit) guidance.
  test("`next` refuses a FUTURE (v9) state as newer, not as predating v8", () => {
    const r = runOrchestrate("next", "9");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(/State Version 9 is newer than the current/);
    expect(r.out).not.toMatch(/predates the current/);
  });

  // A parser that captures only the first non-whitespace token accepts anything
  // on the rest of the line, so "State Version: 8 garbage" passed as v8. The
  // anchored parser rejects any trailing content on the schema-token line and
  // routes it through the unparseable branch.
  test("`next` refuses trailing content on the State Version line as unparseable, not as v8", () => {
    const r = runOrchestrate("next", "8 garbage");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    expect(r.out).not.toMatch(/predates the current/);
    expect(r.out).not.toMatch(/is newer than the current/);
    expect(r.out).not.toMatch(/"kind":\s*"load-steering"/);
  });

  test("`report` refuses trailing content on the State Version line as unparseable", () => {
    const r = runOrchestrate("report", "8 garbage");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
  });

  // A stale numeric with trailing content ("7 archived") must also fall through
  // the unparseable branch rather than being mistaken for a plain v7 state.
  test("`next` treats `7 <trailing>` as unparseable, not as a pre-v8 state", () => {
    const r = runOrchestrate("next", "7 archived");
    expect(r.kind).toBe("error");
    expect(r.out).toMatch(UNPARSEABLE);
    expect(r.out).not.toMatch(/predates the current/);
  });
});

// All three refusals point at doctor. The pointer must name the harness's own
// skill prefix: Codex routes `$aidlc`, so a literal `/aidlc --doctor` sends a
// Codex user to a command their harness does not have.
describe("t282 state-version refusals name doctor through the harness skill prefix", () => {
  const CODEX_ORCH = join(REPO_ROOT, "dist", "codex", ".codex", "tools", "aidlc-orchestrate.ts");
  const nextOn = (tool: string, version: string): string => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    writeFileSync(seededStateFile(proj), stateWithVersion(version), "utf-8");
    const env = { ...process.env };
    delete env.AIDLC_HARNESS_DIR;
    delete env.AIDLC_HARNESS_NAME;
    const res = spawnSync(BUN, [tool, "next", "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env,
    });
    return `${res.stdout ?? ""}${res.stderr ?? ""}`;
  };
  for (const [branch, version] of [["past", "6"], ["future", "9"], ["unparseable", "8 garbage"]]) {
    test(`the ${branch} refusal says $aidlc --doctor on Codex and /aidlc --doctor on Claude`, () => {
      const codex = nextOn(CODEX_ORCH, version);
      expect(codex).toContain("Run `$aidlc --doctor`");
      expect(codex).not.toContain("/aidlc --doctor");
      expect(nextOn(ORCH, version)).toContain("Run `/aidlc --doctor`");
    });
  }
});

// The real records 2.1.x to 2.3.0 wrote (Project Root made relative), brought
// up by main's engine the first time it reads them.
const V7 = join(REPO_ROOT, "tests", "fixtures", "state-v7");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");

function v7Project(fixture: string, withDesign = false): { proj: string; state: string; record: string } {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const record = seededRecordDir(proj);
  const original = readFileSync(join(V7, fixture), "utf-8");
  writeFileSync(seededStateFile(proj), original, "utf-8");
  if (withDesign) {
    mkdirSync(join(record, "inception"), { recursive: true });
    cpSync(join(V7, "application-design"), join(record, "inception", "application-design"), { recursive: true });
  }
  return { proj, state: original, record };
}

function engine(proj: string, args: string[], env: Record<string, string> = {}): { directive: Record<string, unknown>; out: string } {
  const res = spawnSync(BUN, [ORCH, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: { ...process.env, ...env },
  });
  const out = `${res.stdout ?? ""}`;
  let directive: Record<string, unknown> = {};
  try { directive = JSON.parse(out.trim()); } catch { directive = {}; }
  return { directive, out: `${out}${res.stderr ?? ""}` };
}

function upgradeRows(proj: string): number {
  const dir = seededAuditDir(proj);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce((n, f) => n + (readFileSync(join(dir, f), "utf-8").match(/\*\*Event\*\*: STATE_UPGRADED$/gm)?.length ?? 0), 0);
}

describe("t282 a v7 record is brought up in place and resumes", () => {
  test("stopped after Application Design was approved (2.3.0): resumes at Units Generation, every approval kept", () => {
    const { proj, state, record } = v7Project("aidlc-state-2.3.0-design-approved.md", true);
    const r = engine(proj, ["next", "--resume"]);
    expect(r.out).not.toMatch(/predates the current/);
    expect(r.directive.kind).not.toBe("error");
    expect(r.directive.stage).toBe("units-generation");
    const now = readFileSync(seededStateFile(proj), "utf-8");
    expect(now).toMatch(/^- \*\*State Version\*\*: 8$/m);
    for (const slug of ["practices-discovery", "requirements-analysis", "user-stories", "refined-mockups", "domain-design"]) {
      expect(now).toMatch(new RegExp(`^- \\[x\\] ${slug} \u2014 EXECUTE$`, "m"));
    }
    expect(now).not.toMatch(/application-design/);
    expect(now).toMatch(/^- \*\*Last Completed Stage\*\*: domain-design$/m);
    // The route after Units Generation runs through Contract Design now, and status reads this field.
    expect(now).toMatch(/^- \*\*Next Stage\*\*: contract-design$/m);
    // Contract Design has no row until the work moves onto it, as for any stage a newer release adds.
    expect(now).not.toMatch(/^- \[.\] contract-design/m);
    // The approved design is where Units Generation reads it.
    expect(existsSync(join(record, "inception", "domain-design", "components.md"))).toBe(true);
    expect(existsSync(join(record, "inception", "application-design"))).toBe(false);
    expect(readFileSync(join(record, "aidlc-state.v7.md"), "utf-8")).toBe(state);
    expect(upgradeRows(proj)).toBe(1);
    // A second step finds it current: nothing more is written.
    engine(proj, ["next", "--resume"]);
    expect(upgradeRows(proj)).toBe(1);
    expect(readFileSync(join(record, "aidlc-state.v7.md"), "utf-8")).toBe(state);
  });

  test("stopped right after Units Generation was approved (2.1.7): Contract Design runs next, by the engine's own backward jump", () => {
    const { proj } = v7Project("aidlc-state-2.1.7-units-approved.md");
    // The 2.1.7 audit holds no STAGE_STARTED for Delivery Planning here, so every add
    // since the record began counts; the bring-up row is the only one.
    const r = engine(proj, ["next"]);
    const message = String(r.directive.message ?? "");
    expect(r.directive.kind).toBe("print");
    expect(message).toMatch(/--target contract-design --direction backward/);
    const jump = spawnSync(BUN, [JUMP, "execute", "--target", "contract-design", "--direction", "backward", "--scope", "workshop"], {
      cwd: proj, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    expect(jump.status, `${jump.stdout}${jump.stderr}`).toBe(0);
    const now = readFileSync(seededStateFile(proj), "utf-8");
    expect(now).toMatch(/^- \[-\] contract-design \u2014 EXECUTE$/m);
    expect(now).toMatch(/^- \*\*Current Stage\*\*: contract-design$/m);
    expect(now).toMatch(/^- \[x\] units-generation \u2014 EXECUTE$/m);
    expect(now).toMatch(/^- \[x\] domain-design \u2014 EXECUTE$/m);
    expect(engine(proj, ["next"]).directive.stage).toBe("contract-design");
  });

  test("already in Code Generation (2.1.1): it carries on there and nothing approved is reopened", () => {
    const { proj } = v7Project("aidlc-state-2.1.1-code-generation.md");
    const r = engine(proj, ["next", "--resume"]);
    expect(r.directive.kind).not.toBe("error");
    expect(r.out).not.toMatch(/contract-design/);
    const now = readFileSync(seededStateFile(proj), "utf-8");
    expect(now).toMatch(/^- \*\*Current Stage\*\*: code-generation$/m);
    expect(now).toMatch(/^- \[x\] domain-design \u2014 EXECUTE$/m);
    expect(now).toMatch(/^- \[x\] delivery-planning \u2014 EXECUTE$/m);
  });

  test("a v8 record is untouched: same bytes, no copy, no audit row", () => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    const v8 = stateWithVersion("8");
    writeFileSync(seededStateFile(proj), v8, "utf-8");
    engine(proj, ["next"]);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(v8);
    expect(existsSync(join(seededRecordDir(proj), "aidlc-state.v8.md"))).toBe(false);
    expect(upgradeRows(proj)).toBe(0);
  });

  test("the Stop hook's read-only probe on a v7 record writes nothing", () => {
    const { proj, state, record } = v7Project("aidlc-state-2.3.0-design-approved.md", true);
    engine(proj, ["next"], { AIDLC_STOP_HOOK_PROBE: "1" });
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(state);
    expect(existsSync(join(record, "aidlc-state.v7.md"))).toBe(false);
    expect(existsSync(join(record, "inception", "application-design", "components.md"))).toBe(true);
    expect(upgradeRows(proj)).toBe(0);
  });

  test("after the step, doctor and status say when it was brought up", () => {
    const { proj } = v7Project("aidlc-state-2.3.0-design-approved.md", true);
    engine(proj, ["next", "--resume"]);
    const doctor = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
    });
    expect(`${doctor.stdout}`).toMatch(/State Version: 8 \(brought up from 7 on \d{4}-\d{2}-\d{2}; the record as it was is aidlc-state\.v7\.md\)/);
    const status = spawnSync(BUN, [UTIL, "status", "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
    });
    expect(`${status.stdout}`).toMatch(/^Brought up: +from an older AI-DLC on \d{4}-\d{2}-\d{2} \(the record as it was: aidlc-state\.v7\.md\)$/m);
    expect(`${status.stdout}`).toMatch(/^Next Stage: +Contract Design$/m);
  });
});
