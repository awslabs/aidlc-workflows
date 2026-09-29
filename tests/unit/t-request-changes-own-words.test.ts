// covers: function:recordGateWords, function:clearGateWords, function:gateWordsSincePresentation
// covers: function:personsGateFeedback, function:GATE_WORDS_SPENT_BY
//
// Request Changes at a stage gate records what the person typed, not the
// conductor's rewording of it. Observed live on Kiro IDE: the person typed
//   Call the list command "todo ls" instead of "todo list", and keep "done" as it is.
// and the audit's GATE_REJECTED and STAGE_REVISING Feedback held the agent's
// paraphrase. These cases drive the real human-turn hook (through the
// dispatcher, as every harness does) and the real `report --result rejected`:
//
//   - the typed words are the Feedback, exactly, quotes and punctuation kept;
//     the conductor's --reason is kept beside them as the Conductor Summary;
//   - "Request Changes", then the answer to "What should change?", records the
//     answer; several messages are joined in order;
//   - with no recorded words (no prompt text, no session, a slash command or
//     guard switch, words from before the gate or from another chat, words over
//     the bound) the row is exactly what the conductor's text made before;
//   - the kept words are cleared once a gate is presented or answered.

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  clearGateWords,
  GATE_WORDS_SPENT_BY,
  gateWordsSincePresentation,
  personsGateFeedback,
  readAuditShardEvents,
  recordGateWords,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { isTypedGuardSwitchPrompt } from "../../dist/claude/.claude/tools/aidlc-guard-switch.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c0de";
const OTHER_SESSION = "01995000-7a11-7000-8000-00000000beef";

// What the person typed at the gate, and what the agent reported instead.
const TYPED = 'Call the list command "todo ls" instead of "todo list", and keep "done" as it is.';
const PARAPHRASE = 'Rename the list command from "todo list" to "todo ls"; keep "done" as is.';
const PUNCTUATED = `Rename "a & b" to 'c|d' (not <e>); keep 100% of $HOME & the rest, OK?! {f} = g \\ h`;

