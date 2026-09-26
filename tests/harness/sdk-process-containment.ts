// sdk-process-containment.ts: Windows Job Object containment for the Claude
// CLI that driveAidlc() spawns through the Agent SDK.
//
// Why this exists. Agent SDK 0.3.158 aborts a query on Windows by ending the
// CLI's stdin and, about 7 s later, calling kill("SIGKILL") on the CLI process
// alone (ProcessTransport.close: 2 s grace, then a 5 s timer). The conductor
// keeps running tools during those seconds, and Windows does not end a
// process's children with it, so a Bash tool started just before the kill
// survives the drive and can hold the fixture folder (EBUSY) for the whole
// cleanup budget (live run 36061390100, t-tui-custom-harness [sdk]).
//
// The fix mirrors tui-bun-process.ts: the drive owns a kill-on-close Job
// Object, so every descendant is bound to the drive. terminate() ends the
// whole tree after each drive (success, failure, abort and timeout all reach
// the finally in driveAidlc), and the OS ends it when the last job handle
// closes, which is what happens if this process dies first. Neither BREAKAWAY
// flag is set (windowsJobLimits), so a detached grandchild cannot leave the job.
//
// How the CLI enters the job. Windows adds a process to a job only when it is
// assigned and never adds children it created earlier, so assigning the CLI
// after spawn would race whatever the CLI starts first (git, ripgrep, MCP
// helpers). The SDK is therefore handed a bootstrap (sdk-contained-bootstrap.ts)
// instead of the CLI: the bootstrap does nothing until this module has made it
// a verified job member and released it through a ready file, then starts the
// real CLI with inherited stdio. The CLI and everything under it are created
// inside the job. Because the SDK's own kill() lands on the bootstrap, the
// SpawnedProcess returned here terminates the job in kill() as well, so the
// CLI cannot keep the SDK's stdout pipe open after the SDK gave up on it.
//
// Off Windows the factory returns undefined and driveAidlc keeps the SDK's
// default spawn; this module never loads native code at import time.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import {
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  NATIVE_PROCESS_QUERY_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
} from "./test-budget.ts";
import { windowsJobLimits } from "./tui-bun-process.ts";
import { getWindowsProcessDetailsWithBun } from "./tui-process-identity.ts";

/** The SDK's own force-kill fires 5 s after its 2 s stdin-EOF grace. A drive
 * that completed naturally gives the CLI the same 5 s to exit by itself before
 * the tree is ended, so transcript flushes are not cut short. */
export const SDK_NATURAL_EXIT_GRACE_MS = 5_000;

const POLL_MS = 25;
const BOOTSTRAP = fileURLToPath(new URL("./sdk-contained-bootstrap.ts", import.meta.url));

export interface SdkContainmentSurvivor {
  pid: number;
  parentPid?: number;
  commandLine?: string;
}

export interface SdkContainmentReport {
  /** PID of the bootstrap the SDK was handed, if the spawn produced one. The
   * CLI is its child and has its own PID. */
  bootstrapPid?: number;
  /** True when the bootstrap had already exited when terminate() started. */
  bootstrapExited: boolean;
  /** True when the SDK's kill() on the SpawnedProcess ended the job itself. */
  sdkKillEndedTree: boolean;
  /** Job members observed after the optional grace wait, before termination. */
  membersBeforeTerminate: number[];
  /** True when terminate() itself had to call TerminateJobObject. */
  terminated: boolean;
  /** Members still listed by the job when the cleanup budget ran out. */
  survivors: SdkContainmentSurvivor[];
  /** Set when naming the survivors failed; the PIDs above are still exact. */
  survivorDetailError?: string;
  waitedMs: number;
}

/** What the SDK receives: its SpawnedProcess contract plus the bootstrap PID
 * for diagnostics and tests. The CLI itself is the bootstrap's child. */
export type ContainedSpawnedProcess = SpawnedProcess & { readonly pid: number | undefined };

