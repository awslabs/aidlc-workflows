// covers: function:kiroContextPressure, function:kiroChatRecordOrigin, subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next
//
// Kiro shows the person how full the chat is, but gives the agent no figure,
// so the skills' "park only when a figure of 80% or more was surfaced" could
// never happen and nothing told the person anything (#2574). The engine now
// reads Kiro's own record of the chat, read only: Kiro CLI's default engine
// keeps the figure in ~/.kiro/sessions/cli/<chat>.json, Kiro CLI v3 and Kiro
// IDE summarize the chat on their own at 80% and leave a `summarization` row in
// ~/.kiro/sessions/<workspace>/<chat>/messages.jsonl. Beside a question the
// person is asked anyway (a stage's approval, a Unit's checkpoint) it offers
// once per chat to pause and carry on in a new chat; their answer decides.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, createTestProject, FIXTURES_DIR, REPO_ROOT,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const TREES = {
  kiro: join(REPO_ROOT, "dist", "kiro", ".kiro"),
  "kiro-ide": join(REPO_ROOT, "dist", "kiro-ide", ".kiro"),
  claude: AIDLC_SRC,
} as const;
type Tree = keyof typeof TREES;
const STAGE = "requirements-analysis";
// The state file's separator between a stage slug and its action.
const SEPARATOR = "\u2014";
const usageLine = (n: number) =>
  `This chat is about ${n}% full by Kiro's count, and once it fills the agent carries on from a summary. ` +
  "Do you want to pause here and carry on in a new chat? I recommend it: the work is saved, and a new chat " +
  "picks it up from the saved files.";
const SUMMARIZED_LINE =
  "Kiro has summarized this chat to make room, so the agent now works from a summary of what came before. " +
  "Do you want to pause here and carry on in a new chat? I recommend it: your work is saved, and a new chat " +
  "picks it up from the saved files.";
const offered = (text: string | undefined): boolean => /full by Kiro's count|Kiro has summarized this chat/.test(text ?? "");
// A chat whose first turn on the work already took half the window: a new chat
// on the same model would start about that full (#3642). The figure names
// Kiro's count as its source: on Kiro CLI 3.1.0 the agent left out the sentence
// that gave it bare, twice.
const onSameModel = (n: number, model?: string) =>
  `By Kiro's count this chat was about ${n}% full in its first turn on this work, so a new chat on the same ` +
  `model${model ? ` (${model})` : ""} will not help much.`;
const noRoomSummarized = (n: number, model?: string) =>
  "Kiro has summarized this chat to make room, so the agent now works from a summary of what came before. " +
  onSameModel(n, model);
