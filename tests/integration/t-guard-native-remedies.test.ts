// covers: function:evaluateGuardRefusal, function:guardRecoveryAskForRefusal,
// subcommand:aidlc-orchestrate:next, subcommand:aidlc-jump:execute,
// subcommand:aidlc-bolt:abort, subcommand:aidlc-testing-posture:fingerprint,
// subcommand:aidlc-testing-posture:verify, function:planSourceDriftRefusal
//
// Execute the evaluator's actual source/native remedies, including the jump
// command returned by next --stage. Lifecycle snapshots and spent recovery
// inputs are synthetic; the resulting mutations/audit rows use owning CLIs.
// Native evaluation imports dist-release under Bun; execution uses one compiled
// dispatcher with a calibrated Bun-denial PATH sentinel. No model is invoked.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  NATIVE_COMPILE_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { setDefaultTimeout, afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { appendAuditEntry } from "../../core/tools/aidlc-audit.ts";
import {
  boltName,
  worktreePath,
  type ActiveDirectiveMarker,
  getField,
  GUARD_POLICY_FIELD,
  type GuardRefusal,
  type GuardRefusalInput,
  markEngineTouch,
  setGuardPolicyLine,
  splitKiroCommandArgs,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../core/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../core/tools/aidlc-testing-posture.ts";
import {
  fixtureIntentId8,
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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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

// Windows inherits the variable as `Path`. A child given both `Path` and `PATH`
// resolves the inherited one, so the Bun-denial sentinel never shadows Bun and
// the calibration sees the real interpreter. Replace every case variant with
// the single PATH this test intends.
function withPath(env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^path$/i.test(key)) next[key] = value;
  }
  next.PATH = path;
  return next;
}

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
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
  ], { cwd: REPO_ROOT, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_COMPILE_TIMEOUT_MS) });
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
    env: withPath({ ...process.env, AIDLC_REMEDY_BUN_DENIAL_LOG: denialLog }, nativePath),
  });
  expect(calibration.status, calibration.stdout + calibration.stderr).toBe(91);
  expect(readFileSync(denialLog, "utf-8")).toContain("unexpected Bun invocation");
  rmSync(denialLog);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterAll(() => {
  // Retain compile/command/denial logs in ROOT/tmp for diagnosis.
  if (projectsDir) rmSync(projectsDir, { recursive: true, force: true });
  if (binDir) rmSync(binDir, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    this.evaluationEnv = withPath({
      ...env,
      AIDLC_PROJECT_DIR: this.project,
      CLAUDE_PROJECT_DIR: this.project,
      AIDLC_HARNESS_DIR: harness.dir,
      AIDLC_HARNESS_NAME: harness.name,
      AIDLC_RUNTIME_ROOT: runtimeRoot,
      AIDLC_UNATTENDED: "0",
      AIDLC_SESSION_OVERRIDE: "01995000-0995-7000-8000-000000000777",
      TMPDIR: scratch,
    }, `${dirname(BUN)}${delimiter}${process.env.PATH ?? ""}`);
    this.env = projection === "native"
      ? withPath({ ...this.evaluationEnv, AIDLC_REMEDY_BUN_DENIAL_LOG: denialLog }, nativePath)
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
    const path = join(seededRecordDir(this.project), ".aidlc-engine", "active-directive.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as ActiveDirectiveMarker : null;
  }

  hook(name: string, payload: Json): Run {
    const argv = this.projection === "native"
      ? ["aidlc", "engine", "hook", name, "--project-dir", this.project]
      : name === "record-human-turn"
        ? [BUN, join(this.tools, "aidlc.ts"), "engine", "hook", name]
        : [BUN, join(this.project, this.harness.dir, "hooks", `aidlc-${name}.ts`)];
    const input = {
      cwd: this.project, session_id: "01995000-0995-7000-8000-000000000777", ...payload,
    };
    const output = run(argv, this.cwd, this.env, input);
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
    const input = {
      cwd: this.project, session_id: "01995000-0995-7000-8000-000000000777", ...payload,
    };
    const output = run(argv, this.cwd, this.env, input);
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

function completeReview(
  fixture: Fixture,
  projectDir: string,
  iteration = 1,
): Json {
  fixture.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = "1";
  const stageDir = join(
    seededRecordDir(projectDir),
    "inception",
    STAGE,
  );
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, "requirements.md"), "# Requirements\n");
  writeFileSync(
    join(stageDir, `${STAGE}-questions.md`),
    "# Requirements Questions\n",
  );
  const requestArgs = [
    "review",
    "--stage",
    STAGE,
    "--reviewer",
    "aidlc-product-lead-agent",
    "--iteration",
    String(iteration),
  ];
  const argv = fixture.projection === "native"
    ? ["aidlc", "engine", "log", ...requestArgs, "--project-dir", projectDir]
    : [BUN, join(fixture.tools, "aidlc-log.ts"), ...requestArgs, "--project-dir", projectDir];
  const requested = json(run(argv, fixture.cwd, fixture.env));
  const reviewFile = join(projectDir, String(requested.reviewFile));
  mkdirSync(dirname(reviewFile), { recursive: true });
  writeFileSync(
    reviewFile,
    "## Review\n\n" +
      "**Verdict:** READY\n" +
      "**Reviewer:** aidlc-product-lead-agent\n" +
      `**Iteration:** ${iteration}\n\n` +
      "### Findings\n\nNo blocking findings.\n",
  );
  const recordVerdict = String(requested.recordVerdict);
  const recordArgs = splitKiroCommandArgs(recordVerdict);
  expect(recordArgs[recordArgs.indexOf("--project-dir") + 1]).toBe(projectDir);
  expect(recordArgs[recordArgs.indexOf("--reviewer") + 1])
    .toBe("aidlc-product-lead-agent");
  expect(recordArgs[recordArgs.indexOf("--iteration") + 1])
    .toBe(String(iteration));
  expect(recordArgs[recordArgs.indexOf("--verdict") + 1])
    .toBe("<READY|NOT-READY>");
  const completed = json(fixture.exact(
    recordVerdict.replace("<READY|NOT-READY>", "READY"),
  ));
  expect(completed.emitted).toBe("REVIEW_COMPLETED");
  return requested;
}

describe("source and native guard remedies execute their owning operations", () => {
  for (const projection of ["source", "native"] as const) {
    test(`${projection}: a returned verdict command closes a review in its target worktree`, () => {
      const p = new Fixture(projection, HARNESS_RUNTIMES[0], "state-mid-inception.md");
      const slug = `${projection}-review-target`;
      succeeded(p.tool("worktree", ["create", "--slug", slug, "--base", "main"]));
      const target = worktreePath(p.project, fixtureIntentId8(p.project), slug);
      expect(existsSync(target)).toBe(true);

      const requested = completeReview(p, target);
      const command = String(requested.recordVerdict);
      expect(command.startsWith("bun .claude/tools/aidlc-log.ts review "))
        .toBe(projection === "source");
      expect(command.startsWith("aidlc engine log review "))
        .toBe(projection === "native");
      const targetAudit = readdirSync(seededAuditDir(target))
        .filter((name) => name.endsWith(".md"))
        .map((name) => readFileSync(join(seededAuditDir(target), name), "utf-8"))
        .join("\n");
      expect(targetAudit).toContain("**Event**: REVIEW_COMPLETED");
      expect(p.audit()).not.toContain("**Event**: REVIEW_COMPLETED");
      p.assertNoNestedState();
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("finish-revision reopens the gate without executing the restart operation", () => {
    const p = new Fixture("source", HARNESS_RUNTIMES[0], "state-mid-inception.md");
    p.env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "1";
    completeReview(p, p.project);
    succeeded(p.tool("orchestrate", [
      "report", "--stage", STAGE, "--result", "awaiting-approval",
    ]));
    succeeded(p.tool("orchestrate", [
      "report", "--stage", STAGE, "--result", "rejected",
      "--user-input", "Request Changes", "--reason", "Clarify the requirement.",
    ]));
    expect(p.state()).toContain(`- [R] ${STAGE} — EXECUTE`);
    completeReview(p, p.project);

    const evaluated = json(run([BUN, "--eval", EVALUATE], p.project, {
      ...p.evaluationEnv,
      AIDLC_REMEDY_EVALUATOR_TOOLS: p.tools,
    }, {
      code: "REVISION_FINISH_EXECUTION",
      blockedAction: "complete",
      stage: STAGE,
      projectDir: p.project,
      stateContent: p.state(),
      invariant: "A reviewed revision reopens its existing approval gate.",
      userMessage: "The revision is ready to finish.",
      attempt: {
        recovery: "spent",
        summaryCoverage: "current",
        reviewCoverage: "current",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: false, unattended: false },
    } satisfies GuardRefusalInput));
    const refusal = evaluated.refusal as GuardRefusal;
    const finish = refusal.remedies.find((remedy) => remedy.op === "finish-revision");
    expect(finish).toMatchObject({
      interaction: "external-work",
      executableNow: true,
      requiresHuman: false,
    });
    expect(finish?.operation).toBeUndefined();
    expect(finish?.command).toBeUndefined();
    const finishCommand = /`([^`]+)`/.exec(finish!.action)?.[1];
    expect(finishCommand).toBeString();
    expect(finishCommand).toContain("--result revised");
    expect(finishCommand).toContain(`--project-dir '${p.project}'`);

    const before = p.audit();
    const finished = json(p.exact(finishCommand!));
    expect(finished).toMatchObject({
      kind: "print",
      message: `Recorded revised for "${STAGE}".`,
    });
    expect(p.state()).toContain(`- [?] ${STAGE} — EXECUTE`);
    const appended = p.audit().slice(before.length);
    expect(appended).toContain("**Event**: STAGE_AWAITING_APPROVAL");
    expect(appended).not.toContain("**Event**: STAGE_JUMPED");
    p.assertNoNestedState();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
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
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
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
        }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
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
      const worktree = worktreePath(p.project, fixtureIntentId8(p.project), slug);
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
        emitted: "BOLT_FAILED", reason: "aborted", abort_reason: "stale review recovery exhausted",
        failed_bolt: unit, slug, discarded: true,
      });
      expect(existsSync(worktree)).toBe(false);
      expect(succeeded(run(["git", "worktree", "list", "--porcelain"], p.project, p.env)).stdout)
        .not.toContain(boltName(fixtureIntentId8(p.project), slug));
      expect(run(["git", "show-ref", "--quiet", "--verify", `refs/heads/${boltName(fixtureIntentId8(p.project), slug)}`], p.project, p.env).status)
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
      expect(p.state()).not.toMatch(new RegExp(`^- \\*\\*Bolt Refs\\*\\*:.*${slug}`, "m"));
      p.assertNoNestedState();
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`${projection}/claude: the strict plan-drift ask's printed remedies run through the dispatcher on the fixture that printed them`, () => {
      const p = new Fixture(projection, HARNESS_RUNTIMES[0], "state-construction.md");
      const session = "01995000-0995-7000-8000-000000000777";
      let state = p.state()
        .replace("- **Current Stage**: functional-design", "- **Current Stage**: code-generation")
        .replace("- [-] functional-design — EXECUTE", "- [x] functional-design — EXECUTE")
        .replace("- [ ] code-generation — EXECUTE", "- [-] code-generation — EXECUTE");
      state = setGuardPolicyLine(state, "strict (set by you)");
      expect(getField(state, GUARD_POLICY_FIELD)).toBe("strict (set by you)");
      writeFileSync(seededStateFile(p.project), state);
      writeActiveDirectiveMarker(p.project, {
        kind: "run-stage", stage: "code-generation", state_sha256: stateDigest(state),
      });

      // Present and approve the plan through the owning tools, as the stage does.
      const dir = codeGenerationRecordDir(p.project, null);
      mkdirSync(dir, { recursive: true });
      const contract = succeeded(p.tool("testing-posture", ["render"])).stdout;
      writeFileSync(join(dir, "code-generation-plan.md"), `# Plan\n\n${contract}\n## Steps\n\n- [ ] Implement\n`);
      writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\n## Command\n\n`bun test unit.test.ts`\n");
      const questions = join(dir, "code-generation-questions.md");
      writeFileSync(questions, "## Plan Approval\n[Answer]:\n");
      const tags = succeeded(p.tool("testing-posture", ["fingerprint", "--stage-level"])).stdout.trim().split("\n");
      expect(tags).toHaveLength(2);
      writeFileSync(questions, ["## Plan Approval", ...tags, "A. Approve Plan", "B. Request Changes", "[Answer]:", ""].join("\n"));
      const identity = [
        "--stage", "code-generation", "--checkpoint", "plan-approval",
        "--questions-file", questions, "--session", session, "--stage-level",
      ];
      appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, p.project);
      succeeded(p.tool("log", [
        "decision", ...identity,
        "--decision", "Approve this exact Code Generation plan?",
        "--options", "Approve Plan,Request Changes",
      ]));
      succeeded(p.hook("record-human-turn", { hook_event_name: "UserPromptSubmit", prompt: "Approve Plan" }));
      writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]:\s*$/, "[Answer]: Approve Plan"));
      succeeded(p.tool("log", ["answer", ...identity, "--details", "Approve Plan"]));
      succeeded(p.tool("testing-posture", ["verify", "--stage-level"]));

      // The source moves after approval; the next dispatch is refused with the ask.
      writeFileSync(join(p.project, "src", "after.ts"), "export const after = 1;\n");
      const dispatch = {
        subagent_type: "aidlc-developer-agent",
        prompt: `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: sha256:${"0".repeat(64)}`,
      };
      const refused = p.guard("Task", dispatch);
      expect(refused.status, refused.stderr).toBe(2);
      const lines = refused.stderr.split(/\r?\n/).filter((line) => line.trim().length > 0);
      expect(lines[0]).toContain("src/after.ts");
      const ask = JSON.parse(lines[lines.length - 1]) as { remedies: GuardRefusal["remedies"] };
      expect(ask.remedies.map((remedy) => remedy.op)).toEqual([
        "reapprove-plan", "show-plan-drift", "stop-here", "lower-fence",
      ]);
      const [reapprove, show, , lowerFence] = ask.remedies;
      const prefix = projection === "native" ? "aidlc engine " : `bun ${p.harness.dir}/tools/aidlc-`;
      for (const remedy of [reapprove, show]) {
        expect(remedy.command, remedy.op).toStartWith(prefix);
        expect(remedy.interaction).toBe("command");
        // Each printed command is admitted by the hook that printed it, and
        // nothing appended to it is.
        succeeded(p.guard("Bash", { command: remedy.command }));
        expect(p.guard("Bash", { command: `${remedy.command}; printf code > src/unapproved.ts` }).status).toBe(2);
      }
      expect(lowerFence).toMatchObject({
        op: "lower-fence", interaction: "human-input", requiresHuman: true, executableNow: true,
      });
      expect(lowerFence.command).toBeUndefined();
      expect(lowerFence.operation).toBeUndefined();
      expect(lowerFence.action).toContain("typing /aidlc config set guard.plan-approval off yourself");
      expect(p.marker()).toMatchObject({ kind: "run-stage", stage: "code-generation" });
      // The one approval the fixture recorded before the drift is the only one
      // the ledger may ever hold: no remedy below mints another.
      const approvalRows = (audit: string) => audit.split("**Event**: PLAN_APPROVAL_RECORDED").length - 1;
      expect(approvalRows(p.audit())).toBe(1);

      // show: read-only, exit 2 carries the drift as the reason.
      const shown = p.exact(show.command!);
      expect(shown.status, shown.stderr).toBe(2);
      expect(JSON.parse(shown.stdout.trim()).reason).toContain("src/after.ts");
      expect(readFileSync(questions, "utf-8")).toContain("[Answer]: Approve Plan");

      // The typed human prompt lowers the fence at hook time. The dispatcher
      // can repeat that setting. A fresh directive and current brief retain
      // the original approval while continuing after source drift.
      expect(p.state()).not.toContain("- **Guards Off**:");
      const lowerFenceCommand = projection === "native"
        ? "aidlc engine config set guard.plan-approval off"
        : `bun ${p.harness.dir}/tools/aidlc.ts engine config set guard.plan-approval off`;
      succeeded(p.guard("Bash", { command: lowerFenceCommand }));
      expect(p.guard("Bash", { command: `${lowerFenceCommand}; printf code > src/unapproved.ts` }).status).toBe(2);
      markEngineTouch(p.project);
      const unchosen = p.exact(lowerFenceCommand);
      expect(unchosen.status).not.toBe(0);
      expect(unchosen.stderr).toContain("is the person's move");
      expect(p.state()).not.toContain("- **Guards Off**:");
      succeeded(p.hook("record-human-turn", {
        hook_event_name: "UserPromptSubmit", prompt: "/aidlc config set guard.plan-approval off", session_id: session,
      }));
      expect(p.state()).toMatch(/^- \*\*Guards Off\*\*: plan-approval \(set by you\)$/m);
      let audit = p.audit();
      expect(audit).toContain("**Event**: GUARD_DISABLED");
      expect(audit).toContain("**Guard**: plan-approval");
      expect(audit).not.toContain("**Event**: GUARD_STOOD_ASIDE");
      expect(approvalRows(audit)).toBe(1);
      const stateAfterPrompt = p.state();
      const unchanged = p.exact(lowerFenceCommand);
      expect(unchanged.status, unchanged.stderr).toBe(0);
      expect(unchanged.stdout).toContain("Fence plan-approval is already off");
      expect(p.state()).toBe(stateAfterPrompt);
      expect(p.audit()).toBe(audit);
      let directive = json(p.tool("orchestrate", ["next"]));
      for (let i = 0; directive.kind === "load-steering" && i < 64; i++) {
        const receipt = directive.receipt ?? directive.continue_token;
        expect(typeof receipt).toBe("string");
        directive = json(p.tool("orchestrate", ["continue", receipt as string]));
      }
      expect(directive, JSON.stringify(directive)).toMatchObject({ kind: "run-stage", stage: "code-generation" });
      const currentDispatch = {
        subagent_type: "aidlc-developer-agent",
        prompt: succeeded(p.tool("testing-posture", ["brief", "--stage-level"])).stdout,
      };
      const stoodAside = p.guard("Task", currentDispatch);
      expect(stoodAside.status, stoodAside.stderr).toBe(0);
      expect(stoodAside.stdout).toContain("Continuing past the plan-approval check because it is off for this piece of work");
      audit = p.audit();
      expect(audit).toContain("**Event**: GUARD_STOOD_ASIDE");
      expect(approvalRows(audit)).toBe(1);

      // approve-again explicitly withdraws the standing approval. An off fence
      // does not manufacture a replacement approval or another execution start.
      const reapproved = p.exact(reapprove.command!);
      expect(reapproved.status, reapproved.stderr).toBe(0);
      expect(reapproved.stdout.trim().split("\n")).toHaveLength(2);
      expect(reapproved.stdout).toContain("[Approval Fingerprint]: sha256:v3:");
      expect(reapproved.stdout).toContain("[Planned Source]: ");
      expect(reapproved.stderr).toContain("withdrawn");
      expect(readFileSync(questions, "utf-8")).not.toContain("[Answer]: Approve Plan");
      expect(readFileSync(questions, "utf-8")).toMatch(/\[Answer\]:[ \t]*$/m);
      expect(p.exact(show.command!).status).toBe(2);
      const afterWithdrawal = p.guard("Task", currentDispatch);
      expect(afterWithdrawal.status, afterWithdrawal.stderr).toBe(2);
      expect(afterWithdrawal.stderr).toContain("CODE_GENERATION_EXECUTION_INELIGIBLE");
      expect(p.state()).toMatch(/^- \*\*Guards Off\*\*: plan-approval \(set by you\)$/m);
      expect(p.audit()).toBe(audit);
      expect(approvalRows(p.audit())).toBe(1);
      expect(existsSync(join(p.project, "src", "unapproved.ts"))).toBe(false);
      p.assertNoNestedState();
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
