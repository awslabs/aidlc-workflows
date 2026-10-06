// covers: tool:aidlc-init, file:core/tools/aidlc-includes.ts
//
// A copied install whose first session added AI-DLC's part to AGENTS.md or
// .gitignore keeps one AI-DLC part in each after a settings
// change made with the copy's own command, and the next refresh from a
// release goes through. Before, the settings change took the project's own
// file, markers and all, as the shipped part and wrapped it in a second pair
// of markers, so the refresh stopped with "managed markers are missing,
// duplicated, or malformed".
//
// Mechanism: cli. The copy's own aidlc.ts and the release's aidlc-init.ts run
// against a copy of each release tree, as a copy-channel person runs them.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { copyChannelOmits, projectionFiles } from "../../core/tools/aidlc-distribution.ts";
import { addRootBlocks } from "../../core/tools/aidlc-includes.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  temporary.push(path);
  return path;
}

function run(tool: string, args: string[], cwd: string): { status: number; out: string } {
  // Keep the host's active runtime out of fixture source selection.
  const machine = temp("aidlc-t-csm-machine-");
  const result = spawnSync(BUN, [tool, ...args], {
    cwd,
    env: {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
    },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("a copy keeps one AI-DLC part in each managed file after a settings change", () => {
  for (const [harness, harnessDir] of [["opencode", ".aidlc"], ["claude", ".claude"], ["kiro", ".kiro"]] as const) {
    test(`${harness}: first session, a settings change from the copy, then a refresh from a release`, () => {
      const release = join(REPO_ROOT, "dist-release", harness);
      const { descriptor } = projectionFiles(release);
      const managed = descriptor.rootIntegrations
        .filter((integration) => integration.policy === "managed-block")
        .map((integration) => integration.path);
      expect(managed.length, `${harness} ships no managed file`).toBeGreaterThan(0);
      const dir = temp(`aidlc-t-csm-${harness}-`);
      mkdirSync(join(dir, ".git"));
      // The copy runtime: the release tree without the files a copy leaves out.
      cpSync(release, dir, { recursive: true });
      for (const path of copyChannelOmits(descriptor)) rmSync(join(dir, path), { force: true });
      addRootBlocks(dir);
      const markerPairs = () =>
        managed.filter((path) => existsSync(join(dir, path))).map((path) =>
          [path, readFileSync(join(dir, path), "utf-8").match(/BEGIN AI-DLC/g)?.length ?? 0] as const
        );
      expect(markerPairs().length, `the first session wrote none of ${managed.join(", ")}`).toBeGreaterThan(0);

      const changed = run(
        join(dir, harnessDir, "tools", "aidlc.ts"),
        ["config", "models", "--project-dir", dir, "--project", "--reviewing-effort", "high", "--yes"],
        dir,
      );
      expect(changed.status, changed.out).toBe(0);
      for (const [path, pairs] of markerPairs()) expect(pairs, `${path} after the settings change`).toBe(1);

      const refreshed = run(
        INIT,
        ["config", "--project-dir", dir, "--from", release, "--harness", harness, "--mcp", "none", "--yes"],
        dir,
      );
      expect(refreshed.status, refreshed.out).toBe(0);
      expect(refreshed.out).not.toContain("managed markers");
      for (const [path, pairs] of markerPairs()) expect(pairs, `${path} after the refresh`).toBe(1);
    });
  }
});
