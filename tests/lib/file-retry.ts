/**
 * The one rule for re-running a failed test file once. A retry is earned only
 * by an ordinary assertion failure with complete evidence: never by a timeout,
 * a crash or a nonzero exit without failed cases, a cleanup failure, a file
 * that executed no cases, or a file too long to repeat within the run.
 */
export interface RetryEvidence {
  status: "PASS" | "FAIL" | "SKIP";
  cases: { failed: number };
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
