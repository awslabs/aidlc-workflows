// covers: function:unchangedChangeRequest, function:keptReviewRejections, function:reviewAttemptWindow, subcommand:aidlc-orchestrate:report, hook:aidlc-review-freeze
//
// A Request Changes that changed nothing brings the same gate back, with the review as it stands. At a reviewed gate
// the person rejected one open finding ("reject R-02, ..."): the agent recorded Request Changes with the finding
// rejected, had nothing to change, and reported the stage revised. The engine took every Request Changes for the
// start of a new review round, so the review it was made on no longer counted: the gate shown again was refused for
// want of a new review, and the same report again left the person one way, "Start the stage over". The stage
// protocol's own undo for a misread Request Changes (report revised) met the same refusal.
//
// Now `revise` keeps the review when nothing of the stage changed after the Request Changes (no review asked or
// recorded since, and the review still covers the documents byte for byte) and records that on the gate's row; the
// review window and its accounting read that record. A change request that did change a document still gets its
// review, and while the stage is revising nothing is kept, so the revision's first edit is never frozen.
//
// Mechanism: cli, over the answers corpus Requirements Analysis gate with two open findings, the real human-turn
// hook, the real report, log review, review brief and review-freeze hook.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { STAGE } from "../harness/aidlc-answers-corpus.ts";
import { env, exec, LOG, next, ORCHESTRATE, reviewedStage, say } from "../harness/aidlc-input-corpus.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, recordArtifactWriteViaHook, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

const REVIEWER = "aidlc-product-lead-agent";
const FINDINGS = [
  "| Medium | requirements.md | A title of only spaces is not said to be blank | Say that it is refused |",
  "| Low | requirements.md | FR-1 has no acceptance check | Add one |",
];
const REASON = "an acceptance check is not needed for this fix";
const LINE =
  "Approve accepts the open review finding R-01 (A title of only spaces is not said to be blank) as risk; you can " +
  "also approve and ask for it to be fixed, or reject it as not applying, saying why.";

interface Directive {
  kind?: string;
  message?: string;
  gate_only?: boolean;
  agent_work?: boolean;
  reason_codes?: string[];
  remedies?: Array<{ op: string }>;
}

type Policy = "strict" | "relaxed" | "off";

async function gateOpen(policy: Policy = "strict"): Promise<string> {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  await reviewedStage(proj, FINDINGS);
  if (policy !== "strict") {
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8")
      .replace(/- \*\*Change Control\*\*:.*$/m, `- **Guard Policy**: ${policy} (from scope bugfix)`), "utf-8");
  }
  expect((await report(proj, "awaiting-approval")).directive?.kind).not.toBe("error");
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

const requirements = (proj: string): string => join(seededRecordDir(proj), "inception", STAGE, "requirements.md");

function edit(proj: string): void {
  const doc = requirements(proj);
  writeFileSync(doc, `${readFileSync(doc, "utf-8")}- FR-9: the check is case-sensitive.\n`, "utf-8");
  recordArtifactWriteViaHook(proj, doc);
}

// The person's reply, then the agent's record of it as Request Changes (with R-02 rejected, when they rejected it).
async function changeRequested(proj: string, words: string, rejectR02: boolean): Promise<void> {
  expect((await say(proj, words, "claude")).status).toBe(0);
  const rejected = await report(proj, "rejected", [
    "--user-input", "Request Changes", ...(rejectR02 ? ["--reject-finding", `requirements#R-02=${REASON}`] : []),
  ]);
  expect(rejected.directive?.kind, rejected.out).toBe("print");
}

async function reviewed(proj: string, iteration: number): Promise<void> {
  const asked = await run(proj, LOG, ["review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", String(iteration)]);
  expect(asked.status, asked.out).toBe(0);
  const file = (asked.directive as { reviewFile?: string } | null)?.reviewFile;
  expect(file, asked.out).toBeDefined();
  writeFileSync(join(proj, file as string),
    `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** ${iteration}\n\n` +
      "### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n**New findings**\n\n" +
      "| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n", "utf-8");
  const recorded = await run(proj, LOG, ["review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", String(iteration), "--verdict", "READY"]);
  expect(recorded.status, recorded.out).toBe(0);
}

const rows = (proj: string) => readAuditShardEvents(proj).filter((row) => auditBlockField(row.block, "Stage") === STAGE);
const lastRow = (proj: string, event: string) => rows(proj).findLast((row) => row.event === event);
const sinceLastRejection = (proj: string): string[] => {
  const all = rows(proj);
  const at = all.findLastIndex((row) => row.event === "GATE_REJECTED");
  return all.slice(at + 1).map((row) => row.event);
};

const brief = async (proj: string): Promise<string> => {
  const shown = await run(proj, join(AIDLC_SRC, "tools", "aidlc-review-brief.ts"), ["review", "--stage", STAGE, "--why", "revision"]);
  expect(shown.status, shown.out).toBe(0);
  return shown.out;
};

/** The agent's edit of the reviewed document, through the shipped review-freeze hook: its exit code. */
async function freeze(proj: string): Promise<number> {
  const ran = await exec([process.execPath, join(AIDLC_SRC, "hooks", "aidlc-review-freeze.ts")], {
    cwd: proj,
    env: env(proj),
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: requirements(proj) }, cwd: proj }),
  });
  return ran.status;
}

