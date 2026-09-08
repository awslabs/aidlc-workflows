// covers: subcommand:aidlc-utility:doctor (disableAllHooks detection)
//
// Issue #802: during a workshop a regulated-industry customer had hooks
// disabled by IT policy (`"disableAllHooks": true`). `/aidlc --doctor` reported
// every check green, yet the workflow was blocked at runtime because no hook
// could fire. Doctor only verified the hook FILES were present and wired — it
// never checked that Claude Code was allowed to RUN them. This pins the new
// "Hooks enabled" row: it must FAIL loudly (exit non-zero) when a resolved
// `disableAllHooks: true` is present, follow Claude Code's layer precedence so
// a higher-precedence `false` suppresses a lower `true`, and pass otherwise.

import { describe, expect, test, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { resolveManagedSettingsCandidates } from "../../core/tools/aidlc-utility.ts";

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

// Merge a patch into the project's copied .claude/settings.json so the base
// shipped hook wiring stays intact (we only toggle disableAllHooks).
function patchProjectSettings(proj: string, patch: Record<string, unknown>): void {
  const path = join(proj, ".claude", "settings.json");
  const current = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
}

function writeFile(proj: string, rel: string, content: string): void {
  writeFileSync(join(proj, rel), content, "utf-8");
}

// Path the injectable managed-settings seam points at during tests. Kept under
// the project so the host's real managed-settings file can never leak into a
// result; a test writes here to simulate an enterprise managed policy.
function managedPath(proj: string): string {
  return join(proj, ".claude", "managed-settings.json");
}

function createUserHome(): string {
  const home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-user-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  created.push(home);
  return home;
}

function writeUserSettings(home: string, settings: Record<string, unknown>): void {
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf-8",
  );
}

// Keep HOME distinct from the project so the user and project layers cannot
// collapse onto the same settings.json. The managed layer is also pinned to a
// fixture path rather than the host's real enterprise policy.
function runDoctor(
  proj: string,
  userHome = join(proj, ".test-user-home"),
): { status: number; out: string } {
  const res = spawnSync(BUN, [UTIL, "doctor", "--verbose", "--project-dir", proj], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      AIDLC_MANAGED_SETTINGS_PATH: managedPath(proj),
    },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

describe("t324 doctor disableAllHooks gate", () => {
  test("a clean install passes the Hooks-enabled row", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    const { out } = runDoctor(proj);
    expect(out).toMatch(/Hooks enabled \(resolved disableAllHooks is not true\)/);
    expect(out).not.toMatch(/Hooks DISABLED/);
  });

  test("disableAllHooks:true in .claude/settings.json fails loudly and exits non-zero", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    patchProjectSettings(proj, { disableAllHooks: true });
    const { status, out } = runDoctor(proj);
    expect(out).toMatch(/Hooks DISABLED/);
    expect(out).toMatch(/\.claude\/settings\.json/);
    // The remedy explains the engine is hook-driven, not a cosmetic warning.
    expect(out).toMatch(/hook-driven/);
    expect(status).not.toBe(0);
  });

  test("disableAllHooks:false is not flagged (explicit enable)", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    patchProjectSettings(proj, { disableAllHooks: false });
    const { out } = runDoctor(proj);
    expect(out).toMatch(/Hooks enabled/);
    expect(out).not.toMatch(/Hooks DISABLED/);
  });

  test("settings.local.json disableAllHooks:true fails even when settings.json is silent", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    writeFile(proj, ".claude/settings.local.json", JSON.stringify({ disableAllHooks: true }, null, 2));
    const { status, out } = runDoctor(proj);
    expect(out).toMatch(/Hooks DISABLED/);
    expect(out).toMatch(/settings\.local\.json/);
    expect(status).not.toBe(0);
  });

  test("higher-precedence settings.local.json:false SUPPRESSES a lower settings.json:true", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    patchProjectSettings(proj, { disableAllHooks: true });
    writeFile(proj, ".claude/settings.local.json", JSON.stringify({ disableAllHooks: false }, null, 2));
    const { out } = runDoctor(proj);
    // The local layer wins → hooks are enabled → no disabled warning.
    expect(out).toMatch(/Hooks enabled/);
    expect(out).not.toMatch(/Hooks DISABLED/);
  });

  test("disableAllHooks:true in user settings fails and names the user layer", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    const home = createUserHome();
    writeUserSettings(home, { disableAllHooks: true });
    const { status, out } = runDoctor(proj, home);
    expect(out).toMatch(/Hooks DISABLED/);
    expect(out).toMatch(/~\/\.claude\/settings\.json/);
    expect(status).not.toBe(0);
  });

  test("project settings:false SUPPRESSES lower-precedence user settings:true", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    const home = createUserHome();
    writeUserSettings(home, { disableAllHooks: true });
    patchProjectSettings(proj, { disableAllHooks: false });
    const { out } = runDoctor(proj, home);
    expect(out).toMatch(/Hooks enabled/);
    expect(out).not.toMatch(/Hooks DISABLED/);
  });

  // Managed-settings is the realistic IT-policy vector for issue #802 (reported
  // on Windows). The managed layer is read from the injectable seam, so this
  // covers the managed channel on any host platform.
  test("disableAllHooks:true in enterprise managed settings fails and is attributed to the managed layer", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    writeFileSync(managedPath(proj), JSON.stringify({ disableAllHooks: true }, null, 2), "utf-8");
    const { status, out } = runDoctor(proj);
    expect(out).toMatch(/Hooks DISABLED/);
    expect(out).toMatch(/enterprise managed settings/);
    expect(status).not.toBe(0);
    // The remedy must NOT tell the user to override a managed policy from a
    // local layer — managed settings is the highest-precedence layer.
    expect(out).not.toMatch(/set it to false in a higher-precedence layer/);
    expect(out).toMatch(/IT policy must remove it/);
  });

  test("managed settings is highest precedence: managed:false SUPPRESSES a project settings.json:true", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    patchProjectSettings(proj, { disableAllHooks: true });
    writeFileSync(managedPath(proj), JSON.stringify({ disableAllHooks: false }, null, 2), "utf-8");
    const { out } = runDoctor(proj);
    expect(out).toMatch(/Hooks enabled/);
    expect(out).not.toMatch(/Hooks DISABLED/);
  });

  test("managed-settings.d fragments resolve alphabetically inside the managed layer", () => {
    const proj = setupIntegrationProject();
    created.push(proj);
    writeFileSync(
      managedPath(proj),
      JSON.stringify({ disableAllHooks: true }, null, 2),
      "utf-8",
    );
    mkdirSync(join(proj, ".claude", "managed-settings.d"), {
      recursive: true,
    });
    writeFileSync(
      join(proj, ".claude", "managed-settings.d", "20-enable.json"),
      JSON.stringify({ disableAllHooks: false }, null, 2),
      "utf-8",
    );

    const { out } = runDoctor(proj);
    expect(out).toMatch(/Hooks enabled/);
    expect(out).not.toMatch(/Hooks DISABLED/);
  });
});

