// live-gate-fuzz.ts - real agents on real tools, replies as people give them, judged by what the person got.
//
// The live half of the reading design's test program (the design lead's section 4.3). Each reply in the corpus
// (tests/fixtures/gate-fuzz/replies.json) is met at its wait point in the tool's own install (seedWait): the question
// open, built as the answers corpus builds it (buildQuestion), and the person's first line has the agent show it; where
// the question is the engine's answer to that line (the routing question, the plan offer), the work as it stands
// before the line, which opens it. Then the person replies, in one or two lines. Pass, per reply (section 4.1):
//
//   P1 the decision the person meant is on record (the row's event and its choice, an answer judged by meaning); for a reply that is really
//      ambiguous, nothing is recorded and the agent asks once.
//   P2 nothing refused and nothing asked again: questions back to the person stay within the reply's allowance, and
//      no line the person reads names a check, a refusal, or says the work carries on while it waits (the model judge
//      reads the agent's words, by meaning). Refusals the agent met and retried are counted, not judged.
//   P3 nothing moved on without a turn the person took after the question (the person-turn ledger).
//   P4 their words are kept whole: the message record holds what they typed, and the decision row names it.
//   P5 no loop and no dead end: the work ends at the next step or at a wait on the person, and no engine refusal
//      comes back for the same call.
//
// Records are read by script, the agent's words to the person by a model (judgeWords, with what the person had been
// shown before their reply); a difference in
// wording between runs is never a failure. The drivers: Claude Code through the SDK (its own Claude Code, the nightly's
// model pins) and through the box's own `claude -p` (AIDLC_GATE_FUZZ_CLAUDE_BIN, the shell's models), Codex through `codex exec`,
// Kiro CLI over ACP, opencode through `opencode run`, the Cursor agent through `agent -p`, Copilot CLI through
// `copilot -p`. tests/e2e/t-live-gate-fuzz.serial.test.ts runs a sample; `bun tests/harness/live-gate-fuzz.ts
// --write-corpus` writes the first corpus from the answers corpus and the measured cases; `--rejudge <report dir>`
// judges a finished run's answers again by meaning.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ANSWERS, type AnswersItem, buildQuestion, type Question } from "./aidlc-answers-corpus.ts";
import { buildState, type State } from "./aidlc-input-corpus.ts";
import { turnEvidence } from "./codex-turn-evidence.ts";
import { cleanupTestProject, REPO_ROOT, seedAidlcMemory, seedWorkspaceShell } from "./fixtures.ts";
import {
  codexJsonTurn, copilotToolResults, copilotTurn, opencodeRunCommand, opencodeToolResults, setupCopilotProject, setupCursorProject,
  setupOpencodeProject, trustCopilotFolder,
} from "./exec-drive.ts";
import { AcpSession, driveKiroAcp } from "./kiro-acp-drive.ts";
import { homeDigest, judgeVerdict, liveProject, PERSON_READS_RULE } from "./live-corpus.ts";
import { auditCursor, type PersonTurn, unbackedDecisions } from "./person-turns.ts";
import { driveAidlc } from "./sdk-drive.ts";
import { remainingOperationTimeoutMs } from "./test-budget.ts";
import { CI_BEDROCK_MODELS } from "../../scripts/ci-credential-broker.ts";

type Lib = typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts");
type Store = typeof import("../../dist/claude/.claude/tools/aidlc-message-store.ts");
const lib = (): Lib => require("../../dist/claude/.claude/tools/aidlc-lib.ts") as Lib;
const store = (): Store => require("../../dist/claude/.claude/tools/aidlc-message-store.ts") as Store;

export const LIVE_TOOLS = ["claude", "claude-cli", "codex", "kiro", "opencode", "cursor", "copilot"] as const;
export type LiveTool = (typeof LIVE_TOOLS)[number];

// ---------------------------------------------------------------------------
// The corpus (section 4.3's schema)
// ---------------------------------------------------------------------------

export const REPLY_CLASSES = [
  "number", "label", "own-words", "typo", "two-things", "other-thing", "change-of-mind", "question-back",
  "other-language", "non-answer", "command-line", "misread-correction",
] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

export interface Reply {
  id: string;
  /** The wait point, as the answers corpus names its questions. */
  wait: Question;
  /** Who composed the list the person saw. */
  shownBy: "agent" | "engine" | "box";
  replyClass: ReplyClass;
  language: string;
  /** One reply, or two for a change of mind and a misread correction. */
  inputs: string[];
  meaning: string;
  ambiguous?: true;
  /**
   * What the drive does before the person's last line, as an agent would have done it: `misread` records the
   * opposite of what the first line meant (the person then corrects it).
   */
  setup?: "misread";
  /** A question the agent asked beside the open step before the person's reply, laid into the fixture. */
  beside?: { decision: string; options: string[] };
  /** What the agent's first showing must offer for the reply to mean what the item says (a number or a label picks from it). */
  shows?: string;
  expected: { end: { decision: string; also?: string[]; asks: number; says: string[] } };
  /** Where the reply comes from: an answers corpus id, or a measure. */
  source: string;
}

export const CORPUS_FILE = join(REPO_ROOT, "tests", "fixtures", "gate-fuzz", "replies.json");
export const loadCorpus = (): Reply[] => JSON.parse(readFileSync(CORPUS_FILE, "utf-8")) as Reply[];

/** The closed-set action an answers corpus item's end names, in section 4.3's words. */
function decisionOf(item: AnswersItem): string {
  const recorded = item.expected.end.recorded;
  if (recorded === "none") return "none";
  switch (item.question) {
    case "stage-gate":
    case "stage-gate-accept-as-is":
      return recorded === "Approve" ? "approve" : recorded === "Accept as-is" ? "accept-as-is" : "request-changes";
    case "code-plan":
    case "code-plan-grouped":
      return /^Approve/.test(recorded) ? "approve-plan" : recorded === "Request Changes" ? "request-plan-changes" : "edit-plan";
    case "unit-checkpoint":
    case "batch-checkpoint":
    case "verification-command":
    case "construction-policy":
      return recorded === "Approve" ? "checkpoint-approve" : "checkpoint-reject";
    case "guard-recovery":
      return recorded === "Request Changes" ? "remedy:request-changes" : recorded === "Approve" ? "remedy:approve" : "remedy:finish-revision";
    case "routing":
      return recorded === "Part of the active work" ? "route:continue" : recorded === "Separate new piece of work" ? "route:separate" : "route:reshape";
    case "resume-reentry":
    case "jump-target":
      return recorded.startsWith("jump") || recorded === "first stage" || recorded === "requirements-analysis" ? "resume:jump" : `resume:${recorded}`;
    case "reopened-stage":
      return `answer:${recorded.toLowerCase()}`;
    default:
      return `answer:${recorded}`;
  }
}

function shownByOf(item: AnswersItem): Reply["shownBy"] {
  if (item.via === "picker") return "box";
  return ["code-plan", "code-plan-grouped", "plan-offer", "scope-confirm", "routing", "intent-pick", "project-type", "unit-paused",
    "guard-recovery", "unit-checkpoint", "batch-checkpoint", "verification-command", "construction-policy"].includes(item.question) ? "engine" : "agent";
}