describe("a Request Changes that changed nothing brings the gate back with its review", () => {
  for (const policy of ["strict", "off"] as const) {
    test(`Guard Policy ${policy}: "reject R-02" brings the same gate back, and Approve accepts only R-01`, async () => {
      const proj = await gateOpen(policy);
      await changeRequested(proj, `reject R-02, ${REASON}`, true);
      const rejection = lastRow(proj, "GATE_REJECTED");

      const back = await report(proj, "revised");
      expect(back.directive?.kind, back.out).toBe("print");
      expect(back.directive?.message, back.out).toContain("Recorded revised");
      expect(sinceLastRejection(proj)).not.toContain("REVIEW_REQUESTED");
      expect(auditBlockField(lastRow(proj, "STAGE_AWAITING_APPROVAL")?.block ?? "", "Review Kept")).toBe(rejection?.timestamp ?? null);

      const shown = await brief(proj);
      expect(shown).toContain(`Rejected: ${REASON}`);
      expect(shown.split("\n").filter((line) => line.startsWith("Approve accepts"))).toEqual([LINE]);

      expect((await say(proj, "Approve", "claude")).status).toBe(0);
      const approved = await report(proj, "approved", ["--user-input", "Approve"]);
      expect(approved.directive?.kind, approved.out).toBe("done");
      const recorded = auditBlockField(lastRow(proj, "GATE_APPROVED")?.block ?? "", "Review Finding Dispositions") ?? "";
      const decided = (JSON.parse(recorded) as { dispositions: Array<{ id: string; status: string }> }).dispositions;
      expect(decided.map(({ id, status }) => `${id} ${status}`)).toEqual(["R-01 Accepted risk"]);
    });
  }

  test("a misread Request Changes undone with revised brings the gate back, the same review on it", async () => {
    const proj = await gateOpen();
    await changeRequested(proj, "hmm, the second point", false);
    expect((await say(proj, "No, I did not ask for a change. Show me the gate again.", "claude")).status).toBe(0);
    const back = await report(proj, "revised");
    expect(back.directive?.kind, back.out).toBe("print");
    expect(sinceLastRejection(proj)).not.toContain("REVIEW_REQUESTED");
    expect(auditBlockField(lastRow(proj, "STAGE_AWAITING_APPROVAL")?.block ?? "", "Review Kept")).not.toBeNull();
  });

  test("at the gate shown again: next shows the gate, the brief says nothing went stale, and the document is frozen as at any reviewed gate", async () => {
    const proj = await gateOpen();
    await changeRequested(proj, `reject R-02, ${REASON}`, true);
    // While the stage is revising, nothing is kept: the revision's first edit is not frozen.
    expect(await freeze(proj)).toBe(0);
    expect((await report(proj, "revised")).directive?.kind).toBe("print");
    const gate = await next(proj, []);
    expect(gate.directive?.gate_only, gate.out).toBe(true);
    const shown = await brief(proj);
    expect(shown).not.toContain("Changed upstream");
    expect(shown).not.toContain("Invalidated");
    expect(await freeze(proj)).toBe(2);
  });
});

describe("a Request Changes that changed something still gets its review", () => {
  test("a revision that edited the document and reports revised without a review is refused for one, and keeps nothing", async () => {
    const proj = await gateOpen();
    await changeRequested(proj, "Add FR-9: the check is case-sensitive.", false);
    expect(await freeze(proj)).toBe(0);
    edit(proj);
    const early = await report(proj, "revised");
    expect(early.directive?.kind, early.out).toBe("ask");
    expect(early.directive?.reason_codes, early.out).toContain("REVIEW_EVIDENCE_MISSING");
    expect(lastRow(proj, "STAGE_AWAITING_APPROVAL")?.block).not.toContain("Review Kept");
  });

  test("an agent that runs the review anyway after a rejection that changed nothing gets its first pass, and the gate", async () => {
    const proj = await gateOpen();
    await changeRequested(proj, `reject R-02, ${REASON}`, true);
    await reviewed(proj, 1);
    const back = await report(proj, "revised");
    expect(back.directive?.kind, back.out).toBe("print");
    expect(auditBlockField(lastRow(proj, "STAGE_AWAITING_APPROVAL")?.block ?? "", "Review Kept")).toBeNull();
  });

  test("after a gate came back with its review, a Request Changes that edits starts a new round: its first pass is admitted", async () => {
    const proj = await gateOpen();
    await changeRequested(proj, `reject R-02, ${REASON}`, true);
    expect((await report(proj, "revised")).directive?.kind).toBe("print");
    await changeRequested(proj, "Add FR-9: the check is case-sensitive.", false);
    edit(proj);
    await reviewed(proj, 1);
    const back = await report(proj, "revised");
    expect(back.directive?.kind, back.out).toBe("print");
    expect(auditBlockField(lastRow(proj, "STAGE_AWAITING_APPROVAL")?.block ?? "", "Review Kept")).toBeNull();
  });

  // The limit, as a decision: under relaxed, a change kept after the review and before the Request Changes cannot be
  // told from one made after it, so the gate does not come back on the earlier review.
  test("Guard Policy relaxed: a change kept after the review, before the Request Changes, keeps today's review step", async () => {
    const proj = await gateOpen("relaxed");
    edit(proj);
    await changeRequested(proj, `reject R-02, ${REASON}`, true);
    const back = await report(proj, "revised");
    expect(back.directive?.kind, back.out).toBe("ask");
    expect(back.directive?.reason_codes, back.out).toContain("REVIEW_EVIDENCE_MISSING");
  });
});
