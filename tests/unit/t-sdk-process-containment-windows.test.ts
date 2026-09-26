// covers: harness-instrument:sdk-process-containment
//
// Proves the Windows Job Object containment that driveAidlc wraps around the
// SDK's Claude CLI (tests/harness/sdk-process-containment.ts). No model or
// credentials: a fake CLI (tests/fixtures/windows-sdk-fake-cli.ts) starts a
// detached grandchild as its very first act, before it touches stdin, the way
// a helper started at CLI startup would. The tests prove that the grandchild
// is a job member even when the containment is slow to assign (the CLI is
// started by an already-contained bootstrap, so nothing can escape), that the
// SDK's own kill() on the SpawnedProcess ends the whole tree, that terminate()
// sweeps what a self-exiting CLI leaves behind, and that kill-on-close ends
// the tree when the owning process dies. A no-containment control shows the
// orphan and the EBUSY the fix targets. The bootstrap's own contract (start
// only when released, inherit stdio, forward the exit code, fail closed) is
// platform-neutral and checked everywhere.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  createSdkProcessContainment,
  describeSdkContainment,
  type SdkProcessContainment,
} from "../harness/sdk-process-containment.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_PROCESS_TERMINATE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const FAKE_CLI = join(import.meta.dir, "..", "fixtures", "windows-sdk-fake-cli.ts");
const OWNER = join(import.meta.dir, "..", "fixtures", "windows-sdk-containment-owner.ts");
const BOOTSTRAP = join(import.meta.dir, "..", "harness", "sdk-contained-bootstrap.ts");

interface FakeCliHello { pid: number; grandchild: number }

/** Satisfied by a ChildProcess and by the SDK-facing wrapper the containment returns. */
type StdoutSource = {
  stdout: Readable | null;
  once(event: "error", listener: (error: Error) => void): unknown;
};

function firstJsonLine(child: StdoutSource): Promise<FakeCliHello> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () => reject(new Error(`fake CLI did not report its PIDs; saw ${JSON.stringify(buffered)}`)),
      remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const line = buffered.indexOf("\n");
      if (line < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffered.slice(0, line)) as FakeCliHello);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("exit", () => resolve());
  });
}

