// covers: hook:aidlc-record-human-turn, subcommand:aidlc-log:review, subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-state:approve, file:aidlc-common/protocols/stage-protocol-reviewer.md
//
// The person drives. A review is running in a helper and the person stops it
// and writes ("approve it as it is"). The agent hears one line from the
// prompt hook: run `next` first. `next` names the step that finishes the
// review, or the person's way on, so the agent never retries the review behind
// their back or records a result in the reviewer's place.
//
// A review that stops with no person involved (its turn cap, a session that
// died) still gets the one retry and, if that also ends with nothing written,
// the NOT-READY fallback the agent records. That fallback is no reviewer's
// verdict: at a Unit checkpoint and at a stage gate it reads as a review that
// did not finish. The question says so, the approval records "Review: not
// finished", and the person hears the one line. What may proceed does not
// change, under every Guard Policy.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededAuditDir, seededRecordDir, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CG = "code-generation";
const REVIEWER = findStageBySlug(CG)!.reviewer!;
const SESSION = "01995000-7a11-7000-8000-00000000a516";
const AS_IT_IS = "approve it as it is";
const NOTE = "A review was asked for and has no verdict yet (it may have been stopped).";
const CLAUDE_NEXT = "`bun .claude/tools/aidlc-orchestrate.ts next`";
const QUESTION = "Approve alpha? Its Code Generation review did not finish.";
const NOTICE = "Approved. The Code Generation review for alpha did not finish.";
const RA = "requirements-analysis";
const RA_REVIEWER = "aidlc-product-lead-agent";
const RA_NOTICE = "Approved. The Requirements Analysis review did not finish.";
const DASH = "\u2014"; // the state file's stage-line separator
type Policy = "off" | "strict";

// The tools as the agent runs them: no test switch stands in for the person.
function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_UNATTENDED: "0" };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  return env;
}

function tool(p: string, name: string, args: string[], env: NodeJS.ProcessEnv = agentEnv()) {
  const result = spawnSync(process.execPath, [
    join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env });
  const last = (result.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(last); } catch { json = null; }
  return { status: result.status, json, out: `${result.stdout}${result.stderr}` };
}

// What the person types, through the real prompt hook every harness uses, and
// the context the agent hears from it.
function says(p: string, prompt: string, session = SESSION): string {
  const env: NodeJS.ProcessEnv = { ...agentEnv(), AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return heard(result.stdout ?? "");
}

// The agent-facing context lines in a hook's stdout.
function heard(stdout: string): string {
  const lines: string[] = [];
  for (const line of stdout.split("\n")) {
    try {
      const parsed = JSON.parse(line) as { hookSpecificOutput?: { additionalContext?: unknown } };
      const text = parsed.hookSpecificOutput?.additionalContext;
      if (typeof text === "string") lines.push(text);
    } catch { /* not hook JSON */ }
  }
  return lines.join("\n");
}

const events = (p: string, name: string) => readAuditShardEvents(p).filter((row) => row.event === name);

// --- A solo unit-major walk with Unit checkpoints on (Code Generation only). ---

function fixture(policy: Policy, reviewClass: "advisory" | "adversarial" = "advisory"): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  const skipped = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"];
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: A review that was stopped
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: classic
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Guard Policy**: ${policy} (set by you)
- **Review Override**: ${reviewClass}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${skipped.map((stage) => `- [S] ${stage} ${DASH} SKIP`).join("\n")}
- [-] code-generation ${DASH} EXECUTE
- [ ] build-and-test ${DASH} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic" }, p);
  recordCommand(p);
  return p;
}

function recordCommand(p: string): void {
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "const fs=require('node:fs'); for(const unit of ['alpha','beta']) if(!fs.readFileSync('src/'+unit+'.ts','utf8').includes(unit))process.exit(1);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", CG, "--checkpoint", "verification-command", "--command", command, "--session", "stopped-review-command"];
  expect(tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]).status).toBe(0);
  says(p, "Approve", "stopped-review-command");
  for (const args of [["log", "answer", ...identity, "--details", "Approve"], ["state", "set-construction-verification-command", command]]) {
    const recorded = tool(p, args[0], args.slice(1));
    expect(recorded.status, recorded.out).toBe(0);
  }
}

