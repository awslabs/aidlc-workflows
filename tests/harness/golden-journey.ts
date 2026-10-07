// golden-journey.ts - the person in a live golden journey.
//
// A golden journey drives one real model through a scope family's real path,
// the way a person drives it: they type their request, answer each question
// once, approve each stage once, approve the plan once where the scope asks
// for it, and close the session once the journey's last stage is approved.
//
// The person never reads the agent's prose. What they pick in a menu comes from
// the menu itself; what they type when a turn ends comes from what the engine
// recorded as waiting for them: a question it logged and nobody answered, a
// stage waiting for approval, or the engine's last ask. When a turn ends with
// nothing waiting for them, the journey is stuck. When the same thing reaches
// them twice, they were asked twice. Both are failures, named in `problems`.
//
// The test drives with driveAidlc (sdk-drive.ts), which already fails a drive
// whose agent records a decision the person did not make (person-turns.ts).

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { parseDirectiveOutput } from "./directive-output.ts";
import { declaredScope, expectedStages, sourceStages } from "./scope-run.ts";
import {
  type AnswerSpec,
  type AskUserQuestionItem,
  type CapturedToolResult,
  type DriveOptions,
  type DriveResult,
  readStateField,
  readStateFile,
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

/** The plain choice a person makes in each kind of menu, first match wins. */
const PLAIN_CHOICES: RegExp[] = [
  /^Approve Plans?\b/,
  /^Guide me\b/i,
  /^Looks correct\b/i,
  /^Nothing to add\b/i,
  /^Approve\b/,
];

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
}

