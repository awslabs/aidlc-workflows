// covers: subcommand:aidlc-utility:doctor, function:auditDevinImportConfig, function:userDevinConfigPath
//
// t345-doctor-devin-import-isolation: pins the two advisory doctor rows for
// Devin's `read_config_from` compatibility imports (PR #996 Item 6).
//
//   - The PROJECT row audits .devin/config.json: every documented import
//     source must be an explicit boolean; a missing or non-false
//     non-agents_standard key warns and names the keys Devin then imports
//     (the shipped three-key block leaks copilot/opencode/zed; null = true).
//   - The USER row audits the user-level config.json (XDG_CONFIG_HOME /
//     APPDATA resolved): on tested builds the user layer OVERRIDES the project
//     file for this setting, so a user-level `true` warns even when the
//     project ships the full seven-key block. Absent user file = pass, so the
//     row count is stable.
//
// No Devin binary involved — both rows are pure file reads.

import { describe, expect, test, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  DEVIN_IMPORT_EXPECTED,
  devinUserLayerOverridesProject,
  userDevinConfigPath,
} from "../../core/tools/aidlc-devin-config.ts";

const BUN = process.execPath;
const DEVIN_ROOT = join(REPO_ROOT, "dist", "devin");
const PROJECT_LABEL = "Devin compatibility imports:";
const OLD_THREE_KEY = { cursor: false, windsurf: false, claude: false };

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

function setupDevinInstall(): string {
  const proj = mkdtempSync(join(tmpdir(), "t345-devin-doctor-"));
  created.push(proj);
  const project = join(proj, "project");
  cpSync(DEVIN_ROOT, project, { recursive: true });
  return project;
}

function patchProjectConfig(
  proj: string,
  readConfigFrom: Record<string, unknown> | undefined,
): void {
  const path = join(proj, ".devin", "config.json");
  const config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  if (readConfigFrom === undefined) delete config.read_config_from;
  else config.read_config_from = readConfigFrom;
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

interface DoctorRow {
  pass: boolean;
  severity?: string;
  label: string;
  fix?: string;
}

// A fake devin CLI keeps the spawned doctor hermetic: checkDevinVersion()
// resolves `devin` through the child's PATH and runs `<bin> --version`, so
// a shim first on PATH decides the version-aware user row deterministically
// (same mechanism as t331 9d). `devinVersion` of "none" hides the binary by
// running on a PATH that holds only Bun's own directory.
function devinShim(root: string, version: string | "none"): string {
  if (version === "none") return join(BUN, "..") + delimiter;
  const dir = join(root, "bin");
  mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, "devin.cmd"),
      `@echo off\r\necho devin ${version} (t345-shim)\r\n`,
    );
  } else {
    writeFileSync(
      join(dir, "devin"),
      `#!/bin/sh\necho "devin ${version} (t345-shim)"\n`,
      { mode: 0o755 },
    );
  }
  return `${dir}${delimiter}${process.env.PATH ?? ""}`;
}

// The user layer is ALWAYS redirected to a scratch XDG dir so the
// contributor's real ~/.config/devin/config.json can never participate.
function runDoctor(
  proj: string,
  userConfig?: Record<string, unknown>,
  devinVersion: string | "none" = "none",
): DoctorRow[] {
  const xdg = mkdtempSync(join(tmpdir(), "t345-xdg-"));
  created.push(xdg);
  const appData = join(xdg, "appdata");
  if (userConfig !== undefined) {
    const userPath = userDevinConfigPath(
      { XDG_CONFIG_HOME: xdg, APPDATA: appData },
      process.platform,
    );
    mkdirSync(join(userPath, ".."), { recursive: true });
    writeFileSync(userPath, JSON.stringify(userConfig, null, 2), "utf-8");
  }
  const r = spawnSync(
    BUN,
    [join(proj, ".devin", "tools", "aidlc-doctor.ts"), "--json", "--offline", "--project-dir", proj],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_HARNESS_DIR: ".devin",
        XDG_CONFIG_HOME: xdg,
        APPDATA: appData,
        PATH: devinShim(proj, devinVersion),
      },
    },
  );
  // Exit status is not asserted: a warn row must not fail doctor, and a
  // deliberately unparsable config.json may fail other checks — the JSON
  // envelope's check rows are the observable under test.
  const envelope = JSON.parse(r.stdout) as { data: { checks: DoctorRow[] } };
  return envelope.data.checks.filter((row) => row.label.startsWith(PROJECT_LABEL));
}

