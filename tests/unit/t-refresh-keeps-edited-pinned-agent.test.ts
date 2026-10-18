// covers: tool:aidlc-init, function:planManagedFiles, function:applyModelPolicyToProjection
//
// A shipped agent file that `aidlc config models` writes a model or effort
// into is still AI-DLC's file: a person's edit to it stops a release refresh
// with the same conflict as any other shipped file, and both ways forward the
// conflict names go through, so the edit is never written over without a word.
// Unedited, the refresh writes the release's file with the recorded model and
// effort and asks nothing, and a plugin's additions to the file stay. Kiro
// CLI's settings/cli.json, which the same writer fills with the model's
// effort, is held the same way.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSettingsPath } from "../../core/tools/aidlc-settings.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 4);

const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const RELEASES = join(REPO_ROOT, "dist-release");

const temporary: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function project(name: string) {
  const dir = temp(`aidlc-pinned-agent-${name}-`);
  mkdirSync(join(dir, ".git"));
  const machine = temp(`aidlc-pinned-agent-${name}-m-`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
    AIDLC_BIN_DIR: join(machine, "bin"),
    // A refresh reads the release files from here.
    AIDLC_RUNTIME_ROOT: RELEASES,
  };
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [INIT, ...args], {
      cwd: dir,
      env,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}`.replace(/\s+/g, " ") };
  };
  return { dir, run };
}

const appendNote = (text: string) => `${text}\nmy own notes\n`;
// Kiro CLI reads its agent and settings files as JSON, so the edit keeps them JSON.
const addJsonNote = (text: string) =>
  `${JSON.stringify({ ...JSON.parse(text), myOwnNotes: true }, null, 2)}\n`;

const ROWS = [
  { harness: "claude", files: [".claude/agents/aidlc-architect-agent.md"], pin: ["--effort", "high"], edit: appendNote },
  { harness: "codex", files: [".codex/agents/aidlc-architect-agent.toml"], pin: ["--effort", "high"], edit: appendNote },
  { harness: "opencode", files: [".opencode/agents/aidlc-architect-agent.md"], pin: ["--effort", "high"], edit: appendNote },
  { harness: "kiro-ide", files: [".kiro/agents/aidlc-architect-agent.md"], pin: ["--effort", "high"], edit: appendNote },
  {
    harness: "kiro",
    files: [".kiro/agents/aidlc-architect-agent.json", ".kiro/settings/cli.json"],
    pin: ["--model", "claude-sonnet-5-5", "--effort", "high"],
    edit: addJsonNote,
  },
] as const;

describe("a refresh over an agent file with a recorded model or effort", () => {
  for (const row of ROWS) {
    test(`${row.harness}: an edit stops the refresh and is kept; moving it aside or --force goes through`, () => {
      const p = project(row.harness);
      const release = join(RELEASES, row.harness);
      const installed = p.run(["config", "--project-dir", p.dir, "--from", release, "--harness", row.harness, "--mcp", "none", "--yes"]);
      expect(installed.status, installed.out).toBe(0);
      const pinned = p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", "architect", ...row.pin, "--yes"]);
      expect(pinned.status, pinned.out).toBe(0);
      const written = new Map(row.files.map((rel) => [rel, readFileSync(join(p.dir, rel), "utf-8")]));
      for (const [rel, text] of written) {
        expect(text, rel).not.toBe(readFileSync(join(release, rel), "utf-8"));
      }

      const refresh = ["config", "--project-dir", p.dir, "--yes"];
      const clean = p.run(refresh);
      expect(clean.status, clean.out).toBe(0);
      for (const [rel, text] of written) expect(readFileSync(join(p.dir, rel), "utf-8"), rel).toBe(text);

      const refuse = () => {
        for (const [rel, text] of written) writeFileSync(join(p.dir, rel), row.edit(text));
        const refused = p.run(refresh);
        expect(refused.status, refused.out).toBe(4);
        for (const [rel, text] of written) {
          expect(refused.out).toContain(`${rel} (locally modified or unowned)`);
          expect(readFileSync(join(p.dir, rel), "utf-8"), rel).toBe(row.edit(text));
        }
      };

      refuse();
      for (const rel of written.keys()) renameSync(join(p.dir, rel), join(p.dir, `${rel}.mine`));
      const moved = p.run(refresh);
      expect(moved.status, moved.out).toBe(0);
      for (const [rel, text] of written) {
        expect(readFileSync(join(p.dir, rel), "utf-8"), rel).toBe(text);
        expect(readFileSync(join(p.dir, `${rel}.mine`), "utf-8"), rel).toBe(row.edit(text));
      }

      refuse();
      const forced = p.run([...refresh, "--force"]);
      expect(forced.status, forced.out).toBe(0);
      for (const [rel, text] of written) expect(readFileSync(join(p.dir, rel), "utf-8"), rel).toBe(text);
    });
  }

  // test-pro adds its fragments to the quality agent. An effort set for that
  // agent afterwards reaches the install record with them, so the refresh
  // proves the file AI-DLC's and keeps both.
  test("a plugin's additions to an agent file and the effort set for it stay through a refresh; an edit still stops it", () => {
    const p = project("composed");
    const release = join(RELEASES, "claude");
    const installed = p.run(["config", "--project-dir", p.dir, "--from", release, "--harness", "claude", "--mcp", "none", "--yes"]);
    expect(installed.status, installed.out).toBe(0);
    const plugin = join(REPO_ROOT, "dist", "plugins", "test-pro", "claude");
    const composed = spawnSync(process.execPath, [join(plugin, "hooks", "compose.ts")], {
      cwd: p.dir,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: p.dir },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(composed.status, `${composed.stdout}${composed.stderr}`).toBe(0);
    const agent = join(p.dir, ".claude", "agents", "aidlc-quality-agent.md");
    expect(readFileSync(agent, "utf-8")).toContain("<!-- plugin:test-pro:");
    const refresh = ["config", "--project-dir", p.dir, "--yes"];
    for (const effort of ["high", "low"]) {
      const pinned = p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", "quality", "--effort", effort, "--yes"]);
      expect(pinned.status, pinned.out).toBe(0);
      const written = readFileSync(agent, "utf-8");
      const refreshed = p.run(refresh);
      expect(refreshed.status, refreshed.out).toBe(0);
      expect(readFileSync(agent, "utf-8")).toBe(written);
      expect(written).toContain("<!-- plugin:test-pro:");
      expect(written).toMatch(new RegExp(`^effort: ${effort}$`, "m"));
    }
    // A newer release that changes the agent file brings its text in around both.
    const newer = temp("aidlc-pinned-agent-newer-");
    cpSync(release, newer, { recursive: true });
    const newerAgent = join(newer, ".claude", "agents", "aidlc-quality-agent.md");
    writeFileSync(newerAgent, `${readFileSync(newerAgent, "utf-8")}\nUpstream refresh marker.\n`);
    const upgraded = p.run(["config", "--project-dir", p.dir, "--from", newer, "--yes"]);
    expect(upgraded.status, upgraded.out).toBe(0);
    const upgradedText = readFileSync(agent, "utf-8");
    expect(upgradedText).toContain("Upstream refresh marker.");
    expect(upgradedText).toContain("<!-- plugin:test-pro:");
    expect(upgradedText).toMatch(/^effort: low$/m);
    writeFileSync(agent, appendNote(readFileSync(agent, "utf-8")));
    const refused = p.run(["config", "--project-dir", p.dir, "--from", newer, "--yes"]);
    expect(refused.status, refused.out).toBe(4);
    expect(refused.out).toContain(".claude/agents/aidlc-quality-agent.md (locally modified or unowned)");
    expect(readFileSync(agent, "utf-8")).toContain("my own notes");
  });

  // The release's own file is AI-DLC's before the model writer fills it in,
  // as it is after: putting it back is no edit to keep.
  test("an agent file put back to the release's own copy takes the recorded model with no conflict", () => {
    const p = project("release-copy");
    const release = join(RELEASES, "kiro");
    const installed = p.run(["config", "--project-dir", p.dir, "--from", release, "--harness", "kiro", "--mcp", "none", "--yes"]);
    expect(installed.status, installed.out).toBe(0);
    const pinned = p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", "architect", "--model", "claude-sonnet-5-5", "--yes"]);
    expect(pinned.status, pinned.out).toBe(0);
    const rel = join(".kiro", "agents", "aidlc-architect-agent.json");
    const written = readFileSync(join(p.dir, rel), "utf-8");
    cpSync(join(release, rel), join(p.dir, rel));
    const refreshed = p.run(["config", "--project-dir", p.dir, "--yes"]);
    expect(refreshed.status, refreshed.out).toBe(0);
    expect(readFileSync(join(p.dir, rel), "utf-8")).toBe(written);
  });

  // A copied release tree has no install record yet: its agent file is the
  // release's own, so the first config run writes the recorded effort into it.
  test("a copied release tree with an effort already recorded sets up without a conflict", () => {
    const p = project("copy");
    const release = join(RELEASES, "claude");
    cpSync(release, p.dir, { recursive: true });
    writeFileSync(
      projectSettingsPath(p.dir),
      `${JSON.stringify({ schemaVersion: 1, models: { schemaVersion: 1, agents: { architect: { effort: "high" } } } }, null, 2)}\n`,
    );
    const configured = p.run(["config", "--project-dir", p.dir, "--from", release, "--harness", "claude", "--mcp", "none", "--yes"]);
    expect(configured.status, configured.out).toBe(0);
    expect(configured.out).not.toContain("locally modified or unowned");
    expect(readFileSync(join(p.dir, ".claude", "agents", "aidlc-architect-agent.md"), "utf-8")).toMatch(/^effort: high$/m);
  });
});
