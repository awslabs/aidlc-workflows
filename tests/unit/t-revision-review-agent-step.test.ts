// covers: function:evaluateGuardRefusal, subcommand:aidlc-orchestrate:report
//
// A revision reported done before its review is the agent's own step to
// finish, not a restart put to the person. Seen live on Kiro CLI at high
// context (and on Copilot CLI on Windows Server): at the open Requirements
// gate the person asked for a change; the agent recorded Request Changes,
// edited requirements.md and reported `revised` without running the stage's
// review again. The refusal (REVIEW_EVIDENCE_MISSING, the stage revising) held
// no way on the agent could take, because the review remedies counted only an
// in-progress or awaiting-approval stage as open, so the person read "can't go
// ahead as things stand" with one choice, "Start the stage over": the summary
// confirmed again and every document saved again, for a review nobody ran.
//
// Now a revising stage is open for its own review: the first refusal is the
// agent's work (request the review, have it recorded, report `revised`), the
// gate comes back with the review, and the same refusal twice still asks the
// person, as before.
//
// Mechanism: cli, over the answers corpus "stage-gate" fixture (Requirements
// Analysis reviewed READY, summary confirmed, gate open), the real human-turn
// hook, the real `report` and `log review`; plus evaluateGuardRefusal's pure
// cases for each review remedy in a revising stage.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateGuardRefusal, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { buildQuestion, STAGE } from "../harness/aidlc-answers-corpus.ts";
import { env, exec, LOG, ORCHESTRATE, say } from "../harness/aidlc-input-corpus.ts";
import {
  cleanupTestProject, createOrchestrationTestProject, recordArtifactWriteViaHook, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

const REVIEWER = "aidlc-product-lead-agent";
const CHANGE = "2. Add one line to the requirements: the password check is case-sensitive.";

interface Directive {
  kind?: string;
  ask_type?: string;
  agent_work?: boolean;
  message?: string;
  question?: string;
  remedies?: Array<{ op: string }>;
}

async function gateOpen(policy: "strict" | "off"): Promise<string> {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  await buildQuestion(proj, "stage-gate");
  if (policy === "off") {
    // The bugfix scope's own default, as in the live run.
    const file = seededStateFile(proj);
    const text = readFileSync(file, "utf-8");
    writeFileSync(file, /\*\*Guard Policy\*\*/.test(text)
      ? text.replace(/- \*\*Guard Policy\*\*:.*$/m, "- **Guard Policy**: off (from scope bugfix)")
      : text.replace(/- \*\*Change Control\*\*:.*$/m, "- **Guard Policy**: off (from scope bugfix)"), "utf-8");
  }
  return proj;
}

async function run(proj: string, tool: string, args: string[]): Promise<{ status: number; out: string; directive: Directive | null }> {
  const res = await exec([process.execPath, tool, ...args, "--project-dir", proj], { cwd: proj, env: env(proj) });
  let directive: Directive | null = null;
  try {
    directive = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "") as Directive;
  } catch {
    directive = null;
  }
  return { status: res.status, out: `${res.stdout}${res.stderr}`, directive };
}

const report = (proj: string, result: string, extra: string[] = []) =>
  run(proj, ORCHESTRATE, ["report", "--stage", STAGE, "--result", result, ...extra]);

// The person's change at the gate, recorded; then the agent's edit of the document.
async function changeRecordedAndMade(proj: string): Promise<void> {
  expect((await say(proj, CHANGE, "claude")).status).toBe(0);
  const rejected = await report(proj, "rejected", ["--user-input", "Request Changes", "--reason", "Add the case-sensitive check"]);
  expect(rejected.directive?.kind, rejected.out).toBe("print");
  const doc = join(seededRecordDir(proj), "inception", STAGE, "requirements.md");
  writeFileSync(doc, `${readFileSync(doc, "utf-8")}\n- FR-9: the password check is case-sensitive.\n`, "utf-8");
  recordArtifactWriteViaHook(proj, doc);
}