export interface SdkProcessContainment {
  /** Drop-in for Options.spawnClaudeCodeProcess. */
  spawn(options: SpawnOptions): ContainedSpawnedProcess;
  /** PIDs currently assigned to the job (exited processes are not listed). */
  memberPids(): number[];
  /**
   * End every job member, wait for the job to empty within the cleanup
   * budget, then close the job. Idempotent: later calls return the first
   * report. Survivors are reported, never silently dropped.
   */
  terminate(options?: { graceMs?: number }): Promise<SdkContainmentReport>;
}

export interface SdkContainmentOptions {
  /**
   * Test seam: runs after the bootstrap is spawned and before it is assigned to
   * the job. Tests widen that window to prove the CLI cannot start inside it.
   */
  beforeAssign?: () => void;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Render a report for traces and cleanup diagnostics. Fixed shape, no env. */
export function describeSdkContainment(report: SdkContainmentReport): string {
  const survivors = report.survivors.length === 0
    ? "job verified empty"
    : `survivors: ${report.survivors.map((s) =>
      `${s.pid}${s.commandLine === undefined ? "" : ` (${s.commandLine})`}`).join(", ")}`;
  return `SDK drive bootstrap=${report.bootstrapPid ?? "none"} exited=${report.bootstrapExited} ` +
    `sdkKillEndedTree=${report.sdkKillEndedTree} members=[${report.membersBeforeTerminate.join(", ")}] ` +
    `terminated=${report.terminated} ${survivors} waited=${report.waitedMs}ms`;
}

/**
 * Create a Job Object for one SDK drive. Returns undefined off Windows so the
 * caller keeps the SDK's default spawn there; on Windows it requires Bun
 * (bun:ffi), which is the only runtime this harness's tests execute under.
 */
export async function createSdkProcessContainment(
  options: SdkContainmentOptions = {},
): Promise<SdkProcessContainment | undefined> {
  if (process.platform !== "win32") return undefined;
  if (!["x64", "arm64"].includes(process.arch)) {
    throw new Error("SDK process containment requires a 64-bit Bun ABI on Windows");
  }
  if (!process.versions.bun) throw new Error("SDK process containment requires Bun on Windows");
  const { dlopen } = await import("bun:ffi");
  // Win64: BOOL/DWORD are 32-bit, HANDLE is pointer-sized; never map a Windows
  // BOOL to an FFI bool. The job handle is created non-inheritable.
  const library = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
    IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    TerminateJobObject: { args: ["ptr", "u32"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    SetHandleInformation: { args: ["ptr", "u32", "u32"], returns: "i32" },
    GetHandleInformation: { args: ["ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
  const api = library.symbols;
  const failure = (call: string, code = api.GetLastError()): Error =>
    new Error(`${call} failed: Windows error ${code}`);
  const check = (result: number, call: string): void => {
    if (!result) throw failure(call);
  };

  const job = api.CreateJobObjectW(null, null); // Unnamed + NULL SECURITY_ATTRIBUTES: non-inheritable.
  if (!job) throw failure("CreateJobObjectW");
  check(api.SetHandleInformation(job, 1, 0), "SetHandleInformation(job, no inherit)");
  const handleFlags = new Uint32Array(1);
  check(api.GetHandleInformation(job, handleFlags), "GetHandleInformation(job)");
  if (handleFlags[0] & 1) throw new Error("SDK Job Object handle is inheritable");
  const limits = windowsJobLimits();
  check(api.SetInformationJobObject(job, 9, limits, limits.byteLength), "SetInformationJobObject(ExtendedLimit)");
  const observed = new Uint8Array(144);
  check(api.QueryInformationJobObject(job, 9, observed, observed.byteLength, null), "QueryInformationJobObject(ExtendedLimit)");
  if (new DataView(observed.buffer).getUint32(16, true) !== 0x2000) {
    throw new Error("SDK Job Object kill-on-close verification failed");
  }

  let bootstrap: ChildProcess | undefined;
  let readyDir: string | undefined;
  let closed = false;
  let sdkKillEndedTree = false;
  let report: SdkContainmentReport | undefined;

  const memberPids = (): number[] => {
    if (closed) return [];
    let capacity = 64;
    let list: Uint8Array;
    while (true) {
      list = new Uint8Array(8 + capacity * 8); // DWORD counts + ULONG_PTR[capacity]
      if (api.QueryInformationJobObject(job, 3, list, list.byteLength, null)) break;
      const code = api.GetLastError();
      if (code !== 234 || capacity >= 65_536) throw failure("QueryInformationJobObject(ProcessIdList)", code);
      capacity *= 2; // ERROR_MORE_DATA, not an empty job.
    }
    const view = new DataView(list.buffer);
    const assigned = view.getUint32(0, true);
    const count = view.getUint32(4, true);
    if (count > capacity || assigned !== count) throw new Error("incomplete SDK Job Object process list");
    const pids: number[] = [];
    for (let i = 0; i < count; i++) {
      const pid = Number(view.getBigUint64(8 + i * 8, true));
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) throw new Error("invalid SDK Job Object PID");
      pids.push(pid);
    }
    return pids;
  };

  /** Make the bootstrap a verified job member. It is still waiting for its
   * release, so it has created nothing that could be missing from the job. */
  const assign = (child: ChildProcess): void => {
    const pid = child.pid!;
    // SET_QUOTA | TERMINATE | SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    const handle = api.OpenProcess(0x0100 | 0x0001 | 0x00100000 | 0x1000, 0, pid);
    if (!handle) throw failure(`OpenProcess(${pid})`);
    try {
      if (!api.AssignProcessToJobObject(job, handle)) {
        const code = api.GetLastError();
        // A bootstrap that already exited cannot join; the SDK observes that exit.
        if (api.WaitForSingleObject(handle, 0) === 0) return;
        child.kill("SIGKILL");
        throw failure(`AssignProcessToJobObject(${pid})`, code);
      }
      const member = new Int32Array(1);
      check(api.IsProcessInJob(handle, job, member), `IsProcessInJob(${pid})`);
      if (member[0] !== 1) {
        child.kill("SIGKILL");
        throw new Error(`SDK bootstrap ${pid} is not in its Job Object`);
      }
    } finally {
      check(api.CloseHandle(handle), "CloseHandle(bootstrap)");
    }
  };

  /** End every member now. Used by the SpawnedProcess kill() the SDK calls,
   * so the tree never outlives the SDK's own decision to stop. Never throws. */
  const endTree = (): void => {
    if (closed || sdkKillEndedTree) return;
    if (api.TerminateJobObject(job, 1)) sdkKillEndedTree = true;
  };

  const releaseReadyDir = (): void => {
    if (!readyDir) return;
    rmSync(readyDir, { recursive: true, force: true });
    readyDir = undefined;
  };

  const closeJob = (): void => {
    if (closed) return;
    closed = true;
    check(api.CloseHandle(job), "CloseHandle(job)");
    library.close();
  };

  const bootstrapAlive = (): boolean =>
    bootstrap !== undefined && bootstrap.pid !== undefined &&
    bootstrap.exitCode === null && bootstrap.signalCode === null;

  const waitForBootstrapExit = (ms: number): Promise<void> => new Promise((resolve) => {
    if (!bootstrapAlive()) { resolve(); return; }
    const child = bootstrap!;
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    }
    child.once("exit", done);
  });

  /** ChildProcess already satisfies SpawnedProcess; only kill() is widened. */
  const wrap = (child: ChildProcess): ContainedSpawnedProcess => ({
    stdin: child.stdin!,
    stdout: child.stdout!,
    get pid() { return child.pid; },
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    kill(signal) {
      // The SDK's force-kill lands on the bootstrap. Take the whole tree with
      // it, or the CLI would keep the SDK's stdout pipe open and stall the
      // stream the SDK is winding down.
      endTree();
      return child.kill(signal);
    },
    on: child.on.bind(child) as SpawnedProcess["on"],
    once: child.once.bind(child) as SpawnedProcess["once"],
    off: child.off.bind(child) as SpawnedProcess["off"],
  });

  return {
    spawn(spawnOptions) {
      if (closed) throw new Error("SDK process containment already terminated");
      if (bootstrap) throw new Error("SDK process containment spawns one CLI per drive");
      // Mirror the SDK's local spawn (stdio pipes, hidden window, forwarded
      // abort signal). The SDK discards stderr unless it is debugging; keep the
      // debug case visible instead of piping into a buffer nobody drains.
      const debug = /^(1|true|yes)$/i.test(spawnOptions.env.DEBUG_CLAUDE_AGENT_SDK ?? "");
      readyDir = mkdtempSync(join(tmpdir(), "aidlc-sdk-bootstrap-"));
      const readyFile = join(readyDir, "ready");
      const child = spawn(
        process.execPath,
        [BOOTSTRAP, readyFile, String(process.pid), spawnOptions.command, ...spawnOptions.args],
        {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          stdio: ["pipe", "pipe", debug ? "inherit" : "ignore"],
          signal: spawnOptions.signal,
          windowsHide: true,
        },
      );
      bootstrap = child;
      // A failed spawn has no pid; its 'error' event reaches the SDK unchanged.
      if (child.pid !== undefined) {
        try {
          options.beforeAssign?.();
          assign(child);
          // Only a verified member is released to start the CLI.
          writeFileSync(readyFile, "ready\n");
        } catch (error) {
          releaseReadyDir();
          throw error;
        }
      }
      return wrap(child);
    },
    memberPids,
    async terminate(terminateOptions = {}) {
      if (report) return report;
      const started = Date.now();
      const deadline = started + remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS);
      const bootstrapExited = !bootstrapAlive();
      const graceMs = Math.max(0, Math.min(terminateOptions.graceMs ?? 0, deadline - Date.now()));
      if (!bootstrapExited && graceMs > 0) await waitForBootstrapExit(graceMs);
      const membersBeforeTerminate = memberPids();
      let terminated = false;
      if (membersBeforeTerminate.length > 0) {
        check(api.TerminateJobObject(job, 1), "TerminateJobObject");
        terminated = true;
      }
      // Terminated processes leave the list once the kernel has torn them
      // down; poll rather than trust the synchronous return.
      while (memberPids().length > 0 && Date.now() < deadline) await delay(POLL_MS);
      const survivors: SdkContainmentSurvivor[] = memberPids().map((pid) => ({ pid }));
      let survivorDetailError: string | undefined;
      if (survivors.length > 0) {
        try {
          const budget = Math.max(1, Math.min(NATIVE_PROCESS_QUERY_TIMEOUT_MS, deadline - Date.now()));
          for (const row of getWindowsProcessDetailsWithBun(survivors.map((s) => s.pid), budget)) {
            const survivor = survivors.find((s) => s.pid === row.pid);
            if (survivor) {
              survivor.parentPid = row.parentPid;
              survivor.commandLine = row.commandLine;
            }
          }
        } catch (error) {
          survivorDetailError = error instanceof Error ? error.message : String(error);
        }
      }
      // Kill-on-close is the last resort for anything still listed.
      closeJob();
      releaseReadyDir();
      report = {
        bootstrapPid: bootstrap?.pid,
        bootstrapExited,
        sdkKillEndedTree,
        membersBeforeTerminate,
        terminated,
        survivors,
        ...(survivorDetailError === undefined ? {} : { survivorDetailError }),
        waitedMs: Date.now() - started,
      };
      return report;
    },
  };
}
