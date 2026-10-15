// covers: hook:aidlc-record-human-turn, function:terminalCommandRelay
//
// /aidlc --help is answered by the prompt hook on every harness whose prompt
// hook can hand the agent context: the hook puts the help in front of the agent
// with the person's message, so the agent shows it with no command to run.
// Before, the agent ran the engine's `next --help`, which told it to run the
// help command, and only then printed the help: two commands before the person
// saw anything, and once on macOS no command at all within 12.5 s (t23).
//
// Kiro CLI and Kiro IDE already did this in their own prompt hooks; the help
// still reaches their agent once, not twice. Cursor's and Copilot's prompt hooks
// cannot hand the agent context, so their agent runs the help as before.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject, REPO_ROOT, removeWorkspaceRecord } from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { hooksHealthDir, writeSessionPidEntry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const SESSION = "01995000-7a11-7000-8000-00000000c0de";
const HELP_HEADER = "AI-DLC - AI-Driven Development Life Cycle";

const created: string[] = [];
afterEach(() => {
  for (const proj of created.splice(0)) cleanupTestProject(proj);
});

// Each harness's prompt hook, as its install ships it, and the words its person
// types for help.
const HOOKS = [
  { harness: "claude", dir: ".claude", script: "tools/aidlc.ts", target: ["engine", "hook", "record-human-turn"], event: "UserPromptSubmit", entry: "/aidlc" },
  { harness: "codex", dir: ".codex", script: "hooks/aidlc-codex-adapter.ts", target: ["record-human-turn"], event: "UserPromptSubmit", entry: "$aidlc" },
  { harness: "kiro", dir: ".kiro", script: "hooks/aidlc-kiro-adapter.ts", target: ["verb-intercept"], event: "userPromptSubmit", entry: "/aidlc" },
  { harness: "kiro-ide", dir: ".kiro", script: "hooks/aidlc-kiro-adapter.ts", target: ["person-message"], event: "UserPromptSubmit", entry: "/aidlc" },
] as const;

function env(proj: string): NodeJS.ProcessEnv {
  return {
    ...testGuardEnvironment(process.env, "production"),
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
    USER_PROMPT: undefined,
    CODEX_THREAD_ID: undefined,
    CODEX_SESSION_ID: undefined,
  };
}

// What the hook hands the agent: the context of a JSON reply, or plain stdout
// where that is the host's context channel (Kiro CLI).
function agentContext(stdout: string): string {
  const texts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as { additionalContext?: unknown; hookSpecificOutput?: { additionalContext?: unknown } };
      const text = parsed.hookSpecificOutput?.additionalContext ?? parsed.additionalContext;
      if (typeof text === "string") texts.push(text);
    } catch {
      texts.push(line);
    }
  }
  return texts.join("\n");
}

function prompted(hook: (typeof HOOKS)[number], prompt: string, change: (proj: string) => void = () => {}): string {
  const proj = createTestProject();
  created.push(proj);
  removeWorkspaceRecord(proj);
  cpSync(join(REPO_ROOT, "dist", hook.harness, hook.dir), join(proj, hook.dir), { recursive: true });
  change(proj);
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  if (hook.harness === "codex") writeSessionPidEntry(proj, process.pid, SESSION);
  const fired = spawnSync(BUN, [join(proj, hook.dir, hook.script), ...hook.target], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: hook.event,
      session_id: SESSION,
      cwd: proj,
      prompt,
      ...(hook.harness === "codex" ? { turn_id: "t1" } : {}),
    }),
    env: env(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(fired.status, `${hook.harness}: ${fired.stdout}${fired.stderr}`).toBe(0);
  return agentContext(fired.stdout ?? "");
}

const count = (text: string, part: string): number => text.split(part).length - 1;

describe("t-help-from-prompt-hook: the prompt hook hands the agent the help", () => {
  for (const hook of HOOKS) {
    for (const words of ["--help", "help", "-h"]) {
      test(`${hook.harness}: ${hook.entry} ${words} puts the help in front of the agent once`, () => {
        const context = prompted(hook, `${hook.entry} ${words}`);
        expect(count(context, HELP_HEADER), context.slice(0, 600)).toBe(1);
        // The usage line names the entry the person types on this harness.
        expect(context).toContain(`Usage: ${hook.entry} [command]`);
      });
    }

    test(`${hook.harness}: a request for work carries no help`, () => {
      const context = prompted(hook, `${hook.entry} build a notes app with help pages`);
      expect(context).not.toContain(HELP_HEADER);
    });

    // The help of one command family is that family's own: the general help
    // never stands in for it where this hook answers help (Kiro's own prompt
    // hook runs each family's command itself).
    const families = hook.harness === "claude" || hook.harness === "codex"
      ? ["knowledge help", "knowledge -h", "knowledge --help"]
      : [];
    for (const family of families) {
      test(`${hook.harness}: ${hook.entry} ${family} is not answered with the general help`, () => {
        const context = prompted(hook, `${hook.entry} ${family}`);
        expect(context).not.toContain(HELP_HEADER);
      });
    }
  }
});

describe("t-help-from-prompt-hook: a help too long for the host is left to the agent", () => {
  // A team's own plans are listed in the help; enough of them make it longer
  // than Claude Code keeps of a hook's line, and a cut help is no help.
  test("claude: with the help grown past what the host keeps, the hook hands nothing over", () => {
    const claude = HOOKS[0];
    let helpChars = 0;
    const context = prompted(claude, "/aidlc --help", (proj) => {
      const scopes = join(proj, ".claude", "scopes");
      const poc = readFileSync(join(scopes, "aidlc-poc.md"), "utf-8");
      for (let i = 0; i < 40; i++) {
        const name = `teamplan${String(i).padStart(2, "0")}`;
        writeFileSync(join(scopes, `aidlc-${name}.md`), poc
          .replace(/^name: poc$/m, `name: ${name}`)
          .replace(/^keywords:\n(?: {2}- .*\n)+/m, `keywords:\n  - ${name} work\n`)
          .replace(/^description: .*$/m, `description: ${"A plan the team keeps for one kind of work. ".repeat(3)}`));
      }
      const help = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc-utility.ts"), "help"], {
        cwd: proj,
        env: env(proj),
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(help.stdout).toContain("teamplan39");
      helpChars = help.stdout.length;
    });
    expect(helpChars).toBeGreaterThan(10_000);
    expect(context).not.toContain(HELP_HEADER);
  });
});
