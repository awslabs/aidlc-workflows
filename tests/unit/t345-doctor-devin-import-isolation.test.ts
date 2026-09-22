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
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  DEVIN_IMPORT_EXPECTED,
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

// The user layer is ALWAYS redirected to a scratch XDG dir so the
// contributor's real ~/.config/devin/config.json can never participate.
function runDoctor(
  proj: string,
  userConfig?: Record<string, unknown>,
): DoctorRow[] {
  const xdg = mkdtempSync(join(tmpdir(), "t345-xdg-"));
  created.push(xdg);
  if (userConfig !== undefined) {
    mkdirSync(join(xdg, "devin"), { recursive: true });
    writeFileSync(
      join(xdg, "devin", "config.json"),
      JSON.stringify(userConfig, null, 2),
      "utf-8",
    );
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
        APPDATA: join(xdg, "appdata"),
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

  test("user config with zed:true warns naming zed (user layer overrides project)", () => {
    const proj = setupDevinInstall();
    const rows = runDoctor(proj, { read_config_from: { zed: true } });
    const row = rows.find((r) => r.label.includes("user"));
    expect(row).toBeDefined();
    expect(row!.pass).toBe(false);
    expect(row!.severity).toBe("warn");
    expect(row!.label).toContain("enables `zed`");
    expect(row!.label).toContain("user layer overrides the project file");
    expect(row!.fix).toContain("devin skills list");
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
