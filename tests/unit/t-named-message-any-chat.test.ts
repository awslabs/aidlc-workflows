// covers: function:proveMessage, function:personsGateReply, subcommand:aidlc-log:answer, subcommand:aidlc-orchestrate:report
// covers: audit:QUESTION_ANSWERED, audit:GATE_APPROVED, audit:GATE_REJECTED
//
// The message the agent names (`--message <id>`) is the person's reply when it
// is on record, carries their words and no decision has used it, whichever chat
// of this work it came through: the record the agent read is one record, and the
// spending row settles a race. Before, an answer or an approval recorded in a
// second chat on the reply the person gave in the first was refused as "came
// through another chat". The window the engine takes with no message named stays
// this chat's. Another chat's message proves when it was sent on this work (a
// HUMAN_TURN row of this record names it); one typed for other work, or before
// any, is refused to the agent with this chat's replies named for the retry,
// while this chat's own messages prove as they are. A decision whose words come
// from several replies names every one of them, oldest first, so the record's
// words and its ids match; a reply an earlier answer recorded is left to that
// answer unless it is their latest. Every case runs under Guard Policy off,
// relaxed and strict.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { artifactFilename, auditBlockField, findStageBySlug, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, createTestProject, FIXTURES_DIR, runOrchestrateNext,
  seedAidlcMemory, seededRecordDir, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const CHAT = "01995000-7a11-7000-8000-00000000c1c1";
const OTHER = "01995000-7a11-7000-8000-00000000c2c2";
const STAGE = "requirements-analysis";
const POLICIES = ["off", "relaxed", "strict"] as const;
type Policy = (typeof POLICIES)[number];

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop()!);
});

const guardPolicyLine = (policy: Policy, scope: string): string =>
  policy === "strict" ? "- **Guard Policy**: strict (set by you)" : `- **Guard Policy**: ${policy} (from scope ${scope})`;

// Production guards, as a person's run has them, in the chat `chat` (null: one the engine cannot name).
function env(proj: string, chat: string | null): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...testGuardEnvironment(process.env, "production"),
    CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", AIDLC_SKIP_ARTIFACT_GUARD: "1",
  };
  if (chat !== null) {
    out.AIDLC_SESSION_OVERRIDE = chat;
    out.AIDLC_SESSION_OVERRIDE_SOURCE = "payload";
  } else {
    delete out.AIDLC_SESSION_OVERRIDE;
    delete out.AIDLC_SESSION_OVERRIDE_SOURCE;
  }
  return out;
}

function spawn(proj: string, cmd: string[], chat: string | null, stdin?: string) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...cmd], cwd: proj, env: env(proj, chat), stdout: "pipe", stderr: "pipe",
    ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.exitCode, out: `${result.stdout.toString()}${result.stderr.toString()}` };
}

// What the person types in `chat`, through the prompt hook every harness uses; the message id its turn names.
function says(proj: string, prompt: string, chat = CHAT): string {
  const kept = spawn(proj, [DISPATCHER, "engine", "hook", "record-human-turn"], chat,
    JSON.stringify({ session_id: chat, hook_event_name: "UserPromptSubmit", prompt }));
  expect(kept.status, kept.out).toBe(0);
  return auditBlockField(rows(proj, "HUMAN_TURN").at(-1)?.block ?? "", "Message Id") ?? "";
}

const log = (proj: string, args: string[], chat: string | null) => spawn(proj, [LOG, ...args, "--project-dir", proj], chat);
const report = (proj: string, args: string[], chat: string | null) =>
  spawn(proj, [ORCHESTRATE, "report", "--stage", "feasibility", ...args, "--project-dir", proj], chat);

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const field = (proj: string, event: string, name: string) => auditBlockField(rows(proj, event).at(-1)!.block, name);

