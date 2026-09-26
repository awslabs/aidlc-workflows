#!/usr/bin/env bun
// sdk-contained-bootstrap.ts: the process the SDK containment starts instead
// of the Claude CLI on Windows (see sdk-process-containment.ts).
//
// Windows adds a process to a Job Object only when it is assigned; children
// the process has already created stay outside and are never added later. A
// CLI started directly could therefore create a helper (git, ripgrep, an MCP
// server) in the moment between CreateProcess and AssignProcessToJobObject,
// and that helper would escape the drive's termination. This bootstrap closes
// the gap: it runs nothing of consequence until its parent has assigned it to
// the job and released it through a ready file, then starts the real CLI with
// inherited stdio. Every process the CLI creates from then on is born inside
// the job.
//
// Contract: argv = <ready-file> <parent-pid> <command> [args...]. It never
// writes to stdout (that pipe is the SDK's stream-json channel) and never
// reads stdin (the CLI owns it); diagnostics go to stderr. Exit code: the
// CLI's own; 3 when the parent never released it; 126/127 when the CLI could
// not start. SIGINT/SIGTERM/SIGHUP are forwarded where the runtime can observe
// them. A TerminateProcess on this bootstrap is invisible to it: the
// parent-owned job ends the whole tree in that case.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { NATIVE_STARTUP_TIMEOUT_MS } from "./test-budget.ts";

const RELEASE_POLL_MS = 5;

function fail(code: number, message: string): never {
  process.stderr.write(`sdk-contained-bootstrap: ${message}\n`);
  process.exit(code);
}

const [readyFile, parentPidText, command, ...args] = process.argv.slice(2);
if (!readyFile || !/^[1-9][0-9]*$/.test(parentPidText ?? "") || !command) {
  fail(2, "usage: bun sdk-contained-bootstrap.ts <ready-file> <parent-pid> <command> [args...]");
}
const parentPid = Number(parentPidText);

function parentAlive(): boolean {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// Wait to be released. The parent writes the ready file only after this
// process is a verified job member; a parent that dies first must not leave a
// bootstrap waiting forever, and a parent that never releases is a bug.
const deadline = Date.now() + NATIVE_STARTUP_TIMEOUT_MS;
while (!existsSync(readyFile)) {
  if (!parentAlive()) fail(3, "parent exited before releasing the bootstrap");
  if (Date.now() >= deadline) fail(3, "parent never released the bootstrap");
  await Bun.sleep(RELEASE_POLL_MS);
}

const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
child.once("error", (error) => {
  const code = (error as NodeJS.ErrnoException).code;
  fail(code === "ENOENT" ? 127 : 126, `cannot start ${command}: ${error.message}`);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    try { child.kill(signal); } catch { /* already gone */ }
  });
}
child.once("exit", (code, signal) => {
  // A terminated child reports a null code on Windows; keep that failure visible.
  process.exit(code ?? (signal ? 1 : 0));
});
