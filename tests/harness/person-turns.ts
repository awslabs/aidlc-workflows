// person-turns.ts - every decision recorded as the person's came from a turn
// the test driver sent as that person.
//
// Under the fixture profile the engine does not refuse an approval or an
// answer that no human turn backs, and the agent can append HUMAN_TURN rows
// itself, so neither proves a person acted. The driver knows what it sent: it
// records an audit cursor each time it sends a turn (the opening prompt, a
// menu answer, a typed reply). Every gate resolution, question answer (and
// checkpoint receipt that closes a question) and project-type change written
// during the drive must then have a driver turn after its gate or question
// opened and before the row itself. A live run on
// Kiro CLI recorded an approval when the person had typed only a slash command
// at the open gate; this catches that kind.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AuditShardEvent } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

type AuditReader = Pick<
  typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts"),
  | "auditBlockField"
  | "readAuditShardEvents"
  | "nextOpenDecision"
  | "decisionAnsweredBy"
  | "DECISION_CLOSING_EVENTS"
  | "findStageBySlug"
  | "ANSWER_SOURCE_ON_INSTRUCTION"
>;
let reader: AuditReader | undefined;
// The engine's own audit reader and question pairing, loaded on first use:
// runner fixtures that load the drivers without a generated tree never reach it.
function audit(): AuditReader {
  reader ??= require("../../dist/claude/.claude/tools/aidlc-lib.ts") as AuditReader;
  return reader;
}
const auditBlockField = (block: string, field: string) => audit().auditBlockField(block, field);

/** Events in one audit shard, keyed by space, intent and shard name. */
type AuditTrail = Map<string, AuditShardEvent[]>;

/** How many events each shard held when the driver sent a turn. */
export type AuditCursor = ReadonlyMap<string, number>;

export interface PersonTurn {
  words: string;
  cursor: AuditCursor;
  /**
   * How many answers a menu submission can back: the picks it carried
   * (several on a form with more than one question, none for a pick on one of
   * its tabs, which the form's Submit counts). Unset for a typed reply, which
   * answers every question open when it arrived, as the engine reads a reply.
   */
  selections?: number;
}