describe("t345 doctor Devin read_config_from import-isolation rows", () => {
  test("shipped seven-key block: project row passes, user row passes (no user file)", () => {
    const proj = setupDevinInstall();
    const rows = runDoctor(proj);
    const project = rows.filter((r) => r.label.includes(".devin/config.json"));
    const user = rows.filter((r) => r.label.includes("user-level"));
    expect(project).toHaveLength(1);
    expect(project[0]!.pass).toBe(true);
    expect(project[0]!.label).toContain("all 7 documented sources");
    expect(user).toHaveLength(1);
    expect(user[0]!.pass).toBe(true);
    expect(user[0]!.label).toBe(
      "Devin compatibility imports: no user-level read_config_from override",
    );
  });

  test("old three-key block: project row warns naming exactly copilot, opencode, zed", () => {
    const proj = setupDevinInstall();
    patchProjectConfig(proj, OLD_THREE_KEY);
    const rows = runDoctor(proj);
    const row = rows.find((r) => r.label.includes(".devin/config.json"));
    expect(row).toBeDefined();
    expect(row!.pass).toBe(false);
    expect(row!.severity).toBe("warn");
    expect(row!.label).toContain("`copilot`, `opencode`, `zed`");
    expect(row!.label).not.toContain("`cursor`");
    expect(row!.fix).toContain("/devin:aidlc");
  });

  test("a null value reads as enabled: copilot:null warns naming copilot", () => {
    const proj = setupDevinInstall();
    patchProjectConfig(proj, { ...DEVIN_IMPORT_EXPECTED, copilot: null });
    const rows = runDoctor(proj);
    const row = rows.find((r) => r.label.includes(".devin/config.json"));
    expect(row!.pass).toBe(false);
    expect(row!.severity).toBe("warn");
    expect(row!.label).toContain("`copilot`");
    expect(row!.label).not.toContain("`zed`");
  });

  test("unreadable project config.json emits no project row (presence row covers it)", () => {
    const proj = setupDevinInstall();
    writeFileSync(join(proj, ".devin", "config.json"), "not-json", "utf-8");
    const rows = runDoctor(proj);
    expect(rows.filter((r) => r.label.includes(".devin/config.json"))).toHaveLength(0);
  });

  test("user config with zed:true warns naming zed (no devin on PATH: user layer may override)", () => {
    const proj = setupDevinInstall();
    const rows = runDoctor(proj, { read_config_from: { zed: true } });
    const row = rows.find((r) => r.label.includes("user"));
    expect(row).toBeDefined();
    expect(row!.pass).toBe(false);
    expect(row!.severity).toBe("warn");
    expect(row!.label).toContain("enables `zed`");
    expect(row!.label).toContain("before 3000.11.92 the user config overrides the project file");
    expect(row!.fix).toContain("devin skills list");
  });

  test("user config with claude:true on 3000.11.3 warns, and names the Claude hook side effect", () => {
    const proj = setupDevinInstall();
    const rows = runDoctor(
      proj,
      { read_config_from: { claude: true } },
      "3000.11.3",
    );
    const row = rows.find((r) => r.label.includes("user"));
    expect(row).toBeDefined();
    expect(row!.pass).toBe(false);
    expect(row!.severity).toBe("warn");
    expect(row!.label).toContain("enables `claude`");
    expect(row!.label).toContain("before 3000.11.92");
    expect(row!.label).toContain("hooks");
  });

  test("user config with claude:true on 3000.11.92 passes — a project `false` wins there", () => {
    const proj = setupDevinInstall();
    const rows = runDoctor(
      proj,
      { read_config_from: { claude: true } },
      "3000.11.92",
    );
    const row = rows.find((r) => !r.label.includes(".devin/config.json"));
    expect(row).toBeDefined();
    expect(row!.pass).toBe(true);
    expect(row!.label).toContain("enables `claude`");
    expect(row!.label).toContain("project `false` wins");
  });

  test("user config that sets nothing import-related passes as 'no user-level override'", () => {
    const proj = setupDevinInstall();
    const rows = runDoctor(proj, { permissions: { allow: [] } });
    const row = rows.find((r) => r.label.includes("user"));
    expect(row!.pass).toBe(true);
    expect(row!.label).toBe(
      "Devin compatibility imports: no user-level read_config_from override",
    );
  });
});

describe("t345 devinUserLayerOverridesProject (per-build read_config_from precedence)", () => {
  test("unknown version keeps the old precedence (override possible)", () => {
    expect(devinUserLayerOverridesProject(null)).toBe(true);
  });
  test("below 3000.11.92 the user layer overrides", () => {
    expect(devinUserLayerOverridesProject([3000, 11, 3])).toBe(true);
    expect(devinUserLayerOverridesProject([3000, 11, 91])).toBe(true);
  });
  test("from 3000.11.92 a project `false` wins at every layer", () => {
    expect(devinUserLayerOverridesProject([3000, 11, 92])).toBe(false);
    expect(devinUserLayerOverridesProject([3001, 0, 0])).toBe(false);
  });
});

describe("t345 userDevinConfigPath (per-platform user config resolution)", () => {
  test("linux honours XDG_CONFIG_HOME", () => {
    expect(
      userDevinConfigPath({ XDG_CONFIG_HOME: "/scratch/xdg" }, "linux"),
    ).toBe(join("/scratch/xdg", "devin", "config.json"));
  });
  test("linux falls back to ~/.config", () => {
    expect(userDevinConfigPath({}, "linux")).toContain(
      join(".config", "devin", "config.json"),
    );
  });
  test("win32 uses APPDATA", () => {
    expect(
      userDevinConfigPath({ APPDATA: "C:\\AppData\\Roaming" }, "win32"),
    ).toBe(join("C:\\AppData\\Roaming", "devin", "config.json"));
  });
});