// The stage's review of the revision, as the reviewer subagent leaves it.
async function reviewed(proj: string): Promise<void> {
  const asked = await run(proj, LOG, ["review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1"]);
  expect(asked.status, asked.out).toBe(0);
  const file = (asked.directive as { reviewFile?: string } | null)?.reviewFile;
  expect(file, asked.out).toBeDefined();
  writeFileSync(join(proj, file as string),
    `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
      "### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n**New findings**\n\n" +
      "| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n", "utf-8");
  const recorded = await run(proj, LOG, ["review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1", "--verdict", "READY"]);
  expect(recorded.status, recorded.out).toBe(0);
}

describe("a revision reported before its review", () => {
  for (const policy of ["strict", "off"] as const) {
    test(`Guard Policy ${policy}: the agent is sent to run the review, and the person is asked nothing`, async () => {
      const proj = await gateOpen(policy);
      await changeRecordedAndMade(proj);
      const early = await report(proj, "revised");
      expect(early.directive?.kind, early.out).toBe("ask");
      expect(early.directive?.agent_work, early.out).toBe(true);
      expect(early.directive?.remedies?.[0]?.op, early.out).toBe("request-review");
      expect(early.directive?.remedies?.map((remedy) => remedy.op), early.out).not.toContain("redo-jump");
      await reviewed(proj);
      const done = await report(proj, "revised");
      expect(done.directive?.kind, done.out).toBe("print");
      expect(done.directive?.message, done.out).toContain("Recorded revised");
      const events = readAuditShardEvents(proj).map((row) => row.event);
      expect(events).not.toContain("STAGE_JUMPED");
      expect(events.at(-1), events.join(",")).toBe("STAGE_AWAITING_APPROVAL");
    });
  }

  test("the same refusal twice still puts the person's ways on to them", async () => {
    const proj = await gateOpen("off");
    await changeRecordedAndMade(proj);
    expect((await report(proj, "revised")).directive?.agent_work).toBe(true);
    const again = await report(proj, "revised");
    expect(again.directive?.kind, again.out).toBe("ask");
    expect(again.directive?.agent_work, again.out).toBeUndefined();
    expect(again.directive?.remedies?.map((remedy) => remedy.op), again.out).toContain("redo-jump");
  });
});

describe("evaluateGuardRefusal: a revising stage is open for its own review", () => {
  const revising = [
    "# AI-DLC State",
    "- **Scope**: feature",
    "- [R] functional-design \u2014 EXECUTE",
    "",
  ].join("\n");
  const base = {
    code: "REVIEW_EVIDENCE_MISSING",
    blockedAction: "present-approval-gate",
    stage: "functional-design",
    projectDir: "/workspace",
    stateContent: revising,
    invariant: "A revision is reviewed before its gate opens again.",
    userMessage: "blocked",
    humanAuthority: { freshTurn: false, unattended: false },
  };
  const remedy = (attempt: Parameters<typeof evaluateGuardRefusal>[0]["attempt"], op: string) => {
    const refusal = evaluateGuardRefusal({ ...base, attempt });
    expect(refusal.state).toBe("revising");
    return refusal.remedies.find((entry) => entry.op === op);
  };

  test("no review of the revision yet: requesting it is the agent's step now", () => {
    expect(remedy({ recovery: "spent", summaryCoverage: "current", reviewCoverage: "missing", sourceCoverage: "current" },
      "request-review")).toMatchObject({ requiresHuman: false, executableNow: true });
  });

  test("a review gone stale with its recovery unused: the recovery review is the agent's step now", () => {
    expect(remedy({ recovery: "available", summaryCoverage: "current", reviewCoverage: "stale", sourceCoverage: "current" },
      "start-recovery-review")).toMatchObject({ requiresHuman: false, executableNow: true });
  });

  test("the reviewer's next pass and its repairs are the agent's step now", () => {
    const attempt = { recovery: "spent" as const, summaryCoverage: "current" as const, reviewCoverage: "stale" as const,
      sourceCoverage: "current" as const };
    expect(remedy({ ...attempt, nextReview: { iteration: 2 } }, "request-review"))
      .toMatchObject({ requiresHuman: false, executableNow: true });
    expect(remedy({ ...attempt, repairReview: { iteration: 1 } }, "apply-repairs-then-request"))
      .toMatchObject({ requiresHuman: false, executableNow: true });
  });

  test("a summary that no longer covers the documents still comes first", () => {
    expect(remedy({ recovery: "spent", summaryCoverage: "stale", reviewCoverage: "missing", sourceCoverage: "current" },
      "request-review")?.executableNow).toBe(false);
  });
});
