// covers: none (aidlc-init config --pin has no registry unit)
//
// #1418: `config --pin` switched the engine that serves a project at once, while
// the project's hooks and tools stayed at the version its harness tree was last
// refreshed to, and the refresh that would align them is refused while a
// workflow runs. The two then ran side by side and code generation stopped.
// A pin or unpin that would split them now waits for the workflow; pinning to
// the hooks' own version (the way back) and dry-run previews stay available.

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
  test("a pin away from the hooks' version waits, naming both versions and the next step", () => {
    const proj = project(true);
    const refused = config(proj, ["--pin", OTHER_VERSION]);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain(`refusing to switch this project to aidlc ${OTHER_VERSION} while 1 workflow(s) are active: default/pin-probe`);
    expect(refused.output).toContain(`hooks and tools are from aidlc ${AIDLC_VERSION}`);
    expect(refused.output).toContain("code generation would stop");
    expect(refused.output).toContain(`Complete the workflow, then change the pin and refresh the project; or pin to ${AIDLC_VERSION}`);
    expect(existsSync(join(proj.dir, ".aidlc-version"))).toBe(false);
  });

  test("pinning to the hooks' own version is not held back", () => {
    const proj = project(true);
    const result = config(proj, ["--pin", AIDLC_VERSION]);
    expect(result.output).not.toContain("refusing to switch this project");
  });

  test("with no workflow running, a pin to another version is not held back", () => {
    const proj = project(false);
    const result = config(proj, ["--pin", OTHER_VERSION]);
    expect(result.output).not.toContain("refusing to switch this project");
  });

  test("unpinning waits the same way when the machine version differs from the hooks", () => {
    const proj = project(true);
    writeFileSync(join(proj.installRoot, "active-version"), `${OTHER_VERSION}\n`);
    writeFileSync(join(proj.dir, ".aidlc-version"), `${AIDLC_VERSION}\n`);
    const refused = config(proj, ["--unpin"]);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain(`refusing to switch this project to aidlc ${OTHER_VERSION}`);
    expect(readFileSync(join(proj.dir, ".aidlc-version"), "utf-8")).toBe(`${AIDLC_VERSION}\n`);
  });

  test("a dry run previews and says what the real run would refuse", () => {
    const proj = project(true);
    writeFileSync(join(proj.installRoot, "active-version"), `${OTHER_VERSION}\n`);
    writeFileSync(join(proj.dir, ".aidlc-version"), `${AIDLC_VERSION}\n`);
    const preview = config(proj, ["--unpin", "--dry-run"]);
    expect(preview.status).toBe(0);
    expect(preview.output).toContain("Project pin removal plan; no files were changed.");
    expect(preview.output).toContain("Running it now would be refused: refusing to switch this project");
    expect(readFileSync(join(proj.dir, ".aidlc-version"), "utf-8")).toBe(`${AIDLC_VERSION}\n`);
  });
});