export interface GoldenRun {
  drive: DriveResult;
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
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
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

/** The last question the engine logged that no answer has closed yet. */
function openDecision(proj: string): Row | undefined {
  const rows = auditRows(proj);
  for (let i = rows.length - 1; i >= 0; i--) {
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

/** The engine's last step handed to the agent, read from the agent's own Bash results. */
function lastEngineStep(results: readonly CapturedToolResult[]): Record<string, unknown> | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    const t = results[i];
    const command = typeof t.input.command === "string" ? t.input.command : "";
    if (t.toolName !== "Bash" || !command.includes("engine orchestrate")) continue;
    try {
      return parseDirectiveOutput(t.resultText).directive as unknown as Record<string, unknown>;
    } catch {
      // Not a directive (a refusal or a print): look further back.
    }
  }
  return undefined;
}

/** The plain choice at an approval, a mode, a summary or a learnings question. */
function plainChoice(options: string[]): string | undefined {
  for (const choice of PLAIN_CHOICES) {
    const hit = options.find((o) => choice.test(o));
    if (hit) return hit;
  }
  return undefined;
}

function recommended(options: string[]): string | undefined {
  return options.find((o) => /recommended/i.test(o));
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

  constructor(private readonly j: GoldenJourney) {
    this.start = auditRows(j.proj).length;
  }

  driveOptions(): DriveOptions {
    return {
      projectDir: this.j.proj,
      persistSession: true,
      captureStopHooks: true,
      answerScript: { kind: "pick", pick: (q) => this.pick(q) },
      nextMessage: (turn) => this.reply(turn.turn),
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
    return { drive, start: this.start, person: this.said, problems, planAsked: this.planAsked, ownWordsUsed: this.ownWordsUsed };
  }

  private stageNow(): string {
    return readStateField(readStateFile(this.j.proj) ?? "", "Current Stage") ?? "(no work yet)";
  }

  private reach(key: string, what: string): void {
    if (this.reached.has(key)) this.problems.push(`asked twice: ${what}`);
    this.reached.add(key);
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
    this.reach(`${stage} | ${norm(q.question)}`, `"${q.question}" at ${stage}`);
    if (labels.some((l) => /^Approve Plans?\b/.test(l))) this.planAsked++;
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
    const decision = openDecision(this.j.proj);
    if (decision) {
      const question = auditBlockField(decision.block, "Decision") ?? "";
      const at = stageField(decision) || stage;
      const options = (auditBlockField(decision.block, "Options") ?? "").split(",").map((o) => o.trim()).filter(Boolean);
      this.reach(`${at} | ${norm(question)}`, `"${question}" at ${at}`);
      if (options.some((o) => /^Approve Plans?\b/.test(o))) this.planAsked++;
      const words = plainChoice(options) ?? this.ownWords(at) ?? recommended(options) ?? options[0] ?? "Go with what you recommend";
      this.said.push(`typed ${JSON.stringify(words)} for "${clip(question, 120)}" at ${at}`);
      return words;
    }
    const waiting = stageAwaitingApproval(this.j.proj);
    if (waiting) {
      this.reach(`approval | ${waiting}`, `the ${waiting} approval`);
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
      this.reach(`ask | ${type} | ${stage}`, `the ${type} question at ${stage}`);
      if (type === "plan-approval") {
        this.planAsked++;
        this.said.push("typed \"Approve Plan\" for the plan");
        return "Approve Plan";
      }
      const offered = ((step.options as Array<{ label?: unknown }> | undefined) ?? []).map((o) => String(o.label ?? o));
      const words = plainChoice(offered) ?? recommended(offered) ?? offered[0] ?? "Go with what you recommend";
      this.said.push(`typed ${JSON.stringify(words)} for the ${type} question at ${stage}`);
      return words;
    }
    this.problems.push(`turn ${turn} ended at ${stage} with nothing asked of the person; the engine's last step was ${clip(JSON.stringify(step ?? null))}`);
    return undefined;
  }
}

/**
 * What the engine recorded against the scope's path, up to the journey's last
 * stage: the stages it ran, one approval each, the plan asked once where the
 * scope asks it, and its summary and learnings switches kept.
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

  // One approval per stage, never a change asked for.
  const approvals = new Map<string, number>();
  for (const r of rows.filter((r) => r.event === "GATE_APPROVED")) approvals.set(stageField(r), (approvals.get(stageField(r)) ?? 0) + 1);
  for (const [stage, n] of approvals) if (n > 1) problems.push(`${stage} was approved ${n} times`);
  for (const r of rows.filter((r) => r.event === "STAGE_AWAITING_APPROVAL")) {
    if (!approvals.has(stageField(r))) problems.push(`${stageField(r)} waited for approval and was never approved`);
  }
  for (const event of ["GATE_REJECTED", "STAGE_REVISING"]) {
    if (count(event) > 0) problems.push(`${event} recorded ${count(event)} times; the person never asked for changes`);
  }

  // The plan: asked once and approved once where the scope asks, never otherwise.
  const plan = declared.planApproval && live.includes("code-generation") ? 1 : 0;
  if (run.planAsked !== plan) problems.push(`the plan question reached the person ${run.planAsked} times, ${j.scope} asks it ${plan} times`);
  if (count("PLAN_APPROVAL_RECORDED") !== plan) {
    problems.push(`PLAN_APPROVAL_RECORDED ${count("PLAN_APPROVAL_RECORDED")} times, ${j.scope} asks for the plan ${plan} times`);
  }

  // Summary confirmation and learnings, as the scope declares them.
  const summaries = count("SUMMARY_CONFIRMATION_RECORDED");
  const summarised = sourceStages().some((s) => s.summaryConfirmation && live.includes(s.slug));
  if (!declared.summaryConfirmation && summaries > 0) problems.push(`a summary was confirmed ${summaries} times; ${j.scope} turns summary confirmation off`);
  if (declared.summaryConfirmation && summarised && summaries === 0) problems.push(`no summary was confirmed; ${j.scope} turns summary confirmation on`);
  const learnings = run.drive.toolResults.filter((t) => t.toolName === "Bash" && String(t.input.command ?? "").includes("engine learnings surface")).length;
  if (!declared.learnings && learnings > 0) problems.push(`the learnings question was raised ${learnings} times; ${j.scope} turns learnings off`);
  if (declared.learnings && learnings === 0) problems.push(`the learnings question was never raised; ${j.scope} turns learnings on`);

  // The person answered one question in their own words. That every answer is
  // backed by their own turn is the drive's own check (person-turns.ts). The
  // check that their words are kept as their answer is re-enabled with the fix
  // that keeps the person's own words on every answer: today a picker answer in
  // their own words can be recorded as the option it is closest to.
  if (j.ownWords && !run.ownWordsUsed) problems.push(`no question at ${j.ownWords.stage} took the person's own words`);
  return problems;
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
