// covers: scope:bugfix, file:skills/aidlc/SKILL.md, hook:aidlc-record-human-turn, audit:GATE_REJECTED, audit:GATE_APPROVED
//
// t-run-opencode-journey-golden-change.serial.test.ts - the "fix existing code"
// golden journey on opencode (live `opencode run`), from the person's first
// line to Reverse Engineering approved after one change they asked for.
//
// The journey: the release journey's greeter repo (tests/harness/release-journey.ts)
// on the shipped opencode tree, with its permission table and production
// guards. `opencode run` shows no question box, so every question comes as
// numbered text and the person types each reply, in one session.
//   `/aidlc fix the greeter: ...`, the plan offer taken, then at Reverse
//   Engineering's approval "Request changes: ..." in their own words, and
//   "Approve" once the revised work is shown again.
//
// It fails when the person is asked anything twice (the approval offered again
// after their change counts once), a decision is recorded with no turn of
// theirs behind it, a turn ends with nothing asked of them, a stage bugfix
// leaves out runs, the change is not recorded once and in their words,
// Reverse Engineering is approved other than once, a line they typed has no
// message record or a record holds words they never typed, or opencode refuses
// one of AI-DLC's own calls on the shipped permissions (`opencode run` refuses
// a call the table would ask about). Pass/fail reads only what the engine and
// hooks recorded, the state file, the person's own turns and opencode's own
// events, NEVER the agent's prose.
//
// LIVE GATE: AIDLC_OPENCODE_RUN_LIVE=1, an opencode >= 1.17 binary
// (AIDLC_OPENCODE_BIN or PATH), dist/opencode, a configured model provider
// (AIDLC_OPENCODE_MODEL overrides, default Bedrock), and the production guard
// profile (--production-guards). SPENDS TOKENS. Serial.

import { liveCaseTimeoutMs, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CI_BEDROCK_MODELS } from "../../scripts/ci-credential-broker.ts";
import { opencodeReplies, opencodeToolResults, opencodeTurn, setupOpencodeProject } from "../harness/exec-drive.ts";
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
import { PersonTurnLedger, unbackedFailure } from "../harness/person-turns.ts";
import { RELEASE_JOURNEY_REQUEST, recordedPersonLines, seedGreeter } from "../harness/release-journey.ts";
import { opencodePermissionProblems } from "../harness/stock-permissions.ts";

const OPENCODE_BIN = process.env.AIDLC_OPENCODE_BIN ?? "opencode";
const MODEL = process.env.AIDLC_OPENCODE_MODEL ?? `amazon-bedrock/${CI_BEDROCK_MODELS.opencode}`;
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(GOLDEN_WORK_MS);
const CHANGE = "Request changes: in the summary, also say that the only test runs the command line and checks its output";

function opencodeVersionOk(): boolean {
  const r = spawnSync(OPENCODE_BIN, ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw r.error;
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return r.status === 0 && m !== null && (Number(m[1]) > 1 || (Number(m[1]) === 1 && Number(m[2]) >= 17));
}

// The runner gives this file the production guard profile on its own (it looks
// for this comparison), even in a shard of fixture-profile files.
const PRODUCTION_GUARDS = process.env.AIDLC_TEST_GUARD_PROFILE === "production";

function skipReason(): string | null {
  if (process.env.AIDLC_OPENCODE_RUN_LIVE !== "1") return "set AIDLC_OPENCODE_RUN_LIVE=1 to run the live opencode golden journey (uses your provider)";
  if (!PRODUCTION_GUARDS) return "run with --production-guards: the journey is the person's own guard profile";
  if (!opencodeVersionOk()) return `opencode >= 1.17 not found (AIDLC_OPENCODE_BIN=${OPENCODE_BIN})`;
  if (!existsSync(join(REPO_ROOT, "dist", "opencode"))) return "dist/opencode is missing: run bun scripts/package.ts";
  // opencode's Bedrock provider needs static credentials (it does not walk the instance-role chain), as t-run-opencode-status says.
  if (MODEL.startsWith("amazon-bedrock/") && !process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE &&
    !existsSync(join(homedir(), ".aws", "credentials"))) {
    return "Bedrock is the provider but no static AWS credentials are visible to opencode (env keys, AWS_PROFILE, or ~/.aws/credentials)";
  }
  return null;
}
const SKIP_REASON = skipReason();

// opencode reports each model step's tokens and its own price for them.
function addTokens(total: Record<string, number>, stdout: string): void {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith('{"type":"step_finish"')) continue;
    try {
      const part = (JSON.parse(line) as { part?: { tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }; cost?: number } }).part;
      const add = (key: string, value: number | undefined) => { total[key] = (total[key] ?? 0) + (value ?? 0); };
      add("input", part?.tokens?.input);
      add("output", part?.tokens?.output);
      add("cacheRead", part?.tokens?.cache?.read);
      add("cacheWrite", part?.tokens?.cache?.write);
      add("cost", part?.cost);
    } catch {
      // A partly written line is no report.
    }
  }
}

