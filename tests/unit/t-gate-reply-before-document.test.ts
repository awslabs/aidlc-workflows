// covers: subcommand:aidlc-orchestrate:report, function:answeredBeforeShownStep, function:unshownGateReplyStands
// covers: hook:aidlc-record-human-turn
//
// A reply sent before a stage's document was last written does not approve its
// gate. A person on Kiro CLI answered a Requirements Analysis question in chat
// ("stop with a clear error"); the agent then wrote the requirements, opened the
// gate without showing it and approved it; the engine refused, its step offered
// that answer as the message that might have answered the gate, and the agent
// named it: the record said they approved requirements they never saw. The
// gate now has the summary's rule, from the one check both share: a reply sent
// before the document was last written (this clone's own record says when) is
// neither offered for the gate nor taken as the message it stands on, so the
// gate is shown and their next reply answers it. What the gate shows is every
// output its stage's review reads, optional ones included (a combined gate's
// stages are pinned in t-late-design-gates-one-approval). A message held while another
// engine question was open is left out of that offer too. Still taken, under
// Guard Policy off and strict: an approval given at the learnings question after
// the document is written (offered, recorded on the agent's one retry), with the
// answers written back to the questions file after it (the person's); a
// change request, which keeps today's offer (Arden's choice covers approvals);
// and a reply followed only by a write to another stage's output or by a
// teammate's write on another clone. A reply in the same second as the write
// counts as before it, as the summary has it. The summary reads the same rule:
// a teammate's write on another clone no longer moves it. A gate the agent
// never opened (it reports the approval with no showing on record) has the
// rule too, through Kiro CLI's and Claude Code's hooks: the stage answer
// neither approves it nor is offered, and once the agent shows the gate, or the
// person replies again in chat, that reply approves it; a reply after the
// document approves it at once.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { basename, dirname } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, recordArtifactWriteViaHook, seededAuditShard, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { artifactFilename, auditBlockField, findStageBySlug, readAuditShardEvents, setGuardPolicyLine } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { env, exec, projectAt, SESSION, say, templateProjects, type Exec } from "../harness/aidlc-answers-corpus.ts";

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
const latestMessageId = (proj: string): string => {
  const turn = rows(proj, "HUMAN_TURN").at(-1);
  return (turn === undefined ? null : auditBlockField(turn.block, "Message Id")) as string;
};
const stageDir = (proj: string) => join(seededRecordDir(proj), "inception", STAGE);
const sleep = () => Bun.sleepSync(1100);
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// A teammate's clone keeps its own shard beside this one: a row it wrote.
function teammateWrote(proj: string, file: string): void {
  const mine = seededAuditShard(proj);
  writeFileSync(join(dirname(mine), `zz-teammate-${basename(mine)}`), [
    "## ARTIFACT_UPDATED", `**Timestamp**: ${now()}`, "**Event**: ARTIFACT_UPDATED", `**File**: ${file}`, "", "---", "",
  ].join("\n"));
}

async function at(question: "stage-question" | "learnings", policy: "off" | "strict"): Promise<string> {
  const proj = await projectAt(question);
  projects.push(proj);
  const file = seededStateFile(proj);
  writeFileSync(file, setGuardPolicyLine(readFileSync(file, "utf-8"), `${policy} (set by you)`));
  return proj;
}

