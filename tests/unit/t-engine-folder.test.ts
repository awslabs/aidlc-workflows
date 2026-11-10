// covers: function:ensureWorkspaceEngineFolder, function:workspaceEnginePath, function:workspaceEngineFile, function:sessionsDir, function:cloneIdPath, function:cloneIdentity
//
// t-engine-folder: AI-DLC's own machine-local files in a workspace live in one
// hidden folder, aidlc/.aidlc-engine/, which keeps itself out of git with its
// own .gitignore holding "*". A workspace an earlier release set up keeps them
// as separate entries at the top of aidlc/; the first engine process that
// builds one of these paths moves them in, file by file, and leaves the pin
// marker where every release reads it.
//
// INVARIANTS asserted:
//   1. One engine path moves every earlier entry to its new name, byte for
//      byte, writes the folder's .gitignore, and leaves aidlc/.aidlc-sessions/
//      holding only pin-target; git status shows nothing of the folder.
//   2. A second process changes nothing.
//   3. Both places present: the clone id keeps the new place, and the old
//      name gets its bytes, so an earlier release that runs here again reads
//      the same identity; any other file keeps the newer, the new place on
//      equal times.
//   4. A move refused (an unwritable folder) leaves the clone id read and
//      written at its old name: no new token, no second audit shard.
//   5. A link at aidlc/.aidlc-engine carries nothing out of the project.
//   6. A read-only engine observer that is the first process on the earlier
//      layout reads what the earlier release recorded.
//   7. Switching to a release from before the folder says once what it will
//      not see (a claimed Unit, an approved merge not landed), and nothing when
//      nothing is open, the folder was never made, the release reads it, or the
//      project's own pin names another release.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { REPO_ROOT, toPortablePath } from "../harness/fixtures.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

const NEWER_PREVIEW = ((parts) => `${parts[0]}.${parts[1]}.${parts[2] + 1}-preview.20261111.1`)(AIDLC_VERSION.split(".").map(Number));

const LIB = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-lib.ts");
const RECORD_CORE = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-record-core.ts");
const LIFECYCLE = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-lifecycle.ts");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    try {
      chmodSync(join(dir, "aidlc", ".aidlc-engine"), 0o700);
    } catch {
      // Not made read-only by this test.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  let dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix));
  try {
    dir = realpathSync(dir);
  } catch {
    // Keep the temp path as created.
  }
  dir = toPortablePath(dir);
  dirs.push(dir);
  return dir;
}

