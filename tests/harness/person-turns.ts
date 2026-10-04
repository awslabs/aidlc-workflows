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
// Kiro CLI recorded an approval the person never gave; this catches that kind.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AuditShardEvent,
  auditBlockField,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

/** Rows that record a decision as the person's. */
const DECISIONS = new Set(["GATE_APPROVED", "GATE_REJECTED", "QUESTION_ANSWERED", "WORKSPACE_RECLASSIFIED"]);

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
      for (const event of readAuditShardEvents(projectDir, entry.name, space)) {
        const key = `${space}/${entry.name}/${event.shard}`;
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

/** What opened the decision a row records, or undefined when it is not one. */
function opener(row: AuditShardEvent): ((candidate: AuditShardEvent) => boolean) | undefined {
  const stage = auditBlockField(row.block, "Stage");
  const unit = auditBlockField(row.block, "Unit");
  const sameItem = (candidate: AuditShardEvent) =>
    auditBlockField(candidate.block, "Stage") === stage && auditBlockField(candidate.block, "Unit") === unit;
  switch (row.event) {
    case "GATE_APPROVED":
    case "GATE_REJECTED":
      return (candidate) => candidate.event === "STAGE_AWAITING_APPROVAL" && sameItem(candidate);
    case "QUESTION_ANSWERED":
      return (candidate) => candidate.event === "DECISION_RECORDED" && sameItem(candidate);
    case "WORKSPACE_RECLASSIFIED":
      // The project type is set when the work is created and on each change.
      return (candidate) =>
        candidate.event === "WORKSPACE_INITIALISED" || candidate.event === "WORKSPACE_RECLASSIFIED";
    default:
      return undefined;
  }
}

/**
 * Decisions written after `start` that no driver turn backs: no turn was sent
 * after the gate or question opened (or after `start`, when it opened earlier
 * than the drive) and before the row.
 */
export function unbackedDecisions(projectDir: string, start: AuditCursor, turns: readonly PersonTurn[]): string[] {
  const problems: string[] = [];
  for (const [key, events] of readTrail(projectDir)) {
    const first = start.get(key) ?? 0;
    for (let index = first; index < events.length; index++) {
      const row = events[index];
      if (!DECISIONS.has(row.event)) continue;
      const opens = opener(row);
      if (!opens) continue;
      let opened = -1;
      for (let earlier = index - 1; earlier >= 0; earlier--) {
        if (opens(events[earlier])) { opened = earlier; break; }
      }
      // A turn counts once it came after what opened the decision: strictly
      // after an opening row inside the drive, or at the drive's start.
      const after = opened >= first ? opened + 1 : first;
      const backed = turns.some((turn) => {
        const at = turn.cursor.get(key) ?? 0;
        return at >= after && at <= index;
      });
      if (backed) continue;
      const stage = auditBlockField(row.block, "Stage");
      const unit = auditBlockField(row.block, "Unit");
      const words = auditBlockField(row.block, "Person Reply") ?? auditBlockField(row.block, "User Input");
      problems.push([
        `${row.event}${stage ? ` ${stage}` : ""}${unit ? ` (Unit ${unit})` : ""} at ${row.timestamp} in ${key}`,
        words === null ? "" : `, recorded words ${JSON.stringify(words)}`,
        `: no turn from the person after it opened; the driver sent ${turns.length} turn(s)`,
      ].join(""));
    }
  }
  return problems;
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
