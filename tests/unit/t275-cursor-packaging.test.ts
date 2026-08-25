// t275-cursor-packaging: dist/cursor parity + drift guard + shell shape.
//
// covers: file:tools/aidlc-lib.ts, function:runnerFrontmatterAdditions
//
// WHAT. Five contracts land here:
//   (1) The committed dist/cursor tree is byte-identical to what
//       `bun scripts/package.ts cursor --check` verifies (drift guard, same
//       UX as opencode's t240 test 1).
//   (2) Core parity: every .ts under dist/cursor/.cursor/{tools,hooks}/ is
//       BYTE-IDENTICAL to its dist/claude source (the architecture-B
//       invariant: the packager may transform prose/data paths, never code)
//       - all but the authored adapter, which has no Claude twin.
//   (3) The Cursor-native surfaces are shaped for Cursor's scanners: the
//       rules dir carries ONLY .mdc (a plain .md in .cursor/rules/ is
//       silently ignored by Cursor - live-verified), standing method layers
//       are always-applied, phase layers are agent-decided, and hooks.json
//       wires only camelCase events through the adapter.
//   (4) The persona files double as live native subagents on Cursor, so no
//       agent may carry a model pin (model availability is plan-dependent;
//       a pinned id hard-fails Free/lower plans) and the raw tier: key never
//       leaks.
//   (5) The doctor recognizes a dist/cursor install (adapter + wiring
//       checks pass on the pristine tree).
//
// WHY SUBPROCESS for (1). Same idiom as t141/t150/t240: the packager is a
// CLI; we pin its observable behavior, not its internals.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const CURSOR_ROOT = join(REPO_ROOT, "dist", "cursor");
const ENGINE = join(CURSOR_ROOT, ".cursor");
const CURSOR_INSTALLER_SOURCE = join(REPO_ROOT, "harness", "cursor", "install.ts");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("t275 dist/cursor packaging parity + shell shape", () => {
  test("1: committed dist/cursor matches the packaging script (drift guard)", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "cursor", "--check"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
    if (r.status !== 0) {
      // Surface the script's own stale-file list - it names the fix.
      console.error(r.stderr);
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("in sync");
  });

  test("2: every packaged .ts file is byte-identical to its dist/claude source (code is never transformed)", () => {
    const divergent: string[] = [];
    for (const sub of ["tools", "hooks"]) {
      const dstDir = join(ENGINE, sub);
      for (const file of walk(dstDir)) {
        if (!file.endsWith(".ts")) continue;
        const rel = file.slice(dstDir.length + 1);
        // The adapter is AUTHORED for this harness - no Claude twin exists.
        if (rel === "aidlc-cursor-adapter.ts") continue;
        const src = join(CLAUDE_SRC, sub, rel);
        if (!readFileSync(file).equals(readFileSync(src))) divergent.push(`${sub}/${rel}`);
      }
    }
    expect(divergent).toEqual([]);
  });

  test("3: rules/ splits always-applied standing layers from agent-decided phase layers", () => {
    // Cursor loads ONLY .mdc from .cursor/rules/ (live-verified: a plain .md
    // there is silently ignored). Anything else in the dir is a shipping bug.
    const rules = readdirSync(join(ENGINE, "rules")).sort();
    expect(rules).toEqual([
      "aidlc-phase-construction.mdc",
      "aidlc-phase-ideation.mdc",
      "aidlc-phase-inception.mdc",
      "aidlc-phase-operation.mdc",
      "aidlc.mdc",
    ]);
    const standing = readFileSync(join(ENGINE, "rules", "aidlc.mdc"), "utf-8");
    expect(standing).toMatch(/^alwaysApply: true$/m);
    for (const f of ["org.md", "team.md", "project.md"]) {
      expect(standing).toContain(`aidlc/spaces/default/memory/${f}`);
    }
    expect(standing).not.toContain("memory/phases/");

    for (const phase of ["ideation", "inception", "construction", "operation"]) {
      const rule = readFileSync(
        join(ENGINE, "rules", `aidlc-phase-${phase}.mdc`),
        "utf-8",
      );
      expect(rule, phase).toMatch(/^description: .+ phase practices$/mi);
      expect(rule, phase).toMatch(/^alwaysApply: false$/m);
      expect(rule, phase).toContain(
        `aidlc/spaces/default/memory/phases/${phase}.md`,
      );
      expect(rule, phase).not.toContain("memory/org.md");
    }
    for (const name of rules) {
      // No @-import lines: Cursor rules do not expand them (live-verified).
      expect(readFileSync(join(ENGINE, "rules", name), "utf-8")).not.toMatch(/^@/m);
    }
    // And the shipped memory tree the rule points at actually ships.
    expect(existsSync(join(CURSOR_ROOT, "aidlc", "spaces", "default", "memory", "org.md"))).toBe(
      true,
    );
  });

  test("4: hooks.json wires only camelCase Cursor events, every command through the adapter", () => {
    const wiring = JSON.parse(readFileSync(join(ENGINE, "hooks.json"), "utf-8")) as {
      version: number;
      hooks: Record<
        string,
        Array<{ command: string; failClosed?: boolean; loop_limit?: number }>
      >;
    };
    expect(wiring.version).toBe(1);
    const events = Object.keys(wiring.hooks).sort();
    expect(events).toEqual([
      "beforeSubmitPrompt",
      "postToolUse",
      "postToolUseFailure",
      "preCompact",
      "preToolUse",
      "sessionEnd",
      "sessionStart",
      "stop",
    ]);
    const targets = new Set<string>();
    for (const [event, group] of Object.entries(wiring.hooks)) {
      // Cursor event names are camelCase; a PascalCase name (the Claude
      // schema) would silently never fire.
      expect(event[0], `${event}: camelCase`).toBe(event[0].toLowerCase());
      for (const h of group) {
        const m = h.command.match(/^bun \.cursor\/hooks\/aidlc-cursor-adapter\.ts ([a-z-]+)$/);
        expect(m, `${event}: adapter command shape (${h.command})`).not.toBeNull();
        if (m) targets.add(m[1]);
      }
    }
    // Every wired target has a real arm in the adapter switch.
    const adapter = readFileSync(join(ENGINE, "hooks", "aidlc-cursor-adapter.ts"), "utf-8");
    for (const target of targets) {
      expect(adapter, `adapter handles "${target}"`).toContain(`case "${target}":`);
    }
    expect(wiring.hooks.preToolUse).toEqual([
      {
        command: "bun .cursor/hooks/aidlc-cursor-adapter.ts guards",
        failClosed: true,
      },
    ]);
    expect(wiring.hooks.stop).toEqual([
      {
        command: "bun .cursor/hooks/aidlc-cursor-adapter.ts stop",
        loop_limit: 10,
      },
    ]);
  });

  test("5: persona files are native-subagent-safe - no model pins, no tier leak", () => {
    const agents = readdirSync(join(ENGINE, "agents")).filter((f) => f.endsWith("-agent.md"));
    expect(agents.length).toBe(14);
    for (const f of agents) {
      const raw = readFileSync(join(ENGINE, "agents", f), "utf-8");
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      // The cursor tier column is all-null BY DESIGN (plan-dependent model
      // availability): a model pin here would hard-fail lower-plan installs.
      expect(fm, `${f}: no model pin`).not.toMatch(/^model:/m);
      expect(fm, `${f}: no raw tier: leak`).not.toMatch(/^tier:/m);
      // Cursor discovers subagents by frontmatter name; the core name key is
      // the discovery key and must survive projection.
      expect(fm, `${f}: discoverable name`).toMatch(/^name: aidlc-/m);
      // Default-space startup must not rewrite the shipped persona files.
      expect(raw, `${f}: concrete default memory pointer`).not.toContain(
        "aidlc/spaces/<active-space>/memory/",
      );
    }
  });

  test("6: cli.json pre-approves exactly Shell(bun) at the project level", () => {
    const cli = JSON.parse(readFileSync(join(ENGINE, "cli.json"), "utf-8")) as {
      permissions?: { allow?: string[]; deny?: string[] };
    };
    // Project-level cli.json is permissions-only (Cursor's documented
    // contract); the shipped allowlist is the engine runner and nothing else.
    expect(cli.permissions?.allow).toEqual(["Shell(bun)"]);
    expect(cli.permissions?.deny).toEqual([]);
  });

  test("7: shipped cursor prose names no other harness's engine dir", () => {
    const r = spawnSync("grep", ["-rn", "bun .claude/tools/", CURSOR_ROOT], {
      encoding: "utf-8",
    });
    // grep exits 1 on no matches - exactly what we want.
    expect(r.status).toBe(1);
  });

  test("8: doctor recognizes a pristine dist/cursor install (adapter + wiring checks)", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-doctor-"));
    try {
      const project = join(root, "project");
      cpSync(CURSOR_ROOT, project, { recursive: true });
      const r = spawnSync(
        "bun",
        [join(project, ".cursor", "tools", "aidlc-utility.ts"), "doctor", "--project-dir", project],
        {
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".cursor" },
        },
      );
      expect(r.stdout).toContain("✓  aidlc-cursor-adapter.ts present");
      expect(r.stdout).toContain("✓  hooks.json present (hook wiring)");
      expect(r.stdout).toContain("✓  cli.json present (Shell(bun) permission pre-approval)");
      expect(r.stdout).toContain(
        "✓  rules/aidlc.mdc present (standing method rule (alwaysApply read instruction))",
      );
      for (const phase of ["Ideation", "Inception", "Construction", "Operation"]) {
        expect(r.stdout).toContain(
          `✓  rules/aidlc-phase-${phase.toLowerCase()}.mdc present (${phase} phase rule (agent-decided read instruction))`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("9: Cursor installer merges shared surfaces without overwriting project files", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-install-"));
    const project = join(root, "project");
    try {
      const cursorDir = join(project, ".cursor");
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(
        join(cursorDir, "hooks.json"),
        `${JSON.stringify({
          version: 1,
          hooks: { sessionStart: [{ command: "bun .cursor/hooks/project-hook.ts" }] },
        }, null, 2)}\n`,
      );
      writeFileSync(
        join(cursorDir, "cli.json"),
        `${JSON.stringify({
          permissions: { allow: ["Shell(git)"], deny: ["Shell(rm)"] },
          projectSetting: true,
        }, null, 2)}\n`,
      );
      writeFileSync(join(cursorDir, ".gitignore"), "project-cursor-cache\n");
      writeFileSync(join(project, "AGENTS.md"), "# Project instructions\n");
      writeFileSync(join(project, ".gitignore"), "coverage/\n");

      const install = spawnSync("bun", [join(CURSOR_ROOT, "install.ts"), project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(install.status, install.stderr).toBe(0);

      const hooks = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf-8")) as {
        hooks: Record<string, Array<{ command: string; failClosed?: boolean }>>;
      };
      expect(hooks.hooks.sessionStart.map((entry) => entry.command)).toContain(
        "bun .cursor/hooks/project-hook.ts",
      );
      expect(hooks.hooks.sessionStart.map((entry) => entry.command)).toContain(
        "bun .cursor/hooks/aidlc-cursor-adapter.ts session-start",
      );
      expect(hooks.hooks.postToolUseFailure).toHaveLength(1);
      expect(hooks.hooks.preToolUse[0]?.failClosed).toBe(true);

      const cli = JSON.parse(readFileSync(join(cursorDir, "cli.json"), "utf-8")) as {
        permissions: { allow: string[]; deny: string[] };
        projectSetting: boolean;
      };
      expect(cli.projectSetting).toBe(true);
      expect(cli.permissions.allow).toEqual(["Shell(git)", "Shell(bun)"]);
      expect(cli.permissions.deny).toEqual(["Shell(rm)"]);
      expect(readFileSync(join(cursorDir, ".gitignore"), "utf-8")).toBe(
        "project-cursor-cache\n",
      );
      expect(readFileSync(join(project, "AGENTS.md"), "utf-8")).toContain(
        "# Project instructions",
      );
      expect(readFileSync(join(project, "AGENTS.md"), "utf-8")).toContain(
        "<!-- BEGIN AIDLC CURSOR -->",
      );
      expect(readFileSync(join(project, ".gitignore"), "utf-8")).toContain("coverage/");
      expect(readFileSync(join(project, ".gitignore"), "utf-8")).toContain(
        "aidlc/active-space",
      );

      const before = readFileSync(join(cursorDir, "hooks.json"), "utf-8");
      const rerun = spawnSync("bun", [join(CURSOR_ROOT, "install.ts"), project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(readFileSync(join(cursorDir, "hooks.json"), "utf-8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("10: Cursor installer refuses malformed shared config before copying", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-install-malformed-"));
    const project = join(root, "project");
    try {
      mkdirSync(join(project, ".cursor"), { recursive: true });
      writeFileSync(join(project, ".cursor", "hooks.json"), "{not json");
      writeFileSync(join(project, "AGENTS.md"), "# Keep me\n");
      const install = spawnSync("bun", [join(CURSOR_ROOT, "install.ts"), project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(install.status).toBe(1);
      expect(install.stderr).toContain("malformed JSON");
      expect(readFileSync(join(project, "AGENTS.md"), "utf-8")).toBe("# Keep me\n");
      expect(existsSync(join(project, ".cursor", "tools"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("11: Cursor installer refuses unresolved file collisions before copying", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-install-collision-"));
    const project = join(root, "project");
    try {
      mkdirSync(join(project, ".cursor", "rules"), { recursive: true });
      writeFileSync(join(project, ".cursor", "rules", "aidlc.mdc"), "project-owned\n");
      writeFileSync(join(project, "AGENTS.md"), "# Keep me\n");
      const install = spawnSync("bun", [join(CURSOR_ROOT, "install.ts"), project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(install.status).toBe(1);
      expect(install.stderr).toContain("refusing to overwrite");
      expect(install.stderr).toContain(".cursor/rules/aidlc.mdc");
      expect(readFileSync(join(project, "AGENTS.md"), "utf-8")).toBe("# Keep me\n");
      expect(existsSync(join(project, ".cursor", "tools"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("12: Cursor install docs use the merge-aware installer", () => {
    for (const file of [
      join(REPO_ROOT, "README.md"),
      join(REPO_ROOT, "docs", "guide", "harnesses", "cursor.md"),
    ]) {
      const raw = readFileSync(file, "utf-8");
      expect(raw, file).toContain("bun dist/cursor/install.ts your-project");
      expect(raw, file).not.toContain("cp -R dist/cursor/.cursor");
      expect(raw, file).not.toContain("cp dist/cursor/AGENTS.md");
    }
  });

  test("13: Cursor installer migrates only verified pre-receipt files", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-upgrade-"));
    const project = join(root, "project");
    try {
      const stagedDist = join(root, "cursor-dist");
      cpSync(CURSOR_ROOT, stagedDist, { recursive: true });
      cpSync(CURSOR_INSTALLER_SOURCE, join(stagedDist, "install.ts"));
      const installer = join(stagedDist, "install.ts");
      const first = spawnSync("bun", [installer, project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(first.status, first.stderr).toBe(0);

      const utility = join(project, ".cursor", "tools", "aidlc-utility.ts");
      const utilityEnv = { ...process.env, AIDLC_HARNESS_DIR: ".cursor" };
      const create = spawnSync(
        "bun",
        [utility, "space-create", "team-b", "--project-dir", project],
        { cwd: project, encoding: "utf-8", env: utilityEnv },
      );
      expect(create.status, create.stderr).toBe(0);
      const switchSpace = spawnSync(
        "bun",
        [utility, "space", "team-b", "--project-dir", project],
        { cwd: project, encoding: "utf-8", env: utilityEnv },
      );
      expect(switchSpace.status, switchSpace.stderr).toBe(0);

      // Simulate an install made by the reviewed pre-receipt installer.
      rmSync(join(project, ".cursor", "aidlc-install.json"), { force: true });
      const managed = join(project, ".cursor", "hooks", "aidlc-cursor-adapter.ts");
      const projectMemory = join(
        project,
        "aidlc",
        "spaces",
        "default",
        "memory",
        "project.md",
      );
      writeFileSync(projectMemory, "# Project-owned method\n");

      const upgrade = spawnSync("bun", [installer, project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(readFileSync(managed).equals(
        readFileSync(join(ENGINE, "hooks", "aidlc-cursor-adapter.ts")),
      )).toBe(true);
      expect(readFileSync(join(project, "aidlc", "active-space"), "utf-8").trim()).toBe(
        "team-b",
      );
      expect(
        readFileSync(join(project, ".cursor", "rules", "aidlc.mdc"), "utf-8"),
      ).toContain("aidlc/spaces/team-b/memory/");
      for (const phase of ["ideation", "inception", "construction", "operation"]) {
        const installedRule = readFileSync(
          join(project, ".cursor", "rules", `aidlc-phase-${phase}.mdc`),
          "utf-8",
        );
        expect(installedRule, phase).toContain(
          `aidlc/spaces/team-b/memory/phases/${phase}.md`,
        );
        expect(installedRule, phase).not.toContain("aidlc/spaces/default/memory/");
      }
      for (const agent of readdirSync(join(project, ".cursor", "agents"))) {
        if (!agent.endsWith("-agent.md")) continue;
        const shipped = readFileSync(join(ENGINE, "agents", agent), "utf-8");
        const installed = readFileSync(join(project, ".cursor", "agents", agent), "utf-8");
        if (shipped.includes("aidlc/spaces/default/memory/")) {
          expect(installed, agent).toContain("aidlc/spaces/team-b/memory/");
          expect(installed, agent).not.toContain("aidlc/spaces/default/memory/");
        } else {
          expect(installed, agent).toBe(shipped);
        }
      }
      expect(readFileSync(projectMemory, "utf-8")).toBe("# Project-owned method\n");
      expect(existsSync(join(project, ".cursor", "aidlc-install.json"))).toBe(true);

      // Sentinel files establish that this is an older AI-DLC install, but do
      // not prove ownership of a differing file. Without receipt provenance,
      // a modified framework-shaped file must block the whole migration.
      const agentsBeforeRefusal = readFileSync(join(project, "AGENTS.md"));
      const ruleBeforeRefusal = readFileSync(
        join(project, ".cursor", "rules", "aidlc.mdc"),
      );
      rmSync(join(project, ".cursor", "aidlc-install.json"), { force: true });
      writeFileSync(managed, "// user-modified pre-receipt adapter\n");
      const refused = spawnSync("bun", [installer, project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("refusing to overwrite");
      expect(refused.stderr).toContain(".cursor/hooks/aidlc-cursor-adapter.ts");
      expect(readFileSync(managed, "utf-8")).toBe(
        "// user-modified pre-receipt adapter\n",
      );
      expect(readFileSync(join(project, "AGENTS.md"))).toEqual(agentsBeforeRefusal);
      expect(readFileSync(join(project, ".cursor", "rules", "aidlc.mdc"))).toEqual(
        ruleBeforeRefusal,
      );
      expect(existsSync(join(project, ".cursor", "aidlc-install.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("14: generated Cursor runners are explicit-only", () => {
    const generated: string[] = [];
    for (const file of walk(join(ENGINE, "skills"))) {
      if (!file.endsWith("SKILL.md")) continue;
      const raw = readFileSync(file, "utf-8");
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      if (!/^generated-by:\s*aidlc-runner-gen$/m.test(fm)) continue;
      generated.push(file);
      expect(fm, file).toMatch(/^disable-model-invocation:\s*true$/m);
    }
    expect(generated.length).toBeGreaterThan(0);
  });

  test("15: Cursor utility shortcuts are native explicit-only skills", () => {
    const shortcuts = {
      "aidlc-status": "next --status",
      "aidlc-jump": "next $ARGUMENTS",
      "aidlc-scope": "next --scope $ARGUMENTS",
    } as const;
    for (const [name, invocation] of Object.entries(shortcuts)) {
      const raw = readFileSync(join(ENGINE, "skills", name, "SKILL.md"), "utf-8");
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      expect(fm, name).toMatch(new RegExp(`^name: ${name}$`, "m"));
      expect(fm, name).toMatch(/^user-invocable: true$/m);
      expect(fm, name).toMatch(/^disable-model-invocation: true$/m);
      expect(raw, name).toContain(invocation);
    }
    expect(
      readFileSync(join(ENGINE, "skills", "aidlc-jump", "SKILL.md"), "utf-8"),
    ).toMatch(/A\s+missing target must never degrade into a bare `next`\./);
    expect(
      readFileSync(join(ENGINE, "skills", "aidlc-scope", "SKILL.md"), "utf-8"),
    ).toMatch(/A\s+missing scope must never degrade into a bare `next`\./);
    expect(existsSync(join(ENGINE, "commands"))).toBe(false);
  });

  test("16: receipt-backed reinstall recompiles explicit plugin selection against upgraded core", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-selection-reinstall-"));
    const project = join(root, "project");
    try {
      const installer = join(CURSOR_ROOT, "install.ts");
      const first = spawnSync("bun", [installer, project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(first.status, first.stderr).toBe(0);

      const utility = join(project, ".cursor", "tools", "aidlc-utility.ts");
      const selected = spawnSync(
        "bun",
        [utility, "select-plugins", "aidlc", "--project-dir", project],
        {
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".cursor" },
        },
      );
      expect(selected.status, selected.stderr).toBe(0);
      const graphPath = join(project, ".cursor", "tools", "data", "stage-graph.json");
      const scopeGridPath = join(project, ".cursor", "tools", "data", "scope-grid.json");
      const graphBefore = readFileSync(graphPath);
      const scopeGridBefore = readFileSync(scopeGridPath);

      // Model an older installed release whose managed stage source and compiled
      // routing data disagree with the refreshed distribution. The receipt hash
      // identifies the old stage bytes as framework-owned, so upgrade may replace
      // them; the compiled outputs must then be rebuilt from the new source.
      const stageRel = ".cursor/aidlc-common/stages/construction/functional-design.md";
      const stagePath = join(project, stageRel);
      const staleStage = readFileSync(stagePath, "utf-8").replace(
        /^name:\s*.+$/m,
        "name: Stale Functional Design",
      );
      writeFileSync(stagePath, staleStage);
      const receiptPath = join(project, ".cursor", "aidlc-install.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf-8")) as {
        managedFiles: Record<string, string>;
      };
      receipt.managedFiles[stageRel] = createHash("sha256").update(staleStage).digest("hex");
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      const staleGraph = JSON.parse(graphBefore.toString("utf-8")) as Array<{
        slug?: string;
        name?: string;
      }>;
      const functionalDesign = staleGraph.find((stage) => stage.slug === "functional-design");
      expect(functionalDesign).toBeDefined();
      functionalDesign!.name = "Stale Functional Design";
      writeFileSync(graphPath, `${JSON.stringify(staleGraph, null, 2)}\n`);
      writeFileSync(scopeGridPath, `${JSON.stringify({ stale: true }, null, 2)}\n`);

      const reinstall = spawnSync("bun", [installer, project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(reinstall.status, reinstall.stderr).toBe(0);
      const harnessData = JSON.parse(
        readFileSync(
          join(project, ".cursor", "tools", "data", "harness.json"),
          "utf-8",
        ),
      ) as { plugins?: string[] };
      expect(harnessData.plugins).toEqual(["aidlc"]);
      expect(reinstall.stdout).toContain("refreshed plugin routing");
      expect(readFileSync(stagePath)).toEqual(readFileSync(join(CURSOR_ROOT, stageRel)));
      expect(readFileSync(graphPath)).toEqual(graphBefore);
      expect(readFileSync(scopeGridPath)).toEqual(scopeGridBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("17: reinstall restores missing Cursor surfaces for the active space", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-active-restore-"));
    const project = join(root, "project");
    try {
      const installer = join(CURSOR_ROOT, "install.ts");
      expect(
        spawnSync("bun", [installer, project], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
        }).status,
      ).toBe(0);
      const utility = join(project, ".cursor", "tools", "aidlc-utility.ts");
      const env = { ...process.env, AIDLC_HARNESS_DIR: ".cursor" };
      expect(
        spawnSync(
          "bun",
          [utility, "space-create", "team-b", "--project-dir", project],
          { cwd: project, encoding: "utf-8", env },
        ).status,
      ).toBe(0);
      expect(
        spawnSync(
          "bun",
          [utility, "space", "team-b", "--project-dir", project],
          { cwd: project, encoding: "utf-8", env },
        ).status,
      ).toBe(0);

      const phaseRule = join(
        project,
        ".cursor",
        "rules",
        "aidlc-phase-construction.mdc",
      );
      const agent = join(
        project,
        ".cursor",
        "agents",
        "aidlc-architect-agent.md",
      );
      rmSync(phaseRule);
      rmSync(agent);

      const reinstall = spawnSync("bun", [installer, project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(reinstall.status, reinstall.stderr).toBe(0);
      for (const file of [phaseRule, agent]) {
        const restored = readFileSync(file, "utf-8");
        expect(restored, file).toContain("aidlc/spaces/team-b/memory/");
        expect(restored, file).not.toContain("aidlc/spaces/default/memory/");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("18: Cursor installer rejects symlinked managed targets and parent directories", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-symlink-"));
    try {
      const externalFile = join(root, "external-agents.md");
      writeFileSync(externalFile, "# Outside\n");
      const fileProject = join(root, "file-project");
      mkdirSync(fileProject, { recursive: true });
      symlinkSync(externalFile, join(fileProject, "AGENTS.md"));
      const fileInstall = spawnSync("bun", [join(CURSOR_ROOT, "install.ts"), fileProject], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(fileInstall.status).toBe(1);
      expect(fileInstall.stderr).toContain("symlinked installer targets");
      expect(fileInstall.stderr).toContain("AGENTS.md");
      expect(readFileSync(externalFile, "utf-8")).toBe("# Outside\n");
      expect(existsSync(join(fileProject, ".cursor", "tools"))).toBe(false);

      const externalCursor = join(root, "external-cursor");
      mkdirSync(externalCursor);
      const directoryProject = join(root, "directory-project");
      mkdirSync(directoryProject);
      symlinkSync(externalCursor, join(directoryProject, ".cursor"), "dir");
      const directoryInstall = spawnSync(
        "bun",
        [join(CURSOR_ROOT, "install.ts"), directoryProject],
        {
          cwd: REPO_ROOT,
          encoding: "utf-8",
        },
      );
      expect(directoryInstall.status).toBe(1);
      expect(directoryInstall.stderr).toContain("symlinked installer targets");
      expect(directoryInstall.stderr).toContain(".cursor");
      expect(readdirSync(externalCursor)).toEqual([]);

      const ordinaryProject = join(root, "ordinary-project");
      mkdirSync(join(ordinaryProject, "node_modules", ".bin"), { recursive: true });
      mkdirSync(join(ordinaryProject, "sub"), { recursive: true });
      symlinkSync(
        "/usr/bin/env",
        join(ordinaryProject, "node_modules", ".bin", "env-link"),
      );
      symlinkSync("/tmp", join(ordinaryProject, "sub", "tmplink"), "dir");
      const ordinaryInstall = spawnSync(
        "bun",
        [join(CURSOR_ROOT, "install.ts"), ordinaryProject],
        {
          cwd: REPO_ROOT,
          encoding: "utf-8",
        },
      );
      expect(ordinaryInstall.status, ordinaryInstall.stderr).toBe(0);
      expect(existsSync(join(ordinaryProject, ".cursor", "tools"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("19: Cursor upgrades remove unchanged obsolete files and refuse modified ones", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-obsolete-"));
    const project = join(root, "project");
    try {
      const installer = join(CURSOR_ROOT, "install.ts");
      expect(
        spawnSync("bun", [installer, project], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
        }).status,
      ).toBe(0);

      const receiptPath = join(project, ".cursor", "aidlc-install.json");
      writeFileSync(join(project, "aidlc", "active-space"), "myspace\n");
      expect(
        spawnSync("bun", [installer, project], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
        }).status,
      ).toBe(0);

      const obsoleteRel = ".cursor/rules/aidlc-legacy.mdc";
      const obsoletePath = join(project, obsoleteRel);
      const sourceBytes = readFileSync(
        join(CURSOR_ROOT, ".cursor", "rules", "aidlc.mdc"),
      );
      const activeSpaceBytes = Buffer.from(
        sourceBytes
          .toString("utf-8")
          .replaceAll(
            "aidlc/spaces/default/memory/",
            "aidlc/spaces/myspace/memory/",
          ),
      );
      writeFileSync(obsoletePath, activeSpaceBytes);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf-8")) as {
        managedFiles: Record<string, string>;
      };
      receipt.managedFiles[obsoleteRel] = createHash("sha256")
        .update(sourceBytes)
        .digest("hex");
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

      const cleanUpgrade = spawnSync("bun", [installer, project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(cleanUpgrade.status, cleanUpgrade.stderr).toBe(0);
      expect(existsSync(obsoletePath)).toBe(false);
      const refreshedReceipt = JSON.parse(readFileSync(receiptPath, "utf-8")) as {
        managedFiles: Record<string, string>;
      };
      expect(refreshedReceipt.managedFiles).not.toHaveProperty(obsoleteRel);

      writeFileSync(
        obsoletePath,
        Buffer.concat([activeSpaceBytes, Buffer.from("\n# user modification\n")]),
      );
      refreshedReceipt.managedFiles[obsoleteRel] = createHash("sha256")
        .update(sourceBytes)
        .digest("hex");
      writeFileSync(receiptPath, `${JSON.stringify(refreshedReceipt, null, 2)}\n`);
      const refused = spawnSync("bun", [installer, project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("removed upstream but modified locally");
      expect(refused.stderr).toContain(obsoleteRel);
      expect(readFileSync(obsoletePath, "utf-8")).toContain("# user modification");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("20: Cursor upgrade transfers adopted contribution ownership back to core", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-core-adopts-"));
    const project = join(root, "project");
    try {
      const installer = join(CURSOR_ROOT, "install.ts");
      expect(
        spawnSync("bun", [installer, project], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
        }).status,
      ).toBe(0);

      const stageRel =
        ".cursor/aidlc-common/stages/construction/functional-design.md";
      const stagePath = join(project, stageRel);
      const artifact = "plugin-artifact-x";
      const addArtifact = (content: string) =>
        content.replace(
          "  - entities\n",
          `  - entities\n  - ${artifact}\n`,
        );
      writeFileSync(stagePath, addArtifact(readFileSync(stagePath, "utf-8")));
      const sidecarPath = join(
        project,
        ".cursor",
        "tools",
        "data",
        "plugin-contrib-test-pro.json",
      );
      writeFileSync(
        sidecarPath,
        `${JSON.stringify(
          { "functional-design": { produces: [artifact] } },
          null,
          2,
        )}\n`,
      );

      const stagedDist = join(root, "cursor-v2");
      cpSync(CURSOR_ROOT, stagedDist, { recursive: true });
      cpSync(CURSOR_INSTALLER_SOURCE, join(stagedDist, "install.ts"));
      const stagedStage = join(stagedDist, stageRel);
      writeFileSync(stagedStage, addArtifact(readFileSync(stagedStage, "utf-8")));
      const upgrade = spawnSync("bun", [join(stagedDist, "install.ts"), project], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(upgrade.status, upgrade.stderr).toBe(0);
      expect(
        readFileSync(stagePath, "utf-8").match(new RegExp(`^  - ${artifact}$`, "gm")),
      ).toHaveLength(1);
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8")) as {
        "functional-design"?: { produces?: string[] };
      };
      expect(sidecar["functional-design"]?.produces ?? []).not.toContain(artifact);

      const pluginScopeSource = join(
        REPO_ROOT,
        "dist",
        "plugins",
        "test-pro",
        "cursor",
        "scopes",
        "test-pro-validation.md",
      );
      cpSync(
        pluginScopeSource,
        join(project, ".cursor", "scopes", "test-pro-validation.md"),
      );
      const utility = join(project, ".cursor", "tools", "aidlc-utility.ts");
      const disable = spawnSync(
        "bun",
        [utility, "select-plugins", "aidlc", "--project-dir", project],
        {
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".cursor" },
        },
      );
      expect(disable.status, disable.stderr).toBe(0);
      expect(readFileSync(stagePath, "utf-8")).toContain(`  - ${artifact}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
