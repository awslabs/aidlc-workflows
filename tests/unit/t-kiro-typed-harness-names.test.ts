// covers: tool:aidlc-init, function:typedHarnessName, function:harnessIdFromTyped, function:harnessArgsAsIds
//
// What a person types after --harness for the two Kiro harnesses: `kiro` is
// Kiro (Kiro IDE and Kiro CLI v3, the `kiro-ide` tree) and `kiro-v2` is Kiro
// CLI (V2) (the `kiro` tree). Installed projects keep the ids they record, so
// a refresh keeps whichever tree a project has; `--harness kiro` on a Kiro CLI
// (V2) project is the in-place switch to Kiro, asked first at a terminal
// (unless a dry run's --plan-token already approves its plan) and said once
// otherwise, in --quiet and in the --json result too. A copied tool's hand-off carries ids, read as ids by
// every release.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessArgsAsIds, harnessIdFromTyped, typedHarnessName } from "../../core/tools/aidlc-runtime-paths.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const temporary: string[] = [];
// Both Kiro trees of this release in one runtime/ folder, so --harness alone picks the tree.
const RELEASE = join(mkdtempSync(join(realpathSync(tmpdir()), "aidlc-kiro-typed-release-")), "runtime");
temporary.push(dirname(RELEASE));
for (const tree of ["kiro", "kiro-ide"]) cpSync(join(REPO_ROOT, "dist-release", tree), join(RELEASE, tree), { recursive: true });
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function project(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-kiro-typed-"));
  temporary.push(dir, `${dir}-kiro-home`);
  expect(spawnSync("git", ["init", "-q", dir]).status).toBe(0);
  return dir;
}

