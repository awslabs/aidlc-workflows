// The background-helper ledger: one session-scoped entry for each agent sent
// in the background, which the Stop hook reads so a turn can end while the
// agent works. aidlc-lib.ts re-exports it. Beside it, unrecordedFinishSince
// reads the completion hook's own traces of a finish it could not record.
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { withAuditLock, workspaceRoot, writeFileAtomic } from "./aidlc-locks.ts";
import { attemptEventDefinitelyBefore, auditBlockField, type AuditShardEvent, sessionsDir, validSessionId } from "./aidlc-record-core.ts";

// How far the authority covering an action reaches (authorityFor in
// aidlc-lib.ts); an entry keeps the one in force when its agent was sent.
export type AuthorityCover = "grant" | "instruction" | "none";

// `<projectDir>/aidlc/.aidlc-sessions/subagent-inflight.json`: the
// workspace-level background dispatch ledger, in the git-ignored sessions
// folder so a `git add -A` while a helper runs cannot commit it. Entries are
// session-scoped and reference-counted so overlapping workers cannot clear or
// authorize each other. The file remains workspace-level because dispatch and
// completion hooks can run outside an intent record, while each entry carries
// the session identity needed by Stop.
export function subagentInflightMarkerPath(projectDir: string): string {
  return join(sessionsDir(projectDir), "subagent-inflight.json");
}

/** The ledger's path as a person types it in the project. */
export function shownSubagentInflightPath(projectDir: string): string {
  return relative(projectDir, subagentInflightMarkerPath(projectDir)).split(sep).join("/");
}

// Where earlier releases kept the ledger, which no shipped ignore block
// lists. A helper sent before an update can still be at work, so the first
// locked read after it takes the file in: removed first, so a removal that
// fails carries nothing and one helper is never counted twice, then its fresh
// entries join the ledger. A malformed or all-stale old file never let a turn
// end, so it is only removed.
const OLD_SUBAGENT_INFLIGHT_FILE = ".aidlc-subagent-inflight";

function takeInOldSubagentInflight(projectDir: string): void {
  const old = join(workspaceRoot(projectDir), OLD_SUBAGENT_INFLIGHT_FILE);
  if (!existsSync(old)) return;
  try {
    const left = readSubagentInflightLedgerAt(old);
    unlinkSync(old);
    const carried = left.malformed ? [] : freshSubagentEntries(left.entries, Date.now());
    if (carried.length === 0) return;
    const current = readSubagentInflightLedger(projectDir);
    if (!current.malformed) writeSubagentInflightLedger(projectDir, [...current.entries, ...carried]);
  } catch {
    // Left for the next locked read; the caller's own result stands.
  }
}

// Freshness window for each background-subagent entry. The Stop hook honours
// only matching fresh entries; older entries are orphaned dispatches and are
// pruned under the workspace lock. 2h covers long-running agents while bounding
// how long a crashed dispatch can relax forwarding-loop enforcement.
export const SUBAGENT_INFLIGHT_TTL_MS = 2 * 60 * 60 * 1000;

interface SubagentInflightEntry {
  sessionId: string | null;
  startedAtMs: number;
  /** The authority in force when this agent was dispatched, so it inherits it
   *  instead of being judged on its own (a dispatch cannot mint a grant). */
  authority?: AuthorityCover;
}

interface SubagentInflightLedger {
  version: 1;
  entries: SubagentInflightEntry[];
}

interface SubagentInflightRead {
  exists: boolean;
  malformed: boolean;
  entries: SubagentInflightEntry[];
}

export interface SubagentInflightSummary {
  exists: boolean;
  malformed: boolean;
  freshCount: number;
  staleCount: number;
  oldestAgeMs: number | null;
}

export interface SubagentInflightMatch {
  active: boolean;
  staleRemoved: number;
  malformed: boolean;
  invalidSession: boolean;
}

export function subagentSessionIdentity(
  sessionId: unknown,
): { valid: true; sessionId: string | null } | { valid: false } {
  if (sessionId === undefined || sessionId === "") {
    return { valid: true, sessionId: null };
  }
  if (typeof sessionId !== "string") return { valid: false };
  const valid = validSessionId(sessionId);
  return valid ? { valid: true, sessionId: valid } : { valid: false };
}

export function readSubagentInflightLedger(projectDir: string): SubagentInflightRead {
  return readSubagentInflightLedgerAt(subagentInflightMarkerPath(projectDir));
}