function classOf(item: AnswersItem): ReplyClass {
  const input = item.input.trim();
  const options = item.picker?.options ?? [];
  if (input === "") return "non-answer";
  if (item.via === "aidlc" || item.via === "codex") return "command-line";
  if (/^\(?#?\d{1,2}[.)]?$/.test(input)) return "number";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the reply's script, not a control character
  if (/[^\u0000-ɏ -⁯]/.test(input)) return "other-language";
  if (options.some((o) => o.toLowerCase() === input.toLowerCase()) || /^(approve|request changes|accept as-is|looks correct|guide me|nothing to add)\.?$/i.test(input)) return "label";
  if (/\?\s*$/.test(input)) return "question-back";
  return "own-words";
}

function languageOf(text: string): string {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[؀-ۿ]/.test(text)) return "ar";
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  if (/[ऀ-ॿ]/.test(text)) return "hi";
  return "en";
}

/** The replies the measures met live, and the kinds of reply the design asks for that the answers corpus lacks. */
const MEASURED: Reply[] = [
  { id: "mgo-codex-3", wait: "stage-gate", shownBy: "agent", replyClass: "number", language: "en", inputs: ["3"], shows: "Add User Stories as the third choice",
    meaning: "the person picks the third choice the agent showed at the Requirements Analysis gate, Add User Stories (User Stories is skipped in this plan); the stage is added, and the gate is approved only if the agent offered approve-and-add",
    expected: { end: { decision: "add-stage:user-stories", asks: 1, says: ["User Stories is added to the plan", "whether Requirements Analysis is approved, or the question still waits"] } },
    source: "measure-gate-options (Codex run 1)" },
  { id: "mkl-kiro-2", wait: "stage-gate", shownBy: "agent", replyClass: "number", language: "en", inputs: ["2"],
    shows: "a numbered question beside the gate whose second choice approves the stage as it is (such as I'm comfortable approving as-is)",
    beside: { decision: "Do you want me to have the new approach checked before you decide?", options: ["Have it checked again", "I'm comfortable approving as-is"] },
    meaning: "beside the gate the agent asked its own question, 1. Have it checked again, 2. I'm comfortable approving as-is; the person picks 2: they approve the stage as it is",
    expected: { end: { decision: "approve", asks: 0, says: ["the requirements are approved and the work moves on"] } },
    source: "measure-kiro-loops F1 (Kiro CLI v3)" },
  { id: "two-approve-change", wait: "stage-gate", shownBy: "agent", replyClass: "two-things", language: "en", inputs: ["Approve. Also add a test for blank titles in the next stage."],
    meaning: "the person approves the requirements and asks for a change to carry into the next work", expected: { end: { decision: "approve", asks: 0, says: ["the requirements are approved", "the extra test is noted or done"] } },
    source: "design 4.3 two-things" },
  { id: "two-approve-setting", wait: "stage-gate", shownBy: "agent", replyClass: "two-things", language: "en", inputs: ["approve, and turn plan approval off"],
    meaning: "the person approves the requirements and turns plan approval off for this work", expected: { end: { decision: "approve", also: ["plan-approval off"], asks: 0, says: ["approved", "code plans will be built without asking first"] } },
    source: "design 4.3 two-things" },
  { id: "two-approve-park", wait: "stage-gate", shownBy: "agent", replyClass: "two-things", language: "en", inputs: ["approve it and let's stop here for today"],
    meaning: "the person approves the requirements and stops the work for today", expected: { end: { decision: "approve", also: ["park"], asks: 0, says: ["approved", "the work is paused and how to pick it up"] } },
    source: "design 4.3 two-things" },
  { id: "two-answer-question", wait: "stage-question", shownBy: "agent", replyClass: "two-things", language: "en", inputs: ["PostgreSQL. Will that work offline?"],
    meaning: "the person picks PostgreSQL and asks whether it works offline", expected: { end: { decision: "answer:PostgreSQL", asks: 0, says: ["PostgreSQL is noted", "an answer about offline use"] } },
    source: "design 4.3 two-things" },
  { id: "other-document", wait: "stage-gate", shownBy: "agent", replyClass: "other-thing", language: "en", inputs: ["what does FR-1 mean exactly?"],
    meaning: "the person asks about the document; nothing is decided, the agent answers and the gate still waits", expected: { end: { decision: "none", asks: 0, says: ["what FR-1 means"] } },
    source: "design 4.3 other-thing" },
  { id: "other-where", wait: "stage-gate", shownBy: "agent", replyClass: "other-thing", language: "en", inputs: ["where are we?"],
    meaning: "the person asks where the work stands; nothing is decided", expected: { end: { decision: "none", asks: 0, says: ["where the work stands: the requirements wait for their approval"] } },
    source: "design 4.3 other-thing" },
  { id: "other-status", wait: "stage-gate", shownBy: "agent", replyClass: "command-line", language: "en", inputs: ["/aidlc --status"],
    meaning: "the person asks AI-DLC for the status; nothing is decided", expected: { end: { decision: "none", asks: 0, says: ["the status"] } },
    source: "design 4.3 other-thing" },
  { id: "change-of-mind", wait: "stage-gate", shownBy: "agent", replyClass: "change-of-mind", language: "en", inputs: ["approve", "wait, no, I want the title rule changed first: a title may not start with a space"],
    meaning: "the person approved, then changed their mind and asks for a change before the work goes on", expected: { end: { decision: "request-changes", asks: 0, says: ["the change is being made", "the requirements come back for approval"] } },
    source: "design 4.3 change-of-mind" },
  { id: "question-back", wait: "stage-gate", shownBy: "agent", replyClass: "question-back", language: "en", inputs: ["what does approving commit me to?"],
    meaning: "the person asks what approving means; nothing is decided, the agent answers and asks for the decision once", expected: { end: { decision: "none", asks: 1, says: ["what approving means for them"] } },
    source: "design 4.3 question-back" },
  { id: "lang-label", wait: "stage-gate", shownBy: "agent", replyClass: "other-language", language: "fr", inputs: ["Approuver"],
    meaning: "the person approves, in French", expected: { end: { decision: "approve", asks: 0, says: ["approved, in the person's language or plain words"] } }, source: "design 4.3 other-language" },
  { id: "lang-digit", wait: "stage-gate", shownBy: "agent", replyClass: "other-language", language: "fr", inputs: ["le 2"],
    meaning: "the person picks the second choice shown (Request Changes when the agent showed Approve then Request Changes), in French; the agent asks what should change, once", expected: { end: { decision: "request-changes", asks: 1, says: ["what should change, asked once"] } }, source: "design 4.3 other-language" },
  { id: "non-answer-dots", wait: "stage-gate", shownBy: "agent", replyClass: "non-answer", language: "en", inputs: ["..."], ambiguous: true,
    meaning: "the person typed nothing meaningful; nothing is decided and the agent asks once", expected: { end: { decision: "none", asks: 1, says: ["the question again, once"] } }, source: "design 4.3 non-answer" },
  { id: "cmd-digit", wait: "stage-gate", shownBy: "agent", replyClass: "command-line", language: "en", inputs: ["/aidlc 2"],
    meaning: "the person picks the second choice after /aidlc: Request Changes when shown second; the agent asks what should change", expected: { end: { decision: "request-changes", asks: 1, says: ["what should change, asked once"] } }, source: "design 4.3 command-line" },
  { id: "cmd-approve", wait: "stage-gate", shownBy: "agent", replyClass: "command-line", language: "en", inputs: ["/aidlc approve"],
    meaning: "the person approves after /aidlc", expected: { end: { decision: "approve", asks: 0, says: ["approved"] } }, source: "design 4.3 command-line" },
  { id: "misread-fix", wait: "stage-gate", shownBy: "agent", replyClass: "misread-correction", language: "en", setup: "misread",
    inputs: ["looks good", "no, I meant approve: I did not ask for changes"],
    meaning: "the person's \"looks good\" was recorded as Request Changes; they say so, and the agent fixes it in one step with no question",
    expected: { end: { decision: "approve", asks: 0, says: ["the approval is now recorded", "the requirements are approved"] } }, source: "design 4.3 misread-correction" },
  { id: "learnings-and-approve", wait: "stage-gate", shownBy: "agent", replyClass: "two-things", language: "en", inputs: ["Nothing to add, and approve the requirements"],
    beside: { decision: "Anything to add for next time?", options: ["Nothing to add", "Add a note"] },
    meaning: "the person answers the learnings question (nothing to add) and approves the stage in the same reply", expected: { end: { decision: "answer:Nothing to add", also: ["approve"], asks: 0, says: ["nothing added", "the requirements are approved"] } },
    source: "design 4.4 learnings-then-approve" },
];

/** The first corpus: every answers corpus reply, in section 4.3's schema, and the measured replies. */
export function draftCorpus(): Reply[] {
  const replies: Reply[] = ANSWERS.map((item) => ({
    id: `ans-${item.id}`, wait: item.question, shownBy: shownByOf(item), replyClass: classOf(item), language: languageOf(item.input),
    inputs: [item.via === "aidlc" ? `/aidlc ${item.input}`.trim() : item.via === "codex" ? `$aidlc ${item.input}`.trim() : item.input],
    meaning: item.meaning, ...(item.ambiguous ? { ambiguous: true as const } : {}),
    ...(shownByOf(item) === "agent" && ["number", "label"].includes(classOf(item)) && item.expected.end.recorded !== "none"
      ? { shows: `the choice ${JSON.stringify(item.expected.end.recorded)}${classOf(item) === "number" ? ` at number ${item.input.replace(/\D/g, "")}` : ""}` } : {}),
    expected: { end: {
      decision: decisionOf(item),
      ...(item.expected.end.parked || item.expected.end.set ? { also: [...(item.expected.end.parked ? ["park"] : []), ...(item.expected.end.set ?? []).map(([k, v]) => `${k} ${v}`)] } : {}),
      asks: item.expected.end.asks, says: item.expected.end.says,
    } },
    source: `answers ${item.id}${item.picker ? " (box)" : ""}`,
  }));
  return [...replies, ...MEASURED];
}

// ---------------------------------------------------------------------------
// Projects in each tool's install, scratch homes, the person's real homes
// ---------------------------------------------------------------------------

export interface LiveRig {
  proj: string;
  /** The scratch home the tool runs with, where it has one. */
  home: string | null;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

const SCRATCH_TOOL_ENV = { DISABLE_AUTOUPDATER: "1", OPENCODE_DISABLE_AUTOUPDATE: "true", COPILOT_AUTO_UPDATE: "false" };

/** The person's homes a drive must leave as it found them, and the ones a tool writes its own records into (reported). */
export const REAL_HOMES: Record<LiveTool, { owed: string[]; reported: string[] }> = {
  claude: { owed: [join(homedir(), ".claude")], reported: [] },
  "claude-cli": { owed: [join(homedir(), ".claude")], reported: [] },
  codex: { owed: [join(homedir(), ".codex")], reported: [] },
  kiro: { owed: [join(homedir(), ".kiro", "settings"), join(homedir(), ".kiro", "agents")], reported: [join(homedir(), ".kiro")] },
  opencode: { owed: [join(homedir(), ".config", "opencode")], reported: [join(homedir(), ".local", "share", "opencode")] },
  cursor: { owed: [], reported: [join(homedir(), ".cursor"), join(homedir(), ".config", "cursor")] },
  copilot: { owed: [join(homedir(), ".copilot")], reported: [] },
};
export const homeDigests = (tool: LiveTool) =>
  Object.fromEntries([...REAL_HOMES[tool].owed, ...REAL_HOMES[tool].reported].filter(existsSync).map((home) => [home, homeDigest(home).digest]));

/** A scratch install of the tool under /var/tmp/aidlc-live-runs (or the folder named), with the tool's scratch home. */
export function liveRig(tool: LiveTool): LiveRig {
  const env: NodeJS.ProcessEnv = { ...process.env, ...SCRATCH_TOOL_ENV };
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "KIRO_SESSION_ID"]) delete env[name];
  if (tool === "claude" || tool === "codex" || tool === "kiro") {
    const made = liveProject(tool);
    return { proj: made.proj, home: made.home ?? null, env, cleanup: made.cleanup };
  }
  if (tool === "claude-cli") {
    const made = liveProject("claude");
    const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-config-")));
    return { proj: made.proj, home, env: { ...env, CLAUDE_CONFIG_DIR: home }, cleanup: () => {
      made.cleanup();
      cleanupTestProject(home);
    } };
  }
  if (tool === "opencode") {
    const { proj, root } = setupOpencodeProject();
    seedAidlcMemory(proj);
    seedWorkspaceShell(proj);
    // Its own config home: the person's provider settings, self-update off.
    const config = join(root, "xdg-config");
    mkdirSync(join(config, "opencode"), { recursive: true });
    const real = join(homedir(), ".config", "opencode", "opencode.jsonc");
    const text = existsSync(real) ? readFileSync(real, "utf-8") : "{\n}";
    writeFileSync(join(config, "opencode", "opencode.jsonc"), text.replace(/^\s*\{/, '{\n  "autoupdate": false,'), "utf-8");
    return { proj, home: config, env: { ...env, XDG_CONFIG_HOME: config }, cleanup: () => cleanupTestProject(root) };
  }
  if (tool === "cursor") {
    const { proj, root } = setupCursorProject();
    seedAidlcMemory(proj);
    seedWorkspaceShell(proj);
    return { proj, home: null, env, cleanup: () => cleanupTestProject(root) };
  }
  const proj = setupCopilotProject();
  seedAidlcMemory(proj);
  seedWorkspaceShell(proj);
  const home = join(realpathSync(mkdtempSync(join(tmpdir(), "copilot-home-"))));
  trustCopilotFolder(home, proj);
  return { proj, home, env: { ...env, COPILOT_HOME: home }, cleanup: () => {
    cleanupTestProject(join(proj, ".."));
    cleanupTestProject(home);
  } };
}

// ---------------------------------------------------------------------------
// Driving one reply
// ---------------------------------------------------------------------------

export interface Exchange {
  /** What the agent said to the person after each line, and the commands it ran. */
  turns: Array<{ line: string; text: string; tools: Array<{ command: string; output: string }> }>;
  /** Questions put in a box after the person's reply (Claude Code). */
  boxes: number;
  error: string | null;
}

/**
 * The waits whose question is the engine's answer to the person's first line: that line (the answers corpus's own),
 * and the work as it stands before they type it (the first step of the corpus's fixture for the question).
 */
const OPENED_BY_FIRST_LINE: Partial<Record<Question, { line: string; before: State }>> = {
  routing: { line: "/aidlc fix the login", before: "work-open" },
  "plan-offer": { line: "/aidlc fix the login: it rejects a correct password", before: "fresh" },
  "scope-confirm": { line: "/aidlc fix the login timeout", before: "fresh" },
};

/** The person's first line, which opens the question (OPENED_BY_FIRST_LINE) or has the agent show the open one. */
export function firstLine(reply: Reply, tool: LiveTool): string | null {
  const line = OPENED_BY_FIRST_LINE[reply.wait]?.line ?? (reply.wait === "resume-reentry" || reply.wait === "jump-target" ? null : "/aidlc");
  return line === null ? null : tool === "codex" ? line.replace(/^\/aidlc/, "$aidlc") : line;
}

const said = (line: string, tool: LiveTool) => (tool === "codex" ? line.replace(/^\/aidlc/, "$aidlc") : line);

/** The line that opens the wait's question, for a wait the person's first line opens; else null. The live answers check reads it too. */
export function openingLine(wait: Question): string | null {
  return OPENED_BY_FIRST_LINE[wait]?.line ?? null;
}

function spawnTool(argv: string[], proj: string, env: NodeJS.ProcessEnv, input?: string): { rc: number; stdout: string; out: string } {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: proj, encoding: "utf-8", env: { ...env, PWD: proj }, maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] as const } : { input, stdio: ["pipe", "pipe", "pipe"] as const }),
    timeout: remainingOperationTimeoutMs(30 * 60_000, { phase: "live gate fuzz turn" }),
  });
  return { rc: r.status ?? -1, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}\n${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}` };
}

/** The box's own Claude Code: AIDLC_GATE_FUZZ_CLAUDE_BIN, else the newest under ~/aidlc-tier/claude, else `claude`. */
export function claudeBinary(): string {
  if (process.env.AIDLC_GATE_FUZZ_CLAUDE_BIN) return process.env.AIDLC_GATE_FUZZ_CLAUDE_BIN;
  const tier = join(homedir(), "aidlc-tier", "claude");
  if (!existsSync(tier)) return "claude";
  const versions = readdirSync(tier).filter((v) => existsSync(join(tier, v, "claude")))
    .sort((a, b) => a.split(".").map(Number).reduce((d, n, i) => d || n - Number(b.split(".")[i] ?? 0), 0));
  return versions.length > 0 ? join(tier, versions.at(-1)!, "claude") : "claude";
}

/** What one `claude -p --output-format stream-json` turn said and ran. */
function claudeStream(stdout: string): { text: string; tools: Array<{ command: string; output: string }> } {
  const texts: string[] = [];
  const calls = new Map<string, string>();
  const tools: Array<{ command: string; output: string }> = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: string; message?: { content?: Array<{ type?: string; text?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown }> } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const part of event.message?.content ?? []) {
      if (event.type === "assistant" && part.type === "text" && part.text) texts.push(part.text);
      if (event.type === "assistant" && part.type === "tool_use" && part.id) calls.set(part.id, JSON.stringify(part.input ?? {}).slice(0, 400));
      if (event.type === "user" && part.type === "tool_result" && part.tool_use_id) {
        const content = Array.isArray(part.content) ? part.content.map((c: { text?: string }) => c.text ?? "").join("") : String(part.content ?? "");
        tools.push({ command: calls.get(part.tool_use_id) ?? "", output: content });
      }
    }
  }
  return { text: texts.join("\n"), tools };
}

/** Text the opencode JSON events carry from the agent. */
function opencodeText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string } };
      if (event.type === "text" && typeof event.part?.text === "string") parts.push(event.part.text);
    } catch {
      // Not an event line.
    }
  }
  return parts.join("\n");
}

/** Text a Copilot JSON turn carries from the agent. */
function copilotText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { type?: string; data?: { content?: unknown } };
      if (event.type === "assistant.message" && typeof event.data?.content === "string") parts.push(event.data.content);
    } catch {
      // Not an event line.
    }
  }
  return parts.join("\n");
}

/**
 * The exchange: the first line (when the wait has one), then each of the person's lines, in one chat. `between` runs
 * after the person's first line and before their next one (the misread a correction answers).
 */
export async function exchange(tool: LiveTool, rig: LiveRig, lines: string[], ledger: PersonTurn[], between?: () => void): Promise<Exchange> {
  const result: Exchange = { turns: [], boxes: 0, error: null };
  const sent = (line: string) => ledger.push({ words: line, cursor: auditCursor(rig.proj) });
  try {
    if (tool === "claude") {
      let next = 1;
      // Where each line the person gave starts in the drive's prose and tool results; a line a box took is placed
      // after the drive, at that box.
      const starts: Array<{ text: number; tool: number } | "box"> = [{ text: 0, tool: 0 }];
      const asked: number[] = [];
      const r = await driveAidlc(lines[0], {
        // The SDK's own Claude Code is the nightly's, which takes the nightly's model pins (the newest models need a newer
        // Claude Code; the claude-tui driver runs the box's own).
        projectDir: rig.proj, permissionMode: "bypassPermissions",
        env: { DISABLE_AUTOUPDATER: "1", ...(process.env.AIDLC_GATE_FUZZ_KEEP_MODELS === "1" ? {} : CI_BEDROCK_MODELS.claude) },
        // The first one-question box after the question was shown takes the person's next line as a person answers a
        // box: the option it names, else their words in the box's own field. Any other box is left for the chat.
        chatAboutQuestionWhen: (menu) => menu.questions.length !== 1 || next >= lines.length || starts.includes("box"),
        answerScript: {
          kind: "pick",
          pick: (q) => {
            const line = lines[next++];
            starts.push("box");
            const label = q.options.find((o) => o.label.trim().toLowerCase() === line.trim().toLowerCase())?.label;
            return label ? { label } : { text: line };
          },
        },
        nextMessage: (turn) => {
          asked.push(turn.askedQuestions);
          if (next >= lines.length) return undefined;
          if (next === 2) between?.();
          starts.push({ text: turn.assistantText.length, tool: turn.toolResults });
          return lines[next++];
        },
        timeoutMs: remainingOperationTimeoutMs(30 * 60_000),
      });
      const box = r.toolResults.findIndex((t) => t.toolName === "AskUserQuestion");
      const at = starts.map((x) => x === "box" ? { text: (r.assistantTextBeforeFirstAsk ?? r.assistantText).length, tool: Math.max(0, box) } : x);
      at.forEach((from, i) => {
        const to = at[i + 1] ?? { text: r.assistantText.length, tool: r.toolResults.length };
        result.turns.push({ line: lines[i], text: r.assistantText.slice(from.text, to.text),
          tools: r.toolResults.slice(from.tool, to.tool).map((t) => ({ command: JSON.stringify(t.input).slice(0, 400), output: t.resultText })) });
      });
      // Boxes opened after the person's last line: questions put to them after it.
      result.boxes = r.askedQuestions.length - (asked.at(-1) ?? 0);
      return result;
    }
    if (tool === "kiro") {
      const session = new AcpSession(rig.proj, "aidlc", true);
      try {
        for (const [at, line] of lines.entries()) {
          if (at === 2) between?.();
          if (at > 0) sent(line);
          const r = await driveKiroAcp({ projectDir: rig.proj, prompt: line, session, keepAlive: true, timeoutMs: remainingOperationTimeoutMs(30 * 60_000) });
          result.turns.push({ line, text: r.assistantText, tools: r.toolCalls.map((t) => ({ command: `${t.title ?? ""} ${JSON.stringify(t.rawInput ?? {}).slice(0, 300)}`, output: (t.output ?? []).join("").slice(0, 4000) })) });
        }
      } finally {
        session.close();
      }
      return result;
    }
    let session: string | undefined;
    if (tool === "claude-cli") session = randomUUID();
    if (tool === "cursor") {
      const made = spawnTool([process.env.AIDLC_CURSOR_BIN ?? "agent", "create-chat"], rig.proj, rig.env);
      session = made.stdout.trim().split("\n").at(-1)?.trim();
    }
    if (tool === "copilot") session = randomUUID();
    // A turn whose tool process failed before the agent said a word is the rig's, not the agent's: the drive stops there.
    const died = (rc: number, words: string, out: string): boolean => {
      if (rc === 0 || words.trim().length > 0) return false;
      result.error = `${DIED} (${tool} exit ${rc}): ${out.trim().slice(-300)}`;
      return true;
    };
    for (const [at, line] of lines.entries()) {
      if (at === 2) between?.();
      if (at > 0) sent(line);
      if (tool === "codex") {
        const r = codexJsonTurn(rig.proj, rig.home ?? "", line, `gate-fuzz-${at}`, session);
        session ??= r.sessionId;
        let text = "";
        try {
          text = turnEvidence(r.stdout).agentMessages.join("\n");
        } catch {
          text = "";
        }
        if (died(r.rc, text, r.out)) break;
        result.turns.push({ line, text, tools: r.results.map((t) => ({ command: String(t.input.command ?? ""), output: t.resultText })) });
      } else if (tool === "claude-cli") {
        const r = spawnTool([claudeBinary(), "-p", line, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
          ...(at === 0 ? ["--session-id", session ?? ""] : ["--resume", session ?? ""])], rig.proj, rig.env);
        const turn = claudeStream(r.stdout);
        if (died(r.rc, turn.text, r.out)) break;
        result.turns.push({ line, ...turn });
      } else if (tool === "opencode") {
        const { argv, input } = opencodeRunCommand(line, session);
        const r = spawnTool([process.env.AIDLC_OPENCODE_BIN ?? "opencode", ...argv], rig.proj, rig.env, input);
        const parsed = opencodeToolResults(r.stdout);
        session ??= parsed.sessionId;
        if (died(r.rc, opencodeText(r.stdout), r.out)) break;
        result.turns.push({ line, text: opencodeText(r.stdout), tools: parsed.results.map((t) => ({ command: String(t.input.command ?? JSON.stringify(t.input)), output: t.resultText })) });
      } else if (tool === "cursor") {
        const r = spawnTool([process.env.AIDLC_CURSOR_BIN ?? "agent", "-p", line, "--trust", "--model", process.env.AIDLC_CURSOR_MODEL ?? "auto",
          "--output-format", "text", ...(session ? ["--resume", session] : [])], rig.proj, rig.env);
        if (died(r.rc, r.stdout, r.out)) break;
        result.turns.push({ line, text: r.out, tools: [] });
      } else {
        const r = copilotTurn(rig.proj, line, { copilotHome: rig.home ?? "", sessionId: session ?? randomUUID(), resume: at > 0, json: true, stdin: true });
        if (died(r.rc, copilotText(r.out), r.out)) break;
        result.turns.push({ line, text: copilotText(r.out), tools: copilotToolResults(r.out).map((t) => ({ command: String(t.input.command ?? ""), output: t.resultText })) });
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message.slice(0, 1500) : String(error);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Judging by outcome
// ---------------------------------------------------------------------------

interface Row { event: string; block: string; index: number }
const rowsOf = (proj: string): Row[] => {
  try {
    return lib().readAuditShardEvents(proj).map((row, index) => ({ event: row.event, block: row.block, index }));
  } catch {
    return [];
  }
};
const fieldOf = (row: Row, name: string) => lib().auditBlockField(row.block, name);

/** The decisions on record after `from`, in section 4.3's words. */
export function decisionsSince(proj: string, from: number, intentsBefore: number, activeBefore: string | null = null): string[] {
  const out: string[] = [];
  for (const row of rowsOf(proj).slice(from)) {
    const checkpoint = fieldOf(row, "Checkpoint");
    const details = fieldOf(row, "Details") ?? fieldOf(row, "Choice") ?? "";
    switch (row.event) {
      case "GATE_APPROVED":
        out.push(checkpoint ? "checkpoint-approve" : fieldOf(row, "User Input") === "Accept as-is" ? "accept-as-is" : "approve");
        break;
      case "GATE_REJECTED":
        out.push(checkpoint ? "checkpoint-reject" : "request-changes");
        break;
      case "PLAN_APPROVAL_RECORDED":
        out.push("approve-plan");
        break;
      case "VERIFICATION_COMMAND_RECORDED":
      case "CONSTRUCTION_POLICY_RECORDED":
        out.push("checkpoint-approve");
        break;
      case "QUESTION_ANSWERED":
      case "SUMMARY_CONFIRMATION_RECORDED":
        if (checkpoint === "plan-approval") out.push(/^Request Changes/.test(details) ? "request-plan-changes" : /edit/i.test(details) ? "edit-plan" : "approve-plan");
        else if (checkpoint === "verification-command" || checkpoint === "construction-policy") out.push(/^Approve/.test(details) ? "checkpoint-approve" : "checkpoint-reject");
        else if (checkpoint === "guard-recovery") out.push(`remedy:${details}`);
        else out.push(`answer:${details.split(":")[0].trim()}`);
        break;
      case "ARTIFACT_REUSED":
        out.push(`answer:${(fieldOf(row, "Decision") ?? "").toLowerCase()}`);
        break;
      case "RECOMPOSED": {
        const added = fieldOf(row, "Added") ?? fieldOf(row, "Add") ?? "";
        out.push(added ? `add-stage:${added.split(",")[0].trim()}` : "skip-stage");
        break;
      }
      case "STAGE_JUMPED":
        out.push(fieldOf(row, "Direction") === "REDO" ? "resume:redo" : "resume:jump");
        break;
      case "REQUEST_ROUTED":
        out.push("route:reshape");
        break;
      case "WORKFLOW_PARKED":
        out.push("park");
        break;
      case "WORKSPACE_RECLASSIFIED":
        out.push(`answer:${/Brownfield/i.test(fieldOf(row, "New Project Type") ?? "") ? "Yes, it is existing code" : "No, it stays a new project"}`);
        break;
      case "UNIT_RESUMED":
        out.push("answer:Resume");
        break;
    }
  }
  const intents = lib().listIntents(proj);
  if (intents.length > intentsBefore) {
    out.push("route:separate", "resume:fresh");
    // A plan confirmed or picked is the work created with it (no answer row of its own on today's main).
    for (const intent of intents.slice(intentsBefore)) if (intent.scope) out.push(`answer:Go ahead with the "${intent.scope}" plan`, `answer:${intent.scope}`);
  }
  // A pick among the open pieces of work is the active work changing (no row of its own): the record folder, less its date.
  else {
    const now = lib().readActiveIntentCursor(proj);
    if (now !== null && now !== activeBefore) out.push(`answer:${now.replace(/^\d{6}-/, "")}`);
  }
  return out;
}

/** Whether what the agent showed first offers what the reply picks from: a model reads it (the answers corpus's own setup check, by meaning). */
/** One yes-or-no question to the model judge; null when it could not run or gave no verdict. */
async function askJudge(rubric: string, judgeDir: string): Promise<{ ok: boolean; reason?: string } | null> {
  const proc = Bun.spawn(["claude", "-p", rubric, "--output-format", "json", "--model", "sonnet", "--no-session-persistence", "--permission-mode", "default",
    "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Skill", "AskUserQuestion"],
  { cwd: judgeDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_CONFIG_DIR: join(judgeDir, "config"), DISABLE_AUTOUPDATER: "1" } });
  const [stdout, status] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (status !== 0) return null;
  const result = String((JSON.parse(stdout) as { result?: string }).result ?? "");
  const verdict = /\{[^{}]*"ok"\s*:\s*(true|false)[^{}]*\}/.exec(result);
  return verdict ? (JSON.parse(verdict[0]) as { ok: boolean; reason?: string }) : null;
}

export async function judgeShown(text: string, shows: string, judgeDir: string): Promise<string | null> {
  if (text.trim().length === 0) return "setup: the agent showed nothing before the person's reply";
  const parsed = await askJudge([
    "You check one thing about what an AI assistant showed a person in a software project tool, before the person replied.",
    `Does it offer ${shows}? Answer by meaning, not exact words.`,
    'Answer with one line of JSON only: {"ok": true or false, "reason": "<one sentence>"}',
    "What the assistant showed follows.",
    text.slice(-4000),
  ].join("\n\n"), judgeDir);
  if (parsed === null) return "setup: the check of what was shown gave no verdict";
  return parsed.ok ? null : `setup: the agent did not offer ${shows} (${parsed.reason ?? "no reason"})`;
}

/** Whether a recorded answer is the answer the person meant, by meaning: "sqlite please" is SQLite, "the second one" names nothing. */
export async function sameAnswer(want: string, recorded: string[], meaning: string, judgeDir: string): Promise<boolean> {
  const parsed = await askJudge([
    "You check one record a software project tool kept of a person's answer to a question.",
    `What the person meant: ${meaning}`,
    `The answer they meant: ${JSON.stringify(want)}`,
    `The answer(s) on record: ${recorded.map((r) => JSON.stringify(r)).join(", ")}`,
    "Does one answer on record say that same answer, so that someone reading only the record knows what the person chose? Answer by meaning, not exact words.",
    'Answer with one line of JSON only: {"ok": true or false, "reason": "<one sentence>"}',
  ].join("\n\n"), judgeDir);
  return parsed?.ok === true;
}

export interface Verdict {
  reply: Reply;
  tool: LiveTool;
  failures: Array<{ pass: "P1" | "P2" | "P3" | "P4" | "P5" | "setup" | "drive"; what: string }>;
  decisions: string[];
  refusalsMet: number;
  asks: number | null;
  /** What the person read after their reply, for the report. */
  read: string;
}

const CARRYING_ON = /AI-DLC is carrying on/;
const DIED = "the tool's turn failed before the agent said anything";
/**
 * The agent's words after the person's reply, judged by meaning with what the person had been shown before it, so the
 * next stage's own opening question reads as the work moving on and not as a question back.
 */
export async function judgeWords(reply: Reply, shown: string, said: string, judgeDir: string): Promise<{ failure: string | null; asked: number | null }> {
  if (said.trim().length === 0) return { failure: "the agent said nothing to the person before carrying on (no line about what it did)", asked: null };
  const end = reply.expected.end;
  const proc = Bun.spawn(["claude", "-p", [
    "You judge what an AI assistant told a person in a software project tool, right after the person replied to it.",
    `What the assistant had shown the person just before (its end):\n${shown.slice(-2500) || "(nothing in this chat yet)"}`,
    `The person typed: ${JSON.stringify(reply.inputs.at(-1) ?? "")}`,
    `What the person meant: ${reply.meaning}`,
    ...(end.says.length ? [`The reply must tell the person each of these, by meaning and not by exact words (a reply that stops at the one allowed question need only ask it):\n${end.says.map((x) => `- ${x}`).join("\n")}`] : []),
    end.asks > 0
      ? "One question back to the person about their reply is allowed: the meaning leaves a choice to them or the line is ambiguous. Asking it plainly passes; acting consistently with the meaning without asking passes too."
      : "No question back to the person about their reply is allowed: the meaning is clear.",
    "A question back is one about the person's reply or the same decision: asking again, asking them to confirm, or asking something their reply already settled. Once the decision is carried out the work moves on, and the next step may open with its own question (how to answer a new stage's questions, a plan to approve, the next gate): that is not a question back. One question with several options is one question.",
    `The reply passes when all hold: (1) it says in plain words what was done, or what the person now needs to decide, consistent with what they meant; ${PERSON_READS_RULE}(3) it asks a question back only where allowed above. Judge the words to the person, not the work log.`,
    'Answer with one line of JSON only: {"ok": true or false, "asked": <the number of questions back, as defined above>, "reason": "<one sentence>"}',
    `What the assistant told the person after their reply:\n${said.slice(-4000)}`,
  ].join("\n\n"), "--output-format", "json", "--model", "opus", "--no-session-persistence", "--permission-mode", "default",
  "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Skill", "AskUserQuestion"],
  { cwd: judgeDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_CONFIG_DIR: join(judgeDir, "config"), DISABLE_AUTOUPDATER: "1" } });
  const [stdout, status] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (status !== 0) return { failure: `the judge could not run (exit ${status})`, asked: null };
  return judgeVerdict(String((JSON.parse(stdout) as { result?: string }).result ?? ""));
}
const REFUSAL = /"kind"\s*:\s*"error"|Cannot (?:approve|record|reject)|Refusing to/;

/** Judge one exchange against the reply: the record by script, the agent's words by the model judge. */
export async function judge(reply: Reply, tool: LiveTool, rig: LiveRig, ex: Exchange, start: { rows: number; intents: number; active: string | null; cursor: ReturnType<typeof auditCursor> }, ledger: PersonTurn[], judgeDir: string): Promise<Verdict> {
  const failures: Verdict["failures"] = [];
  const decisions = decisionsSince(rig.proj, start.rows, start.intents, start.active);
  const end = reply.expected.end;
  // The SDK driver refuses a drive whose decisions no turn of the person backs: that is P3.
  if (ex.error) failures.push({ pass: /recorded \d+ decision\(s\) as the person's/.test(ex.error) ? "P3" : "drive", what: ex.error });
  // A dead turn judges nothing about the reply: the drive line stands alone.
  if (ex.error?.startsWith(DIED)) return { reply, tool, failures, decisions, refusalsMet: 0, asks: null, read: "" };
  // A reply to a list the agent never showed judges nothing about the reply: the setup line stands alone.
  if (reply.shows && ex.turns.length > reply.inputs.length) {
    const setup = await judgeShown(ex.turns[0].text, reply.shows, judgeDir);
    if (setup !== null) return { reply, tool, failures: [{ pass: "setup", what: setup }], decisions, refusalsMet: 0, asks: null, read: ex.turns.at(-1)?.text.slice(-1500) ?? "" };
  }
  // P1: the decision the person meant, or nothing and one question for an ambiguous reply.
  const wanted = [end.decision, ...(end.also ?? []).filter((a) => !/ /.test(a))].filter((d) => d !== "none");
  if (end.decision === "none" && decisions.length > 0) failures.push({ pass: "P1", what: `recorded ${decisions.join(", ")} where the person decided nothing` });
  for (const want of wanted) {
    if (decisions.some((d) => d === want || d.toLowerCase() === want.toLowerCase())) continue;
    // An answer is the person's choice in any words: the record is judged by what it says, not by matching the label.
    const answers = decisions.filter((d) => d.startsWith("answer:")).map((d) => d.slice("answer:".length));
    if (want.startsWith("answer:") && answers.length > 0 && await sameAnswer(want.slice("answer:".length), answers, reply.meaning, judgeDir)) continue;
    failures.push({ pass: "P1", what: `${want} is not on record (recorded: ${decisions.join(", ") || "nothing"})` });
  }
  // P2: the agent's words after the last line, by meaning; refusals the agent met are counted.
  const last = ex.turns.at(-1);
  const read = last?.text ?? "";
  const shown = ex.turns.at(-2)?.text ?? "";
  const verdict = await judgeWords(reply, shown, read, judgeDir);
  if (verdict.failure !== null) failures.push({ pass: "P2", what: verdict.failure });
  const asks = Math.max(verdict.asked ?? 0, tool === "claude" ? ex.boxes - 1 : 0);
  if (asks > end.asks) failures.push({ pass: "P2", what: `${asks} question(s) back to the person, ${end.asks} allowed` });
  if (ex.turns.some((t) => CARRYING_ON.test(t.text))) failures.push({ pass: "P2", what: "the person read that the work carries on while it waits for them" });
  const refusalsMet = ex.turns.flatMap((t) => t.tools).filter((t) => REFUSAL.test(t.output)).length;
  // P3: every decision row since the reply is backed by a turn the person took (the SDK driver checks its own).
  if (tool !== "claude") {
    for (const problem of unbackedDecisions(rig.proj, start.cursor, ledger)) failures.push({ pass: "P3", what: problem.slice(0, 300) });
  }
  // P4: the message record keeps each line whole, and the decision row names it.
  const kept = store().listMessages(rig.proj).map((m) => lib().personsWordsText(m.text));
  // A blank line has no words to keep.
  for (const line of reply.inputs.filter((l) => l.trim().length > 0)) {
    const text = said(line, tool);
    if (!kept.some((whole) => whole === text || whole.trim() === text.trim())) failures.push({ pass: "P4", what: `no message record holds ${JSON.stringify(text.slice(0, 80))} whole` });
  }
  for (const row of rowsOf(rig.proj).slice(start.rows)) {
    if (["GATE_APPROVED", "GATE_REJECTED", "PLAN_APPROVAL_RECORDED", "QUESTION_ANSWERED", "SUMMARY_CONFIRMATION_RECORDED", "REQUEST_ROUTED"].includes(row.event) && fieldOf(row, "Message Id") === null) {
      failures.push({ pass: "P4", what: `${row.event} names no message` });
    }
  }
  // P5: no refusal came back for the same command, and the work ends at a step or a wait.
  const tools = ex.turns.flatMap((t) => t.tools);
  for (let i = 1; i < tools.length; i++) {
    if (REFUSAL.test(tools[i].output) && tools[i].command === tools[i - 1].command && tools[i].output === tools[i - 1].output) {
      failures.push({ pass: "P5", what: `the same refusal came back for ${tools[i].command.slice(0, 120)}` });
      break;
    }
  }
  return { reply, tool, failures, decisions, refusalsMet, asks, read: read.slice(-1500) };
}

/**
 * The project as the person's chat finds it at the reply's wait: the question open, or for a question their first line
 * opens, the work before that line. Seeded open, the question was asked where nobody sees it, and the line typed again
 * met the engine's step for an unanswered question, which an agent could answer for the person.
 */
export async function seedWait(proj: string, wait: Question): Promise<void> {
  const opened = OPENED_BY_FIRST_LINE[wait];
  return opened === undefined ? buildQuestion(proj, wait) : buildState(proj, opened.before);
}

/** Drive and judge one reply on one tool. */
/** `keep`: a folder that keeps each reply's audit and what the agent told the person, read after the run. */
export async function driveReply(reply: Reply, tool: LiveTool, judgeDir: string, keep: string | null = null): Promise<Verdict> {
  const rig = liveRig(tool);
  let ex: Exchange | null = null;
  try {
    await seedWait(rig.proj, reply.wait);
    if (reply.beside) {
      spawnTool([process.execPath, join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-log.ts"), "decision", "--stage", "requirements-analysis",
        "--decision", reply.beside.decision, "--options", reply.beside.options.join(","), "--project-dir", rig.proj], rig.proj, rig.env);
    }
    const start = { rows: rowsOf(rig.proj).length, intents: lib().listIntents(rig.proj).length, active: lib().readActiveIntentCursor(rig.proj), cursor: auditCursor(rig.proj) };
    const first = firstLine(reply, tool);
    const lines = [...(first ? [first] : []), ...reply.inputs.map((line) => said(line, tool))];
    const ledger: PersonTurn[] = [];
    // The misread: the agent recorded the opposite of the person's first reply; their next line corrects it.
    const between = reply.setup === "misread" ? () => {
      spawnTool([process.execPath, join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts"), "report", "--stage", "requirements-analysis",
        "--result", "rejected", "--user-input", "Request Changes", "--project-dir", rig.proj], rig.proj, rig.env);
    } : undefined;
    ex = await exchange(tool, rig, lines, ledger, between);
    return await judge(reply, tool, rig, ex, start, ledger, judgeDir);
  } finally {
    if (keep !== null) {
      const dir = join(keep, tool, reply.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "exchange.json"), `${JSON.stringify({ reply, exchange: ex }, null, 2)}\n`);
      const records = join(rig.proj, "aidlc");
      if (existsSync(records)) cpSync(records, join(dir, "aidlc"), { recursive: true, filter: (from) => !/[\\/](?:construction|inception|ideation|operation)[\\/]/.test(from) });
    }
    rig.cleanup();
  }
}

/** The report: per tool and wait point, replies run, how many passed, and every failure with what the person read. */
export function writeReport(dir: string, verdicts: Verdict[], header: string[]): string {
  mkdirSync(dir, { recursive: true });
  const lines = [`# Live gate fuzz`, "", ...header, ""];
  for (const tool of LIVE_TOOLS) {
    const mine = verdicts.filter((v) => v.tool === tool);
    if (mine.length === 0) continue;
    const passed = mine.filter((v) => v.failures.length === 0).length;
    lines.push(`## ${tool}: ${passed} of ${mine.length} passed; refusals the agent met: ${mine.reduce((t, v) => t + v.refusalsMet, 0)}`, "",
      "| wait | replies | passed | P1 | P2 | P3 | P4 | P5 |", "|---|---|---|---|---|---|---|---|");
    for (const wait of [...new Set(mine.map((v) => v.reply.wait))]) {
      const w = mine.filter((v) => v.reply.wait === wait);
      const count = (p: string) => w.filter((v) => v.failures.some((f) => f.pass === p)).length;
      lines.push(`| ${wait} | ${w.length} | ${w.filter((v) => v.failures.length === 0).length} | ${count("P1")} | ${count("P2")} | ${count("P3")} | ${count("P4")} | ${count("P5")} |`);
    }
    lines.push("");
    for (const v of mine.filter((x) => x.failures.length > 0)) {
      lines.push(`### ${v.reply.id} (${v.reply.wait}, ${v.reply.replyClass}): ${v.reply.inputs.map((i) => JSON.stringify(i)).join(" then ")}`, "",
        ...v.failures.map((f) => `- ${f.pass}: ${f.what}`), `- Recorded: ${v.decisions.join(", ") || "nothing"}; questions back: ${v.asks ?? "?"}`,
        `- The person read: ${v.read.replace(/\s+/g, " ").slice(-600)}`, "");
    }
  }
  const file = join(dir, "REPORT.md");
  writeFileSync(file, `${lines.join("\n")}\n`);
  writeFileSync(join(dir, "verdicts.json"), JSON.stringify(verdicts, null, 2));
  return file;
}

