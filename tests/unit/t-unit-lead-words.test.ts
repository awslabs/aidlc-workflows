// covers: subcommand:aidlc-unit:sign-off, subcommand:aidlc-unit:amend, subcommand:aidlc-unit:turned-down, subcommand:aidlc-unit:merged, subcommand:aidlc-unit:send-back, audit:UNIT_SENT_BACK
//
// The lead's word on a team's Unit is kept in the lead's own words (#2410; the
// design read's S10 B). The lead answers in their chat; the agent runs the
// verb with whatever it wrote to the request file. The record of a sign-off,
// an answer to a proposed change, a turn-down, a merge by word and a send-back
// keeps what the lead typed and the message it came in (main's message store:
// the message named with `--message <id>`, the reply held for the engine's own
// question, or this chat's replies since the last decision), never the agent's
// text labelled as theirs. What a team hears stays the words the agent relayed.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { fixtureIntentId8 } from "../harness/fixtures.ts";
import {
  claimPayload,
  cleanupTeamBuild,
  codeGenerated,
  git,
  hook,
  next,
  personsChat,
  refundsTaken,
  run,
  UNIT,
} from "../harness/team-build.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const REQUIREMENTS = "inception/requirements-analysis/requirements.md";

// The lead types in their own chat at the home: the prompt hook keeps the
// message and writes its turn. Returns the message's id as the turn names it.
function leadSays(dir: string, session: string, prompt: string): string {
  const said = hook(dir, personsChat(session), { hook_event_name: "UserPromptSubmit", session_id: session, prompt });
  expect(said.status, said.out).toBe(0);
  const turn = readAuditShardEvents(dir).findLast((row) => row.event === "HUMAN_TURN");
  const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
  expect(id, "the hook named the lead's message").not.toBeNull();
  return id as string;
}

function lastRow(dir: string, event: string): string {
  const row = readAuditShardEvents(dir).findLast((entry) => entry.event === event);
  expect(row, `${event} written`).toBeDefined();
  return row!.block;
}

function pushed() {
  const taken = refundsTaken();
  codeGenerated(taken.alice, taken.record);
  expect(run(UNIT, ["push"], taken.alice).status).toBe(0);
  git(taken.home.dir, ["fetch", "-q", "origin"]);
  return taken;
}

describe("the lead's word is kept in their own words, with the message it came in", () => {
  test("a sign-off", () => {
    const taken = refundsTaken();
    const { home } = taken;
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    codeGenerated(taken.alice, taken.record);
    expect(run(UNIT, ["push"], taken.alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    // Asked as the result arrives: the lead's reply comes while the question is on screen.
    expect(next(home.dir).ask_type).toBe("unit-signoff");
    const session = "t-unit-lead-words-signoff";
    const words = "hmm, billing still owes us the retry fix, but ok go";
    const id = leadSays(home.dir, session, words);
    const signed = run(UNIT, ["sign-off", "refunds", "--person-words", "Sign it off"], home.dir, personsChat(session));
    expect(signed.status, signed.out).toBe(0);
    const row = lastRow(home.dir, "QUESTION_ANSWERED");
    expect(auditBlockField(row, "Person Reply")).toBe(words);
    expect(auditBlockField(row, "Message Id")).toBe(id);
    expect((claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.signoff as { words?: string })?.words).toBe(words);
  });

  test("an answer to a team's proposed change", () => {
    const taken = refundsTaken();
    writeFileSync(join(taken.record, ...REQUIREMENTS.split("/")), "# Requirements\n\nFR1 refunds, partial amounts too.\n");
    expect(run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds need partial amounts"], taken.alice).status).toBe(0);
    git(taken.home.dir, ["fetch", "-q", "origin"]);
    const { home } = taken;
    expect(next(home.dir).ask_type).toBe("unit-amend");
    const session = "t-unit-lead-words-amend";
    const words = "fine by me, partial refunds are what finance asked for";
    const id = leadSays(home.dir, session, words);
    const amended = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "approve", "--person-words", "Approve it"],
      home.dir, personsChat(session));
    expect(amended.status, amended.out).toBe(0);
    const row = lastRow(home.dir, "QUESTION_ANSWERED");
    expect(auditBlockField(row, "Person Reply")).toBe(words);
    expect(auditBlockField(row, "Message Id")).toBe(id);
  });

  test("a turn-down", () => {
    const { home } = pushed();
    const session = "t-unit-lead-words-down";
    const words = "billing wants the ledger entry before this goes in, turn it down there";
    leadSays(home.dir, session, words);
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger entry"],
      home.dir, personsChat(session));
    expect(down.status, down.out).toBe(0);
    // The team hears what the agent relayed; the claim keeps what the lead typed beside it.
    const claimed = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.turned_down as { words?: string; person_reply?: string };
    expect(claimed?.person_reply).toBe(words);
    expect(claimed?.words).toBe("needs the ledger entry");
  });

  test("a merge by the lead's word", () => {
    const { home } = pushed();
    const session = "t-unit-lead-words-merged";
    const words = "billing merged it by hand last night, count it";
    leadSays(home.dir, session, words);
    const said = run(UNIT, ["merged", "refunds", "--repo", "billing", "--person-words", "merged by hand"], home.dir, personsChat(session));
    expect(said.status, said.out).toBe(0);
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds");
    expect((claim?.said_merged as Array<{ repo: string; words: string }>)?.find((entry) => entry.repo === "billing")?.words).toBe(words);
  });

  test("a send-back: the failure goes to the team, the lead's own words go on the record", () => {
    const { home } = pushed();
    const session = "t-unit-lead-words-back";
    const words = "send refunds back to payments, the browser can't call it";
    const id = leadSays(home.dir, session, words);
    const failure = "checkout-api sends no CORS headers";
    const sent = run(UNIT, ["send-back", "refunds", "--person-words", failure], home.dir, personsChat(session));
    expect(sent.status, sent.out).toBe(0);
    const row = lastRow(home.dir, "UNIT_SENT_BACK");
    expect(auditBlockField(row, "Person Reply")).toBe(words);
    expect(auditBlockField(row, "Message Id")).toBe(id);
    const claim = claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds");
    expect((claim?.turned_down as { words?: string })?.words).toBe(failure);
  });
});

