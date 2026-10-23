// covers: file:core/tools/aidlc-lock-line.ts, function:takeActiveDirectiveReleaseHeld
//
// A program that holds the project's folders open (on Windows, a dev server's
// file watcher such as Vite's) can stop AI-DLC from moving its active-directive
// lock folder. The fault hooks stand in for it here, as the measure on Windows
// Server showed it: the release rename of a held lock fails, and so does the
// next process's rename of the dead holder's folder.
//
//   - the next process gives up within its budget (plus one round), not after
//     hours, and says the folder is held; a live owner, or an owner whose process
//     generation cannot be read, keeps today's words;
//   - a release that spent its budget is retried once, briefly, after that: at
//     the process's exit and at the next transaction, which throws the held kind;
//   - the plan-approval guard: Guard Policy off and relaxed go on with one line,
//     said once a turn and again on the next turn, and leave no row claiming a
//     start that was not published; strict refuses with the line, and once the
//     program stops the same write goes through and `next` moves on; the
//     agent's own stop command goes through under strict and starts nothing;
//   - the guard that held the lock says the line once its own call goes through;
//   - `next` and `continue` hand the agent a step that ends the turn instead of
//     "Retry ... run doctor": stop a program it started itself and run the
//     command again, else show the person the line; a second stop in the same
//     turn hands over the line, and without the Windows line today's words stay;
//   - a folder of a provably dead owner, or our own release, held for the
//     give-up time (10 s) is given up early; a live owner, or one of unknown
//     generation, still waits its whole budget.
// The line is Windows-only; the cases below set the Windows text through the
// line module's test seam and pin today's words without it.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  _setAuditLockFaultHooksForTests,
  ActiveDirectiveLockContendedError,
  ActiveDirectiveLockFolderHeldError,
  activeDirectiveLockHeldNote,
  readAuditShardEvents,
  stateDigest,
  takeActiveDirectiveReleaseHeld,
  withActiveDirectiveLock,
  writeActiveDirectiveMarker,
} from "../../core/tools/aidlc-lib.ts";
import {
  _setLockFolderHeldGiveUpMsForTests,
  _setLockFolderHeldPlatformForTests,
  LOCK_FOLDER_HELD_GIVE_UP_MS,
  lockFolderHeldAgentStep,
  lockFolderHeldGoesOnStep,
  lockFolderHeldLine,
} from "../../core/tools/aidlc-lock-line.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(240_000);

const BUN = process.execPath;
const LIB = join(REPO_ROOT, "core", "tools", "aidlc-lib.ts");
const BUSY = "Active-directive coordination is busy";
const PROVENANCE = `Code Generation source provenance could not be committed. ${BUSY} Repair the source or runtime/audit write problem and retry; the plan-approval setting is unchanged.`;
const SESSION = "01995000-7a11-7000-8000-0000000000b2";

const created: string[] = [];
afterEach(() => {
  _setAuditLockFaultHooksForTests(null);
  _setLockFolderHeldPlatformForTests(null);
  _setLockFolderHeldGiveUpMsForTests(null);
  while (created.length > 0) {
    const path = created.pop() as string;
    if (path.includes("aidlc-lfh-marker-")) rmSync(path, { recursive: true, force: true });
    else cleanupTestProject(path);
  }
});

function withTimeout<T>(value: string, action: () => T): T {
  const previous = process.env.AIDLC_ACTIVE_DIRECTIVE_LOCK_TIMEOUT_MS;
  process.env.AIDLC_ACTIVE_DIRECTIVE_LOCK_TIMEOUT_MS = value;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.AIDLC_ACTIVE_DIRECTIVE_LOCK_TIMEOUT_MS;
    else process.env.AIDLC_ACTIVE_DIRECTIVE_LOCK_TIMEOUT_MS = previous;
  }
}

// A workspace with one piece of work, as t161's marker project.
function markerProject(): { projectDir: string; lockDir: string; state: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-lfh-marker-"));
  created.push(projectDir);
  const recordName = "auth-deadbeef";
  const intents = join(projectDir, "aidlc", "spaces", "default", "intents");
  const recordDir = join(intents, recordName);
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(join(projectDir, "aidlc", "active-space"), "default\n");
  writeFileSync(join(intents, "active-intent"), `${recordName}\n`);
  writeFileSync(join(intents, "intents.json"), `${JSON.stringify([{
    uuid: "deadbeef-0000-7000-8000-000000000002", slug: "auth", dirName: recordName, status: "in-flight",
  }])}\n`);
  const state = "- **Current Stage**: requirements-analysis\n";
  writeFileSync(join(recordDir, "aidlc-state.md"), state);
  return { projectDir, lockDir: join(recordDir, ".aidlc-engine", "active-directive.lock"), state };
}

