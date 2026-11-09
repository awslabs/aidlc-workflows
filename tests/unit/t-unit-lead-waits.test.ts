// covers: subcommand:aidlc-unit:send-back, function:leadWaitsOnTeams, function:unitBuildPastCodeGeneration, audit:ASKED_CHANGE_ALLOWED
//
// While the lead's project waits at Code Generation on Units the teams build,
// nothing is built there, and the board is the step `next` gives. A live run
// (Claude Code, Linux, a Unit sent back to its team): after a send-back from
// the lead's Build and Test, every write the lead asked for in the project, and
// a compound read, was refused by the plan-approval guard with "Run next", and
// next printed the board: a loop with no way out. At that wait the agent's own
// change is still refused, in one sentence that says the wait (which Units wait
// on which teams, and that nothing is built here meanwhile) and names no step;
// the person's own ask, before or after that refusal, lets it through, with a
// row naming their message and their words. The same refusal never comes back
// for what they asked, and a Unit the lead builds here keeps its plan. The
// team's twin, a Unit's build whose Code Generation is approved, leaves the
// same row when the person's ask runs there.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTeamBuild,
  cloneCode,
  cloneOf,
  codeHost,
  ENV,
  git,
  HOME_RECORD,
  hook,
  homeState,
  makeHome,
  next,
  personsChat,
  refundsTaken,
  run,
  STATE,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const OPEN = "# Unit dependencies\n\n```yaml\nunits:\n  - name: refunds\n    depends_on: []\n" +
  "  - name: reporting\n    repos: [ledger]\n    depends_on: []\n```\n";
const CHAT = "t-unit-lead-waits-chat";
const FAILURE = "the refund route never calls the notices handler";
const WAIT = "refunds waits on the payments team and reporting on the data team, so nothing is built here " +
  "meanwhile: the files here change only when you ask for a change.";

// The lead's own chat: its commands carry the chat, as the host's hooks name it.
const LEAD: NodeJS.ProcessEnv = { ...ENV, AIDLC_SESSION_OVERRIDE: CHAT };

// The person types in their chat: the prompt hook keeps the message and writes its turn.
function leadSays(dir: string, prompt: string, chat = CHAT): string {
  const said = hook(dir, personsChat(chat), { hook_event_name: "UserPromptSubmit", session_id: chat, prompt });
  expect(said.status, said.out).toBe(0);
  const turn = readAuditShardEvents(dir).findLast((row) => row.event === "HUMAN_TURN");
  const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
  expect(id, "the hook named the lead's message").not.toBeNull();
  return id as string;
}

// The agent's tool call in the person's chat, as Claude Code hands it to the guard.
function call(dir: string, tool: string, input: Record<string, unknown>, chat = CHAT, extra: NodeJS.ProcessEnv = {}) {
  return hook(dir, { ...personsChat(chat), ...extra }, { hook_event_name: "PreToolUse", session_id: chat, tool_name: tool, tool_input: input });
}
const write = (dir: string, path: string, chat = CHAT, extra: NodeJS.ProcessEnv = {}) =>
  call(dir, "Write", { file_path: join(dir, ...path.split("/")), content: `# For the data team\n\n${FAILURE}\n` }, chat, extra);
// The refusal as the host shows it: the hook's decision line (the stderr copy follows it).
const reason = (out: string): string => {
  try {
    return String(JSON.parse(out.split("\n")[0]).hookSpecificOutput?.permissionDecisionReason ?? out);
  } catch {
    return out;
  }
};

