// covers: scripts/install.ts — interactive harness installer integration tests.
//
// Exercises the non-interactive path of scripts/install.ts against the real
// committed dist/ tree, verifying:
//   - correct files are copied per harness
//   - skip behavior when files already exist (no --force)
//   - --force overwrites existing files
//   - unknown harness errors exit non-zero
//   - --help exits 0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../..");
const INSTALL_SCRIPT = join(REPO_ROOT, "scripts", "install.ts");
const BUN = process.execPath;
const TIMEOUT_MS = 30_000;

function runInstall(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(BUN, [INSTALL_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("install.ts", () => {
  let targetDir: string;

  beforeEach(() => {
    targetDir = mkdtempSync(join(tmpdir(), "aidlc-install-test-"));
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // --help
  // -------------------------------------------------------------------------
  test("--help exits 0 and shows usage", () => {
    const { stdout, exitCode } = runInstall(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("AI-DLC Installer");
    expect(stdout).toContain("--harness");
    expect(stdout).toContain("--target");
  });

  // -------------------------------------------------------------------------
  // Unknown harness
  // -------------------------------------------------------------------------
  test("unknown harness exits 1 with error", () => {
    const { stderr, exitCode } = runInstall(["--harness", "fakecli", "--target", targetDir]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown harness");
  });

  // -------------------------------------------------------------------------
  // Kiro install — correct files land
  // -------------------------------------------------------------------------
  test("--harness kiro copies expected files", () => {
    const { exitCode, stdout } = runInstall(["--harness", "kiro", "--target", targetDir, "--force"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Installation complete");

    // Core files that kiro's dist ships
    expect(existsSync(join(targetDir, ".kiro"))).toBe(true);
    expect(existsSync(join(targetDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(targetDir, "aidlc"))).toBe(true);
    expect(existsSync(join(targetDir, ".gitignore"))).toBe(true);

    // Files from OTHER harnesses should NOT be present
    expect(existsSync(join(targetDir, ".claude"))).toBe(false);
    expect(existsSync(join(targetDir, ".codex"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Claude install — correct files land
  // -------------------------------------------------------------------------
  test("--harness claude copies expected files", () => {
    const { exitCode } = runInstall(["--harness", "claude", "--target", targetDir, "--force"]);
    expect(exitCode).toBe(0);

    expect(existsSync(join(targetDir, ".claude"))).toBe(true);
    expect(existsSync(join(targetDir, "aidlc"))).toBe(true);
    expect(existsSync(join(targetDir, ".mcp.json"))).toBe(true);

    // Claude does NOT ship AGENTS.md (its onboarding is CLAUDE.md inside .claude/)
    expect(existsSync(join(targetDir, "AGENTS.md"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Codex install — correct files land + trust note
  // -------------------------------------------------------------------------
  test("--harness codex copies expected files and shows trust note", () => {
    const { exitCode, stdout } = runInstall(["--harness", "codex", "--target", targetDir, "--force"]);
    expect(exitCode).toBe(0);

    expect(existsSync(join(targetDir, ".codex"))).toBe(true);
    expect(existsSync(join(targetDir, ".agents"))).toBe(true);
    expect(existsSync(join(targetDir, "aidlc"))).toBe(true);
    expect(existsSync(join(targetDir, "AGENTS.md"))).toBe(true);

    // Codex-specific trust-seeding note
    expect(stdout).toContain("Codex requires hook trust");
  });

  // -------------------------------------------------------------------------
  // opencode install — correct files land
  // -------------------------------------------------------------------------
  test("--harness opencode copies expected files", () => {
    const { exitCode } = runInstall(["--harness", "opencode", "--target", targetDir, "--force"]);
    expect(exitCode).toBe(0);

    expect(existsSync(join(targetDir, ".aidlc"))).toBe(true);
    expect(existsSync(join(targetDir, ".opencode"))).toBe(true);
    expect(existsSync(join(targetDir, "aidlc"))).toBe(true);
    expect(existsSync(join(targetDir, "opencode.json"))).toBe(true);
    expect(existsSync(join(targetDir, "AGENTS.md"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Skip behavior (no --force)
  // -------------------------------------------------------------------------
  test("existing files are skipped without --force", () => {
    // Pre-create files that the installer would copy
    mkdirSync(join(targetDir, ".kiro"), { recursive: true });
    writeFileSync(join(targetDir, "AGENTS.md"), "# existing\n");

    const { exitCode, stdout } = runInstall(["--harness", "kiro", "--target", targetDir]);
    expect(exitCode).toBe(0);
    // Skipped items show "(exists, use --force)"
    expect(stdout).toContain("exists, use --force");
    expect(stdout).toContain(".kiro");
    expect(stdout).toContain("AGENTS.md");
  });

  // -------------------------------------------------------------------------
  // --force overwrites
  // -------------------------------------------------------------------------
  test("--force overwrites existing files", () => {
    // First install
    runInstall(["--harness", "kiro", "--target", targetDir, "--force"]);

    // Second install with --force should NOT report skips
    const { exitCode, stdout } = runInstall(["--harness", "kiro", "--target", targetDir, "--force"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Installation complete");
    expect(stdout).not.toContain("exists, use --force");
  });

  // -------------------------------------------------------------------------
  // Target directory is created if missing
  // -------------------------------------------------------------------------
  test("creates target directory if it does not exist", () => {
    const newTarget = join(targetDir, "nested", "project");
    expect(existsSync(newTarget)).toBe(false);

    const { exitCode } = runInstall(["--harness", "kiro", "--target", newTarget, "--force"]);
    expect(exitCode).toBe(0);
    expect(existsSync(join(newTarget, ".kiro"))).toBe(true);
    expect(existsSync(join(newTarget, "AGENTS.md"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Unknown argument
  // -------------------------------------------------------------------------
  test("unknown argument exits 1", () => {
    const { stderr, exitCode } = runInstall(["--banana"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown argument");
  });

  // -------------------------------------------------------------------------
  // Version detection — same version
  // -------------------------------------------------------------------------
  test("detects same version on re-install", () => {
    // First install
    runInstall(["--harness", "kiro", "--target", targetDir, "--force"]);

    // Second install with --force shows version info
    const { exitCode, stdout } = runInstall(["--harness", "kiro", "--target", targetDir, "--force"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("already at");
  });

  // -------------------------------------------------------------------------
  // Version detection — different version (upgrade path)
  // -------------------------------------------------------------------------
  test("detects version difference on update", () => {
    // Install first
    runInstall(["--harness", "kiro", "--target", targetDir, "--force"]);

    // Fake an older version in both the metadata and version file
    const metaFile = join(targetDir, ".kiro", ".aidlc-install.json");
    writeFileSync(metaFile, JSON.stringify({ harness: "kiro", version: "1.0.0", installedAt: "2025-01-01T00:00:00Z" }));
    writeFileSync(join(targetDir, ".kiro", "tools", "aidlc-version.ts"), 'export const AIDLC_VERSION = "1.0.0";\n');

    // Re-install detects the version difference
    const { exitCode, stdout } = runInstall(["--harness", "kiro", "--target", targetDir, "--force"]);
    expect(exitCode).toBe(0);
    // Shows the old version and the arrow indicating an upgrade
    expect(stdout).toContain("v1.0.0");
    expect(stdout).toContain("\u2192");
  });

  // -------------------------------------------------------------------------
  // --all updates all existing installations
  // -------------------------------------------------------------------------
  test("--all updates all detected harnesses", () => {
    // Install two harnesses
    runInstall(["--harness", "kiro", "--target", targetDir, "--force"]);
    runInstall(["--harness", "claude", "--target", targetDir, "--force"]);

    // Fake older versions in metadata + version files so --all has something to update
    writeFileSync(join(targetDir, ".kiro", ".aidlc-install.json"), JSON.stringify({ harness: "kiro", version: "1.0.0", installedAt: "2025-01-01T00:00:00Z" }));
    writeFileSync(join(targetDir, ".kiro", "tools", "aidlc-version.ts"), 'export const AIDLC_VERSION = "1.0.0";\n');
    writeFileSync(join(targetDir, ".claude", ".aidlc-install.json"), JSON.stringify({ harness: "claude", version: "1.0.0", installedAt: "2025-01-01T00:00:00Z" }));
    writeFileSync(join(targetDir, ".claude", "tools", "aidlc-version.ts"), 'export const AIDLC_VERSION = "1.0.0";\n');

    // --all should update both
    const { exitCode, stdout } = runInstall(["--all", "--target", targetDir]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("claude");
    expect(stdout).toContain("kiro");
    expect(stdout).toContain("Installation complete");
  });

  // -------------------------------------------------------------------------
  // --all errors when no installations exist
  // -------------------------------------------------------------------------
  test("--all exits 1 when no installations found", () => {
    const emptyDir = join(targetDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const { exitCode, stderr } = runInstall(["--all", "--target", emptyDir]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no existing AI-DLC installation");
  });

  // -------------------------------------------------------------------------
  // --all and --harness are mutually exclusive
  // -------------------------------------------------------------------------
  test("--all + --harness exits 1", () => {
    const { exitCode, stderr } = runInstall(["--all", "--harness", "kiro", "--target", targetDir]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("cannot be used together");
  });
});