describe("t-run-opencode-journey-golden-change: fix existing code on opencode, to Reverse Engineering approved after one change", () => {
  test.skipIf(SKIP_REASON !== null)(
    `asked once at every step, every answer the person's, their change recorded in their words, and nothing of AI-DLC's refused${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      for (const key of GUARD_SWITCHES) expect(process.env[key], `${key} disables the production contract`).not.toBe("1");
      const deadline = Date.now() + TEST_TIMEOUT_MS;
      const { proj, root } = setupOpencodeProject();
      seedGreeter(proj);
      const journey: GoldenJourney = {
        proj, scope: "bugfix", hasCode: true, request: `/aidlc ${RELEASE_JOURNEY_REQUEST}`, lastStage: "reverse-engineering",
        changeRequest: { stage: "reverse-engineering", words: CHANGE }, budget: () => undefined,
      };
      const person = new GoldenPerson(journey);
      const turns: Array<{ line: string; seconds: number }> = [];
      const refused: string[] = [];
      const tokens: Record<string, number> = {};
      let sessionId: string | undefined;
      const problems: string[] = [];
      try {
        const run = driveTyped(person, (line) => {
          const ledger = new PersonTurnLedger(proj);
          ledger.sent(line);
          const started = Date.now();
          const turn = opencodeTurn(proj, line, { sessionId, timeoutMs: Math.max(1, deadline - Date.now()) });
          turns.push({ line, seconds: Math.round((Date.now() - started) / 1000) });
          if (turn.rc !== 0) throw new Error(`opencode ended "${line}" with exit ${turn.rc}: ${turn.out.trim().slice(-1500)}`);
          const unbacked = ledger.unbacked();
          if (unbacked.length > 0) throw unbackedFailure(`The opencode turn "${line}"`, unbacked);
          addTokens(tokens, turn.stdout);
          const permissions = opencodePermissionProblems(turn.stdout);
          problems.push(...permissions.problems);
          refused.push(...permissions.listed);
          const { sessionId: id, results } = opencodeToolResults(turn.stdout);
          if (sessionId !== undefined && id !== undefined && id !== sessionId) throw new Error(`"${line}" went to session ${id}, not the person's ${sessionId}`);
          sessionId ??= id;
          return { results, words: opencodeReplies(turn.stdout, true) };
        });
        problems.push(...run.problems, ...goldenPathProblems(journey, run));
        const recorded = recordedPersonLines(proj);
        const typed = turns.map(({ line }) => line);
        for (const line of typed) if (!recorded.includes(line)) problems.push(`"${line}" has no message record: opencode did not run AI-DLC's hooks for it`);
        for (const line of recorded.filter((words) => !typed.includes(words))) {
          problems.push(`a message record holds words the person never typed: "${line.slice(0, 120)}"`);
        }
      } catch (error) {
        problems.push(`the journey stopped: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
        throw error;
      } finally {
        writeGoldenReport("opencode", { problems, person: person.said, turns, refused, tokens });
      }
      expect(problems, `the person:\n  ${person.said.join("\n  ")}`).toEqual([]);
      rmSync(root, { recursive: true, force: true });
    },
    TEST_TIMEOUT_MS,
  );
});
