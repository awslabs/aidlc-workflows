// windows-folder-holders.ts: what the harness knows about processes that could
// still hold a Windows fixture folder when its removal fails with EBUSY.
//
// The SDK drive records one verdict per project directory after it terminates
// its Job Object (sdk-process-containment.ts). cleanupTuiProject's Windows
// diagnostics read it back, so a stuck removal can say whether the drive left
// descendants behind or the holder has to be something outside the drive.
// The registry is process-local: it only describes drives run by this test
// process, which is exactly the scope in which the fixture is removed.

import { resolve } from "node:path";

const verdicts = new Map<string, string>();

function key(projectDir: string): string {
  const path = resolve(projectDir);
  // Windows paths compare case-insensitively; keep POSIX keys exact.
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function recordWindowsFolderHolderVerdict(projectDir: string, verdict: string): void {
  verdicts.set(key(projectDir), verdict);
}

export function windowsFolderHolderVerdict(projectDir: string): string | undefined {
  return verdicts.get(key(projectDir));
}