// Every sentence of the line that gives a figure says whose figure it is.
const figuresSourced = (line: string | undefined): boolean =>
  (line ?? "").split(/(?<=\.) /).filter((sentence) => /\d+%/.test(sentence)).every((sentence) => /by Kiro's count/i.test(sentence));
// The near-full line asks nothing, so it rides as a change notice, which the
// agent says as written (left out of the narration, measured live on Kiro CLI
// 3.1.0); today's offer stays in the narration.
const notices = (reply: { change_notices?: string[] }) => reply.change_notices ?? [];
const noRoomUsage = (figure: number, n: number, model?: string) =>
  `This chat is about ${figure}% full by Kiro's count, and once it fills the agent carries on from a summary. ` +
  onSameModel(n, model);

function home(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t-kiro-ctx-home-")));
  created.push(dir);
  return dir;
}

// Kiro CLI's default engine: one JSON file per chat, the figure saved at the end of a turn.
function v2Record(
  homeDir: string, chat: string, percentage: unknown, turns: Array<Record<string, unknown>> = [], model?: string,
): void {
  const dir = join(homeDir, ".kiro", "sessions", "cli");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${chat}.json`), `${JSON.stringify({
    session_id: chat, cwd: "/work", created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:10:00Z",
    session_state: {
      version: "v1", agent_name: "aidlc",
      conversation_metadata: { last_context_usage: { percentage, model_id: model ?? "auto" }, user_turn_metadatas: turns },
      rts_model_state: {
        context_usage_percentage: percentage,
        model_info: { ...(model ? { model_id: model } : {}), context_window_tokens: 200000 },
      },
    },
  })}\n`);
}

// One turn's figures as Kiro CLI's default engine saves them, its end time with
// the nine fractional digits Kiro writes.
const kiroTime = (offsetMs: number) => at(offsetMs).replace(/\.(\d{3})Z$/, ".$1091369Z");
const v2Turn = (offsetMs: number, start: number, end: number, model = "auto") => ({
  end_reason: "UserTurnEnd", end_timestamp: kiroTime(offsetMs), model,
  context_usage_percentage: start, final_context_usage_percentage: end,
});

// Kiro CLI's default engine also logs the chat beside it, one `kind` per line;
// a `Compaction` row is Kiro compacting the chat when it overflows, mid-turn too.
function v2Log(homeDir: string, chat: string, kinds: string[]): void {
  const row = (kind: string) => kind === "Prompt"
    ? { version: "v1", kind, data: { message_id: "m1", content: [{ kind: "text", data: "go on" }], meta: {} } }
    : kind === "Compaction"
    ? { version: "v1", kind, data: { summary: "Earlier work.", strategy: { message_pairs_to_exclude: 2 }, messages_snapshot: [] } }
    : { version: "v1", kind, data: { message_id: "a1", content: [] } };
  writeFileSync(join(homeDir, ".kiro", "sessions", "cli", `${chat}.jsonl`), `${kinds.map((kind) => JSON.stringify(row(kind))).join("\n")}\n`);
}

// Kiro CLI v3 and Kiro IDE: one wrapped row per line, as @kiro/agent writes them.
function v3Record(homeDir: string, chat: string, rows: Array<Record<string, unknown>>): void {
  const dir = join(homeDir, ".kiro", "sessions", "0123456789abcdef", chat);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "messages.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
// The chat's own settings file beside its record: the model now, and the model
// Kiro last told the agent about.
function v3Session(homeDir: string, chat: string, body: string): void {
  writeFileSync(join(homeDir, ".kiro", "sessions", "0123456789abcdef", chat, "session.json"), body);
}
const AUTO_DISPLAY = "Auto (model selected dynamically on the server)";
const sessionOn = (chat: string, modelId: string, told = modelId) =>
  JSON.stringify({
    id: chat, agentMode: "aidlc", modelId,
    contextSnapshotModelDisplay: { modelId: told, display: told === "auto" ? AUTO_DISPLAY : told },
  });
// The note Kiro writes at a chat's first prompt, and again after each summary.
const snapshotRow = (display: string, when: string) => ({
  id: `context_snapshot_${display.length}-${when}`, timestamp: when,
  payload: {
    type: "agent_note",
    content: "<session_context>\nOnly the last <session_context> block is current; it remains current until a later " +
      `block supersedes it.\nThe current model is ${display}.\n</session_context>`,
  },
});
// A figure in one turn (Kiro's `executionId` names the turn).
const turnRow = (percent: number, when: string, turn: string) => ({
  id: `meta-${turn}-${percent}`, timestamp: when,
  payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: percent }, executionId: turn },
});
const usageRow = (percent: number, when = at(0)) => ({
  id: `meta-${percent}`, timestamp: when,
  payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: percent }, executionId: "e1" },
});
const tombstone = (kind: string, when: string) => ({
  id: "tombstone_summarize_1", timestamp: when,
  payload: { type: "tombstone", kind, effectiveFromMessageId: "m1", metadata: { truncatedMessageCount: 40, truncatedAt: when } },
});
const userRow = (text: string) => ({
  id: "u1", timestamp: at(-120_000),
  payload: { type: "user", content: [{ type: "text", text }], _meta: { kiro: { userMessageTag: "prompt_1" } } },
});

// Everything under the scratch home, by content, so a test can say nothing of Kiro's changed.
function homeDigest(homeDir: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(`${path}\0`).update(readFileSync(path));
    }
  };
  walk(join(homeDir, ".kiro"));
  return hash.digest("hex");
}

// A bugfix at Requirements Analysis with its output written, and this chat's first turn on the work.
function project(chat: string): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n## FR-1\nList notes.\n", "utf-8");
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
  appendAuditEntry("HUMAN_TURN", { Session: chat, Origin: "person", Source: "typed" }, proj);
  return proj;
}

type Who = { tree: Tree; homeDir: string; chat?: string; ideChat?: string; env?: Record<string, string | undefined> };

// The environment the agent's own command runs with on each host: Kiro CLI
// names the chat in KIRO_SESSION_ID; Kiro IDE names none, and the engine finds
// the chat from the process tree, which a test stands in for with the
// hook-supplied identity.
function hostEnv(who: Who): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: who.homeDir,
    USERPROFILE: who.homeDir,
    KIRO_SESSION_ID: who.chat,
    AIDLC_SESSION_OVERRIDE: who.ideChat,
    AIDLC_SESSION_OVERRIDE_SOURCE: who.ideChat ? "payload" : undefined,
    CLAUDE_CODE_SESSION_ID: undefined,
    CLAUDE_PID: undefined,
    CODEX_THREAD_ID: undefined,
    AIDLC_HARNESS_DIR: undefined,
    AIDLC_HARNESS_NAME: undefined,
    AIDLC_UNATTENDED: undefined,
    AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    ...who.env,
  };
}

function report(proj: string, who: Who) {
  const result = spawnSync(process.execPath, [
    join(TREES[who.tree], "tools", "aidlc-orchestrate.ts"), "report", "--stage", STAGE, "--result", "awaiting-approval",
    "--project-dir", proj,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: hostEnv(who) });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse((result.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "{}") as {
    kind: string; narration?: string; change_notices?: string[];
  };
}

describe("t-kiro-context-offer: Kiro CLI's default engine, the figure Kiro saved", () => {
  test("at 80% or more the approval question carries the offer once in this chat, with the figure", () => {
    const chat = "27b3d4ec-5cf4-4fbb-b0fb-b0d3f8a53e47";
    const homeDir = home();
    v2Record(homeDir, chat, 84.3061);
    const proj = project(chat);
    const before = homeDigest(homeDir);
    const first = report(proj, { tree: "kiro", homeDir, chat });
    expect(first.kind).toBe("print");
    expect(first.narration).toStartWith("Requirements Analysis is ready for your review.");
    expect(first.narration?.split("\n").at(-1)).toBe(usageLine(84));
    // The gate shown again in the same chat: said once, whatever the figure now.
    v2Record(homeDir, chat, 91);
    const again = report(proj, { tree: "kiro", homeDir, chat });
    expect(offered(again.narration)).toBe(false);
    expect(offered(again.change_notices?.join(" "))).toBe(false);
    // Read only: nothing of Kiro's changed.
    v2Record(homeDir, chat, 84.3061);
    expect(homeDigest(homeDir)).toBe(before);
  });

  // Measured live on Kiro CLI 2.29.0: the chat was 85.7% at the end of a turn,
  // Kiro compacted it part way through the next (a `Compaction` row after the
  // turn's `Prompt`), and the figure stays the old one until the turn ends.
  test("a compaction in this turn, after the figure was saved, is said as a summary, not as the old figure", () => {
    const chat = "99999999-9999-4999-8999-999999999999";
    const homeDir = home();
    v2Record(homeDir, chat, 85.7245);
    v2Log(homeDir, chat, ["Prompt", "AssistantMessage", "ToolResults", "Prompt", "AssistantMessage", "Compaction", "ToolResults", "AssistantMessage"]);
    const proj = project(chat);
    expect(report(proj, { tree: "kiro", homeDir, chat }).narration?.split("\n").at(-1)).toBe(SUMMARIZED_LINE);
  });

  test("a compaction in an earlier turn leaves the figure Kiro saved since", () => {
    const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const homeDir = home();
    v2Record(homeDir, chat, 41);
    v2Log(homeDir, chat, ["Prompt", "Compaction", "AssistantMessage", "Prompt", "AssistantMessage"]);
    const proj = project(chat);
    expect(offered(report(proj, { tree: "kiro", homeDir, chat }).narration)).toBe(false);
    v2Record(homeDir, chat, 82);
    expect(report(proj, { tree: "kiro", homeDir, chat }).narration?.split("\n").at(-1)).toBe(usageLine(82));
  });

  test("another chat at 80% hears it in its own chat", () => {
    const one = "11111111-1111-4111-8111-111111111111";
    const two = "22222222-2222-4222-8222-222222222222";
    const homeDir = home();
    v2Record(homeDir, one, 82);
    v2Record(homeDir, two, 95.6);
    const proj = project(one);
    appendAuditEntry("HUMAN_TURN", { Session: two, Origin: "person", Source: "typed" }, proj);
    expect(report(proj, { tree: "kiro", homeDir, chat: one }).narration?.split("\n").at(-1)).toBe(usageLine(82));
    expect(report(proj, { tree: "kiro", homeDir, chat: two }).narration?.split("\n").at(-1)).toBe(usageLine(96));
  });

  test("the gate shown again by next (a new chat at an open gate) says it once, with the step", () => {
    const opener = "77777777-7777-4777-8777-777777777777";
    const chat = "88888888-8888-4888-8888-888888888888";
    const homeDir = home();
    const proj = project(opener);
    expect(offered(report(proj, { tree: "kiro", homeDir, chat: opener }).narration)).toBe(false);
    v2Record(homeDir, chat, 90.2);
    appendAuditEntry("HUMAN_TURN", { Session: chat, Origin: "person", Source: "typed" }, proj);
    const step = () => {
      const result = runOrchestrateNext(join(TREES.kiro, "tools", "aidlc-orchestrate.ts"), proj, [], {
        env: hostEnv({ tree: "kiro", homeDir, chat }),
      });
      expect(result.directive, result.stderr).not.toBeNull();
      return result.directive as { gate_only?: boolean; change_notices?: string[] };
    };
    const shown = step();
    expect(shown.gate_only).toBe(true);
    expect(shown.change_notices ?? []).toContain(usageLine(90));
    expect(offered((step().change_notices ?? []).join(" "))).toBe(false);
  });

  test("below 80%, no record, or a record that does not parse: nothing is said", () => {
    const chat = "33333333-3333-4333-8333-333333333333";
    const homeDir = home();
    const proj = project(chat);
    const none = report(proj, { tree: "kiro", homeDir, chat });
    v2Record(homeDir, chat, 79.9);
    const below = report(proj, { tree: "kiro", homeDir, chat });
    expect(below.narration).toBe(none.narration);
    writeFileSync(join(homeDir, ".kiro", "sessions", "cli", `${chat}.json`), "{\"session_state\": ");
    expect(report(proj, { tree: "kiro", homeDir, chat }).narration).toBe(none.narration);
    v2Record(homeDir, chat, "84");
    expect(report(proj, { tree: "kiro", homeDir, chat }).narration).toBe(none.narration);
    expect(offered(none.narration)).toBe(false);
  });

  test("an unattended run says nothing", () => {
    const chat = "44444444-4444-4444-8444-444444444444";
    const homeDir = home();
    v2Record(homeDir, chat, 88);
    const proj = project(chat);
    expect(offered(report(proj, { tree: "kiro", homeDir, chat, env: { AIDLC_UNATTENDED: "1" } }).narration)).toBe(false);
  });
});

describe("t-kiro-context-offer: Kiro CLI v3 and Kiro IDE, right after Kiro summarized the chat", () => {
  test("a summarization since this chat's first turn on the work is said once (Kiro CLI v3)", () => {
    const chat = "sess_f3fedea3-3cb6-41f9-9e75-da9bf2fd1d36";
    const homeDir = home();
    const proj = project(chat);
    v3Record(homeDir, chat, [userRow("/aidlc"), usageRow(79.4, at(-120_000)), tombstone("summarization", at(60_000)), usageRow(20.1, at(61_000))]);
    const before = homeDigest(homeDir);
    const first = report(proj, { tree: "kiro-ide", homeDir, chat });
    expect(first.narration?.split("\n").at(-1)).toBe(SUMMARIZED_LINE);
    expect(offered(report(proj, { tree: "kiro-ide", homeDir, chat }).narration)).toBe(false);
    expect(homeDigest(homeDir)).toBe(before);
  });

  test("Kiro IDE (no chat id in the shell) gets the same line for the chat the engine resolved", () => {
    const chat = "sess_0f185df1-7393-49c2-a607-92e02fea6d00";
    const homeDir = home();
    const proj = project(chat);
    v3Record(homeDir, chat, [tombstone("summarization", at(60_000))]);
    expect(report(proj, { tree: "kiro-ide", homeDir, ideChat: chat }).narration?.split("\n").at(-1)).toBe(SUMMARIZED_LINE);
  });

  test("a summary from before the work began, a checkpoint revert, or a figure under 80% says nothing", () => {
    const chat = "sess_44aff2b8-e5fe-48c2-a42c-9f8712954432";
    const homeDir = home();
    const proj = project(chat);
    const none = report(proj, { tree: "kiro-ide", homeDir, chat }).narration;
    v3Record(homeDir, chat, [tombstone("summarization", at(-3_600_000)), usageRow(21)]);
    expect(report(proj, { tree: "kiro-ide", homeDir, chat }).narration).toBe(none);
    v3Record(homeDir, chat, [tombstone("checkpoint_revert", at(60_000)), usageRow(40)]);
    expect(report(proj, { tree: "kiro-ide", homeDir, chat }).narration).toBe(none);
    v3Record(homeDir, chat, [usageRow(79.4)]);
    expect(report(proj, { tree: "kiro-ide", homeDir, chat }).narration).toBe(none);
    writeFileSync(join(homeDir, ".kiro", "sessions", "0123456789abcdef", chat, "messages.jsonl"), "not json\n{\"payload\":\n");
    expect(report(proj, { tree: "kiro-ide", homeDir, chat }).narration).toBe(none);
    expect(offered(none)).toBe(false);
  });

  test("with Kiro's auto-compaction off the figure passes 80%, and the figure line is said", () => {
    const chat = "sess_aa48a8fe-1745-43d7-93d3-3bf59abab7d2";
    const homeDir = home();
    const proj = project(chat);
    v3Record(homeDir, chat, [turnRow(30.2, at(0), "t1"), usageRow(70), usageRow(85.2)]);
    expect(report(proj, { tree: "kiro-ide", homeDir, chat }).narration?.split("\n").at(-1)).toBe(usageLine(85));
  });
});

// Measured on Kiro CLI 3.1.0 with a 200k model: a chat starts at 24% before any
// work, and the turn that picked the work up in a new chat took it to 63.6%;
// Kiro summarized that chat 12 minutes later and 10 times in all (#3642).
describe("t-kiro-context-offer: a new chat on the same model would start about as full", () => {
  test("a new chat its first turn on the work took to 64% hears that a new chat will not help, once (Kiro CLI v3)", () => {
    const chat = "sess_9aba7ab2-47f4-415d-a4a3-a826eb21c559";
    const homeDir = home();
    const proj = project(chat);
    v3Record(homeDir, chat, [
      turnRow(90, at(-3_600_000), "t0"), snapshotRow("claude-opus-4.5", at(2_000)),
      turnRow(24.662, at(3_000), "t1"), turnRow(41.8705, at(30_000), "t1"), turnRow(63.619, at(110_000), "t1"),
      turnRow(64.5, at(150_000), "t2"), turnRow(79.8575, at(500_000), "t3"),
      tombstone("summarization", at(700_000)), turnRow(20, at(700_010), "t3"), turnRow(25.9, at(720_000), "t4"),
    ]);
    v3Session(homeDir, chat, sessionOn(chat, "claude-opus-4.5"));
    const before = homeDigest(homeDir);
    const first = report(proj, { tree: "kiro", homeDir, chat });
    expect(notices(first)).toContain(noRoomSummarized(64, "claude-opus-4.5"));
    expect(notices(first).filter((line) => /\d+%/.test(line)).every(figuresSourced)).toBe(true);
    expect(offered(first.narration)).toBe(false);
    expect(first.narration).not.toContain("I recommend it");
    const again = report(proj, { tree: "kiro", homeDir, chat });
    expect(offered([again.narration, ...notices(again)].join(" "))).toBe(false);
    // Read only: no model or setting of Kiro's changed.
    expect(homeDigest(homeDir)).toBe(before);
  });

  test("a first turn Kiro summarized part way counts at its highest figure (Kiro IDE)", () => {
    const chat = "sess_66160e7a-e9f7-4c65-bbf1-486f5d61b60e";
    const homeDir = home();
    const proj = project(chat);
    v3Record(homeDir, chat, [
      snapshotRow("claude-opus-4.5", at(1_000)),
      turnRow(25.4, at(2_000), "t1"), turnRow(79.849, at(60_000), "t1"), tombstone("summarization", at(61_000)),
      turnRow(20, at(61_010), "t1"), turnRow(34.5, at(90_000), "t1"), turnRow(39.9, at(400_000), "t2"),
    ]);
    v3Session(homeDir, chat, sessionOn(chat, "claude-opus-4.5"));
    expect(notices(report(proj, { tree: "kiro-ide", homeDir, ideChat: chat }))).toContain(noRoomSummarized(80, "claude-opus-4.5"));
  });

  test("a model Kiro picks (auto) names no model; a settings file that does not parse keeps today's line", () => {
    const chat = "sess_7f937405-f1b8-46f0-9584-f881bb034a9e";
    const homeDir = home();
    const rows = [
      snapshotRow(AUTO_DISPLAY, at(1_000)), turnRow(51, at(2_000), "t1"), turnRow(60.2, at(9_000), "t1"),
      tombstone("summarization", at(60_000)),
    ];
    const proj = project(chat);
    v3Record(homeDir, chat, rows);
    v3Session(homeDir, chat, sessionOn(chat, "auto"));
    expect(notices(report(proj, { tree: "kiro", homeDir, chat }))).toContain(noRoomSummarized(60));
    const other = "sess_0b1d2c3e-4f50-4617-8829-3a4b5c6d7e8f";
    const proj2 = project(other);
    v3Record(homeDir, other, rows);
    v3Session(homeDir, other, "{\"modelId\": ");
    expect(report(proj2, { tree: "kiro", homeDir, chat: other }).narration?.split("\n").at(-1)).toBe(SUMMARIZED_LINE);
  });

  // The figure is a share of the window of the model that filled it: after a
  // switch with /model, a new chat would start on the model switched to (#3650).
  test("a chat switched to another model after its first turn, or with no model on record then, keeps today's line", () => {
    const homeDir = home();
    const rows = [
      snapshotRow("claude-opus-4.5", at(1_000)), turnRow(24.7, at(2_000), "t1"), turnRow(63.6, at(30_000), "t1"),
      turnRow(79.8, at(400_000), "t2"), tombstone("summarization", at(500_000)), turnRow(20, at(500_010), "t2"),
    ];
    const cases: Array<[string, string | null]> = [
      // Switched with /model, before Kiro tells the agent about it.
      ["sess_3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b", sessionOn("x", "claude-sonnet-4.5", "claude-opus-4.5")],
      // Switched, and Kiro has told the agent.
      ["sess_4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c", sessionOn("x", "claude-sonnet-4.5")],
      // Switched to Kiro's own pick.
      ["sess_5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d", sessionOn("x", "auto")],
      // No settings file beside the record.
      ["sess_6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e", null],
    ];
    for (const [chat, session] of cases) {
      const proj = project(chat);
      v3Record(homeDir, chat, rows);
      if (session !== null) v3Session(homeDir, chat, session);
      expect(report(proj, { tree: "kiro", homeDir, chat }).narration?.split("\n").at(-1), chat).toBe(SUMMARIZED_LINE);
    }
    // A record with no note of the model before its first turn.
    const bare = "sess_7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
    const proj = project(bare);
    v3Record(homeDir, bare, rows.slice(1));
    v3Session(homeDir, bare, sessionOn(bare, "claude-opus-4.5"));
    expect(report(proj, { tree: "kiro", homeDir, chat: bare }).narration?.split("\n").at(-1)).toBe(SUMMARIZED_LINE);
    // Kiro CLI's default engine names each turn's model.
    const v2 = "56565656-5656-4565-8565-565656565656";
    const proj2 = project(v2);
    v2Record(homeDir, v2, 85.2, [v2Turn(20_000, 63.9, 64.2, "claude-opus-4.5"), v2Turn(400_000, 85.2, 85.2, "claude-sonnet-4.5")], "claude-sonnet-4.5");
    expect(report(proj2, { tree: "kiro", homeDir, chat: v2 }).narration?.split("\n").at(-1)).toBe(usageLine(85));
  });

  test("a first turn under half the window, or none since the work began, keeps today's line", () => {
    const chat = "sess_1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const homeDir = home();
    const proj = project(chat);
    v3Record(homeDir, chat, [
      turnRow(24, at(2_000), "t1"), turnRow(30.4, at(20_000), "t1"), turnRow(79, at(400_000), "t2"),
      tombstone("summarization", at(500_000)), turnRow(20, at(500_010), "t2"),
    ]);
    v3Session(homeDir, chat, JSON.stringify({ id: chat, modelId: "claude-opus-4.5" }));
    expect(report(proj, { tree: "kiro", homeDir, chat }).narration?.split("\n").at(-1)).toBe(SUMMARIZED_LINE);
    const quiet = "sess_2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";
    const proj2 = project(quiet);
    v3Record(homeDir, quiet, [turnRow(70, at(-3_600_000), "t0"), tombstone("summarization", at(60_000))]);
    expect(report(proj2, { tree: "kiro", homeDir, chat: quiet }).narration?.split("\n").at(-1)).toBe(SUMMARIZED_LINE);
  });

  test("Kiro CLI's default engine: the first turn's figures it saved decide, with the model it names", () => {
    const chat = "12121212-1212-4121-8121-121212121212";
    const homeDir = home();
    const proj = project(chat);
    v2Record(homeDir, chat, 85.2, [
      v2Turn(-3_600_000, 90, 91), v2Turn(20_000, 63.9, 64.2, "claude-opus-4.5"), v2Turn(400_000, 85.2, 85.2, "claude-opus-4.5"),
    ], "claude-opus-4.5");
    const near = notices(report(proj, { tree: "kiro", homeDir, chat }));
    expect(near).toContain(noRoomUsage(85, 64, "claude-opus-4.5"));
    expect(near.filter((line) => /\d+%/.test(line)).every(figuresSourced)).toBe(true);
    const light = "34343434-3434-4343-8343-343434343434";
    const proj2 = project(light);
    v2Record(homeDir, light, 85.2, [v2Turn(20_000, 22.1, 30.4), v2Turn(400_000, 85.2, 85.2)]);
    expect(report(proj2, { tree: "kiro", homeDir, chat: light }).narration?.split("\n").at(-1)).toBe(usageLine(85));
  });
});

describe("t-kiro-context-offer: other hosts never read Kiro's files", () => {
  test("a Claude Code chat with a Kiro record of the same id hears nothing", () => {
    const chat = "55555555-5555-4555-8555-555555555555";
    const homeDir = home();
    v2Record(homeDir, chat, 97);
    const proj = project(chat);
    expect(offered(report(proj, { tree: "claude", homeDir, ideChat: chat }).narration)).toBe(false);
  });
});

describe("t-kiro-context-offer: a Unit's checkpoint", () => {
  const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

  // Classic, two Units one at a time, reviews off, checkpoints on; Unit alpha's stages all built.
  function walk(chat: string, autonomy: "gated" | "autonomous" = "gated"): string {
    const p = createTestProject();
    created.push(p);
    seedAidlcMemory(p);
    writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: A checkpoint offer
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: classic
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: ${autonomy}
- **Review Override**: none
- **Guard Policy**: off (from scope classic)
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${STAGES.map((stage) => `- [${stage === "functional-design" ? "-" : " "}] ${stage} ${SEPARATOR} EXECUTE`).join("\n")}
- [ ] build-and-test ${SEPARATOR} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
    seedBoltDag(p, ["alpha", "beta"]);
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "alpha.ts"), "export const alpha = 1;\n");
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic" }, p);
    if (autonomy === "autonomous") appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, p);
    appendAuditEntry("HUMAN_TURN", { Session: chat, Origin: "person", Source: "typed" }, p);
    for (const slug of STAGES) {
      const stage = findStageBySlug(slug)!;
      const output = join(seededRecordDir(p), "construction", "alpha", slug);
      mkdirSync(output, { recursive: true });
      for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# alpha ${name}\n`);
      if (stage.workspace_requires) {
        writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
          stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }],
        }));
      }
      appendAuditEntry("UNIT_COMPLETED", {
        Stage: slug, Unit: "alpha", Mode: "wave",
        "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, "alpha"),
        "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, "alpha", { requireRequiredArtifacts: true })!,
      }, p);
    }
    return p;
  }

  test("the checkpoint step says it when the step starts, once in this chat", () => {
    const chat = "66666666-6666-4666-8666-666666666666";
    const homeDir = home();
    v2Record(homeDir, chat, 86.4);
    const p = walk(chat);
    const step = () => {
      const result = runOrchestrateNext(join(TREES.kiro, "tools", "aidlc-orchestrate.ts"), p, [], {
        env: hostEnv({ tree: "kiro", homeDir, chat }),
      });
      expect(result.directive, result.stderr).not.toBeNull();
      return result.directive as { construction_checkpoint?: { unit: string }; change_notices?: string[] };
    };
    const first = step();
    expect(first.construction_checkpoint?.unit).toBe("alpha");
    expect(first.change_notices ?? []).toContain(usageLine(86));
    expect(offered((step().change_notices ?? []).join(" "))).toBe(false);
  });

  test("a checkpoint that approves on its own says nothing and keeps the offer for a question the person is asked", () => {
    const chat = "77777777-7777-4777-8777-777777777777";
    const homeDir = home();
    v2Record(homeDir, chat, 86.4);
    const p = walk(chat, "autonomous");
    const step = () => {
      const result = runOrchestrateNext(join(TREES.kiro, "tools", "aidlc-orchestrate.ts"), p, [], {
        env: hostEnv({ tree: "kiro", homeDir, chat }),
      });
      expect(result.directive, result.stderr).not.toBeNull();
      return result.directive as {
        construction_checkpoint?: { unit: string; human_required: boolean }; change_notices?: string[];
      };
    };
    const automatic = step();
    expect(automatic.construction_checkpoint?.unit).toBe("alpha");
    expect(automatic.construction_checkpoint?.human_required).toBe(false);
    expect(offered((automatic.change_notices ?? []).join(" "))).toBe(false);
    const state = seededStateFile(p);
    writeFileSync(state, readFileSync(state, "utf8").replace(
      "- **Construction Autonomy Mode**: autonomous", "- **Construction Autonomy Mode**: gated",
    ));
    const asked = step();
    expect(asked.construction_checkpoint?.human_required).toBe(true);
    expect(asked.change_notices ?? []).toContain(usageLine(86));
  });
});