function run(
  tool: string,
  args: string[],
  session: string | null,
  extra: Record<string, string> = {},
): { rc: number; out: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
    AIDLC_UNATTENDED: "0",
    ...extra,
  };
  delete env.AIDLC_SESSION_OVERRIDE;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  if (session !== null) env.AIDLC_SESSION_OVERRIDE = session;
  const r = spawnSync(BUN, [tool, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const state = (proj: string, args: string[]) =>
  run(STATE, [...args, "--project-dir", proj], null, { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" });

// `report` as the agent runs it in this chat.
function report(proj: string, args: string[], session: string | null = SESSION): { kind: string; message?: string } {
  const r = run(ORCHESTRATE, ["report", ...args, "--project-dir", proj], session);
  const line = r.out.split("\n").find((entry) => entry.startsWith("{"));
  expect(line, r.out).toBeDefined();
  return JSON.parse(line as string) as { kind: string; message?: string };
}

const rejectWith = (proj: string, slug: string, extra: string[], session: string | null = SESSION) =>
  report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes", ...extra], session);

// The real UserPromptSubmit route every harness uses.
function typed(proj: string, payload: Record<string, unknown>, session: string = SESSION, extraEnv: Record<string, string> = {}): void {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: session,
    ...extraEnv,
  };
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify(payload),
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

const says = (proj: string, prompt: string, session: string = SESSION, extraEnv: Record<string, string> = {}) =>
  typed(proj, { hook_event_name: "UserPromptSubmit", session_id: session, prompt }, session, extraEnv);

const rows = (proj: string, name: string) => readAuditShardEvents(proj).filter((row) => row.event === name);
const field = (proj: string, name: string, key: string) => {
  const found = rows(proj, name);
  expect(found.length).toBeGreaterThan(0);
  return auditBlockField(found[found.length - 1].block, key);
};
const wordsDir = (proj: string) => join(seededRecordDir(proj), ".aidlc-engine", "gate-words");

// The GATE_REJECTED block as the renderer wrote it, with its timestamp masked.
function rejectedBlock(proj: string): string[] {
  const found = rows(proj, "GATE_REJECTED");
  expect(found).toHaveLength(1);
  return found[0].block.split("\n").filter((line) => line.length > 0)
    .map((line) => line.replace(/^\*\*Timestamp\*\*: .*$/, "**Timestamp**: <t>"));
}

describe("Request Changes records the person's own words", () => {
  let proj: string;
  let slug: string;

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    slug = state(proj, ["get", "Current Stage"]).out.trim();
    state(proj, ["checkbox", `${slug}=in-progress`]);
    state(proj, ["gate-start", slug]);
  });
  afterEach(() => cleanupTestProject(proj));

  test.each([TYPED, PUNCTUATED])("the typed words are the Feedback; the paraphrase is the Conductor Summary: %s", (words) => {
    says(proj, words);
    const directive = rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(directive.kind, JSON.stringify(directive)).toBe("print");
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(words);
    expect(field(proj, "GATE_REJECTED", "Conductor Summary")).toBe(PARAPHRASE);
    expect(field(proj, "STAGE_REVISING", "Feedback")).toBe(words);
    expect(field(proj, "STAGE_REVISING", "Conductor Summary")).toBeNull();
    // The revision is handed exactly what they said.
    expect(directive.message).toStartWith(`Recorded rejected for "${slug}".`);
    expect(directive.message).toContain(`revise from exactly what they said: ${JSON.stringify(words)}`);
    // Short-lived: answered, the kept words are gone.
    expect(existsSync(wordsDir(proj))).toBe(false);
  });

  test("the words alone are enough: no --reason, no extra round", () => {
    says(proj, "Request Changes");
    says(proj, TYPED);
    const directive = rejectWith(proj, slug, []);
    expect(directive.kind, JSON.stringify(directive)).toBe("print");
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(TYPED);
    expect(field(proj, "GATE_REJECTED", "Conductor Summary")).toBeNull();
  });

  test("Request Changes, then the answer to \"What should change?\", records the answer", () => {
    says(proj, "Request Changes");
    says(proj, TYPED);
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(TYPED);
    expect(field(proj, "GATE_REJECTED", "Conductor Summary")).toBe(PARAPHRASE);
    expect(field(proj, "STAGE_REVISING", "Feedback")).toBe(TYPED);
  });

  test("several messages since the gate are joined in order, each verbatim", () => {
    says(proj, "2");
    says(proj, "Rename the list command to todo ls.");
    says(proj, "And keep done as it is.");
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    // The renderer escapes the line break inside one audit field.
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe("Rename the list command to todo ls.\\nAnd keep done as it is.");
  });

  test("a conductor that passes the same words adds no Conductor Summary", () => {
    says(proj, TYPED);
    rejectWith(proj, slug, ["--reason", `  ${TYPED.replace(/ /g, "  ")} `]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(TYPED);
    expect(field(proj, "GATE_REJECTED", "Conductor Summary")).toBeNull();
  });

  test("with no recorded words the row is the conductor's text, exactly as before", () => {
    // A harness that passes no prompt text still mints the human turn.
    says(proj, "");
    const directive = rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(directive).toEqual({ kind: "print", message: `Recorded rejected for "${slug}".` });
    expect(rejectedBlock(proj)).toEqual([
      "## Gate Rejected",
      "**Timestamp**: <t>",
      "**Event**: GATE_REJECTED",
      `**Stage**: ${slug}`,
      `**Feedback**: ${PARAPHRASE}`,
    ]);
    expect(field(proj, "STAGE_REVISING", "Feedback")).toBe(PARAPHRASE);
  });

  test("a prompt with no session records no words", () => {
    typed(proj, { hook_event_name: "UserPromptSubmit", prompt: TYPED });
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(PARAPHRASE);
    expect(field(proj, "GATE_REJECTED", "Conductor Summary")).toBeNull();
  });

  test("an unattended driver records no words", () => {
    says(proj, TYPED, SESSION, { AIDLC_UNATTENDED: "1" });
    // Its turn minted nothing, so a person must still act at the gate.
    appendAuditEntry("HUMAN_TURN", {}, proj);
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(PARAPHRASE);
  });

  test("slash commands and typed guard switches are not feedback", () => {
    expect(isTypedGuardSwitchPrompt("guard policy relaxed")).toBe(true);
    says(proj, "/aidlc --status");
    says(proj, "guard policy relaxed");
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(PARAPHRASE);
    expect(field(proj, "GATE_REJECTED", "Conductor Summary")).toBeNull();
  });

  test("a slash command beside the feedback leaves only the feedback", () => {
    says(proj, "/aidlc --status");
    says(proj, TYPED);
    says(proj, "guard policy relaxed");
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(TYPED);
  });

  test("messages from another chat session are not used", () => {
    says(proj, TYPED, OTHER_SESSION);
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(PARAPHRASE);
    expect(field(proj, "GATE_REJECTED", "Conductor Summary")).toBeNull();
  });

  test("this chat's words are used, not another chat's typed alongside", () => {
    says(proj, "Drop the done command.", OTHER_SESSION);
    says(proj, TYPED);
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(TYPED);
  });

  test("a reject whose chat is unknown falls back to the conductor's text", () => {
    says(proj, TYPED);
    rejectWith(proj, slug, ["--reason", PARAPHRASE], null);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(PARAPHRASE);
  });

  test("a message over the size bound is not stood in for by the rest", () => {
    says(proj, "Rename the list command.");
    says(proj, `Also: ${"x".repeat(8001)}`);
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(PARAPHRASE);
  });

  test("free text typed into the gate picker is the person's; a picked label is not", () => {
    const question = "Requirements Analysis is ready. How would you like to proceed?";
    const picker = (answer: string) => typed(proj, {
      hook_event_name: "PostToolUse",
      session_id: SESSION,
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question, options: [{ label: "Approve (Recommended)" }, { label: "Request Changes" }] }] },
      tool_response: { answers: { [question]: answer } },
    });
    picker("Request Changes");
    picker(TYPED);
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(TYPED);
  });

  test("approving spends the kept words and records the approval as before", () => {
    says(proj, "looks good");
    expect(existsSync(wordsDir(proj))).toBe(true);
    const directive = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "looks good"]);
    expect(directive.kind, JSON.stringify(directive)).toBe("done");
    expect(field(proj, "GATE_APPROVED", "User Input")).toBe("Approve");
    expect(existsSync(wordsDir(proj))).toBe(false);
  });

  test("a revised gate starts fresh: only words after its re-presentation count", () => {
    says(proj, "Rename the list command.");
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    says(proj, "While you revise: also check the help text.");
    expect(report(proj, ["--stage", slug, "--result", "revised"]).kind).toBe("print");
    says(proj, TYPED);
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    const rejected = rows(proj, "GATE_REJECTED");
    expect(rejected).toHaveLength(2);
    expect(auditBlockField(rejected[0].block, "Feedback")).toBe("Rename the list command.");
    expect(auditBlockField(rejected[1].block, "Feedback")).toBe(TYPED);
  });
});

