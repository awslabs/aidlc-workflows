// covers: none (aidlc-init config --pin has no registry unit)
//
// `config --pin` switches the engine that serves a project at once,
// while the project's own files stay at the version its harness tree was last
// refreshed to until the next `aidlc config`. A pin or unpin while work is
// open is done, and when the files are on another version than the one the
// project now follows, it says to run `aidlc config` to finish. A tree from
// before stamps records no version, so it never counts as a match.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const CLAUDE_RELEASE = join(REPO_ROOT, "dist-release", "claude");
const KIRO_RELEASE = join(REPO_ROOT, "dist-release", "kiro");
const OTHER_VERSION = "9.9.9";

const created: string[] = [];
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

// A project installed from the packaged Claude tree, so its harness stamp names
// this build's version, with one workflow in flight when `active` is set.
function project(active: boolean): { dir: string; installRoot: string } {
  const dir = temp("aidlc-pin-project-");
  mkdirSync(join(dir, ".git"));
  cpSync(join(CLAUDE_RELEASE, ".claude"), join(dir, ".claude"), { recursive: true });
  if (active) {
    const intentsDir = join(dir, "aidlc", "spaces", "default", "intents");
    const dirName = "pin-probe";
    mkdirSync(join(intentsDir, dirName), { recursive: true });
    writeFileSync(
      join(intentsDir, "intents.json"),
      `${JSON.stringify([{
        uuid: "deadbeef-0000-4000-8000-000000001418",
        slug: "pin-probe",
        dirName,
        scope: "feature",
        status: "in-flight",
      }], null, 2)}\n`,
    );
    writeFileSync(
      join(intentsDir, dirName, "aidlc-state.md"),
      "# AI-DLC State Tracking\n\n## Current Status\n- **Status**: Running\n",
    );
  }
  return { dir, installRoot: temp("aidlc-pin-machine-") };
}

// A Claude tree as releases before projection stamps shipped it.
function dropStamp(dir: string): void {
  const data = join(dir, ".claude", "tools", "data");
  rmSync(join(data, "aidlc-stamp.json"));
  writeFileSync(join(data, "harness.json"), `${JSON.stringify({ harnessDir: ".claude", rulesSubdir: "rules" })}\n`);
}

// A second harness, last refreshed to `version`.
function addKiro(dir: string, version: string): void {
  cpSync(join(KIRO_RELEASE, ".kiro"), join(dir, ".kiro"), { recursive: true });
  const stampPath = join(dir, ".kiro", "tools", "data", "aidlc-stamp.json");
  const stamp = JSON.parse(readFileSync(stampPath, "utf-8"));
  writeFileSync(stampPath, `${JSON.stringify({ ...stamp, frameworkVersion: version }, null, 2)}\n`);
}

function config(proj: { dir: string; installRoot: string }, args: string[]) {
  const result = spawnSync(process.execPath, [INIT, "config", ...args, "--project-dir", proj.dir], {
    cwd: proj.dir,
    env: {
      ...process.env,
      AIDLC_INSTALL_ROOT: proj.installRoot,
      AIDLC_BIN_DIR: join(proj.installRoot, "bin"),
      AIDLC_OFFLINE: "1",
    },
    encoding: "utf-8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("config --pin while a workflow is running (#1418)", () => {
  const FINISH = "config` to finish updating this project.";

  // The machine follows another version, and the project is pinned to the one
  // its files are from.
  function pinnedAwayFromMachine(active: boolean): { dir: string; installRoot: string } {
    const proj = project(active);
    writeFileSync(join(proj.installRoot, "active-version"), `${OTHER_VERSION}\n`);
    writeFileSync(join(proj.dir, ".aidlc-version"), `${AIDLC_VERSION}\n`);
    return proj;
  }

  test("unpinning while work is open is done and says to finish the update", () => {
    const proj = pinnedAwayFromMachine(true);
    const result = config(proj, ["--unpin"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Removed this project's AI-DLC version pin; it now follows the active machine version.");
    expect(result.output).toContain(FINISH);
    expect(result.output).not.toContain("refusing");
    expect(existsSync(join(proj.dir, ".aidlc-version"))).toBe(false);
  });

  test("with no workflow running, an unpin says nothing more", () => {
    const proj = pinnedAwayFromMachine(false);
    const result = config(proj, ["--unpin"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain(FINISH);
  });

  test("an unpin to the version the files are from says nothing more", () => {
    const proj = project(true);
    writeFileSync(join(proj.installRoot, "active-version"), `${AIDLC_VERSION}\n`);
    writeFileSync(join(proj.dir, ".aidlc-version"), `${AIDLC_VERSION}\n`);
    const result = config(proj, ["--unpin"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain(FINISH);
  });

  test("files that did not record their version, or harnesses on different versions, say to finish too", () => {
    for (const prepare of [dropStamp, (dir: string) => addKiro(dir, OTHER_VERSION)]) {
      const proj = project(true);
      prepare(proj.dir);
      writeFileSync(join(proj.installRoot, "active-version"), `${AIDLC_VERSION}\n`);
      writeFileSync(join(proj.dir, ".aidlc-version"), `${AIDLC_VERSION}\n`);
      const result = config(proj, ["--unpin"]);
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(FINISH);
    }
  });

  test("a pin while work is open is never refused, and its dry run plans it the usual way", () => {
    const proj = project(true);
    for (const args of [["--pin", OTHER_VERSION], ["--pin", OTHER_VERSION, "--dry-run"], ["--pin", AIDLC_VERSION]]) {
      expect(config(proj, args).output).not.toContain("refusing to switch this project");
    }
  });
});
