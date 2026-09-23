// Real inner runners, process trees and artifacts; no model calls or shared-source mutations.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getNativeProcessIdentity } from "../harness/tui-process-identity.ts";
import { createE2eTemporaryRoot } from "../lib/e2e-workers.ts";
import { assertRunnerFixtureImports } from "../lib/runner-fixture-imports.ts";
import { readJUnitEvidence } from "../lib/e2e-plan.ts";

const SOURCE = resolve(import.meta.dir, "../..");
const roots: string[] = [];
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function root(): Promise<string> {
  // Keep cloned worker paths short on Windows. afterEach retains inner-runner
  // evidence in the outer stamp before removing these owned OS-temp fixtures.
  const dir = await createE2eTemporaryRoot(process.platform === "win32"
    ? [join(process.env.SystemRoot || "C:\\Windows", "Temp"), tmpdir()]
    : undefined);
  roots.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
}

async function fixture(files: Record<string, string>, preparing = false): Promise<string> {
  const dir = await root();
  cpSync(join(SOURCE, "tests", "lib"), join(dir, "tests", "lib"), { recursive: true });
  for (const path of [
    "tests/run-tests.ts", "tests/run-tests.sh", "tests/gen-coverage-registry.ts",
    "tests/harness/claude-gate.ts", "tests/harness/tui-runtime.ts", "tests/harness/tui-record-file.ts",
    "tests/harness/tui-windows-private-file.ts",
    "tests/harness/runner-profile.ts",
    "tests/harness/test-budget.ts",
  ]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(SOURCE, path), join(dir, path));
  }
  assertRunnerFixtureImports(dir);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "tests", path)), { recursive: true });
    writeFileSync(join(dir, "tests", path), body);
  }
  if (preparing) {
    // The production allocation runs first. This private module wrapper holds
    // its return so cancellation deterministically lands in the await gap.
    cpSync(join(dir, "tests/lib/e2e-workers.ts"), join(dir, "tests/lib/e2e-workers-original.ts"));
    writeFileSync(join(dir, "tests/lib/e2e-workers.ts"), `
export * from "./e2e-workers-original.ts";
import {e2eWorkerEnvironment as allocate} from "./e2e-workers-original.ts";
import {existsSync,writeFileSync} from "node:fs";
export async function e2eWorkerEnvironment(...args: Parameters<typeof allocate>) {
 const env = await allocate(...args);
 writeFileSync(process.env.RUNNER_PREPARING!, JSON.stringify({temp:env.TEMP}));
 const end=Date.now()+15000;
 while(!existsSync(process.env.RUNNER_RELEASE!)) {
   if(Date.now()>end) throw new Error("preparation barrier not released");
   await Bun.sleep(10);
 }
 return env;
}
`);
  }
  writeFileSync(join(dir, ".gitignore"), "tests/logs/\nnode_modules/\n");
  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  return dir;
}