function readTrail(projectDir: string): AuditTrail {
  const trail: AuditTrail = new Map();
  const spaces = join(projectDir, "aidlc", "spaces");
  if (!existsSync(spaces)) return trail;
  for (const space of readdirSync(spaces)) {
    const intents = join(spaces, space, "intents");
    if (!existsSync(intents)) continue;
    for (const entry of readdirSync(intents, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      for (const event of audit().readAuditShardEvents(projectDir, entry.name, space)) {
        const key = `${space}/${entry.name}/${basename(event.shard)}`;
        const events = trail.get(key) ?? [];
        events.push(event);
        trail.set(key, events);
      }
    }
  }
  return trail;
}

/** The audit position of a turn sent now. */
export function auditCursor(projectDir: string): AuditCursor {
  return new Map([...readTrail(projectDir)].map(([key, events]) => [key, events.length]));
}

// A turn is only a command as the human-turn hook reads it: a slash command
// with something the engine reads in it. Words alone after the AIDLC entry
// ("/aidlc approve the code plan") are a reply, as is any other slash text.
let entryReader: {
  aidlcEntryWords: (prompt: string) => string | null;
  nextArgsAreOnlyWords: (args: string[]) => boolean;
  splitKiroCommandArgs: (raw: string) => string[];
} | undefined;
function isCommand(words: string): boolean {
  const text = words.trim();
  if (!/^[/$]aidlc(?:[-\s]|$)/i.test(text)) return false;
  entryReader ??= {
    ...(require("../../dist/claude/.claude/tools/aidlc-reply-reader.ts") as { aidlcEntryWords: (prompt: string) => string | null }),
    ...(require("../../dist/claude/.claude/tools/aidlc-orchestrate.ts") as { nextArgsAreOnlyWords: (args: string[]) => boolean }),
    splitKiroCommandArgs: (require("../../dist/claude/.claude/tools/aidlc-lib.ts") as { splitKiroCommandArgs: (raw: string) => string[] }).splitKiroCommandArgs,
  };
  const after = entryReader.aidlcEntryWords(text);
  return after === null || after.length === 0 || !entryReader.nextArgsAreOnlyWords(entryReader.splitKiroCommandArgs(after));
}

/** A gate is one per stage, Unit and workflow. */
const gateItem = (row: AuditShardEvent) =>
  ["Stage", "Unit", "Workflow"].map((field) => auditBlockField(row.block, field) ?? "").join("\0");

/**
 * Decisions written after `start` that no driver turn backs. What a decision
 * answers is found the way the engine pairs them (nextOpenDecision): a
 * question's answer, or a checkpoint's own gate row, closes the stage's open
 * DECISION_RECORDED, and a later question supersedes an earlier one. A stage
 * gate follows its STAGE_AWAITING_APPROVAL; a project-type change follows the
 * work's creation or the last change. With nothing open, an answer follows
 * what the stage's previous answer followed, and any other decision follows
 * the previous one of its stage or gate. A turn backs it when it was sent after
 * that point (or at the drive's start, when the point is earlier than the
 * drive) and before the row. A menu submission backs as many answers as it
 * carried picks; a typed reply backs one answer for each question open when it
 * arrived (at least one), so a second answer to one question needs a newer
 * turn, and so does a question asked after the reply. Approvals and
 * answers need a reply: a turn that was only a command (as the human-turn hook
 * reads it) does not count. A command still backs what it
 * can ask for: a stage reopened by a jump, a changed project type.
 *
 * A choice the person left to the agent (its row says Answer Source "chosen
 * by the agent as the person asked") is backed by a turn anywhere in the drive
 * that holds the words its Instruction quotes; the words, not the field, are
 * what back it.
 *
 * Which rows are the engine's own comes from the trail and the stage graph,
 * never from a field a row carries. An approval is the engine's when the
 * person's grant of autonomous Construction is in force (the latest
 * WORKFLOW_STARTED or AUTONOMY_MODE_SET is AUTONOMY_MODE_SET to autonomous)
 * and the stage is a Construction stage; a walking-skeleton checkpoint still
 * asks the person. A Construction stage gate is also the engine's once every
 * Unit of the work's compiled DAG has its checkpoint approved (and not since
 * rejected) and one of them covers the stage in its Gate Stages: the engine
 * settles the stage gate from those approvals (isAutonomousConstructionGate),
 * and each checkpoint approval is itself checked as the person's. That grant is itself the person's decision, backed by a
 * turn after the last gate resolution, as the engine requires. The rows an
 * approval backfills before it (a Recovered rejection and re-opening) leave
 * the gate's first opening in place, and the rejection is checked as usual.
 */
export function unbackedDecisions(projectDir: string, start: AuditCursor, turns: readonly PersonTurn[]): string[] {
  const { decisionAnsweredBy, nextOpenDecision, DECISION_CLOSING_EVENTS } = audit();
  const problems: string[] = [];
  // How many answers each turn has backed so far.
  const used = turns.map(() => 0);
  for (const [key, events] of readTrail(projectDir)) {
    const first = start.get(key) ?? 0;
    const open = new Map<string, { block: string; index: number }>();
    const answered = new Map<string, number>();
    const gates = new Map<string, number>();
    const gated = new Map<string, number>();
    let workspace = -1;
    let autonomous = false;
    let resolved = -1;
    // The engine settles a Construction stage gate once every Unit of the
    // work's compiled DAG has its checkpoint approved and one of them covers the
    // stage (isAutonomousConstructionGate): per Unit, the stages its standing
    // checkpoint approval covers. A rejection takes that Unit's approval back.
    const units = dagUnits(projectDir, key);
    const approvedUnits = new Map<string, Set<string>>();
    const covers = (name: string) => {
      const needed = units.length > 0 ? units : [...approvedUnits.keys()];
      return needed.length > 0 && needed.every((unit) => approvedUnits.has(unit)) &&
        needed.some((unit) => approvedUnits.get(unit)!.has(name));
    };
    for (let index = 0; index < events.length; index++) {
      const row = events[index];
      const stage = auditBlockField(row.block, "Stage") ?? "";
      const pending = open.get(stage);
      const closes = DECISION_CLOSING_EVENTS.has(row.event);
      const gate = row.event === "GATE_APPROVED" || row.event === "GATE_REJECTED";
      // The engine writes Recovered only on the rows an approval backfills.
      const backfilled = auditBlockField(row.block, "Recovered") === "true" &&
        (row.event === "GATE_REJECTED" || row.event === "STAGE_AWAITING_APPROVAL");
      const construction = audit().findStageBySlug(stage)?.phase === "construction";
      const checkpoint = auditBlockField(row.block, "Checkpoint");
      const engineApproved = row.event === "GATE_APPROVED" && construction && (
        (autonomous && checkpoint !== "walking-skeleton") || (checkpoint === null && covers(stage))
      );
      let since: number | undefined;
      let reply = true;
      let answer = false;
      let instruction: string | undefined;
      if (closes) {
        since = pending?.index ?? answered.get(stage) ?? -1;
        answered.set(stage, since);
        answer = true;
        // A choice the person left to the agent, which they can say before the
        // question comes: any turn of the drive that holds the words the row
        // quotes backs it, a command included, and backs every answer it covers.
        if (auditBlockField(row.block, "Answer Source") === audit().ANSWER_SOURCE_ON_INSTRUCTION) {
          instruction = plainWords(auditBlockField(row.block, "Instruction") ?? "");
          since = -1;
          reply = false;
          answer = false;
        }
      } else if (gate && !engineApproved) {
        reply = row.event === "GATE_APPROVED";
        if (pending && decisionAnsweredBy(pending.block, row.event, row.block)) {
          since = pending.index;
          answered.set(stage, since);
          answer = true;
        } else {
          since = gates.get(gateItem(row)) ?? gated.get(gateItem(row)) ?? -1;
          if (!backfilled) {
            gates.delete(gateItem(row));
            gated.set(gateItem(row), index);
          }
        }
      } else if (row.event === "WORKSPACE_RECLASSIFIED") {
        since = workspace;
        reply = false;
      } else if (row.event === "AUTONOMY_MODE_SET" && auditBlockField(row.block, "Mode") === "autonomous") {
        since = resolved;
        reply = false;
      }
      if (since !== undefined && index >= first) {
        const after = Math.max(since + 1, first);
        const needsReply = reply;
        const quoted = instruction;
        const backing = quoted === "" ? -1 : turns.findIndex((turn, which) => {
          const at = turn.cursor.get(key) ?? 0;
          return at >= after && at <= index && !(needsReply && isCommand(turn.words)) &&
            (!answer || used[which] < (turn.selections ?? openQuestions(events, at))) &&
            (quoted === undefined || plainWords(turn.words).includes(quoted));
        });
        if (backing === -1) problems.push(describe(row, key, turns));
        else if (answer) used[backing]++;
      }
      if (row.event === "DECISION_RECORDED" || closes || gate) {
        const next = nextOpenDecision(pending?.block ?? null, row.event, row.block);
        if (next === null) open.delete(stage);
        else if (row.event === "DECISION_RECORDED") open.set(stage, { block: row.block, index });
      }
      if (row.event === "STAGE_AWAITING_APPROVAL" && !backfilled) gates.set(gateItem(row), index);
      if (row.event === "WORKSPACE_INITIALISED" || row.event === "WORKSPACE_RECLASSIFIED") workspace = index;
      if (row.event === "WORKFLOW_STARTED") {
        autonomous = false;
        approvedUnits.clear();
      }
      const unit = auditBlockField(row.block, "Unit");
      if (gate && checkpoint !== null && unit !== null) {
        if (row.event === "GATE_REJECTED") approvedUnits.delete(unit);
        else {
          const stages = (auditBlockField(row.block, "Gate Stages") ?? "").split(",").map((part) => part.trim());
          approvedUnits.set(unit, new Set(stages.filter((name) => name.length > 0)));
        }
      }
      if (row.event === "AUTONOMY_MODE_SET") autonomous = auditBlockField(row.block, "Mode") === "autonomous";
      if (gate) resolved = index;
    }
  }
  return problems;
}

// The questions open when a turn arrived `at` this point of a shard: each one
// asked counts until an answer closes one (at least one, for a reply to a gate
// or to a question the trail does not show).
function openQuestions(events: readonly AuditShardEvent[], at: number): number {
  const { DECISION_CLOSING_EVENTS } = audit();
  let open = 0;
  for (const row of events.slice(0, at)) {
    if (row.event === "DECISION_RECORDED") open++;
    else if (DECISION_CLOSING_EVENTS.has(row.event)) open = Math.max(0, open - 1);
  }
  return Math.max(open, 1);
}

// Words compared as the person typed them, whatever the spacing or case.
function plainWords(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The Units of the work's compiled DAG (`<record>/runtime-graph.json`), when it has one. */
function dagUnits(projectDir: string, key: string): string[] {
  const [space, intent] = key.split("/");
  try {
    const graph = JSON.parse(readFileSync(join(projectDir, "aidlc", "spaces", space, "intents", intent, "runtime-graph.json"), "utf-8")) as {
      bolt_dag?: { units?: { name?: string }[] };
    };
    return (graph.bolt_dag?.units ?? []).map((unit) => unit.name).filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

function describe(row: AuditShardEvent, key: string, turns: readonly PersonTurn[]): string {
  const stage = auditBlockField(row.block, "Stage");
  const unit = auditBlockField(row.block, "Unit");
  const words = ["Person Reply", "User Input", "Details", "Feedback", "New Project Type", "Mode"]
    .map((field) => auditBlockField(row.block, field)).find((value) => value !== null) ?? null;
  const sent = turns.slice(-8).map((turn) => JSON.stringify(turn.words.slice(0, 60))).join(", ");
  return [
    `${row.event}${stage ? ` ${stage}` : ""}${unit ? ` (Unit ${unit})` : ""} at ${row.timestamp} in ${key}`,
    words === null ? "" : `, recorded words ${JSON.stringify(words)}`,
    `: no reply from the person after it opened; the driver sent ${turns.length} turn(s)${sent ? `: ${sent}` : ""}`,
  ].join("");
}

/** The failure a drive raises when `problems` is not empty. */
export function unbackedFailure(drive: string, problems: readonly string[]): Error {
  return new Error(
    `${drive} recorded ${problems.length} decision(s) as the person's that no turn from them backs:\n` +
      problems.map((line) => `  ${line}`).join("\n"),
  );
}

/** A driver's record of what the person sent, checked at the end of a drive. */
export class PersonTurnLedger {
  readonly turns: PersonTurn[] = [];
  readonly start: AuditCursor;

  constructor(readonly projectDir: string) {
    this.start = auditCursor(projectDir);
  }

  /** Call as the driver sends a turn, before the agent can act on it; a menu answer passes its picks. */
  sent(words: string, selections?: number): void {
    this.turns.push({ words, cursor: auditCursor(this.projectDir), ...(selections === undefined ? {} : { selections }) });
  }

  unbacked(): string[] {
    return unbackedDecisions(this.projectDir, this.start, this.turns);
  }
}

// The TUI driver runs once per command (start, send, kill), so it keeps its
// ledger in files: one per project, out of the agent's working tree, and one
// pointer per session naming its project, what was typed but not yet
// submitted, and how many turns the driver sent. They live in a directory only
// this account can use. A ledger that is gone, or holds fewer turns than the
// driver sent, fails the drive: the run can no longer show who decided.
function privateDirectory(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const dir = process.env.AIDLC_PERSON_TURNS_DIR ??
    join(tmpdir(), uid === undefined ? "aidlc-tui-person-turns" : `aidlc-tui-person-turns-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) {
    throw new Error(`${dir} is not a private folder of this account: remove it and run the test again`);
  }
  return dir;
}
const fileName = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const sessionPointer = (session: string) => join(privateDirectory(), `session-${fileName(session)}.json`);
const ledgerFile = (projectDir: string) => join(privateDirectory(), `ledger-${fileName(projectDir)}.jsonl`);

/** Replace a file in the private folder through a new name. */
function replaceFile(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { flag: "w", mode: 0o600 });
  renameSync(temp, path);
}

interface LedgerLine {
  kind: "start" | "turn";
  words: string;
  cursor: [string, number][];
  selections?: number;
}

function appendLine(projectDir: string, kind: LedgerLine["kind"], words: string, selections?: number): void {
  const line: LedgerLine = { kind, words, cursor: [...auditCursor(projectDir)], ...(selections === undefined ? {} : { selections }) };
  appendFileSync(ledgerFile(projectDir), `${JSON.stringify(line)}\n`);
}

interface SessionPointer {
  projectDir: string;
  typed?: string;
  sent?: number;
  picks?: { selections: number; words: string };
}

function readPointer(session: string): SessionPointer | undefined {
  try {
    return JSON.parse(readFileSync(sessionPointer(session), "utf-8")) as SessionPointer;
  } catch {
    return undefined;
  }
}

/** A TUI session started in `projectDir`: later turns sent to it are the person's. */
export function startPersonTurnSession(session: string, projectDir: string): void {
  // A restarted session keeps the count of what it sent before.
  const before = readPointer(session);
  const sent = before?.projectDir === projectDir ? before.sent ?? 0 : 0;
  replaceFile(sessionPointer(session), JSON.stringify({ projectDir, sent } satisfies SessionPointer));
  appendLine(projectDir, "start", "");
}

/** The driver typed `text` into a TUI session without submitting it. */
export function typedIntoPersonTurnSession(session: string, text: string): void {
  const pointer = readPointer(session);
  if (pointer) replaceFile(sessionPointer(session), JSON.stringify({ ...pointer, typed: `${pointer.typed ?? ""}${text}` }));
}

/**
 * The driver's next submit to the session carries `selections` menu picks,
 * with `words` naming them: a form's Submit carries every pick on it, and a
 * pick on one of its tabs carries none.
 */
export function nextPersonTurnCarriesPicks(session: string, selections: number, words = ""): void {
  const pointer = readPointer(session);
  if (pointer) replaceFile(sessionPointer(session), JSON.stringify({ ...pointer, picks: { selections, words } }));
}

/** The driver submitted what it typed, then `text`; a session with no project is not tracked. */
export function submittedToPersonTurnSession(session: string, text: string): void {
  const pointer = readPointer(session);
  if (!pointer) return;
  const picks = pointer.picks;
  appendLine(pointer.projectDir, "turn", picks?.words || `${pointer.typed ?? ""}${text}`, picks?.selections);
  const sent = (pointer.sent ?? 0) + 1;
  replaceFile(sessionPointer(session), JSON.stringify({ projectDir: pointer.projectDir, sent } satisfies SessionPointer));
}

/**
 * The decisions no turn backs across every TUI session the project had, from
 * the first session's start; empty when no session started. Throws when the
 * ledger is gone, unreadable, or short of what the driver sent. Removes the
 * project's ledger and session pointers.
 */
export function unbackedTuiDecisions(projectDir: string): string[] {
  const folder = privateDirectory();
  let sessions = 0;
  let sent = 0;
  for (const name of readdirSync(folder).filter((entry) => entry.startsWith("session-") && entry.endsWith(".json"))) {
    try {
      const pointer = JSON.parse(readFileSync(join(folder, name), "utf-8")) as Partial<SessionPointer>;
      if (pointer.projectDir !== projectDir) continue;
      sessions++;
      sent += typeof pointer.sent === "number" ? pointer.sent : 0;
      rmSync(join(folder, name), { force: true });
    } catch { /* another driver is writing it */ }
  }
  const file = ledgerFile(projectDir);
  const record = `The TUI drive's record of what the person sent to ${projectDir}`;
  if (!existsSync(file)) {
    if (sessions === 0) return [];
    throw new Error(`${record} is gone: the driver sent ${sent} turn(s) to ${sessions} session(s), so the run cannot show who made its decisions.`);
  }
  const text = readFileSync(file, "utf-8");
  rmSync(file, { force: true });
  let lines: LedgerLine[];
  try {
    lines = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerLine);
  } catch {
    throw new Error(`${record} cannot be read, so the run cannot show who made its decisions.`);
  }
  const start = lines.find((line) => line.kind === "start");
  const turns = lines.filter((line) => line.kind === "turn")
    .map((line) => ({ words: line.words, cursor: new Map(line.cursor), selections: line.selections }));
  if (!start || turns.length < sent) {
    throw new Error(
      `${record} holds ${turns.length} of the ${sent} turn(s) the driver sent${start ? "" : " and no session start"}, ` +
        "so the run cannot show who made its decisions.",
    );
  }
  return existsSync(projectDir) ? unbackedDecisions(projectDir, new Map(start.cursor), turns) : [];
}
