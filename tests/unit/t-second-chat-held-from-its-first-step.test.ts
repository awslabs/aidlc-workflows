// covers: function:classifyFirstContact, function:chatAwaitsFirstStep, function:chatTookStep,
// function:hookOutsideGate, function:mutationBlockReason, subcommand:aidlc-orchestrate:next
//
// A second chat opened on a project folder while the work there sits at Code
// Generation with no plan (#3204). It follows this machine's cursor onto that
// work, so `/aidlc` in it carries on the same stage with nothing asked; but the
// work's checks hold it only from its first AI-DLC step, on the hosts whose
// commands name the chat they run in (Claude Code, Codex, Kiro CLI, opencode).
// Until then a read the plan guard cannot read runs there as in a folder with
// no workflow. Cursor, Copilot and Kiro IDE commands find their chat only
// through the process tree, so there the chat is held from the start, as
// before; a worktree of this checkout or a Unit claimed here holds it from the
// start everywhere. A shell command the guard could not read is refused in
// words that say so, apart from a write, with the way a read gets through.
//
// Each host's own tree runs its SessionStart and its tool-call hook
// (tests/harness/code-generation-states.ts SHAPES); the chat's step is `next`
// with the chat named the way that host names it in the agent's shell.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, DEFAULT_RECORD_DIR, intentsDirOf, runOrchestrateNext } from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  createCodeGenerationProject,
  DEVELOPER,
  next,
  type Shape,
  SHAPES,
} from "../harness/code-generation-states.ts";
import { readSessionBinding } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(600_000);