function config(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): { status: number; out: string; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [
    INIT, "config", "--project-dir", dir, "--from", RELEASE, "--mcp", "none", ...args,
  ], {
    cwd: dir,
    encoding: "utf-8",
    timeout: NATIVE_STARTUP_TIMEOUT_MS,
    // The person's Kiro home and Kiro CLI settings are never read or written.
    env: { ...process.env, AIDLC_TEST_NAME: process.env.AIDLC_TEST_NAME ?? "t-kiro-typed-harness-names", KIRO_HOME: `${dir}-kiro-home`, ...env },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const stamp = (dir: string): string =>
  JSON.parse(readFileSync(join(dir, ".kiro", "tools", "data", "aidlc-stamp.json"), "utf-8")).distribution;

describe("Kiro harness names a person types", () => {
  test("the typed names map to the ids installed projects keep, both ways", () => {
    expect(harnessIdFromTyped("kiro")).toBe("kiro-ide");
    expect(harnessIdFromTyped("kiro-v2")).toBe("kiro");
    expect(harnessIdFromTyped("kiro-ide")).toBe("kiro-ide");
    expect(harnessIdFromTyped("claude")).toBe("claude");
    expect(typedHarnessName("kiro-ide")).toBe("kiro");
    expect(typedHarnessName("kiro")).toBe("kiro-v2");
    expect(harnessArgsAsIds(["config", "--harness", "kiro", "--project-dir", "kiro"]))
      .toEqual(["config", "--harness", "kiro-ide", "--project-dir", "kiro"]);
  });

  test("--harness kiro sets up Kiro, --harness kiro-v2 Kiro CLI (V2), and --harness kiro-ide still Kiro", () => {
    for (const [typed, id] of [["kiro", "kiro-ide"], ["kiro-v2", "kiro"], ["kiro-ide", "kiro-ide"]] as const) {
      const dir = project();
      const setup = config(dir, ["--harness", typed, "--yes"]);
      expect(setup.status, `${typed}: ${setup.out}`).toBe(0);
      expect(stamp(dir), typed).toBe(id);
    }
  });

  test("on a Kiro CLI (V2) project a refresh keeps it, and --harness kiro asks first at a terminal, then switches", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const refresh = config(dir, ["--yes"]);
    expect(refresh.status, refresh.out).toBe(0);
    expect(stamp(dir)).toBe("kiro");

    const declined = config(dir, ["--harness", "kiro"], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" });
    expect(declined.out).toContain(
      "This project is set up for Kiro CLI (V2). `--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3). Switch .kiro to Kiro in place? [y/N]:",
    );
    expect(declined.out).toContain("nothing changed; .kiro stays on Kiro CLI (V2)");
    expect(declined.out).toContain("config --harness kiro-v2");
    expect(declined.status).toBe(2);
    expect(stamp(dir)).toBe("kiro");

    // A second answer for setup's own check, which asks only where the hook PATH lacks aidlc (as on CI).
    const switched = config(dir, ["--harness", "kiro"], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "y\nn\n" });
    expect(switched.status, switched.out).toBe(0);
    expect(switched.out).toContain("switched .kiro in place from kiro-v2 to kiro (aidlc/ kept)");
    expect(stamp(dir)).toBe("kiro-ide");
  });

  test("--harness kiro --yes on a Kiro CLI (V2) project says once what it does and how to stay, then switches", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const switched = config(dir, ["--harness", "kiro", "--yes"]);
    expect(switched.status, switched.out).toBe(0);
    const note = "`--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3), so on a Kiro CLI (V2) project like this one it means " +
      "switching .kiro to Kiro in place; to keep Kiro CLI (V2), run `";
    expect(switched.out.split(note).length - 1).toBe(1);
    expect(switched.out).toMatch(/to keep Kiro CLI \(V2\), run `[^`]* config --harness kiro-v2[^`]*` instead\./);
    expect(stamp(dir)).toBe("kiro-ide");
  });

  test("with --quiet the switch still says once what it does", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const switched = config(dir, ["--harness", "kiro", "--yes", "--quiet"]);
    expect(switched.status, switched.out).toBe(0);
    expect(switched.out).toContain("Warning: `--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3), so on a Kiro CLI (V2) project like this one it means switching .kiro");
    expect(stamp(dir)).toBe("kiro-ide");
  });

  test("the question comes before any check of the switch can refuse it", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    // A switch refuses a hooks folder that is a file; the person who meant a refresh hears about the name first.
    rmSync(join(dir, ".kiro", "hooks"), { recursive: true, force: true });
    writeFileSync(join(dir, ".kiro", "hooks"), "not a folder\n");
    const declined = config(dir, ["--harness", "kiro"], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" });
    expect(declined.out).toContain("`--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3)");
    expect(declined.out).toContain("nothing changed; .kiro stays on Kiro CLI (V2)");
    expect(declined.out).not.toContain("cannot switch");
    expect(stamp(dir)).toBe("kiro");
  });

  test("with --yes a switch check that refuses still says the name changed", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    rmSync(join(dir, ".kiro", "hooks"), { recursive: true, force: true });
    writeFileSync(join(dir, ".kiro", "hooks"), "not a folder\n");
    const refused = config(dir, ["--harness", "kiro", "--yes"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("cannot switch .kiro to kiro: .kiro/hooks is a link or a file, not a directory");
    expect(refused.out).toContain("`--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3)");
    expect(stamp(dir)).toBe("kiro");
  });

  test("with --json a switch check that refuses carries the note in the result's data, and stdout and stderr together stay one JSON value", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    rmSync(join(dir, ".kiro", "hooks"), { recursive: true, force: true });
    writeFileSync(join(dir, ".kiro", "hooks"), "not a folder\n");
    const refused = config(dir, ["--harness", "kiro", "--yes", "--json"]);
    expect(refused.status).not.toBe(0);
    const result = JSON.parse(refused.stdout) as { message?: string; data?: { notes?: string[] } };
    expect(result.message).toContain("cannot switch .kiro to kiro: .kiro/hooks is a link or a file, not a directory");
    expect(result.message).not.toContain("now means Kiro");
    expect(result.data?.notes?.join("\n")).toContain("to keep Kiro CLI (V2), run `");
    expect(refused.stderr).not.toContain("now means Kiro");
  });

  test("with --json every refusal carries the note, the unowned-hook approval included", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    writeFileSync(join(dir, ".kiro", "hooks", "team-check.json"), "{}\n");
    const refused = config(dir, ["--harness", "kiro", "--yes", "--json"]);
    expect(refused.status).toBe(4);
    const result = JSON.parse(refused.stdout) as { message?: string; data?: { notes?: string[] } };
    expect(result.message).toContain("lets Kiro run hook files AI-DLC does not own");
    expect(result.data?.notes?.join("\n")).toContain("`--harness kiro` now means Kiro (Kiro IDE and Kiro CLI v3)");
    expect(stamp(dir)).toBe("kiro");
  });

  test("applying a dry run's --plan-token at a terminal does not ask again", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const planned = config(dir, ["--harness", "kiro", "--dry-run", "--json"]);
    expect(planned.status, planned.out).toBe(0);
    const token = (JSON.parse(planned.stdout) as { data: { planToken: string } }).data.planToken;
    // The one answer is for setup's own check, which asks only where the hook PATH lacks aidlc (as on CI).
    const applied = config(dir, ["--harness", "kiro", "--plan-token", token], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "n\n" });
    expect(applied.status, applied.out).toBe(0);
    expect(applied.out).not.toContain("[y/N]");
    expect(stamp(dir)).toBe("kiro-ide");
  });

  test("a --plan-token from another plan at a terminal leaves Kiro CLI (V2) in place", () => {
    const dir = project();
    expect(config(dir, ["--harness", "kiro-v2", "--yes"]).status).toBe(0);
    const refresh = config(dir, ["--harness", "kiro-v2", "--dry-run", "--json"]);
    const token = (JSON.parse(refresh.stdout) as { data: { planToken: string } }).data.planToken;
    const applied = config(dir, ["--harness", "kiro", "--plan-token", token], { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_TEST_CONFIG_INPUT: "" });
    expect(applied.status).not.toBe(0);
    expect(applied.out).toContain("config plan changed after approval");
    expect(stamp(dir)).toBe("kiro");
  });

  test("a copied tool's hand-off is read in ids: --harness kiro there is Kiro CLI (V2)", () => {
    const dir = project();
    const handed = config(dir, ["--harness", "kiro", "--yes"], { AIDLC_CONFIG_HANDOFF: join(dir, ".kiro", "tools", "aidlc.ts") });
    expect(handed.status, handed.out).toBe(0);
    expect(stamp(dir)).toBe("kiro");
  });
});