// The Unit's Code Generation written and completed.
function build(p: string, unit: string): void {
  const stage = findStageBySlug(CG)!;
  const output = join(seededRecordDir(p), "construction", unit, CG);
  mkdirSync(output, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
  writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
    stage: CG, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
  }));
  appendAuditEntry("UNIT_COMPLETED", {
    Stage: CG, Unit: unit, Mode: "wave",
    "Run floor": latestMainWorkflowStageRunFloorForProject(p, CG, true, unit),
    "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true })!,
  }, p);
}

const reviewArgs = (unit: string, iteration: number) =>
  ["review", "--stage", CG, "--reviewer", REVIEWER, "--unit", unit, "--iteration", String(iteration)];

// The agent asks for the Unit's review; the reviewer's answer is optional.
function review(p: string, unit: string, verdict?: "READY" | "NOT-READY", extra: string[] = []): void {
  const requested = tool(p, "log", [...reviewArgs(unit, 1), ...extra]);
  expect(requested.status, requested.out).toBe(0);
  if (verdict === undefined) return;
  const file = String(requested.json?.reviewFile);
  mkdirSync(dirname(join(p, file)), { recursive: true });
  writeFileSync(join(p, file), `**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\n` +
    (verdict === "READY" ? "No blocking findings.\n" :
      "| ID | Severity | Location | Finding | Required action | Status |\n|---|---|---|---|---|---|\n" +
      `| R-01 | Major | src/${unit}.ts | It is not covered. | Cover it. | New |\n`));
  const recorded = tool(p, "log", [...reviewArgs(unit, 1), "--verdict", verdict]);
  expect(recorded.status, recorded.out).toBe(0);
}

// The review stopped twice with nothing written: the one retry, then the
// NOT-READY fallback the agent records with no review file.
function fallback(p: string, unit: string): void {
  review(p, unit);
  review(p, unit, undefined, ["--retry-pending"]);
  const recorded = tool(p, "log", [...reviewArgs(unit, 1), "--verdict", "NOT-READY"]);
  expect(recorded.status, recorded.out).toBe(0);
}

type Directive = {
  kind: string; stage?: string; unit?: string; protocol_modules?: string[];
  construction_checkpoint?: {
    unit: string; ready: boolean; verified: boolean;
    rereview?: { command: string; unfinished?: string };
    review_not_finished?: { stages: string[]; question: string };
  };
};

// The step `next` routes, seen as a route check (it records nothing).
function routed(p: string): Directive {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, [], {
    env: { ...agentEnv(), AIDLC_ROUTE_CHECK: "1" },
  });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Directive;
}

function checkpoint(p: string, unit: string, action: string, extra: string[] = []) {
  return tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", action, "--session", SESSION, ...extra]);
}

const unitApprovals = (p: string, unit: string) => events(p, "GATE_APPROVED")
  .filter((row) => auditBlockField(row.block, "Checkpoint") === "construction-unit" && auditBlockField(row.block, "Unit") === unit);

// After alpha: beta is built, reviewed and approved as usual, and one bare
// `next` closes Code Generation. Strict closes a stage only against the record
// of the workspace it started from, which this fixture never wrote, so that
// last step is read under off.
function walkCarriesOn(p: string, policy: Policy): void {
  build(p, "beta");
  review(p, "beta", "READY");
  expect(checkpoint(p, "beta", "verify").json?.verified).toBe(true);
  expect(checkpoint(p, "beta", "ask").status).toBe(0);
  says(p, "Approve");
  const approved = checkpoint(p, "beta", "approve", ["--user-input", "Approve"]);
  expect(approved.json?.approved, approved.out).toBe(true);
  expect(approved.json?.change_notices ?? []).not.toContainEqual(expect.stringContaining("did not finish"));
  if (policy === "strict") return;
  const settled = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, [], { env: agentEnv() });
  expect((settled.directive as Directive | null)?.kind, settled.out).not.toBe("error");
  expect(readFileSync(seededStateFile(p), "utf-8")).toMatch(/^- \[x\] code-generation /m);
  expect(events(p, "GATE_REJECTED")).toHaveLength(0);
}

