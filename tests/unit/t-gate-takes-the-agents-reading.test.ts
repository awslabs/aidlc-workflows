// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-state:approve, subcommand:aidlc-state:reject
// covers: hook:aidlc-record-human-turn, function:humanTurnState
//
// At a stage gate the agent reads the person's reply, in any words, against
// what it showed them, and reports the choice it read; the engine checks that
// a person replied since the last decision and since the stage started (and,
// unless the agent names the message, after the gate was shown), records the
// agent's choice as it was passed, and keeps the person's words whole beside
// it. These are the replies a person was refused or misrecorded on before: a
// "3" the agent read as Add User Stories on Codex, a "2" to the agent's own
// question beside the gate on Kiro, an approval given at the learnings
// question just before the gate, an approval given with a stop after the
// agent logged the gate as a question, and an approval typed before the gate's
// own row was written. Each is recorded the first time, or, when every reply
// came before the gate was shown, on the agent's one retry naming the message,
// never by asking the person again; under every Guard Policy; and no reply
// backs a decision on a stage it came before.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  readAuditShardEvents,
  setGuardPolicyLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { env, exec, next, projectAt, say, templateProjects, type Exec } from "../harness/aidlc-answers-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "requirements-analysis";
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const REVIEWER = "aidlc-product-lead-agent";
// The stage's own outputs are not what these cases are about: a stage opened
// here without them still has its gate checked for the person's reply.
const NO_OUTPUT_CHECKS = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
};
const POLICIES = ["off", "relaxed", "strict"] as const;
type Policy = (typeof POLICIES)[number];

const projects: string[] = [];
afterAll(() => {
  for (const proj of [...projects, ...templateProjects()]) cleanupTestProject(proj);
});

async function at(question: "stage-gate" | "learnings", policy: Policy): Promise<string> {
  const proj = await projectAt(question);
  projects.push(proj);
  const file = seededStateFile(proj);
  writeFileSync(file, setGuardPolicyLine(readFileSync(file, "utf-8"), `${policy} (set by you)`));
  return proj;
}

async function engine(proj: string, tool: string, args: string[], extra: Record<string, string> = {}): Promise<Exec> {
  return exec([process.execPath, tool, ...args, "--project-dir", proj], { cwd: proj, env: env(proj, { env: extra }) });
}

const report = (proj: string, args: string[], extra: Record<string, string> = {}) =>
  engine(proj, ORCHESTRATE, ["report", "--stage", STAGE, ...args], extra);
const log = (proj: string, args: string[], extra: Record<string, string> = {}) =>
  engine(proj, LOG, [...args, "--stage", STAGE], extra);