function readSubagentInflightLedgerAt(path: string): SubagentInflightRead {
  if (!existsSync(path)) return { exists: false, malformed: false, entries: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object") {
      return { exists: true, malformed: true, entries: [] };
    }
    const candidate = parsed as Partial<SubagentInflightLedger>;
    if (candidate.version !== 1 || !Array.isArray(candidate.entries)) {
      return { exists: true, malformed: true, entries: [] };
    }
    const entries: SubagentInflightEntry[] = [];
    for (const value of candidate.entries) {
      if (value === null || typeof value !== "object") {
        return { exists: true, malformed: true, entries: [] };
      }
      const entry = value as Partial<SubagentInflightEntry>;
      const validIdentity =
        entry.sessionId === null ||
        (typeof entry.sessionId === "string" &&
          validSessionId(entry.sessionId) === entry.sessionId);
      const validAuthority =
        entry.authority === undefined ||
        entry.authority === "grant" ||
        entry.authority === "instruction" ||
        entry.authority === "none";
      if (
        !validIdentity ||
        !validAuthority ||
        typeof entry.startedAtMs !== "number" ||
        !Number.isFinite(entry.startedAtMs) ||
        entry.startedAtMs <= 0
      ) {
        return { exists: true, malformed: true, entries: [] };
      }
      entries.push({
        sessionId: entry.sessionId ?? null,
        startedAtMs: entry.startedAtMs,
        ...(entry.authority ? { authority: entry.authority } : {}),
      });
    }
    return { exists: true, malformed: false, entries };
  } catch {
    return existsSync(path)
      ? { exists: true, malformed: true, entries: [] }
      : { exists: false, malformed: false, entries: [] };
  }
}