// Pin the managed-settings path resolver for EVERY platform without needing a
// host of that OS — the deterministic equivalent of booting a real Windows box.
// Paths are verified against Claude Code's own settings docs
// (code.claude.com/docs/en/settings): Windows moved to %ProgramFiles%\ClaudeCode\
// (legacy %PROGRAMDATA% unsupported since v2.1.75), macOS uses
// /Library/Application Support/ClaudeCode/, Linux and WSL use /etc/claude-code/.
describe("t324 resolveManagedSettingsCandidates (per-platform paths)", () => {
  test("Windows probes Program Files first, then legacy ProgramData", () => {
    const paths = resolveManagedSettingsCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      PROGRAMDATA: "C:\\ProgramData",
    });
    expect(paths).toEqual([
      "C:\\Program Files\\ClaudeCode\\managed-settings.json",
      "C:\\ProgramData\\ClaudeCode\\managed-settings.json",
    ]);
    // Program Files (supported) must outrank ProgramData (legacy).
    expect(paths[0]).toContain("Program Files");
  });

  test("Windows falls back to default roots when env vars are unset", () => {
    const paths = resolveManagedSettingsCandidates("win32", {});
    expect(paths[0]).toBe("C:\\Program Files\\ClaudeCode\\managed-settings.json");
    expect(paths[1]).toBe("C:\\ProgramData\\ClaudeCode\\managed-settings.json");
  });

  test("macOS uses the Application Support path", () => {
    expect(resolveManagedSettingsCandidates("darwin", {})).toEqual([
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    ]);
  });

  test("Linux (and WSL) use /etc/claude-code", () => {
    expect(resolveManagedSettingsCandidates("linux", {})).toEqual([
      "/etc/claude-code/managed-settings.json",
    ]);
  });

  test("AIDLC_MANAGED_SETTINGS_PATH overrides the platform default on every OS", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(
        resolveManagedSettingsCandidates(platform, {
          AIDLC_MANAGED_SETTINGS_PATH: "/custom/managed-settings.json",
        }),
      ).toEqual(["/custom/managed-settings.json"]);
    }
  });
});
