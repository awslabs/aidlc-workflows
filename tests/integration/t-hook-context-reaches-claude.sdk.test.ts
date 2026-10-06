// covers: hook:aidlc-session-start, hook:aidlc-record-human-turn, function:hookContextLine
//
// What AI-DLC's SessionStart and UserPromptSubmit hooks tell the agent has to
// reach it on Claude Code. Claude Code reads that context only from
// hookSpecificOutput and drops a top-level additionalContext without a word,
// so for a long time a new chat never learned its own Runtime Session id, the
// state of the work, or a switched-off check. Each case asks the agent to echo
// what its context says through one Bash call and asserts on that tool result,
// never on the agent's prose. SPENDS TOKENS.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fileCleanupReserveMs,
  liveCaseTimeoutMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, createTestProject, setupIntegrationProject } from "../harness/fixtures.ts";
import { type DriveResult, driveAidlc } from "../harness/sdk-drive.ts";

const WORK_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(WORK_TIMEOUT_MS);

function echoed(result: DriveResult): string {
  return result.toolResults
    .filter((item) => item.toolName === "Bash" && /^\s*echo\b/.test(String(item.input.command ?? "")))
    .map((item) => item.resultText)
    .join("\n");
}

describe("hook context reaches the agent on Claude Code (SDK live)", () => {
  test("a new chat learns its Runtime Session id from the shipped session-start hook", async () => {
    const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
    const project = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
    try {
      const result = await driveAidlc(
        "Your session context may hold a line that starts with 'AIDLC Runtime Session:'. " +
          "Run exactly one Bash command: echo followed by the value after that label, " +
          "or echo NONE if your context holds no such line. Do nothing else.",
        {
          projectDir: project,
          timeoutMs: remainingOperationTimeoutMs(WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
        },
      );
      const session = String(result.resultEvent?.raw.session_id ?? "");
      expect(session).toMatch(/^[0-9a-f-]{36}$/);
      expect(echoed(result)).toContain(session);
    } finally {
      cleanupTestProject(project);
    }
  }, TEST_TIMEOUT_MS);

  test("the context line reaches the agent from SessionStart and from UserPromptSubmit", async () => {
    const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
    const project = createTestProject();
    const words = { SessionStart: `PELICAN${Date.now() % 100_000}`, UserPromptSubmit: `HERON${Date.now() % 100_000}` };
    try {
      // Each hook prints the line through the same owner the shipped hooks use.
      const hooks = join(project, ".claude", "hooks");
      mkdirSync(hooks, { recursive: true });
      const settings: Record<string, unknown[]> = {};
      for (const [event, word] of Object.entries(words)) {
        writeFileSync(
          join(hooks, `${event}.ts`),
          `import { hookContextLine } from ${JSON.stringify(join(AIDLC_SRC, "tools", "aidlc-lib.ts"))};\n` +
            `process.stdout.write(hookContextLine(${JSON.stringify(event)}, ${
              JSON.stringify(`The ${event} secret word for this chat is ${word}.`)
            }));\n`,
        );
        settings[event] = [{
          hooks: [{ type: "command", command: `bun "$CLAUDE_PROJECT_DIR/.claude/hooks/${event}.ts"` }],
        }];
      }
      writeFileSync(join(project, ".claude", "settings.json"), `${JSON.stringify({ hooks: settings }, null, 2)}\n`);
      const result = await driveAidlc(
        "Your context may give a SessionStart secret word and a UserPromptSubmit secret word. " +
          "Run exactly one Bash command: echo followed by the two words, SessionStart's first, " +
          "writing NONE for any word your context does not give. Do nothing else.",
        {
          projectDir: project,
          timeoutMs: remainingOperationTimeoutMs(WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
        },
      );
      expect(echoed(result)).toContain(words.SessionStart);
      expect(echoed(result)).toContain(words.UserPromptSubmit);
    } finally {
      cleanupTestProject(project);
    }
  }, TEST_TIMEOUT_MS);
});
