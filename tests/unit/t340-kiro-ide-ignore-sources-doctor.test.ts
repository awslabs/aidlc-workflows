// covers: subcommand:aidlc-utility:doctor (Kiro IDE ignore sources)
//
// Issue #1146: Kiro IDE evaluates ignore files independently, so a project
// negation cannot rescue framework reads denied by a global ignore rule.

import { describe, expect, test, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kiroIdeIgnoreSourceChecks } from "../../core/tools/aidlc-utility.ts";

const UTIL = fileURLToPath(new URL("../../core/tools/aidlc-utility.ts", import.meta.url));
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setupProject(): { project: string; globalFile: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), "aidlc-ignore-home-"));
  created.push(home);
  const project = mkdtempSync(join(tmpdir(), "aidlc-ignore-project-"));
  created.push(project);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const globalFile = join(env.XDG_CONFIG_HOME, "git", "ignore");
  mkdirSync(join(env.XDG_CONFIG_HOME, "git"), { recursive: true });
  const init = spawnSync("git", ["init", "-q", project], { env, encoding: "utf-8" });
  if (init.error) throw init.error;
  if (init.status !== 0) throw new Error(init.stderr || `git init exit ${init.status}`);
  return { project, globalFile, env };
}

describe("t340 Kiro IDE ignore sources doctor", () => {
  test("a global .kiro/ rule fails and is named even when the project .gitignore negates it", () => {
    const { project, globalFile, env } = setupProject();
    writeFileSync(globalFile, ".kiro/\n");
    writeFileSync(join(project, ".gitignore"), "!.kiro/\n");

    const rows = kiroIdeIgnoreSourceChecks(project, ".kiro", env);
    const failures = rows.filter((row) => !row.pass);
    expect(failures).toHaveLength(1);
    expect(failures[0].severity).toBeUndefined();
    expect(failures[0].label).toContain(`${globalFile}:1 ".kiro/" hides .kiro/`);
    expect(failures[0].fix).toContain("permissions.yaml");
    expect(failures[0].fix).toContain(".git/info/exclude");
    expect(failures.some((row) => row.label.includes(join(project, ".gitignore")))).toBe(false);
  });

  test("a negation inside the same file clears the rule", () => {
    const { project, globalFile, env } = setupProject();
    writeFileSync(globalFile, ".kiro/\n!.kiro/\n");

    const rows = kiroIdeIgnoreSourceChecks(project, ".kiro", env);
    expect(rows).toHaveLength(1);
    expect(rows[0].pass).toBe(true);
    expect(rows[0].label).toMatch(/none hide \.kiro\//);
    expect(rows[0].label).toContain("1 file(s) checked");
  });

  test("a directly matching negation inside the same file clears the rule", () => {
    const { project, globalFile, env } = setupProject();
    writeFileSync(globalFile, "*.md\n!*.md\n");

    const rows = kiroIdeIgnoreSourceChecks(project, ".kiro", env);
    expect(rows).toHaveLength(1);
    expect(rows[0].pass).toBe(true);
    expect(rows[0].label).toMatch(/none hide \.kiro\//);
  });

  test("the doctor row is emitted only for the Kiro IDE conductor surface", () => {
    const { project, globalFile, env } = setupProject();
    writeFileSync(globalFile, ".kiro/\n");
    mkdirSync(join(project, ".kiro", "agents"), { recursive: true });
    writeFileSync(join(project, ".kiro", "agents", "aidlc.json"), "{}\n");
    const run = (): string => {
      const result = spawnSync(process.execPath, [UTIL, "doctor", "--project-dir", project, "--verbose"], {
        encoding: "utf-8",
        env: { ...env, AIDLC_HARNESS_DIR: ".kiro" },
      });
      if (result.error) throw result.error;
      return `${result.stdout ?? ""}${result.stderr ?? ""}`;
    };

    const cli = run();
    expect(cli).toContain("ok    agents/aidlc.{json,md} present (conductor wiring)");
    expect(cli).not.toContain("Kiro IDE ignore sources:");

    writeFileSync(join(project, ".kiro", "agents", "aidlc.md"), "# AI-DLC conductor\n");
    const ide = run();
    expect(ide).toContain(`fail  Kiro IDE ignore sources: ${globalFile}:1 ".kiro/" hides .kiro/`);
  });

  test("global rules fail while workspace rules warn about the IDE setting", () => {
    const { project, globalFile, env } = setupProject();
    const workspaceFile = join(project, ".gitignore");
    writeFileSync(globalFile, ".kiro/\n");
    writeFileSync(workspaceFile, ".kiro/\n");

    const rows = kiroIdeIgnoreSourceChecks(project, ".kiro", env);
    const failures = rows.filter((row) => !row.pass && row.severity === undefined);
    const warnings = rows.filter((row) => row.severity === "warn");
    expect(failures).toHaveLength(1);
    expect(failures[0].label).toContain(`${globalFile}:1 ".kiro/" hides .kiro/`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].label).toContain(`${workspaceFile}:1 ".kiro/" hides .kiro/`);
    expect(warnings[0].label).toContain("kiroAgent.agentIgnoreFiles names .gitignore");
  });
});
