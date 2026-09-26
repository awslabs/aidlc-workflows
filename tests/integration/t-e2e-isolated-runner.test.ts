// covers: harness-instrument:isolated-e2e-parity
// Runs the real runner over tiny synthetic test files, never the live e2e suite.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createE2eTemporaryRoot, prepareE2eWorkers } from "../lib/e2e-workers.ts";
import { captureTestSource } from "../lib/test-source.ts";
import { selectedTuiBackend } from "../harness/tui-runtime.ts";
import { getNativeProcessIdentity } from "../harness/tui-process-identity.ts";
import { assertRunnerFixtureImports } from "../lib/runner-fixture-imports.ts";
import {
  FILE_CLEANUP_ENV, FILE_DEADLINE_ENV, NATIVE_STARTUP_TIMEOUT_MS, NATIVE_RUNTIME_CASE_TIMEOUT_MS,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
} from "../harness/test-budget.ts";

const SOURCE = resolve(import.meta.dir, "../..");
const roots: string[] = [];

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-isolated-runner-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function fixture(files: Record<string, string>): string {
  const root = scratch();
  for (const path of [
    "tests/run-tests.ts", "tests/run-tests.sh", "tests/gen-coverage-registry.ts",
    "tests/harness/claude-gate.ts", "tests/harness/tui-runtime.ts", "tests/harness/tui-record-file.ts",
    "tests/harness/tui-windows-private-file.ts",
    "tests/harness/runner-profile.ts",
    "tests/harness/test-budget.ts",
    "tests/lib/bun-junit-to-meta.ts", "tests/lib/test-sharding.ts",
    "tests/lib/e2e-plan.ts", "tests/lib/e2e-scheduler.ts", "tests/lib/e2e-workers.ts", "tests/lib/e2e-process.ts",
    "tests/lib/e2e-deferred-cleanup.ts",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(SOURCE, path), join(root, path));
  }
  assertRunnerFixtureImports(root);
  mkdirSync(join(root, "tests", "e2e"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "tests", "e2e", name), body);
  writeFileSync(join(root, ".gitignore"), "tests/logs/\nnode_modules/\ndist/\ndist-release/\n");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "isolation-marker"), "source");
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  return root;
}

function run(
  root: string, args: string[] = [], env: NodeJS.ProcessEnv = {},
  { timeoutMs = NATIVE_RUNTIME_CASE_TIMEOUT_MS } = {},
) {
  const inherited: NodeJS.ProcessEnv = { ...process.env, ...env, AIDLC_TEST_PACKAGE_READY: "1" };
  delete inherited.BUN_OPTIONS;
  // Native entrypoint keeps this contract test portable; outer operator runs
  // still use run-tests.sh with debug output and durable capture.
  const result = spawnSync(process.execPath, [
    join(root, "tests", "run-tests.ts"), "--debug", "-P", "8", "--e2e", "--no-llm", ...args,
  ], {
    cwd: root, env: inherited, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  const match = /Verbose mode: logging to (.+)/.exec(result.stdout);
  return {
    code: result.status, output: result.stdout + result.stderr,
    log: match?.[1].trim(),
    stdout: result.stdout, stderr: result.stderr, signal: result.signal,
    spawnError: result.error ? { name: result.error.name, message: result.error.message, code: (result.error as NodeJS.ErrnoException).code } : null,
  };
}

function retainRunnerDiagnostics(result: ReturnType<typeof run>, evidence: string): void {
  writeFileSync(join(evidence, "stdout.log"), result.stdout);
  writeFileSync(join(evidence, "stderr.log"), result.stderr);
  writeFileSync(join(evidence, "exit.json"), JSON.stringify({
    code: result.code, signal: result.signal, spawnError: result.spawnError, log: result.log,
  }, null, 2));
  if (!result.log) throw new Error("Nested runner did not report a diagnostic directory");
  // Retain report bytes before afterEach deletes the synthetic checkout. Do not
  // traverse retained projects, dependencies, or links as diagnostic evidence.
  const copy = (source: string, destination: string) => {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) {
      const from = join(source, name);
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (!["retained-fixtures", "node_modules", ".git"].includes(name)) copy(from, join(destination, name));
      } else if (stat.isFile() && /\.(log|json|ndjson|xml|txt|meta)$/.test(name)) {
        copyFileSync(from, join(destination, name));
      }
    }
  };
  copy(result.log, join(evidence, "nested-logs"));
}

function finishRunnerDiagnostics(
  result: ReturnType<typeof run>, evidence: string, observations: unknown, assertionFailed: boolean,
): void {
  console.log(`Initial log-write cancellation evidence: ${evidence}`);
  const failures: Array<{ operation: string; error: unknown }> = [];
  for (const [operation, write] of [
    ["observations", () => writeFileSync(join(evidence, "observations.json"), JSON.stringify(observations, null, 2))],
    ["nested-logs", () => retainRunnerDiagnostics(result, evidence)],
  ] as const) {
    try { write(); } catch (error) { failures.push({ operation, error }); }
  }
  if (!failures.length) return;
  const details = failures.map(({ operation, error }) => {
    const detail = error as NodeJS.ErrnoException;
    return { operation, name: detail.name, code: detail.code, message: detail.message ?? String(error) };
  });
  console.error(`Nested runner diagnostic retention failed: ${JSON.stringify(details)}`);
  try { writeFileSync(join(evidence, "retention-errors.json"), JSON.stringify(details, null, 2)); }
  catch (error) { console.error(`Could not write retention error report: ${String(error)}`); }
  // Keep a failing assertion authoritative. Successful assertions still require
  // complete retention; a report-copy failure must not turn that case green.
  if (!assertionFailed) throw failures[0].error;
}

function json<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}

const pass = 'import {test,expect} from "bun:test"; test("passes",()=>expect(true).toBe(true));\n';

function matrixPlan(root: string, options: {
  files: string[];
  backend?: "bun" | "tmux" | "node-pty" | "none";
  extraCase?: boolean;
  peer?: boolean;
}): string {
  for (const path of ["tests/lib/test-source.ts", "tests/lib/test-matrix.ts", "tests/reconcile-tests.ts"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(SOURCE, path), join(root, path));
  }
  const job = {
    id: "current", platform: process.platform, architecture: process.arch,
    backend: options.backend ?? "none",
    files: options.files.map((path) => ({
      path, cases: [
        { classname: "", name: "passes" },
        ...(options.extraCase ? [{ classname: "", name: "required but unexecuted" }] : []),
      ],
    })),
    gates: { AIDLC_TUI_LIVE: "0" },
  };
  const plan = join(scratch(), "plan.json");
  writeFileSync(plan, JSON.stringify({
    version: 1, cohortId: "runner-calibration",
    sourceDigest: captureTestSource(root).sourceDigest,
    jobs: [job, ...(options.peer ? [{
      ...job, id: "peer", platform: process.platform === "win32" ? "linux" : "win32",
    }] : [])],
  }));
  return plan;
}

