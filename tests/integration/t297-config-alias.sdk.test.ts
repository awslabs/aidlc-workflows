// covers: subcommand:aidlc-orchestrate:next, file:skills/aidlc/SKILL.md

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

describe("t297 /aidlc --config trust (SDK live)", () => {
  test(
    "reads trust state, asks conversationally, and creates no workflow state",
    async () => {
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
          timeoutMs: DRIVE_TIMEOUT_MS,
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
