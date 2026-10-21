// covers: scope:bugfix, file:skills/aidlc/SKILL.md, hook:aidlc-record-human-turn, audit:GATE_APPROVED, audit:PLAN_APPROVAL_RECORDED
//
// t-exec-codex-journey-golden-bugfix.serial.test.ts - the "fix existing code"
// golden journey on Codex (live `codex exec`), from the person's first line to
// the fix built, with a night between.
//
// The journey: the release journey's greeter repo (tests/harness/release-journey.ts),
// which prints `hello` where its README says `Hello, Ada!`, on a Codex install
// with the shipped workspace-write sandbox and production guards. The question
// picker is off in exec, so every question comes as numbered text and the
// person types each reply.
//   session 1: `$aidlc fix the greeter: ...`, the plan offer taken, Reverse
//              Engineering approved, Requirements answered (their own words for
//              the first question it asks, if it asks one) and approved. The
//              plan question is left unanswered for the day.
//   session 2: a new `codex exec`, not a resume: `$aidlc`. The plan question
//              comes first, "Approve Plan", then Code Generation is approved.
//
// It fails when the person is asked anything twice, a decision is recorded
// with no turn of theirs behind it, a turn ends with nothing asked of them, the
// new session asks anything before the plan question, a stage bugfix leaves
// out runs, a stage is approved other than once, a line the person typed has
// no message record, the sandbox refuses one of AI-DLC's own commands, or the
// fix does not work. Pass/fail reads only what the engine and hooks recorded,
// the state file, the person's own turns and the project's own code, NEVER the
// agent's prose.
//
// LIVE GATE: AIDLC_CODEX_EXEC_LIVE=1, a codex >= 0.145.0 binary (AIDLC_CODEX_BIN
// or PATH), dist/codex, and the production guard profile (--production-guards).
// Bedrock uses the AWS default credential chain; AIDLC_CODEX_AWS_PROFILE
// selects a named profile. SPENDS TOKENS. Serial.

import { liveCaseTimeoutMs, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codexExecDiagnostic, withCodexFixture } from "../harness/codex-test-lifecycle.ts";
import { codexJsonTurn, setupCodexProject } from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  driveTyped,
  GOLDEN_WORK_MS,
  type GoldenJourney,
  goldenPathProblems,
  GoldenPerson,
  GUARD_SWITCHES,
  writeGoldenReport,
} from "../harness/golden-journey.ts";
import { RELEASE_JOURNEY_REQUEST, recordedPersonLines, seedGreeter } from "../harness/release-journey.ts";

const CODEX_BIN = process.env.AIDLC_CODEX_BIN ?? "codex";
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(GOLDEN_WORK_MS);
const OWN_WORDS = "Keep it small: the greeting uses the name given on the command line, and nothing else changes";

function codexVersionOk(): boolean {
  const r = spawnSync(CODEX_BIN, ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw r.error;
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return r.status === 0 && m !== null && (Number(m[1]) > 0 || Number(m[2]) >= 145);
}

// The runner gives this file the production guard profile on its own (it looks
// for this comparison), even in a shard of fixture-profile files.
const PRODUCTION_GUARDS = process.env.AIDLC_TEST_GUARD_PROFILE === "production";

function skipReason(): string | null {
  if (process.env.AIDLC_CODEX_EXEC_LIVE !== "1") return "set AIDLC_CODEX_EXEC_LIVE=1 to run the live Codex golden journey (uses Bedrock)";
  if (!PRODUCTION_GUARDS) return "run with --production-guards: the journey is the person's own guard profile";
  if (!codexVersionOk()) return `codex >= 0.145.0 not found (AIDLC_CODEX_BIN=${CODEX_BIN})`;
  if (!existsSync(join(REPO_ROOT, "dist", "codex"))) return "dist/codex is missing: run bun scripts/package.ts";
  return null;
}
const SKIP_REASON = skipReason();

// Codex reports a session's tokens so far at each turn's end; the last report of each session is its total.
function sessionTokens(stdout: string): Record<string, number> | undefined {
  let usage: Record<string, number> | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith('{"type":"turn.completed"')) continue;
    try {
      usage = (JSON.parse(line) as { usage?: Record<string, number> }).usage ?? usage;
    } catch {
      // A partly written line is no report.
    }
  }
  return usage;
}

describe("t-exec-codex-journey-golden-bugfix: fix existing code on Codex, from the first line to the fix built", () => {
  test.skipIf(SKIP_REASON !== null)(
    `asked once at every step, every answer the person's, the plan left overnight and approved in a new session, and the fix works${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    async () => {
      for (const key of GUARD_SWITCHES) expect(process.env[key], `${key} disables the production contract`).not.toBe("1");
      const deadlineMs = performance.now() + TEST_TIMEOUT_MS;
      const { proj, home, root } = setupCodexProject({ workspaceWrite: true });
      await withCodexFixture(root, () => rmSync(root, { recursive: true, force: true }), () => {
        seedGreeter(proj);
        const journey: GoldenJourney = {
          proj, scope: "bugfix", hasCode: true, request: `$aidlc ${RELEASE_JOURNEY_REQUEST}`,
          ownWords: { stage: "requirements-analysis", words: OWN_WORDS }, lastStage: "code-generation",
          newSessionAtPlan: "$aidlc", budget: () => undefined,
        };
        const person = new GoldenPerson(journey);
        const turns: Array<{ line: string; newSession: boolean; seconds: number }> = [];
        const tokens: Record<string, number>[] = [];
        let session: string | undefined;
        const problems: string[] = [];
        try {
          const run = driveTyped(person, (line, newSession) => {
            const started = Date.now();
            const turn = codexJsonTurn(proj, home, line, "golden-bugfix", newSession ? undefined : session);
            turns.push({ line, newSession, seconds: Math.round((Date.now() - started) / 1000) });
            if (turn.rc !== 0) throw new Error(`Codex ended "${line}" with exit ${turn.rc}\n${codexExecDiagnostic(turn)}`);
            if (!newSession && turn.sessionId !== session) throw new Error(`"${line}" went to session ${turn.sessionId}, not the person's ${session}`);
            const usage = sessionTokens(turn.stdout);
            if (newSession || tokens.length === 0) tokens.push(usage ?? {});
            else if (usage) tokens[tokens.length - 1] = usage;
            session = turn.sessionId;
            return turn.results;
          });
          problems.push(...run.problems, ...goldenPathProblems(journey, run));
          const recorded = recordedPersonLines(proj);
          for (const { line } of turns) if (!recorded.includes(line)) problems.push(`"${line}" has no message record: Codex did not run AI-DLC's hooks for it`);
          const app = spawnSync("node", ["src/app.js", "Ada"], { cwd: proj, encoding: "utf-8", timeout: 60_000 });
          if ((app.stdout ?? "").trim() !== "Hello, Ada!") problems.push(`the greeter prints ${JSON.stringify((app.stdout ?? "").trim())} for Ada, not "Hello, Ada!"`);
          const own = spawnSync("node", ["test/app.test.js"], { cwd: proj, encoding: "utf-8", timeout: 60_000 });
          if (own.status !== 0) problems.push(`the project's own test fails: ${`${own.stdout ?? ""}${own.stderr ?? ""}`.trim().slice(0, 400)}`);
        } catch (error) {
          problems.push(`the journey stopped: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
          throw error;
        } finally {
          writeGoldenReport("codex", { problems, person: person.said, turns, tokens });
        }
        expect(problems, `the person:\n  ${person.said.join("\n  ")}`).toEqual([]);
      }, deadlineMs);
    },
    TEST_TIMEOUT_MS,
  );
});
