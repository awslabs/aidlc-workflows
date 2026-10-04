// person-turns.ts - every decision recorded as the person's came from a turn
// the test driver sent as that person.
//
// Under the fixture profile the engine does not refuse an approval or an
// answer that no human turn backs, and the agent can append HUMAN_TURN rows
// itself, so neither proves a person acted. The driver knows what it sent: it
// records an audit cursor each time it sends a turn (the opening prompt, a
// menu answer, a typed reply). Every gate resolution, question answer and
// project-type change written during the drive must then have a driver turn
// after its gate or question opened and before the row itself. A live run on
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

type AuditReader = Pick<typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts"), "auditBlockField" | "readAuditShardEvents">;
let reader: AuditReader | undefined;
// The engine's own audit reader, loaded on first use: runner fixtures that load
// the drivers without a generated tree never reach it.
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

/**
 * What a row opens or decides, and for which item. `reply` decisions are the
 * person's approvals and answers: only a reply backs them, never a turn that
 * was only a command (it starts with "/"), as the human-turn hook marks it. A
 * command still backs what it asks for: a stage reopened by a jump, a changed
 * project type.
 */
function role(row: AuditShardEvent): { item: string; opens: boolean; decides: boolean; reply: boolean } | undefined {
  // A question is also told apart by its checkpoint (plan approval, summary confirmation, ...).
  const item = (kind: string) =>
    [kind, ...["Stage", "Unit", "Workflow", ...(kind === "answer" ? ["Checkpoint"] : [])]
      .map((field) => auditBlockField(row.block, field) ?? "")].join("\0");
  switch (row.event) {
    case "STAGE_AWAITING_APPROVAL":
      return { item: item("gate"), opens: true, decides: false, reply: false };
    case "GATE_APPROVED":
      return { item: item("gate"), opens: false, decides: true, reply: true };
    case "GATE_REJECTED":
      return { item: item("gate"), opens: false, decides: true, reply: false };
    case "DECISION_RECORDED":
      return { item: item("answer"), opens: true, decides: false, reply: false };
    case "QUESTION_ANSWERED":
      return { item: item("answer"), opens: false, decides: true, reply: true };
    // The project type is set when the work is created and on each change.
    case "WORKSPACE_INITIALISED":
      return { item: "workspace", opens: true, decides: false, reply: false };
    case "WORKSPACE_RECLASSIFIED":
      return { item: "workspace", opens: true, decides: true, reply: false };
    default:
      return undefined;
  }
}

const isCommand = (words: string) => words.trim().startsWith("/");

/**
 * Decisions written after `start` that no driver turn backs. Each decision
 * takes the latest question of its item still open (one gate per item; several
 * questions can be open at once), or else follows the item's previous
 * decision, so a second answer to one question needs a newer turn. A turn
 * backs it when it was sent after that point (or at the drive's start, when the
 * point is earlier than the drive) and before the row.
 */
export function unbackedDecisions(projectDir: string, start: AuditCursor, turns: readonly PersonTurn[]): string[] {
  const problems: string[] = [];
  for (const [key, events] of readTrail(projectDir)) {
    const first = start.get(key) ?? 0;
    const open = new Map<string, number[]>();
    const decided = new Map<string, number>();
    for (let index = 0; index < events.length; index++) {
      const row = events[index];
      const part = role(row);
      if (!part) continue;
      if (part.decides) {
        const since = open.get(part.item)?.pop() ?? decided.get(part.item) ?? -1;
        decided.set(part.item, index);
        const after = Math.max(since + 1, first);
        const backed = index < first || turns.some((turn) => {
          const at = turn.cursor.get(key) ?? 0;
          return at >= after && at <= index && !(part.reply && isCommand(turn.words));
        });
        if (!backed) problems.push(describe(row, key, turns));
      }
      if (part.opens) {
        const questions = open.get(part.item) ?? [];
        open.set(part.item, row.event === "DECISION_RECORDED" ? [...questions, index] : [index]);
      }
    }
  }
  return problems;
}

function describe(row: AuditShardEvent, key: string, turns: readonly PersonTurn[]): string {
  const stage = auditBlockField(row.block, "Stage");
  const unit = auditBlockField(row.block, "Unit");
  const words = ["Person Reply", "User Input", "Details", "Feedback", "New Project Type"]
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

  /** Call as the driver sends a turn, before the agent can act on it. */
  sent(words: string): void {
    this.turns.push({ words, cursor: auditCursor(this.projectDir) });
  }

  unbacked(): string[] {
    return unbackedDecisions(this.projectDir, this.start, this.turns);
  }
}

// The TUI driver runs once per command (start, send, kill), so it keeps its
// ledger in files: one per project, out of the agent's working tree, and one
// pointer per session naming its project and what was typed but not yet
// submitted. They live in a directory only this account can use.
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
}

function appendLine(projectDir: string, kind: LedgerLine["kind"], words: string): void {
  const line: LedgerLine = { kind, words, cursor: [...auditCursor(projectDir)] };
  appendFileSync(ledgerFile(projectDir), `${JSON.stringify(line)}\n`);
}

interface SessionPointer {
  projectDir: string;
  typed?: string;
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
  replaceFile(sessionPointer(session), JSON.stringify({ projectDir } satisfies SessionPointer));
  appendLine(projectDir, "start", "");
}

/** The driver typed `text` into a TUI session without submitting it. */
export function typedIntoPersonTurnSession(session: string, text: string): void {
  const pointer = readPointer(session);
  if (pointer) replaceFile(sessionPointer(session), JSON.stringify({ ...pointer, typed: `${pointer.typed ?? ""}${text}` }));
}

/** The driver submitted what it typed, then `text`; a session with no project is not tracked. */
export function submittedToPersonTurnSession(session: string, text: string): void {
  const pointer = readPointer(session);
  if (!pointer || !existsSync(ledgerFile(pointer.projectDir))) return;
  appendLine(pointer.projectDir, "turn", `${pointer.typed ?? ""}${text}`);
  if (pointer.typed) replaceFile(sessionPointer(session), JSON.stringify({ projectDir: pointer.projectDir }));
}

/**
 * The decisions no turn backs across every TUI session the project had, from
 * the first session's start; empty when no session recorded one. Removes the
 * project's ledger and session pointers.
 */
export function unbackedTuiDecisions(projectDir: string): string[] {
  const file = ledgerFile(projectDir);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerLine);
  const start = lines.find((line) => line.kind === "start");
  const turns = lines.filter((line) => line.kind === "turn")
    .map((line) => ({ words: line.words, cursor: new Map(line.cursor) }));
  const problems = start && existsSync(projectDir) ? unbackedDecisions(projectDir, new Map(start.cursor), turns) : [];
  rmSync(file, { force: true });
  const folder = privateDirectory();
  for (const name of readdirSync(folder).filter((entry) => entry.startsWith("session-") && entry.endsWith(".json"))) {
    try {
      const pointer = JSON.parse(readFileSync(join(folder, name), "utf-8")) as { projectDir?: string };
      if (pointer.projectDir === projectDir) rmSync(join(folder, name), { force: true });
    } catch { /* another driver is writing it */ }
  }
  return problems;
}
