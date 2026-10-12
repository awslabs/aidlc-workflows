// t240-opencode-packaging: dist/opencode determinism + shell shape.
//
// covers: file:tools/aidlc-lib.ts
//
// WHAT. Four contracts land here:
//   (1) `bun scripts/package.ts opencode --check` produces byte-identical
//       clean builds (same UX as codex's t150 test 1).
//   (2) Core parity: every .ts under dist/opencode/.aidlc/{tools,hooks}/ is
//       BYTE-IDENTICAL to its dist/claude source (the architecture-B
//       invariant: the packager may transform prose/data paths, never code).
//   (3) The .opencode/ shell carries ONLY natively-consumed emissions
//       (agents/command/plugin) and NO .ts under tools-like paths — opencode
//       auto-imports .opencode/tool(s)/*.ts as custom tool definitions, and a
//       CLI-style engine script there CRASHES the session (live-reproduced on
//       1.17.18). The engine must stay in .aidlc/.
//   (4) The emitted subagent twins carry `mode: subagent` (none may register
//       as a primary agent), native task denial, and valid active-memory paths.
//
// WHY SUBPROCESS for (1). Same idiom as t141/t150: the packager is a CLI; we
// pin its observable behavior, not its internals.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import createAdapter from "../../dist/opencode/.opencode/plugin/aidlc-opencode-adapter.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const OPENCODE_ROOT = join(REPO_ROOT, "dist", "opencode");
const ENGINE = join(OPENCODE_ROOT, ".aidlc");
const SHELL = join(OPENCODE_ROOT, ".opencode");
const ADAPTER_ENTRYPOINT_TIMEOUT_MS = NATIVE_FIXTURE_SETUP_TIMEOUT_MS;
const OPENCODE_INTENTS = join(
  OPENCODE_ROOT,
  "aidlc",
  "spaces",
  "default",
  "intents",
);