// Requirements Analysis running, its questions the agent's own; `before` runs ahead of any work.
function inception(policy: Policy, before: (proj: string) => void = () => {}): string {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  before(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const state = seededStateFile(proj);
  writeFileSync(state, readFileSync(state, "utf-8").replace(/- \*\*Change Control\*\*: [^\n]*/, guardPolicyLine(policy, "bugfix")));
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
  return proj;
}

// Feasibility at its approval gate, started and shown in chat CHAT.
function gate(policy: Policy): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope feature)",
      `${guardPolicyLine(policy, "feature")}\n- **Summary Confirmation**: off (set by you)`), "utf-8");
  says(proj, "/aidlc");
  const started = runOrchestrateNext(ORCHESTRATE, proj, [], { env: env(proj, CHAT) });
  expect(started.directive?.kind, started.out).toBe("run-stage");
  const dir = join(seededRecordDir(proj), "ideation", "feasibility");
  mkdirSync(dir, { recursive: true });
  for (const name of findStageBySlug("feasibility")!.produces ?? []) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n\n## Summary\n\nWritten for this case.\n`, "utf-8");
  }
  const shown = report(proj, ["--result", "awaiting-approval"], CHAT);
  expect(shown.status, shown.out).toBe(0);
  return proj;
}

for (const policy of POLICIES) {
  describe(`t-named-message-any-chat (Guard Policy ${policy})`, () => {
    test("an answer recorded in a second chat names the first chat's reply it stood on", () => {
      const proj = inception(policy);
      const id = says(proj, "PostgreSQL, it is what we run");
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Which database?", "--options", "PostgreSQL,SQLite"], OTHER)
        .status).toBe(0);
      const answered = log(proj, ["answer", "--stage", STAGE, "--details", "PostgreSQL", "--message", id], OTHER);
      expect(answered.status, answered.out).toBe(0);
      expect(field(proj, "QUESTION_ANSWERED", "Message Id")).toBe(id);
      expect(field(proj, "QUESTION_ANSWERED", "Person Reply")).toBe("PostgreSQL, it is what we run");
    });

    test("another chat's message sent before this work existed is refused, naming this chat's reply; this chat's proves", () => {
      // Typed while no work existed: the hook keeps the message, and no row of this work names it.
      const kept: Record<string, string> = {};
      const proj = inception(policy, (dir) => {
        for (const chat of [OTHER, CHAT]) {
          says(dir, "use SQLite", chat);
          kept[chat] = listMessages(dir).filter((m) => m.session === chat).at(-1)!.id;
        }
      });
      const mine = says(proj, "PostgreSQL");
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Which database?", "--options", "PostgreSQL,SQLite"], CHAT)
        .status).toBe(0);
      const refused = log(proj, ["answer", "--stage", STAGE, "--details", "SQLite", "--message", kept[OTHER]], CHAT);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain(`If the person's message ${mine} (sent `);
      expect(refused.out).toContain(`message ${kept[OTHER]} was not sent on this piece of work`);
      expect(rows(proj, "QUESTION_ANSWERED")).toHaveLength(0);
      const own = log(proj, ["answer", "--stage", STAGE, "--details", "SQLite", "--message", kept[CHAT]], CHAT);
      expect(own.status, own.out).toBe(0);
      expect(field(proj, "QUESTION_ANSWERED", "Message Id")).toBe(kept[CHAT]);
    });

    test("with no chat the engine can name and two chats since the last decision, the message named is recorded", () => {
      const proj = inception(policy);
      const id = says(proj, "SQLite");
      says(proj, "what does the gate commit me to?", OTHER);
      expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Which database?", "--options", "PostgreSQL,SQLite"], null)
        .status).toBe(0);
      const answered = log(proj, ["answer", "--stage", STAGE, "--details", "SQLite", "--message", id], null);
      expect(answered.status, answered.out).toBe(0);
      expect(field(proj, "QUESTION_ANSWERED", "Message Id")).toBe(id);
    });

    test("a gate approved in a second chat on the first chat's reply names that reply", () => {
      const proj = gate(policy);
      const id = says(proj, "approve");
      const approved = report(proj, ["--result", "approved", "--user-input", "Approve", "--message", id], OTHER);
      expect(approved.status, approved.out).toBe(0);
      expect(rows(proj, "GATE_APPROVED"), approved.out).toHaveLength(1);
      expect(field(proj, "GATE_APPROVED", "Message Id")).toBe(id);
      expect(field(proj, "GATE_APPROVED", "Person Reply")).toBe("approve");
    });

    test("a gate's row names every message its words come from, oldest first", () => {
      const proj = gate(policy);
      const first = says(proj, "the title rule needs a length limit");
      const second = says(proj, "ok, approve");
      const approved = report(proj, ["--result", "approved", "--user-input", "Approve"], CHAT);
      expect(approved.status, approved.out).toBe(0);
      expect(field(proj, "GATE_APPROVED", "Person Reply")).toBe("the title rule needs a length limit\\nok, approve");
      expect(field(proj, "GATE_APPROVED", "Message Id")).toBe(second);
      expect(field(proj, "GATE_APPROVED", "Message Ids")).toBe(`${first},${second}`);
    });

    test("a Request Changes' row names every message its words come from, oldest first", () => {
      const proj = gate(policy);
      const first = says(proj, "the title rule needs a length limit");
      const second = says(proj, "and drop the second risk");
      const rejected = report(proj, ["--result", "rejected", "--user-input", "Request Changes"], CHAT);
      expect(rejected.status, rejected.out).toBe(0);
      expect(field(proj, "GATE_REJECTED", "Feedback")).toBe("the title rule needs a length limit\\nand drop the second risk");
      expect(field(proj, "GATE_REJECTED", "Message Id")).toBe(second);
      expect(field(proj, "GATE_REJECTED", "Message Ids")).toBe(`${first},${second}`);
    });

    test("one reply names its one message, with no list beside it", () => {
      const proj = gate(policy);
      const id = says(proj, "approve");
      expect(report(proj, ["--result", "approved", "--user-input", "Approve"], CHAT).status).toBe(0);
      expect(field(proj, "GATE_APPROVED", "Message Id")).toBe(id);
      expect(field(proj, "GATE_APPROVED", "Message Ids")).toBeNull();
    });

    // The learnings question's answer is that answer's: live, the approval after it kept both as one reply.
    const learnings = (proj: string) => expect(log(proj, ["decision", "--stage", "feasibility", "--decision",
      "Anything to add for next time?", "--options", "Nothing to add,Add a note", "--question-kind", "learnings-note"], CHAT)
      .status).toBe(0);

    test("the gate after the learnings answer keeps the approval, not the learnings reply", () => {
      const proj = gate(policy);
      learnings(proj);
      says(proj, "Nothing to add");
      const answered = log(proj, ["answer", "--stage", "feasibility", "--details", "Nothing to add"], CHAT);
      expect(answered.status, answered.out).toBe(0);
      const id = says(proj, "Approve");
      const approved = report(proj, ["--result", "approved", "--user-input", "Approve"], CHAT);
      expect(approved.status, approved.out).toBe(0);
      expect(field(proj, "GATE_APPROVED", "Person Reply")).toBe("Approve");
      expect(field(proj, "GATE_APPROVED", "Message Id")).toBe(id);
      expect(field(proj, "GATE_APPROVED", "Message Ids")).toBeNull();
    });

    test("one message that answered the learnings question and approved backs both rows whole", () => {
      const proj = gate(policy);
      learnings(proj);
      const id = says(proj, "Nothing to add, approve");
      const answered = log(proj, ["answer", "--stage", "feasibility", "--details", "Nothing to add"], CHAT);
      expect(answered.status, answered.out).toBe(0);
      expect(field(proj, "QUESTION_ANSWERED", "Message Id")).toBe(id);
      const approved = report(proj, ["--result", "approved", "--user-input", "Approve"], CHAT);
      expect(approved.status, approved.out).toBe(0);
      expect(field(proj, "GATE_APPROVED", "Person Reply")).toBe("Nothing to add, approve");
      expect(field(proj, "GATE_APPROVED", "Message Id")).toBe(id);
    });
  });
}

// A request refused for want of a named message leads with the ids the agent can
// name: this chat's, worked out as the proof works out the chat. Another chat's
// ids would invite an agent that cannot see which chat sent them (Copilot,
// opencode, Cursor hand it no ids of its own) to pick one by its time.
describe("t-named-message-any-chat: a refused request names this chat's messages only", () => {
  test("a lowering refused in a second chat names that chat's reply, never the first chat's", () => {
    // Under strict the review freeze check is on, so turning it off is the person's call.
    const proj = inception("strict");
    const first = says(proj, "turn the review freeze check off for this work");
    const mine = says(proj, "and keep going with the requirements", OTHER);
    const refused = spawn(proj, [UTILITY, "config-change", "--guard.review-freeze", "off", "--project-dir", proj], OTHER);
    expect(refused.status, refused.out).not.toBe(0);
    expect(refused.out).toContain(`If their message ${mine} (sent `);
    expect(refused.out).not.toContain(first);
  });
});