describe("the words are ordered against the gate row, not by time", () => {
  let proj: string;
  let slug: string;

  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
    slug = state(proj, ["get", "Current Stage"]).out.trim();
    state(proj, ["checkbox", `${slug}=in-progress`]);
  });
  afterEach(() => cleanupTestProject(proj));

  // An owning emitter's gate row, written without the engine's clear, so only
  // the shard offsets can tell a message before the gate from one after it.
  const presentWithoutClearing = () => {
    appendAuditEntry("STAGE_AWAITING_APPROVAL", { Stage: slug }, proj);
    state(proj, ["checkbox", `${slug}=awaiting-approval`]);
  };

  test("a message typed before the gate was presented is not used", () => {
    says(proj, "Before you finish: keep it short.");
    presentWithoutClearing();
    expect(gateWordsSincePresentation(proj, SESSION, { stage: slug })).toBeNull();
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(PARAPHRASE);
  });

  test("of messages on both sides of the presentation, only the later count", () => {
    says(proj, "Before you finish: keep it short.");
    presentWithoutClearing();
    says(proj, TYPED);
    expect(gateWordsSincePresentation(proj, SESSION, { stage: slug })).toEqual([TYPED]);
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(TYPED);
  });

  test("a gate never presented (the direct Active to Revising path) has no words", () => {
    says(proj, TYPED);
    rejectWith(proj, slug, ["--reason", PARAPHRASE]);
    expect(field(proj, "GATE_REJECTED", "Feedback")).toBe(PARAPHRASE);
  });

  test("the library reads: bare choices dropped, other chats and units apart, clear spends", () => {
    presentWithoutClearing();
    appendAuditEntry("HUMAN_TURN", {}, proj);
    recordGateWords(proj, SESSION, "Request Changes");
    recordGateWords(proj, SESSION, `  ${TYPED}  `);
    recordGateWords(proj, SESSION, "cancel");
    expect(gateWordsSincePresentation(proj, SESSION, { stage: slug })).toEqual(["Request Changes", TYPED, "cancel"]);
    expect(personsGateFeedback(proj, SESSION, { stage: slug, acceptAsIs: false })).toBe(TYPED);
    expect(personsGateFeedback(proj, OTHER_SESSION, { stage: slug, acceptAsIs: false })).toBeNull();
    expect(personsGateFeedback(proj, null, { stage: slug, acceptAsIs: false })).toBeNull();
    expect(personsGateFeedback(proj, SESSION, { stage: "some-other-stage", acceptAsIs: false })).toBeNull();
    expect(personsGateFeedback(proj, SESSION, { stage: slug, unit: "alpha", acceptAsIs: false })).toBeNull();
    // A corrupt file reads as no words.
    const file = join(wordsDir(proj), readdirSync(wordsDir(proj))[0]);
    writeFileSync(file, "{not json", "utf-8");
    expect(personsGateFeedback(proj, SESSION, { stage: slug, acceptAsIs: false })).toBeNull();
    expect([...GATE_WORDS_SPENT_BY].sort()).toEqual(["GATE_APPROVED", "GATE_REJECTED", "STAGE_AWAITING_APPROVAL"]);
    clearGateWords(proj);
    expect(existsSync(wordsDir(proj))).toBe(false);
    clearGateWords(proj);
  });

  test("the store keeps a bounded number of messages; older ones stop the words standing alone", () => {
    presentWithoutClearing();
    appendAuditEntry("HUMAN_TURN", {}, proj);
    for (let i = 1; i <= 9; i++) recordGateWords(proj, SESSION, `change ${i}`);
    expect(gateWordsSincePresentation(proj, SESSION, { stage: slug })).toBeNull();
  });
});