// refunds held for payments, reporting for data; a data member's clone takes
// reporting, builds it and pushes it; then the lead's Build and Test fails on
// reporting, the lead sends it back, and the lead's project goes back to Code
// Generation to wait for it, as the step says. The board is the step there.
function leadWaits(policy?: "relaxed" | "off") {
  const home = makeHome({
    dependencies: OPEN,
    repos: { ledger: "" },
    ...(policy ? { state: homeState([`- **Guard Policy**: ${policy} (set by you)`]) } : {}),
  });
  expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
  expect(run(UNIT, ["assign", "refunds=payments", "reporting=data"], home.dir).status).toBe(0);
  expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
  const partner = cloneOf(home.remote, "dana");
  cloneCode(codeHost("ledger"), partner, "ledger", "dana");
  const took = run(UNIT, ["take", "reporting", "--home", HOME_RECORD, "--team", "data"], partner);
  expect(took.status, took.out).toBe(0);
  const intents = join(partner, "aidlc", "spaces", "data", "intents");
  const record = join(intents, readdirSync(intents).find((name) => name.endsWith("-reporting"))!);
  mkdirSync(join(partner, "ledger", "src"), { recursive: true });
  writeFileSync(join(partner, "ledger", "src", "report.ts"), "export const report = 1;\n");
  const stage = join(record, "construction", "reporting", "code-generation");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
    stage: "code-generation", unit: "reporting", version: 1, writes: [{ path: "src/report.ts" }],
  })}\n`);
  const pushed = run(UNIT, ["push"], partner);
  expect(pushed.status, pushed.out).toBe(0);
  // The lead's clone fetches the result the push put on the claim.
  git(home.dir, ["fetch", "-q", "origin"]);
  // The lead's Build and Test failed on reporting.
  const statePath = seededStateFile(home.dir);
  writeFileSync(statePath, readFileSync(statePath, "utf-8").replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test"));
  leadSays(home.dir, "Send it back to the data team with this failure");
  const step = next(home.dir, LEAD, ["--stage", "code-generation", "--unit", "reporting"]);
  const reopen = /`[^`]*aidlc-jump\.ts reopen ([^`]*)`/.exec(String(step.message))?.[1];
  expect(reopen, String(step.message)).toBeString();
  const sent = run(UNIT, ["send-back", "reporting", "--person-words", FAILURE], home.dir, LEAD);
  expect(sent.status, sent.out).toBe(0);
  const reopened = run(JUMP, ["reopen", ...reopen!.split(" ")], home.dir, LEAD);
  expect(reopened.status, reopened.out).toBe(0);
  expect(readFileSync(statePath, "utf-8")).toMatch(/^- \*\*Current Stage\*\*: code-generation$/m);
  const board = next(home.dir, LEAD);
  expect(String(board.narration)).toContain("- reporting, data: sent back from your Build and Test, back with data");
  expect(String(board.message)).toContain("end the turn");
  return { home };
}

const allowed = (dir: string) => readAuditShardEvents(dir).filter((row) => row.event === "ASKED_CHANGE_ALLOWED");

describe("while the lead's project waits on the teams at Code Generation", () => {
  for (const policy of [undefined, "relaxed", "off"] as const) {
    test(`Guard Policy ${policy ?? "as the scope sets it"}: the agent's own write is refused with the wait in plain words, naming no step`, () => {
      const { home } = leadWaits(policy);
      const own = write(home.dir, "notes/for-data.md");
      expect(own.status, own.out).toBe(2);
      expect(reason(own.out).trim()).toBe(WAIT);
      expect(own.out).not.toContain("next");
      expect(allowed(home.dir)).toHaveLength(0);
    });

    test(`Guard Policy ${policy ?? "as the scope sets it"}: the person's own ask lets the write through, with a row naming their message and words`, () => {
      const { home } = leadWaits(policy);
      expect(write(home.dir, "notes/for-data.md").status).toBe(2);
      const words = "Yes, one file per team that I can mail them";
      const id = leadSays(home.dir, words);
      const theirs = write(home.dir, "notes/for-data.md");
      expect(theirs.status, theirs.out).toBe(0);
      const rows = allowed(home.dir);
      expect(rows).toHaveLength(1);
      expect(auditBlockField(rows[0].block, "Message Id")).toBe(id);
      expect(auditBlockField(rows[0].block, "Person Reply")).toBe(words);
      expect(auditBlockField(rows[0].block, "Tool")).toBe("Write");
      expect(auditBlockField(rows[0].block, "Target")).toBe("notes/for-data.md");
      expect(auditBlockField(rows[0].block, "Waiting")).toBe("refunds=payments, reporting=data");
    });
  }

  test("an unattended run: the person's turn on record lifts nothing, and the refusal is the same sentence", () => {
    const { home } = leadWaits();
    leadSays(home.dir, "Yes, one file per team that I can mail them");
    const held = write(home.dir, "notes/for-data.md", CHAT, { AIDLC_UNATTENDED: "1" });
    expect(held.status, held.out).toBe(2);
    expect(reason(held.out).trim()).toBe(WAIT);
    expect(allowed(home.dir)).toHaveLength(0);
  });

  test("asked before the agent tries: their note and the compound read on their question run, with no refusal", () => {
    const { home } = leadWaits();
    leadSays(home.dir, "How does the data team get this? Write them a note with what Build and Test found.");
    const read = call(home.dir, "Bash", {
      command: `date; grep -n -i "current stage\\|^## " aidlc/spaces/default/intents/${HOME_RECORD}/aidlc-state.md | head -30`,
    });
    expect(read.status, read.out).toBe(0);
    expect(write(home.dir, "aidlc/notes-for-data.md").status).toBe(0);
    expect(allowed(home.dir)).toHaveLength(2);
  });

  test("no loop: refused, the person asks, it runs, the rest of their ask runs too, and the agent's own write after a decision is refused again", () => {
    const { home } = leadWaits();
    const first = write(home.dir, "notes/for-data.md");
    expect(reason(first.out).trim()).toBe(WAIT);
    leadSays(home.dir, "yes, write it, and one for payments too");
    expect(write(home.dir, "notes/for-data.md").status).toBe(0);
    expect(write(home.dir, "notes/for-payments.md").status).toBe(0);
    expect(allowed(home.dir)).toHaveLength(2);
    // A decision recorded after their turn spends it: the agent's next change on
    // its own waits for their word again, with the same sentence.
    appendAuditEntry("GATE_APPROVED", { Stage: "build-and-test", Details: "Approve" }, home.dir);
    const after = write(home.dir, "notes/for-web.md");
    expect(after.status, after.out).toBe(2);
    expect(reason(after.out).trim()).toBe(WAIT);
  });

  test("a Unit the lead builds here keeps its plan: the person's word to build it here ends the wait's pass", () => {
    const home = makeHome({ dependencies: OPEN, repos: { ledger: "" } });
    expect(run(STATE, ["set-unit-ownership", "team"], home.dir).status).toBe(0);
    expect(run(UNIT, ["assign", "--open", "refunds", "reporting=data"], home.dir).status).toBe(0);
    expect(run(UNIT, ["share", "--plan"], home.dir).status).toBe(0);
    const statePath = seededStateFile(home.dir);
    writeFileSync(statePath, readFileSync(statePath, "utf-8").replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    next(home.dir, LEAD);
    // The wait is recorded: the agent's own write hears it, an open Unit in its own words.
    expect(reason(write(home.dir, "notes/for-data.md").out).trim()).toStartWith("refunds waits for a team to take it and reporting on the data team");
    leadSays(home.dir, "build refunds here");
    const here = run(UNIT, ["assign", "--here", "refunds", "--person-words", "build refunds here"], home.dir, LEAD);
    expect(here.status, here.out).toBe(0);
    const code = write(home.dir, "app/src/refunds.ts");
    expect(code.status, code.out).toBe(2);
    expect(reason(code.out)).not.toBe(WAIT);
    expect(allowed(home.dir)).toHaveLength(0);
  });
});