/** Arm before the kill: the SDK's SpawnedProcess exposes exit only as an event. */
function exitOf(target: { once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown }): Promise<void> {
  return new Promise((resolve) => target.once("exit", () => resolve()));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Process objects linger briefly after termination; wait for a real absence. */
async function gone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function forceKill(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** Kill every recorded orphan and wait until each has really exited. */
async function reapOrphans(): Promise<void> {
  for (const pid of orphans.splice(0)) {
    forceKill(pid);
    await gone(pid, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS);
  }
}

/** A just-killed holder releases its cwd asynchronously; retry within a bound. */
async function removeFixtureDir(dir: string): Promise<void> {
  const deadline = Date.now() + NATIVE_PROCESS_TERMINATE_TIMEOUT_MS;
  for (;;) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function spawnBootstrap(readyFile: string, parentPid: number, command: string[]): ChildProcess {
  return spawn(process.execPath, [BOOTSTRAP, readyFile, String(parentPid), ...command], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
}

function collect(child: ChildProcess): { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
  return { stdout: () => out, stderr: () => err };
}

const orphans: number[] = [];
const containments: SdkProcessContainment[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const containment of containments.splice(0)) {
    try { await containment.terminate({ graceMs: 0 }); } catch { /* reported by the test */ }
  }
  await reapOrphans();
  for (const dir of scratch.splice(0)) await removeFixtureDir(dir);
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

describe("SDK contained bootstrap contract", () => {
  test("starts the command only once released, with inherited stdio and the command's exit code", async () => {
    const dir = scratchDir("aidlc-sdk-bootstrap-");
    const readyFile = join(dir, "ready");
    const child = spawnBootstrap(readyFile, process.pid, [
      process.execPath, "-e", "process.stdout.write('released\\n'); process.exit(7)",
    ]);
    orphans.push(child.pid!);
    const output = collect(child);
    // Not released: nothing runs, nothing reaches stdout, the bootstrap waits.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(child.exitCode).toBeNull();
    expect(output.stdout()).toBe("");
    writeFileSync(readyFile, "ready\n");
    await exited(child);
    expect(output.stdout()).toBe("released\n");
    expect(child.exitCode).toBe(7);
    expect(output.stderr()).toBe("");
  });

  test("never starts the command when its parent is gone before the release", async () => {
    const dir = scratchDir("aidlc-sdk-bootstrap-");
    const marker = join(dir, "started");
    // A parent that has already exited: its PID is gone by the time the poll runs.
    const goneParent = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await exited(goneParent);
    const child = spawnBootstrap(join(dir, "never-written"), goneParent.pid!, [
      process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`,
    ]);
    orphans.push(child.pid!);
    const output = collect(child);
    await exited(child);
    expect(child.exitCode).toBe(3);
    expect(output.stderr()).toContain("parent exited before releasing the bootstrap");
    expect(existsSync(marker)).toBe(false);
  });

  test("fails closed with a distinct code when the released command cannot start", async () => {
    const dir = scratchDir("aidlc-sdk-bootstrap-");
    const readyFile = join(dir, "ready");
    writeFileSync(readyFile, "ready\n");
    const child = spawnBootstrap(readyFile, process.pid, [join(dir, "missing-cli.exe"), "--version"]);
    orphans.push(child.pid!);
    const output = collect(child);
    await exited(child);
    expect(child.exitCode).toBe(127);
    expect(output.stderr()).toContain("cannot start");
    expect(output.stdout()).toBe("");
  });

  test("rejects a malformed invocation before doing anything", () => {
    const result = spawnSync(process.execPath, [BOOTSTRAP, "only-one-argument"], {
      encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
  });
});

describe("SDK process containment factory", () => {
  test("is a Windows-only seam: no override off Windows, a job on Windows", async () => {
    const containment = await createSdkProcessContainment();
    if (process.platform !== "win32") {
      expect(containment).toBeUndefined();
      return;
    }
    expect(containment).toBeDefined();
    containments.push(containment!);
    expect(containment!.memberPids()).toEqual([]);
    const report = await containment!.terminate();
    expect(report).toMatchObject({
      bootstrapExited: true, sdkKillEndedTree: false, membersBeforeTerminate: [], terminated: false, survivors: [],
    });
    expect(describeSdkContainment(report)).toContain("job verified empty");
    // Idempotent: the same report, no second native teardown.
    expect(await containment!.terminate()).toBe(report);
  });
});

describe.skipIf(process.platform !== "win32")("SDK process containment (Windows Job Object)", () => {
  test("the SDK's own abort orphans a detached grandchild (control without containment)", async () => {
    const cwd = scratchDir("aidlc-sdk-containment-control-");
    const child = spawn(process.execPath, [FAKE_CLI], {
      cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    const hello = await firstJsonLine(child);
    orphans.push(hello.grandchild);
    expect(hello.pid).toBe(child.pid!);
    expect(alive(hello.grandchild)).toBe(true);
    // ProcessTransport.close on win32: stdin EOF, then kill("SIGKILL") on the CLI.
    child.stdin!.end();
    child.kill("SIGKILL");
    await exited(child);
    expect(await gone(child.pid!, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS)).toBe(true);
    // The grandchild is exactly the holder the live run could not identify:
    // it inherited the fixture cwd, so removing the folder now fails EBUSY.
    expect(alive(hello.grandchild)).toBe(true);
    expect(() => rmSync(cwd, { recursive: true, force: true })).toThrow(/EBUSY|ENOTEMPTY|EPERM/);
  });

  test("a descendant created at CLI startup is contained even when assignment is slow, and the SDK's kill ends the tree", async () => {
    const cwd = scratchDir("aidlc-sdk-containment-");
    // Widen the spawn-to-assign window far beyond a CLI's startup. A CLI
    // started directly would have created its grandchild outside the job by
    // now; the bootstrap has not started it at all.
    const containment = (await createSdkProcessContainment({
      beforeAssign: () => Bun.sleepSync(750),
    }))!;
    containments.push(containment);
    const spawned = containment.spawn({
      command: process.execPath,
      args: [FAKE_CLI],
      cwd,
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    const bootstrapPid = spawned.pid!;
    const hello = await firstJsonLine(spawned);
    orphans.push(hello.pid, hello.grandchild);
    // The SDK holds the bootstrap; the CLI is its child with its own PID.
    expect(hello.pid).not.toBe(bootstrapPid);
    const members = containment.memberPids();
    expect(members).toContain(bootstrapPid);
    expect(members).toContain(hello.pid);
    expect(members).toContain(hello.grandchild);

    // ProcessTransport.close on win32 as the SDK performs it against the
    // SpawnedProcess it was handed: stdin EOF, then kill("SIGKILL").
    const bootstrapExit = exitOf(spawned);
    spawned.stdin.end();
    expect(spawned.kill("SIGKILL")).toBe(true);
    await bootstrapExit;
    for (const pid of [bootstrapPid, hello.pid, hello.grandchild]) {
      expect(await gone(pid, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS), `pid ${pid}`).toBe(true);
    }
    expect(containment.memberPids()).toEqual([]);
    const report = await containment.terminate({ graceMs: 0 });
    expect(report).toMatchObject({
      bootstrapPid, bootstrapExited: true, sdkKillEndedTree: true,
      membersBeforeTerminate: [], terminated: false, survivors: [],
    });
    expect(describeSdkContainment(report)).toContain("sdkKillEndedTree=true");
    // The folder the grandchild held as its cwd is removable right away.
    rmSync(cwd, { recursive: true, force: true });
  });

  test("terminate() sweeps the descendant a self-exiting CLI leaves behind and verifies the job is empty", async () => {
    const cwd = scratchDir("aidlc-sdk-containment-");
    const containment = (await createSdkProcessContainment())!;
    containments.push(containment);
    const spawned = containment.spawn({
      command: process.execPath,
      args: [FAKE_CLI],
      cwd,
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    const bootstrapPid = spawned.pid!;
    const hello = await firstJsonLine(spawned);
    orphans.push(hello.grandchild);
    // The CLI dies on its own (crash or exit); the bootstrap follows, the
    // detached grandchild does not.
    const bootstrapExit = exitOf(spawned);
    forceKill(hello.pid);
    await bootstrapExit;
    expect(await gone(hello.pid, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS)).toBe(true);
    expect(await gone(bootstrapPid, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS)).toBe(true);
    expect(alive(hello.grandchild)).toBe(true);
    expect(containment.memberPids()).toEqual([hello.grandchild]);

    const report = await containment.terminate({ graceMs: 0 });
    expect(report).toMatchObject({
      bootstrapPid, bootstrapExited: true, sdkKillEndedTree: false,
      membersBeforeTerminate: [hello.grandchild], terminated: true, survivors: [],
    });
    expect(await gone(hello.grandchild, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS)).toBe(true);
    expect(containment.memberPids()).toEqual([]);
    expect(describeSdkContainment(report)).toContain(`members=[${hello.grandchild}] terminated=true job verified empty`);
    expect(() => containment.spawn({
      command: process.execPath, args: ["--version"], env: {}, signal: new AbortController().signal,
    })).toThrow("already terminated");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("terminate() with grace lets a CLI that exits by itself finish, then still sweeps the tree", async () => {
    const containment = (await createSdkProcessContainment())!;
    containments.push(containment);
    const spawned = containment.spawn({
      command: process.execPath,
      args: [FAKE_CLI],
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    const hello = await firstJsonLine(spawned);
    orphans.push(hello.grandchild);
    // A natural completion: the CLI exits on its own while the grandchild lingers.
    const bootstrapExit = exitOf(spawned);
    forceKill(hello.pid);
    await bootstrapExit;
    const report = await containment.terminate({ graceMs: 2_000 });
    expect(report.bootstrapExited).toBe(true);
    expect(report.membersBeforeTerminate).toEqual([hello.grandchild]);
    expect(report.terminated).toBe(true);
    expect(report.survivors).toEqual([]);
    expect(await gone(hello.grandchild, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS)).toBe(true);
  });

  test("kill-on-close ends the tree when the owning process exits without terminate()", async () => {
    const owner = spawn(process.execPath, [OWNER], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stderr = "";
    owner.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const hello = await firstJsonLine(owner);
    orphans.push(hello.pid, hello.grandchild);
    await exited(owner);
    expect(owner.exitCode, stderr).toBe(0);
    // The owner never called terminate(); closing its last job handle did the work.
    expect(await gone(hello.pid, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS)).toBe(true);
    expect(await gone(hello.grandchild, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS)).toBe(true);
  });
});
