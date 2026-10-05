import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * The one rule for re-running a failed test file once. A retry is earned only
 * by an ordinary assertion failure with complete evidence: never by a timeout,
 * a crash or a nonzero exit without failed cases, a cleanup failure, a file
 * that executed no cases, or a file too long to repeat within the run.
 */
export interface RetryEvidence {
  status: "PASS" | "FAIL" | "SKIP";
  cases: { passed: number; failed: number; skipped: number };
  evidenceComplete?: boolean;
  cleanupError?: string;
  timedOut: boolean;
  wallTimeMs: number;
}

/** Isolated live files: one Bedrock-backed journey can take most of an hour. */
export const ISOLATED_RETRY_MAX_MS = 25 * 60_000;
/**
 * Ordinary smoke/unit/integration files (merge queue). Shards run serially, so
 * a retry adds the file's time again; ten minutes covers every file that
 * flaked in the queue on 2026-10-03 (the longest ran about 7.5 minutes on its
 * slowest OS) and about 98% of all files.
 */
export const ORDINARY_RETRY_MAX_MS = 10 * 60_000;
/** Never start a second attempt the run deadline would cut short. */
export const RETRY_DEADLINE_RESERVE_MS = 5 * 60_000;

export function retryEligible(first: RetryEvidence, maxWallMs: number, remainingMs = Number.POSITIVE_INFINITY): boolean {
  return first.status === "FAIL" && first.cases.failed > 0 && first.evidenceComplete === true &&
    !first.cleanupError && !first.timedOut && first.wallTimeMs <= maxWallMs &&
    remainingMs > RETRY_DEADLINE_RESERVE_MS;
}

/**
 * A retry replaces the first attempt's failure only when it passed every case
 * the first attempt ran: no failed case, no case newly skipped, complete
 * evidence, and no timeout or cleanup failure. A case that failed and is then
 * skipped never counts as passing, even beside passing siblings.
 */
export function retryPassed(first: RetryEvidence, second: RetryEvidence): boolean {
  return second.status === "PASS" && second.cases.failed === 0 && second.evidenceComplete === true &&
    !second.cleanupError && !second.timedOut && second.cases.skipped <= first.cases.skipped &&
    second.cases.passed >= first.cases.passed + first.cases.failed;
}

/**
 * Move a failed first attempt's log, JUnit, execution record and process
 * artifacts to `<name>.attempt-1.*` before its retry, all or nothing. When
 * anything that exists cannot be moved (or its target already exists), every
 * move is undone and `ok` is false: the caller must then not retry, because
 * the second attempt would overwrite the first attempt's evidence.
 */
export function preserveFirstAttempt(logDir: string, name: string): { ok: boolean; log: string | null } {
  const moves = [
    [`${name}.log`, `${name}.attempt-1.log`],
    [`${name}.junit.xml`, `${name}.attempt-1.junit.xml`],
    [`${name}.execution.json`, `${name}.attempt-1.execution.json`],
    [join("processes", name), join("processes", `${name}.attempt-1`)],
  ].map(([from, to]) => [join(logDir, from), join(logDir, to)] as const).filter(([from]) => existsSync(from));
  const done: Array<readonly [string, string]> = [];
  try {
    for (const [from, to] of moves) {
      if (existsSync(to)) throw new Error(`${to} already exists`);
      renameSync(from, to);
      done.push([from, to]);
    }
  } catch {
    for (const [from, to] of done.reverse()) {
      try { renameSync(to, from); } catch { /* the retry is refused either way */ }
    }
    return { ok: false, log: null };
  }
  return { ok: true, log: existsSync(join(logDir, `${name}.attempt-1.log`)) ? `${name}.attempt-1.log` : null };
}