function writeMarker(projectDir: string, state: string): void {
  writeActiveDirectiveMarker(projectDir, { kind: "run-stage", stage: "requirements-analysis", state_sha256: stateDigest(state) });
}

// The lock left by a holder that has exited.
function seedDeadOwner(lockDir: string): void {
  const token = randomUUID();
  mkdirSync(join(lockDir, token), { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
    pid: 2_000_000_000, startedAtMs: 0, reapLiveOwnerAfterStale: true, token,
  }));
}

function seedOwner(lockDir: string, pid: number): void {
  const token = randomUUID();
  mkdirSync(join(lockDir, token), { recursive: true });
  writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
    pid, startedAtMs: Math.floor(performance.timeOrigin + performance.now()), reapLiveOwnerAfterStale: true, token,
  }));
}

const WINDOWS_HELD = lockFolderHeldLine("stopped", 300_000, "win32");
const WINDOWS_GOES_ON = lockFolderHeldLine("goes-on", 300_000, "win32");
// The guard cases run at a 300 ms budget, so each step waits about that long.
const GUARD_GOES_ON = lockFolderHeldLine("goes-on", 300, "win32");
// A guard whose own call went through, then could not move the folder.
const GUARD_WENT_THROUGH = lockFolderHeldLine("went-through", 300, "win32");
// Where an engine command stopped: the agent stops a program it, or an agent it
// sent (Code Generation's developer), left running and runs the command again;
// the person hears the line only when neither started one, or when the step
// stops again in the same turn.
const STOP_YOURS =
  "A program is holding the project folder, so this step stopped. If you, or an agent you sent, started a dev " +
  "server, a file watcher or another long-running program over the project in this conversation, and the person did " +
  "not ask to keep it running, stop it and everything it started (on Windows, stopping an npx or npm parent leaves " +
  "the server running: stop the whole process tree by its Windows process id, for example " +
  "`taskkill //T //F //PID <pid>` in Git Bash, or the node process whose command line names the server), then run " +
  "the same command again.";
const AGENT_STEP = `${STOP_YOURS} If neither of you started one, show the person this line and end your turn: "${WINDOWS_HELD}"`;
// Where no chat reaches the engine to count the turn's stops, the words bound the retry.
const AGENT_STEP_UNCOUNTED = `${STOP_YOURS} If neither of you started one, or the step stops again after it was stopped, ` +
  `show the person this line and end your turn: "${WINDOWS_HELD}"`;
const PERSON_STEP = `Show the person this line and end your turn: "${WINDOWS_HELD}"`;
// Where the guard lets the call go on: the same step around the go-on or
// went-through line, with no command to run again.
const GOES_ON_STOP =
  "A program is holding the project folder, so AI-DLC cannot update its record of this work and each step waits on " +
  "it; this call goes ahead. If you, or an agent you sent, started a dev server, a file watcher or another " +
  "long-running program over the project in this conversation, and the person did not ask to keep it running, stop " +
  "it and everything it started (on Windows, stopping an npx or npm parent leaves the server running: stop the whole " +
  "process tree by its Windows process id, for example `taskkill //T //F //PID <pid>` in Git Bash, or the node " +
  "process whose command line names the server), then carry on.";
const goesOnStep = (line: string | null) =>
  `${GOES_ON_STOP} If neither of you started one, tell the person this line once and carry on: "${line}"`;
// On Claude Code the agent reads a PreToolUse hook's additionalContext on a call
// that goes on, and the person reads its systemMessage.
const toAgent = (step: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: step } });
const toPerson = (line: string | null) => JSON.stringify({ systemMessage: line });

