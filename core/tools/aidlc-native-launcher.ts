// bin\aidlc.exe of a native Windows install is a copy of the aidlc binary
// (windowsExeCommandPath). Run from there, it starts the active release with
// the arguments as it was given them, so no cmd.exe reads & | < > ^ or %NAME%
// in them the way it does for aidlc.cmd.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { activeExecutablePath, readActiveExecutable } from "./aidlc-install-paths.ts";

// The install root aidlc.cmd was written with (windowsShim in
// aidlc-lifecycle.ts), as aidlc-shim.ps1 has it: the copy reads the install it
// sits in even when AIDLC_INSTALL_ROOT named it only at install. Null for any
// other file, so the binary run from anywhere else is itself.
export function nativeLauncherRoot(cmd: string): string | null {
  const match =
    /^@echo off\r\npowershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "([^"\r\n]+)[\\/]aidlc-shim\.ps1" %\*\r\nexit \/b %ERRORLEVEL%\r\n$/
      .exec(cmd);
  return match ? match[1].replaceAll("%%", "%") : null;
}

// True when this process is the bin copy and has taken the command over: it
// runs the active release, waits for it and exits with its code.
export function startNativeLauncher(): boolean {
  if (process.platform !== "win32") return false;
  let root: string | null;
  try {
    root = nativeLauncherRoot(readFileSync(join(dirname(process.execPath), "aidlc.cmd"), "utf-8"));
  } catch {
    return false;
  }
  if (root === null) return false;
  // The release runs with the environment the person's shell gave this copy.
  const env = { ...process.env, AIDLC_SHIM_PID: String(process.pid) };
  process.env.AIDLC_INSTALL_ROOT = root;
  let target: string | null;
  let reason = "";
  try {
    target = readActiveExecutable();
    if (target === null) {
      reason = `active command target ${activeExecutablePath()} is missing`;
    } else if (!existsSync(target)) {
      reason = `active executable ${target} is missing`;
      target = null;
    }
  } catch (error) {
    target = null;
    reason = error instanceof Error ? error.message : String(error);
  }
  const stop = (why: string): never => {
    process.stderr.write(`aidlc: ${why}. Rerun the AI-DLC installer (install.ps1) to repair the aidlc command.\n`);
    process.exit(4);
  };
  if (target === null) stop(reason);
  // Ctrl+C reaches the release too; this copy waits for it to finish.
  process.on("SIGINT", () => {});
  try {
    const child = Bun.spawn([target as string, ...process.argv.slice(2)], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
    });
    void child.exited.then((code) => process.exit(code));
  } catch (error) {
    stop(`the active executable ${target} could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}