const SECOND = "01995000-7a11-7000-8000-0000000000b2";
const READS = [
  `python3 -B -c "import pathlib; print(pathlib.Path('src/base.ts').read_text())"`,
  `for f in src/base.ts; do cat "$f"; done`,
  `F=src/base.ts; cat "$F"`,
];
/** The hosts whose agent commands name the chat they run in. */
const NAMING = ["claude", "codex", "kiro", "opencode"];
const HOST_CHAT_VARIABLES = {
  AIDLC_HARNESS_DIR: undefined,
  AIDLC_HARNESS_NAME: undefined,
  AIDLC_SESSION_OVERRIDE: undefined,
  AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
  CLAUDECODE: undefined,
  CLAUDE_CODE_SESSION_ID: undefined,
  CLAUDE_PID: undefined,
  CODEX_THREAD_ID: undefined,
  KIRO_SESSION_ID: undefined,
  OPENCODE: undefined,
};

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function shape(name: string): Shape {
  const found = SHAPES.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no shape ${name}`);
  return found;
}

// The first chat's work at Code Generation with no plan, the stage's step
// issued to it, and this machine's cursor naming the work (it created it).
function workAtCodeGeneration(host: Shape, policy: "strict" | "off"): string {
  const proj = createCodeGenerationProject(policy, "off");
  created.push(proj);
  host.install(proj);
  expect(next(proj).stage).toBe("code-generation");
  writeFileSync(join(intentsDirOf(proj), "active-intent"), `${DEFAULT_RECORD_DIR}\n`);
  return proj;
}

function spawnTree(proj: string, argv: string[], input: string | undefined, extra: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, argv, {
    cwd: proj,
    input,
    env: { ...process.env, ...HOST_CHAT_VARIABLES, AIDLC_UNATTENDED: "0", AIDLC_PROJECT_DIR: proj, CLAUDE_PROJECT_DIR: proj, ...extra } as NodeJS.ProcessEnv,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// The host opens the second chat: its tree's own SessionStart.
function opensSecondChat(proj: string, host: Shape): void {
  const started = spawnTree(proj, [join(proj, host.dir, "tools", "aidlc.ts"), "engine", "hook", "session-start"],
    JSON.stringify({ hook_event_name: "SessionStart", session_id: SECOND, cwd: proj, source: "startup" }), {});
  expect(started.status, started.stderr).toBe(0);
}

// How each host names the chat in the agent's own shell.
function chatVariables(host: string): NodeJS.ProcessEnv {
  switch (host) {
    case "claude": return { CLAUDE_CODE_SESSION_ID: SECOND, CLAUDE_PID: String(process.pid) };
    case "codex": return { CODEX_THREAD_ID: SECOND };
    case "kiro": return { KIRO_SESSION_ID: SECOND };
    case "opencode": return { AIDLC_SESSION_OVERRIDE: SECOND, AIDLC_SESSION_OVERRIDE_SOURCE: "payload", OPENCODE: "1" };
    default: return {};
  }
}

// The second chat's `next`, as its agent runs it.
function secondChatNext(proj: string, host: Shape, args: string[] = []) {
  const run = runOrchestrateNext(join(proj, host.dir, "tools", "aidlc-orchestrate.ts"), proj, args, {
    cwd: proj,
    env: { ...process.env, ...HOST_CHAT_VARIABLES, AIDLC_UNATTENDED: "0", AIDLC_PROJECT_DIR: proj, CLAUDE_PROJECT_DIR: proj, ...chatVariables(host.name) },
  });
  expect(run.status, run.out).toBe(0);
  return run.directive as Record<string, unknown>;
}

async function reads(proj: string, host: Shape): Promise<Array<{ command: string; code: number; said: string }>> {
  const verdicts = [];
  for (const command of READS) {
    const verdict = await host.call(proj, SECOND, { tool: "Bash", command });
    verdicts.push({ command, code: verdict.code, said: verdict.said });
  }
  return verdicts;
}

describe("a second chat on the work the cursor names", () => {
  for (const name of NAMING) {
    for (const policy of ["off", "strict"] as const) {
      test(`[${name}] under Guard Policy ${policy}, its reads run until its first step, and are held from it`, async () => {
        const host = shape(name);
        const proj = workAtCodeGeneration(host, policy);
        opensSecondChat(proj, host);
        for (const verdict of await reads(proj, host)) expect(verdict, verdict.said).toMatchObject({ code: 0 });
        expect(readSessionBinding(proj, SECOND)).toMatchObject({ intent: DEFAULT_RECORD_DIR, source: "cursor-followed" });

        // A read-only `next` (status) is no step.
        secondChatNext(proj, host, ["--status"]);
        expect(readSessionBinding(proj, SECOND)?.source).toBe("cursor-followed");

        // `/aidlc` carry on: the same stage, nothing asked.
        const step = secondChatNext(proj, host);
        expect(step.kind, JSON.stringify(step)).toBe("run-stage");
        expect(step.stage).toBe("code-generation");
        expect(readSessionBinding(proj, SECOND)).toMatchObject({ intent: DEFAULT_RECORD_DIR, source: "cursor" });
        for (const verdict of await reads(proj, host)) {
          expect(verdict.code, verdict.command).toBe(2);
          expect(verdict.said).toContain("could not be read");
        }
      });
    }
  }

  for (const name of ["cursor", "copilot", "kiro-ide"]) {
    test(`[${name}] its commands cannot name the chat, so it is held from the start, as before`, async () => {
      const host = shape(name);
      const proj = workAtCodeGeneration(host, "off");
      opensSecondChat(proj, host);
      expect(readSessionBinding(proj, SECOND)).toMatchObject({ intent: DEFAULT_RECORD_DIR, source: "cursor" });
      for (const verdict of await reads(proj, host)) expect(verdict.code, verdict.command).toBe(2);
    });
  }

  test("a Unit claimed on this machine holds it from the start", async () => {
    const host = shape("claude");
    const proj = workAtCodeGeneration(host, "off");
    const registry = JSON.parse(readFileSync(join(intentsDirOf(proj), "intents.json"), "utf-8")) as Array<{ uuid: string; dirName: string }>;
    const uuid = registry.find((row) => row.dirName === DEFAULT_RECORD_DIR)?.uuid ?? "";
    expect(uuid).not.toBe("");
    writeFileSync(join(proj, "aidlc", ".aidlc-unit-scope.json"), JSON.stringify({
      version: 1, space: "default", intent_uuid: uuid, intent_id8: uuid.slice(-8), unit: "u1",
      owner: "me", generation: 1, nonce: "n", claim_ref: "r", claim_oid: "o", claimed_from_oid: "f",
      integration_ref: "i", gate_rhythm: "per-stage",
    }));
    opensSecondChat(proj, host);
    expect(readSessionBinding(proj, SECOND)?.source).toBe("cursor-followed");
    for (const verdict of await reads(proj, host)) expect(verdict.code, verdict.command).toBe(2);
  });

  test("this checkout's own worktree record holds it from the start", async () => {
    const host = shape("claude");
    const proj = workAtCodeGeneration(host, "off");
    spawnSync("git", ["init", "-q"], { cwd: proj });
    const common = realpathSync(join(proj, ".git")).replace(/\\/g, "/");
    const key = process.platform === "win32" ? common.toLowerCase() : common;
    mkdirSync(join(proj, ".aidlc"), { recursive: true });
    writeFileSync(join(proj, ".aidlc", "worktree-meta.json"), JSON.stringify({
      version: 1, intentRecord: `aidlc/spaces/default/intents/${DEFAULT_RECORD_DIR}`,
      gitCommonDirHash: createHash("sha256").update(key).digest("hex"),
    }));
    opensSecondChat(proj, host);
    expect(readSessionBinding(proj, SECOND)?.source).toBe("cursor-followed");
    for (const verdict of await reads(proj, host)) expect(verdict.code, verdict.command).toBe(2);
  });

  test("before that step, a system package install nobody asked for still waits for the person", async () => {
    const host = shape("claude");
    const proj = workAtCodeGeneration(host, "off");
    opensSecondChat(proj, host);
    const install = await host.call(proj, SECOND, { tool: "Bash", command: "sudo apt-get install -y python3-pytest" });
    expect(install.code).toBe(2);
    expect(install.said).toContain("installs a system package on this machine");
  });

  test("its developer dispatch before that step meets the plan, as any chat on the work does", async () => {
    const host = shape("claude");
    const proj = workAtCodeGeneration(host, "off");
    opensSecondChat(proj, host);
    const dispatch = await host.call(proj, SECOND, { tool: "Task", agent: DEVELOPER, prompt: "AIDLC-STAGE: code-generation\nBuild it." });
    expect(dispatch.code).toBe(2);
    expect(dispatch.said).not.toContain("has not joined");
    expect(dispatch.said).toContain("Code generation cannot start");
  });
});

describe("the refusal of a command the guard could not read", () => {
  // The working chat itself: the one that holds the stage's step.
  function guard(proj: string, command: string, powerShell = false) {
    return spawnTree(proj, [join(proj, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], JSON.stringify({
      hook_event_name: "PreToolUse", cwd: proj, tool_name: "Bash", tool_input: { command },
      ...(powerShell ? { aidlc_shell: "powershell" } : {}),
    }), {});
  }

  test("says it could not be read, apart from a write, and the read it names runs", () => {
    const proj = workAtCodeGeneration(shape("claude"), "strict");
    const unread = guard(proj, READS[0]);
    expect(unread.status).toBe(2);
    expect(unread.stderr).toContain("This shell command could not be read");
    expect(unread.stderr).not.toContain("mutation-capable");
    expect(unread.stderr).toContain("`cat src/app.ts`");
    const write = guard(proj, "echo hi > src/x.ts");
    expect(write.status).toBe(2);
    expect(write.stderr).toContain("cannot modify workspace paths");
    expect(write.stderr).not.toContain("could not be read");
    for (const powerShell of [false, true]) {
      expect(guard(proj, "cat src/app.ts", powerShell).status).toBe(0);
      expect(guard(proj, "$f = 'src/base.ts'; Get-Content $f", powerShell).stderr).toContain("This shell command could not be read");
    }
  });
});
