// t275-cursor-packaging: dist/cursor determinism + shell shape.
//
// covers: file:tools/aidlc-lib.ts, function:runnerFrontmatterAdditions
//
// WHAT. Six contracts land here:
//   (1) `bun scripts/package.ts cursor --check` produces byte-identical clean
//       builds (same UX as opencode's t240 test 1).
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
//   (6) Outside a git repository, where Cursor may skip project hooks
//       (issue #976), config, the copy installer, and the doctor all name
//       `git init`; inside one, subfolders included, they stay quiet.
//
// WHY SUBPROCESS for (1). Same idiom as t141/t150/t240: the packager is a
// CLI; we pin its observable behavior, not its internals.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { copyChannelDispatcherCommands, copyChannelToolScripts, machineReachingTools, resolveAction } from "../../core/tools/aidlc.ts";
import { RECORDABLE_PROJECT_BYPASSES } from "../../core/tools/aidlc-settings.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const CURSOR_ROOT = join(REPO_ROOT, "dist", "cursor");
const CURSOR_RELEASE_ROOT = join(REPO_ROOT, "dist-release", "cursor");
const ENGINE = join(CURSOR_ROOT, ".cursor");
const CURSOR_INSTALLER_SOURCE = join(REPO_ROOT, "harness", "cursor", "install.ts");
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("t275 dist/cursor packaging parity + shell shape", () => {
  test("1: cursor package generation is deterministic", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "cursor", "--check"], {
      timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
    if (r.status !== 0) {
      // Surface the script's path-level mismatch list.
      console.error(r.stderr);
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "deterministic across two independent build(s) for cursor",
    );
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("2: packaged .ts files differ only at declared projection tokens", () => {
    const divergent: string[] = [];
    for (const sub of ["tools", "hooks"]) {
      const dstDir = join(ENGINE, sub);
      for (const file of walk(dstDir)) {
        if (!file.endsWith(".ts")) continue;
        const rel = file.slice(dstDir.length + 1);
        // The adapter is AUTHORED for this harness - no Claude twin exists.
        if (rel === "aidlc-cursor-adapter.ts") continue;
        const src = join(CLAUDE_SRC, sub, rel);
        const cursor = readFileSync(file, "utf-8").replaceAll(
          "bun .cursor/tools/aidlc.ts",
          "bun .claude/tools/aidlc.ts",
        );
        if (cursor !== readFileSync(src, "utf-8")) divergent.push(`${sub}/${rel}`);
      }
    }
    expect(divergent).toEqual([]);
  });

  test("3: rules/ splits always-applied standing layers from agent-decided phase layers", () => {
    // Cursor loads ONLY .mdc from .cursor/rules/ (live-verified: a plain .md
    // there is silently ignored). Anything else in the dir is a shipping bug.
    const rules = readdirSync(join(ENGINE, "rules")).sort();
    expect(rules).toEqual([
      "aidlc-onboarding.mdc",
      "aidlc-phase-construction.mdc",
      "aidlc-phase-ideation.mdc",
      "aidlc-phase-inception.mdc",
      "aidlc-phase-operation.mdc",
      "aidlc.mdc",
    ]);
    expect(readFileSync(join(ENGINE, "rules", "aidlc-onboarding.mdc"), "utf-8"))
      .toMatch(/^---\ndescription: AI-DLC onboarding for Cursor\nalwaysApply: true\n---/);
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

  const SHIPPED_ALLOW = [
    "Shell(bun:.cursor/tools/aidlc.ts engine *)",
    ...copyChannelDispatcherCommands().map((command) => `Shell(bun:.cursor/tools/aidlc.ts ${command})`),
    ...copyChannelToolScripts().flatMap((tool) => [`Shell(bun:.cursor/tools/${tool})`, `Shell(bun:.cursor/tools/${tool} *)`]),
  ];
  const SHIPPED_DENY: string[] = [];

  test("6: cli.json pre-approves only AI-DLC's own workflow commands at the project level", () => {
    const cli = JSON.parse(readFileSync(join(ENGINE, "cli.json"), "utf-8")) as {
      permissions?: { allow?: string[]; deny?: string[] };
    };
    // Project-level cli.json is permissions-only (Cursor's documented
    // contract); the shipped allowlist is the dispatcher's engine namespace,
    // its doctor, version, status and read-only config forms exactly as
    // AI-DLC runs them, and each of AI-DLC's tool scripts but the ones behind
    // a machine-changing command, nothing else bun can run.
    expect(cli.permissions?.allow).toEqual(SHIPPED_ALLOW);
    expect(cli.permissions?.deny).toEqual(SHIPPED_DENY);
    expect(machineReachingTools()).toEqual(expect.arrayContaining(["aidlc-lifecycle.ts", "aidlc-machine-config.ts"]));
    for (const tool of machineReachingTools()) {
      expect(cli.permissions?.allow?.some((entry) => entry.includes(tool)), tool).toBe(false);
    }
  });

  // Cursor CLI's documented matching: `Shell(commandBase:args)`, the command's
  // first token against commandBase and the rest against the args glob (`*`
  // matches any text); deny beats allow; a command no entry names asks.
  function cursorShellEffect(cli: { allow: string[]; deny: string[] }, command: string): "deny" | "allow" | "ask" {
    const [base, ...rest] = command.split(" ");
    const args = rest.join(" ");
    const hits = (entries: string[]) => entries.some((entry) => {
      const m = /^Shell\(([^:)]+)(?::(.*))?\)$/.exec(entry);
      if (!m || m[1] !== base) return false;
      if (m[2] === undefined) return true;
      const glob = m[2].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
      return new RegExp(`^${glob}$`).test(args);
    });
    if (hits(cli.deny)) return "deny";
    return hits(cli.allow) ? "allow" : "ask";
  }

  test("6b: AI-DLC's own commands run with no prompt; anything that changes the machine or a setting shows Cursor's prompt", () => {
    const cli = { allow: SHIPPED_ALLOW, deny: SHIPPED_DENY };
    for (const command of [
      "bun .cursor/tools/aidlc.ts engine orchestrate next",
      "bun .cursor/tools/aidlc.ts engine orchestrate report --stage requirements-analysis --result approved --user-input 'Approve (Recommended)'",
      "bun .cursor/tools/aidlc.ts config models --show --json",
      "bun .cursor/tools/aidlc.ts config providers --help",
      "bun .cursor/tools/aidlc.ts doctor",
      "bun .cursor/tools/aidlc.ts version",
      "bun .cursor/tools/aidlc.ts --doctor",
      "bun .cursor/tools/aidlc.ts status",
      "bun .cursor/tools/aidlc-utility.ts",
      "bun .cursor/tools/aidlc-utility.ts codekb-path",
      "bun .cursor/tools/aidlc-log.ts answers --stage x",
      // Turning a recorded check back on, in the one form the skills name.
      ...RECORDABLE_PROJECT_BYPASSES.map((name) => `bun .cursor/tools/aidlc.ts config flags --clear-bypass ${name} --yes`),
    ]) {
      expect(cursorShellEffect(cli, command), command).toBe("allow");
    }
    // The verbs and the scripts behind them fall to Cursor's own prompt.
    for (const command of [
      "bun .cursor/tools/aidlc.ts use 2.10.0",
      "bun .cursor/tools/aidlc.ts update",
      "bun .cursor/tools/aidlc.ts rollback",
      "bun .cursor/tools/aidlc.ts uninstall --yes",
      "bun .cursor/tools/aidlc.ts system config global set offline on",
      "bun .cursor/tools/aidlc.ts --yes update",
      ...machineReachingTools().map((tool) => `bun .cursor/tools/${tool} use 2.10.0`),
      // Any config change, a machine-wide flag however it is spelled included,
      // and a read that only looks like the shipped forms.
      "bun .cursor/tools/aidlc.ts config --pin 2.10.0",
      "bun .cursor/tools/aidlc.ts config --unpin",
      "bun .cursor/tools/aidlc.ts config --channel",
      "bun .cursor/tools/aidlc.ts config --channel preview",
      "bun .cursor/tools/aidlc.ts config project --plugins all --download --yes",
      "bun .cursor/tools/aidlc.ts config models --deciding-effort high --global --yes",
      'bun .cursor/tools/aidlc.ts config models --deciding-effort high --gl"obal" --yes',
      "bun .cursor/tools/aidlc.ts config models --deciding-effort high --project --yes",
      "bun .cursor/tools/aidlc.ts config models --show --json --global",
      "bun .cursor/tools/aidlc.ts doctor --fix",
      // Turning a check off, and a form that changes something else as well.
      "bun .cursor/tools/aidlc.ts config flags --bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --local --yes",
      "bun .cursor/tools/aidlc.ts config flags --bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes",
      "bun .cursor/tools/aidlc.ts config flags --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --bypass AIDLC_DISABLE_SENSORS --yes",
      "bun .cursor/tools/aidlc.ts config flags --bypass AIDLC_DISABLE_SENSORS --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes",
      "bun .cursor/tools/aidlc.ts config flags --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes --bypass AIDLC_DISABLE_SENSORS",
      "bun .cursor/tools/aidlc.ts config flags --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes --question-retention-days 1",
      "bun .cursor/tools/aidlc.ts config flags --clear-bypass AIDLC_DISABLE_REVIEW_FREEZE_HOOK --yes --global",
      "bun .cursor/tools/aidlc.ts config flags --clear-bypass AIDLC_NOT_A_SWITCH --yes",
      // A file whose name only starts with a tool script's.
      "bun .cursor/tools/aidlc-log.tsx answers --stage x",
      "bun .cursor/tools/aidlc-log.ts.bak answers --stage x",
    ]) {
      expect(cursorShellEffect(cli, command), command).toBe("ask");
    }
  });

  test("7: shipped cursor prose names no other harness's engine dir", () => {
    const r = spawnSync("grep", ["-rn", "bun .claude/tools/", CURSOR_ROOT], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
        [
          join(project, ".cursor", "tools", "aidlc-utility.ts"),
          "doctor",
          "--verbose",
          "--project-dir",
          project,
        ],
        {
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".cursor" },
        },
      );
      expect(r.stdout).toContain("ok    aidlc-cursor-adapter.ts present");
      expect(r.stdout).toContain("ok    hooks.json present (hook wiring)");
      expect(r.stdout).toContain("ok    cli.json present (AI-DLC command permission pre-approval)");
      expect(r.stdout).toContain(
        "ok    rules/aidlc.mdc present (standing method rule (alwaysApply read instruction))",
      );
      for (const phase of ["Ideation", "Inception", "Construction", "Operation"]) {
        expect(r.stdout).toContain(
          `ok    rules/aidlc-phase-${phase.toLowerCase()}.mdc present (${phase} phase rule (agent-decided read instruction))`,
        );
      }
      // When Cursor refuses every tool call because the hooks cannot start,
      // the always-applied rule sends the person here: this doctor run prints
      // the Runtime hook PATH line the rule names, and `aidlc doctor` routes.
      expect(r.stdout).toContain("Runtime hook PATH");
      // Each install names its own doctor: the copied one runs it through Bun.
      for (const [tree, doctor] of [
        [CURSOR_ROOT, "run `bun .cursor/tools/aidlc.ts doctor` (after installing Bun from https://bun.sh/install if `bun` is not found),"],
        [CURSOR_RELEASE_ROOT, "run `aidlc doctor`,"],
      ] as const) {
        const standing = readFileSync(join(tree, ".cursor", "rules", "aidlc.mdc"), "utf-8");
        expect(standing, tree).toContain("If every tool call here is refused before it runs");
        expect(standing, tree).toContain(`${doctor}\nwhose Runtime hook PATH line names what to fix`);
        expect(standing, tree).not.toContain("bun --version");
        expect(standing, tree).toContain("quit Cursor fully and\nopen this folder again");
      }
      expect(resolveAction(["doctor"]).type).not.toBe("error");
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
          // Shell(bun) is the entry earlier releases shipped; refresh drops it.
          permissions: { allow: ["Shell(git)", "Shell(bun)"], deny: ["Shell(rm)"] },
          projectSetting: true,
        }, null, 2)}\n`,
      );
      writeFileSync(join(cursorDir, ".gitignore"), "project-cursor-cache\n");
      writeFileSync(join(project, "AGENTS.md"), "# Project instructions\n");
      writeFileSync(join(project, ".gitignore"), "coverage/\n");

      const install = spawnSync("bun", [join(CURSOR_ROOT, "install.ts"), project], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
      expect(cli.permissions.allow).toEqual(["Shell(git)", ...SHIPPED_ALLOW]);
      expect(cli.permissions.deny).toEqual(["Shell(rm)", ...SHIPPED_DENY]);
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(readFileSync(join(cursorDir, "hooks.json"), "utf-8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("9b: native Cursor installer replaces legacy adapter wiring without duplication", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-native-hook-upgrade-"));
    const project = join(root, "project");
    try {
      const cursorDir = join(project, ".cursor");
      mkdirSync(cursorDir, { recursive: true });
      // A project refreshed across releases carries BOTH legacy spellings of
      // the AI-DLC guards entry (bun-era copy channel, then 2.8.0 native), with
      // a project-owned hook between them. Only the AI-DLC entries are owned:
      // both collapse into one canonical entry at the first one's position and
      // the project's hook is untouched.
      const userEntry = { command: "bun scripts/my-guard.ts guards", failClosed: false };
      writeFileSync(
        join(cursorDir, "hooks.json"),
        `${JSON.stringify({
          version: 1,
          hooks: {
            preToolUse: [
              {
                command: "bun .cursor/hooks/aidlc-cursor-adapter.ts guards",
                failClosed: true,
              },
              userEntry,
              {
                command: "aidlc engine hook cursor-adapter guards",
                failClosed: true,
              },
            ],
          },
        }, null, 2)}\n`,
      );

      const install = spawnSync(
        "bun",
        [join(CURSOR_RELEASE_ROOT, "install.ts"), project],
        {
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          cwd: REPO_ROOT,
          encoding: "utf-8",
        },
      );
      expect(install.status, install.stderr).toBe(0);

      const hooks = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf-8")) as {
        hooks: Record<string, Array<{ command: string; failClosed?: boolean }>>;
      };
      expect(hooks.hooks.preToolUse).toEqual([
        {
          command: "aidlc engine adapter cursor guards",
          failClosed: true,
        },
        userEntry,
      ]);
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

  test("10b: Cursor installer refuses aidlc config managed blocks before copying", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-install-config-owned-"));
    try {
      for (const [file, block] of [
        ["AGENTS.md", "<!-- BEGIN AI-DLC:agents -->\n# AI-DLC\n<!-- END AI-DLC:agents -->\n"],
        [".gitignore", "# BEGIN AI-DLC:gitignore\naidlc/active-space\n# END AI-DLC:gitignore\n"],
      ]) {
        const project = join(root, file);
        mkdirSync(project);
        writeFileSync(join(project, file), block);
        const install = spawnSync("bun", [join(CURSOR_ROOT, "install.ts"), project], {
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          cwd: REPO_ROOT,
          encoding: "utf-8",
        });
        expect(install.status).toBe(1);
        expect(install.stderr).toContain(
          `refusing to install: ${file} already carries an AI-DLC managed block owned by aidlc config; use \`aidlc config --harness cursor\` to add Cursor to this project`,
        );
        expect(readFileSync(join(project, file), "utf-8")).toBe(block);
        expect(existsSync(join(project, ".cursor"))).toBe(false);
        expect(readdirSync(project)).toEqual([file]);
      }
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(install.status).toBe(1);
      expect(install.stderr).toContain("refusing to overwrite");
      expect(install.stderr).toContain(".cursor/rules/aidlc.mdc");
      expect(install.stderr).toContain(
        "To keep your changes, move these files somewhere else, then run the installer again.",
      );
      expect(readFileSync(join(project, "AGENTS.md"), "utf-8")).toBe("# Keep me\n");
      expect(existsSync(join(project, ".cursor", "tools"))).toBe(false);
      // The step it names: with the file moved aside, the installer runs.
      renameSync(join(project, ".cursor", "rules", "aidlc.mdc"), join(project, "my-aidlc.mdc"));
      const again = spawnSync("bun", [join(CURSOR_ROOT, "install.ts"), project], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(again.status, again.stderr).toBe(0);
      expect(existsSync(join(project, ".cursor", "tools"))).toBe(true);
      expect(readFileSync(join(project, "my-aidlc.mdc"), "utf-8")).toBe("project-owned\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("12: Cursor install docs use the merge-aware installer", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf-8");
    expect(readme).toContain("aidlc config --harness cursor");
    expect(readme).not.toContain("cp -R dist/cursor/.cursor");
    expect(readme).not.toContain("cp dist/cursor/AGENTS.md");

    const guide = readFileSync(
      join(REPO_ROOT, "docs", "guide", "harnesses", "cursor.md"),
      "utf-8",
    );
    expect(guide).toContain('bun "$RUNTIME_ROOT/cursor/install.ts" your-project');
    expect(guide).not.toContain("cp -R dist/cursor/.cursor");
    expect(guide).not.toContain("cp dist/cursor/AGENTS.md");
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(first.status, first.stderr).toBe(0);

      const utility = join(project, ".cursor", "tools", "aidlc-utility.ts");
      const utilityEnv = { ...process.env, AIDLC_HARNESS_DIR: ".cursor" };
      const create = spawnSync(
        "bun",
        [utility, "space-create", "team-b", "--project-dir", project],
        { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: project, encoding: "utf-8", env: utilityEnv },
      );
      expect(create.status, create.stderr).toBe(0);
      const switchSpace = spawnSync(
        "bun",
        [utility, "space", "team-b", "--project-dir", project],
        { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: project, encoding: "utf-8", env: utilityEnv },
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
      expect(
        readFileSync(join(project, ".cursor", "rules", "aidlc-onboarding.mdc"), "utf-8"),
      ).toContain("aidlc/spaces/<space>/memory/");
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(first.status, first.stderr).toBe(0);

      const utility = join(project, ".cursor", "tools", "aidlc-utility.ts");
      const selected = spawnSync(
        "bun",
        [utility, "select-plugins", "aidlc", "--project-dir", project],
        {
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
          { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: project, encoding: "utf-8", env },
        ).status,
      ).toBe(0);
      expect(
        spawnSync(
          "bun",
          [utility, "space", "team-b", "--project-dir", project],
          { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: project, encoding: "utf-8", env },
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(fileInstall.status).toBe(1);
      expect(fileInstall.stderr).toContain("symlinked installer targets");
      expect(fileInstall.stderr).toContain("AGENTS.md");
      expect(fileInstall.stderr).toContain(
        "Replace that link with a regular file or folder, then run the installer again.",
      );
      expect(readFileSync(externalFile, "utf-8")).toBe("# Outside\n");
      expect(existsSync(join(fileProject, ".cursor", "tools"))).toBe(false);
      // The step it names: with a regular file in place of the link, it runs.
      unlinkSync(join(fileProject, "AGENTS.md"));
      writeFileSync(join(fileProject, "AGENTS.md"), "# Outside\n");
      const replaced = spawnSync("bun", [join(CURSOR_ROOT, "install.ts"), fileProject], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(replaced.status, replaced.stderr).toBe(0);
      expect(readFileSync(externalFile, "utf-8")).toBe("# Outside\n");

      const externalCursor = join(root, "external-cursor");
      mkdirSync(externalCursor);
      const directoryProject = join(root, "directory-project");
      mkdirSync(directoryProject);
      symlinkSync(externalCursor, join(directoryProject, ".cursor"), "dir");
      const directoryInstall = spawnSync(
        "bun",
        [join(CURSOR_ROOT, "install.ts"), directoryProject],
        {
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          cwd: REPO_ROOT,
          encoding: "utf-8",
        }).status,
      ).toBe(0);

      const receiptPath = join(project, ".cursor", "aidlc-install.json");
      // The pointer names a space only when the project has it.
      mkdirSync(join(project, "aidlc", "spaces", "myspace", "memory"), { recursive: true });
      writeFileSync(join(project, "aidlc", "active-space"), "myspace\n");
      expect(
        spawnSync("bun", [installer, project], {
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
        ).replace(
          "produces_kinds:\n",
          `produces_kinds:\n  ${artifact}: [service, spec, ui, library]\n`,
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
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS); // Three CLI steps plus a distribution copy need a bounded Windows startup allowance.

  test("21: outside a git repository, config, the copy installer, and doctor all name git init", () => {
    const root = mkdtempSync(join(tmpdir(), "t275-cursor-git-"));
    const run = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
      spawnSync("bun", args, {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd,
        encoding: "utf-8",
        env: { ...process.env, ...env },
      });
    try {
      const repo = join(root, "repo");
      mkdirSync(repo);
      expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
      // The plain folder carries an empty .git, which git does not count as a
      // repository; the git case is a subfolder, which counts.
      for (const [base, inGit] of [[join(root, "plain"), false], [join(repo, "packages"), true]] as const) {
        const configured = join(base, "configured");
        const copied = join(base, "copied");
        mkdirSync(configured, { recursive: true });
        mkdirSync(copied, { recursive: true });
        if (!inGit) mkdirSync(join(base, ".git"));
        const config = run([
          INIT, "config", "--project-dir", configured, "--from", CURSOR_RELEASE_ROOT,
          "--harness", "cursor", "--mcp", "none",
        ], configured);
        expect(config.status, config.stdout + config.stderr).toBe(0);
        const install = run([join(CURSOR_ROOT, "install.ts"), copied], REPO_ROOT);
        expect(install.status, install.stderr).toBe(0);
        const doctor = run(
          [join(copied, ".cursor", "tools", "aidlc-utility.ts"), "doctor", "--verbose", "--project-dir", copied],
          copied,
          { AIDLC_HARNESS_DIR: ".cursor" },
        );
        if (inGit) {
          expect(config.stdout).toContain("next: open this project in Cursor, then run `/aidlc --doctor`");
          expect(config.stdout).not.toContain("git init");
          expect(install.stdout).not.toContain("git init");
          expect(doctor.stdout).toMatch(/ok\s+project is in a git repository/);
        } else {
          expect(config.stdout).toContain(
            "next: run `git init` in this project, then open it in Cursor and trust it (fully restart Cursor if it is already open), then run `/aidlc --doctor`",
          );
          expect(config.stdout).toContain("Note: This project is not in a git repository.");
          expect(install.stdout).toContain("Run `git init` in it before opening it in Cursor");
          expect(doctor.stdout).toMatch(/fail\s+project is in a git repository/);
          expect(doctor.stdout).toContain("fix: run `git init` in this project, then fully restart Cursor");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS); // Two configs, two installs, and two doctors need a bounded Windows startup allowance.
});
