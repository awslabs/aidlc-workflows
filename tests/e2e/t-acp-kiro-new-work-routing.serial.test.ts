// covers: file:skills/aidlc/SKILL.md, subcommand:aidlc-orchestrate:next
//
// Native Windows Kiro ACP proof for the two P3 routing shapes:
//   1. active intent + unrelated prose -> typed new-work-routing ask;
//   2. unselected intent clone + unrelated scoped prose -> the same typed ask
//      with engine-listed available_intents.
//
// In both cases the engine ask is the final tool result of the turn and Kiro
// renders numbered prose with Other. The test is intentionally two short turns
// and does not answer either question, so no workflow mutation follows.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { driveKiroAcp } from "../harness/kiro-acp-drive.ts";
import {
  cleanupTuiProject,
  KIRO_SRC,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 30_000);

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro routing proof (uses Kiro credits)";
  }
  if (platform() !== "win32") {
    return "this acceptance test is native-Windows-only";
  }
  if (spawnSync("kiro-cli", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not found";
  }
  if (spawnSync("kiro-cli", ["whoami"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

function engineAskIndex(
  calls: Awaited<ReturnType<typeof driveKiroAcp>>["toolCalls"],
  outputNeedle: string,
): number {
  return calls.findIndex((call) =>
    call.title.includes("aidlc-orchestrate.ts") &&
    call.output.join("").includes(outputNeedle)
  );
}

interface RoutingDirective {
  kind: "ask";
  ask_type: "new-work-routing";
  numbered_prose_question: string;
  available_intents?: string[];
}

function routingDirective(
  calls: Awaited<ReturnType<typeof driveKiroAcp>>["toolCalls"],
  index: number,
): RoutingDirective {
  const output = calls[index]?.output.join("").trim() ?? "";
  const directive = JSON.parse(output) as RoutingDirective;
  expect(directive.kind).toBe("ask");
  expect(directive.ask_type).toBe("new-work-routing");
  return directive;
}

function expectExactCompletedRendering(
  assistantText: string,
  directive: RoutingDirective,
): void {
  expect(assistantText).toContain(directive.numbered_prose_question);
  expect(
    assistantText.trimEnd().endsWith(directive.numbered_prose_question),
  ).toBe(
    true,
  );
}

function seedSecondIntent(project: string): void {
  const result = spawnSync(
    process.execPath,
    [
      join(project, ".kiro", "tools", "aidlc-utility.ts"),
      "intent-create",
      "--scope",
      "poc",
      "--label",
      "second fixture",
      "--project-dir",
      project,
    ],
    { cwd: project, encoding: "utf-8" },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

describe("t-acp-kiro-new-work-routing (live engine-ask authority)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `active intent: typed ask is numbered 1-4 and ends tool use${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const project = setupTuiProject({
        harness: "kiro",
        withState: "state-mid-ideation.md",
      });
      try {
        const result = await driveKiroAcp({
          projectDir: project,
          prompt:
            "/aidlc build a completely separate standalone metrics dashboard " +
            "unrelated to the active work",
          timeoutMs: DRIVE_TIMEOUT_MS,
        });

        expect(result.toolCallIssues).toEqual([]);
        expect(result.stopReason).toBe("end_turn");
        const askIndex = engineAskIndex(
          result.toolCalls,
          '"ask_type":"new-work-routing"',
        );
        expect(askIndex).toBeGreaterThanOrEqual(0);
        expect(result.toolCalls.slice(askIndex + 1)).toEqual([]);
        const directive = routingDirective(result.toolCalls, askIndex);
        expectExactCompletedRendering(result.assistantText, directive);
      } finally {
        cleanupTuiProject(project);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(SKIP_REASON !== null)(
    `unselected intent: typed ask is numbered with Other and is not replaced${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const project = setupTuiProject({
        harness: "kiro",
        withState: "state-mid-ideation.md",
      });
      seedSecondIntent(project);
      rmSync(
        join(
          project,
          "aidlc",
          "spaces",
          "default",
          "intents",
          "active-intent",
        ),
        { force: true },
      );
      try {
        const result = await driveKiroAcp({
          projectDir: project,
          prompt:
            "/aidlc poc Create a tiny TypeScript command-line program that " +
            "prints Hello World.",
          timeoutMs: DRIVE_TIMEOUT_MS,
        });

        expect(result.toolCallIssues).toEqual([]);
        expect(result.stopReason).toBe("end_turn");
        const askIndex = engineAskIndex(
          result.toolCalls,
          '"available_intents":',
        );
        expect(askIndex).toBeGreaterThanOrEqual(0);
        expect(result.toolCalls.slice(askIndex + 1)).toEqual([]);
        const directive = routingDirective(result.toolCalls, askIndex);
        expect(directive.available_intents).toHaveLength(2);
        for (const selector of directive.available_intents ?? []) {
          expect(result.assistantText).toContain(selector);
        }
        expectExactCompletedRendering(result.assistantText, directive);
      } finally {
        cleanupTuiProject(project);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