function writeSubagentInflightLedger(
  projectDir: string,
  entries: SubagentInflightEntry[],
): void {
  const path = subagentInflightMarkerPath(projectDir);
  if (entries.length === 0) {
    try {
      unlinkSync(path);
    } catch {
      // Already absent or unreadable: callers retain fail-closed behavior.
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const ledger: SubagentInflightLedger = { version: 1, entries };
  writeFileAtomic(path, `${JSON.stringify(ledger)}\n`);
}

export function freshSubagentEntries(
  entries: SubagentInflightEntry[],
  nowMs: number,
): SubagentInflightEntry[] {
  return entries.filter(
    (entry) => nowMs - entry.startedAtMs <= SUBAGENT_INFLIGHT_TTL_MS,
  );
}

export function markSubagentInflight(
  projectDir: string,
  sessionId?: unknown,
  authority?: AuthorityCover,
): boolean {
  const identity = subagentSessionIdentity(sessionId);
  if (!identity.valid) return false;
  return withAuditLock(projectDir, () => {
    takeInOldSubagentInflight(projectDir);
    const current = readSubagentInflightLedger(projectDir);
    if (current.malformed) {
      throw new Error(
        `background-subagent in-flight ledger is malformed; remove ${shownSubagentInflightPath(projectDir)}`,
      );
    }
    const nowMs = Date.now();
    const entries = freshSubagentEntries(current.entries, nowMs);
    // The dispatch stamp: the authority in force at dispatch travels with the
    // agent, so its actions are judged on what the human or the engine asked
    // for, not on the agent's own (absent) authority.
    entries.push({
      sessionId: identity.sessionId,
      startedAtMs: nowMs,
      ...(authority ? { authority } : {}),
    });
    writeSubagentInflightLedger(projectDir, entries);
    return true;
  });
}

export function completeSubagentInflight(
  projectDir: string,
  sessionId?: unknown,
): boolean {
  const identity = subagentSessionIdentity(sessionId);
  if (!identity.valid) return false;
  return withAuditLock(projectDir, () => {
    takeInOldSubagentInflight(projectDir);
    const current = readSubagentInflightLedger(projectDir);
    if (!current.exists) return false;
    if (current.malformed) {
      throw new Error(
        `background-subagent in-flight ledger is malformed; remove ${shownSubagentInflightPath(projectDir)}`,
      );
    }
    const entries = freshSubagentEntries(current.entries, Date.now());
    const index = entries.findIndex(
      (entry) => entry.sessionId === identity.sessionId,
    );
    if (index >= 0) entries.splice(index, 1);
    writeSubagentInflightLedger(projectDir, entries);
    return index >= 0;
  });
}

export function matchSubagentInflight(
  projectDir: string,
  sessionId?: unknown,
): SubagentInflightMatch {
  const identity = subagentSessionIdentity(sessionId);
  if (!identity.valid) {
    return {
      active: false,
      staleRemoved: 0,
      malformed: false,
      invalidSession: true,
    };
  }
  return withAuditLock(projectDir, () => {
    takeInOldSubagentInflight(projectDir);
    const current = readSubagentInflightLedger(projectDir);
    if (!current.exists) {
      return {
        active: false,
        staleRemoved: 0,
        malformed: false,
        invalidSession: false,
      };
    }
    if (current.malformed) {
      return {
        active: false,
        staleRemoved: 0,
        malformed: true,
        invalidSession: false,
      };
    }
    const entries = freshSubagentEntries(current.entries, Date.now());
    const staleRemoved = current.entries.length - entries.length;
    if (staleRemoved > 0) writeSubagentInflightLedger(projectDir, entries);
    return {
      active: entries.some(
        (entry) => entry.sessionId === identity.sessionId,
      ),
      staleRemoved,
      malformed: false,
      invalidSession: false,
    };
  });
}

/** Whether an agent sent in the background at or after `sinceMs` has not
 *  returned: a fresh in-flight entry started since. The completion hook that
 *  records an agent's finish removes its entry; a missing or malformed ledger
 *  shows none. */
export function backgroundAgentOutSince(projectDir: string, sinceMs: number): boolean {
  const current = readSubagentInflightLedger(projectDir);
  if (!current.exists || current.malformed) return false;
  return freshSubagentEntries(current.entries, Date.now()).some((entry) => entry.startedAtMs >= sinceMs);
}

/** Whether the completion hook (hooks-health folder `healthDir`) left a trace since `request` of a finish
 *  it could not record as an agent's: a completion row since naming no agent, a run since that left no row
 *  (its heartbeat newer than every completion row since), a failure it recorded since, or a trace or request
 *  time that does not read. A cross-shard tie counts as since; a trace file that cannot be read throws. */
export function unrecordedFinishSince(healthDir: string, rows: ReadonlyArray<AuditShardEvent>, request: AuditShardEvent): boolean {
  const requested = Date.parse(request.timestamp);
  if (!Number.isFinite(requested)) return true;
  const since = rows.filter((row) => row.event === "SUBAGENT_COMPLETED" && !attemptEventDefinitelyBefore(row, request));
  if (since.some((row) => [null, "", "unknown"].includes(auditBlockField(row.block, "Agent Type")))) return true;
  const heartbeat = join(healthDir, "log-subagent.last");
  if (existsSync(heartbeat)) {
    const beat = Date.parse(readFileSync(heartbeat, "utf-8").trim());
    if (!Number.isFinite(beat)) return true;
    // The hook beats, then appends its row in the same run: a beat since the
    // request with no completion row at or after it is a run that left none.
    if (beat >= requested && !since.some((row) => Date.parse(row.timestamp) >= beat)) return true;
  }
  const drops = join(healthDir, "log-subagent.drops");
  if (existsSync(drops)) {
    for (const line of readFileSync(drops, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      const at = Date.parse(line.split("\t", 1)[0]);
      if (!Number.isFinite(at) || at >= requested) return true;
    }
  }
  return false;
}

export function inspectSubagentInflight(
  projectDir: string,
): SubagentInflightSummary {
  const current = readSubagentInflightLedger(projectDir);
  if (!current.exists || current.malformed) {
    return {
      exists: current.exists,
      malformed: current.malformed,
      freshCount: 0,
      staleCount: 0,
      oldestAgeMs: null,
    };
  }
  const nowMs = Date.now();
  let freshCount = 0;
  let staleCount = 0;
  let oldestAgeMs: number | null = null;
  for (const entry of current.entries) {
    const ageMs = Math.max(0, nowMs - entry.startedAtMs);
    oldestAgeMs = Math.max(oldestAgeMs ?? 0, ageMs);
    if (ageMs <= SUBAGENT_INFLIGHT_TTL_MS) freshCount++;
    else staleCount++;
  }
  return {
    exists: true,
    malformed: false,
    freshCount,
    staleCount,
    oldestAgeMs,
  };
}