afterEach(() => {
  rmSync(join(OPENCODE_INTENTS, ".aidlc-engine/hooks-health"), {
    recursive: true,
    force: true,
  });
  try {
    rmdirSync(OPENCODE_INTENTS);
  } catch {
    // Keep a non-empty generated intents directory intact.
  }
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("t240 dist/opencode packaging parity + shell shape", () => {
  test("1: opencode package generation is deterministic", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "opencode", "--check"], {
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
      "deterministic across two independent build(s) for opencode",
    );
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("2: packaged .ts files differ only at declared projection tokens", () => {
    const divergent: string[] = [];
    for (const sub of ["tools", "hooks"]) {
      const dstDir = join(ENGINE, sub);
      for (const file of walk(dstDir)) {
        if (!file.endsWith(".ts")) continue;
        const rel = file.slice(dstDir.length + 1);
        const src = join(CLAUDE_SRC, sub, rel);
        let opencode = readFileSync(file, "utf-8");
        const claude = readFileSync(src, "utf-8");
        opencode = opencode.replaceAll(
          "bun .aidlc/tools/",
          "bun .claude/tools/",
        );
        if (rel === "aidlc-plugin.ts") {
          opencode = opencode.replace(
            '.replaceAll(".aidlc", harnessDir)',
            '.replaceAll(".claude", harnessDir)',
          );
        }
        if (opencode !== claude) divergent.push(`${sub}/${rel}`);
      }
    }
    expect(divergent).toEqual([]);
  });

  test("3: the .opencode shell holds ONLY the native emissions — no engine .ts opencode would auto-import", () => {
    // Top-level shape: exactly the three natively-consumed dirs.
    expect(readdirSync(SHELL).sort()).toEqual(["agents", "command", "plugin"]);
    // The tool-scan trap: opencode imports .opencode/tool/*.ts and
    // .opencode/tools/*.ts as custom tools. Neither dir may ever appear.
    expect(existsSync(join(SHELL, "tools"))).toBe(false);
    expect(existsSync(join(SHELL, "tool"))).toBe(false);
    // The one .ts in the shell is the adapter plugin (opencode loads plugins
    // in-process as modules, so a plugin-shaped file is safe there).
    const tsFiles = [...walk(SHELL)].filter((f) => f.endsWith(".ts"));
    expect(tsFiles).toEqual([join(SHELL, "plugin", "aidlc-opencode-adapter.ts")]);
  });

  test("4: every emitted subagent twin is mode: subagent with the projected tier keys", () => {
    const agents = readdirSync(join(SHELL, "agents")).filter((f) => f.endsWith("-agent.md"));
    expect(agents.length).toBe(14);
    for (const f of agents) {
      const raw = readFileSync(join(SHELL, "agents", f), "utf-8");
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      expect(fm, `${f}: registers as a subagent`).toMatch(/^mode: subagent$/m);
      expect(fm, `${f}: no raw tier: leak`).not.toMatch(/^tier:/m);
      expect(fm, `${f}: no inert disallowedTools leak`).not.toMatch(/^disallowedTools:/m);
      expect(fm, `${f}: native task denial`).toMatch(/^permission:\n {2}task: deny$/m);
      // Every tier inherits the session model by omission.
      const model = fm.match(/^model: (.*)$/m)?.[1];
      expect(model, `${f}: opencode model must inherit`).toBeUndefined();
      if (f === "aidlc-product-lead-agent.md") {
        expect(fm).toMatch(/^variant: medium$/m);
      }
      if (f === "aidlc-delivery-agent.md") {
        expect(model).toBeUndefined();
        expect(fm).not.toMatch(/^variant:/m);
      }
    }
  });

  test("5: opencode resolves a projected persona with task disabled", () => {
    const opencode = Bun.which("opencode");
    if (!opencode) {
      console.warn("opencode executable unavailable; raw native permission assertion still ran");
      return;
    }
    const xdg = mkdtempSync(join(tmpdir(), "t240-opencode-xdg-"));
    try {
      const project = join(xdg, "project");
      const agents = join(project, ".opencode", "agents");
      mkdirSync(agents, { recursive: true });
      copyFileSync(
        join(SHELL, "agents", "aidlc-architect-agent.md"),
        join(agents, "aidlc-architect-agent.md"),
      );
      const r = spawnSync(opencode, ["debug", "agent", "aidlc-architect-agent"], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        encoding: "utf-8",
        cwd: project,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "test",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            model: "anthropic/claude-sonnet-4-20250514",
          }),
          XDG_CACHE_HOME: join(xdg, "cache"),
          XDG_CONFIG_HOME: join(xdg, "config"),
          XDG_DATA_HOME: join(xdg, "data"),
        },
      });
      if (r.status !== 0) console.error(r.stderr);
      expect(r.status).toBe(0);
      const resolved = JSON.parse(r.stdout) as {
        permission?: Array<{ permission?: string; action?: string }>;
        tools?: Record<string, boolean>;
      };
      expect(resolved.tools?.task).toBe(false);
      expect(
        resolved.permission?.some(
          (rule) => rule.permission === "task" && rule.action === "deny",
        ),
      ).toBe(true);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test("6: inline and native personas reference the shipped active-space memory tree", () => {
    const memory = join(OPENCODE_ROOT, "aidlc", "spaces", "default", "memory");
    expect(existsSync(memory)).toBe(true);
    for (const agentsDir of [join(ENGINE, "agents"), join(SHELL, "agents")]) {
      for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md"))) {
        const raw = readFileSync(join(agentsDir, f), "utf-8");
        expect(raw, `${f}: no nonexistent rules path`).not.toContain(".aidlc/rules/");
        expect(raw, `${f}: concrete default memory pointer`).not.toContain(
          "aidlc/spaces/<active-space>/memory/",
        );
        if (
          raw.includes("organization and project guardrails") ||
          raw.includes("execution guardrails")
        ) {
          expect(raw, `${f}: projected active memory path`).toContain(
            "aidlc/spaces/default/memory/",
          );
        }
      }
    }
  });

  test("7: shipped opencode prose names no other harness's engine dir", () => {
    const r = spawnSync(
      "grep",
      ["-rn", "bun .claude/tools/", OPENCODE_ROOT],
      { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" },
    );
    // grep exits 1 on no matches — exactly what we want.
    expect(r.status).toBe(1);
  });

  test("8: the shipped opencode.json wires skills, method instructions, and the Bun tool allowlist", () => {
    const cfg = JSON.parse(readFileSync(join(OPENCODE_ROOT, "opencode.json"), "utf-8")) as {
      skills?: { paths?: string[] };
      instructions?: string[];
      permission?: {
        bash?: Record<string, string>;
        edit?: Record<string, string>;
      };
    };
    expect(cfg.skills?.paths).toContain(".aidlc/skills");
    // The method glob reads the engine's git-ignored copy of the active space's memory.
    expect(cfg.instructions).toContain("aidlc/active-memory/**/*.md");
    expect(cfg.permission?.bash?.["bun .aidlc/tools/*"]).toBe("allow");
    expect(cfg.permission?.edit?.[".aidlc/tools/**"]).toBe("ask");
    expect(cfg.permission?.edit?.[".aidlc/hooks/**"]).toBe("ask");
    // AI-DLC ships no "*" rule: the person's own opencode settings decide their
    // commands and edits; only a recursive delete and a push ask.
    expect(cfg.permission?.bash?.["*"]).toBeUndefined();
    expect(cfg.permission?.edit?.["*"]).toBeUndefined();
    expect(cfg.permission?.bash?.["rm -r*"]).toBe("ask");
    expect(cfg.permission?.bash?.["git push *"]).toBe("ask");
  });

  // opencode v1.18.18 packages/opencode/src/util/wildcard.ts match() (the same
  // in v1.18.34 packages/core): `*` is anything, anchored at both ends, and a
  // pattern ending in " *" also matches the command alone; the last matching
  // rule decides (permission/index.ts evaluate), none means opencode's own default.
  function opencodeMatch(command: string, pattern: string): boolean {
    let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
    return new RegExp(`^${escaped}$`, "s").test(command);
  }

  test("8b: the shipped asks catch a recursive delete and a push, nothing else, and never AI-DLC's own command", () => {
    const cfg = JSON.parse(readFileSync(join(OPENCODE_ROOT, "opencode.json"), "utf-8")) as {
      permission: { bash: Record<string, string> };
    };
    const rules = Object.entries(cfg.permission.bash);
    const decide = (command: string) => rules.filter(([pattern]) => opencodeMatch(command, pattern)).at(-1)?.[1];
    for (const command of [
      "rm -rf dist", "rm -rf", "rm -r dist", "rm -rfv dist", "rm -rf dist 2>/dev/null",
      "git push", "git push origin main", "git push --force-with-lease",
    ]) {
      expect(decide(command), command).toBe("ask");
    }
    for (const command of [
      "rm file.txt", "rm -f file.txt", "rm -- -rfile", "rmdir dist",
      "git pushx", "git log --oneline", "bun test", "bun src/app.js", "ls -la",
    ]) {
      expect(decide(command), command).toBeUndefined();
    }
    expect(decide("bun .aidlc/tools/aidlc.ts engine orchestrate next")).toBe("allow");
  });

  test("10b: doctor says once, as a warning, when the person's global opencode config holds a short-form permission rule", () => {
    const root = mkdtempSync(join(tmpdir(), "t240-opencode-global-"));
    try {
      const project = join(root, "project");
      cpSync(OPENCODE_ROOT, project, { recursive: true });
      const home = join(root, "home");
      const file = join(home, ".config", "opencode", "opencode.jsonc");
      mkdirSync(join(home, ".config", "opencode"), { recursive: true });
      const doctor = () => spawnSync(
        "bun",
        [join(project, ".aidlc", "tools", "aidlc-utility.ts"), "doctor", "--verbose", "--project-dir", project],
        {
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".aidlc", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
        },
      );
      const text = '{\n  // the person\x27s own file\n  "permission": { "bash": "ask" },\n}\n';
      writeFileSync(file, text);
      const seen = doctor();
      // The file as the person sees it: "~/..." on Linux and macOS, the full path on Windows.
      const shownFile = platform() === "win32" ? file : "~/.config/opencode/opencode.jsonc";
      const line = `Your opencode setting asks before every shell command; in this project AI-DLC\x27s permission rules replace that short form. To keep asking, write it as "bash": {"*": "ask"} in ${shownFile}.`;
      expect(seen.stdout.split(line).length - 1, seen.stdout).toBe(1);
      const row = seen.stdout.split(/\r?\n/).find((candidate) => candidate.includes(line));
      expect(row ?? "").toMatch(/^\s*warn\s/);
      expect(readFileSync(file, "utf-8")).toBe(text);
      writeFileSync(file, '{ "permission": { "bash": { "*": "ask" } } }');
      expect(doctor().stdout).not.toContain("Your opencode setting");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Each allowed bash call continues through two real core-hook subprocesses.
  // Under cross-runner load the full shipped-entrypoint sweep can exceed Bun's
  // 5s default even though every boundary assertion succeeds.
  test("9: the adapter embeds exactly the shipped tool and hook entrypoints", async () => {
    const moduleExports = await import(
      "../../dist/opencode/.opencode/plugin/aidlc-opencode-adapter.ts"
    );
    expect(Object.keys(moduleExports)).toEqual(["default"]);

    const adapterHooks = await createAdapter({
      client: {
        session: {
          get: async () => ({ data: {} }),
          prompt: async () => {},
        },
      },
      directory: OPENCODE_ROOT,
    });
    const before = adapterHooks["tool.execute.before"];
    await expect(
      before(
        { tool: "bash", sessionID: "main", callID: "direct" },
        {
          args: {
            command: "bun .aidlc/tools/aidlc.ts engine state approve",
          },
        },
      ),
    ).rejects.toThrow(/Stage status cannot be changed with aidlc-state\.ts approve/i);
  }, ADAPTER_ENTRYPOINT_TIMEOUT_MS);

  test("10: doctor accepts an opencode.jsonc-only install", () => {
    const root = mkdtempSync(join(tmpdir(), "t240-opencode-doctor-"));
    try {
      const project = join(root, "project");
      cpSync(OPENCODE_ROOT, project, { recursive: true });
      renameSync(join(project, "opencode.json"), join(project, "opencode.jsonc"));
      const r = spawnSync(
        "bun",
        [
          join(project, ".aidlc", "tools", "aidlc-utility.ts"),
          "doctor",
          "--verbose",
          "--project-dir",
          project,
        ],
        {
          timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".aidlc" },
        },
      );
      expect(r.stdout).toContain(
        "ok    opencode.json or opencode.jsonc present (permissions + method instructions glob)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The /aidlc command carries the skill whole. opencode cuts any tool output
  // over 50 KiB (its skill tool included) and saves the rest in its own data
  // folder, so a skill loaded through that tool lost its last 180 lines in
  // every chat. A command template's text is not cut, and opencode runs a
  // !`...` line in it at command time, so the command prints the installed
  // skill into itself through the engine's own read-only verb.
  test("11: the /aidlc command prints the installed skill into itself, whole", () => {
    const command = readFileSync(join(SHELL, "command", "aidlc.md"), "utf-8");
    expect(command).toContain("!`bun .aidlc/tools/aidlc.ts engine skill-text --harness-dir .aidlc`");
    expect(command).toContain("$ARGUMENTS");
    expect(command).not.toContain("Invoke the `aidlc` skill");
    // The native channel spells the same line with the installed launcher.
    const release = readFileSync(
      join(REPO_ROOT, "dist-release", "opencode", ".opencode", "command", "aidlc.md"),
      "utf-8",
    );
    expect(release).toContain("!`aidlc engine skill-text --harness-dir .aidlc`");
    expect(release).not.toContain("{{INVOKE}}");
    // What the line prints, run the way opencode runs it (from the project
    // folder, no --project-dir): the shipped skill, byte for byte, and longer
    // than opencode's 50 KiB tool-output cut.
    const r = spawnSync(
      process.execPath,
      [join(ENGINE, "tools", "aidlc.ts"), "engine", "skill-text", "--harness-dir", ".aidlc"],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        cwd: OPENCODE_ROOT,
        encoding: "utf-8",
        env: withoutHarnessEnv(),
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const skill = readFileSync(join(ENGINE, "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(r.stdout).toBe(skill.endsWith("\n") ? skill : `${skill}\n`);
    expect(Buffer.byteLength(r.stdout, "utf-8")).toBeGreaterThan(50 * 1024);
  });

  // Claude Code and opencode may share one project (the lifecycle guide's
  // coexistence rule). The native launcher resolves a harness by precedence,
  // `.claude` before `.aidlc`, so the opencode command names its own harness:
  // with `--harness-dir .aidlc` the verb prints opencode's skill even when it
  // runs from the Claude Code tools under a launcher that is not Bun by name
  // (a copy of Bun named aidlc stands in for the compiled executable; under
  // the name bun the tool's own tree always wins, so the flag shows only here).
  test("12: --harness-dir picks the opencode skill in a project that also has Claude Code", () => {
    const root = mkdtempSync(join(tmpdir(), "t240-two-trees-"));
    try {
      const project = join(root, "project");
      cpSync(CLAUDE_SRC, join(project, ".claude"), { recursive: true });
      cpSync(ENGINE, join(project, ".aidlc"), { recursive: true });
      const launcher = join(root, process.platform === "win32" ? "aidlc.exe" : "aidlc");
      try {
        linkSync(process.execPath, launcher);
      } catch {
        copyFileSync(process.execPath, launcher);
      }
      const claudeSkill = readFileSync(join(project, ".claude", "skills", "aidlc", "SKILL.md"), "utf-8");
      const opencodeSkill = readFileSync(join(project, ".aidlc", "skills", "aidlc", "SKILL.md"), "utf-8");
      expect(claudeSkill).not.toBe(opencodeSkill);
      const run = (...args: string[]) =>
        spawnSync(
          launcher,
          [join(project, ".claude", "tools", "aidlc-utility.ts"), "skill-text", "--project-dir", project, ...args],
          {
            timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
            cwd: project,
            encoding: "utf-8",
            env: withoutHarnessEnv(),
          },
        );
      const named = run("--harness-dir", ".aidlc");
      expect(named.status, named.stderr).toBe(0);
      expect(named.stdout).toBe(opencodeSkill.endsWith("\n") ? opencodeSkill : `${opencodeSkill}\n`);
      const ambient = run();
      expect(ambient.status, ambient.stderr).toBe(0);
      expect(ambient.stdout).toBe(claudeSkill.endsWith("\n") ? claudeSkill : `${claudeSkill}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// The environment a person's shell gives the launcher: no AI-DLC harness or
// runtime-root selector left over from this test process.
function withoutHarnessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AIDLC_HARNESS_DIR;
  delete env.AIDLC_RUNTIME_ROOT;
  delete env.AIDLC_RUNTIME_HARNESS_ROOT;
  return env;
}
