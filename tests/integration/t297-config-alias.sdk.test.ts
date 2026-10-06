// covers: subcommand:aidlc-orchestrate:next, file:skills/aidlc/SKILL.md

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

describe("t297 /aidlc --config trust (SDK live)", () => {
  test(
    "reads trust state, asks conversationally, and creates no workflow state",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const project = setupIntegrationProject({
        noAidlcDocs: true,
        stripEnvScope: true,
      });
      try {
        const result = await driveAidlc("/aidlc --config trust", {
          projectDir: project,
          answerScript: {
            kind: "sequence",
            specs: [{ labelContains: "Acknowledge" }],
            fallback: { optionIndex: 0 },
          },
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterAskUserQuestion: true,
        });

        assertToolResultContains(
          result,
          "Bash",
          "Configure the trust section conversationally",
        );
        assertToolResultContains(
          result,
          "Bash",
          "trust configuration for claude",
        );
        const showCall = result.toolResults.find((item) =>
          item.toolName === "Bash" &&
          item.resultText.includes("trust configuration for claude")
        );
        expect(showCall).toBeDefined();
        expect(String(showCall?.input.command ?? "")).toContain(
          "config trust --show --json",
        );
        expect(result.askedQuestions.length).toBeGreaterThanOrEqual(1);
        expect(
          Object.values(result.askedQuestions[0].answers).flat().join(" "),
        ).not.toBe("");

        const intents = join(
          project,
          "aidlc",
          "spaces",
          "default",
          "intents",
        );
        const stateFiles = existsSync(intents)
          ? readdirSync(intents).filter((name) =>
              existsSync(join(intents, name, "aidlc-state.md"))
            )
          : [];
        expect(stateFiles).toEqual([]);
        expect(result.stateFile).toBeUndefined();
      } finally {
        cleanupTestProject(project);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
