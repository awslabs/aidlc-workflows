// covers: subcommand:aidlc-orchestrate:report, function:personCommandedSinceGateShown, function:commandTurnHint
// covers: hook:aidlc-record-human-turn
//
// A setting typed at an open stage gate is no approval, and the refusal says
// so. A person answered the stage's question in chat, the gate opened, and they
// typed "/aidlc --plan-approval off"; an agent that read the line as their
// approval (Kiro CLI did, on a release candidate) was refused with only "no new
// human reply has been received for this approval question since it was shown"
// and their earlier answer offered as the message the gate might stand on. The
// refusal now also says their message since then was a command to AIDLC, to
// carry out with the question left open, through Claude Code's and Kiro CLI's
// human-turn hooks, for an approval and for a change request, under Guard
// Policy off and strict: nothing is recorded, the gate stays open, and their
// reply after it is taken as before. With no command after the gate, the
// refusal is as it was.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { auditBlockField, readAuditShardEvents, setGuardPolicyLine } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { env, exec, projectAt, say, templateProjects, type Exec } from "../harness/aidlc-answers-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "requirements-analysis";
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const REVIEWER = "aidlc-product-lead-agent";
const NO_OUTPUT_CHECKS = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
};
const COMMAND = "The person's message since then was a command to AIDLC, not a reply to this question: carry out the " +
  "command and leave the question open for their reply.";

const projects: string[] = [];
afterAll(() => {
  for (const proj of [...projects, ...templateProjects()]) cleanupTestProject(proj);
});

async function engine(proj: string, tool: string, args: string[]): Promise<Exec> {
  return exec([process.execPath, tool, ...args, "--project-dir", proj], { cwd: proj, env: env(proj, { env: NO_OUTPUT_CHECKS }) });
}
const report = (proj: string, args: string[]) => engine(proj, ORCHESTRATE, ["report", "--stage", STAGE, ...args]);
const log = (proj: string, args: string[]) => engine(proj, LOG, [...args, "--stage", STAGE]);

function message(result: Exec): string {
  const line = result.stdout.trim().split("\n").findLast((entry) => entry.startsWith("{"));
  return line ? (JSON.parse(line) as { message?: string }).message ?? "" : "";
}
const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const latestMessageId = (proj: string): string | null => {
  const turn = rows(proj, "HUMAN_TURN").at(-1);
  return turn === undefined ? null : auditBlockField(turn.block, "Message Id");
};

// Requirements Analysis reviewed READY, its learnings question answered in the
// person's own words, and its gate shown: the reply came before the gate.
async function gateAfterTheirAnswer(policy: "off" | "strict", harness: "claude" | "kiro"): Promise<{ proj: string; answer: string }> {
  const proj = await projectAt("learnings");
  projects.push(proj);
  const file = seededStateFile(proj);
  writeFileSync(file, setGuardPolicyLine(readFileSync(file, "utf-8"), `${policy} (set by you)`));
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n- FR-1: a blank title is refused.\n", "utf-8");
  writeFileSync(join(dir, `${STAGE}-questions.md`), "# Questions\n\n## Q1\n\nRefuse a blank title?\n\n[Answer]: Yes\n", "utf-8");
  const base = ["review", "--reviewer", REVIEWER, "--iteration", "1"];
  const asked = await log(proj, base);
  expect(asked.status, asked.stdout + asked.stderr).toBe(0);
  const reviewFile = (JSON.parse(asked.stdout.split("\n").find((line) => line.startsWith("{")) ?? "{}") as { reviewFile?: string }).reviewFile;
  writeFileSync(join(proj, reviewFile as string),
    `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
      "### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n", "utf-8");
  expect((await log(proj, [...base, "--verdict", "READY"])).status).toBe(0);
  expect((await say(proj, "Nothing to add for next time, it has to run on our own servers", harness)).status).toBe(0);
  const answer = latestMessageId(proj) as string;
  expect((await log(proj, ["answer", "--details", "Nothing to add"])).status).toBe(0);
  expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
  return { proj, answer };
}

describe("t-gate-command-after-shown: a setting typed at the gate is no approval, and the refusal says so", () => {
  for (const policy of ["off", "strict"] as const) {
    for (const harness of ["claude", "kiro"] as const) {
      test(`${policy}, ${harness}: an approval read from "/aidlc --plan-approval off" is refused as a command`, async () => {
        const { proj, answer } = await gateAfterTheirAnswer(policy, harness);
        expect((await say(proj, "/aidlc --plan-approval off", harness)).status).toBe(0);
        expect(auditBlockField(rows(proj, "HUMAN_TURN").at(-1)?.block ?? "", "Reply")).toBe("command");
        const refused = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
        expect(rows(proj, "GATE_APPROVED"), refused.stdout).toHaveLength(0);
        expect(message(refused)).toContain(COMMAND);
        // The earlier answer is still offered as #2931 designed it.
        expect(message(refused)).toContain(`If their message ${answer} (sent `);
        expect(readFileSync(seededStateFile(proj), "utf-8")).toMatch(new RegExp(`^- \\[\\?\\] ${STAGE} `, "m"));
        // Their reply after it is their approval.
        expect((await say(proj, "approve", harness)).status).toBe(0);
        const approved = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
        expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
        expect(auditBlockField(rows(proj, "GATE_APPROVED")[0].block, "Message Id")).toBe(latestMessageId(proj));
      });
    }

    test(`${policy}: a change request read from the command is refused the same way`, async () => {
      const { proj } = await gateAfterTheirAnswer(policy, "claude");
      expect((await say(proj, "/aidlc --plan-approval off", "claude")).status).toBe(0);
      const refused = await report(proj, ["--result", "rejected", "--user-input", "Request Changes", "--reason", "tighten FR-1"]);
      expect(rows(proj, "GATE_REJECTED"), refused.stdout).toHaveLength(0);
      expect(message(refused)).toContain(COMMAND);
    });

    test(`${policy}: with no command after the gate, the refusal says nothing about one`, async () => {
      const { proj, answer } = await gateAfterTheirAnswer(policy, "claude");
      const refused = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
      expect(rows(proj, "GATE_APPROVED"), refused.stdout).toHaveLength(0);
      expect(message(refused)).toContain(`If their message ${answer} (sent `);
      expect(message(refused)).not.toContain("a command to AIDLC");
    });
  }
});
