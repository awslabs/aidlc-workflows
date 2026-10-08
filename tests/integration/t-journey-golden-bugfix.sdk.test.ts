// covers: scope:bugfix, file:skills/aidlc/SKILL.md, hook:aidlc-record-human-turn, audit:GATE_APPROVED, audit:PLAN_APPROVAL_RECORDED
//
// t-journey-golden-bugfix.sdk.test.ts - the "fix existing code" family's
// golden journey (bugfix, security-patch, refactor and express share its
// path), live, from the person's first message to the fix built.
//
// The journey: a small repo whose formatPrice(0) returns an empty string.
//   The person types `/aidlc Fix the bug where formatPrice(0) ...`, takes the
//   bugfix offer, approves Reverse Engineering, answers the Requirements
//   questions (the first in their own words), approves Requirements, approves
//   the code plan, and approves Code Generation. Nothing else is asked.
//
// It fails when the person is asked anything twice, a decision is recorded
// with no turn of theirs behind it, a turn ends with nothing asked of them, a
// stage bugfix leaves out runs, the plan is asked other than once, a summary
// or learnings question comes (bugfix turns both off), or the fix does not
// work. Pass/fail reads only what the engine and hooks recorded, the state
// file, the person's own turns and the project's own code, NEVER the agent's
// prose.
//
// SPENDS TOKENS. Requires AIDLC_CLAUDE_SDK_LIVE=1 and --production-guards;
// the fixture profile skips it.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const REQUEST = '/aidlc Fix the bug where formatPrice(0) returns an empty string instead of "$0.00"';
const OWN_WORDS = "Keep the fix small: zero shows as $0.00 like any other price, and nothing else changes";

// The team's repo: the bug, and a test that does not cover it.
function seedRepo(proj: string): void {
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(proj, "test"), { recursive: true });
  writeFileSync(join(proj, "package.json"), `${JSON.stringify({ name: "price-format", type: "module", scripts: { test: "bun test" } }, null, 2)}\n`);
  writeFileSync(join(proj, "README.md"), "# price-format\n\nFormats prices held in cents for the shop's receipts.\n");
  writeFileSync(join(proj, "src", "price.js"),
    "export function formatPrice(cents) {\n  if (!cents) return \"\";\n  return `$${(cents / 100).toFixed(2)}`;\n}\n");
  writeFileSync(join(proj, "test", "price.test.js"),
    "import { expect, test } from \"bun:test\";\nimport { formatPrice } from \"../src/price.js\";\n\n" +
    "test(\"formats cents as dollars\", () => {\n  expect(formatPrice(1999)).toBe(\"$19.99\");\n});\n");
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=Team", "-c", "user.email=team@example.com", ...args], { cwd: proj });
  expect(git("init", "-q").status).toBe(0);
  expect(git("add", "package.json", "README.md", "src", "test").status).toBe(0);
  expect(git("commit", "-qm", "price formatting").status).toBe(0);
}

// The fix, read by running the project's own code.
function priceOf(proj: string, cents: number): string {
  const res = spawnSync(process.execPath, ["-e", `import { formatPrice } from "./src/price.js"; process.stdout.write(String(formatPrice(${cents})));`],
    { cwd: proj, encoding: "utf8", timeout: 60_000 });
  return res.status === 0 ? res.stdout : `(failed: ${res.stderr})`;
}

describe.skipIf(
  process.env.AIDLC_CLAUDE_SDK_LIVE !== "1" ||
    process.env.AIDLC_NO_LLM === "1" ||
    !Bun.which("claude"),
)("t-journey-golden-bugfix (sdk, production guards): fix existing code, from the first message to the fix built", () => {
  productionTest("asked once at every step, every answer the person's, the plan approved once, and the fix works", async () => {
    for (const key of GUARD_SWITCHES) {
      expect(process.env[key], `${key} disables the production contract`).not.toBe("1");
    }
    const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
    const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
    try {
      seedRepo(proj);
      const journey: GoldenJourney = {
        proj,
        scope: "bugfix",
        hasCode: true,
        request: REQUEST,
        ownWords: { stage: "requirements-analysis", words: OWN_WORDS },
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

      expect(priceOf(proj, 0), "formatPrice(0) after the fix").toBe("$0.00");
      expect(priceOf(proj, 1999), "formatPrice(1999) after the fix").toBe("$19.99");
      const tests = runProjectTests(proj);
      expect(tests.status, `the project's tests ${JSON.stringify(tests.files)}:\n${tests.output}`).toBe(0);
    } finally {
      cleanupTestProject(proj);
    }
  }, TEST_TIMEOUT_MS);
});
