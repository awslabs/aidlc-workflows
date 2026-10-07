// covers: scope:poc, file:skills/aidlc/SKILL.md, hook:aidlc-record-human-turn, audit:GATE_APPROVED, audit:SUMMARY_CONFIRMATION_RECORDED
//
// t-journey-golden-poc.sdk.test.ts - the "prototype" family's golden journey
// (poc), live, from the person's first message in an empty folder to the
// prototype built.
//
// The journey: an empty folder.
//   The person types `/aidlc Prototype ...`, takes the poc offer, answers the
//   Intent Capture questions (the first in their own words), confirms its
//   summary, answers the learnings question, approves it; Reverse Engineering
//   is left out with no question (there is no code); then Requirements the
//   same way; then Code Generation builds with no plan question (poc turns
//   plan approval off), and they approve it.
//
// It fails when the person is asked anything twice, a decision is recorded
// with no turn of theirs behind it, a turn ends with nothing asked of them, a
// stage poc leaves out runs, a plan question comes, no summary or learnings
// question comes (poc turns both on), or the prototype has no passing test.
// Pass/fail reads only what the engine and hooks recorded, the state file,
// the person's own turns and the project's own code, NEVER the agent's prose.
//
// SPENDS TOKENS. Requires AIDLC_CLAUDE_SDK_LIVE=1 and --production-guards;
// the fixture profile skips it.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";
import {
  GOLDEN_WORK_MS,
  type GoldenJourney,
  goldenPathProblems,
  GoldenPerson,
  GUARD_SWITCHES,
  runProjectTests,
} from "../harness/golden-journey.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";
import { fileCleanupReserveMs, liveCaseTimeoutMs, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

const productionTest =
  process.env.AIDLC_TEST_GUARD_PROFILE === "production" ? test : test.skip;
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(GOLDEN_WORK_MS);

const REQUEST = "/aidlc Prototype a small TypeScript module, run with Bun, that adds up a CSV of sales rows " +
  "(date,amount) into a total per month, with a bun test that shows the totals are right";
const OWN_WORDS = "Keep it as small as possible: just enough to show the monthly totals come out right";

describe.skipIf(
  process.env.AIDLC_CLAUDE_SDK_LIVE !== "1" ||
    process.env.AIDLC_NO_LLM === "1" ||
    !Bun.which("claude"),
)("t-journey-golden-poc (sdk, production guards): a prototype, from an empty folder to the code built", () => {
  productionTest("asked once at every step, every answer the person's, no plan question, and the prototype's test passes", async () => {
    for (const key of GUARD_SWITCHES) {
      expect(process.env[key], `${key} disables the production contract`).not.toBe("1");
    }
    const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
    const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
    try {
      expect(spawnSync("git", ["init", "-q"], { cwd: proj }).status).toBe(0);
      const journey: GoldenJourney = {
        proj,
        scope: "poc",
        hasCode: false,
        request: REQUEST,
        ownWords: { stage: "intent-capture", words: OWN_WORDS },
        lastStage: "code-generation",
        budget: () => remainingOperationTimeoutMs(GOLDEN_WORK_MS, {
          deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "golden journey drive",
        }),
      };
      const person = new GoldenPerson(journey);
      const run = person.finish(await driveAidlc(journey.request, person.driveOptions()));
      const seen = `the person:\n  ${run.person.join("\n  ")}`;
      expect(run.problems, seen).toEqual([]);
      expect(goldenPathProblems(journey, run), seen).toEqual([]);

      const tests = runProjectTests(proj);
      expect(tests.files.length, "the prototype has no test").toBeGreaterThan(0);
      expect(tests.status, `the prototype's tests ${JSON.stringify(tests.files)}:\n${tests.output}`).toBe(0);
    } finally {
      cleanupTestProject(proj);
    }
  }, TEST_TIMEOUT_MS);
});