// `--rejudge <report dir> [--answers] [--words]`: a finished run read again by the rules added since it ran (the plan off
// the registry, a dead tool turn as a drive miss), into <dir>/rejudged; --answers asks the model again whether a recorded
// answer is the one meant (sameAnswer, for a run judged before it existed) and --words judges the agent's words again
// (judgeWords, where the run kept its traces). Without them the rejudge asks no model, so it gives the same numbers each time.
if (import.meta.main && process.argv.includes("--rejudge")) {
  const dir = process.argv[process.argv.indexOf("--rejudge") + 1];
  const verdicts = JSON.parse(readFileSync(join(dir, "verdicts.json"), "utf-8")) as Verdict[];
  const judgeDir = mkdtempSync(join(tmpdir(), "gate-fuzz-judge-"));
  mkdirSync(join(judgeDir, "config"), { recursive: true });
  for (const v of verdicts) {
    // A run before decisionsSince read the plan off the work it created: the kept registry says which plan it was.
    const registry = join(dir, "traces", v.tool, v.reply.id, "aidlc", "spaces", "default", "intents", "intents.json");
    if (v.decisions.includes("route:separate") && existsSync(registry)) {
      for (const intent of JSON.parse(readFileSync(registry, "utf-8")) as Array<{ scope?: string; request?: string }>) {
        if (intent.scope && intent.request) v.decisions.push(`answer:Go ahead with the "${intent.scope}" plan`, `answer:${intent.scope}`);
      }
      v.failures = v.failures.filter((f) => !(f.pass === "P1" && v.decisions.includes(/^(.*) is not on record \(recorded: /.exec(f.what)?.[1] ?? "")));
    }
    const answers = v.decisions.filter((d) => d.startsWith("answer:")).map((d) => d.slice("answer:".length));
    const kept: Verdict["failures"] = [];
    for (const f of v.failures) {
      const want = /^(answer:.*) is not on record \(recorded: /.exec(f.what)?.[1];
      if (process.argv.includes("--answers") && f.pass === "P1" && want && answers.length > 0 && await sameAnswer(want.slice("answer:".length), answers, v.reply.meaning, judgeDir)) continue;
      kept.push(f);
    }
    v.failures = kept;
    const trace = join(dir, "traces", v.tool, v.reply.id, "exchange.json");
    const ex = existsSync(trace) ? (JSON.parse(readFileSync(trace, "utf-8")) as { exchange: Exchange | null }).exchange : null;
    // A run kept before dead turns were drive misses: a turn with no words and no tool call is one (its exit code was not kept).
    const dead = ex?.turns.find((t) => t.text.trim().length === 0 && t.tools.length === 0);
    if (dead) {
      v.failures = [{ pass: "drive", what: `${DIED} (no words and no tool call after ${JSON.stringify(dead.line)}; exit code not kept)` }];
      v.asks = null;
      continue;
    }
    if (ex && ex.turns.length > 0 && process.argv.includes("--words")) {
      const words = await judgeWords(v.reply, ex.turns.at(-2)?.text ?? "", ex.turns.at(-1)?.text ?? "", judgeDir);
      v.failures = v.failures.filter((f) => !(f.pass === "P2" && (/^the agent('s words| said nothing)|^the judge /.test(f.what) || / question\(s\) back to the person/.test(f.what))));
      if (words.failure !== null) v.failures.push({ pass: "P2", what: words.failure });
      const asks = Math.max(words.asked ?? 0, v.tool === "claude" ? ex.boxes - 1 : 0);
      if (asks > v.reply.expected.end.asks) v.failures.push({ pass: "P2", what: `${asks} question(s) back to the person, ${v.reply.expected.end.asks} allowed` });
      v.asks = asks;
    }
  }
  console.log(writeReport(join(dir, "rejudged"), verdicts, ["The answers judged again by meaning (live-gate-fuzz.ts --rejudge)."]));
}

if (import.meta.main && process.argv.includes("--write-corpus")) {
  mkdirSync(join(REPO_ROOT, "tests", "fixtures", "gate-fuzz"), { recursive: true });
  const corpus = draftCorpus();
  writeFileSync(CORPUS_FILE, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(`${corpus.length} replies -> ${CORPUS_FILE}`);
}