// --- A stage gate: Requirements Analysis with its advisory review. ---

function inception(policy: Policy): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, "state-mid-inception.md");
  const path = seededStateFile(p);
  writeFileSync(path, readFileSync(path, "utf-8").replace(/^- \*\*Change Control\*\*: .*$/m, `- **Guard Policy**: ${policy} (set by you)`));
  const dir = join(seededRecordDir(p), "inception", RA);
  mkdirSync(dir, { recursive: true });
  for (const name of ["requirements.md", "requirements-analysis-questions.md"]) writeFileSync(join(dir, name), `# ${name}\n`);
  return p;
}

// The stage tools as the agent runs them, with the stage's own document
// checks held aside (the review is what is under test here).
const stageEnv = (): NodeJS.ProcessEnv => ({
  ...agentEnv(),
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SESSION_OVERRIDE: SESSION,
});
const raReview = (p: string, extra: string[] = []) =>
  tool(p, "log", ["review", "--stage", RA, "--reviewer", RA_REVIEWER, "--iteration", "1", ...extra], stageEnv());

function report(p: string, args: string[]): Record<string, unknown> {
  const r = tool(p, "orchestrate", ["report", ...args], stageEnv());
  const line = r.out.split("\n").find((entry) => entry.startsWith("{"));
  expect(line, r.out).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

const notices = (directive: Record<string, unknown>): string[] =>
  Array.isArray(directive.change_notices) ? directive.change_notices as string[] : [];

describe("(a) the person writes while a review has no verdict: the agent hears to run next first", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: the note comes while the review waits, and not before or after it`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      expect(says(p, "how is it going?")).not.toContain(NOTE);
      review(p, "alpha");
      const first = says(p, AS_IT_IS);
      expect(first).toContain(NOTE);
      expect(first).toContain(`Run ${CLAUDE_NEXT} before retrying it or recording anything, and follow the step it prints.`);
      // Stopped again after the one retry: the same note.
      review(p, "alpha", undefined, ["--retry-pending"]);
      expect(says(p, "no, don't run the review again, approve the unit as it is")).toContain(NOTE);
      // `next` names the step for that review (the retry, and the person's way on).
      const step = routed(p);
      expect(step.construction_checkpoint?.rereview?.unfinished).toBe("no-verdict");
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("no note once the verdict is recorded", () => {
    const p = fixture("off");
    build(p, "alpha");
    review(p, "alpha", "READY");
    expect(says(p, "looks good")).not.toContain(NOTE);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("no note on the person's reply to the question asked over the unfinished review", () => {
    const p = fixture("off");
    build(p, "alpha");
    review(p, "alpha");
    expect(says(p, AS_IT_IS)).toContain(NOTE);
    const verified = checkpoint(p, "alpha", "verify", ["--over-unfinished-review"]);
    expect(verified.json?.verified, verified.out).toBe(true);
    expect(checkpoint(p, "alpha", "ask").status).toBe(0);
    expect(says(p, "yes")).not.toContain(NOTE);
    const approved = checkpoint(p, "alpha", "approve", ["--user-input", "yes"]);
    expect(approved.json?.approved, approved.out).toBe(true);
    // Approved over it, the review that never finished asks for nothing more.
    expect(says(p, "carry on")).not.toContain(NOTE);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("no note outside a workflow", () => {
    const p = createTestProject();
    projects.push(p);
    expect(says(p, AS_IT_IS)).toBe("");
    expect(existsSync(seededStateFile(p))).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: at a stage, the same note while its review waits`, () => {
      const p = inception(policy);
      expect(raReview(p).status).toBe(0);
      expect(says(p, "I don't need another review, approve it")).toContain(NOTE);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("Kiro CLI: the prompt adapter carries the note, with Kiro's own next", () => {
    const p = inception("off");
    cpSync(join(REPO_ROOT, "dist", "kiro", ".kiro"), join(p, ".kiro"), { recursive: true });
    expect(raReview(p).status).toBe(0);
    const r = spawnSync(process.execPath, [join(p, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "verb-intercept"], {
      cwd: p,
      input: JSON.stringify({ cwd: p, session_id: SESSION, prompt: AS_IT_IS }),
      encoding: "utf-8",
      env: { ...agentEnv(), CLAUDE_PROJECT_DIR: p, AIDLC_SESSION_OVERRIDE: SESSION },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(NOTE);
    expect(r.stdout).toContain("`bun .kiro/tools/aidlc-orchestrate.ts next`");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("(b) the NOT-READY fallback the agent records reads as a review that did not finish", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: at a Unit checkpoint, asked and approved as not finished, and the walk carries on`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      fallback(p, "alpha");
      const completed = events(p, "REVIEW_COMPLETED").at(-1);
      expect(auditBlockField(completed?.block ?? "", "Review Finished"), completed?.block).toBe("no");
      const shown = routed(p);
      expect(shown.construction_checkpoint, JSON.stringify(shown).slice(0, 800)).toMatchObject({ unit: "alpha", ready: true });
      expect(shown.construction_checkpoint?.review_not_finished).toEqual({ stages: [CG], question: QUESTION });
      expect(shown.protocol_modules ?? []).not.toContain("learnings");
      const verified = checkpoint(p, "alpha", "verify");
      expect(verified.json?.verified, verified.out).toBe(true);
      expect(verified.json?.review_not_finished).toEqual({ stages: [CG], question: QUESTION });
      expect(checkpoint(p, "alpha", "ask").status).toBe(0);
      says(p, "yes");
      const approved = checkpoint(p, "alpha", "approve", ["--user-input", "yes"]);
      expect(approved.json?.approved, approved.out).toBe(true);
      expect(approved.json?.change_notices).toEqual([NOTICE]);
      const approvals = unitApprovals(p, "alpha");
      expect(approvals).toHaveLength(1);
      expect(auditBlockField(approvals[0].block, "Review")).toBe("not finished");
      walkCarriesOn(p, policy);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  // An adversarial review keeps a pass after the fallback: that pass is a
  // review that did not finish, with nothing to repair.
  test("Guard Policy off, adversarial: the pass left after the fallback is named as a review that did not finish", () => {
    const p = fixture("off", "adversarial");
    build(p, "alpha");
    fallback(p, "alpha");
    const step = routed(p);
    expect(step.construction_checkpoint).toMatchObject({ unit: "alpha", ready: false });
    expect(step.construction_checkpoint?.rereview?.unfinished).toBe("no-verdict");
    expect(step.construction_checkpoint?.rereview?.command).toContain(reviewArgs("alpha", 2).join(" "));
    const refused = checkpoint(p, "alpha", "verify");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("The Code Generation review for alpha did not finish.");
    expect(refused.out).not.toContain("NOT-READY with a pass left");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a fallback recorded before the mark is known by its empty record", () => {
    const p = fixture("off");
    build(p, "alpha");
    fallback(p, "alpha");
    const dir = seededAuditDir(p);
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const path = join(dir, name);
      writeFileSync(path, readFileSync(path, "utf-8").replace(/^(?:- )?\*\*Review Finished\*\*: no\r?\n/m, ""));
    }
    expect(auditBlockField(events(p, "REVIEW_COMPLETED").at(-1)?.block ?? "", "Review Finished")).toBeNull();
    expect(routed(p).construction_checkpoint?.review_not_finished).toEqual({ stages: [CG], question: QUESTION });
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a reviewer's own NOT-READY stays the reviewer's verdict", () => {
    const p = fixture("off");
    build(p, "alpha");
    review(p, "alpha", "NOT-READY");
    expect(auditBlockField(events(p, "REVIEW_COMPLETED").at(-1)?.block ?? "", "Review Finished")).toBeNull();
    expect(routed(p).construction_checkpoint?.review_not_finished).toBeUndefined();
    const verified = checkpoint(p, "alpha", "verify");
    expect(verified.json?.verified, verified.out).toBe(true);
    expect(verified.json?.review_not_finished).toBeUndefined();
    expect(checkpoint(p, "alpha", "ask").status).toBe(0);
    says(p, "yes");
    const approved = checkpoint(p, "alpha", "approve", ["--user-input", "yes"]);
    expect(approved.json?.approved, approved.out).toBe(true);
    expect(approved.json?.change_notices ?? []).not.toContain(NOTICE);
    expect(auditBlockField(unitApprovals(p, "alpha")[0].block, "Review")).toBeNull();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: at a stage gate, the approval is recorded as over a review that did not finish`, () => {
      const p = inception(policy);
      expect(raReview(p).status).toBe(0);
      expect(raReview(p, ["--retry-pending"]).status).toBe(0);
      const recorded = raReview(p, ["--verdict", "NOT-READY"]);
      expect(recorded.status, recorded.out).toBe(0);
      expect(auditBlockField(events(p, "REVIEW_COMPLETED").at(-1)?.block ?? "", "Review Finished")).toBe("no");
      const gate = report(p, ["--stage", RA, "--result", "awaiting-approval"]);
      expect(gate.kind, JSON.stringify(gate)).not.toBe("error");
      says(p, "Approve");
      const done = report(p, ["--result", "approved", "--user-input", "Approve"]);
      expect(done.kind, JSON.stringify(done)).toBe("done");
      expect(notices(done)).toContain(RA_NOTICE);
      const approved = events(p, "GATE_APPROVED");
      expect(approved).toHaveLength(1);
      expect(auditBlockField(approved[0].block, "Review")).toBe("not finished");
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("a stage review that finished READY is approved as usual", () => {
    const p = inception("off");
    const requested = raReview(p);
    expect(requested.status).toBe(0);
    const file = String(requested.json?.reviewFile);
    writeFileSync(join(p, file),
      `## Review\n\n**Verdict:** READY\n**Reviewer:** ${RA_REVIEWER}\n**Iteration:** 1\n\n` +
        "### Findings\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n");
    expect(raReview(p, ["--verdict", "READY"]).status).toBe(0);
    report(p, ["--stage", RA, "--result", "awaiting-approval"]);
    says(p, "Approve");
    const done = report(p, ["--result", "approved", "--user-input", "Approve"]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(notices(done)).not.toContain(RA_NOTICE);
    expect(auditBlockField(events(p, "GATE_APPROVED")[0].block, "Review")).toBeNull();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("the reviewer protocol says when the agent retries and when it runs next", () => {
  test("core and every projected copy carry the rule", () => {
    const module = join("aidlc-common", "protocols", "stage-protocol-reviewer.md");
    for (const path of [join(REPO_ROOT, "core", module), join(AIDLC_SRC, module), join(REPO_ROOT, "dist", "kiro", ".kiro", module)]) {
      const body = readFileSync(path, "utf-8").replace(/\s+/g, " ");
      const labelled = `${path}\n${body}`;
      expect(labelled).toContain(
        "When the person has written since this review was dispatched (they stopped it, or said anything at all), " +
          "re-run `next` first and follow the step it prints together with what they asked.",
      );
      expect(labelled).toContain(
        "Never retry the review or record the NOT-READY fallback (step 3) on your own then: the retry and the fallback " +
          "are for a review that stopped with no person involved (its turn cap, a session that died).",
      );
      expect(labelled).toContain("When the person has written since the dispatch, step 1's rule comes first.");
      expect(labelled).toContain("The person hears that the review did not finish, never that the reviewer found the work not ready.");
    }
  });
});
