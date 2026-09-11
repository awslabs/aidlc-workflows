// covers: function:evaluateGuardRefusal, function:guardRecoveryAskForRefusal,
// subcommand:aidlc-orchestrate:next, subcommand:aidlc-jump:execute,
// subcommand:aidlc-bolt:abort
//
// Execute the evaluator's actual source/native remedies, including the jump
// command returned by next --stage. Lifecycle snapshots and spent recovery
// inputs are synthetic; the resulting mutations/audit rows use owning CLIs.
// Native evaluation imports dist-release under Bun; execution uses one compiled
// dispatcher with a calibrated Bun-denial PATH sentinel. No model is invoked.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  type ActiveDirectiveMarker,
  type GuardRefusal,
  type GuardRefusalInput,
  splitKiroCommandArgs,
} from "../../core/tools/aidlc-lib.ts";
import {
  createTestProject,
  DEFAULT_SPACE,
  REPO_ROOT,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";

const HARNESS_RUNTIMES = [
  { name: "claude", dir: ".claude" },
  { name: "codex", dir: ".codex" },
  { name: "copilot", dir: ".aidlc" },
  { name: "cursor", dir: ".cursor" },
  { name: "kiro", dir: ".kiro" },
  { name: "kiro-ide", dir: ".kiro" },
  { name: "opencode", dir: ".aidlc" },
] as const;
type Harness = (typeof HARNESS_RUNTIMES)[number];
type Projection = "source" | "native";
type Json = Record<string, unknown>;
type Run = { status: number | null; stdout: string; stderr: string };

const SOURCE_ROOT = join(REPO_ROOT, "dist");
const NATIVE_ROOT = join(REPO_ROOT, "dist-release");
const STAGE = "requirements-analysis";
const BUN = process.execPath;
const RESET_CASES = [
  { op: "restart-stage", marker: " ", lifecycle: "pending", direction: "redo" },
  { op: "redo-jump", marker: "R", lifecycle: "revising", direction: "redo" },
  { op: "restore-or-jump", marker: "x", lifecycle: "completed", direction: "backward" },
] as const;

// Import BOTH evaluator and validator from the projection under examination.
// In particular, do not replace a source command by rendering a native one in
// this test: a stale dist-release invocation token must fail the regression.
const EVALUATE = `
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";
  const tools = process.env.AIDLC_REMEDY_EVALUATOR_TOOLS;
  const lib = await import(pathToFileURL(join(tools, "aidlc-lib.ts")).href);
  const directives = await import(pathToFileURL(join(tools, "aidlc-directive.ts")).href);
  const runtime = await import(pathToFileURL(join(tools, "aidlc-runtime-paths.ts")).href);
  const input = await Bun.stdin.json();
  const refusal = lib.evaluateGuardRefusal(input);
  const ask = lib.guardRecoveryAskForRefusal(refusal);
  // Exercise the direct log refusal's actual emission boundary for aborts.
  // Its spent-attempt input is synthetic, like the reset lifecycle fixtures.
  const refusalOutput = input.autonomousBolt
    ? lib.guardRefusalOutput(process.env.AIDLC_PROJECT_DIR, refusal, input.attempt)
    : undefined;
  console.log(JSON.stringify({
    refusal, ask, refusalOutput, validation: directives.validateDirective(ask),
    invocation: runtime.aidlcInvocation(),
    harness: runtime.runtimeHarnessName(),
  }));
`;

let scratch: string;
let projectsDir: string;
let binDir: string;
let trace: string;
let denialLog: string;
let nativePath: string;

function run(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: unknown,
  exactCommand?: string,
): Run {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd, env, encoding: "utf-8",
    input: input === undefined ? undefined : JSON.stringify(input),
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  appendFileSync(trace, `${JSON.stringify({
    argv, exactCommand, cwd,
    project: env.AIDLC_PROJECT_DIR,
    runtime: env.AIDLC_RUNTIME_ROOT,
    profile: env.AIDLC_TEST_GUARD_PROFILE,
    error: result.error?.message,
    ...output,
  })}\n`);
  return output;
}

function succeeded(output: Run): Run {
  expect(output.status, `${output.stdout}\n${output.stderr}\nTrace: ${trace}`).toBe(0);
  return output;
}

function json(output: Run): Json {
  return JSON.parse(succeeded(output).stdout.trim()) as Json;
}

beforeAll(() => {
  const common = spawnSync("git", [
    "rev-parse", "--path-format=absolute", "--git-common-dir",
  ], { cwd: REPO_ROOT, encoding: "utf-8" });
  expect(common.status, common.stderr).toBe(0);
  const root = join(dirname(common.stdout.trim()), "tmp", "guard-recovery-contract", "omp-fixes");
  mkdirSync(root, { recursive: true });
  scratch = realpathSync(mkdtempSync(join(root, "native-remedies-")));
  projectsDir = join(scratch, "projects with spaces");
  binDir = join(scratch, "native bin");
  mkdirSync(projectsDir);
  mkdirSync(binDir);
  trace = join(scratch, "commands.jsonl");
  denialLog = join(scratch, "bun-denied.log");
  console.log(`Native remedy execution trace: ${trace}`);

  // As in t-kiro-ide-native-recovery, compile the shipped dispatcher once.
  // Packaging is the outer runner's responsibility; this file never regenerates
  // shared dist trees or uses a possibly stale binary from another test.
  const build = spawnSync(BUN, [
    "build", join(NATIVE_ROOT, "claude", ".claude", "tools", "aidlc.ts"),
    "--compile", "--outfile",
    join(binDir, process.platform === "win32" ? "aidlc.exe" : "aidlc"),
  ], { cwd: REPO_ROOT, encoding: "utf-8", timeout: 120_000 });
  writeFileSync(join(scratch, "compile.log"), `${build.stdout ?? ""}${build.stderr ?? ""}`);
  expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

  const sentinel = join(binDir, process.platform === "win32" ? "bun.cmd" : "bun");
  writeFileSync(sentinel, process.platform === "win32"
    ? '@echo off\r\necho unexpected Bun invocation>>"%AIDLC_REMEDY_BUN_DENIAL_LOG%"\r\nexit /b 91\r\n'
    : '#!/bin/sh\nprintf "unexpected Bun invocation\\n" >> "$AIDLC_REMEDY_BUN_DENIAL_LOG"\nexit 91\n');
  if (process.platform !== "win32") chmodSync(sentinel, 0o755);
  // On Windows bun.exe must not take precedence over the .cmd sentinel.
  // POSIX keeps Git/system tools on PATH and shadows Bun with the executable.
  const hostPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  nativePath = [binDir, ...hostPath.filter((dir) =>
    process.platform !== "win32" ||
    !["bun.exe", "bun.cmd", "bun.bat"].some((name) => existsSync(join(dir, name)))
  )].join(delimiter);
  const calibration = spawnSync("bun --version", {
    cwd: scratch,
    shell: true,
    encoding: "utf-8",
    env: { ...process.env, PATH: nativePath, AIDLC_REMEDY_BUN_DENIAL_LOG: denialLog },
  });
  expect(calibration.status, calibration.stdout + calibration.stderr).toBe(91);
  expect(readFileSync(denialLog, "utf-8")).toContain("unexpected Bun invocation");
  rmSync(denialLog);
}, 150_000);

afterAll(() => {
  // Retain compile/command/denial logs in ROOT/tmp for diagnosis.
  if (projectsDir) rmSync(projectsDir, { recursive: true, force: true });
  if (binDir) rmSync(binDir, { recursive: true, force: true });
}, 30_000);

class Fixture {
  readonly project: string;
  readonly cwd: string;
  readonly tools: string;
  readonly env: NodeJS.ProcessEnv;
  readonly evaluationEnv: NodeJS.ProcessEnv;

  constructor(readonly projection: Projection, readonly harness: Harness, state: string) {
    const previousTmp = process.env.TMPDIR;
    try {
      process.env.TMPDIR = projectsDir;
      this.project = createTestProject();
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
    const runtimeRoot = projection === "native" ? NATIVE_ROOT : SOURCE_ROOT;
    this.tools = join(this.project, harness.dir, "tools");
    cpSync(join(runtimeRoot, harness.name, harness.dir), join(this.project, harness.dir), {
      recursive: true,
    });
    cpSync(join(this.tools, "data", "memory-seed"),
      join(this.project, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
    seedStateFile(this.project, state);
    writeFileSync(seededStateFile(this.project), this.state().replace(
      /^- \*\*Project Root\*\*:.*$/m, `- **Project Root**: ${this.project}`,
    ));
    mkdirSync(seededAuditDir(this.project), { recursive: true });
    writeFileSync(seededAuditShard(this.project), "# AI-DLC Audit Log\n");
    mkdirSync(join(this.project, "src"));
    writeFileSync(join(this.project, "src", "base.ts"), "export const base = 1;\n");
    // The native commands are unchanged strings. Project context comes from
    // the supported explicit environment, NOT from appending flags after
    // validation. Relative source tool paths require the project-root CWD.
    this.cwd = projection === "native"
      ? join(this.project, "nested working directory", "more spaces")
      : this.project;
    mkdirSync(this.cwd, { recursive: true });
    const env = testGuardEnvironment(process.env, "production");
    for (const key of [
      "AWS_AIDLC_DEFAULT_SCOPE", "AIDLC_COMPILED_EXECUTABLE",
      "AIDLC_RUNTIME_HARNESS_ROOT", "AIDLC_RUNTIME_PROJECT_DIR", "BUN_OPTIONS",
    ]) delete env[key];
    this.evaluationEnv = {
      ...env,
      AIDLC_PROJECT_DIR: this.project,
      CLAUDE_PROJECT_DIR: this.project,
      AIDLC_HARNESS_DIR: harness.dir,
      AIDLC_HARNESS_NAME: harness.name,
      AIDLC_RUNTIME_ROOT: runtimeRoot,
      AIDLC_UNATTENDED: "0",
      TMPDIR: scratch,
      PATH: `${dirname(BUN)}${delimiter}${process.env.PATH ?? ""}`,
    };
    this.env = projection === "native"
      ? { ...this.evaluationEnv, PATH: nativePath, AIDLC_REMEDY_BUN_DENIAL_LOG: denialLog }
      : this.evaluationEnv;
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.name", "AI-DLC Fixture"],
      ["config", "user.email", "fixture@example.invalid"],
      ["add", "-A"],
      ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture baseline"],
    ]) succeeded(run(["git", ...args], this.project, this.env));
  }

  state(): string {
    return readFileSync(seededStateFile(this.project), "utf-8");
  }

  audit(): string {
    return readdirSync(seededAuditDir(this.project))
      .filter((name) => name.endsWith(".md"))
      .map((name) => readFileSync(join(seededAuditDir(this.project), name), "utf-8")).join("\n");
  }

  exact(command: string): Run {
    const argv = splitKiroCommandArgs(command);
    expect(argv.length).toBeGreaterThan(0);
    expect(argv[0]).toBe(this.projection === "native" ? "aidlc" : "bun");
    const result = run(argv, this.cwd, this.env, undefined, command);
    if (this.projection === "native") expect(existsSync(denialLog), result.stderr).toBe(false);
    return result;
  }

  tool(route: string, args: string[]): Run {
    const argv = this.projection === "native"
      ? ["aidlc", "engine", route, ...args, "--project-dir", this.project]
      : [BUN, join(this.tools, `aidlc-${route}.ts`), ...args, "--project-dir", this.project];
    const output = run(argv, this.cwd, this.env);
    if (this.projection === "native") expect(existsSync(denialLog), output.stderr).toBe(false);
    return output;
  }

  marker(): ActiveDirectiveMarker | null {
    const path = join(seededRecordDir(this.project), ".aidlc-active-directive.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as ActiveDirectiveMarker : null;
  }

  hook(name: string, payload: Json): Run {
    const argv = this.projection === "native"
      ? ["aidlc", "engine", "hook", name, "--project-dir", this.project]
      : [BUN, join(this.project, this.harness.dir, "hooks", `aidlc-${name}.ts`)];
    const output = run(argv, this.cwd, this.env, {
      cwd: this.project, session_id: "01995000-0995-7000-8000-000000000777", ...payload,
    });
    if (this.projection === "native") expect(existsSync(denialLog), output.stderr).toBe(false);
    return output;
  }

  guard(toolName: string, toolInput: Json): Run {
    return this.hook("plan-approval-guard", {
      hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput,
    });
  }

  copilotAdapter(target: string, payload: Json): Run {
    expect(this.harness.name).toBe("copilot");
    const argv = this.projection === "native"
      ? ["aidlc", "engine", "adapter", "copilot", target, "--project-dir", this.project]
      : [BUN, join(this.project, this.harness.dir, "hooks", "aidlc-copilot-adapter.ts"), target];
    const output = run(
      argv, this.cwd, this.env,
      { cwd: this.project, session_id: "01995000-0995-7000-8000-000000000777", ...payload },
    );
    if (this.projection === "native") expect(existsSync(denialLog), output.stderr).toBe(false);
    return output;
  }

  remedy(op: string, input: Partial<GuardRefusalInput> = {}) {
    const evaluated = json(run([BUN, "--eval", EVALUATE], this.project, {
      ...this.evaluationEnv, AIDLC_REMEDY_EVALUATOR_TOOLS: this.tools,
    }, {
      code: "NATIVE_REMEDY_EXECUTION",
      blockedAction: "complete",
      stage: STAGE,
      stateContent: this.state(),
      invariant: "A spent attempt must retain an executable recovery.",
      userMessage: "The current attempt cannot complete.",
      attempt: {
        recovery: "spent", summaryCoverage: "current",
        reviewCoverage: "stale", sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: true, unattended: false },
      ...input,
    } satisfies GuardRefusalInput));
    expect(evaluated.harness).toBe(this.harness.name);
    expect(String(evaluated.invocation).startsWith("bun "))
      .toBe(this.projection === "source");
    expect(evaluated.validation, JSON.stringify(evaluated)).toMatchObject({ valid: true });
    expect(evaluated.ask).toMatchObject({
      kind: "ask", ask_type: "guard-recovery", response_route: "execute-remedy",
    });
    if (input.autonomousBolt) {
      expect(typeof evaluated.refusalOutput).toBe("string");
      expect(JSON.parse(String(evaluated.refusalOutput).trim().split("\n").at(-1)!))
        .toEqual(evaluated.ask);
    }
    const refusal = evaluated.refusal as GuardRefusal;
    const ask = evaluated.ask as { remedies: GuardRefusal["remedies"] };
    const remedy = ask.remedies.find((candidate) => candidate.op === op);
    expect(remedy, JSON.stringify(evaluated)).toMatchObject({
      op, interaction: "command", executableNow: true, requiresHuman: true,
    });
    expect(remedy).toEqual(refusal.remedies.find((candidate) => candidate.op === op));
    expect(typeof remedy?.command).toBe("string");
    return { refusal, remedy: remedy! };
  }

  assertNoNestedState(): void {
    if (this.projection === "native") {
      expect(this.cwd).not.toBe(this.project);
      expect(existsSync(join(this.cwd, "aidlc"))).toBe(false);
      expect(existsSync(join(this.cwd, ".aidlc"))).toBe(false);
      expect(existsSync(denialLog)).toBe(false);
    }
  }
}

function restartFixture(harness: Harness = HARNESS_RUNTIMES[0], projection: Projection = "native") {
  const p = new Fixture(projection, harness, "state-mid-inception.md");
  writeFileSync(seededStateFile(p.project), p.state()
    .replace("- **Current Stage**: requirements-analysis", "- **Current Stage**: code-generation")
    .replace("- **Lifecycle Phase**: INCEPTION", "- **Lifecycle Phase**: CONSTRUCTION")
    .replace("- [-] requirements-analysis — EXECUTE", "- [x] requirements-analysis — EXECUTE")
    .replace("- [ ] code-generation — EXECUTE", "- [R] code-generation — EXECUTE"));
  // The lifecycle fixture starts mid-revision; the owning report emits and
  // publishes the real recovery ask. Subsequent selections use actual hooks.
  const ask = json(p.tool("orchestrate", [
    "report", "--stage", "code-generation", "--result", "revised",
  ]));
  expect(ask).toMatchObject({ kind: "ask", ask_type: "guard-recovery", stage: "code-generation" });
  const remedy = (ask.remedies as GuardRefusal["remedies"]).find((entry) => entry.op === "redo-jump")!;
  expect(remedy.operation).toEqual({ kind: "restart-stage", stage: "code-generation" });
  expect(p.marker()).toMatchObject({
    kind: "ask", ask_type: "guard-recovery", delivery: "issued", needs_rehydrate: false,
  });
  return { p, remedy };
}

function returnedJump(instruction: Json): string {
  expect(instruction.kind, JSON.stringify(instruction)).toBe("print");
  const match = /^Run `([^`]+)` to perform the jump/.exec(String(instruction.message));
  expect(match, JSON.stringify(instruction)).not.toBeNull();
  return match![1];
}

describe("source and native guard remedies execute their owning operations", () => {
  test("native jump resolution before human selection does not authorize its returned reset", () => {
    const { p, remedy } = restartFixture();
    const state = p.state();
    const issued = p.marker();
    succeeded(p.guard("Bash", { command: remedy.command }));
    const jump = returnedJump(json(p.exact(remedy.command!)));
    expect(p.marker()).toEqual(issued);
    expect(p.guard("Bash", { command: jump }).status).toBe(2);
    expect(p.state()).toBe(state);
    expect(p.audit()).not.toContain("**Event**: STAGE_JUMPED");
    expect(p.audit()).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    p.assertNoNestedState();
  }, 60_000);

  for (const harness of [HARNESS_RUNTIMES[0], HARNESS_RUNTIMES[2]]) {
    test(`native/${harness.name}: human selection survives next --stage and admits only the returned reset`, () => {
      const { p, remedy } = restartFixture(harness);
      const human = { hook_event_name: "UserPromptSubmit", prompt: remedy.op };
      succeeded(harness.name === "copilot"
        ? p.copilotAdapter("record-human-turn", human)
        : p.hook("record-human-turn", human));
      const selected = p.marker();
      expect(selected).toMatchObject({
        kind: "ask", delivery: "consumed", needs_rehydrate: false,
        guard_recovery_response: { selected_op: "redo-jump", status: "ready" },
      });
      expect(selected?.guard_recovery_response?.feedback_sha256).toBeUndefined();

      // This is the conductor's actual order: select, then next --stage, then
      // execute its returned jump. Never resolve the jump before selecting.
      succeeded(p.guard("Bash", { command: remedy.command }));
      let jump: string;
      if (harness.name === "copilot") {
        const input = {
          hook_event_name: "PreToolUse", tool_name: "Bash",
          tool_input: { command: remedy.command }, tool_use_id: "selected-recovery-next",
        };
        const pre = json(p.copilotAdapter("guard-tool-call", input));
        const command = (pre.modifiedArgs as { command?: string } | undefined)?.command;
        expect(command, JSON.stringify(pre)).toContain("--aidlc-attempt-id selected-recovery-next");
        expect(p.marker()).toMatchObject({
          needs_rehydrate: true, active_attempt: { status: "pending" },
        });
        const output = succeeded(p.exact(command!));
        jump = returnedJump(json(output));
        // Delivery is not complete until the real adapter settles the result.
        expect(p.guard("Bash", { command: jump }).status).toBe(2);
        // A result for a different command/attempt cannot settle this claim,
        // even when it contains the selected restart's exact print.
        const pending = p.marker();
        succeeded(p.copilotAdapter("post-tool", {
          ...input, hook_event_name: "PostToolUse",
          tool_use_id: "different-recovery-next",
          tool_input: { command: command!.replace("selected-recovery-next", "different-recovery-next") },
          tool_result: { result_type: "success", text_result_for_llm: output.stdout.trim() },
        }));
        expect(p.marker()).toEqual(pending);
        succeeded(p.copilotAdapter("post-tool", {
          ...input, hook_event_name: "PostToolUse", tool_input: { command },
          tool_result: { result_type: "success", text_result_for_llm: output.stdout.trim() },
        }));
        expect(p.marker()?.active_attempt?.status).toBe("settled");
        expect(p.marker()?.active_attempt?.result_sha256)
          .toBe(createHash("sha256").update(output.stdout.trim(), "utf-8").digest("hex"));
      } else {
        jump = returnedJump(json(p.exact(remedy.command!)));
        expect(p.marker()).toEqual(selected);
      }
      // The print transport must preserve the consumed choice, including on
      // a runtime whose adapter owns delivery/needs_rehydrate bookkeeping.
      expect(p.marker()).toMatchObject({
        kind: "ask", ask_type: "guard-recovery", delivery: "consumed", needs_rehydrate: false,
        remedies: selected!.remedies,
        guard_recovery_response: selected!.guard_recovery_response,
      });
      expect(jump).toContain("--scope bugfix");
      for (const command of [
        jump.replace("--scope bugfix", "--scope feature"),
        jump.replace("--target code-generation", "--target requirements-analysis"),
        `${jump} --force`,
        `${jump}; printf code > src/unapproved.ts`,
        `${jump} > src/unapproved.ts`,
      ]) {
        expect(p.guard("Bash", { command }).status, command).toBe(2);
      }
      succeeded(p.guard("Bash", { command: jump }));
      if (harness.name === "copilot") {
        const allowed = succeeded(p.copilotAdapter("guard-tool-call", {
          hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: jump },
        }));
        expect(allowed.stdout).not.toContain('"permissionDecision":"deny"');
      }
      const reset = json(p.exact(jump));
      expect(reset).toMatchObject({ target: "code-generation", direction: "redo", state_updated: true });
      expect(p.state()).toContain("- [-] code-generation — EXECUTE");
      expect(p.audit()).toContain("**Event**: STAGE_JUMPED");
      expect(p.audit()).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
      expect(p.guard("Bash", { command: jump }).status).toBe(2);
      expect(p.guard("Write", {
        file_path: join(p.project, "src", "unapproved.ts"), content: "export const unapproved = true;\n",
      }).status).toBe(2);
      expect(existsSync(join(p.project, "src", "unapproved.ts"))).toBe(false);
      p.assertNoNestedState();
    }, 90_000);
  }

  test("source/copilot: the selected restart print settles with the source command representation", () => {
    const { p, remedy } = restartFixture(HARNESS_RUNTIMES[2], "source");
    succeeded(p.copilotAdapter("record-human-turn", {
      hook_event_name: "UserPromptSubmit", prompt: remedy.op,
    }));
    const selected = p.marker();
    expect(selected).toMatchObject({
      kind: "ask", delivery: "consumed", needs_rehydrate: false,
      guard_recovery_response: { status: "ready", selected_op: remedy.op },
    });
    const input = {
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "source-recovery-next",
      tool_input: { command: remedy.command },
    };
    const pre = json(p.copilotAdapter("guard-tool-call", input));
    const command = (pre.modifiedArgs as { command?: string } | undefined)?.command;
    expect(command, JSON.stringify(pre)).toContain("--aidlc-attempt-id source-recovery-next");
    expect(p.marker()).toMatchObject({
      needs_rehydrate: true, active_attempt: { status: "pending" },
    });
    const output = succeeded(p.exact(command!));
    const jump = returnedJump(json(output));
    expect(jump).toStartWith("bun .aidlc/tools/aidlc-jump.ts execute ");
    succeeded(p.copilotAdapter("post-tool", {
      ...input, hook_event_name: "PostToolUse", tool_input: { command },
      tool_result: { result_type: "success", text_result_for_llm: output.stdout.trim() },
    }));
    expect(p.marker()).toMatchObject({
      kind: "ask", delivery: "consumed", needs_rehydrate: false,
      guard_recovery_response: selected!.guard_recovery_response,
      active_attempt: {
        status: "settled",
        result_sha256: createHash("sha256").update(output.stdout.trim(), "utf-8").digest("hex"),
      },
    });
    // Source tools retain their existing trusted admission. This case verifies
    // delivery/selection preservation, not a new source-tool consent check.
    expect(json(p.exact(jump))).toMatchObject({
      target: "code-generation", direction: "redo", state_updated: true,
    });
    expect(p.audit()).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
    expect(p.guard("Write", { file_path: join(p.project, "src", "unapproved.ts") }).status).toBe(2);
  }, 90_000);

  for (const mismatch of ["ordinary-print", "unrelated-command", "changed-state"] as const) {
    test(`native/copilot: ${mismatch} cannot preserve a selected restart through settlement`, () => {
      const { p, remedy } = restartFixture(HARNESS_RUNTIMES[2]);
      succeeded(p.copilotAdapter("record-human-turn", {
        hook_event_name: "UserPromptSubmit", prompt: remedy.op,
      }));
      expect(p.marker()?.guard_recovery_response?.selected_op).toBe("redo-jump");
      // Obtain a real returned jump for the later denial assertion. Like the
      // conductor, select first; this read does not consume or replace the ask.
      const selectedJump = returnedJump(json(p.exact(remedy.command!)));
      const requested = mismatch === "unrelated-command"
        ? "aidlc engine orchestrate next --scope feature"
        : remedy.command!;
      const input = {
        hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `recovery-${mismatch}`,
        tool_input: { command: requested },
      };
      const pre = json(p.copilotAdapter("guard-tool-call", input));
      const command = (pre.modifiedArgs as { command?: string } | undefined)?.command;
      expect(command, JSON.stringify(pre)).toContain(`--aidlc-attempt-id recovery-${mismatch}`);
      expect(p.marker()).toMatchObject({
        needs_rehydrate: true, active_attempt: { status: "pending" },
      });
      const output = succeeded(p.exact(command!));
      expect(json(output).kind).toBe("print");
      if (mismatch === "unrelated-command") {
        expect(String(json(output).message)).not.toContain(selectedJump);
      }
      if (mismatch === "changed-state") {
        const before = p.state();
        writeFileSync(seededStateFile(p.project), before
          .replace("- **Scope**: bugfix", "- **Scope**: feature"));
        expect(p.state()).not.toBe(before);
      }
      const state = p.state();
      // A successful ordinary print is still not the selected restart result.
      // The adapter itself computes its digest from this actual result payload.
      const delivered = mismatch === "ordinary-print"
        ? JSON.stringify({ kind: "print", message: "The workflow status is unchanged." })
        : output.stdout.trim();
      succeeded(p.copilotAdapter("post-tool", {
        ...input, hook_event_name: "PostToolUse", tool_input: { command },
        tool_result: { result_type: "success", text_result_for_llm: delivered },
      }));
      expect(p.marker()).toMatchObject({
        kind: "print", delivery: "superseded", needs_rehydrate: true,
        active_attempt: { status: "settled" },
      });
      expect(p.marker()?.guard_recovery_response).toBeUndefined();
      expect(p.marker()?.remedies).toBeUndefined();
      expect(p.guard("Bash", { command: selectedJump }).status).toBe(2);
      expect(p.state()).toBe(state);
      expect(p.audit()).not.toContain("**Event**: STAGE_JUMPED");
      expect(p.audit()).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
      p.assertNoNestedState();
    }, 90_000);
  }

  for (const choice of ["wrong", "stale"] as const) {
    test(`native reset refuses a ${choice} recorded choice without changing state or approving a plan`, () => {
      const { p, remedy } = restartFixture();
      succeeded(p.hook("record-human-turn", {
        hook_event_name: "UserPromptSubmit",
        prompt: choice === "wrong" ? "Approve Plan" : remedy.op,
      }));
      if (choice === "wrong") {
        expect(p.marker()?.guard_recovery_response?.selected_op).toBeNull();
      } else {
        expect(p.marker()?.guard_recovery_response?.selected_op).toBe("redo-jump");
      }
      const jump = returnedJump(json(p.exact(remedy.command!)));
      expect(jump).toContain("--scope bugfix");
      if (choice === "stale") {
        const before = p.state();
        writeFileSync(seededStateFile(p.project), p.state()
          .replace("- **Scope**: bugfix", "- **Scope**: feature"));
        expect(p.state()).not.toBe(before);
      }
      const state = p.state();
      expect(p.guard("Bash", { command: jump }).status).toBe(2);
      if (choice === "stale") {
        expect(p.guard("Bash", { command: jump.replace("--scope bugfix", "--scope feature") }).status).toBe(2);
      }
      expect(p.state()).toBe(state);
      expect(p.audit()).not.toContain("**Event**: STAGE_JUMPED");
      expect(p.audit()).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
      expect(p.guard("Write", { file_path: join(p.project, "src", "unapproved.ts") }).status).toBe(2);
      p.assertNoNestedState();
    }, 60_000);
  }

  // t331 keeps its existing seven-source-harness proof. Here source Claude
  // covers all lifecycle remedies; the same cases cross all seven native
  // runtimes, including the shared-directory Kiro/Kiro IDE and Copilot/OpenCode.
  for (const projection of ["source", "native"] as const) {
    const harnesses = projection === "native" ? HARNESS_RUNTIMES : [HARNESS_RUNTIMES[0]];
    for (const harness of harnesses) {
      for (const scenario of RESET_CASES) {
        test(`${projection}/${harness.name}: ${scenario.op} resolves, resets and resumes the target`, () => {
          const p = new Fixture(projection, harness, "state-mid-inception.md");
          let state = p.state().replace(
            `- [-] ${STAGE} — EXECUTE`, `- [${scenario.marker}] ${STAGE} — EXECUTE`,
          );
          if (scenario.op === "restore-or-jump") {
            state = state
              .replace("- **Current Stage**: requirements-analysis", "- **Current Stage**: build-and-test")
              .replace("- **Lifecycle Phase**: INCEPTION", "- **Lifecycle Phase**: CONSTRUCTION")
              .replace("- [ ] code-generation — EXECUTE", "- [x] code-generation — EXECUTE")
              .replace("- [ ] build-and-test — EXECUTE", "- [-] build-and-test — EXECUTE");
          }
          writeFileSync(seededStateFile(p.project), state);
          const questions = join(seededRecordDir(p.project), "inception", STAGE, `${STAGE}-questions.md`);
          const answers = "# Requirements Questions\n\n[Answer]: Preserve private saved searches.\n";
          mkdirSync(dirname(questions), { recursive: true });
          writeFileSync(questions, answers);

          const { refusal, remedy } = p.remedy(scenario.op);
          expect(refusal.state).toBe(scenario.lifecycle);
          expect(remedy.operation).toEqual({ kind: "restart-stage", stage: STAGE });
          const instruction = json(p.exact(remedy.command!));
          expect(instruction.kind, JSON.stringify(instruction)).toBe("print");
          expect(p.state()).toBe(state);
          expect(p.audit()).not.toContain("**Event**: STAGE_JUMPED");
          const match = /^Run `([^`]+)` to perform the jump/.exec(String(instruction.message));
          expect(match, JSON.stringify(instruction)).not.toBeNull();
          const jumpCommand = match![1];
          const jumpArgv = splitKiroCommandArgs(jumpCommand);
          expect(jumpArgv[jumpArgv.indexOf("--target") + 1]).toBe(STAGE);
          expect(jumpArgv[jumpArgv.indexOf("--direction") + 1]).toBe(scenario.direction);
          // Follow the returned instruction verbatim, not a test-rebuilt jump.
          const jumped = json(p.exact(jumpCommand));
          expect(jumped).toMatchObject({
            target: STAGE, direction: scenario.direction,
            state_updated: true, audit_appended: true,
          });
          expect(jumped.stages_reset).toContain(STAGE);
          expect(p.state()).toContain(`- [-] ${STAGE} — EXECUTE`);
          expect(p.state()).toContain(`- **Current Stage**: ${STAGE}`);
          expect(p.state()).toContain("- **Next Stage**: code-generation");
          if (scenario.direction === "backward") {
            expect(jumped.stages_reset).toContain("code-generation");
            expect(p.state()).toContain("- [ ] code-generation — EXECUTE");
            expect(p.state()).toContain("- [ ] build-and-test — EXECUTE");
          }
          expect(p.audit()).toContain("**Event**: STAGE_JUMPED");
          expect(p.audit()).toContain("**Event**: STAGE_STARTED");
          expect(p.audit()).not.toContain("**Event**: STAGE_COMPLETED");
          expect(readFileSync(questions, "utf-8")).toBe(answers);

          let directive = json(p.tool("orchestrate", ["next"]));
          for (let i = 0; directive.kind === "load-steering" && i < 64; i++) {
            expect(typeof directive.continue_token).toBe("string");
            directive = json(p.tool("orchestrate", ["continue", directive.continue_token as string]));
          }
          expect(directive, JSON.stringify(directive)).toMatchObject({
            kind: "run-stage", stage: STAGE,
          });
          expect(p.state()).toContain(`- [-] ${STAGE} — EXECUTE`);
          p.assertNoNestedState();
        }, 120_000);
      }
    }

    test(`${projection}/claude: direct abort admission discards the worktree without minting Plan Approval`, () => {
      const p = new Fixture(projection, HARNESS_RUNTIMES[0], "state-construction.md");
      writeFileSync(seededStateFile(p.project), p.state()
        .replace("- **Current Stage**: functional-design", "- **Current Stage**: code-generation")
        .replace("- [-] functional-design — EXECUTE", "- [x] functional-design — EXECUTE")
        .replace("- [ ] code-generation — EXECUTE", "- [-] code-generation — EXECUTE"));
      // Use different logical Unit and worktree slug so swapping their fields
      // cannot pass by coincidence. The fixture creates a real Git worktree.
      const unit = "alpha-unit";
      const slug = "alpha-attempt";
      succeeded(p.tool("worktree", ["create", "--slug", slug, "--base", "main"]));
      const worktree = join(p.project, ".aidlc", "worktrees", `bolt-${slug}`);
      expect(existsSync(worktree)).toBe(true);
      const baseBefore = succeeded(run(
        ["git", "rev-parse", "HEAD"], p.project, p.env,
      )).stdout;
      const { remedy } = p.remedy("abort-bolt", {
        blockedAction: "review", stage: "code-generation", unit,
        autonomousBolt: { unit, slug, batch: "1" },
      });
      expect(remedy.operation).toEqual({ kind: "abort-bolt", unit, slug });
      expect(p.state()).toContain("- **Current Stage**: code-generation");
      // Direct review refusal asks have no published selection marker. Exercise
      // the actual hook in both projections to pin this deliberate parity.
      expect(p.marker()).toBeNull();
      succeeded(p.guard("Bash", { command: remedy.command }));
      expect(p.guard("Bash", {
        command: `${remedy.command}; printf code > src/unapproved.ts`,
      }).status).toBe(2);
      expect(p.guard("Bash", { command: `${remedy.command} > src/unapproved.ts` }).status).toBe(2);
      const aborted = json(p.exact(remedy.command!));
      expect(aborted).toMatchObject({
        emitted: "BOLT_FAILED", reason: "aborted", failed_bolt: unit, slug, discarded: true,
      });
      expect(existsSync(worktree)).toBe(false);
      expect(succeeded(run(["git", "worktree", "list", "--porcelain"], p.project, p.env)).stdout)
        .not.toContain(`bolt-${slug}`);
      expect(run(["git", "show-ref", "--quiet", "--verify", `refs/heads/bolt-${slug}`], p.project, p.env).status)
        .toBe(1);
      expect(succeeded(run(["git", "rev-parse", "HEAD"], p.project, p.env)).stdout).toBe(baseBefore);
      expect(readFileSync(join(p.project, "src", "base.ts"), "utf-8")).toBe("export const base = 1;\n");
      const audit = p.audit();
      expect(audit).toContain("**Event**: WORKTREE_DISCARDED");
      expect(audit).toContain("**Event**: BOLT_FAILED");
      // Both owning processes append to this fixture's pinned clone shard.
      const shard = readFileSync(seededAuditShard(p.project), "utf-8");
      expect(shard.indexOf("**Event**: WORKTREE_DISCARDED")).toBeGreaterThanOrEqual(0);
      expect(shard.indexOf("**Event**: BOLT_FAILED"))
        .toBeGreaterThan(shard.indexOf("**Event**: WORKTREE_DISCARDED"));
      expect(audit).toContain(`**Failed Bolt**: ${unit}`);
      expect(audit).toContain("**Reason**: aborted");
      expect(audit).not.toContain("**Event**: BOLT_COMPLETED");
      expect(audit).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
      expect(p.marker()).toBeNull();
      expect(p.guard("Write", { file_path: join(p.project, "src", "unapproved.ts") }).status).toBe(2);
      expect(existsSync(join(p.project, "src", "unapproved.ts"))).toBe(false);
      expect(p.state()).not.toMatch(new RegExp(`^- \\*\\*Bolt Refs\\*\\*:.*bolt-${slug}`, "m"));
      p.assertNoNestedState();
    }, 120_000);
  }
});