describe("isolated e2e runner contracts", () => {
  test("isolated snapshots reject a tracked directory replaced by an external link before dispatch", async () => {
    const external = scratch();
    const witness = join(external, "executed");
    const body = `import { test } from "bun:test"; import { writeFileSync } from "node:fs";
test("external bytes must not execute", () => writeFileSync(${JSON.stringify(witness)}, "executed"));`;
    const root = fixture({ "t-linked.test.ts": 'import "../../payload/test.ts";' });
    const directory = join(root, "payload");
    mkdirSync(directory);
    writeFileSync(join(directory, "test.ts"), pass);
    // Ignore the replacement link itself; cached descendants still remain in
    // ls-files and must not bypass ancestor validation via a leaf-only lstat.
    writeFileSync(join(root, ".gitignore"), `${readFileSync(join(root, ".gitignore"), "utf8")}payload\n`);
    git(root, ["add", "-f", "payload"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", "tracked payload"]);
    rmSync(directory, { recursive: true });
    writeFileSync(join(external, "test.ts"), body);
    symlinkSync(external, directory, process.platform === "win32" ? "junction" : "dir");
    // Git still names payload/test.ts as an ordinary tracked descendant.
    // The direct entry call proves rejection before any storage estimate/copy.
    await expect(prepareE2eWorkers(root, scratch(), 1)).rejects.toThrow("payload");
    const result = run(root, ["--isolated-e2e"]);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("symlink");
    expect(result.output).toContain("payload");
    expect(result.output).not.toContain("=== START t-linked.test.ts");
    expect(existsSync(witness)).toBe(false);
  });

  test("relative in-tree fixture links remain links and execute only worker copies", () => {
    const root = fixture({ "t-linked.test.ts": `import { test, expect } from "bun:test";
import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
test("relative alias is private", () => {
  expect(readlinkSync("alias.txt")).toBe("data.txt");
  writeFileSync("alias.txt", "worker bytes");
  expect(readFileSync("data.txt", "utf8")).toBe("worker bytes");
});` });
    writeFileSync(join(root, "data.txt"), "source bytes");
    symlinkSync("data.txt", join(root, "alias.txt"), "file");
    const result = run(root, ["--isolated-e2e"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("=== DONE t-linked.test.ts (PASS)");
    expect(readlinkSync(join(root, "alias.txt"))).toBe("data.txt");
    expect(readFileSync(join(root, "data.txt"), "utf8")).toBe("source bytes");
  });

  test("copied runners reject missing platform-gated imports on every host", () => {
    const root = fixture({ "t-proof.test.ts": pass });
    rmSync(join(root, "tests/harness/tui-windows-private-file.ts"));
    expect(() => assertRunnerFixtureImports(root)).toThrow("imports missing");
  });

  test("unfiltered deterministic deep tiers skip the closed Claude preflight without failing", () => {
    const root = fixture({ "t-deterministic.test.ts": pass });
    const integration = join(root, "tests", "integration");
    mkdirSync(integration, { recursive: true });
    const driver = "drive" + "Aidlc";
    writeFileSync(join(integration, "t19.test.ts"), [
      'import { test } from "bun:test";',
      `function ${driver}() { throw new Error("closed Claude preflight executed"); }`,
      `test("Claude preflight", () => ${driver}());`,
    ].join("\n"));
    writeFileSync(join(integration, "t-deterministic.test.ts"), pass);
    const result = run(root, ["--integration", "--isolated-e2e"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("RESULT: PASS");
    expect(result.output).not.toContain("## Preflight Health Check");
    expect(result.output).not.toContain("PREFLIGHT FAILURE");
    expect(result.output).toContain("=== DONE t19.test.ts (SKIP) ===");
  });

  for (const isolated of [false, true]) {
    test(`matrix receipts include the implicit preflight and real JUnit (isolated=${isolated})`, () => {
      const root = fixture({
        "t-tui-preflight.serial.test.ts": pass,
        "t-tui-probe.serial.test.ts": pass,
      });
      const plan = matrixPlan(root, {
        files: ["tests/e2e/t-tui-preflight.serial.test.ts", "tests/e2e/t-tui-probe.serial.test.ts"],
        backend: selectedTuiBackend(),
      });
      const result = run(root, [
        ...(isolated ? ["--isolated-e2e"] : []), "--filter", "^t-tui-probe",
        "--matrix-plan", plan, "--matrix-job", "current",
      ]);
      expect(result.code, result.output).toBe(0);
      const receiptPath = join(result.log!, "test-matrix-receipt.json");
      const receipt = json<{
        status: string; sourceUnchanged: boolean; files: Array<{junitSha256: string}>;
        runtimeIdentity: {backend: string};
      }>(receiptPath);
      expect(receipt.status).toBe("PASS");
      expect(receipt.sourceUnchanged).toBe(true);
      expect(receipt.runtimeIdentity.backend).toBe(selectedTuiBackend());
      expect(receipt.files).toHaveLength(2);
      for (const file of receipt.files) expect(file.junitSha256).toMatch(/^[a-f0-9]{64}$/);
      const output = join(scratch(), "matrix.json");
      const reconciled = spawnSync(process.execPath, [
        join(root, "tests/reconcile-tests.ts"), "reconcile", "--plan", plan,
        "--receipt", receiptPath, "--output", output,
      ], { cwd: root, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS });
      expect(reconciled.status, reconciled.stderr).toBe(0);
      expect(json<{complete: boolean}>(output).complete).toBe(true);
    });
  }

  test("a complete passing run cannot satisfy a matrix with a missing case", () => {
    const root = fixture({ "t-proof.test.ts": pass });
    const plan = matrixPlan(root, { files: ["tests/e2e/t-proof.test.ts"], extraCase: true });
    const result = run(root, ["--matrix-plan", plan, "--matrix-job", "current"]);
    expect(result.code, result.output).not.toBe(0);
    expect(json<{status: string}>(join(result.log!, "test-matrix-receipt.json")).status).toBe("FAIL");
    expect(readFileSync(join(result.log!, "summary.txt"), "utf8")).toContain("Result: FAIL");
    expect(readFileSync(join(result.log!, "failures.txt"), "utf8")).toContain("test matrix job");
  });

  test("the wrong matrix backend stops dispatch", () => {
    const root = fixture({ "t-proof.test.ts": pass });
    const plan = matrixPlan(root, { files: ["tests/e2e/t-proof.test.ts"], backend: "node-pty" });
    const result = run(root, ["--matrix-plan", plan, "--matrix-job", "current"]);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).not.toContain("=== START");
    expect(json<{status: string}>(join(result.log!, "test-matrix-receipt.json")).status).toBe("FAIL");
  });

  test("a passing job receipt cannot hide a missing platform job", () => {
    const root = fixture({ "t-proof.test.ts": pass });
    const plan = matrixPlan(root, { files: ["tests/e2e/t-proof.test.ts"], peer: true });
    const result = run(root, ["--matrix-plan", plan, "--matrix-job", "current"]);
    expect(result.code, result.output).toBe(0);
    const output = join(scratch(), "matrix.json");
    const reconciled = spawnSync(process.execPath, [
      join(root, "tests/reconcile-tests.ts"), "reconcile", "--plan", plan,
      "--receipt", join(result.log!, "test-matrix-receipt.json"), "--output", output,
    ], { cwd: root, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS });
    expect(reconciled.status, reconciled.stderr).toBe(1);
    const report = json<{complete: boolean; obligations: Array<{jobId: string; status: string}>}>(output);
    expect(report.complete).toBe(false);
    expect(report.obligations.some((row) => row.jobId === "peer" && row.status === "MISSING-INCOMPLETE")).toBe(true);
  });

  test("matrix finalization cannot seal PASS after report publication fails", () => {
    const root = fixture({
      "t-proof.test.ts": `
import {test,expect} from "bun:test";
import {mkdirSync} from "node:fs";
import {join,resolve} from "node:path";
test("passes",()=>{
  mkdirSync(join(resolve(process.env.AIDLC_TEST_WORKER_ROOT!,"../.."),"coverage.json"));
  expect(true).toBe(true);
});
`,
    });
    const plan = matrixPlan(root, { files: ["tests/e2e/t-proof.test.ts"] });
    const result = run(root, [
      "--isolated-e2e", "--matrix-plan", plan, "--matrix-job", "current",
    ]);
    expect(result.code, result.output).not.toBe(0);
    expect(existsSync(join(result.log!, "e2e-artifacts", "t-proof", "junit.xml"))).toBe(true);
    const receipt = join(result.log!, "test-matrix-receipt.json");
    expect(existsSync(receipt)).toBe(false);
    const output = join(scratch(), "matrix.json");
    const reconciled = spawnSync(process.execPath, [
      join(root, "tests/reconcile-tests.ts"), "reconcile", "--plan", plan,
      "--output", output,
    ], { cwd: root, encoding: "utf8", timeout: NATIVE_STARTUP_TIMEOUT_MS });
    expect(reconciled.status, reconciled.stderr).not.toBe(0);
    expect(json<{complete: boolean}>(output).complete).toBe(false);
  });

  test("an isolated worker source edit cannot satisfy an unchanged coordinator plan", () => {
    const body = `
import {test,expect} from "bun:test";
import {appendFileSync} from "node:fs";
test("passes",()=>{
  appendFileSync(import.meta.path,"\\n// worker source changed\\n");
  expect(true).toBe(true);
});
`;
    const root = fixture({ "t-proof.test.ts": body });
    const plan = matrixPlan(root, { files: ["tests/e2e/t-proof.test.ts"] });
    const result = run(root, [
      "--isolated-e2e", "--matrix-plan", plan, "--matrix-job", "current",
    ]);
    expect(result.code, result.output).not.toBe(0);
    expect(readFileSync(join(root, "tests/e2e/t-proof.test.ts"), "utf8")).toBe(body);
    const proof = json<{expected: string; before: string; after: string}>(
      join(result.log!, "e2e-artifacts", "t-proof", "matrix-worker-source.json"),
    );
    expect(proof.before).toBe(proof.expected);
    expect(proof.after).not.toBe(proof.expected);
    expect(json<{status: string}>(join(result.log!, "test-matrix-receipt.json")).status).toBe("FAIL");
    expect(readFileSync(join(result.log!, "failures.txt"), "utf8")).toContain("authored source mismatch");
    const storage = json<{root: string; retained: boolean}>(join(result.log!, "e2e-worker-storage.json"));
    expect(storage.retained).toBe(true);
    roots.push(storage.root);
  });

  test("temporary roots avoid incomplete Git markers without deleting them", async () => {
    const root = scratch();
    const marked = join(root, "marked");
    mkdirSync(join(marked, ".git"), { recursive: true });
    // This machine's default temp can itself contain an incomplete marker.
    // The production fallback must remain available to this test as well.
    const clean = await createE2eTemporaryRoot();
    roots.push(clean);
    const child = await createE2eTemporaryRoot([marked, clean]);
    expect(dirname(child)).toBe(clean);
    expect(existsSync(join(marked, ".git"))).toBe(true);
  });

  test("plan mode lists every selected file without packaging, spawning tests, or creating logs", () => {
    const root = fixture({
      "t02.test.ts": pass,
      "t-exec-codex-small.serial.test.ts": pass,
    });
    const planned = run(root, ["--e2e-plan"]);
    expect(planned.code, planned.output).toBe(0);
    const plan = JSON.parse(planned.output);
    expect(plan.files.map((row: { file: string }) => row.file).sort()).toEqual([
      "tests/e2e/t-exec-codex-small.serial.test.ts", "tests/e2e/t02.test.ts",
    ]);
    expect(existsSync(join(root, "tests", "logs"))).toBe(false);
    const filtered = run(root, ["--e2e-plan", "--filter", "^t02$"]);
    expect(filtered.code, filtered.output).toBe(0);
    expect(JSON.parse(filtered.output).files).toHaveLength(1);
    expect(run(root, ["--e2e-plan", "--filter", "missing-file"]).code).toBe(2);
  });

  test("serial and isolated modes preserve selected files, assertions, failures, and skip counts", () => {
    const root = fixture({
      "t01-pass.test.ts": pass,
      "t02-fail.test.ts": 'import {test,expect} from "bun:test"; test("fails",()=>expect(1).toBe(2));',
      "t03-skip.test.ts": 'import {test} from "bun:test"; test.skip("not executed",()=>{});',
    });
    const serial = run(root);
    const isolated = run(root, ["--isolated-e2e"]);
    expect(serial.code, serial.output).toBe(1);
    expect(isolated.code, isolated.output).toBe(1);
    const totals = (output: string) => output.split("\n")
      .filter((line) => /^(?:Test files|Failed files|Total assertions|Failed assertions):/.test(line));
    expect(totals(isolated.output)).toEqual(totals(serial.output));
    const report = json<{ selectedFiles: number; coverageComplete: boolean; files: Array<{
      file: string; state: string; cases: { total: number; passed: number; failed: number; skipped: number };
    }> }>(join(isolated.log!, "e2e-results.json"));
    expect(report.selectedFiles).toBe(3);
    expect(report.coverageComplete).toBe(false);
    expect(report.files.map((row) => row.file).sort()).toEqual([
      "tests/e2e/t01-pass.test.ts", "tests/e2e/t02-fail.test.ts", "tests/e2e/t03-skip.test.ts",
    ]);
    expect(report.files.map((row) => row.cases)).toEqual([
      { total: 1, passed: 1, failed: 0, skipped: 0 },
      { total: 1, passed: 0, failed: 1, skipped: 0 },
      { total: 1, passed: 0, failed: 0, skipped: 1 },
    ]);
    expect(report.files.at(-1)!.state).toBe("SKIP");
    for (const name of ["t01-pass", "t02-fail", "t03-skip"]) {
      expect(existsSync(join(isolated.log!, "e2e-artifacts", name, "junit.xml"))).toBe(true);
    }
  });

  test("a native Windows Codex-only plan allocates one worker for its serial group", () => {
    const root = fixture({
      "t-exec-codex-a.serial.test.ts": pass,
      "t-exec-codex-b.serial.test.ts": pass,
    });
    const planned = run(root, ["--e2e-plan", "--bedrock-parallel", "2"]);
    expect(planned.code, planned.output).toBe(0);
    const plan = JSON.parse(planned.output);
    expect(plan.files).toHaveLength(2);
    expect(plan.workers).toBe(process.platform === "win32" ? 1 : 2);
    for (const file of plan.files) {
      expect(file.resources).toEqual(["bedrock"]);
      if (process.platform === "win32") expect(file.serialGroup).toBe("windows-codex");
      else expect(file.serialGroup).toBeUndefined();
    }
  });

  test("known serial files overlap in isolated checkouts with separate profiles and generated files", () => {
    const shared = scratch();
    const body = `
import {test,expect} from "bun:test";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
test("worker isolation", async()=>{
  const peer = process.env.AIDLC_BARRIER!;
  const id = process.env.AIDLC_TEST_NAME!;
  const marker = join(process.cwd(),"dist","isolation-marker");
  expect(readFileSync(marker,"utf8")).toBe("source");
  expect(spawnSync("git",["rev-parse","--show-toplevel"],{
    cwd:process.env.TEMP,stdio:"ignore"
  }).status).not.toBe(0);
  writeFileSync(marker,id);
  writeFileSync(join(peer,id), JSON.stringify({
    cwd:process.cwd(),profile:process.env.CLAUDE_CONFIG_DIR,socket:process.env.AIDLC_TUI_TMUX_SOCKET
  }));
  const names=["t-run-opencode-a.serial.test.ts","t-run-opencode-b.serial.test.ts"];
  const end=Date.now()+${NATIVE_STARTUP_TIMEOUT_MS};
  while(!names.every(name=>existsSync(join(peer,name)))&&Date.now()<end) await Bun.sleep(10);
  expect(names.every(name=>existsSync(join(peer,name)))).toBe(true);
  expect(readFileSync(marker,"utf8")).toBe(id);
},${NATIVE_FIXTURE_SETUP_TIMEOUT_MS});
`;
    const root = fixture({
      "t-run-opencode-a.serial.test.ts": body,
      "t-run-opencode-b.serial.test.ts": body,
    });
    const result = run(root, ["--isolated-e2e", "--bedrock-parallel", "2"], { AIDLC_BARRIER: shared });
    expect(result.code, result.output).toBe(0);
    const observations = readdirSync(shared).map((file) => json<{ cwd: string; profile: string; socket: string }>(join(shared, file)));
    for (const key of ["cwd", "profile", "socket"] as const) {
      expect(new Set(observations.map((row) => row[key])).size).toBe(2);
    }
    expect(readFileSync(join(root, "dist", "isolation-marker"), "utf8")).toBe("source");
    const events = readFileSync(join(result.log!, "e2e-events.ndjson"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(events.slice(0, 2).every((event) => event.kind === "start")).toBe(true);
    expect(events.filter((event) => event.kind === "finish")).toHaveLength(2);
  });

  test("parallel file retirement preserves every result across repeated worker reuse", () => {
    // Exercise overlapping process-tree cleanup over several waves. A runtime
    // pipe/handle failure must not silently lose later files or their reports.
    const files = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [
      `t-retire-${String(index).padStart(2, "0")}.test.ts`,
      `import {test,expect} from "bun:test";
test("owned file ${index}", async () => {
  await Bun.sleep(${20 + (index % 8) * 10});
  expect(process.env.AIDLC_TEST_WORKER_ID).toBeDefined();
});`,
    ]));
    const root = fixture(files);
    const result = run(root, ["--isolated-e2e", "--bedrock-parallel", "8", "--require-coverage"]);
    expect(result.code, result.output).toBe(0);
    const report = json<{ state: string; coverageComplete: boolean; files: Array<{ state: string; worker: number }> }>(
      join(result.log!, "e2e-results.json"),
    );
    expect(report.state).toBe("COMPLETE");
    expect(report.coverageComplete).toBe(true);
    expect(report.files).toHaveLength(24);
    expect(report.files.every((file) => file.state === "PASS")).toBe(true);
    expect(new Set(report.files.map((file) => file.worker)).size).toBe(8);
    const coverage = json<{ files: Array<{ cases: { total: number; skipped: number } }> }>(
      join(result.log!, "coverage.json"),
    );
    expect(coverage.files.reduce((sum, file) => sum + file.cases.total, 0)).toBe(24);
    expect(coverage.files.reduce((sum, file) => sum + file.cases.skipped, 0)).toBe(0);
    const storage = json<{ root: string }>(join(result.log!, "e2e-worker-storage.json"));
    expect(existsSync(storage.root)).toBe(false);
  });

  test("outer file deadline records a failure and retains incremental evidence", () => {
    const root = fixture({
      "t-hang.serial.test.ts": `
import {test} from "bun:test";
test("hang",async()=>{console.log("BEFORE_TIMEOUT"); await new Promise(()=>{});},30000);
`,
    });
    // The file hangs, so any deadline exercises this path. A quarter of it is
    // the cleanup reserve, which must cover retiring the worker on a loaded
    // Windows runner; one second left 250 ms and was reported as ERROR.
    const result = run(root, ["--isolated-e2e", "--e2e-file-timeout", "20"]);
    expect(result.code, result.output).toBe(1);
    const report = json<{ state: string; files: Array<{ state: string; timedOut: boolean }> }>(
      join(result.log!, "e2e-results.json"),
    );
    expect(report.state, result.output).toBe("FAIL");
    expect(report.files[0].state, result.output).toBe("TIMED_OUT");
    expect(report.files[0].timedOut, result.output).toBe(true);
    expect(readFileSync(join(result.log!, "t-hang.serial.log"), "utf8")).toContain("BEFORE_TIMEOUT");
    expect(readFileSync(join(result.log!, "failures.txt"), "utf8")).toContain("deadline");
  });

  test("an empty file is visible as unexecuted coverage", () => {
    const root = fixture({ "t-empty.test.ts": "export {};" });
    const result = run(root, ["--isolated-e2e"]);
    expect(result.code, result.output).toBe(0);
    const report = json<{ coverageComplete: boolean; files: Array<{ state: string }> }>(
      join(result.log!, "e2e-results.json"),
    );
    expect(report.coverageComplete).toBe(false);
    expect(report.files[0].state).toBe("SKIP");
  });

  test("an unwritable debug log stops dispatch and retires its test instead of hanging", () => {
    const root = fixture({
      "t01-capture.serial.test.ts": `
import {test} from "bun:test";
import {mkdirSync,renameSync} from "node:fs";
import {join} from "node:path";
test("capture failure",async()=>{
  const path=join(process.env.AIDLC_TEST_LOG_DIR!,"t01-capture.serial.log");
  renameSync(path,path+".before");
  mkdirSync(path);
  console.log("OUTPUT_AFTER_CAPTURE_FAILURE");
  await new Promise(()=>{});
},${NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS});
`,
      "t02-later.test.ts": 'import {test} from "bun:test"; test("later",()=>{console.log("LATER_FILE_RAN");});',
    });
    const result = run(root);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("test output capture failed");
    expect(result.output).not.toContain("LATER_FILE_RAN");
    expect(readFileSync(join(result.log!, "summary.txt"), "utf8")).toContain("Result: FAIL");
    expect(readFileSync(join(result.log!, "failures.txt"), "utf8")).toContain("test output capture failed");
  });

  test("ordinary assertion failures retain evidence and release generated checkout copies", () => {
    const root = fixture({
      "t-fail.test.ts": 'import {test,expect} from "bun:test"; test("actual failure",()=>expect(1).toBe(2));',
    });
    const result = run(root, ["--isolated-e2e"]);
    expect(result.code, result.output).toBe(1);
    const storage = json<{root: string; retained: boolean}>(join(result.log!, "e2e-worker-storage.json"));
    expect(storage.retained).toBe(false);
    expect(existsSync(storage.root)).toBe(false);
    expect(readFileSync(join(result.log!, "t-fail.log"), "utf8")).toContain("actual failure");
    expect(existsSync(join(result.log!, "e2e-artifacts", "t-fail", "junit.xml"))).toBe(true);
  });

  test("nested assertion diagnostics survive deletion of their synthetic checkout", () => {
    const root = fixture({
      "t-original-failure.test.ts": 'import {test,expect} from "bun:test"; test("ORIGINAL_NESTED_ASSERTION",()=>expect(1).toBe(2));',
    });
    const result = run(root);
    const outerLogs = process.env.AIDLC_TEST_LOG_DIR ?? join(SOURCE, "tmp");
    mkdirSync(outerLogs, { recursive: true });
    const evidence = mkdtempSync(join(outerLogs, "nested-failure-retention-"));
    retainRunnerDiagnostics(result, evidence);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    expect(existsSync(root)).toBe(false);
    expect(json<{ code: number }>(join(evidence, "exit.json")).code).toBe(1);
    expect(readFileSync(join(evidence, "stdout.log"), "utf8")).toContain("ORIGINAL_NESTED_ASSERTION");
    expect(readFileSync(join(evidence, "nested-logs/t-original-failure.log"), "utf8")).toContain("Received: 1");
    expect(readFileSync(join(evidence, "nested-logs/t-original-failure.junit.xml"), "utf8")).toContain("<failure");
    expect(readFileSync(join(evidence, "nested-logs/summary.txt"), "utf8")).toContain("Result: FAIL");
    expect(readFileSync(join(evidence, "nested-logs/failures.txt"), "utf8")).toContain("ORIGINAL_NESTED_ASSERTION");
  });

  test("a nested log-copy error preserves observations and the original assertion", () => {
    const root = fixture({ "t-original-failure.test.ts": pass });
    const result = run(root);
    expect(result.code, result.output).toBe(0);
    // A real file where the recursive copier expects a directory causes ENOTDIR.
    const invalid = { ...result, log: join(result.log!, "t-original-failure.log") };
    const outerLogs = process.env.AIDLC_TEST_LOG_DIR ?? join(SOURCE, "tmp");
    mkdirSync(outerLogs, { recursive: true });
    const evidence = mkdtempSync(join(outerLogs, "nested-retention-error-"));
    const observations = { probes: [{ pid: 123, error: { code: "ESRCH" } }] };
    const original = new Error("ORIGINAL_ASSERTION_MUST_SURVIVE");
    expect(() => {
      try { throw original; }
      finally { finishRunnerDiagnostics(invalid, evidence, observations, true); }
    }).toThrow(original);
    expect(json<typeof observations>(join(evidence, "observations.json"))).toEqual(observations);
    expect(json<Array<{ operation: string; code: string }>>(join(evidence, "retention-errors.json")))
      .toMatchObject([{ operation: "nested-logs", code: "ENOTDIR" }]);
    expect(readFileSync(join(evidence, "stdout.log"), "utf8")).toBe(result.stdout);
    expect(() => finishRunnerDiagnostics(invalid, evidence, observations, false)).toThrow();
  });

  test("an initial log-write failure cancels admitted siblings and stops the queue", async () => {
    const witnessRoot = scratch();
    const pending = join(witnessRoot, "pending");
    const witnesses = join(witnessRoot, "published");
    mkdirSync(pending);
    mkdirSync(witnesses);
    // Reproduce the interrupted-open state on every run. This empty, unpublished
    // file must coexist with real witnesses without ever reaching a PID probe.
    const interruptedWitness = join(pending, "interrupted");
    writeFileSync(interruptedWitness, "");
    const queuedWitness = join(scratch(), "queued");
    const readinessTimeoutMs = NATIVE_STARTUP_TIMEOUT_MS;
    const parentTimeoutMs = NATIVE_RUNTIME_CASE_TIMEOUT_MS;
    const workerTimeoutMs = NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS;
    // Cancellation must finish before either worker deadline can expire.
    // The enclosing case also leaves time to retain diagnostics after a watchdog failure.
    expect(readinessTimeoutMs).toBeLessThan(parentTimeoutMs);
    expect(parentTimeoutMs).toBeLessThan(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    expect(NATIVE_FIXTURE_SETUP_TIMEOUT_MS).toBeLessThan(workerTimeoutMs);
    const files: Record<string, string> = {};
    for (let i = 1; i <= 7; i++) {
      files[`t0${i}-waiting.test.ts`] = `
import {test} from "bun:test";
import {renameSync,writeFileSync} from "node:fs";
test("waits",async()=>{
  writeFileSync(${JSON.stringify(join(pending, String(i)))},String(process.pid));
  renameSync(${JSON.stringify(join(pending, String(i)))},${JSON.stringify(join(witnesses, String(i)))});
  await new Promise(()=>{});
},${workerTimeoutMs});
`;
    }
    files["t08-write-error.test.ts"] = pass;
    files["t09-queued.test.ts"] = `import {test} from "bun:test"; import {writeFileSync} from "node:fs";
test("queued",()=>{writeFileSync(${JSON.stringify(queuedWitness)},"executed");console.log("QUEUED_SENTINEL_RAN");});`;
    const root = fixture(files);
    const path = join(root, "tests", "run-tests.ts");
    const source = readFileSync(path, "utf8");
    const needle = "if (streamPath) writeFileSync(streamPath,";
    expect(source.split(needle)).toHaveLength(2);
    writeFileSync(path, source.replace(needle, `
if (streamPath && base === "t08-write-error.test.ts") {
  const deadline=Date.now()+${readinessTimeoutMs};
  while(!existsSync(${JSON.stringify(join(witnesses, "1"))}) && Date.now()<deadline) await Bun.sleep(20);
  if(!existsSync(${JSON.stringify(join(witnesses, "1"))})) throw new Error("Waiting sibling did not publish its PID before the readiness deadline");
  mkdirSync(streamPath);
}
${needle}`));
    const outerLogs = process.env.AIDLC_TEST_LOG_DIR ?? join(SOURCE, "tmp");
    mkdirSync(outerLogs, { recursive: true });
    const evidence = mkdtempSync(join(outerLogs, "initial-log-write-"));
    const started = Date.now();
    const workerFileDeadlineMs = started + workerTimeoutMs;
    const result = run(root, ["--file-timeout", String(workerTimeoutMs / 1000)], {
      // Keep the nested file watchdog beyond the parent backstop as well as the
      // explicit Bun case timeout; an inherited outer deadline must not reap the waiters.
      [FILE_DEADLINE_ENV]: String(workerFileDeadlineMs),
      [FILE_CLEANUP_ENV]: "0",
    }, { timeoutMs: parentTimeoutMs });
    const elapsedMs = Date.now() - started;
    const probes: Array<{ pid: number; returned?: boolean; error?: { name: string; message: string; code?: string } }> = [];
    let assertionFailed = false;
    try {
      expect(result.spawnError, result.output).toBeNull();
      expect(result.signal, result.output).toBeNull();
      expect(result.code, result.output).toBe(1);
      expect(elapsedMs, result.output).toBeLessThan(parentTimeoutMs);
      expect(result.stderr, result.output).toContain("EISDIR");
      expect(result.output).not.toContain("test file exceeded its allocated file/run deadline");
      expect(result.output).not.toContain("QUEUED_SENTINEL_RAN");
      const files = readdirSync(witnesses);
      expect(files.length, result.output).toBeGreaterThan(0);
      for (const file of files) {
        // Preserve the original immediate read/probe ordering. Archive I/O and
        // the additional queued-file assertion happen after these observations.
        const value = readFileSync(join(witnesses, file), "utf8");
        const pid = Number(value);
        const diagnostic = `Sibling ${file}, value=${JSON.stringify(value)}, pid=${pid}; evidence: ${evidence}`;
        expect(value, diagnostic).toMatch(/^[1-9]\d*$/);
        expect(Number.isSafeInteger(pid), diagnostic).toBe(true);
        expect(pid, diagnostic).toBeGreaterThan(0);
        if (process.platform === "win32") {
          // Windows keeps an exited process openable while any handle to it
          // remains, so signal 0 can still succeed after its job was torn down.
          // The native identity reports exit as absence.
          const identity = await getNativeProcessIdentity(pid);
          probes.push({ pid, returned: identity !== null });
          expect(identity, diagnostic).toBeNull();
          continue;
        }
        expect(() => {
          try { process.kill(pid, 0); probes.push({ pid, returned: true }); }
          catch (error) {
            const detail = error as NodeJS.ErrnoException;
            probes.push({ pid, error: { name: detail.name, message: detail.message, code: detail.code } });
            throw error;
          }
        }, diagnostic).toThrow();
        expect(probes.at(-1)?.error?.code, diagnostic).toBe("ESRCH");
      }
      expect(existsSync(queuedWitness), result.output).toBe(false);
      expect(readFileSync(interruptedWitness, "utf8")).toBe("");
      expect(lstatSync(join(result.log!, "t08-write-error.log")).isDirectory()).toBe(true);
    } catch (error) {
      assertionFailed = true;
      throw error;
    } finally {
      let records: Array<{ file: string; value: string }> = [];
      let witnessReadError: string | undefined;
      try { records = readdirSync(witnesses).map(file => ({ file, value: readFileSync(join(witnesses, file), "utf8") })); }
      catch (error) { witnessReadError = String(error); }
      finishRunnerDiagnostics(result, evidence, {
        elapsedMs, records, probes, queuedExecuted: existsSync(queuedWitness), witnessReadError,
        readinessTimeoutMs, parentTimeoutMs, workerTimeoutMs, workerFileDeadlineMs, interruptedWitness,
      }, assertionFailed);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test.each(["coverage.json", "e2e-worker-storage.json"])("finalization failure at %s still disposes safe copies and reports ERROR", (name) => {
    const root = fixture({
      "t-finalization.test.ts": `
import {test,expect} from "bun:test";
import {existsSync,mkdirSync,renameSync} from "node:fs";
import {join,resolve} from "node:path";
test("finalization evidence",()=>{
  const stamp=resolve(process.env.AIDLC_TEST_WORKER_ROOT!,"../..");
  const path=join(stamp,${JSON.stringify(name)});
  if(existsSync(path)) renameSync(path,path+".before");
  mkdirSync(path);
  expect(true).toBe(true);
});
`,
    });
    const result = run(root, ["--isolated-e2e"]);
    expect(result.code, result.output).toBe(1);
    const storagePath = join(result.log!, `e2e-worker-storage.json${name === "e2e-worker-storage.json" ? ".before" : ""}`);
    const storage = json<{root: string}>(storagePath);
    expect(existsSync(storage.root)).toBe(false);
    const report = json<{state: string; finalizationError?: string; files: Array<{state: string}>}>(
      join(result.log!, "e2e-results.json"),
    );
    expect(report.state).toBe("ERROR");
    expect(report.finalizationError).toBeString();
    expect(report.files[0].state).toBe("PASS");
    expect(existsSync(join(result.log!, "e2e-artifacts", "t-finalization", "junit.xml"))).toBe(true);
  });

  for (const isolated of [false, true]) {
    for (const damage of ["truncated", "inconsistent"]) {
      test(`required coverage rejects ${damage} real JUnit (isolated=${isolated})`, () => {
        const root = fixture({ "t-evidence.test.ts": pass });
        const helper = join(root, "tests", "lib", "e2e-process.ts");
        copyFileSync(helper, join(root, "tests", "lib", "e2e-process-original.ts"));
        writeFileSync(helper, `
export * from "./e2e-process-original.ts";
import {startIsolatedProcess as start} from "./e2e-process-original.ts";
import {readFileSync,writeFileSync} from "node:fs";
export async function startIsolatedProcess(...args: Parameters<typeof start>) {
  const process = await start(...args);
  return {...process, exited: process.exited.then((code) => {
    const path = args[0].command.find((arg)=>arg.startsWith("--reporter-outfile="))!.slice("--reporter-outfile=".length);
    const original=readFileSync(path,"utf8");
    if (!original.includes("</testsuites>")) throw new Error("control needs a complete real Bun report");
    writeFileSync(path+".before",original);
    const header=/<testsuites\\b[^>]*>/.exec(original)![0];
    writeFileSync(path,${damage === "truncated" ? "header" : 'original.replace(header,header.replace(\'tests="1"\',\'tests="2"\'))'});
    return code;
  })};
}
`);
        const result = run(root, [...(isolated ? ["--isolated-e2e"] : []), "--require-coverage"]);
        expect(result.code, result.output).toBe(1);
        const coverage = json<{complete: boolean; files: Array<{evidenceError?: string}>}>(
          join(result.log!, "coverage.json"),
        );
        expect(coverage.complete).toBe(false);
        expect(coverage.files[0].evidenceError).toContain("Invalid JUnit evidence");
        expect(readFileSync(join(result.log!, "failures.txt"), "utf8")).toContain("Invalid JUnit evidence");
      });
    }
  }

  test("insufficient storage reports incomplete inventory before any test is launched", () => {
    const root = fixture({ "t-pass.test.ts": pass });
    const result = run(root, ["--isolated-e2e"], {
      AIDLC_E2E_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER),
    });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("insufficient e2e storage");
    expect(result.output).not.toContain("=== START");
    const report = json<{state: string; coverageComplete: boolean; files: Array<{state: string}>}>(
      join(result.log!, "e2e-results.json"),
    );
    expect(report.state).toBe("ERROR");
    expect(report.coverageComplete).toBe(false);
    expect(report.files.map((file) => file.state)).toEqual(["INCOMPLETE"]);
  });

  for (const isolated of [false, true]) {
    test(`source-detected TUI use waits for its prerequisite (isolated=${isolated})`, () => {
      const marker = join(scratch(), "substrate-ready");
      const root = fixture({
        "t-tui-preflight.serial.test.ts": `
import {test,expect} from "bun:test";
import {writeFileSync} from "node:fs";
test("capability",()=>{writeFileSync(${JSON.stringify(marker)},"ready");expect(true).toBe(true);});
`,
        "t-capture.test.ts": `
import {test,expect} from "bun:test";
import {existsSync} from "node:fs";
const driver = "tui-drive.ts";
test("capture follows capability",()=>{expect(driver).toBeString();expect(existsSync(${JSON.stringify(marker)})).toBe(true);});
`,
      });
      const result = run(root, [
        ...(isolated ? ["--isolated-e2e"] : []), "--require-coverage", "--filter", "^t-capture",
      ]);
      expect(result.code, result.output).toBe(0);
      expect(json<{selectedFiles: number}>(join(result.log!, "coverage.json")).selectedFiles).toBe(2);
    });

    for (const explicit of [false, true]) {
      test(`required TUI preflight is counted once (isolated=${isolated}, explicit=${explicit})`, () => {
        const root = fixture({
          "t-tui-preflight.serial.test.ts": pass,
          "t-tui-probe.serial.test.ts": pass,
        });
        const result = run(root, [
          ...(isolated ? ["--isolated-e2e"] : []), "--require-coverage",
          "--filter", explicit ? "^t-tui-" : "^t-tui-probe",
        ]);
        expect(result.code, result.output).toBe(0);
        const coverage = json<{
          complete: boolean; selectedFiles: number; requestedFiles: number;
          files: Array<{file: string; prerequisite: boolean; requested: boolean}>;
        }>(join(result.log!, "coverage.json"));
        expect(coverage.complete).toBe(true);
        expect(coverage.selectedFiles).toBe(2);
        expect(coverage.requestedFiles).toBe(explicit ? 2 : 1);
        const prerequisites = coverage.files.filter((file) => file.file.includes("preflight"));
        expect(prerequisites).toHaveLength(1);
        expect(prerequisites[0].prerequisite).toBe(true);
        expect(prerequisites[0].requested).toBe(explicit);
        expect(result.output.match(/=== START t-tui-preflight\.serial\.test\.ts ===/g)).toHaveLength(1);
        if (isolated) {
          const report = json<{coverageComplete: boolean; selectedFiles: number; requestedFiles: number}>(
            join(result.log!, "e2e-results.json"),
          );
          expect(report.coverageComplete).toBe(coverage.complete);
          expect(report.selectedFiles).toBe(coverage.selectedFiles);
          expect(report.requestedFiles).toBe(coverage.requestedFiles);
        }
      });
    }
    for (const [label, gate] of [
      ["all-skipped", 'import {test} from "bun:test"; test.skip("unavailable substrate",()=>{});'],
      ["partially-skipped", `${pass} import {test as other} from "bun:test"; other.skip("unavailable capability",()=>{});`],
      ["empty", "export {};"],
      ["missing", null],
    ] as const) {
      test(`a ${label} implicit TUI prerequisite cannot admit a journey (isolated=${isolated})`, () => {
        const root = fixture({
          ...(gate === null ? {} : { "t-tui-preflight.serial.test.ts": gate }),
          "t-tui-probe.serial.test.ts": `${pass} console.log("SUBJECT_EXECUTED");`,
        });
        // Capability admission must fail even without --require-coverage.
        const result = run(root, [
          ...(isolated ? ["--isolated-e2e"] : []), "--filter", "^t-tui-probe",
        ]);
        expect(result.code, result.output).not.toBe(0);
        expect(result.output).not.toContain("SUBJECT_EXECUTED");
        const coverage = json<{complete: boolean; selectedFiles: number; files: Array<{file: string}>}>(
          join(result.log!, "coverage.json"),
        );
        expect(coverage.complete).toBe(false);
        expect(coverage.selectedFiles).toBe(2);
        expect(coverage.files.map((file) => file.file).sort()).toEqual([
          "tests/e2e/t-tui-preflight.serial.test.ts", "tests/e2e/t-tui-probe.serial.test.ts",
        ]);
        expect(readFileSync(join(result.log!, "summary.txt"), "utf8")).toContain("Result: FAIL");
        expect(readFileSync(join(result.log!, "failures.txt"), "utf8")).not.toBe("\n");
      });
    }

    test(`required coverage rejects skips and empty selections (isolated=${isolated})`, () => {
    const root = fixture({
      "t01-pass.test.ts": pass,
      "t02-skip.test.ts": 'import {test} from "bun:test"; test.skip("unmet prerequisite",()=>{});',
      "t03-empty.test.ts": "export {};",
    });
    const mode = [...(isolated ? ["--isolated-e2e"] : []), "--require-coverage"];
    const positive = run(root, [...mode, "--filter", "^t01"]);
    expect(positive.code, positive.output).toBe(0);
    expect(json<{complete: boolean}>(join(positive.log!, "coverage.json")).complete).toBe(true);
    for (const filter of ["^t0[12]", "^t03", "^does-not-exist"]) {
      const result = run(root, [...mode, "--filter", filter]);
      expect(result.code, result.output).not.toBe(0);
      const coverage = json<{complete: boolean}>(join(result.log!, "coverage.json"));
      expect(coverage.complete).toBe(false);
      expect(readFileSync(join(result.log!, "summary.txt"), "utf8")).toContain("Result: FAIL");
      expect(readFileSync(join(result.log!, "failures.txt"), "utf8")).toContain("INCOMPLETE:");
    }
    });
  }

  test("cancellation reaps its worker and reports unstarted files as incomplete", async () => {
    const shared = scratch();
    const started = join(shared, "started");
    const cancelled = join(shared, "cancelled");
    const root = fixture({
      "t-hang.serial.test.ts": `
import {test} from "bun:test";
import {writeFileSync} from "node:fs";
test("hang",async()=>{
  writeFileSync(process.env.AIDLC_STARTED!,String(process.pid));
  await new Promise(()=>{});
},${NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS});
`,
      "t-later.test.ts": pass,
    });
    const child = spawn(process.execPath, [
      join(root, "tests", "run-tests.ts"),
      "--debug", "-P", "8", "--e2e", "--no-llm", "--isolated-e2e",
      "--e2e-cancel-file", cancelled,
    ], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AIDLC_TEST_PACKAGE_READY: "1", AIDLC_STARTED: started },
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const closed = new Promise<number | null>((done, reject) => {
      child.on("close", done);
      child.on("error", reject);
    });
    try {
      const deadline = Date.now() + NATIVE_STARTUP_TIMEOUT_MS;
      while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(started), output).toBe(true);
      writeFileSync(cancelled, "cancel");
      expect(await closed, output).not.toBe(0);
      const log = /Verbose mode: logging to (.+)/.exec(output)![1].trim();
      const report = json<{ state: string; coverageComplete: boolean; files: Array<{ state: string }> }>(
        join(log, "e2e-results.json"),
      );
      expect(report.state).toBe("INTERRUPTED");
      expect(report.coverageComplete).toBe(false);
      expect(report.files.map((row) => row.state)).toEqual(["INCOMPLETE", "INCOMPLETE"]);
      const pid = Number(readFileSync(started, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  });

  test("worker copies include uncommitted bytes while retaining independent Git indexes", async () => {
    const root = fixture({ "t01.test.ts": pass });
    writeFileSync(join(root, "uncommitted.txt"), "current working bytes");
    const output = scratch();
    const pool = await prepareE2eWorkers(root, output, 2);
    try {
      expect(pool.sourceDirty).toBe(true);
      for (const worker of pool.workers) {
        expect(readFileSync(join(worker.root, "uncommitted.txt"), "utf8")).toBe("current working bytes");
        expect(git(worker.root, ["ls-files", "tests/e2e/t01.test.ts"]).trim()).toBe("tests/e2e/t01.test.ts");
      }
      git(pool.workers[0].root, ["rm", "--cached", "tests/e2e/t01.test.ts"]);
      expect(git(pool.workers[1].root, ["ls-files", "tests/e2e/t01.test.ts"]).trim()).toBe("tests/e2e/t01.test.ts");
      expect(git(root, ["ls-files", "tests/e2e/t01.test.ts"]).trim()).toBe("tests/e2e/t01.test.ts");
    } finally {
      await pool.dispose(false);
    }
  });
});
