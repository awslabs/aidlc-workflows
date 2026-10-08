// covers: file:skills/aidlc/SKILL.md, subcommand:aidlc-orchestrate:next
//
// Native Windows Kiro ACP proof for the two P3 routing shapes:
//   1. active intent + unrelated prose -> typed new-work-routing ask;
//   2. unselected intent clone + unrelated scoped prose -> the same typed ask
//      with engine-listed available_intents.
//
// In both cases the engine ask is the final tool result of the turn and Kiro
// renders numbered prose with Other. The active-intent case then proves the
// full Other response contract across two more turns: bare 4 requests details
// without a tool, and the substantive answer returns unchanged through next.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, fileCleanupReserveMs, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import {
  AcpSession,
  decodeKiroOrchestrateInvocation,
  driveKiroAcp,
  findKiroOrchestrateNextCall,
} from "../harness/kiro-acp-drive.ts";
import {
  cleanupTuiProject,
  KIRO_SRC,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);
let caseDeadlineMs: number;
beforeEach(() => { caseDeadlineMs = Date.now() + TEST_TIMEOUT_MS; });
function remainingWorkMs(): number {
  return remainingOperationTimeoutMs(TEST_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS),
    phase: "E2E live work",
  })!;
}

const OTHER_DETAIL_PROMPT = "What would you like me to do instead?";
const ALTERNATIVE =
  "Treat this as a documentation update for the active work instead.";

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro routing proof (uses Kiro credits)";
  }
  if (platform() !== "win32") {
    return "this acceptance test is native-Windows-only";
  }
  if (completedStartupProbe(spawnSync("kiro-cli", ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "kiro-cli not found";
  }
  if (completedStartupProbe(spawnSync("kiro-cli", ["whoami"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
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
  return findKiroOrchestrateNextCall(calls, outputNeedle);
}

interface RoutingDirective {
  kind: "ask";
  ask_type: "new-work-routing";
  response_route: "next";
  numbered_prose_question: string;
  new_work_description: string;
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

function visibleMarkdown(text: string): string {
  return text
    .replaceAll("**", "")
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim();
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
    { timeout: remainingWorkMs(), cwd: project, encoding: "utf-8" },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

describe("t-acp-kiro-new-work-routing (live engine-ask authority)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `active intent: Other requests details, then forwards the alternative through next${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const project = setupTuiProject({
        harness: "kiro",
        withState: "state-mid-ideation.md",
      });
      const session = new AcpSession(project, "aidlc", true);
      try {
        const first = await driveKiroAcp({
          projectDir: project,
          session,
          prompt:
            "/aidlc build a completely separate standalone metrics dashboard " +
            "unrelated to the active work",
          timeoutMs: remainingWorkMs(),
          keepAlive: true,
        });

        expect(first.toolCallIssues).toEqual([]);
        expect(first.stopReason).toBe("end_turn");
        const askIndex = engineAskIndex(
          first.toolCalls,
          '"ask_type":"new-work-routing"',
        );
        expect(askIndex).toBeGreaterThanOrEqual(0);
        expect(first.toolCalls.slice(askIndex + 1)).toEqual([]);
        const directive = routingDirective(first.toolCalls, askIndex);
        expectExactCompletedRendering(first.assistantText, directive);

        const other = await driveKiroAcp({
          projectDir: project,
          session,
          prompt: "4",
          timeoutMs: remainingWorkMs(),
          keepAlive: true,
        });
        expect(other.toolCallIssues).toEqual([]);
        expect(other.stopReason).toBe("end_turn");
        expect(other.toolCalls).toEqual([]);
        expect(visibleMarkdown(other.assistantText)).toBe(OTHER_DETAIL_PROMPT);

        const alternative = await driveKiroAcp({
          projectDir: project,
          session,
          prompt: ALTERNATIVE,
          timeoutMs: remainingWorkMs(),
          keepAlive: true,
        });
        expect(alternative.toolCallIssues).toEqual([]);
        expect(alternative.stopReason).toBe("end_turn");
        const invocations = alternative.toolCalls.map(decodeKiroOrchestrateInvocation);
        expect(invocations.some((invocation) => invocation?.verb === "report")).toBe(false);
        const nextCalls = invocations.filter((invocation) =>
          invocation?.verb === "next"
        );
        expect(nextCalls).toHaveLength(1);
        expect(nextCalls[0]?.args.join(" ")).toBe(ALTERNATIVE);
        const alternativeAskIndex = engineAskIndex(
          alternative.toolCalls,
          `"new_work_description":"${ALTERNATIVE}"`,
        );
        expect(alternativeAskIndex).toBeGreaterThanOrEqual(0);
        expect(alternative.toolCalls.slice(alternativeAskIndex + 1)).toEqual([]);
        const alternativeDirective = routingDirective(
          alternative.toolCalls,
          alternativeAskIndex,
        );
        expect(alternativeDirective.response_route).toBe("next");
        expect(alternativeDirective.new_work_description).toBe(ALTERNATIVE);
        expectExactCompletedRendering(
          alternative.assistantText,
          alternativeDirective,
        );
      } finally {
        session.close();
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
          timeoutMs: remainingWorkMs(),
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
        expect(directive.response_route).toBe("next");
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