// A workspace as an earlier release left it: each engine entry at the top of
// aidlc/, with its own bytes.
const EARLIER: Record<string, string> = {
  ".aidlc-clone-id": "0a1b2c3d4e5f\nhost-one\n",
  ".aidlc-sessions/s-other.binding.json": '{"space":"default"}\n',
  ".aidlc-sessions/no-git-said": "2026-11-01T00:00:00.000Z\n",
  ".aidlc-sessions/plan-approval/ask-0123456789abcdef01234567.json": '{"ask":1}\n',
  ".aidlc-sessions/questions/0a1b2c3d.json": '{"id":"0a1b2c3d"}\n',
  ".aidlc-sessions/messages/m-0a1b2c3d.json": '{"text":"cut"}\n',
  ".aidlc-sessions/messages/m-0a1b2c3d.txt": "the whole prompt, as typed\n",
  ".aidlc-turn-counter": "7\n",
  ".aidlc-readonly-latch": '{"turn":7}\n',
  ".aidlc-forwarding-latch": '{"turn":7,"raw":"/aidlc"}\n',
  ".aidlc-subagent-inflight": '{"entries":[]}\n',
  ".aidlc-cursor-subagents/spawn-aaaa-bbbb.json": '{"agent":"a"}\n',
  ".aidlc-cursor-subagent-aaaa-bbbb.json": '{"witness":1}\n',
  ".aidlc-claim-registry.json": '{"version":1}\n',
  ".aidlc-claim-generations.json": '{"u1":3}\n',
  ".aidlc-unit-scope.json": '{"version":1,"unit":"u1"}\n',
  ".aidlc-unit-participant": "participant\n",
  ".aidlc-unit-parked": '{"unit":"u1"}\n',
  ".aidlc-unit-releases/default/1111/u1.json": '{"status":"pending"}\n',
  ".aidlc-unit-merges/default/1111/u1.json": '{"status":"pinned"}\n',
};
const NOW: Record<string, string> = {
  ".aidlc-clone-id": "clone-id",
  ".aidlc-sessions/s-other.binding.json": "sessions/s-other.binding.json",
  ".aidlc-sessions/no-git-said": "sessions/no-git-said",
  ".aidlc-sessions/plan-approval/ask-0123456789abcdef01234567.json": "sessions/plan-approval/ask-0123456789abcdef01234567.json",
  ".aidlc-sessions/questions/0a1b2c3d.json": "sessions/questions/0a1b2c3d.json",
  ".aidlc-sessions/messages/m-0a1b2c3d.json": "sessions/messages/m-0a1b2c3d.json",
  ".aidlc-sessions/messages/m-0a1b2c3d.txt": "sessions/messages/m-0a1b2c3d.txt",
  ".aidlc-turn-counter": "sessions/kiro-turn-counter",
  ".aidlc-readonly-latch": "sessions/kiro-readonly-latch",
  ".aidlc-forwarding-latch": "sessions/kiro-forwarding-latch",
  ".aidlc-subagent-inflight": "sessions/subagent-inflight",
  ".aidlc-cursor-subagents/spawn-aaaa-bbbb.json": "sessions/cursor-subagents/spawn-aaaa-bbbb.json",
  ".aidlc-cursor-subagent-aaaa-bbbb.json": "sessions/.aidlc-cursor-subagent-aaaa-bbbb.json",
  ".aidlc-claim-registry.json": "units/claim-registry.json",
  ".aidlc-claim-generations.json": "units/claim-generations.json",
  ".aidlc-unit-scope.json": "units/claimed.json",
  ".aidlc-unit-participant": "units/participant",
  ".aidlc-unit-parked": "units/parked",
  ".aidlc-unit-releases/default/1111/u1.json": "units/releases/default/1111/u1.json",
  ".aidlc-unit-merges/default/1111/u1.json": "units/merges/default/1111/u1.json",
};
const PIN = ".aidlc-sessions/pin-target";
const PIN_BYTES = "/somewhere/versions/2.11.3/aidlc\n";

function earlierWorkspace(): string {
  const proj = scratch("aidlc-engine-folder-");
  spawnSync("git", ["init", "-q"], { cwd: proj });
  writeFileSync(join(proj, "README.md"), "# shop\n");
  for (const [rel, bytes] of Object.entries({ ...EARLIER, [PIN]: PIN_BYTES })) {
    mkdirSync(join(proj, "aidlc", rel, ".."), { recursive: true });
    writeFileSync(join(proj, "aidlc", rel), bytes);
  }
  return proj;
}