describe("the lock line", () => {
  test("says what the person meets, on Windows only", () => {
    expect(WINDOWS_HELD).toBe(
      "A program is watching the project folder (most likely a dev server or a test watcher still running), so AI-DLC " +
        "cannot update its record of this work. Stop that program and the work goes on.",
    );
    expect(WINDOWS_GOES_ON).toBe(
      "A program is watching the project folder (most likely a dev server or a test watcher still running), so AI-DLC " +
        "cannot update its record of this work and each step waits about 5 minutes. Stop that program and the work " +
        "goes back to normal.",
    );
    expect(lockFolderHeldLine("goes-on", 2_000, "win32")).toContain("each step waits about 2 seconds.");
    // The step that went through says so, and what the next one meets.
    expect(lockFolderHeldLine("went-through", 10_000, "win32")).toBe(
      "A program is watching the project folder (most likely a dev server or a test watcher still running). This " +
        "step went through, but AI-DLC cannot update its record of this work after it, and each step waits about 10 " +
        "seconds. Stop that program and the work goes back to normal.",
    );

    expect(lockFolderHeldLine("goes-on", 90_000, "win32")).toContain("each step waits about 2 minutes.");
    for (const platform of ["linux", "darwin"] as const) {
      for (const outcome of ["stopped", "goes-on", "went-through"] as const) {
        expect(lockFolderHeldLine(outcome, 300_000, platform)).toBeNull();
      }
    }
  });

  test("gives the agent its step around the person's line, which stays as it is", () => {
    const line = WINDOWS_HELD as string;
    expect(lockFolderHeldAgentStep(line, "first")).toBe(AGENT_STEP);
    expect(lockFolderHeldAgentStep(line, "again")).toBe(PERSON_STEP);
    expect(lockFolderHeldAgentStep(line, "uncounted")).toBe(AGENT_STEP_UNCOUNTED);
    for (const step of [AGENT_STEP, PERSON_STEP, AGENT_STEP_UNCOUNTED]) expect(step).toEndWith(`"${line}"`);
    expect(lockFolderHeldGoesOnStep(GUARD_GOES_ON as string)).toBe(goesOnStep(GUARD_GOES_ON));
    expect(lockFolderHeldGoesOnStep(GUARD_WENT_THROUGH as string)).toBe(goesOnStep(GUARD_WENT_THROUGH));
  });
});

describe("giving up on a held folder", () => {
  test("is ten seconds, and the line says so at the default budget", () => {
    expect(LOCK_FOLDER_HELD_GIVE_UP_MS).toBe(10_000);
    _setLockFolderHeldPlatformForTests("win32");
    withTimeout("", () => {
      expect(activeDirectiveLockHeldNote()).toBe(lockFolderHeldLine("goes-on", 10_000, "win32"));
      expect(activeDirectiveLockHeldNote()).toContain("each step waits about 10 seconds.");
    });
  });

  // The time cases count rounds of 101 refused renames, not milliseconds: a
  // round is half a second on Linux, 1.4 s on Windows and 2.8 s on a loaded
  // macOS runner, and the lock checks its budget and the give-up between rounds.
  test("a provably dead owner's folder held for the give-up time is given up before the budget", () => {
    _setLockFolderHeldGiveUpMsForTests(300);
    const fixture = markerProject();
    seedDeadOwner(fixture.lockDir);
    let rounds = 0;
    _setAuditLockFaultHooksForTests({ failReapRename: (_path, attempt) => { if (attempt === 0) rounds++; return true; } });
    const started = performance.now();
    withTimeout("30000", () => {
      expect(() => writeMarker(fixture.projectDir, fixture.state)).toThrow(ActiveDirectiveLockFolderHeldError);
    });
    // The round that finds the folder held and the first one past the give-up;
    // the 30 s budget has room for dozens.
    expect(rounds).toBeLessThanOrEqual(2);
    expect(performance.now() - started).toBeLessThan(30_000);
  });

  test("our own release held for the give-up time stops before the budget", () => {
    _setLockFolderHeldGiveUpMsForTests(300);
    const fixture = markerProject();
    writeMarker(fixture.projectDir, fixture.state);
    let rounds = 0;
    const refuse = (_path: string, attempt: number) => { if (attempt === 0) rounds++; return true; };
    _setAuditLockFaultHooksForTests({ failReleaseRename: refuse, failGateReleaseRename: refuse });
    const started = performance.now();
    withTimeout("30000", () => withActiveDirectiveLock(fixture.projectDir, () => null));
    // The gate's release as the lock is taken, then the release's retries of it
    // up to the first one past the give-up.
    expect(rounds).toBeLessThanOrEqual(3);
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(takeActiveDirectiveReleaseHeld()).toBe(true);
    _setAuditLockFaultHooksForTests(null);
    withActiveDirectiveLock(fixture.projectDir, () => null);
    expect(existsSync(fixture.lockDir)).toBe(false);
  });

  test("a live owner, or one of unknown generation, still waits its whole budget", () => {
    _setLockFolderHeldGiveUpMsForTests(100);
    for (const unknownGeneration of [false, true]) {
      const fixture = markerProject();
      seedOwner(fixture.lockDir, unknownGeneration ? 2_000_000_001 : process.pid);
      if (unknownGeneration) {
        _setAuditLockFaultHooksForTests({ processProbe: () => ({ alive: true, generation: null }), failReapRename: () => true });
      }
      const started = performance.now();
      withTimeout("1200", () => {
        expect(() => writeMarker(fixture.projectDir, fixture.state)).toThrow(BUSY);
      });
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_150);
      _setAuditLockFaultHooksForTests(null);
    }
  });
});