// The stage's document, reviewed READY, so its gate can open: the stage up to
// its learnings question, as the agent leaves it.
async function reviewed(proj: string): Promise<void> {
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n- FR-1: a blank title is refused.\n", "utf-8");
  writeFileSync(join(dir, `${STAGE}-questions.md`), "# Questions\n\n## Q1\n\nRefuse a blank title?\n\n[Answer]: Yes\n", "utf-8");
  const base = ["review", "--reviewer", REVIEWER, "--iteration", "1"];
  const asked = await log(proj, base, NO_OUTPUT_CHECKS);
  expect(asked.status, asked.stdout + asked.stderr).toBe(0);
  const reviewFile = (JSON.parse(asked.stdout.split("\n").find((line) => line.startsWith("{")) ?? "{}") as { reviewFile?: string }).reviewFile;
  expect(reviewFile, asked.stdout).toBeDefined();
  writeFileSync(join(proj, reviewFile as string),
    `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
      "### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n", "utf-8");
  const ready = await log(proj, [...base, "--verdict", "READY"], NO_OUTPUT_CHECKS);
  expect(ready.status, ready.stdout + ready.stderr).toBe(0);
}

function directive(result: Exec): { kind?: string; message?: string } {
  const line = result.stdout.trim().split("\n").findLast((entry) => entry.startsWith("{"));
  return line ? JSON.parse(line) as { kind?: string; message?: string } : {};
}

function rows(proj: string, event: string) {
  return readAuditShardEvents(proj).filter((row) => row.event === event);
}
const field = (row: { block: string } | undefined, name: string): string | null =>
  row === undefined ? null : auditBlockField(row.block, name);
const latestMessageId = (proj: string): string | null =>
  field(rows(proj, "HUMAN_TURN").at(-1), "Message Id");

describe("t-gate-takes-the-agents-reading: the gate records the agent's reading and the person's words", () => {
  for (const policy of POLICIES) {
    test(`${policy}: Codex "3" read as Add User Stories is on the record as the agent passed it, beside "3"`, async () => {
      const proj = await at("stage-gate", policy);
      expect((await say(proj, "3", "codex")).status).toBe(0);
      const approved = await report(proj, ["--result", "approved", "--user-input", "Add User Stories"]);
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      const row = rows(proj, "GATE_APPROVED").at(-1);
      expect(field(row, "User Input")).toBe("Add User Stories");
      expect(field(row, "Person Reply")).toBe("3");
      expect(field(row, "Message Id")).toBe(latestMessageId(proj));
    });

    test(`${policy}: Kiro "2" for the agent's own "I'm comfortable approving as-is" approves on that reply`, async () => {
      const proj = await at("stage-gate", policy);
      expect((await say(proj, "2", "kiro-ide")).status).toBe(0);
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      expect(directive(approved).message ?? "").not.toContain("picked");
      const row = rows(proj, "GATE_APPROVED").at(-1);
      expect(field(row, "User Input")).toBe("Approve");
      expect(field(row, "Person Reply")).toBe("2");
    });

    test(`${policy}: "Nothing to add. Approve, and move on" at the learnings question approves the gate it comes before`, async () => {
      const proj = await at("learnings", policy);
      await reviewed(proj);
      const said = "Nothing to add. Approve, and move on";
      expect((await say(proj, said, "claude")).status).toBe(0);
      const id = latestMessageId(proj) as string;
      const answered = await log(proj, ["answer", "--details", "Nothing to add"], NO_OUTPUT_CHECKS);
      expect(answered.status, answered.stdout + answered.stderr).toBe(0);
      const opened = await report(proj, ["--result", "awaiting-approval"], NO_OUTPUT_CHECKS);
      expect(opened.status, opened.stdout + opened.stderr).toBe(0);
      // Their reply came before the gate was shown: the agent's step names it, and the retry records it.
      const first = await report(proj, ["--result", "approved", "--user-input", "Approve"], NO_OUTPUT_CHECKS);
      expect(rows(proj, "GATE_APPROVED"), first.stdout).toHaveLength(0);
      expect(directive(first).message ?? "").toContain(`If their message ${id} (sent `);
      expect(directive(first).message ?? "").toContain("run the same report with --message <id>");
      expect(directive(first).message ?? "").not.toContain(said);
      expect(directive(first).message ?? "").toContain("without asking them again");
      // The agent's reading is the step, never a question still open to show again.
      expect(directive(first).kind).toBe("print");
      expect(directive(first).message ?? "").not.toContain("Show the question again");
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", id], NO_OUTPUT_CHECKS);
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
      expect(field(rows(proj, "GATE_APPROVED")[0], "Person Reply")).toBe(said);
      expect(rows(proj, "QUESTION_ANSWERED")).toHaveLength(1);
    });

    test(`${policy}: "Approve, and stop there for today" after the agent logged the gate as a question approves and parks`, async () => {
      const proj = await at("stage-gate", policy);
      const said = "Approve, and stop there for today";
      // The agent logged the gate as a question of its own, then the person answered it.
      expect((await log(proj, ["decision", "--decision", "Approve the requirements?", "--options", "Approve,Request Changes"])).status).toBe(0);
      expect((await say(proj, said, "claude")).status).toBe(0);
      const answered = await log(proj, ["answer", "--details", "Approve"]);
      expect(answered.status, answered.stdout + answered.stderr).toBe(0);
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve", "--park"]);
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
      expect(field(rows(proj, "GATE_APPROVED")[0], "Person Reply")).toBe(said);
      expect(rows(proj, "WORKFLOW_PARKED")).toHaveLength(1);
    });

    test(`${policy}: an approval typed before the gate's own row was written is recorded`, async () => {
      const proj = await at("learnings", policy);
      await reviewed(proj);
      expect((await say(proj, "Nothing to add", "claude")).status).toBe(0);
      expect((await log(proj, ["answer", "--details", "Nothing to add"], NO_OUTPUT_CHECKS)).status).toBe(0);
      // The agent showed the gate in prose before it ran the report; the person approved at once.
      expect((await say(proj, "approve", "claude")).status).toBe(0);
      const id = latestMessageId(proj) as string;
      expect((await report(proj, ["--result", "awaiting-approval"], NO_OUTPUT_CHECKS)).status).toBe(0);
      const first = await report(proj, ["--result", "approved", "--user-input", "Approve"], NO_OUTPUT_CHECKS);
      expect(rows(proj, "GATE_APPROVED"), first.stdout).toHaveLength(0);
      expect(directive(first).message ?? "").toContain(id);
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", id], NO_OUTPUT_CHECKS);
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
      expect(field(rows(proj, "GATE_APPROVED")[0], "Person Reply")).toBe("approve");
    });

    test(`${policy}: a bare "2" for Request Changes is the feedback as they typed it`, async () => {
      const proj = await at("stage-gate", policy);
      expect((await say(proj, "2", "claude")).status).toBe(0);
      const rejected = await report(proj, ["--result", "rejected", "--user-input", "Request Changes"]);
      expect(rejected.status, rejected.stdout + rejected.stderr).toBe(0);
      const row = rows(proj, "GATE_REJECTED").at(-1);
      expect(field(row, "Feedback")).toBe("2");
      expect(field(row, "Message Id")).toBe(latestMessageId(proj));
    });

    test(`${policy}: --message names the one message the agent read the decision from`, async () => {
      const proj = await at("stage-gate", policy);
      expect((await say(proj, "looks good, approve it", "claude")).status).toBe(0);
      const id = latestMessageId(proj);
      expect(id).not.toBeNull();
      expect((await say(proj, "and thanks", "claude")).status).toBe(0);
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", id as string]);
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      const row = rows(proj, "GATE_APPROVED").at(-1);
      expect(field(row, "Person Reply")).toBe("looks good, approve it");
      expect(field(row, "Message Id")).toBe(id);
    });

    test(`${policy}: --message naming the request that started the work does not approve; a reply since does`, async () => {
      const proj = await at("learnings", policy);
      expect((await say(proj, "build the to-do app", "claude")).status).toBe(0);
      const request = latestMessageId(proj) as string;
      appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
      await reviewed(proj);
      expect((await say(proj, "ok", "claude")).status).toBe(0);
      const since = latestMessageId(proj) as string;
      expect((await report(proj, ["--result", "awaiting-approval"], NO_OUTPUT_CHECKS)).status).toBe(0);
      const onRequest = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", request], NO_OUTPUT_CHECKS);
      expect(rows(proj, "GATE_APPROVED"), onRequest.stdout).toHaveLength(0);
      expect(directive(onRequest).message ?? "").toContain(`message ${request}`);
      const onReply = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", since], NO_OUTPUT_CHECKS);
      expect(rows(proj, "GATE_APPROVED"), onReply.stdout).toHaveLength(1);
      expect(field(rows(proj, "GATE_APPROVED")[0], "Message Id")).toBe(since);
    });

    // A backward jump asked for at a gate starts the stage again with no
    // decision between: the reply that asked for it approves nothing the
    // restarted stage makes, named or not.
    test(`${policy}: the reply that asked to go back does not approve the stage the jump restarted; their reply since does`, async () => {
      const proj = await at("stage-gate", policy);
      expect((await say(proj, "go back to the requirements and drop FR-1", "claude")).status).toBe(0);
      const asked = latestMessageId(proj) as string;
      appendAuditEntry("STAGE_JUMPED", { Stage: STAGE, Direction: "backward" }, proj);
      appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
      // The agent redid the stage and had it reviewed again, as the restart asks.
      await reviewed(proj);
      const named = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", asked], NO_OUTPUT_CHECKS);
      expect(rows(proj, "GATE_APPROVED"), named.stdout).toHaveLength(0);
      expect(directive(named).message ?? "").toContain(`message ${asked}`);
      expect(directive(named).message ?? "").toContain("end your turn");
      const bare = await report(proj, ["--result", "approved", "--user-input", "Approve"], NO_OUTPUT_CHECKS);
      expect(rows(proj, "GATE_APPROVED"), bare.stdout).toHaveLength(0);
      expect(directive(bare).message ?? "").toContain("end your turn");
      expect((await say(proj, "approve", "claude")).status).toBe(0);
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve"], NO_OUTPUT_CHECKS);
      expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
      expect(field(rows(proj, "GATE_APPROVED")[0], "Person Reply")).toBe("approve");
    });

    test(`${policy}: a change request on nothing but the request that started the work is refused; their reply records it`, async () => {
      const proj = await at("learnings", policy);
      expect((await say(proj, "build the to-do app", "claude")).status).toBe(0);
      appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
      await reviewed(proj);
      expect((await report(proj, ["--result", "awaiting-approval"], NO_OUTPUT_CHECKS)).status).toBe(0);
      const ranAhead = await report(proj, ["--result", "rejected", "--user-input", "Request Changes", "--reason", "tighten FR-1"], NO_OUTPUT_CHECKS);
      expect(rows(proj, "GATE_REJECTED"), ranAhead.stdout).toHaveLength(0);
      expect(directive(ranAhead).message ?? "").toContain("end your turn");
      expect((await say(proj, "tighten FR-1 please", "claude")).status).toBe(0);
      const rejected = await report(proj, ["--result", "rejected", "--user-input", "Request Changes"], NO_OUTPUT_CHECKS);
      expect(rows(proj, "GATE_REJECTED"), rejected.stdout).toHaveLength(1);
      expect(field(rows(proj, "GATE_REJECTED")[0], "Feedback")).toBe("tighten FR-1 please");
      // The report's line says their words are kept, and never repeats them.
      expect(directive(rejected).message ?? "").not.toContain("tighten FR-1 please");
    });

    test(`${policy}: the step for their reply at the gate names its id, never their words, and --message records it`, async () => {
      const proj = await at("stage-gate", policy);
      expect((await say(proj, "looks good to me", "claude")).status).toBe(0);
      const id = latestMessageId(proj) as string;
      const step = await next(proj, ["looks good to me"]);
      expect(step.directive?.kind, step.out).toBe("print");
      expect(step.directive?.message ?? "").toContain(id);
      expect(step.directive?.message ?? "").toContain("--message <id>");
      expect(step.directive?.message ?? "").not.toContain("looks good to me");
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", id]);
      expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
    });

    test(`${policy}: a message too long to keep whole leaves their words off the row and names the message`, async () => {
      const proj = await at("stage-gate", policy);
      expect((await say(proj, `approve. ${"x".repeat(9000)}`, "claude")).status).toBe(0);
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      const row = rows(proj, "GATE_APPROVED").at(-1);
      expect(field(row, "Person Reply")).toBeNull();
      expect(field(row, "Message Id")).toBe(latestMessageId(proj));
    });

    test(`${policy}: the request that started the work does not approve the stage it started; their next reply does`, async () => {
      const proj = await at("learnings", policy);
      // The person's request, then the stage the engine started for it, run to its gate.
      expect((await say(proj, "build the to-do app", "claude")).status).toBe(0);
      appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
      await reviewed(proj);
      expect((await report(proj, ["--result", "awaiting-approval"], NO_OUTPUT_CHECKS)).status).toBe(0);
      const ranAhead = await report(proj, ["--result", "approved", "--user-input", "Approve"], NO_OUTPUT_CHECKS);
      expect(rows(proj, "GATE_APPROVED")).toHaveLength(0);
      expect(directive(ranAhead).message ?? ranAhead.stdout + ranAhead.stderr).toContain("end your turn");
      // The step the refusal names, then the person's reply: approved, and the work moves on.
      expect((await say(proj, "approve", "claude")).status).toBe(0);
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve"], NO_OUTPUT_CHECKS);
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
      const after = await next(proj, [], { env: NO_OUTPUT_CHECKS });
      expect(after.status, after.out).toBe(0);
      expect(after.directive?.stage).not.toBe(STAGE);
    });
  }
});