// One fresh engine process: `body` runs with `lib` (the shipped aidlc-lib),
// `core` (aidlc-record-core), `lifecycle` and `proj`, and prints what the test reads.
function engine(proj: string, body: string, env: Record<string, string> = {}): string {
  const script = join(scratch("aidlc-engine-folder-probe-"), "probe.ts");
  writeFileSync(
    script,
    `const lib = await import(${JSON.stringify(LIB)});\nconst core = await import(${JSON.stringify(RECORD_CORE)});\n` +
      `const lifecycle = await import(${JSON.stringify(LIFECYCLE)});\n` +
      `const proj = ${JSON.stringify(proj)};\n${body}\n`,
  );
  const run = spawnSync(process.execPath, [script], {
    cwd: proj,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  return run.stdout.trim();
}

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) walk(path);
      else out[relative(root, path).replaceAll("\\", "/")] = readFileSync(path, "utf-8");
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

describe("an earlier release's engine files move into aidlc/.aidlc-engine/", () => {
  test("one engine path moves each file to its new name, leaves pin-target, and the folder keeps itself out of git", () => {
    const proj = earlierWorkspace();
    engine(proj, "lib.sessionsDir(proj);");
    const folder = join(proj, "aidlc", ".aidlc-engine");
    expect(readFileSync(join(folder, ".gitignore"), "utf-8")).toBe("*\n");
    for (const [old, now] of Object.entries(NOW)) {
      expect(readFileSync(join(folder, now), "utf-8"), now).toBe(EARLIER[old]);
      expect(existsSync(join(proj, "aidlc", old)), old).toBe(false);
    }
    expect(readFileSync(join(proj, "aidlc", PIN), "utf-8")).toBe(PIN_BYTES);
    expect(readdirSync(join(proj, "aidlc", ".aidlc-sessions"))).toEqual(["pin-target"]);
    expect(readdirSync(join(proj, "aidlc")).sort()).toEqual([".aidlc-engine", ".aidlc-sessions"]);
    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: proj, encoding: "utf-8" });
    expect(status.stdout.split("\n").filter((line) => line.includes(".aidlc-engine"))).toEqual([]);

    const before = tree(join(proj, "aidlc"));
    engine(proj, "lib.sessionsDir(proj); lib.cloneIdPath(proj);");
    expect(tree(join(proj, "aidlc"))).toEqual(before);
  });

  test("both places present: the clone id keeps the new place and the old name gets it; another file keeps the newer, the new place on equal times", () => {
    const proj = earlierWorkspace();
    const folder = join(proj, "aidlc", ".aidlc-engine");
    mkdirSync(join(folder, "sessions"), { recursive: true });
    writeFileSync(join(folder, "clone-id"), "ffffffffffff\nhost-two\n");
    writeFileSync(join(folder, "sessions", "no-git-said"), "new place\n");
    writeFileSync(join(folder, "sessions", "s-other.binding.json"), "new place, older\n");
    const old = new Date("2026-11-01T00:00:00Z");
    const newer = new Date("2026-11-02T00:00:00Z");
    utimesSync(join(proj, "aidlc", ".aidlc-clone-id"), newer, newer);
    utimesSync(join(proj, "aidlc", ".aidlc-sessions", "no-git-said"), old, old);
    utimesSync(join(folder, "sessions", "no-git-said"), old, old);
    utimesSync(join(proj, "aidlc", ".aidlc-sessions", "s-other.binding.json"), newer, newer);
    utimesSync(join(folder, "sessions", "s-other.binding.json"), old, old);
    engine(proj, "lib.sessionsDir(proj);");
    expect(readFileSync(join(folder, "clone-id"), "utf-8")).toBe("ffffffffffff\nhost-two\n");
    expect(readFileSync(join(proj, "aidlc", ".aidlc-clone-id"), "utf-8")).toBe("ffffffffffff\nhost-two\n");
    expect(readFileSync(join(folder, "sessions", "no-git-said"), "utf-8")).toBe("new place\n");
    expect(readFileSync(join(folder, "sessions", "s-other.binding.json"), "utf-8")).toBe(EARLIER[".aidlc-sessions/s-other.binding.json"]);
  });

  test.skipIf(process.platform === "win32")("a refused move leaves the clone id read and written at its old name", () => {
    const proj = earlierWorkspace();
    const folder = join(proj, "aidlc", ".aidlc-engine");
    mkdirSync(folder);
    writeFileSync(join(folder, ".gitignore"), "*\n");
    chmodSync(folder, 0o500);
    try {
      const token = engine(proj, "console.log(core.cloneIdentity(proj).token);");
      expect(token).toBe("0a1b2c3d4e5f");
      expect(existsSync(join(folder, "clone-id"))).toBe(false);
      expect(readFileSync(join(proj, "aidlc", ".aidlc-clone-id"), "utf-8")).toBe(EARLIER[".aidlc-clone-id"]);
    } finally {
      chmodSync(folder, 0o700);
    }
  });

  test.skipIf(process.platform === "win32")("a link at aidlc/.aidlc-engine carries nothing out of the project", () => {
    const proj = earlierWorkspace();
    const outside = scratch("aidlc-engine-folder-outside-");
    symlinkSync(outside, join(proj, "aidlc", ".aidlc-engine"), "dir");
    engine(proj, "lib.sessionsDir(proj); lib.cloneIdPath(proj);");
    expect(readdirSync(outside)).toEqual([]);
    for (const old of Object.keys(EARLIER)) {
      expect(readFileSync(join(proj, "aidlc", old), "utf-8"), old).toBe(EARLIER[old]);
    }
  });

  test("a read-only observer that is the first process on the earlier layout reads what was recorded", () => {
    const proj = earlierWorkspace();
    const read = engine(
      proj,
      "console.log(require('node:fs').readFileSync(require('node:path').join(lib.sessionsDir(proj), 'plan-approval', 'ask-0123456789abcdef01234567.json'), 'utf-8').trim());",
      { AIDLC_STOP_HOOK_PROBE: "1" },
    );
    expect(read).toBe('{"ask":1}');
    expect(existsSync(join(proj, "aidlc", ".aidlc-engine", "sessions", "plan-approval", "ask-0123456789abcdef01234567.json"))).toBe(true);
  });

  test("going back to a release from before the folder says what it will not see, once, and only then", () => {
    const proj = scratch("aidlc-engine-folder-back-");
    const line = (release: string): string => engine(proj, `console.log(await lifecycle.engineFolderGoingBackLine(proj, ${JSON.stringify(release)}, "aidlc use 2.12.0") ?? "none");`);
    mkdirSync(join(proj, "aidlc"), { recursive: true });
    expect(line("2.10.0")).toBe("none");
    const units = join(proj, "aidlc", ".aidlc-engine", "units");
    mkdirSync(join(units, "merges", "default", "1111"), { recursive: true });
    expect(line("2.10.0")).toBe("none");
    writeFileSync(join(units, "claimed.json"), '{"version":1,"unit":"u1"}\n');
    expect(line("2.10.0")).toBe("AI-DLC 2.10.0 will not see the Unit u1 you claimed in this project. `aidlc use 2.12.0` brings it back.");
    writeFileSync(join(units, "merges", "default", "1111", "u2.json"), '{"status":"approved","unit":"u2"}\n');
    writeFileSync(join(units, "merges", "default", "1111", "u3.json"), '{"status":"complete","unit":"u3"}\n');
    expect(line("2.10.0")).toBe(
      "AI-DLC 2.10.0 will not see the Unit u1 you claimed and the merge of u2 you approved in this project. `aidlc use 2.12.0` brings it back.",
    );
    expect(line("2.12.0")).toBe("none");
    expect(line("3.0.0")).toBe("none");
    // The release running now, and one newer than it, have the folder whatever
    // their number says (a preview built from main is numbered below 2.12).
    expect(line(AIDLC_VERSION)).toBe("none");
    expect(line(NEWER_PREVIEW)).toBe("none");
    // `aidlc use` does not reach a project whose own pin names another release.
    writeFileSync(join(proj, ".aidlc-version"), "2.12.0\n");
    expect(line("2.10.0")).toBe("none");
    writeFileSync(join(proj, ".aidlc-version"), "2.10.0\n");
    expect(line("2.10.0")).not.toBe("none");
  });

  test("a fresh workspace gets the folder with its sessions and units folders, so a first claim has somewhere to write", () => {
    const proj = scratch("aidlc-engine-folder-fresh-");
    mkdirSync(join(proj, "aidlc"), { recursive: true });
    engine(proj, "lib.sessionsDir(proj);");
    for (const sub of ["sessions", "units"]) {
      expect(lstatSync(join(proj, "aidlc", ".aidlc-engine", sub)).isDirectory(), sub).toBe(true);
    }
    // A first Unit write lands without making its folder itself.
    engine(proj, "require('node:fs').writeFileSync(lib.claimGenerationsPath(proj), '{}');");
    expect(existsSync(join(proj, "aidlc", ".aidlc-engine", "units", "claim-generations.json"))).toBe(true);
  });

  test("a project pinned to another release keeps its earlier files where that release reads them", () => {
    const proj = earlierWorkspace();
    // A release before the folder, never this one (whose own pin moves them).
    writeFileSync(join(proj, ".aidlc-version"), "2.10.0\n");
    engine(proj, "lib.sessionsDir(proj); lib.cloneIdPath(proj);");
    for (const old of Object.keys(EARLIER)) {
      expect(readFileSync(join(proj, "aidlc", old), "utf-8"), old).toBe(EARLIER[old]);
    }
  });

  test("the going-back line reads what is there and moves nothing", () => {
    const proj = earlierWorkspace();
    mkdirSync(join(proj, "aidlc", ".aidlc-engine"), { recursive: true });
    expect(engine(proj, 'console.log(await lifecycle.engineFolderGoingBackLine(proj, "2.10.0", "aidlc use 2.12.0") ?? "none");')).toBe("none");
    for (const old of Object.keys(EARLIER)) {
      expect(readFileSync(join(proj, "aidlc", old), "utf-8"), old).toBe(EARLIER[old]);
    }
  });
});
