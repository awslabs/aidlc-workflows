// covers: voice-layer:error-recovery
//
// t327 - refusal narration and plain-language error strings. Static source
// checks keep the wording contract aligned across harnesses and prevent the
// workshop-facing gate/question/review paths from regressing to internal names.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

function functionBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `missing start marker: ${start}`).toBeGreaterThan(-1);
  expect(to, `missing end marker: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("t327 refusal narration contract", () => {
  test("the shared voice contract translates refusals and stops repeated retries", () => {
    const protocol = read("core/aidlc-common/protocols/stage-protocol.md")
      .replace(/\s+/g, " ");
    expect(protocol).toContain("translate the refusal instead of relaying it");
    expect(protocol).toContain("Leave the refusal text in the tool result");
    expect(protocol).toContain('emits `directive.kind === "error"`');
    expect(protocol).toContain("Corrected incidental arguments retain the identity");
    expect(protocol).toContain("changing the operation or target creates a new identity");
    expect(protocol).toContain("even if unrelated actions succeeded between attempts");
    expect(protocol).toContain("when that identity succeeds");
    expect(protocol).toContain("the human explicitly abandons it");
    expect(protocol).toContain("a workflow transition changes its operation or target");
    expect(protocol).toContain("two refused review requests with corrected flags reach the limit");
    expect(protocol).toContain("a successful unrelated status check between them does not reset it");
    expect(protocol).toContain("a different review target");
    expect(protocol).toContain("`/aidlc --doctor`");
    expect(protocol).toContain("Never read framework or workflow source files");
  });

  test("every harness carries the same refusal clause", () => {
    const marker = "**When an action is refused.**";
    const clauses = new Map<string, string[]>();
    for (const harness of HARNESS_MATRIX) {
      const rel = `harness/${harness.name}/skills/aidlc/SKILL.md`;
      const body = read(rel);
      const start = body.indexOf(marker);
      expect(start, `${rel} lacks the refusal clause`).toBeGreaterThan(-1);
      const clause = body.slice(start).split("\n\n")[0];
      const names = clauses.get(clause) ?? [];
      names.push(harness.name);
      clauses.set(clause, names);
      expect(clause).toContain('emits `directive.kind === "error"`');
      expect(clause).toContain("Corrected incidental arguments retain the identity");
      expect(clause).toContain("changing the operation or target creates a new identity");
      expect(clause).toContain("even if unrelated actions succeeded between attempts");
      expect(clause).toContain("when that identity succeeds");
      expect(clause).toContain("the human explicitly abandons it");
      expect(clause).toContain("a workflow transition changes its operation or target");
      expect(clause).toContain("two refused review requests with corrected flags reach the limit");
      expect(clause).toContain("a successful unrelated status check between them does not reset it");
      expect(clause).toContain("a different review target");
      expect(clause).toContain("never read framework or workflow source files");
      expect(body).toContain(
        '| `error` | Print `directive.message` verbatim and STOP. Do not recover, retry, or smooth it over — the message is the user-facing error. |',
      );
    }
    expect([...clauses.values()].map((names) => names.sort())).toHaveLength(1);
  });
});

describe("t327 rewritten refusal strings stay in project language", () => {
  test("gate and review preconditions name the project action and next step", () => {
    const state = read("core/tools/aidlc-state.ts");
    const reviewErrors = functionBody(
      state,
      "function staleReviewPreconditionError(",
      "function reviewRecoverySpentInCurrentAttempt(",
    );
    const rewrittenStart = reviewErrors.indexOf(
      "because an output document changed after",
    );
    expect(rewrittenStart).toBeGreaterThan(-1);
    const rewrittenErrors = reviewErrors.slice(rewrittenStart);
    expect(rewrittenErrors).toContain("output document changed after");
    expect(rewrittenErrors).toContain("has not reviewed the current output");
    expect(rewrittenErrors).toContain("aidlc-log.ts review --stage");
    for (const leaked of [
      "terminal review receipt from",
      "fresh REVIEW_COMPLETED",
      "stage-protocol-reviewer.md §12a",
      "produces[] artifact",
    ]) {
      expect(rewrittenErrors).not.toContain(leaked);
    }
  });

  test("question and review logging errors omit audit event names and field jargon", () => {
    const log = read("core/tools/aidlc-log.ts");
    const spentStart = log.indexOf("function reviewRecoverySpentMessage(");
    const spentEnd = log.indexOf(
      "function reviewRecoveryAlreadyRequestedMessage(",
      spentStart,
    );
    expect(spentStart).toBeGreaterThan(-1);
    expect(spentEnd).toBeGreaterThan(spentStart);
    const rewrittenLog = log.slice(0, spentStart) + log.slice(spentEnd);
    expect(rewrittenLog).toContain("Cannot record this answer");
    expect(rewrittenLog).toContain("Cannot request review pass");
    expect(rewrittenLog).toContain("its output documents changed");
    expect(rewrittenLog).toContain("after review iteration");
    const stageExpression = "$" + "{flags.stage}";
    for (const leaked of [
      "Refusing REVIEW_REQUESTED",
      `Refusing REVIEW_COMPLETED for "${stageExpression}": no unmatched`,
      "declared artifacts changed after",
      "current audit attempt",
      "produces[] artifacts after a review receipt",
    ]) {
      expect(rewrittenLog).not.toContain(leaked);
    }
    expect(log).toContain(
      `Refusing REVIEW_COMPLETED for "${stageExpression}": the matching REVIEW_REQUESTED`,
    );
    expect(log).toContain("workspace source changed after");
    expect(log).toContain("unit source or source-manifest.json");
  });

  test("recovery-spent refusals retain state-aware routing", () => {
    const log = read("core/tools/aidlc-log.ts");
    const spent = functionBody(
      log,
      "function reviewRecoverySpentMessage(",
      "function reviewRecoveryAlreadyRequestedMessage(",
    );
    expect(spent).toContain("(guidance ?? \"\")");
    expect(log).toContain("reviewRecoveryGuidance(pd, state, flags.stage)");
    expect(log).not.toContain("stop and present the approval gate");

    const state = read("core/tools/aidlc-state.ts");
    expect(state).toContain("recoveryGuidance(pd, content, stage.slug)");
    expect(state).toContain("recoveryGuidance(pd, content, slug)");
    expect(state).not.toContain(
      "present the situation to the human at the approval gate. Only a human",
    );
  });

  test("blocking hooks explain the declined project action before exact recovery commands", () => {
    const plan = read("core/hooks/aidlc-plan-approval-guard.ts");
    const scope = read("core/hooks/aidlc-reviewer-scope.ts");
    const transition = read("core/hooks/aidlc-state-transition-guard.ts");
    expect(plan).toContain("Code generation cannot start");
    expect(plan).toContain("code-generation-plan.md");
    expect(scope).toContain("This review cannot open");
    expect(scope).toContain("variables cannot be checked");
    expect(scope).toContain("the current unit.");
    expect(transition).toContain("Stage status cannot be changed");
    expect(transition).toContain("aidlc-orchestrate.ts report");
    expect(plan).not.toContain("`plan-approval guard:");
    expect(scope).not.toContain("reviewer read-scope:");
    expect(transition).not.toContain("workflow lifecycle and routing are conductor-owned");
  });

  test("approval evidence errors no longer expose topology or audit vocabulary", () => {
    const orchestrate = read("core/tools/aidlc-orchestrate.ts");
    expect(orchestrate).toContain("collaborator notes are missing or");
    expect(orchestrate).toContain("incomplete:");
    expect(orchestrate).toContain("pipeline handoffs have not");
    expect(orchestrate).toContain("been recorded for the current run");
    expect(orchestrate).not.toContain("ensemble must convene");
    expect(orchestrate).not.toContain("current-attempt PIPELINE_LINK_COMPLETED receipt");
  });
});
