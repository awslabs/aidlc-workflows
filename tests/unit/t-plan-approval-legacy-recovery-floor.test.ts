// covers: function:recordPlanApprovalLegacyRecoveryAnswer, function:stageReplyFloorTime
//
// The legacy Kiro IDE window's question "bring the code plan back?" is answered
// by the agent's record of the person's yes, once a reply of theirs came after
// the question. A question an older engine asked kept no time, and the engine
// read that as "any reply ever sent in this chat": with one earlier message
// ("continue please") the yes was recorded in their name with no reply to the
// question at all (a challenge pending across an update). Now that reply must
// come after Code Generation started; with no start on record either, the
// question is timed from now and their next reply answers it, asked once.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  readAuditShardEvents,
  readPlanApprovalLegacyRecoveryChallenge,
  writePlanApprovalLegacyRecoveryChallenge,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { recordPlanApprovalLegacyRecoveryAnswer } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR, seededStateFile } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SESSION = "01995000-7a11-7000-8000-00000000f2f2";
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop()!);
});

function project(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  return proj;
}

// Seconds ago, as a record's whole-second time: message records older than a
// day are pruned, so the earlier message is minutes old, not dated.
const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

// A message of the person's in this chat, as the prompt hook keeps it.
function says(proj: string, words: string, at = ago(0)): void {
  const stored = saveMessage(proj, {
    session: SESSION, at, source: "prompt", text: words, picker: null, words, settings: [],
    route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
  });
  appendAuditEntry("HUMAN_TURN", { Session: SESSION, "Message Id": stored.id }, proj);
}

// The question as an engine before #2926 left it: no time kept.
function olderEnginesQuestion(proj: string): void {
  writePlanApprovalLegacyRecoveryChallenge(proj, {
    version: 1, session: SESSION, intentId: "bare-space", markerRevision: 1, challengeId: "c0ffee",
  });
}

const codeGenerationStarted = (proj: string): boolean =>
  readAuditShardEvents(proj).some((row) => row.event === "STAGE_STARTED" && row.block.includes("**Stage**: code-generation"));

describe("t-plan-approval-legacy-recovery-floor: an older engine's recovery question is answered after it, never by any earlier message", () => {
  test("a message from before Code Generation started records no yes; a reply after it does", () => {
    const proj = project();
    says(proj, "continue please", ago(120));
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation" }, proj);
    olderEnginesQuestion(proj);
    expect(recordPlanApprovalLegacyRecoveryAnswer(proj, SESSION)).toBe("no-reply");
    says(proj, "yes, bring it back");
    expect(recordPlanApprovalLegacyRecoveryAnswer(proj, SESSION)).toBe("recorded");
  });

  test("with no start on record either, the question is timed from now and their next reply answers it", () => {
    const proj = project();
    expect(codeGenerationStarted(proj)).toBe(false);
    says(proj, "continue please", ago(120));
    olderEnginesQuestion(proj);
    expect(recordPlanApprovalLegacyRecoveryAnswer(proj, SESSION)).toBe("no-reply");
    expect(readPlanApprovalLegacyRecoveryChallenge(proj, SESSION)?.createdAt).toBeDefined();
    says(proj, "yes, bring it back");
    expect(recordPlanApprovalLegacyRecoveryAnswer(proj, SESSION)).toBe("recorded");
  });

  test("a question this engine asks keeps its time, and a reply after it records the yes", () => {
    const proj = project();
    says(proj, "continue please", ago(120));
    writePlanApprovalLegacyRecoveryChallenge(proj, {
      version: 1, session: SESSION, intentId: "bare-space", markerRevision: 1, challengeId: "c0ffee",
      createdAt: ago(60),
    });
    expect(recordPlanApprovalLegacyRecoveryAnswer(proj, SESSION)).toBe("no-reply");
    says(proj, "yes, bring it back");
    expect(recordPlanApprovalLegacyRecoveryAnswer(proj, SESSION)).toBe("recorded");
  });
});
