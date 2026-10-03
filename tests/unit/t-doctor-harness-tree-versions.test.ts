// covers: function:activeWorkflowDescriptions
//
// #1406: a project ended with `.kiro` on 2.9.0 and `.claude` on 2.10.0, and
// doctor's multi-harness row said `ok` without reading either tree's stamp.
// Doctor now names each tree's release when they differ and gives commands that
// run as printed: natively `aidlc config --harness <name>` for each tree not on
// the engine's release; on a copied project the newest tree's tool refreshes
// the others from that release's copy runtime, after one `--download` refresh
// for a tree no config run recorded. While a workflow runs, config refuses the
// refresh, so the line says which tool to continue in and to run the commands
// after the workflow completes.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { activeWorkflowDescriptions } from "../../core/tools/aidlc-lib.ts";
import { copyRuntimeUrl } from "../../core/tools/aidlc-release.ts";
import { quoteCommandArgument } from "../../core/tools/aidlc-runtime-paths.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { harnessTreeVersionsCheck as copiedCheck } from "../../dist/claude/.claude/tools/aidlc-utility.ts";
import { harnessTreeVersionsCheck as nativeCheck } from "../../dist-release/claude/.claude/tools/aidlc-utility.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const created: string[] = [];
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-tree-versions-"));
  created.push(dir);
  return dir;
}

// A harness tree as a release stamps it; `version: null` is a tree from before
// stamps, which records no release.
function tree(dir: string, distribution: string, version: string | null, baseline = true): void {
  const harnessDir = `.${distribution}`;
  const data = join(dir, harnessDir, "tools", "data");
  mkdirSync(data, { recursive: true });
  if (version === null) {
    writeFileSync(join(data, "harness.json"), `${JSON.stringify({ harnessDir, rulesSubdir: "rules" })}\n`);
  } else {
    writeFileSync(
      join(data, "aidlc-stamp.json"),
      `${JSON.stringify({ schemaVersion: 1, frameworkVersion: version, distribution, harnessDir })}\n`,
    );
  }
  if (baseline) writeFileSync(join(data, "aidlc-manifest.json"), "{}\n");
}

function intent(dir: string, name: string, registry: string, state: string, space = "default"): void {
  const intents = join(dir, "aidlc", "spaces", space, "intents");
  mkdirSync(join(intents, name), { recursive: true });
  const registryPath = join(intents, "intents.json");
  let rows: unknown[] = [];
  try {
    rows = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch {
    // First intent in this space.
  }
  rows.push({ uuid: `deadbeef-0000-4000-8000-${String(rows.length).padStart(12, "0")}`, slug: name, dirName: name, scope: "poc", status: registry });
  writeFileSync(registryPath, `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(
    join(intents, name, "aidlc-state.md"),
    `# AI-DLC State Tracking\n\n## Current Status\n- **Status**: ${state}\n`,
  );
}

// Doctor renders commands for the shell it runs in: from the project they need
// no --project-dir.
function fromProject<T>(dir: string, run: () => T): T {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return run();
  } finally {
    process.chdir(cwd);
  }
}

describe("active workflows (the refresh guard's list)", () => {
  test("lists every space's running intents and skips completed and archived ones", () => {
    const dir = project();
    intent(dir, "running", "in-flight", "Running");
    intent(dir, "done-row", "complete", "Running");
    intent(dir, "shelved", "archived", "Running");
    intent(dir, "done-state", "in-flight", "Completed");
    intent(dir, "other", "in-flight", "Running", "teamb");
    expect(activeWorkflowDescriptions(dir).sort()).toEqual(["default/running", "teamb/other"]);
  });
});

