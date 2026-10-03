import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSessionPaths } from "../harness/tui-bun-backend.ts";
import {
  assertNoPendingTuiSessionsForProject,
  cleanupTuiProject,
  cleanupTuiProjectAfterKill,
  pendingTuiSessionsForProject,
} from "../harness/tui-fixtures.ts";

let root: string;
let project: string;
let nativeRoot: string;
let priorNativeRoot: string | undefined;
let priorKeepTemp: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aidlc-native-fixture-cleanup-"));
  project = join(root, "Project");
  nativeRoot = join(root, "native");
  for (const path of [project, nativeRoot]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(project, "artifact.txt"), "retain until cleanup is confirmed");
  priorNativeRoot = process.env.AIDLC_TUI_BUN_ROOT;
  priorKeepTemp = process.env.AIDLC_KEEP_TEMP;
  process.env.AIDLC_TUI_BUN_ROOT = nativeRoot;
  delete process.env.AIDLC_KEEP_TEMP;
});

afterEach(() => {
  if (priorNativeRoot === undefined) delete process.env.AIDLC_TUI_BUN_ROOT;
  else process.env.AIDLC_TUI_BUN_ROOT = priorNativeRoot;
  if (priorKeepTemp === undefined) delete process.env.AIDLC_KEEP_TEMP;
  else process.env.AIDLC_KEEP_TEMP = priorKeepTemp;
  rmSync(root, { recursive: true, force: true });
});

function nativeRecord(
  name: string,
  fields: Record<string, unknown> = {},
  sessionsRoot = nativeRoot,
): string {
  const directory = join(sessionsRoot, name);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "session.json");
  writeFileSync(path, JSON.stringify({
    schema: 1, backend: "bun", session: name, cwd: project,
    phase: "running", cleanupComplete: false, ...fields,
  }));
  return path;
}

describe("native TUI fixture cleanup guard", () => {
  test.each(["starting", "running", "error", "exited", "stopped"])(
    "blocks %s records until cleanup is explicitly confirmed, without needing a PID",
    (phase) => {
      nativeRecord(`pending-${phase}`, { phase });
      expect(pendingTuiSessionsForProject(project, nativeRoot)).toEqual([
        { name: `pending-${phase}`, recordedPid: undefined },
      ]);
      expect(() => assertNoPendingTuiSessionsForProject(project, nativeRoot))
        .toThrow(`pending-${phase}=missing-pid`);
    },
  );

  test("missing or truthy non-boolean cleanup flags cannot release the project", () => {
    nativeRecord("missing", { cleanupComplete: undefined });
    nativeRecord("string", { cleanupComplete: "true" });
    nativeRecord("number", { cleanupComplete: 1 });
    expect(pendingTuiSessionsForProject(project, nativeRoot)
      .map((session) => session.name).sort()).toEqual(["missing", "number", "string"]);
  });

  test("raw cleanup uses the configured native root and preserves project artifacts on error", () => {
    const paths = bunSessionPaths("default-root-error");
    expect(paths.root).toBe(nativeRoot);
    mkdirSync(paths.directory);
    writeFileSync(paths.record, JSON.stringify({
      cwd: project, session: "default-root-error", phase: "error",
      daemonPid: 424242, cleanupComplete: false, error: "teardown unconfirmed",
    }));
    expect(() => cleanupTuiProject(project)).toThrow("default-root-error=424242");
    expect(readFileSync(join(project, "artifact.txt"), "utf8"))
      .toBe("retain until cleanup is confirmed");
    expect(existsSync(paths.record)).toBe(true);
  });

  test("confirmed cleanup allows AfterKill removal while retaining the native final snapshot", () => {
    const path = nativeRecord("completed", { phase: "stopped", cleanupComplete: true });
    const snapshot = join(nativeRoot, "completed", "screen.json");
    writeFileSync(snapshot, JSON.stringify({ text: "final frame" }));
    expect(pendingTuiSessionsForProject(project, nativeRoot)).toEqual([]);
    cleanupTuiProjectAfterKill(project, "completed", { rc: 0 });
    expect(existsSync(project)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(snapshot, "utf8"))).toEqual({ text: "final frame" });
  });

  test("an explicit root overrides native session scanning", () => {
    const overrideRoot = join(root, "native-override");
    nativeRecord("ignored-default");
    nativeRecord("selected-native", { daemonPid: 4321 }, overrideRoot);
    expect(pendingTuiSessionsForProject(project, overrideRoot)).toEqual([
      { name: "selected-native", recordedPid: 4321 },
    ]);
    expect(() => assertNoPendingTuiSessionsForProject(project, overrideRoot))
      .toThrow("selected-native=4321");
  });

  test("native cwd matching respects platform case rules and directory boundaries", () => {
    nativeRecord("case-variant", { cwd: join(root, "project") });
    nativeRecord("same-normalized-path", { cwd: `${project}/child/../` });
    nativeRecord("other-project", { cwd: `${project}-other` });
    nativeRecord("nested-project", { cwd: join(project, "child") });
    expect(pendingTuiSessionsForProject(project, nativeRoot)
      .map((session) => session.name).sort()).toEqual(
      process.platform === "win32"
        ? ["case-variant", "same-normalized-path"]
        : ["same-normalized-path"],
    );
  });

  test("native directory names provide diagnostics when launch metadata has no session name", () => {
    nativeRecord("launch-directory", { session: undefined, daemonPid: "bad-pid" });
    expect(pendingTuiSessionsForProject(project, nativeRoot)).toEqual([
      { name: "launch-directory", recordedPid: undefined },
    ]);
  });

  test("unreadable native records preserve the project instead of allowing uncertain cleanup", () => {
    const path = nativeRecord("invalid-record");
    writeFileSync(path, "{incomplete");
    expect(() => cleanupTuiProject(project)).toThrow("could not inspect native Bun sessions");
    expect(existsSync(join(project, "artifact.txt"))).toBe(true);
  });

  test("missing roots and directories without records do not block unrelated cleanup", () => {
    mkdirSync(join(nativeRoot, "launch-without-record"));
    writeFileSync(join(nativeRoot, "session.lock"), "not a session directory");
    expect(pendingTuiSessionsForProject(project, nativeRoot)).toEqual([]);
    expect(pendingTuiSessionsForProject(
      project, join(root, "missing-native"),
    )).toEqual([]);
    expect(() => assertNoPendingTuiSessionsForProject(project, nativeRoot)).not.toThrow();
  });
});
