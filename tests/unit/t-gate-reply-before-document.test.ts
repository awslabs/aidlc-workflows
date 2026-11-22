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
//
// The person's reply at the open gate on Claude Code, "fix R-01 and R-02 as
// suggested, then go on": the agent made the fixes, then reported the
// approval naming that reply, and the engine refused it because the document
// was written after it, so the person was asked to approve again. A reply that
// is their latest turn and came after the gate's latest showing is read
// against the document as written before it: the agent's writes after it do
// not move it, under off on Claude Code and Kiro CLI and, through the one
// recovery review, under strict on Claude Code, and the record keeps what was
// shown and what changed. Still refused: the first reply named when a later
// message of theirs came after the edit (that one approves); a reply sent
// during a revision, named after the gate is shown again; and, under strict, a
// reply named after a recovery review that is NOT-READY, or READY with a
// finding of its own, which its note brings to them at the gate (there, their
// next reply approves it); and a reply sent before the recovery review was
// recorded, which did not see what that review found.

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
import { env, exec, pick, projectAt, SESSION, say, templateProjects, type AnswersItem, type Exec } from "../harness/aidlc-answers-corpus.ts";

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
  await review(proj, 1, "READY");
}

// One review pass, requested and recorded with the verdict and the new
// finding row given (none by default); the verdict's note for the agent.
async function review(proj: string, iteration: number, verdict: "READY" | "NOT-READY", finding = ""): Promise<string> {
  const base = ["review", "--reviewer", REVIEWER, "--iteration", String(iteration)];
  const asked = await log(proj, base);
  expect(asked.status, asked.stdout + asked.stderr).toBe(0);
  const reviewFile = (JSON.parse(asked.stdout.split("\n").find((line) => line.startsWith("{")) ?? "{}") as { reviewFile?: string }).reviewFile;
  writeFileSync(join(proj, reviewFile as string),
    `## Review\n\n**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** ${iteration}\n\n` +
      "### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      `**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n${finding}\n### Summary\n\nDone.\n`, "utf-8");
  const done = await log(proj, [...base, "--verdict", verdict]);
  expect(done.status, done.stdout + done.stderr).toBe(0);
  const line = done.stdout.split("\n").find((entry) => entry.startsWith("{")) ?? "{}";
  return String((JSON.parse(line) as { agent_note?: string }).agent_note ?? "");
}
// The one recovery review under strict, after an edit made the review stale.
const recoveryReview = (proj: string, verdict: "READY" | "NOT-READY", finding = "") => review(proj, 2, verdict, finding);

const FIX_AND_GO_ON = "Fix R-01 and R-02 the way you suggested, then go on.";

// The person's reply at the open gate: picked in Claude Code's question box,
// or typed on Kiro CLI.
async function replyAtGate(proj: string, words: string, harness: "claude" | "kiro"): Promise<string> {
  if (harness === "claude") {
    const item = { picker: { question: "Requirements Analysis complete. How would you like to proceed?",
      options: ["Approve", "Request Changes"], answer: words } } as unknown as AnswersItem;
    expect((await pick(proj, item, "claude")).status).toBe(0);
  } else {
    expect((await say(proj, words, "kiro")).status).toBe(0);
  }
  return latestMessageId(proj);
}

// The agent writes to the stage's document after their reply (the write hook records it).
function agentEdits(proj: string, line: string): void {
  const doc = join(stageDir(proj), "requirements.md");
  writeFileSync(doc, `${readFileSync(doc, "utf-8")}${line}\n`, "utf-8");
  recordArtifactWriteViaHook(proj, doc, "Edit");
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

    // Their reply at the open gate asks for a change and to go on; the agent
    // writes to the document after it, then reports the approval naming it.
    // It is their latest turn and was sent with the gate on screen, so the
    // writes after it do not move what it saw: one approval, theirs, with their
    // words, beside the rows that say what was shown and what changed after.
    for (const harness of policy === "off" ? (["claude", "kiro"] as const) : (["claude"] as const)) {
      test(`${policy}, ${harness}: their reply at the gate approves it after the agent's edit for it, when named`, async () => {
        const proj = await at("learnings", policy);
        await writeAndReview(proj);
        expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
        sleep();
        const asked = await replyAtGate(proj, FIX_AND_GO_ON, harness);
        sleep();
        agentEdits(proj, "- FR-2: the store keeps the redeemed order ids.");
        let approved = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", asked]);
        if (policy === "strict") {
          // The edit made the review stale: the one recovery review runs first,
          // and its note says their reply still stands.
          expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(0);
          expect(approved.stdout).toContain("ARTIFACT_REVIEW_STALE");
          expect(await recoveryReview(proj, "READY")).toContain(`if their message ${asked} (sent `);
          approved = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", asked]);
        }
        expect(message(approved)).not.toContain("came before");
        const gate = rows(proj, "GATE_APPROVED");
        expect(gate, approved.stdout).toHaveLength(1);
        expect(auditBlockField(gate[0].block, "Message Id")).toBe(asked);
        expect(auditBlockField(gate[0].block, "Message Ids")).toBeNull();
        expect(auditBlockField(gate[0].block, "Person Reply")).toBe(FIX_AND_GO_ON);
        const shown = rows(proj, "STAGE_AWAITING_APPROVAL").at(-1)!;
        const turn = rows(proj, "HUMAN_TURN").find((row) => auditBlockField(row.block, "Message Id") === asked)!;
        expect(auditBlockField(shown.block, "Question Shows")).toMatch(/^sha256:/);
        expect(shown.pos).toBeLessThan(turn.pos);
        expect(rows(proj, "ARTIFACT_UPDATED").some((row) => row.pos > turn.pos && row.pos < gate[0].pos &&
          (auditBlockField(row.block, "File") ?? "").endsWith("requirements.md"))).toBe(true);
        expect(rows(proj, "STAGE_COMPLETED").some((row) => auditBlockField(row.block, "Stage") === STAGE && row.pos > gate[0].pos)).toBe(true);
        if (policy === "off") {
          const accepted = rows(proj, "CHANGE_ACCEPTED").at(-1);
          expect(auditBlockField(accepted?.block ?? "", "Changed") ?? "").toContain("requirements.md");
          expect(approved.stdout).toContain("requirements.md changed after the Requirements Analysis review; carrying on.");
        } else {
          expect(rows(proj, "REVIEW_COMPLETED").some((row) => auditBlockField(row.block, "Iteration") === "2" &&
            auditBlockField(row.block, "Verdict") === "READY" && row.pos > turn.pos && row.pos < gate[0].pos)).toBe(true);
        }
      });
    }

    if (policy === "off") {
      // A message of theirs after the edit may have seen it: that one is the
      // one to name, and the first one, named, is refused.
      test("off: with a later message of theirs after the edit, the first reply named is refused and the later one approves", async () => {
        const proj = await at("learnings", policy);
        await writeAndReview(proj);
        expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
        sleep();
        const asked = await replyAtGate(proj, FIX_AND_GO_ON, "claude");
        sleep();
        agentEdits(proj, "- FR-2: the store keeps the redeemed order ids.");
        sleep();
        expect((await say(proj, "and keep the error short", "claude")).status).toBe(0);
        const later = latestMessageId(proj);
        const first = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", asked]);
        expect(rows(proj, "GATE_APPROVED"), first.stdout).toHaveLength(0);
        expect(message(first)).toContain(`their message ${asked} came before the gate's output was last written`);
        const named = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", later]);
        expect(rows(proj, "GATE_APPROVED"), named.stdout).toHaveLength(1);
        expect(auditBlockField(rows(proj, "GATE_APPROVED")[0].block, "Message Id")).toBe(later);
      });

      // A reply sent during a revision, before its write and before the gate
      // was shown again, did not see the gate it names: refused.
      test("off: a reply sent during a revision, named after the gate is shown again, is refused", async () => {
        const proj = await at("learnings", policy);
        await writeAndReview(proj);
        expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
        sleep();
        expect((await say(proj, "Rename FR-1 to FR-1a", "claude")).status).toBe(0);
        const rejected = await report(proj, ["--result", "rejected", "--user-input", "Request Changes", "--reason", "Rename FR-1 to FR-1a"]);
        expect(rows(proj, "GATE_REJECTED"), rejected.stdout).toHaveLength(1);
        sleep();
        expect((await say(proj, "No wait, I approved it as it was", "claude")).status).toBe(0);
        const during = latestMessageId(proj);
        sleep();
        const doc = join(stageDir(proj), "requirements.md");
        writeFileSync(doc, readFileSync(doc, "utf-8").replace("FR-1:", "FR-1a:"), "utf-8");
        recordArtifactWriteViaHook(proj, doc, "Edit");
        await review(proj, 1, "READY");
        expect((await report(proj, ["--result", "revised"])).status).toBe(0);
        const named = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", during]);
        expect(rows(proj, "GATE_APPROVED"), named.stdout).toHaveLength(0);
        expect(message(named)).toContain(`their message ${during} came before the gate's output was last written`);
      });
    } else {
      // A review that finished after their reply with a finding they have not
      // seen (NOT-READY, or READY with a point of its own) goes to them at the
      // gate, as its note says: their reply, named, approves nothing there.
      for (const [verdict, finding] of [
        ["NOT-READY", "| Major | requirements.md | FR-2 has no acceptance rule | Add one |\n"],
        ["READY", "| Minor | requirements.md | FR-2 could say when the ids reset | Say it |\n"],
      ] as const) {
        test(`strict: after a ${verdict} recovery review with a new finding, their earlier reply named is refused, the gate is shown again and their next reply approves it`, async () => {
          const proj = await at("learnings", policy);
          await writeAndReview(proj);
          expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
          sleep();
          const asked = await replyAtGate(proj, FIX_AND_GO_ON, "claude");
          sleep();
          agentEdits(proj, "- FR-2: the store keeps the redeemed order ids.");
          const stale = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", asked]);
          expect(stale.stdout).toContain("ARTIFACT_REVIEW_STALE");
          const note = await recoveryReview(proj, verdict, finding);
          expect(note).not.toContain("still stands");
          expect(note).toContain("ask the approval question in this turn");
          const named = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", asked]);
          expect(rows(proj, "GATE_APPROVED"), named.stdout).toHaveLength(0);
          expect(message(named)).toContain(`their message ${asked} came before the gate's output was last written`);
          // The note's step: the gate shown again, with the finding.
          const reshown = await report(proj, ["--result", "awaiting-approval"]);
          expect(reshown.status).toBe(0);
          expect(reshown.stdout).toContain("Approve accepts the open review finding R-01");
          // Their approval then: the recovery review read the edit and was
          // recorded before this reply, so it approves, with no Request Changes
          // they did not give.
          sleep();
          expect((await say(proj, "approve", "claude")).status).toBe(0);
          const approved = await report(proj, ["--result", "approved", "--user-input", "Approve"]);
          expect(rows(proj, "GATE_APPROVED"), approved.stdout).toHaveLength(1);
          expect(auditBlockField(rows(proj, "GATE_APPROVED")[0].block, "Message Id")).toBe(latestMessageId(proj));
          expect(rows(proj, "GATE_REJECTED")).toHaveLength(0);
          expect(rows(proj, "STAGE_REVISING")).toHaveLength(0);
        });
      }

      // A change asked for, the edit, the gate shown again with no review, and
      // their approval; the recovery review is recorded after it and brings a
      // finding they never saw. Their approval, named, takes nothing: the
      // stage is reviewed again first.
      test("strict: a recovery review recorded after their approval, with a new finding, does not take that approval", async () => {
        const proj = await at("learnings", policy);
        await writeAndReview(proj);
        expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
        sleep();
        await replyAtGate(proj, "Rename FR-1 to FR-1a", "claude");
        sleep();
        agentEdits(proj, "- FR-1a: a bad duration stops with a clear error.");
        expect((await report(proj, ["--result", "awaiting-approval"])).status).toBe(0);
        sleep();
        expect((await say(proj, "approve", "claude")).status).toBe(0);
        const approval = latestMessageId(proj);
        const stale = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", approval]);
        expect(stale.stdout).toContain("ARTIFACT_REVIEW_STALE");
        await recoveryReview(proj, "NOT-READY", "| Major | requirements.md | FR-1a has no acceptance rule | Add one |\n");
        const named = await report(proj, ["--result", "approved", "--user-input", "Approve", "--message", approval]);
        expect(rows(proj, "GATE_APPROVED"), named.stdout).toHaveLength(0);
        expect(named.stdout).toContain("REVIEW_EVIDENCE_MISSING");
      });
    }
  }
});