describe("doctor compares the harness trees' releases (#1406)", () => {
  test("one tree, or trees on one release with no workflow, add no row", () => {
    const dir = project();
    tree(dir, "claude", "2.10.0");
    expect(nativeCheck(dir)).toBeNull();
    tree(dir, "kiro", "2.10.0");
    expect(nativeCheck(dir)).toBeNull();
  });

  test("trees on one release with a workflow keep the advisory row and name the release", () => {
    const dir = project();
    tree(dir, "claude", "2.10.0");
    tree(dir, "kiro", "2.10.0");
    intent(dir, "probe", "in-flight", "Running");
    expect(nativeCheck(dir)).toEqual({
      pass: true,
      label:
        "Multi-harness install detected (.claude + .kiro, all on 2.10.0) with an active workflow - supported but untested; keep all trees at the same framework version",
    });
  });

  test("natively, the tree off the engine's release is named and refreshed with one command", () => {
    const dir = project();
    tree(dir, "claude", AIDLC_VERSION);
    tree(dir, "kiro", "2.9.0");
    const check = fromProject(dir, () => nativeCheck(dir));
    expect(check).toEqual({
      pass: false,
      severity: "warn",
      label:
        `Harness trees on different releases: Claude Code (.claude) ${AIDLC_VERSION}, Kiro CLI (.kiro) 2.9.0 - a workflow can behave differently depending on which tool runs it`,
      fix: "run `aidlc config --harness kiro`",
    });
  });

  test("natively, while a workflow runs, the line names the tool to continue in and waits for it", () => {
    const dir = project();
    tree(dir, "claude", AIDLC_VERSION);
    tree(dir, "kiro", "2.9.0");
    intent(dir, "probe", "in-flight", "Running");
    expect(fromProject(dir, () => nativeCheck(dir))?.fix).toBe(
      `continue default/probe in Claude Code, whose files are on ${AIDLC_VERSION}; after it completes, run \`aidlc config --harness kiro\``,
    );
  });

  test("natively, with no tree on the engine's release, every tree is refreshed after the workflows", () => {
    const dir = project();
    tree(dir, "claude", "2.8.0");
    tree(dir, "kiro", "2.9.0");
    intent(dir, "one", "in-flight", "Running");
    intent(dir, "two", "in-flight", "Running");
    expect(fromProject(dir, () => nativeCheck(dir))?.fix).toBe(
      "after default/one, default/two complete, run `aidlc config --harness claude`, then `aidlc config --harness kiro`",
    );
  });

  test("from outside the project every command names it", () => {
    const dir = project();
    tree(dir, "claude", AIDLC_VERSION);
    tree(dir, "kiro", "2.9.0");
    expect(fromProject(REPO_ROOT, () => nativeCheck(dir))?.fix).toBe(
      `run \`aidlc config --harness kiro --project-dir ${quoteCommandArgument(dir)}\``,
    );
  });

  test("on a copied project, the newest tree's tool refreshes the others from its release", () => {
    const dir = project();
    tree(dir, "claude", "2.10.1");
    tree(dir, "kiro", "2.10.1-preview.20261003.1");
    const check = fromProject(dir, () => copiedCheck(dir));
    expect(check?.label).toBe(
      "Harness trees on different releases: Claude Code (.claude) 2.10.1, Kiro CLI (.kiro) 2.10.1-preview.20261003.1 - a workflow can behave differently depending on which tool runs it",
    );
    expect(check?.fix).toBe(
      `get ${copyRuntimeUrl("2.10.1")} and its .sha256 into one folder, then run \`bun .claude/tools/aidlc.ts config --harness kiro --from <that file>\``,
    );
  });

  test("on a copied project, a tree no config run recorded takes a refresh at its own release first", () => {
    const dir = project();
    tree(dir, "claude", "2.10.0");
    tree(dir, "kiro", "2.10.1", false);
    intent(dir, "probe", "in-flight", "Running");
    expect(fromProject(dir, () => copiedCheck(dir))?.fix).toBe(
      `continue default/probe in Kiro CLI, whose files are on 2.10.1; after it completes, get ${
        copyRuntimeUrl("2.10.1")
      } and its .sha256 into one folder, then run \`bun .kiro/tools/aidlc.ts config --harness claude --from <that file>\``,
    );
    rmSync(join(dir, ".claude", "tools", "data", "aidlc-manifest.json"));
    expect(fromProject(dir, () => copiedCheck(dir))?.fix).toContain(
      "then run `bun .kiro/tools/aidlc.ts config --harness claude --download`, then `bun .kiro/tools/aidlc.ts config --harness claude --from <that file>`",
    );
  });

  test("a tree from before stamps counts as a different release", () => {
    const dir = project();
    tree(dir, "claude", "2.10.1");
    tree(dir, "kiro", null);
    const check = fromProject(dir, () => copiedCheck(dir));
    expect(check?.label).toContain("Claude Code (.claude) 2.10.1, Kiro CLI (.kiro) with no recorded release");
    expect(check?.fix).toContain("`bun .claude/tools/aidlc.ts config --harness kiro --from <that file>`");
  });
});
