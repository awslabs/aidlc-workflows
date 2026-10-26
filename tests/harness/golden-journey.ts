// golden-journey.ts - the person in a live golden journey.
//
// A golden journey drives one real model through a scope family's real path,
// the way a person drives it: they type their request, answer each question
// once, approve each stage once, approve the plan once where the scope asks
// for it, and close the session once the journey's last stage is approved.
//
// What the person picks in a menu comes from the menu itself; what they type
// when a turn ends comes from what the engine recorded as waiting for them: a
// question it logged and nobody answered, a stage waiting for approval, the
// engine's last ask, or a question in the stage's questions file still without
// an answer (the Stop hook ends the turn on that one too). When the record
// shows nothing waiting, they read the agent's words, as a person reads the
// screen: a model says whether a question was left there (judgeOpenQuestion),
// and they answer it; with none, the journey is stuck. When the same thing
// reaches them twice, they were asked twice. Both are failures, named in
// `problems`.
//
// The test drives with driveAidlc (sdk-drive.ts), which already fails a drive
// whose agent records a decision the person did not make (person-turns.ts). A
// tool that takes one typed line per process (codex exec, copilot -p, opencode
// run) drives with driveTyped, its own turns checking the same.
//
// The person keeps stock settings: Claude Code's default permission mode and
// the project's shipped settings. Every prompt is answered yes; a prompt for
// AI-DLC's own command or record, or a write outside the project, is a
// problem (stock-permissions.ts), and the other prompts are listed.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { hasPendingQuestion } from "../../dist/claude/.claude/hooks/aidlc-continue-workflow.ts";
import {
  auditBlockField,
  isLearningsNoteDecision,
  readAuditShardEvents,
  readBaselineSourceSnapshot,
  sourceChangedOutsideAidlc,
  stageDir,
  workspaceSourceListing,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { parseDirectiveOutput } from "./directive-output.ts";
import { declaredScope, expectedStages, sourceStages } from "./scope-run.ts";
import type { AgentWords } from "./leg-evidence.ts";
import { judgeFolder, judgeOpenQuestion } from "./live-corpus.ts";
import { claudePromptProblems } from "./stock-permissions.ts";
import {
  type AnswerSpec,
  type AskUserQuestionItem,
  type CapturedToolResult,
  type DriveOptions,
  type DriveResult,
  plainChoice,
  readStateField,
  readStateFile,
  recommended,
} from "./sdk-drive.ts";

type Row = ReturnType<typeof readAuditShardEvents>[number];

/** Switches that would turn the production contract off for a drive. */
export const GUARD_SWITCHES = [
  "AIDLC_SKIP_ARTIFACT_GUARD",
  "AIDLC_SKIP_HUMAN_PRESENCE_GUARD",
  "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
  "AIDLC_SKIP_REVISION_BACKSTOP",
  "AIDLC_SKIP_REVIEWER_GATE_GUARD",
  "AIDLC_SKIP_SOURCE_FRESHNESS",
  "AIDLC_DISABLE_REVIEW_FREEZE_HOOK",
  "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK",
  "AIDLC_DISABLE_PLAN_APPROVAL_GUARD",
  "AIDLC_ALLOW_DIRECT_AUDIT_EVENTS",
  "AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS",
  "AIDLC_UNATTENDED",
] as const;

/** Golden journeys get longer than the usual live work budget. */
export const GOLDEN_WORK_MS = 45 * 60_000;

/** A person who has typed this many messages in one chat is going round in circles. */
const MAX_TURNS = 40;

export interface GoldenJourney {
  /** The project folder, already holding the AI-DLC tree and the person's files. */
  proj: string;
  /** The golden scope: its stages and switches are what the journey expects. */
  scope: string;
  /** Whether the project holds code when the journey starts. */
  hasCode: boolean;
  /** The person's first message. */
  request: string;
  /** The first question asked in this stage gets these words instead of a pick. */
  ownWords?: { stage: string; words: string };
  /** The journey ends when this stage's approval is recorded. */
  lastStage: string;
  /** The work time left, as test-budget.ts measures it. */
  budget: () => number | undefined;
  /**
   * Typed tools: the person leaves the plan question unanswered for the day and
   * comes back in a new session (not a resume) typing this line. The question
   * must come first there; it counts as asked once.
   */
  newSessionAtPlan?: string;
  /**
   * The person's first reply to this stage's approval asks for this change
   * instead; the gate offered again after the revision counts as asked once.
   */
  changeRequest?: { stage: string; words: string };
  /** Reads the agent's words at a turn's end for a question left open; a model by default (judgeOpenQuestion). */
  openQuestion?: (words: string) => ReturnType<typeof judgeOpenQuestion>;
}

export interface GoldenRun {
  /** Every tool call the agent made, in order. */
  toolResults: readonly CapturedToolResult[];
  /** Audit rows already there when the person started: a seeded leg's earlier stages. */
  start: number;
  /** What the person picked or typed, in order. */
  person: string[];
  /** Everything that went wrong from the person's side, in plain words. */
  problems: string[];
  /** How many times the plan question reached the person. */
  planAsked: number;
  /** Whether the person's own words were used. */
  ownWordsUsed: boolean;
  /** Prompts the person met that were theirs to decide (the project's own commands). */
  prompts: string[];
  /** The person's files before their first line, as the engine lists its source; null when it could not. */
  files: ReadonlyMap<string, string> | null;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// The Plan Approval question is one question to the person, whichever record shows it (a box, a logged decision,
// the engine's ask, the questions file), so it is reached under one key.
const PLAN_CHOICE = /^Approve Plans?\b/;
const planKey = (stage: string): string => `plan approval | ${stage}`;
function questionKey(stage: string, question: string, options: readonly string[]): string {
  return options.some((o) => PLAN_CHOICE.test(o)) ? planKey(stage) : `${stage} | ${norm(question)}`;
}

function clip(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function auditRows(proj: string): Row[] {
  try {
    return readAuditShardEvents(proj);
  } catch {
    return [];
  }
}

export function sourceListing(proj: string): ReadonlyMap<string, string> | null {
  try {
    return workspaceSourceListing(proj);
  } catch {
    return null;
  }
}

export function stageField(row: Row): string {
  return auditBlockField(row.block, "Stage") ?? "";
}

/** True once the stage's approval is recorded. */
export function approved(proj: string, stage: string): boolean {
  return auditRows(proj).some((r) => r.event === "GATE_APPROVED" && stageField(r) === stage);
}

// An answer closes the question before it; a stage boundary closes the stage's.
const ANSWER_EVENTS = new Set([
  "QUESTION_ANSWERED",
  "QUESTION_UNANSWERED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "PLAN_APPROVAL_RECORDED",
  "GATE_APPROVED",
  "STAGE_COMPLETED",
]);

/** The last question the engine logged since row `from` that no answer has closed yet. */
function openDecision(proj: string, from: number): Row | undefined {
  const rows = auditRows(proj);
  for (let i = rows.length - 1; i >= from; i--) {
    const row = rows[i];
    if (ANSWER_EVENTS.has(row.event)) return undefined;
    if (row.event === "DECISION_RECORDED") return row;
  }
  return undefined;
}

/** The stage the state file shows waiting for approval, if any. */
function stageAwaitingApproval(proj: string): string | undefined {
  return /^- \[\?\] (\S+)/m.exec(readStateFile(proj) ?? "")?.[1];
}

/**
 * The first question in the stage's questions files whose answer is blank: its
 * heading and its options as listed (lettered, bulleted, or both). Whether one
 * waits is the Stop hook's call (`hasPendingQuestion`); this only finds it.
 */
function blankQuestion(proj: string, phase: string, stage: string): { question: string; options: string[] } | undefined {
  const dir = stageDir(proj, phase, stage);
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith("-questions.md")).sort() : [];
  for (const name of names) {
    for (const section of readFileSync(join(dir, name), "utf-8").split(/^(?=## )/m)) {
      if (!/\[Answer\]:[ \t]*_*[ \t]*$/m.test(section)) continue;
      const question = /^## (.+)$/m.exec(section)?.[1].trim() ?? name;
      const options = [...section.matchAll(/^(?:[-*][ \t]+(?:[A-Z][.)][ \t]+)?|[A-Z][.)][ \t]+)(.+)$/gm)].map((m) => m[1].trim());
      return { question, options };
    }
  }
  return undefined;
}

/**
 * The engine's last step handed to the agent, read from the agent's own Bash
 * results. A print after it changes nothing waiting for the person (the
 * engine's "Nothing was started: the person has not answered the plan question
 * yet" to an agent that ran ahead), so the step before it counts; a print alone
 * is the last step.
 */
export function lastEngineStep(results: readonly CapturedToolResult[]): Record<string, unknown> | undefined {
  let print: Record<string, unknown> | undefined;
  for (let i = results.length - 1; i >= 0; i--) {
    const t = results[i];
    const command = typeof t.input.command === "string" ? t.input.command : "";
    // The engine's own steps also tell the agent to run aidlc-orchestrate.ts (the plan offer's `next --propose`).
    if (t.toolName !== "Bash" || !/engine orchestrate|aidlc-orchestrate\.ts/.test(command)) continue;
    try {
      const step = parseDirectiveOutput(t.resultText).directive as unknown as Record<string, unknown>;
      if (step.kind !== "print") return step;
      print ??= step;
    } catch {
      // Not a directive (a refusal or a print): look further back.
    }
  }
  return print;
}

/**
 * The person in one golden journey. The test drives with
 * `driveAidlc(journey.request, person.driveOptions())`, so the live-test
 * discovery sees the drive, then reads the outcome with `person.finish(drive)`.
 */
export class GoldenPerson {
  readonly said: string[] = [];
  readonly problems: string[] = [];
  planAsked = 0;
  ownWordsUsed = false;
  // What already reached the person, by stage: a second time is "asked twice".
  private readonly reached = new Set<string>();
  private latest: readonly CapturedToolResult[] = [];
  private readonly start: number;
  private readonly files: ReadonlyMap<string, string> | null;
  // Typed tools: every tool call, this session's calls, and the question left open for the day.
  private readonly all: CapturedToolResult[] = [];
  private session: CapturedToolResult[] = [];
  private sessionFrom = 0;
  private lastKey = "";
  private left: string | undefined;
  private leftOnce = false;
  private changed = false;
  // The agent's words to the person in the turn that just ended, and how much of the SDK drive's prose came before it.
  private words = "";
  private wordsBefore = 0;
  private judgeDir?: string;

  constructor(private readonly j: GoldenJourney) {
    this.start = auditRows(j.proj).length;
    this.files = sourceListing(j.proj);
  }

  driveOptions(): DriveOptions {
    return {
      projectDir: this.j.proj,
      permissionMode: "default",
      settingSources: ["user", "project", "local"],
      persistSession: true,
      captureStopHooks: true,
      answerScript: { kind: "pick", pick: (q) => this.pick(q) },
      nextMessage: (turn) => {
        this.words = turn.assistantText.slice(this.wordsBefore);
        this.wordsBefore = turn.assistantText.length;
        return this.reply(turn.turn);
      },
      stopWhen: (results) => {
        this.latest = results;
        return approved(this.j.proj, this.j.lastStage);
      },
      timeoutMs: this.j.budget(),
    };
  }

  finish(drive: DriveResult): GoldenRun {
    const problems = [...this.problems];
    if (drive.timedOut) problems.push(`the journey ran out of time at ${this.stageNow()}`);
    if (!approved(this.j.proj, this.j.lastStage)) problems.push(`${this.j.lastStage} was never approved (the journey ended at ${this.stageNow()})`);
    const prompts = claudePromptProblems(drive.permissionRequests ?? [], this.j.proj);
    problems.push(...prompts.problems);
    if (prompts.listed.length) console.log(`Prompts the person decided on stock settings:\n  ${prompts.listed.join("\n  ")}`);
    return {
      toolResults: drive.toolResults, start: this.start, person: this.said, problems, planAsked: this.planAsked,
      ownWordsUsed: this.ownWordsUsed, prompts: prompts.listed, files: this.files,
    };
  }

  /** The person's first line. */
  get request(): string {
    return this.j.request;
  }

  /**
   * Typed tools: what the person types after a turn whose tool calls were
   * `results` and whose words to them were `words`, and whether it opens a new
   * session. The engine steps read are this session's only, so a new session
   * that asks nothing is "nothing asked".
   */
  typedReply(turn: number, results: readonly CapturedToolResult[], words = ""): { line?: string; newSession: boolean } {
    this.words = words;
    this.all.push(...results);
    this.session.push(...results);
    this.latest = this.session;
    const plan = this.planAsked;
    const line = this.reply(turn);
    if (line !== undefined && this.j.newSessionAtPlan !== undefined && !this.leftOnce && this.planAsked > plan) {
      this.said[this.said.length - 1] = `left the plan question unanswered for the day, then typed ${JSON.stringify(this.j.newSessionAtPlan)} in a new session`;
      this.left = this.lastKey;
      this.leftOnce = true;
      this.session = [];
      this.sessionFrom = auditRows(this.j.proj).length;
      return { line: this.j.newSessionAtPlan, newSession: true };
    }
    return { line, newSession: false };
  }

  /** The outcome of a typed journey, read as `finish` reads a drive. */
  typedRun(): GoldenRun {
    const problems = [...this.problems];
    if (this.left !== undefined) problems.push("the plan question left for the day was never offered again in the new session");
    if (!approved(this.j.proj, this.j.lastStage)) problems.push(`${this.j.lastStage} was never approved (the journey ended at ${this.stageNow()})`);
    return {
      toolResults: this.all, start: this.start, person: this.said, problems, planAsked: this.planAsked,
      ownWordsUsed: this.ownWordsUsed, prompts: [], files: this.files,
    };
  }

  private stageNow(): string {
    return readStateField(readStateFile(this.j.proj) ?? "", "Current Stage") ?? "(no work yet)";
  }

  // True for the question left open for the day coming back first in the new session: it counts once.
  private reach(key: string, what: string): boolean {
    this.lastKey = key;
    if (this.left !== undefined) {
      const left = this.left;
      this.left = undefined;
      if (key === left) return true;
      this.problems.push(`the new session asked ${what} before the plan question left open for the day`);
    }
    if (this.reached.has(key)) this.problems.push(`asked twice: ${what}`);
    this.reached.add(key);
    return false;
  }

  private readsScreen(words: string): ReturnType<typeof judgeOpenQuestion> {
    if (this.j.openQuestion) return this.j.openQuestion(words);
    this.judgeDir ??= judgeFolder();
    return judgeOpenQuestion(words, this.judgeDir);
  }

  private ownWords(stage: string): string | undefined {
    const own = this.j.ownWords;
    if (!own || this.ownWordsUsed || stage !== own.stage) return undefined;
    this.ownWordsUsed = true;
    return own.words;
  }

  // A menu: the plain choice at a ceremony question, the person's own words
  // for the first content question of their stage, else the recommended option.
  private pick(q: AskUserQuestionItem): AnswerSpec {
    const stage = this.stageNow();
    const labels = q.options.map((o) => o.label);
    const again = this.reach(questionKey(stage, q.question, labels), `"${q.question}" at ${stage}`);
    if (labels.some((l) => PLAN_CHOICE.test(l))) {
      if (!again) this.planAsked++;
    }
    else if (labels.some((l) => /^Approve\b/.test(l)) && labels.some((l) => /^Request Changes\b/i.test(l))) {
      this.reach(`approval | ${stage}`, `the ${stage} approval`);
    }
    const plain = plainChoice(labels);
    const words = plain === undefined && !q.multiSelect ? this.ownWords(stage) : undefined;
    const choice = plain ?? recommended(labels);
    this.said.push(`picked ${JSON.stringify(words ?? choice ?? labels[0] ?? "")} for "${clip(q.question, 120)}" at ${stage}`);
    return words !== undefined ? { text: words } : choice !== undefined ? { label: choice } : { optionIndex: 0 };
  }

  // A turn ended: type what answers what the engine says is waiting, or stop.
  private reply(turn: number): string | undefined {
    if (approved(this.j.proj, this.j.lastStage)) return undefined;
    const stage = this.stageNow();
    if (turn >= MAX_TURNS) {
      this.problems.push(`the person typed ${MAX_TURNS} messages and ${this.j.lastStage} was still not approved (at ${stage})`);
      return undefined;
    }
    const decision = openDecision(this.j.proj, this.sessionFrom);
    if (decision) {
      const question = auditBlockField(decision.block, "Decision") ?? "";
      const at = stageField(decision) || stage;
      const options = decisionOptions(decision);
      const again = this.reach(questionKey(at, question, options), `"${question}" at ${at}`);
      if (!again && options.some((o) => PLAN_CHOICE.test(o))) this.planAsked++;
      const words = plainChoice(options) ?? this.ownWords(at) ?? recommended(options) ?? options[0] ?? "Go with what you recommend";
      this.said.push(`typed ${JSON.stringify(words)} for "${clip(question, 120)}" at ${at}`);
      return words;
    }
    const waiting = stageAwaitingApproval(this.j.proj);
    if (waiting) {
      this.reach(`approval | ${waiting}`, `the ${waiting} approval`);
      const change = this.j.changeRequest;
      if (change?.stage === waiting && !this.changed) {
        this.changed = true;
        this.reached.delete(`approval | ${waiting}`);
        this.said.push(`typed ${JSON.stringify(change.words)} for the ${waiting} approval`);
        return change.words;
      }
      this.said.push(`typed "Approve" for the ${waiting} approval`);
      return "Approve";
    }
    const step = lastEngineStep(this.latest);
    const checkpoint = step?.construction_checkpoint as { kind?: string; unit?: string; human_required?: boolean } | undefined;
    if (checkpoint?.human_required === true) {
      this.reach(`checkpoint | ${checkpoint.kind} | ${checkpoint.unit}`, `the ${checkpoint.unit} ${checkpoint.kind} checkpoint`);
      this.said.push(`typed "Approve" for the ${checkpoint.unit} ${checkpoint.kind} checkpoint`);
      return "Approve";
    }
    if (step?.kind === "ask") {
      const type = String(step.ask_type ?? "");
      const again = this.reach(type === "plan-approval" ? planKey(stage) : `ask | ${type} | ${stage}`, `the ${type} question at ${stage}`);
      if (type === "plan-approval") {
        if (!again) this.planAsked++;
        this.said.push("typed \"Approve Plan\" for the plan");
        return "Approve Plan";
      }
      const offered = ((step.choices as Array<{ label?: unknown }> | undefined) ?? []).map((o) => String(o.label ?? o));
      const words = plainChoice(offered) ?? recommended(offered) ?? offered[0] ?? "Go with what you recommend";
      this.said.push(`typed ${JSON.stringify(words)} for the ${type} question at ${stage}`);
      return words;
    }
    // The agent asked a question from the stage's file without logging it: the
    // person sees it and answers it as they answer a logged one.
    const phase = (readStateField(readStateFile(this.j.proj) ?? "", "Lifecycle Phase") ?? "").toLowerCase();
    const blank = hasPendingQuestion(this.j.proj, stage, phase) ? blankQuestion(this.j.proj, phase, stage) : undefined;
    if (blank) {
      const again = this.reach(questionKey(stage, blank.question, blank.options), `"${blank.question}" at ${stage}`);
      if (!again && blank.options.some((o) => PLAN_CHOICE.test(o))) this.planAsked++;
      const words = plainChoice(blank.options) ?? this.ownWords(stage) ?? recommended(blank.options) ?? blank.options[0] ?? "Go with what you recommend";
      this.said.push(`typed ${JSON.stringify(words)} for "${clip(blank.question, 120)}" (in the questions file) at ${stage}`);
      return words;
    }
    // Nothing on record waits for them, so they read the screen: a question the
    // agent left there in its own words gets their answer.
    const open = this.words.trim() === ""
      ? { asked: false, question: "", reason: "the agent said nothing to the person" }
      : this.readsScreen(this.words);
    if (!("failure" in open) && open.asked) {
      const question = open.question || clip(this.words, 120);
      this.reach(`${stage} | ${norm(question)}`, `"${question}" at ${stage}`);
      const words = this.ownWords(stage) ?? "Go with what you recommend";
      this.said.push(`typed ${JSON.stringify(words)} for "${clip(question, 120)}" (asked in chat) at ${stage}`);
      return words;
    }
    const why = "failure" in open ? open.failure : open.reason;
    this.problems.push(`turn ${turn} ended at ${stage} with nothing asked of the person (${why}); the engine's last step was ${clip(JSON.stringify(step ?? null))}`);
    return undefined;
  }
}

function decisionOptions(row: Row): string[] {
  return (auditBlockField(row.block, "Options") ?? "").split(",").map((o) => o.trim()).filter(Boolean);
}

/**
 * Typed tools: drive a golden journey where each line the person types is one
 * process. `turn` runs the line (in a new session when asked) and returns the
 * tool calls the agent made, in the shape the SDK drive captures them, with
 * what the agent told the person (codexReplies, copilotReplies, opencodeReplies).
 */
export function driveTyped(
  person: GoldenPerson,
  turn: (line: string, newSession: boolean) => readonly CapturedToolResult[] | { results: readonly CapturedToolResult[]; words: readonly AgentWords[] },
): GoldenRun {
  let next: { line?: string; newSession: boolean } = { line: person.request, newSession: true };
  for (let n = 1; next.line !== undefined; n++) {
    const ran = turn(next.line, next.newSession);
    next = "results" in ran ? person.typedReply(n, ran.results, ran.words.map((w) => w.text).join("\n")) : person.typedReply(n, ran);
  }
  return person.typedRun();
}

/**
 * What the engine recorded against the scope's path, up to the journey's last
 * stage: the stages it ran, one approval each, the plan asked once where the
 * scope asks it, its summary and learnings switches kept, and the person's
 * files as they were until their pick started the work.
 */
export function goldenPathProblems(j: GoldenJourney, run: GoldenRun): string[] {
  const problems: string[] = [];
  // What the person did in this journey; a seeded leg's earlier stages came before it.
  const rows = auditRows(j.proj).slice(run.start);
  const count = (event: string) => rows.filter((r) => r.event === event).length;
  const declared = declaredScope(j.scope);
  const expected = expectedStages(j.scope, j.hasCode);
  const through = expected.slice(0, expected.indexOf(j.lastStage) + 1);
  if (through.length === 0) return [`${j.lastStage} is not on the ${j.scope} path ${JSON.stringify(expected)}`];
  const seeded = new Set(auditRows(j.proj).slice(0, run.start).filter((r) => r.event === "STAGE_COMPLETED").map(stageField));
  const live = through.filter((s) => !seeded.has(s));

  // The stages, in the scope's order, and nothing else started.
  const state = readStateFile(j.proj) ?? "";
  const ticked = [...state.matchAll(/^- \[x\] (\S+) \S+ EXECUTE$/gm)].map((m) => m[1]);
  if (JSON.stringify(ticked) !== JSON.stringify(through)) {
    problems.push(`stages done ${JSON.stringify(ticked)}, the ${j.scope} path to ${j.lastStage} is ${JSON.stringify(through)}`);
  }
  const outside = sourceStages().map((s) => s.slug).filter((s) => !expected.includes(s));
  for (const r of rows.filter((r) => r.event === "STAGE_STARTED")) {
    if (outside.includes(stageField(r))) problems.push(`${stageField(r)} was started, and ${j.scope} leaves it out`);
  }

  // One approval per stage, never a change asked for. A typed turn carries on
  // past the last stage's approval, so a stage after it may be waiting.
  const approvals = new Map<string, number>();
  for (const r of rows.filter((r) => r.event === "GATE_APPROVED")) approvals.set(stageField(r), (approvals.get(stageField(r)) ?? 0) + 1);
  for (const [stage, n] of approvals) if (n > 1) problems.push(`${stage} was approved ${n} times`);
  for (const r of rows.filter((r) => r.event === "STAGE_AWAITING_APPROVAL")) {
    if (!approvals.has(stageField(r)) && through.includes(stageField(r))) problems.push(`${stageField(r)} waited for approval and was never approved`);
  }
  const change = j.changeRequest;
  for (const event of ["GATE_REJECTED", "STAGE_REVISING"]) {
    const at = rows.filter((r) => r.event === event);
    if (!change && at.length > 0) problems.push(`${event} recorded ${at.length} times; the person never asked for changes`);
    if (change && (at.length !== 1 || stageField(at[0]) !== change.stage)) {
      problems.push(`${event} recorded ${at.length} times; the person asked for one change, at ${change.stage}`);
    }
  }
  const rejected = change && rows.find((r) => r.event === "GATE_REJECTED" && stageField(r) === change.stage);
  if (change && rejected && !(auditBlockField(rejected.block, "Feedback") ?? "").includes(change.words)) {
    problems.push(`the change the person asked for at ${change.stage} is not on the record in their words`);
  }

  // The plan: asked once and approved once where the scope asks, never otherwise.
  const plan = declared.planApproval && live.includes("code-generation") ? 1 : 0;
  if (run.planAsked !== plan) problems.push(`the plan question reached the person ${run.planAsked} times, ${j.scope} asks it ${plan} times`);
  if (count("PLAN_APPROVAL_RECORDED") !== plan) {
    problems.push(`PLAN_APPROVAL_RECORDED ${count("PLAN_APPROVAL_RECORDED")} times, ${j.scope} asks for the plan ${plan} times`);
  }
  problems.push(...filesBeforePlanProblems(j.proj, run));

  // Summary confirmation and learnings, as the scope declares them.
  const summaries = count("SUMMARY_CONFIRMATION_RECORDED");
  const summarised = sourceStages().some((s) => s.summaryConfirmation && live.includes(s.slug));
  if (!declared.summaryConfirmation && summaries > 0) problems.push(`a summary was confirmed ${summaries} times; ${j.scope} turns summary confirmation off`);
  if (declared.summaryConfirmation && summarised && summaries === 0) problems.push(`no summary was confirmed; ${j.scope} turns summary confirmation on`);
  // The learnings question comes only after a correction: at most at
  // the stage where the person asked for their one change.
  const learnings = rows.filter((r) => r.event === "DECISION_RECORDED" && isLearningsNoteDecision(r.block));
  if (!declared.learnings && learnings.length > 0) problems.push(`the learnings question was raised ${learnings.length} times; ${j.scope} turns learnings off`);
  const uncorrected = learnings.map(stageField).filter((s) => s !== j.changeRequest?.stage);
  if (declared.learnings && uncorrected.length > 0) {
    problems.push(`the learnings question was raised at ${uncorrected.join(", ")}, where the person corrected nothing`);
  }

  // The person answered one question in their own words, where the stage asked
  // one: a stage may find the request clear and ask none. That every answer is
  // backed by their own turn is the drive's own check (person-turns.ts). Their
  // words are on the record as given: the reply a question box carried back
  // (QUESTION_REPLIED), or the Person Reply beside the answer the agent logged.
  const own = j.ownWords;
  const asked = own !== undefined && rows.some((r) => r.event === "DECISION_RECORDED" && stageField(r) === own.stage &&
    plainChoice(decisionOptions(r)) === undefined);
  if (own && asked && !run.ownWordsUsed) problems.push(`no question at ${own.stage} took the person's own words`);
  const kept = own !== undefined && rows.some((r) =>
    [r.event === "QUESTION_REPLIED" ? auditBlockField(r.block, "Reply") : null, auditBlockField(r.block, "Person Reply")]
      .some((words) => words !== null && norm(words).includes(norm(own.words))));
  if (own && run.ownWordsUsed && !kept) problems.push(`the person's own words at ${own.stage} are not on the record`);
  return problems;
}

/**
 * Nothing of the person's changes before they pick a plan. Their pick starts
 * the work: `intent create`, the agent's step after `next --scope` took their
 * reply, writes WORKFLOW_STARTED, whose Source Baseline keeps the engine's
 * listing of their files at that moment. That listing is compared with the one
 * taken before their first line; with no pick in the journey, the files as
 * they are now count. Which changed files are theirs is the engine's own
 * reader, as Plan Approval reads it: AI-DLC's record, its install, the root
 * files it shares (whole) and the host's own folder are not.
 */
export function filesBeforePlanProblems(proj: string, run: Pick<GoldenRun, "files" | "start">): string[] {
  if (run.files === null) return ["the journey could not list the person's files before its first line, so it cannot tell whether they changed before a plan was picked"];
  const rows = auditRows(proj);
  // A plan picked before the journey began (a seeded leg) leaves nothing to check.
  if (rows.slice(0, run.start).some((r) => r.event === "WORKFLOW_STARTED")) return [];
  const started = rows.slice(run.start).find((r) => r.event === "WORKFLOW_STARTED");
  const baseline = started && auditBlockField(started.block, "Source Baseline");
  // The work's creation keeps the one listing under every stage it names, code-generation always among them.
  const after = started ? (baseline ? readBaselineSourceSnapshot(proj, "code-generation", baseline) : null) : sourceListing(proj);
  if (after === null) {
    return [started
      ? `the record keeps no list of the person's files from when their pick started the work (Source Baseline ${baseline || "missing"}), so the journey cannot tell whether they changed before it`
      : "the journey could not list the person's files at its end, so it cannot tell whether they changed with no plan picked"];
  }
  const changed = sourceChangedOutsideAidlc(proj, run.files, after);
  if (changed.length === 0) return [];
  return [`the person's files changed ${started ? "before their pick started the work" : "and no plan was picked"}: ${changed.join(", ")}`];
}

/** Keep a journey's report beside its logs (the nightly keeps that folder) and print its one line. */
export function writeGoldenReport(name: string, report: { problems: readonly string[] } & Record<string, unknown>): void {
  const line = `${name} golden journey: ${report.problems.length ? "FAIL" : "PASS"}`;
  const dir = process.env.AIDLC_TEST_LOG_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `golden-journey-${name}.json`), `${JSON.stringify({ line, ...report }, null, 2)}\n`);
  }
  console.log(line);
}

/** The project's own test files, outside the AI-DLC tree and its records. */
export function projectTestFiles(proj: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "aidlc" || entry.name === "aidlc-docs") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) out.push(`./${relative(proj, path).replaceAll("\\", "/")}`);
    }
  };
  if (existsSync(proj)) walk(proj);
  return out.sort();
}

/** Run the project's own tests with bun, the way the person would check the build. */
export function runProjectTests(proj: string): { files: string[]; status: number | null; output: string } {
  const files = projectTestFiles(proj);
  if (files.length === 0) return { files, status: null, output: "no test files outside the AI-DLC tree" };
  const res = spawnSync(process.execPath, ["test", ...files], { cwd: proj, encoding: "utf8", timeout: 300_000 });
  return { files, status: res.status, output: clip(`${res.stdout ?? ""}${res.stderr ?? ""}`, 2000) };
}
