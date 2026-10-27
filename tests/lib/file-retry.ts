import { existsSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The one rule for re-running a failed test file once. A retry is earned only
 * by failed cases with complete evidence: never by a file that ran past its
 * deadline, a crash or a nonzero exit without failed cases, a cleanup failure,
 * a file that executed no cases, or a file too long to repeat within the run.
 * A case that ran past its own case timeout is a failed case; a file whose
 * only failures are such timeouts may be longer and still earn its retry.
 * A person-turn failure never earns one: a run that saw AI-DLC act for the
 * person found the break a person would meet, and a pass on a second attempt
 * would hide it.
 */
export interface RetryEvidence {
  status: "PASS" | "FAIL" | "SKIP";
  cases: { passed: number; failed: number; skipped: number };
  evidenceComplete?: boolean;
  cleanupError?: string;
  timedOut: boolean;
  wallTimeMs: number;
  /** Every failed case failed by running past its case timeout. */
  caseTimeoutsOnly?: boolean;
  /** A case failed a person-turn check: AI-DLC acted for the person (`personTurnFailed`). */
  personTurnFailure?: boolean;
}

/** Isolated live files: one Bedrock-backed journey can take most of an hour. */
export const ISOLATED_RETRY_MAX_MS = 25 * 60_000;
/**
 * Ordinary smoke/unit/integration files (merge queue). A retry adds the file's
 * time again to its worker; ten minutes covers every file that
 * flaked in the queue on 2026-10-03 (the longest ran about 7.5 minutes on its
 * slowest OS) and about 98% of all files.
 */
export const ORDINARY_RETRY_MAX_MS = 10 * 60_000;
/**
 * A file whose only failures are case timeouts: a slow Windows runner times
 * out cases in files that run 12 to 33 minutes there. It lifts only the
 * ordinary limit; an isolated live file keeps its own.
 */
export const CASE_TIMEOUT_RETRY_MAX_MS = 45 * 60_000;
/** Never start a second attempt the run deadline would cut short. */
export const RETRY_DEADLINE_RESERVE_MS = 5 * 60_000;

export function retryEligible(first: RetryEvidence, maxWallMs: number, remainingMs = Number.POSITIVE_INFINITY): boolean {
  const wallLimit = first.caseTimeoutsOnly === true && maxWallMs === ORDINARY_RETRY_MAX_MS ? CASE_TIMEOUT_RETRY_MAX_MS : maxWallMs;
  return first.status === "FAIL" && first.cases.failed > 0 && first.evidenceComplete === true &&
    !first.cleanupError && !first.timedOut && first.personTurnFailure !== true && first.wallTimeMs <= wallLimit &&
    remainingMs > RETRY_DEADLINE_RESERVE_MS;
}

/**
 * True when a case failed with the error a driver throws by this name. Bun 1.4
 * writes the error's name as the JUnit failure type; Bun 1.3 writes every
 * thrown error as `AssertionError`, so the error's own header line, which
 * every Bun prints for an uncaught error, counts too.
 */
function failedWith(name: string, xml: string, output: string): boolean {
  return [...xml.matchAll(/<(failure|error)\b([^>]*)>/g)].some((match) => new RegExp(`\\btype="${name}"`).test(match[2])) ||
    new RegExp(`^${name}: `, "m").test(output);
}

/** True when a case failed a person-turn check (tests/harness/person-turns.ts). */
export function personTurnFailed(xml: string, output = ""): boolean {
  return failedWith("PersonTurnError", xml, output);
}

/**
 * True when a case failed because the model service did, not AI-DLC
 * (tests/harness/sdk-drive.ts ModelApiError). It is still a failure and keeps
 * its one retry; only what the run says about it changes.
 */
export function modelApiFailed(xml: string, output = ""): boolean {
  return failedWith("ModelApiError", xml, output);
}

/**
 * True when every failed case failed because the model service did: only then
 * is the whole file's failure infrastructure. Bun 1.3 names every failure
 * `AssertionError`, so there each failed case needs its own printed header.
 */
export function onlyModelApiFailures(xml: string, output = ""): boolean {
  const failures = [...xml.matchAll(/<(failure|error)\b([^>]*)>/g)].map((match) => match[2]);
  if (failures.length === 0) return false;
  if (failures.every((attributes) => /\btype="ModelApiError"/.test(attributes))) return true;
  return failures.every((attributes) => /\btype="AssertionError"/.test(attributes)) &&
    (output.match(/^ModelApiError: /gm)?.length ?? 0) >= failures.length;
}

/** What a file whose every failed case was the model service's says, in its result and failures.txt. */
export const MODEL_API_REASON = "the model service failed, not AI-DLC: infrastructure, not a test result";

/** The line a live file that passed only on its second attempt gets, on every OS. */
export function flakyLiveLine(file: string): string {
  return `::warning title=Flaky live test::${basename(file)} passed on its second attempt; both attempts are retained.`;
}

/** The line a file that failed a person-turn check gets, on every OS. */
export function personTurnLine(file: string): string {
  return `::error title=Person-turn failure::${basename(file)} found AI-DLC acting for the person ` +
    "(a decision recorded as theirs with no reply of theirs behind it, or work started before they answered).";
}

/** The line a live file the model service failed under gets, on every OS; its other failures are its own. */
export function modelApiLine(file: string): string {
  return `::warning title=Model service failure::${basename(file)}: the model service failed under it ` +
    "(throttled, a server error, or the connection dropped); that failure is infrastructure, not a test result.";
}

/** True when a JUnit report has failed cases and every one ran past its case timeout (bun writes `type="TimeoutError"`). */
export function onlyCaseTimeouts(xml: string): boolean {
  const failures = [...xml.matchAll(/<(failure|error)\b([^>]*)>/g)];
  return failures.length > 0 && failures.every((match) => match[1] === "failure" && /\btype="TimeoutError"/.test(match[2]));
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
