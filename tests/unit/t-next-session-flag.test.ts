// covers: function:parseNextFlags, subcommand:aidlc-orchestrate:next
//
// Live on Kiro IDE (Default agent): the person typed "/aidlc Build a small
// command-line notes app ...", and the agent ran `next --session <this chat's
// id>` with none of their words, copying the id SessionStart gives for Plan
// Approval's --session. `next` reads no such flag, so the pair was task text:
// the plan offer and the composer were about "--session sess_...", and the work
// was named after it. Once a line of flag-shaped tokens stopped being a
// description, the person was asked whether "--session" was a setting they
// wanted, and nothing ran, at the start of work and in the middle of a stage
// alike. A `--session <id>` before any of the person's words is now the agent's
// own argument and is not read; among their words it is still theirs.

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seededStateFile,
} from "../harness/fixtures.ts";
import { hooksHealthDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { parseNextFlags } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const SESSION_START = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const SESSION = "01995000-7a11-7000-8000-0000000052a1";
const ENV = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: SESSION,
  AIDLC_UNATTENDED: "0",
};
// Read in the raw output, where JSON escapes the quotes around the token.
const UNREAD = "I could not read";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

/** Work in progress, in this chat. */
function openWork(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8"), "utf-8");
  const sessions = join(proj, "aidlc", ".aidlc-sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, ".current-session"), `${SESSION}\n`, "utf-8");
  return proj;
}

/** No work yet; the person's chat runs AI-DLC's hooks. */
function emptyProject(): string {
  const proj = createTestProject();
  created.push(proj);
  removeWorkspaceRecord(proj);
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  return proj;
}

function next(proj: string, args: string[]): { directive: Record<string, unknown>; out: string } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, ...ENV } });
  expect(result.directive, result.out).not.toBeNull();
  return { directive: result.directive as Record<string, unknown>, out: result.out };
}

describe("t-next-session-flag: how next reads a --session", () => {
  test("alone, it is not a setting the person typed and not a description", () => {
    const parsed = parseNextFlags(["--session", SESSION]);
    expect(parsed.intent).toBeUndefined();
    expect(parsed.unreadSetting).toBeUndefined();
    expect(parsed.parseError).toBeUndefined();
  });

  test("before the person's words, only their words are the request", () => {
    expect(parseNextFlags(["--session", SESSION, "Build a small notes app"]).intent).toBe("Build a small notes app");
    expect(parseNextFlags(["--scope", "express", "--session", SESSION, "Build a small notes app"]).intent)
      .toBe("Build a small notes app");
  });

  test("among the person's words, or after --, it is one of their words", () => {
    expect(parseNextFlags(["add", "a", "--session", "timeout", "option"]).intent).toBe("add a --session timeout option");
    expect(parseNextFlags(["--", "--session", "timeout"]).intent).toBe("--session timeout");
  });
});

describe("t-next-session-flag: what the step is", () => {
  test("with work in progress, the step a bare next gives", () => {
    const plain = next(openWork(), []).directive;
    const withSession = next(openWork(), ["--session", SESSION]);
    expect(withSession.out).not.toContain(UNREAD);
    expect(withSession.directive.kind).toBe(plain.kind);
    expect(withSession.directive.stage).toBe(plain.stage);
  });

  test("with no work yet and nothing else on the line, the agent is sent back for the person's words", () => {
    const { directive, out } = next(emptyProject(), ["--session", SESSION]);
    expect(out).not.toContain(UNREAD);
    expect(out).not.toContain("No workflow state found");
    expect(directive.kind, out).toBe("print");
    // Nothing for the person: the agent runs `next` again with what they typed.
    expect(directive.narration).toBeUndefined();
    const message = String(directive.message);
    expect(message).toMatch(/Run `[^`]*aidlc-orchestrate\.ts next "<what the person typed after \/aidlc, word for word>"` now/);
    expect(message).toMatch(/if they typed nothing after it, run `[^`]*aidlc-orchestrate\.ts next`\.$/);
  });

  test("with no work yet and the person's words after it, the plan question is about their words", () => {
    const { directive, out } = next(emptyProject(), ["--session", SESSION, "Build a small notes app"]);
    expect(directive.kind, out).toBe("ask");
    expect(String(directive.question)).toContain('"Build a small notes app"');
    expect(out).not.toContain("--session");
  });
});

describe("t-next-session-flag: the session line at the start of a chat", () => {
  test("says the id goes only where a command asks for --session, never on next", () => {
    const proj = createTestProject();
    created.push(proj);
    const fired = Bun.spawnSync({
      cmd: [BUN, SESSION_START],
      stdin: new TextEncoder().encode(
        JSON.stringify({ hook_event_name: "SessionStart", session_id: SESSION, source: "startup", cwd: proj }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const context = String((JSON.parse(new TextDecoder().decode(fired.stdout).trim()) as { additionalContext?: unknown })
      .additionalContext);
    expect(context).toContain(
      `AIDLC Runtime Session: ${SESSION}\nUse this exact value for any Plan Approval --session argument in this ` +
        "conversation. It goes only on a command that asks for --session, never on next.",
    );
  });
});