describe("a lock folder a program holds", () => {
  test("the next process gives up within its budget and says the folder is held", () => {
    _setLockFolderHeldPlatformForTests("win32");
    const fixture = markerProject();
    seedDeadOwner(fixture.lockDir);
    let rounds = 0;
    _setAuditLockFaultHooksForTests({ failReapRename: (_path, attempt) => { if (attempt === 0) rounds++; return true; } });
    let thrown: unknown = null;
    withTimeout("200", () => {
      try { writeMarker(fixture.projectDir, fixture.state); } catch (error) { thrown = error; }
    });
    expect(thrown).toBeInstanceOf(ActiveDirectiveLockFolderHeldError);
    expect((thrown as Error).message).toBe(WINDOWS_HELD as string);
    // The budget (half a second at least, less than a round) plus at most one
    // round; counted alone, the 200 ms budget allows 21.
    expect(rounds).toBeLessThanOrEqual(2);
  });

  test("without the Windows line the held kind keeps today's words", () => {
    _setLockFolderHeldPlatformForTests("linux");
    const fixture = markerProject();
    seedDeadOwner(fixture.lockDir);
    _setAuditLockFaultHooksForTests({ failReapRename: () => true });
    withTimeout("50", () => {
      expect(() => writeMarker(fixture.projectDir, fixture.state)).toThrow(ActiveDirectiveLockFolderHeldError);
      expect(() => writeMarker(fixture.projectDir, fixture.state)).toThrow(BUSY);
    });
  });

  test("a live owner, or one whose process generation cannot be read, keeps today's words", () => {
    _setLockFolderHeldPlatformForTests("win32");
    for (const unknownGeneration of [false, true]) {
      const fixture = markerProject();
      seedOwner(fixture.lockDir, unknownGeneration ? 2_000_000_001 : process.pid);
      if (unknownGeneration) {
        _setAuditLockFaultHooksForTests({ processProbe: () => ({ alive: true, generation: null }) });
      }
      let thrown: unknown = null;
      withTimeout("30", () => {
        try { writeMarker(fixture.projectDir, fixture.state); } catch (error) { thrown = error; }
      });
      expect(thrown).toBeInstanceOf(ActiveDirectiveLockContendedError);
      expect(thrown).not.toBeInstanceOf(ActiveDirectiveLockFolderHeldError);
      expect((thrown as Error).message).toBe(BUSY);
      _setAuditLockFaultHooksForTests(null);
    }
  });

  test("a release that spent its budget is retried once, briefly, and the next transaction says the folder is held", () => {
    _setLockFolderHeldPlatformForTests("win32");
    const fixture = markerProject();
    writeMarker(fixture.projectDir, fixture.state);
    let rounds = 0;
    const refuse = (_path: string, attempt: number) => { if (attempt === 0) rounds++; return true; };
    _setAuditLockFaultHooksForTests({ failReleaseRename: refuse, failGateReleaseRename: refuse });
    withTimeout("3000", () => {
      const first = performance.now();
      withActiveDirectiveLock(fixture.projectDir, () => null);
      expect(performance.now() - first).toBeGreaterThanOrEqual(2_900);
      expect(takeActiveDirectiveReleaseHeld()).toBe(true);
      expect(takeActiveDirectiveReleaseHeld()).toBe(false);
      const spent = rounds;
      let thrown: unknown = null;
      try { withActiveDirectiveLock(fixture.projectDir, () => null); } catch (error) { thrown = error; }
      // One short retry, one round; a second budget would run rounds until it ran out.
      expect(rounds - spent).toBe(1);
      expect(thrown).toBeInstanceOf(ActiveDirectiveLockFolderHeldError);
      expect((thrown as Error).message).toBe(WINDOWS_HELD as string);
    });
    // The program stops: the same process's pending release goes through.
    _setAuditLockFaultHooksForTests(null);
    withActiveDirectiveLock(fixture.projectDir, () => null);
    expect(existsSync(fixture.lockDir)).toBe(false);
  });

  test("the process exit retries a spent release once, briefly, not for a second budget", () => {
    const fixture = markerProject();
    writeMarker(fixture.projectDir, fixture.state);
    const driver = join(fixture.projectDir, "hold.ts");
    writeFileSync(driver, [
      `const lib = await import(${JSON.stringify(LIB)});`,
      'const { writeSync } = await import("node:fs");',
      "let rounds = 0;",
      "const refuse = (_path, attempt) => { if (attempt === 0) rounds++; return true; };",
      "lib._setAuditLockFaultHooksForTests({ failReleaseRename: refuse, failGateReleaseRename: refuse });",
      "const started = performance.now();",
      `lib.withActiveDirectiveLock(${JSON.stringify(fixture.projectDir)}, () => null);`,
      "const call = Math.round(performance.now() - started);",
      "const spent = rounds;",
      // Registered after the lib's own exit retries, so it runs after them.
      'process.on("exit", () => { writeSync(1, call + " " + (rounds - spent) + "\\n"); });',
    ].join("\n"));
    const result = spawnSync(BUN, [driver], {
      encoding: "utf-8",
      env: { ...process.env, AIDLC_ACTIVE_DIRECTIVE_LOCK_TIMEOUT_MS: "4000" },
      timeout: remainingOperationTimeoutMs(60_000),
    });
    expect(result.status, result.stderr).toBe(0);
    const [call, atExit] = result.stdout.trim().split(" ").map(Number);
    expect(call).toBeGreaterThanOrEqual(3_900);
    // The gate's exit retry and one short retry of the lock's release, where a
    // second budget would run rounds until it ran out.
    expect(atExit).toBeLessThanOrEqual(2);
  });
});

