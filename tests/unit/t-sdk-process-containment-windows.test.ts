// covers: harness-instrument:sdk-process-containment
//
// Proves the Windows Job Object containment that driveAidlc wraps around the
// SDK's Claude CLI (tests/harness/sdk-process-containment.ts). No model or
// credentials: a fake CLI (tests/fixtures/windows-sdk-fake-cli.ts) starts a
// detached grandchild the way a mid-flight Bash tool would, then the test
// reproduces the SDK's abort (stdin EOF + kill("SIGKILL") on the CLI alone)
// and shows the grandchild only dies because terminate() ends the job. A
// no-containment control shows the orphan the fix targets, and an owner
// fixture that exits without terminate() shows the kill-on-close safety net.
// Windows-only by mechanism; the factory contract is checked everywhere.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface FakeCliHello { pid: number; grandchild: number }

function firstJsonLine(child: ChildProcess): Promise<FakeCliHello> {
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

const orphans: number[] = [];
const containments: SdkProcessContainment[] = [];
afterEach(async () => {
  for (const containment of containments.splice(0)) {
    try { await containment.terminate({ graceMs: 0 }); } catch { /* reported by the test */ }
  }
  await reapOrphans();
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
    expect(report).toMatchObject({ cliExited: true, membersBeforeTerminate: [], terminated: false, survivors: [] });
    expect(describeSdkContainment(report)).toContain("job verified empty");
    // Idempotent: the same report, no second native teardown.
    expect(await containment!.terminate()).toBe(report);
  });
});

describe.skipIf(process.platform !== "win32")("SDK process containment (Windows Job Object)", () => {
  test("the SDK's own abort orphans a detached grandchild (control without containment)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aidlc-sdk-containment-control-"));
    try {
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
    } finally {
      await reapOrphans();
      await removeFixtureDir(cwd);
    }
  });

  test("terminate() ends the grandchild the SDK's kill left behind and verifies the job is empty", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "aidlc-sdk-containment-"));
    try {
      const containment = (await createSdkProcessContainment())!;
      containments.push(containment);
      const child = containment.spawn({
        command: process.execPath,
        args: [FAKE_CLI],
        cwd,
        env: { ...process.env },
        signal: new AbortController().signal,
      }) as ChildProcess;
      const hello = await firstJsonLine(child);
      orphans.push(hello.grandchild);
      expect(hello.pid).toBe(child.pid!);
      // Both generations are job members: the detached grandchild inherited membership.
      const members = containment.memberPids();
      expect(members).toContain(child.pid!);
      expect(members).toContain(hello.grandchild);

      // Reproduce the SDK abort exactly; the CLI dies, the grandchild does not.
      child.stdin!.end();
      child.kill("SIGKILL");
      await exited(child);
      expect(await gone(child.pid!, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS)).toBe(true);
      expect(alive(hello.grandchild)).toBe(true);
      expect(containment.memberPids()).toEqual([hello.grandchild]);

      const report = await containment.terminate({ graceMs: 0 });
      expect(report).toMatchObject({
        cliPid: child.pid,
        cliExited: true,
        membersBeforeTerminate: [hello.grandchild],
        terminated: true,
        survivors: [],
      });
      expect(await gone(hello.grandchild, NATIVE_PROCESS_TERMINATE_TIMEOUT_MS)).toBe(true);
      expect(containment.memberPids()).toEqual([]);
      expect(describeSdkContainment(report)).toContain(`members=[${hello.grandchild}] terminated=true job verified empty`);
      expect(() => containment.spawn({
        command: process.execPath, args: ["--version"], env: {}, signal: new AbortController().signal,
      })).toThrow("already terminated");
      // The folder the grandchild held as its cwd is removable right away.
      rmSync(cwd, { recursive: true, force: true });
    } finally {
      await removeFixtureDir(cwd);
    }
  });

  test("terminate() with grace lets a CLI that exits by itself finish, then still sweeps the tree", async () => {
    const containment = (await createSdkProcessContainment())!;
    containments.push(containment);
    const child = containment.spawn({
      command: process.execPath,
      args: [FAKE_CLI],
      env: { ...process.env },
      signal: new AbortController().signal,
    }) as ChildProcess;
    const hello = await firstJsonLine(child);
    orphans.push(hello.grandchild);
    // A natural completion: the CLI exits on its own while the grandchild lingers.
    child.kill("SIGKILL");
    await exited(child);
    const report = await containment.terminate({ graceMs: 2_000 });
    expect(report.cliExited).toBe(true);
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
