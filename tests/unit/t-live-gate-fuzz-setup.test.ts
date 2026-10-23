// covers: file:tests/harness/live-gate-fuzz.ts
//
// Where the live gate fuzz starts a reply's chat. The routing question and the plan offer are the engine's answer to
// the person's first line, so their chat starts where the person types that line: no question open yet, the line read
// as a request, and the question opened once, by the agent's plan proposal, in the chat the run reads. Seeded open and
// typed again, the line met the engine's step for an unanswered question instead, which an agent could answer for the
// person. Every other wait starts with its question open, as the answers corpus builds it.
//
// Mechanism: function - the live driver's seedWait and firstLine on the shipped Claude Code tree, then the engine's
// own steps (the human-turn hook, `next`); no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { latestQuestion } from "../../dist/claude/.claude/tools/aidlc-question-store.ts";
import { next, say } from "../harness/aidlc-answers-corpus.ts";
import { cleanupTestProject, proposalFollowUp, setupIntegrationProject } from "../harness/fixtures.ts";
import { firstLine, loadCorpus, seedWait } from "../harness/live-gate-fuzz.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});
/** A scratch project on the shipped Claude Code tree, as the live drive's Claude Code rig makes one. */
function project(): string {
  const proj = setupIntegrationProject();
  projects.push(proj);
  return proj;
}

describe("the live gate fuzz's first line", () => {
  for (const [wait, ask] of [["routing", "new-work-routing"], ["plan-offer", "scope-confirm"], ["scope-confirm", "scope-confirm"]] as const) {
    test(`at the ${wait} wait the person's first line opens the question, once`, async () => {
      const proj = project();
      const line = firstLine(loadCorpus().find((reply) => reply.wait === wait)!, "claude")!;
      await seedWait(proj, wait);
      expect(latestQuestion(proj), "a question is open before the person's first line").toBeNull();
      await say(proj, line, "claude");
      const read = await next(proj, line.replace(/^\/aidlc\s*/, "").split(" "));
      expect(read.directive?.kind, read.out).toBe("print");
      expect(String(read.directive?.message), read.out).not.toContain("has not answered");
      // The agent reads the line as a fix and names that plan with the request, as the reading print asks.
      const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(String(read.directive?.message))?.[1];
      const proposal = wait === "routing" ? (request ? [...request.split(" "), "--propose", "bugfix"] : null) : proposalFollowUp(read.directive, "bugfix");
      expect(proposal, read.out).not.toBeNull();
      const asked = await next(proj, proposal!);
      expect(asked.directive?.kind, asked.out).toBe("ask");
      expect(asked.directive?.ask_type, asked.out).toBe(ask);
    });
  }

  test("any other wait starts with its question open: the gate waits for the person", async () => {
    const proj = project();
    await seedWait(proj, "stage-gate");
    expect(readAuditShardEvents(proj).map((row) => row.event)).toContain("STAGE_AWAITING_APPROVAL");
  });
});