// This PR's push-question twin: in a Unit's build whose Code Generation is
// approved, what the person asks for runs on their turn, and that pass now
// leaves the same row, with the build's Unit.
describe("in a Unit's build whose Code Generation is approved", () => {
  test("the person's own ask runs, with a row naming their message, their words and the Unit", () => {
    const { alice, record } = refundsTaken();
    const chat = "t-unit-lead-waits-alice";
    next(alice, { ...ENV, AIDLC_SESSION_OVERRIDE: chat });
    const statePath = join(record, "aidlc-state.md");
    writeFileSync(statePath, readFileSync(statePath, "utf-8")
      .replace(/^- \[[-? ]\] code-generation /m, "- [x] code-generation ")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"));
    const own = write(alice, "billing/README.md", chat);
    expect(own.status, own.out).toBe(2);
    expect(reason(own.out).trim()).toBe("Your Unit is built and approved: its code changes only when you ask for a change.");
    const words = "add a line to the end of billing/README.md";
    const id = leadSays(alice, words, chat);
    const theirs = write(alice, "billing/README.md", chat);
    expect(theirs.status, theirs.out).toBe(0);
    const rows = allowed(alice);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Message Id")).toBe(id);
    expect(auditBlockField(rows[0].block, "Person Reply")).toBe(words);
    expect(auditBlockField(rows[0].block, "Unit")).toBe("refunds");
    expect(auditBlockField(rows[0].block, "Target")).toBe("billing/README.md");
  });
});
