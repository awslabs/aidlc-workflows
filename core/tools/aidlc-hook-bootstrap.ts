// Transport only the independent SessionStart response across a hook child.
// The random per-event file is private, project/target-bound, consumed by the
// parent and removed when that invocation ends. It carries no request authority.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  readRegularFileNoFollowOrThrow, recordFileTargetOrThrow, sessionsDir, type WorkflowSelection,
} from "./aidlc-lib.ts";

const ENV = "AIDLC_HOOK_BOOTSTRAP_CAPTURE";
const MAX_BYTES = 1024 * 1024;
type Target = Pick<WorkflowSelection, "space" | "intent" | "sessionId">;
type Capture = { version: 1; id: string; projectDir: string; target: Target };

function sameTarget(a: Target, b: Target): boolean {
  return a.space === b.space && a.intent === b.intent && a.sessionId === b.sessionId;
}

function capturePath(projectDir: string, id: string): string {
  return join(sessionsDir(projectDir), `.hook-bootstrap-${id}.json`);
}

export function beginHookBootstrapCapture(projectDir: string, target: Target): {
  env: Record<string, string>;
  read: () => string;
  close: () => void;
} {
  const capture: Capture = {
    version: 1, id: randomBytes(16).toString("hex"), projectDir: resolve(projectDir),
    target: { space: target.space, intent: target.intent, sessionId: target.sessionId },
  };
  const path = capturePath(projectDir, capture.id);
  return {
    env: { [ENV]: JSON.stringify(capture) },
    read: () => {
      try {
        const safe = recordFileTargetOrThrow(projectDir, relative(projectDir, path));
        const value = JSON.parse(readRegularFileNoFollowOrThrow(safe, "hook bootstrap", MAX_BYTES).toString("utf8"));
        return value.version === 1 && value.id === capture.id &&
          value.projectDir === capture.projectDir && value.target &&
          sameTarget(value.target, capture.target) && typeof value.output === "string"
          ? value.output : "";
      } catch {
        return "";
      }
    },
    close: () => {
      try {
        rmSync(recordFileTargetOrThrow(projectDir, relative(projectDir, path)), { force: true });
      } catch { /* private transient receipt */ }
    },
  };
}

export function recordHookBootstrap(projectDir: string, target: Target, output: string): void {
  try {
    const capture = JSON.parse(process.env[ENV] ?? "") as Capture;
    if (capture.version !== 1 || !/^[0-9a-f]{32}$/.test(capture.id) ||
      capture.projectDir !== resolve(projectDir) || !capture.target ||
      !sameTarget(capture.target, target)) return;
    const data = JSON.stringify({ ...capture, output });
    if (Buffer.byteLength(data) > MAX_BYTES) return;
    const rel = relative(projectDir, capturePath(projectDir, capture.id));
    const path = recordFileTargetOrThrow(projectDir, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    recordFileTargetOrThrow(projectDir, rel);
    writeFileSync(path, data, {
      flag: "wx", mode: 0o600,
    });
  } catch {
    // Bootstrap transport is advisory; it never changes setup or retries it.
  }
}
