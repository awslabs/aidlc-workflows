// covers: tool:aidlc-init
//
// A copied project's own tool never refreshes the project from a native aidlc
// install on the same machine: that release's files would move the project to
// whatever release the install holds and swap its hooks to the native `aidlc`
// command (troubleshooting, the "workspace shell ready" row). With no --from the
// copy takes its own route, the download of its own release (asked at a
// terminal, named with --download in a script), whatever the native install
// holds. A runtime root named in AIDLC_RUNTIME_ROOT is still used as named.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyChannelOmits, projectionFiles, walkFiles } from "../../core/tools/aidlc-distribution.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const HARNESS_DIR = { claude: ".claude", kiro: ".kiro" } as const;
type Harness = keyof typeof HARNESS_DIR;
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function stampPath(root: string, harness: Harness): string {
  return join(root, HARNESS_DIR[harness], "tools", "data", "aidlc-stamp.json");
}

function stampOf(root: string, harness: Harness): string {
  return JSON.parse(readFileSync(stampPath(root, harness), "utf-8")).frameworkVersion;
}

function restamp(root: string, harness: Harness, version: string): void {
  const path = stampPath(root, harness);
  writeFileSync(path, `${JSON.stringify({ ...JSON.parse(readFileSync(path, "utf-8")), frameworkVersion: version }, null, 2)}\n`);
}

// A machine of its own: home, config homes and the native install root, with
// nothing of this process's AI-DLC or host environment carried over.
function machine(extra: Record<string, string> = {}): { root: string; env: NodeJS.ProcessEnv } {
  const root = temp("aidlc-t-copy-keeps-machine-");
  for (const dir of ["home", "config", "data", "claude", "bin", join("share", "aidlc")]) mkdirSync(join(root, dir), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (/^(AIDLC_|AWS_AIDLC_|CLAUDE|KIRO_|CODEX_)/.test(name)) delete env[name];
  return {
    root,
    env: {
      ...env,
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      AIDLC_INSTALL_ROOT: join(root, "share", "aidlc"),
      AIDLC_BIN_DIR: join(root, "bin"),
      ...extra,
    },
  };
}

// What the native installer leaves: the release's native runtime under
// versions/<version>/runtime/<harness> and the active-executable pointer.
function installNative(root: string, version: string, harnesses: Harness[]): void {
  const versionRoot = join(root, "share", "aidlc", "versions", version);
  for (const harness of harnesses) {
    const runtime = join(versionRoot, "runtime", harness);
    cpSync(join(REPO_ROOT, "dist-release", harness), runtime, { recursive: true });
    restamp(runtime, harness, version);
  }
  const executable = join(versionRoot, platform() === "win32" ? "aidlc.exe" : "aidlc");
  writeFileSync(executable, "native fixture\n");
  writeFileSync(join(root, "share", "aidlc", "active-executable"), `${executable}\n`);
}

// The copy runtime's files for one harness, as a person copies them in.
function copyRuntime(harness: Harness, version = AIDLC_VERSION): string {
  const source = join(REPO_ROOT, "dist", harness);
  const omitted = copyChannelOmits(projectionFiles(source).descriptor);
  const copy = join(temp(`aidlc-t-copy-keeps-${harness}-runtime-`), harness);
  for (const rel of walkFiles(source)) {
    if (omitted.has(rel.replaceAll("\\", "/"))) continue;
    mkdirSync(dirname(join(copy, rel)), { recursive: true });
    cpSync(join(source, rel), join(copy, rel));
  }
  if (version !== AIDLC_VERSION) restamp(copy, harness, version);
  return copy;
}

function run(
  project: string,
  harness: Harness,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number; out: string } {
  const result = spawnSync(BUN, [join(HARNESS_DIR[harness], "tools", "aidlc.ts"), "config", ...args], {
    cwd: project,
    env,
    encoding: "utf-8",
    input: "",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// A project the person copied the runtime into and set up with its own tool,
// as the Copy Channel section's last line does.
function copiedProject(env: NodeJS.ProcessEnv, trees: { harness: Harness; version?: string }[]): string {
  const project = temp("aidlc-t-copy-keeps-project-");
  mkdirSync(join(project, ".git"));
  for (const { harness, version } of trees) {
    const copy = copyRuntime(harness, version);
    cpSync(copy, project, { recursive: true });
    const setup = run(project, harness, ["--from", copy, "--harness", harness, "--mcp", "none", "--yes"], env);
    expect(setup.status, setup.out).toBe(0);
    expect(stampOf(project, harness)).toBe(version ?? AIDLC_VERSION);
  }
  return project;
}

function treeFiles(project: string): string[] {
  return walkFiles(join(project, ".claude")).sort();
}

describe("a copied project's own config with a native aidlc on the machine", () => {
  for (const [label, nativeVersion] of [
    ["an older native release", "2.8.0"],
    ["a newer native release", "2.99.0"],
    ["the same release natively", AIDLC_VERSION],
  ] as const) {
    test(`${label}: the project keeps its release, its files and its hooks, and is offered its own release`, () => {
      const { root, env } = machine();
      const project = copiedProject(env, [{ harness: "claude" }]);
      installNative(root, nativeVersion, ["claude"]);
      const files = treeFiles(project);
      const settings = readFileSync(join(project, ".claude", "settings.json"), "utf-8");

      const refresh = run(project, "claude", ["--force"], env);
      expect(refresh.status, refresh.out).toBe(4);
      expect(refresh.out).toContain(`refreshing .claude needs the ${AIDLC_VERSION} release files`);
      expect(refresh.out).toContain("bun .claude/tools/aidlc.ts config --force --download");
      expect(refresh.out).not.toContain(nativeVersion === AIDLC_VERSION ? "configured" : nativeVersion);
      expect(stampOf(project, "claude")).toBe(AIDLC_VERSION);
      expect(treeFiles(project)).toEqual(files);
      const after = readFileSync(join(project, ".claude", "settings.json"), "utf-8");
      expect(after).toBe(settings);
      expect(after).not.toContain('"aidlc engine hook');
    });
  }

  test("a runtime root named in AIDLC_RUNTIME_ROOT is still the source it names", () => {
    const { env } = machine({ AIDLC_RUNTIME_ROOT: join(REPO_ROOT, "dist") });
    const project = copiedProject(env, [{ harness: "claude" }]);
    const refresh = run(project, "claude", ["--force"], env);
    expect(refresh.status, refresh.out).toBe(0);
    expect(stampOf(project, "claude")).toBe(AIDLC_VERSION);
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf-8")).not.toContain('"aidlc engine hook');
  });

  // #1406's line for a tree left on another release names a command that does
  // what it says: the plain one would keep the tree at its own release, so the
  // line names the copy runtime file of the release just written.
  test("a tree left on another release is told to take the copy runtime file, not the native install", () => {
    const { root, env } = machine();
    const project = copiedProject(env, [{ harness: "claude" }, { harness: "kiro", version: "2.9.0" }]);
    installNative(root, AIDLC_VERSION, ["claude", "kiro"]);
    const refreshed = run(project, "claude", ["--harness", "claude", "--from", copyRuntime("claude"), "--yes"], env);
    expect(refreshed.status, refreshed.out).toBe(0);
    expect(refreshed.out).toContain(`Kiro CLI (.kiro) is still on 2.9.0. To bring it to ${AIDLC_VERSION}: get `);
    expect(refreshed.out).toContain("then run `bun .claude/tools/aidlc.ts config --harness kiro --from <that file>`.");
    expect(refreshed.out).not.toContain("`bun .claude/tools/aidlc.ts config --harness kiro`.");
  });
});