function launch(dir: string, flags: string[], extra: NodeJS.ProcessEnv = {}) {
  const cancel = join(dir, "cancel");
  const child = spawn(process.execPath, [
    join(dir, "tests/run-tests.ts"), "--debug", "-P", "8", "--no-llm", ...flags,
    ...(flags.includes("--isolated-e2e") ? ["--e2e-cancel-file", cancel] : []),
  ], {
    cwd: dir, env: { ...process.env, ...extra, AIDLC_TEST_PACKAGE_READY: "1", BUN_OPTIONS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const closed = new Promise<number | null>((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 40_000);
  void closed.finally(() => {
    clearTimeout(watchdog);
    writeFileSync(join(dir, "inner-run.log"), output);
  });
  return {
    child, closed, cancel, output: () => output,
    log: () => {
      const match = /Verbose mode: logging to (.+)/.exec(output);
      if (!match) throw new Error(`inner runner wrote no stamp\n${output}`);
      return match[1].trim();
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        writeFileSync(cancel, "cancel");
        writeFileSync(join(dir, "release"), "release");
      }
      await closed;
    },
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await pause(20);
  }
}
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));

afterEach(() => {
  for (const dir of roots.splice(0)) {
    if (process.env.AIDLC_TEST_LOG_DIR) {
      const evidence = join(process.env.AIDLC_TEST_LOG_DIR, "runner-regressions", basename(dir));
      mkdirSync(evidence, { recursive: true });
      if (existsSync(join(dir, "inner-run.log"))) cpSync(join(dir, "inner-run.log"), join(evidence, "inner-run.log"));
      if (existsSync(join(dir, "tests/logs"))) cpSync(join(dir, "tests/logs"), join(evidence, "logs"), {
        recursive: true,
        filter: (path) => basename(path) !== "e2e-workers",
      });
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("runner process lifetime and reporting", () => {
  test("a run deadline with 256 unfinished files cannot wrap the exit status to success", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 256; index++) {
      files[`unit/t${String(index).padStart(3, "0")}-unfinished.test.ts`] =
        'import {test} from "bun:test"; test("unfinished",async()=>{await new Promise(()=>{});},30000);';
    }
    const dir = await fixture(files);
    const runner = launch(dir, ["--unit", "--run-timeout", "1"]);
    try {
      expect(await runner.closed, runner.output()).toBe(255);
      const summary = readFileSync(join(runner.log(), "summary.txt"), "utf8");
      expect(summary).toContain("Failed files: 256");
      expect(summary).toContain("Result: FAIL");
    } finally { await runner.stop(); }
  }, 55_000);

  for (const tier of ["unit", "integration"] as const) {
    test.each(["file", "run"] as const)(`${tier} %s deadline retires ordinary file processes and reports unfinished work`, async (mode) => {
      const files: Record<string, string> = {
        [`${tier}/t01-holder.serial.test.ts`]: `
import {test} from "bun:test";
import {spawn} from "node:child_process";
test("ordinary file with a live descendant", async () => {
 const leaf=spawn(process.execPath,["-e",\`
  const fs=require("node:fs");
  process.on("SIGTERM",()=>{});
  // Publish only complete JSON: the parent waits for this path to appear.
  const staged=process.env.RUNNER_LEAF+".tmp";
  fs.writeFileSync(staged,JSON.stringify({pid:process.pid}));
  fs.renameSync(staged,process.env.RUNNER_LEAF);
  console.log("ORDINARY_DESCENDANT_READY");
  setInterval(()=>{},1000);
  setTimeout(()=>process.exit(99),30000);
 \`],{stdio:"inherit"});
 leaf.unref();
 await new Promise(()=>{});
},30000);
`,
      };
      if (mode === "run") files[`${tier}/t02-not-admitted.serial.test.ts`] = `
import {test} from "bun:test";
import {writeFileSync} from "node:fs";
test("must not start after the run budget",()=>writeFileSync(process.env.RUNNER_SENTINEL!,"started"));
`;
      const dir = await fixture(files);
      const leaf = join(dir, "leaf.json");
      const sentinel = join(dir, "sentinel");
      // Intentional backstop calibration: preserve the exact operation limit,
      // independent of the buffered defaults used by ordinary workload cases.
      const seconds = process.platform === "win32" ? 15 : 5;
      const runner = launch(dir, [`--${tier}`, `--${mode}-timeout`, String(seconds)], {
        RUNNER_LEAF: leaf, RUNNER_SENTINEL: sentinel,
      });
      try {
        await until(() => existsSync(leaf), "ordinary file descendant");
        const { pid } = json<{ pid: number }>(leaf);
        const identity = process.platform === "linux" || process.platform === "win32"
          ? await getNativeProcessIdentity(pid) : String(pid);
        expect(identity).not.toBeNull();
        expect(await runner.closed, runner.output()).toBe(mode === "run" ? 2 : 1);
        expect(runner.output()).toContain("ORDINARY_DESCENDANT_READY");
        expect(readFileSync(join(runner.log(), "summary.txt"), "utf8")).toContain("Result: FAIL");
        expect(readFileSync(join(runner.log(), "failures.txt"), "utf8")).toContain("t01-holder");
        if (mode === "run") {
          expect(existsSync(sentinel)).toBe(false);
          expect(readFileSync(join(runner.log(), "failures.txt"), "utf8")).toContain("t02-not-admitted");
        }
        if (process.platform === "linux" || process.platform === "win32") {
          expect(await getNativeProcessIdentity(pid)).not.toBe(identity);
        } else {
          expect(() => process.kill(pid, 0)).toThrow();
        }
      } finally { await runner.stop(); }
    }, 55_000);
  }

  test.each(["success", "timeout", "cancel", "detached"] as const)(
    "%s handles descendants which inherit stdio after the test leader exits",
    async (mode) => {
      const dir = await fixture({
        "e2e/t01-holder.test.ts": `
import {test,expect} from "bun:test";
import {spawn} from "node:child_process";
import {existsSync,writeFileSync} from "node:fs";
test("owned descendant",async()=>{
 const leaf=spawn(process.execPath,["-e",\`
  const fs=require("node:fs");
  process.on("SIGTERM",()=>{});
  // Publish only complete JSON: the parent waits for this path to appear.
  const staged=process.env.RUNNER_LEAF+".tmp";
  fs.writeFileSync(staged,JSON.stringify({pid:process.pid}));
  fs.renameSync(staged,process.env.RUNNER_LEAF);
  console.log("DESCENDANT_STDIO_READY");
  setInterval(()=>{},1000);
  setTimeout(()=>process.exit(99),${mode === "detached" ? 5000 : 30000});
 \`],{stdio:"inherit",detached:${mode === "detached" ? "true" : 'process.platform==="win32"'}});
 leaf.unref();
 const end=Date.now()+20000;
 while(!existsSync(process.env.RUNNER_RELEASE!)) {
  if(Date.now()>end) throw new Error("leader release missing");
  await Bun.sleep(10);
 }
 expect(existsSync(process.env.RUNNER_LEAF!)).toBe(true);
 ${mode === "success" || mode === "detached" ? "" : "await new Promise(()=>{});"}
},30000);
`,
      });
      const leaf = join(dir, "leaf.json");
      const release = join(dir, "release");
      const began = Date.now();
      const runner = launch(dir, ["--e2e", "--isolated-e2e", "--e2e-file-timeout", mode === "timeout" ? "5" : "30"], {
        RUNNER_LEAF: leaf, RUNNER_RELEASE: release,
      });
      try {
        await until(() => existsSync(leaf), "inherited-stdio descendant");
        const { pid } = json<{ pid: number }>(leaf);
        const identity = process.platform === "linux" || process.platform === "win32"
          ? await getNativeProcessIdentity(pid) : String(pid);
        expect(identity).not.toBeNull();
        writeFileSync(release, "release");
        if (mode === "cancel") writeFileSync(runner.cancel, "cancel");
        const escaped = mode === "detached" && process.platform !== "win32";
        expect(await runner.closed, runner.output()).toBe(mode === "success" || (mode === "detached" && !escaped) ? 0 : 1);
        expect(Date.now() - began, runner.output()).toBeLessThan(15_000);
        const report = json<{ state: string; files: Array<{
          state: string; cleanupError?: string; temporaryDirectory: string; retainedFixtures?: string;
        }> }>(
          join(runner.log(), "e2e-results.json"),
        );
        expect(report.state).toBe({ success: "COMPLETE", timeout: "FAIL", cancel: "INTERRUPTED", detached: escaped ? "ERROR" : "COMPLETE" }[mode]);
        expect(report.files[0].state).toBe({ success: "PASS", timeout: "TIMED_OUT", cancel: "INCOMPLETE", detached: escaped ? "FAIL" : "PASS" }[mode]);
        if (escaped) {
          expect(report.files[0].cleanupError).toContain("output did not close");
          expect(existsSync(report.files[0].temporaryDirectory)).toBe(true);
          expect(report.files[0].retainedFixtures).toBeUndefined();
        } else {
          expect(report.files[0].cleanupError).toBeUndefined();
        }
        expect(runner.output()).toContain("DESCENDANT_STDIO_READY");
        if (process.platform === "linux" || process.platform === "win32") {
          // A deliberately escaped POSIX child is never killed by PID guessing.
          // It has a short self-deadline; the runner must already have failed
          // boundedly while retaining its temporary directory.
          if (escaped) {
            const end = Date.now() + 8000;
            while (await getNativeProcessIdentity(pid) === identity && Date.now() < end) await pause(20);
          }
          expect(await getNativeProcessIdentity(pid)).not.toBe(identity);
        } else {
          if (escaped) await until(() => {
            try { process.kill(pid, 0); return false; } catch { return true; }
          }, "self-bounded escaped descendant");
          expect(() => process.kill(pid, 0)).toThrow();
        }
        if (escaped) rmSync(report.files[0].temporaryDirectory, { recursive: true, force: true });
      } finally { await runner.stop(); }
    }, 55_000,
  );

  test("cancellation while allocation is pending never starts the prepared file", async () => {
    const dir = await fixture({
      "e2e/t01-must-not-run.test.ts": 'import {test} from "bun:test"; import {writeFileSync} from "node:fs"; test("must not launch",()=>writeFileSync(process.env.RUNNER_SENTINEL!,"launched"));',
    }, true);
    const preparing = join(dir, "preparing.json");
    const release = join(dir, "release");
    const sentinel = join(dir, "launched");
    const runner = launch(dir, ["--e2e", "--isolated-e2e"], {
      RUNNER_PREPARING: preparing, RUNNER_RELEASE: release, RUNNER_SENTINEL: sentinel,
    });
    try {
      await until(() => existsSync(preparing), "allocated environment");
      writeFileSync(runner.cancel, "cancel");
      await until(() => json<{ state: string }>(join(runner.log(), "e2e-results.json")).state === "INTERRUPTED", "observed cancellation");
      writeFileSync(release, "release");
      expect(await runner.closed, runner.output()).toBe(1);
      expect(existsSync(sentinel)).toBe(false);
      expect(runner.output()).not.toContain("=== START t01-must-not-run.test.ts ===");
      const report = json<{ state: string; files: Array<{ state: string; retainedFixtures?: string }> }>(
        join(runner.log(), "e2e-results.json"),
      );
      expect(report.state).toBe("INTERRUPTED");
      expect(report.files[0].state).toBe("INCOMPLETE");
      expect(existsSync(report.files[0].retainedFixtures!)).toBe(true);
      expect(existsSync(json<{ temp: string }>(preparing).temp)).toBe(false);
    } finally { await runner.stop(); }
  }, 55_000);

  test("a queued file executes its frozen supervisor after the coordinator helper changes", async () => {
    const dir = await fixture({
      "e2e/t01-frozen-supervisor.test.ts": 'import {test,expect} from "bun:test"; import {writeFileSync} from "node:fs"; test("frozen supervisor runs",()=>{writeFileSync(process.env.RUNNER_SENTINEL!,"frozen");expect(true).toBe(true);});',
    }, true);
    const helper = join(dir, "tests", "lib", "e2e-process.ts");
    const original = readFileSync(helper, "utf8");
    const preparing = join(dir, "preparing.json");
    const release = join(dir, "release");
    const sentinel = join(dir, "launched");
    const runner = launch(dir, ["--e2e", "--isolated-e2e"], {
      RUNNER_PREPARING: preparing, RUNNER_RELEASE: release, RUNNER_SENTINEL: sentinel,
    });
    try {
      await until(() => existsSync(preparing), "snapshot and environment preparation");
      const storage = json<{ root: string }>(join(runner.log(), "e2e-worker-storage.json"));
      const frozen = join(storage.root, "worker-1", "tests", "lib", "e2e-process.ts");
      expect(readFileSync(frozen, "utf8")).toBe(original);
      const changed = 'throw new Error("COORDINATOR_HELPER_CHANGED_AFTER_SNAPSHOT");\n';
      writeFileSync(helper, changed);
      expect(readFileSync(helper, "utf8")).toBe(changed);
      expect(readFileSync(frozen, "utf8")).toBe(original);
      writeFileSync(release, "release");
      expect(await runner.closed, runner.output()).toBe(0);
      expect(readFileSync(sentinel, "utf8")).toBe("frozen");
      expect(runner.output()).not.toContain("COORDINATOR_HELPER_CHANGED_AFTER_SNAPSHOT");
      const report = json<{ state: string; coverageComplete: boolean; files: Array<{ state: string }> }>(
        join(runner.log(), "e2e-results.json"),
      );
      expect(report.state).toBe("COMPLETE");
      expect(report.coverageComplete).toBe(true);
      expect(report.files[0].state).toBe("PASS");
    } finally {
      await runner.stop();
      writeFileSync(helper, original);
    }
  }, 55_000);

  test("cross-tier names preserve both diagnostics and use the exact preflight result", async () => {
    const dir = await fixture({
      "unit/t19.test.ts": 'import {test,expect} from "bun:test"; test("unit diagnostic retained",()=>expect("UNIT_ONLY","UNIT_ONLY").toBe("different"));',
      "integration/t19.test.ts": 'import {test,expect} from "bun:test"; test("integration preflight succeeds",()=>expect(true).toBe(true));',
      "integration/t20.test.ts": 'import {test,expect} from "bun:test"; test("later integration runs",()=>expect(true).toBe(true));',
    });
    const runner = launch(dir, ["--unit", "--integration"]);
    try {
      expect(await runner.closed, runner.output()).toBe(1);
      expect(runner.output()).not.toContain("PREFLIGHT FAILURE");
      expect(runner.output()).toContain("=== DONE t20.test.ts (PASS)");
      for (const [name, tier] of [["unit-t19", "unit"], ["integration-t19", "integration"]] as const) {
        const execution = json<{ file: string }>(join(runner.log(), `${name}.execution.json`));
        expect(execution.file).toBe(join(dir, "tests", tier, "t19.test.ts"));
        expect(existsSync(join(runner.log(), `${name}.junit.xml`))).toBe(true);
      }
      expect(readFileSync(join(runner.log(), "unit-t19.log"), "utf8")).toContain("UNIT_ONLY");
      const preflight = readJUnitEvidence(readFileSync(join(runner.log(), "integration-t19.junit.xml"), "utf8"));
      expect(preflight.complete).toBe(true);
      if (!preflight.complete) throw new Error(preflight.error);
      expect(preflight.testcases).toMatchObject([{ name: "integration preflight succeeds", outcome: "PASS" }]);
      expect(readFileSync(join(runner.log(), "failures.txt"), "utf8")).toContain("UNIT_ONLY");
      expect(readFileSync(join(runner.log(), "summary.txt"), "utf8")).toContain("Test files: 3");
      expect(existsSync(join(runner.log(), "t20.log"))).toBe(true);
    } finally { await runner.stop(); }
    const single = launch(dir, ["--unit"]);
    try {
      expect(await single.closed, single.output()).toBe(1);
      expect(existsSync(join(single.log(), "t19.log"))).toBe(true);
      expect(existsSync(join(single.log(), "unit-t19.log"))).toBe(false);
    } finally { await single.stop(); }
  }, 55_000);

  test.each(["bedrock-only", "mixed"])("common resource caps bound checkout allocation: %s", async (kind) => {
    const mixed = kind === "mixed";
    const second = mixed ? "t02-independent.test.ts" : "t-exec-codex-b.serial.test.ts";
    const body = `
import {test,expect} from "bun:test";
import {existsSync,readdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
test("allocation and admission",async()=>{
 const count=readdirSync(dirname(process.cwd())).filter(name=>/^worker-[0-9]+$/.test(name)).length;
 expect(count).toBe(${mixed ? 2 : 1});
 writeFileSync(join(process.env.RUNNER_BARRIER!,process.env.AIDLC_TEST_NAME!),"started");
 if (${mixed}) {
  const end=Date.now()+5000;
  while(readdirSync(process.env.RUNNER_BARRIER!).length<2 && Date.now()<end) await Bun.sleep(10);
  expect(readdirSync(process.env.RUNNER_BARRIER!)).toHaveLength(2);
 }
},10000);
`;
    const dir = await fixture({
      "e2e/t-exec-codex-a.serial.test.ts": body,
      [`e2e/${second}`]: body,
      "e2e/t-tui-preflight.serial.test.ts": 'import {test,expect} from "bun:test";test("serial prerequisite",()=>expect(true).toBe(true));',
    });
    const barrier = join(dir, "barrier");
    mkdirSync(barrier);
    const runner = launch(dir, ["--e2e", "--isolated-e2e", "--bedrock-parallel", "1"], { RUNNER_BARRIER: barrier });
    try {
      expect(await runner.closed, runner.output()).toBe(0);
      const report = json<{ limits: { workers: number }; coverageComplete: boolean }>(join(runner.log(), "e2e-results.json"));
      expect(report.limits.workers).toBe(mixed ? 2 : 1);
      expect(report.coverageComplete).toBe(true);
    } finally { await runner.stop(); }
  }, 55_000);

  test("qualified E2E timing rows win over unit collisions and retain legacy timing support", async () => {
    const dir = await fixture({
      "e2e/t05.test.ts": 'import {test,expect} from "bun:test";test("five",()=>expect(true).toBe(true));',
      "e2e/t06.test.ts": 'import {test,expect} from "bun:test";test("six",()=>expect(true).toBe(true));',
    });
    const history = join(dir, "history.txt");
    writeFileSync(history, [
      "e2e-t05 PASS 1 0 3s",
      "unit-t05 PASS 1 0 999s",
      "t05 PASS 1 0 555s",
      "t06 PASS 1 0 7s",
      "integration-t06 PASS 1 0 888s",
    ].join("\n"));
    const runner = launch(dir, ["--e2e", "--e2e-plan", "--e2e-timings", history]);
    try {
      expect(await runner.closed, runner.output()).toBe(0);
      const plan = JSON.parse(runner.output()) as { files: Array<{ file: string; estimatedSeconds: number }> };
      expect(plan.files.map(({ file, estimatedSeconds }) => [file, estimatedSeconds])).toEqual([
        ["tests/e2e/t05.test.ts", 3], ["tests/e2e/t06.test.ts", 7],
      ]);
    } finally { await runner.stop(); }
  }, 55_000);
});