// The agent writes the stage's document (the write hook records it) and has it
// reviewed READY, as a run does before its gate.
async function writeAndReview(proj: string): Promise<void> {
  mkdirSync(stageDir(proj), { recursive: true });
  const doc = join(stageDir(proj), "requirements.md");
  writeFileSync(doc, "# Requirements\n\n- FR-1: a bad duration stops with a clear error.\n", "utf-8");
  recordArtifactWriteViaHook(proj, doc);
  writeFileSync(join(stageDir(proj), `${STAGE}-questions.md`), "# Questions\n\n## Q1\n\nWhich database?\n\n[Answer]: SQLite\n", "utf-8");
  const base = ["review", "--reviewer", REVIEWER, "--iteration", "1"];
  const asked = await log(proj, base);
  expect(asked.status, asked.stdout + asked.stderr).toBe(0);
  const reviewFile = (JSON.parse(asked.stdout.split("\n").find((line) => line.startsWith("{")) ?? "{}") as { reviewFile?: string }).reviewFile;
  writeFileSync(join(proj, reviewFile as string),
    `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
      "### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n", "utf-8");
  expect((await log(proj, [...base, "--verdict", "READY"])).status).toBe(0);
}

describe("t-gate-reply-before-document: a reply sent before the stage's document was last written does not approve its gate", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`${policy}, kiro: an answer to the stage's question, then the document, is neither offered nor taken for the gate`, async () => {
      const proj = await at("stage-question", policy);
      expect((await say(proj, "SQLite, and stop with a clear error on bad input", "kiro")).status).toBe(0);
      const answer = latestMessageId(proj);
      expect((await log(proj, ["answer", "--details", "SQLite"])).status).toBe(0);
      sleep();
      await writeAndReview(proj);
      expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
      const refused = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
      expect(rows(proj, "GATE_APPROVED"), refused.stdout).toHaveLength(0);
      expect(message(refused)).not.toContain(answer);
      expect(message(refused)).toContain("Show the gate and end your turn");
      const named = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", answer]);
      expect(rows(proj, "GATE_APPROVED"), named.stdout).toHaveLength(0);
      expect(message(named)).toContain(`their message ${answer} came before`);
      // Their reply after the gate is shown approves it.
      expect((await say(proj, "approve", "kiro")).status).toBe(0);
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
      expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
      expect(auditBlockField(rows(proj, "GATE_APPROVED")[0].block, "Message Id")).toBe(latestMessageId(proj));
    });

    for (const harness of ["kiro", "claude"] as const) {
      test(`${policy}, ${harness}: a gate never opened takes no answer sent before the document, and the next reply approves it`, async () => {
        const proj = await at("stage-question", policy);
        expect((await say(proj, "SQLite, and stop with a clear error on bad input", harness)).status).toBe(0);
        const answer = latestMessageId(proj);
        expect((await log(proj, ["answer", "--details", "SQLite"])).status).toBe(0);
        sleep();
        await writeAndReview(proj);
        const refused = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
        expect(rows(proj, "GATE_APPROVED"), refused.stdout).toHaveLength(0);
        expect(message(refused)).not.toContain(answer);
        expect(message(refused)).toContain("since the gate's output was last written answers this gate. Show the gate and end your turn");
        sleep();
        // On Kiro CLI the agent shows the gate; on Claude Code the person
        // replies in chat with the gate still unopened. Either reply approves.
        if (harness === "kiro") expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
        expect((await say(proj, "approve", harness)).status).toBe(0);
        const approved = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
        expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
        expect(auditBlockField(rows(proj, "GATE_APPROVED")[0].block, "Message Id")).toBe(latestMessageId(proj));
      });
    }

    test(`${policy}: a gate never opened, a reply after the document approves it at once`, async () => {
      const proj = await at("stage-question", policy);
      expect((await say(proj, "SQLite, and stop with a clear error on bad input", "claude")).status).toBe(0);
      expect((await log(proj, ["answer", "--details", "SQLite"])).status).toBe(0);
      sleep();
      await writeAndReview(proj);
      sleep();
      expect((await say(proj, "Looks right, approve it", "claude")).status).toBe(0);
      const approval = latestMessageId(proj);
      const approved = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
      expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
      expect(auditBlockField(rows(proj, "GATE_APPROVED")[0].block, "Message Id")).toBe(approval);
    });

    test(`${policy}, claude: an approval at the learnings question after the document is written is still offered and taken`, async () => {
      const proj = await at("learnings", policy);
      await writeAndReview(proj);
      sleep();
      expect((await say(proj, "Nothing to add. Approve, and move on", "claude")).status).toBe(0);
      const approval = latestMessageId(proj);
      // The answers written back to the questions file after it are the person's,
      // not a new output. Under strict a write after the review makes the review
      // stale (main's own check, before this one), so that half runs under off.
      if (policy === "off") {
        sleep();
        const questions = join(stageDir(proj), `${STAGE}-questions.md`);
        writeFileSync(questions, `${readFileSync(questions, "utf-8")}\n## Q2\n\nAnything else?\n\n[Answer]: No\n`, "utf-8");
        recordArtifactWriteViaHook(proj, questions, "Edit");
      }
      expect((await log(proj, ["answer", "--details", "Nothing to add"])).status).toBe(0);
      expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
      const first = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
      expect(rows(proj, "GATE_APPROVED"), first.stdout).toHaveLength(0);
      expect(message(first)).toContain(`If their message ${approval} (sent `);
      const retried = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", approval]);
      expect(rows(proj, "GATE_APPROVED"), retried.stdout).toHaveLength(1);
      expect(auditBlockField(rows(proj, "GATE_APPROVED")[0].block, "Message Id")).toBe(approval);
    });

    // An optional output counts as what the gate shows. Under strict a write
    // after the review makes the review stale first (main's own check).
    if (policy === "off") {
      test("off: an optional output written after the approval leaves that approval for the next reply", async () => {
        const proj = await at("learnings", policy);
        await writeAndReview(proj);
        sleep();
        expect((await say(proj, "Nothing to add. Approve, and move on", "claude")).status).toBe(0);
        const approval = latestMessageId(proj);
        sleep();
        const optional = findStageBySlug(STAGE)?.optional_produces?.[0] ?? "traceability";
        const file = join(stageDir(proj), artifactFilename(optional));
        writeFileSync(file, "{}\n", "utf-8");
        recordArtifactWriteViaHook(proj, file);
        expect((await log(proj, ["answer", "--details", "Nothing to add"])).status).toBe(0);
        expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
        const named = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", approval]);
        expect(rows(proj, "GATE_APPROVED"), named.stdout).toHaveLength(0);
        expect(message(named)).toContain(`their message ${approval} came before`);
        expect((await say(proj, "approve", "claude")).status).toBe(0);
        const approved = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
        expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
      });
    }

    test(`${policy}: a change asked for before the document was written is still offered and taken for the gate`, async () => {
      const proj = await at("stage-question", policy);
      expect((await say(proj, "SQLite, and change the error to say which field was blank", "claude")).status).toBe(0);
      const change = latestMessageId(proj);
      expect((await log(proj, ["answer", "--details", "SQLite"])).status).toBe(0);
      sleep();
      await writeAndReview(proj);
      expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
      const refused = await report(proj, ["--result", "rejected", "--user-input", "Request Changes"]);
      expect(rows(proj, "GATE_REJECTED"), refused.stdout).toHaveLength(0);
      expect(message(refused)).toContain(`If their message ${change} (sent `);
      const named = await report(proj, ["--result", "rejected", "--user-input", "Request Changes", "--message", change]);
      expect(rows(proj, "GATE_REJECTED"), named.stdout).toHaveLength(1);
      expect(auditBlockField(rows(proj, "GATE_REJECTED")[0].block, "Message Id")).toBe(change);
    });

    test(`${policy}: a write to another stage's output after the approval, or a teammate's on another clone, moves nothing`, async () => {
      const proj = await at("learnings", policy);
      await writeAndReview(proj);
      sleep();
      expect((await say(proj, "Nothing to add. Approve, and move on", "claude")).status).toBe(0);
      const approval = latestMessageId(proj);
      sleep();
      const stories = join(seededRecordDir(proj), "inception", "user-stories");
      mkdirSync(stories, { recursive: true });
      const other = join(stories, artifactFilename(findStageBySlug("user-stories")?.produces?.[0] ?? "stories"));
      writeFileSync(other, "# Stories\n", "utf-8");
      recordArtifactWriteViaHook(proj, other);
      // Under strict a teammate's write after the review makes the review stale
      // (main's own check, before this one), so that half runs under off.
      if (policy === "off") teammateWrote(proj, join(stageDir(proj), "requirements.md"));
      expect((await log(proj, ["answer", "--details", "Nothing to add"])).status).toBe(0);
      expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
      const first = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
      expect(message(first)).toContain(`If their message ${approval} (sent `);
      const retried = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", approval]);
      expect(rows(proj, "GATE_APPROVED"), retried.stdout).toHaveLength(1);
    });

    test(`${policy}: a message held while another question was open, sent before the document, is not offered for the gate`, async () => {
      const proj = await at("stage-question", policy);
      const held = saveMessage(proj, {
        session: SESSION, at: now(), source: "prompt", text: "SQLite", picker: null, words: "SQLite", settings: [],
        route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
      });
      appendAuditEntry("HUMAN_TURN", { Session: SESSION, "Message Id": held.id, "Open Question": "new-work-routing" }, proj);
      sleep();
      await writeAndReview(proj);
      expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
      const refused = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
      expect(rows(proj, "GATE_APPROVED"), refused.stdout).toHaveLength(0);
      expect(message(refused)).not.toContain(held.id);
    });

    test(`${policy}: the summary takes a message sent after its own last write, whatever a teammate's clone wrote later`, async () => {
      const proj = await at("learnings", policy);
      mkdirSync(stageDir(proj), { recursive: true });
      const questions = join(stageDir(proj), `${STAGE}-questions.md`);
      writeFileSync(join(stageDir(proj), "requirements.md"), "# Requirements\n\n- FR-1: a blank title is refused.\n", "utf-8");
      writeFileSync(questions, "# Questions\n\n## Q1\n\nRefuse a blank title?\n\n[Answer]: Yes\n\n" +
        "## Consolidated Summary Confirmation\n\nDoes this all look correct?\n\n- Looks correct\n- Request changes\n\n[Answer]: \n", "utf-8");
      recordArtifactWriteViaHook(proj, questions);
      sleep();
      expect((await say(proj, "looks correct", "claude")).status).toBe(0);
      const confirmed = latestMessageId(proj);
      sleep();
      teammateWrote(proj, questions);
      sleep();
      const asked = await log(proj, ["decision", "--checkpoint", "summary-confirmation", "--questions-file", questions,
        "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"]);
      expect(asked.status, asked.stdout + asked.stderr).toBe(0);
      writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]: \n$/, "[Answer]: Looks correct\n"));
      const answered = await log(proj, ["answer", "--checkpoint", "summary-confirmation", "--questions-file", questions,
        "--details", "Looks correct", "--message", confirmed]);
      expect(answered.status, answered.stdout + answered.stderr).toBe(0);
      expect(auditBlockField(rows(proj, "SUMMARY_CONFIRMATION_RECORDED").at(-1)?.block ?? "", "Message Id")).toBe(confirmed);
    });
  }
});