// A poc workflow at Code Generation with plan approval off from its scope.
function guardProject(policy: "off" | "relaxed" | "strict"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)", `- **Guard Policy**: ${policy} (set by you)`)
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
  const stage = join(seededRecordDir(proj), "construction", "code-generation");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify\n- Touches: src/slugify.ts\n- Tests: 3 unit tests\n\n" +
      `## Steps\n\n- [ ] Step 1: write slugify\n\n${renderTestingContract(resolveTestingPosture(proj))}`, "utf-8");
  writeFileSync(join(stage, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test`.\n", "utf-8");
  return proj;
}

const env = (proj: string, extra: Record<string, string> = {}) => ({
  ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", ...extra,
});

function next(proj: string): { kind: string; message?: string } {
  const result = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, [], { cwd: proj, env: env(proj) });
  expect(result.status, result.out).toBe(0);
  return result.directive as unknown as { kind: string; message?: string };
}

function say(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
  });
  expect(result.status, result.stderr).toBe(0);
}

function lockDirOf(proj: string): string {
  return join(seededRecordDir(proj), ".aidlc-engine", "active-directive.lock");
}

type Fault = "held" | "release" | "none";

// The guard as a Write reaches it, its own process reading stdin, with the
// fault hooks set by a preload that loads the same lib the hook imports.
// `platform` is the one the line module answers for, never the box the test
// runs on, so the Windows and Linux cases mean the same everywhere.
function guard(
  proj: string,
  file: string,
  fault: Fault,
  platform: NodeJS.Platform = "win32",
  command?: string,
  harness?: string,
): { code: number; stdout: string; stderr: string } {
  // Outside the project: a file there would count as source changed since approval.
  const preload = join(tmpdir(), `aidlc-lfh-faults-${randomUUID()}.ts`);
  const tools = join(proj, ".claude", "tools");
  writeFileSync(preload, [
    `const lib = await import(${JSON.stringify(join(tools, "aidlc-lib.ts"))});`,
    `const line = await import(${JSON.stringify(join(tools, "aidlc-lock-line.ts"))});`,
    `line._setLockFolderHeldPlatformForTests(${JSON.stringify(platform)});`,
    // Only the directive lock's folders are held; the audit lock lives in the temp folder.
    "const directive = (path) => path.includes('active-directive.lock');",
    fault === "held" ? "lib._setAuditLockFaultHooksForTests({ failReapRename: directive });" : "",
    fault === "release" ? "lib._setAuditLockFaultHooksForTests({ failReleaseRename: directive, failGateReleaseRename: directive });" : "",
  ].join("\n"));
  if (fault === "held" && !existsSync(lockDirOf(proj))) seedDeadOwner(lockDirOf(proj));
  const result = spawnSync(BUN, ["--preload", preload, join(proj, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
    cwd: proj,
    env: env(proj, { AIDLC_ACTIVE_DIRECTIVE_LOCK_TIMEOUT_MS: "300", ...(harness ? { AIDLC_HARNESS_NAME: harness } : {}) }),
    encoding: "utf-8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj,
      ...(command === undefined
        ? { tool_name: "Write", tool_input: { file_path: join(proj, "src", file), content: "x\n" } }
        : { tool_name: "Bash", tool_input: { command } }),
    }),
    timeout: remainingOperationTimeoutMs(120_000),
  });
  rmSync(preload, { force: true });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const asideRows = (proj: string) => readAuditShardEvents(proj).filter((row) => row.event === "GUARD_STOOD_ASIDE").length;

function started(proj: string): void {
  expect(next(proj).kind).toBe("run-stage");
  say(proj, "go on");
  expect(guard(proj, "a.ts", "none").code).toBe(0);
}

describe("the plan-approval guard meets a held lock folder", () => {
  for (const policy of ["off", "relaxed"] as const) {
    test(`Guard Policy ${policy}: the write goes on; the agent gets its step, the person the line on a second hit, once a turn`, () => {
      const proj = guardProject(policy);
      started(proj);
      const rows = asideRows(proj);
      const first = guard(proj, "b.ts", "held");
      expect(first.code, first.stderr).toBe(0);
      expect(first.stdout.trim()).toBe(toAgent(goesOnStep(GUARD_GOES_ON)));
      // Still held after the agent's turn to stop its program: the person hears the line.
      const second = guard(proj, "c.ts", "held");
      expect(second.code, second.stderr).toBe(0);
      expect(second.stdout.trim()).toBe(toPerson(GUARD_GOES_ON));
      const third = guard(proj, "c2.ts", "held");
      expect(third.code, third.stderr).toBe(0);
      expect(third.stdout).not.toContain("A program is");
      say(proj, "is it done yet?");
      const nextTurn = guard(proj, "d.ts", "held");
      expect(nextTurn.code, nextTurn.stderr).toBe(0);
      expect(nextTurn.stdout.trim()).toBe(toAgent(goesOnStep(GUARD_GOES_ON)));
      expect(asideRows(proj)).toBe(rows);
      // Without the Windows line the write still goes on, and nothing is said, on a turn that could say it.
      say(proj, "and now?");
      const plain = guard(proj, "e.ts", "held", "linux");
      expect(plain.code, plain.stderr).toBe(0);
      expect(plain.stdout).not.toContain("systemMessage");
      expect(plain.stdout).not.toContain("additionalContext");
    });
  }

  // Codex, Copilot, Cursor, Kiro CLI and opencode drop this hook's output on a
  // call that goes on, and Kiro IDE does not read PreToolUse stdout, so no line
  // reaches their agent: the guard writes the person's line as before.
  test("on a harness with no channel to the agent here, the guard writes the line as before", () => {
    const proj = guardProject("off");
    started(proj);
    const first = guard(proj, "b.ts", "held", "win32", undefined, "codex");
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout.trim()).toBe(GUARD_GOES_ON as string);
    const again = guard(proj, "c.ts", "held", "win32", undefined, "codex");
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).not.toContain("A program is");
  });

  test("Guard Policy strict: refused with the line; once the program stops the write goes through and next moves on", () => {
    const proj = guardProject("strict");
    started(proj);
    const refused = guard(proj, "b.ts", "held");
    expect(refused.code).toBe(2);
    expect(refused.stderr.trim()).toBe(WINDOWS_HELD as string);
    const today = guard(proj, "b.ts", "held", "linux");
    expect(today.code).toBe(2);
    expect(today.stderr.trim()).toBe(PROVENANCE);
    const cleared = guard(proj, "b.ts", "none");
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(existsSync(lockDirOf(proj))).toBe(false);
    expect(next(proj).kind).toBe("run-stage");
  });

  // The engine's step tells the agent to stop a program it started. Under
  // strict the stop it names goes through with the folder held, and starts
  // nothing; this guard's own refusal stays the person's line, never a step.
  test("Guard Policy strict: the agent's own stop command goes through and starts nothing; a write keeps the line", () => {
    const proj = guardProject("strict");
    started(proj);
    const rows = () => readAuditShardEvents(proj).length;
    const before = rows();
    for (const command of ["taskkill //T //F //PID 1", "taskkill /T /F /PID 1"]) {
      const stop = guard(proj, "", "held", "win32", command);
      expect(stop.code, stop.stderr).toBe(0);
      expect(`${stop.stdout}${stop.stderr}`).toBe("");
    }
    expect(rows()).toBe(before);
    const write = guard(proj, "b.ts", "held");
    expect(write.code).toBe(2);
    expect(write.stderr.trim()).toBe(WINDOWS_HELD as string);
  });

  test("the guard whose own call went through gives the agent its step, and the person the line on a second hit", () => {
    const proj = guardProject("off");
    started(proj);
    const held = guard(proj, "b.ts", "release");
    expect(held.code, held.stderr).toBe(0);
    expect(held.stdout.trim()).toBe(toAgent(goesOnStep(GUARD_WENT_THROUGH)));
    // The next step meets the held folder: the second hit of the turn is the person's.
    const next1 = guard(proj, "c.ts", "held");
    expect(next1.code, next1.stderr).toBe(0);
    expect(next1.stdout.trim()).toBe(toPerson(GUARD_GOES_ON));
    say(proj, "how is it going?");
    const nextTurn = guard(proj, "d.ts", "held");
    expect(nextTurn.stdout.trim()).toBe(toAgent(goesOnStep(GUARD_GOES_ON)));
    // Under strict it says nothing: the next write is refused with the line, which is then true.
    const strict = guardProject("strict");
    started(strict);
    const quiet = guard(strict, "b.ts", "release");
    expect(quiet.code, quiet.stderr).toBe(0);
    expect(quiet.stdout).not.toContain("A program is watching");
    const refused = guard(strict, "c.ts", "held");
    expect(refused.code).toBe(2);
    expect(refused.stderr.trim()).toBe(WINDOWS_HELD as string);
  });
});

// `next` (or `verb`) run in its own process with the fault hooks and the line
// module's platform set, as the guard's preload sets them. `session` names the
// chat the way a host's shell does; without it the engine cannot count a turn's stops.
function runNext(
  proj: string,
  args: string[],
  options: { held: boolean; session?: boolean; platform?: NodeJS.Platform; verb?: "next" | "continue" },
): string {
  const tools = join(proj, ".claude", "tools");
  const driver = join(tmpdir(), `aidlc-lfh-next-${randomUUID()}.ts`);
  writeFileSync(driver, [
    `const lib = await import(${JSON.stringify(join(tools, "aidlc-lib.ts"))});`,
    `const line = await import(${JSON.stringify(join(tools, "aidlc-lock-line.ts"))});`,
    `line._setLockFolderHeldPlatformForTests(${JSON.stringify(options.platform ?? "win32")});`,
    options.held ? "lib._setAuditLockFaultHooksForTests({ failReapRename: (path) => path.includes('active-directive.lock') });" : "",
    `const { main } = await import(${JSON.stringify(join(tools, "aidlc-orchestrate.ts"))});`,
    `main(${JSON.stringify([options.verb ?? "next", ...args])});`,
  ].join("\n"));
  if (options.held && !existsSync(lockDirOf(proj))) seedDeadOwner(lockDirOf(proj));
  // The chat comes only from `session`, never from the shell running the tests.
  const hostChat = {
    CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_PID: undefined, CODEX_THREAD_ID: undefined, KIRO_SESSION_ID: undefined,
    AIDLC_SESSION_OVERRIDE: options.session ? SESSION : undefined, AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
  };
  const result = spawnSync(BUN, [driver], {
    cwd: proj,
    env: { ...env(proj, { AIDLC_ACTIVE_DIRECTIVE_LOCK_TIMEOUT_MS: "300" }), ...hostChat },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(120_000),
  });
  rmSync(driver, { force: true });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

const directiveOf = (stdout: string): { kind: string; message?: string; receipt?: string } =>
  JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { kind: string; message?: string; receipt?: string };

const turnEndMark = (proj: string) => join(seededRecordDir(proj), ".aidlc-engine", "turn-end");

describe("next meets a held lock folder", () => {
  test("the agent's step: stop a program it started and run the command again, else the person's line", () => {
    const proj = guardProject("off");
    const held = directiveOf(runNext(proj, ["--project-dir", proj], { held: true }));
    expect(held.kind).toBe("print");
    expect(held.message).toBe(AGENT_STEP_UNCOUNTED);
    expect(JSON.stringify(held)).not.toContain("--doctor");
    // The step ends the turn, so the Stop hook lets an agent that showed the line stop there.
    expect(existsSync(turnEndMark(proj))).toBe(true);
    // Without the Windows line, today's words.
    rmSync(lockDirOf(proj), { recursive: true, force: true });
    const plain = directiveOf(runNext(proj, ["--project-dir", proj], { held: true, platform: "linux" }));
    expect(plain).toEqual({
      kind: "error",
      message: "The directive could not be published, so no work directive was issued. Retry the command; if " +
        "coordination remains busy, run `/aidlc --doctor`.",
    });
  });

  test("a second stop in the same turn hands over the person's line, so stopping the wrong program never loops", () => {
    const proj = guardProject("off");
    started(proj);
    const first = directiveOf(runNext(proj, [], { held: true, session: true }));
    expect(first.kind).toBe("print");
    expect(first.message).toBe(AGENT_STEP);
    // The agent stopped its program and ran the command again; the folder is still held.
    const again = directiveOf(runNext(proj, [], { held: true, session: true }));
    expect(again.kind).toBe("print");
    expect(again.message).toBe(PERSON_STEP);
    expect(directiveOf(runNext(proj, [], { held: true, session: true })).message).toBe(PERSON_STEP);
    // The person writes again: their turn starts with the agent's step.
    say(proj, "I closed it, carry on");
    expect(directiveOf(runNext(proj, [], { held: true, session: true })).message).toBe(AGENT_STEP);
    // The program stops: the work goes on.
    rmSync(lockDirOf(proj), { recursive: true, force: true });
    expect(["run-stage", "load-steering"]).toContain(directiveOf(runNext(proj, [], { held: false, session: true })).kind);
  });

  // The turn's stops are counted in the chat's person-lines record, which keeps
  // nothing where no workflow is selected (markPersonLinesHeard); a folder in
  // the record's place stands in for that here. Then the words bound the retry.
  test("where the turn's stops cannot be counted, the step carries its own bound", () => {
    const proj = guardProject("off");
    started(proj);
    const record = join(proj, "aidlc", ".aidlc-sessions", `${SESSION}.person-lines`);
    rmSync(record, { recursive: true, force: true });
    mkdirSync(record, { recursive: true });
    for (let i = 0; i < 2; i++) {
      expect(directiveOf(runNext(proj, [], { held: true, session: true }))).toEqual({ kind: "print", message: AGENT_STEP_UNCOUNTED });
    }
  });

  // On Kiro IDE (and opencode on Windows) a request the shell would change goes
  // through a file the engine reads and removes; the step's same command reads
  // it again, so the file is back when the step says so.
  test("a request read from a file is there again for the same command", () => {
    const proj = guardProject("off");
    started(proj);
    const file = join(proj, "aidlc", ".aidlc-request-text", "request.txt");
    const request = "Fix the login & signup forms";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${request}\n`);
    // A plan word with new words while work is in progress: the routing question, which the held folder stops.
    const command = ["--scope", "bugfix", "--request-file", "aidlc/.aidlc-request-text/request.txt"];
    expect(directiveOf(runNext(proj, command, { held: true, session: true }))).toEqual({ kind: "print", message: AGENT_STEP });
    expect(readFileSync(file, "utf8")).toBe(request);
    rmSync(lockDirOf(proj), { recursive: true, force: true });
    const again = directiveOf(runNext(proj, command, { held: false, session: true }));
    expect(again.kind, JSON.stringify(again)).toBe("ask");
    expect(existsSync(file)).toBe(false);
  });

  test("continue: the same step, counted in the same turn; without the Windows line, today's words", () => {
    const proj = guardProject("off");
    // A team's memory grown past one message (about 30 KB more rule text, as
    // t-copilot-directive-budget's), so the stage's rules come in parts on every
    // platform and the next part is a `continue`.
    appendFileSync(
      join(proj, "aidlc", "spaces", "default", "memory", "org.md"),
      Array.from({ length: 20 }, (_, index) => `\n## Team practice ${index}\n${"x".repeat(1500)}\n`).join(""),
    );
    started(proj);
    const part = directiveOf(runNext(proj, [], { held: false, session: true }));
    expect(part.kind, JSON.stringify(part)).toBe("load-steering");
    const receipt = String(part.receipt);
    const held = { held: true, session: true, verb: "continue" } as const;
    expect(directiveOf(runNext(proj, [receipt], held))).toEqual({ kind: "print", message: AGENT_STEP });
    expect(directiveOf(runNext(proj, [receipt], held))).toEqual({ kind: "print", message: PERSON_STEP });
    rmSync(lockDirOf(proj), { recursive: true, force: true });
    expect(directiveOf(runNext(proj, [receipt], { ...held, platform: "linux" }))).toEqual({
      kind: "error", message: "The workflow is busy for a moment. Run the same command again.",
    });
    // The program stops: the same part goes on.
    rmSync(lockDirOf(proj), { recursive: true, force: true });
    expect(["run-stage", "load-steering"]).toContain(directiveOf(runNext(proj, [receipt], { ...held, held: false })).kind);
  });

  test("a question it cannot publish is not shown: a reply would land on the question beneath it", () => {
    const proj = guardProject("off");
    started(proj);
    // The person asks for other work; the engine keeps their words for the question where it belongs.
    const reading = runNext(proj, ["Add a dark mode toggle"], { held: false });
    const request = /--request ([0-9a-f]+)/.exec(reading)?.[1] ?? "";
    expect(request, reading).not.toBe("");
    // Held, the step instead of a question no marker binds.
    const held = runNext(proj, ["--request", request], { held: true, session: true });
    expect(held).not.toContain('"kind":"ask"');
    expect(directiveOf(held)).toEqual({ kind: "print", message: AGENT_STEP });
    // Once the program stops, the same command asks the question, with its marker.
    expect(runNext(proj, ["--request", request], { held: false })).toContain('"kind":"ask"');
  });
});