describe("the message the agent names", () => {
  test("an earlier message of theirs named with --message is the one kept", () => {
    const { home } = pushed();
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    const session = "t-unit-lead-words-named";
    const words = "looks right to me, sign refunds off";
    const id = leadSays(home.dir, session, words);
    leadSays(home.dir, session, "and how is checkout-ui coming along?");
    const signed = run(UNIT, ["sign-off", "refunds", "--message", id, "--person-words", "Sign it off"], home.dir, personsChat(session));
    expect(signed.status, signed.out).toBe(0);
    const row = lastRow(home.dir, "QUESTION_ANSWERED");
    expect(auditBlockField(row, "Person Reply")).toBe(words);
    expect(auditBlockField(row, "Message Id")).toBe(id);
  });

  test("a message that is not on record is refused, and nothing is recorded", () => {
    const { home } = pushed();
    const session = "t-unit-lead-words-unknown";
    leadSays(home.dir, session, "billing merged it by hand, count it");
    const said = run(UNIT, ["merged", "refunds", "--repo", "billing", "--message", "msg-not-on-record"], home.dir, personsChat(session));
    expect(said.status).not.toBe(0);
    expect(String(said.json?.error ?? said.out)).toContain("no message record msg-not-on-record exists in this project");
    expect(claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.said_merged).toBeUndefined();
  });
});

// A live run on Claude Code: the lead signed refunds off when asked, then said billing turned it down; the hook
// held that message for the sign-off question already answered, so the turn-down kept none of the lead's words.
describe("once the lead answers the engine's question, their next words are their own", () => {
  test("a turn-down after a sign-off, in the same chat and in the next", () => {
    const taken = refundsTaken();
    const { home } = taken;
    expect(run(UNIT, ["lead-sign-off", "on"], home.dir).status).toBe(0);
    codeGenerated(taken.alice, taken.record);
    expect(run(UNIT, ["push"], taken.alice).status).toBe(0);
    git(home.dir, ["fetch", "-q", "origin"]);
    expect(next(home.dir).ask_type).toBe("unit-signoff");
    const session = "t-unit-lead-words-after-signoff";
    leadSays(home.dir, session, "looks right, sign refunds off");
    expect(run(UNIT, ["sign-off", "refunds", "--person-words", "Sign it off"], home.dir, personsChat(session)).status).toBe(0);
    const words = "billing just turned refunds down in review: it needs the ledger entry first";
    leadSays(home.dir, session, words);
    expect(auditBlockField(lastRow(home.dir, "HUMAN_TURN"), "Open Question")).toBeNull();
    const down = run(UNIT, ["turned-down", "refunds", "--repo", "billing", "--person-words", "needs the ledger entry"],
      home.dir, personsChat(session));
    expect(down.status, down.out).toBe(0);
    expect((claimPayload(home.remote, fixtureIntentId8(home.dir), "refunds")?.turned_down as { person_reply?: string })?.person_reply)
      .toBe(words);
    leadSays(home.dir, "t-unit-lead-words-after-signoff-2", "and how is checkout-ui coming along?");
    expect(auditBlockField(lastRow(home.dir, "HUMAN_TURN"), "Open Question")).toBeNull();
  });

  test("the lead's words after answering a team's proposed change", () => {
    const taken = refundsTaken();
    writeFileSync(join(taken.record, ...REQUIREMENTS.split("/")), "# Requirements\n\nFR1 refunds, partial amounts too.\n");
    expect(run(UNIT, ["propose", "--input", "requirements.md", "--person-words", "refunds need partial amounts"], taken.alice).status).toBe(0);
    git(taken.home.dir, ["fetch", "-q", "origin"]);
    const { home } = taken;
    expect(next(home.dir).ask_type).toBe("unit-amend");
    const session = "t-unit-lead-words-after-amend";
    leadSays(home.dir, session, "no, keep refunds whole for now");
    const answered = run(UNIT, ["amend", "refunds", "--input", REQUIREMENTS, "--answer", "reject", "--person-words", "Turn it down"],
      home.dir, personsChat(session));
    expect(answered.status, answered.out).toBe(0);
    expect(auditBlockField(lastRow(home.dir, "QUESTION_ANSWERED"), "Question Type")).toBe("unit-amend");
    leadSays(home.dir, session, "what else is waiting on me?");
    expect(auditBlockField(lastRow(home.dir, "HUMAN_TURN"), "Open Question")).toBeNull();
  });
});
