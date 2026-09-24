// t150-codex-packaging: dist/codex determinism + trust-seed recipe.
//
// covers: file:tools/aidlc-lib.ts
//
// WHAT. Three contracts land here:
//   (1) `bun scripts/package.ts codex --check` produces byte-identical clean
//       builds, including the single sanctioned prefix-transform class.
//   (2) Core parity: every .ts under dist/codex/.codex/tools/ and the core
//       hook bodies are BYTE-IDENTICAL to their dist/claude sources, except
//       for aidlc-runtime-paths.ts's single projected invocation constant.
//   (3) The S9a trust-hash recipe in the packager reproduces the hash the
//       spike recorded live (findings §S9a) — the installer pre-seed is only
//       sound while this stays true.
//
// WHY SUBPROCESS. Same idiom as kiro's t141: the packager is a CLI; we pin
// its observable behavior, not its internals.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse } from "smol-toml";
import { TRUSTED_ROUTE_NAMESPACE } from "../../core/tools/aidlc-command.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const CODEX_DST = join(REPO_ROOT, "dist", "codex", ".codex");
const TRUST_SUFFIXES = [
  "session_start:0:0",
  "user_prompt_submit:0:0",
  "pre_tool_use:0:0",
  "pre_tool_use:1:0",
  "pre_tool_use:2:0",
  "pre_tool_use:3:0",
  "pre_tool_use:4:0",
  "pre_tool_use:5:0",
  "post_tool_use:0:0",
  "post_tool_use:1:0",
  "post_tool_use:2:0",
  "post_tool_use:3:0",
  "pre_compact:0:0",
  "subagent_stop:0:0",
  "stop:0:0",
] as const;

type TrustDocument = {
  hooks: {
    state: Record<string, { trusted_hash: string }>;
  };
};

type TrustEntries = (
  project: string,
  hooksJson?: string,
  harnessDir?: string,
  harnessName?: string,
  invoke?: string,
) => string;

const SOURCE_INVOKE = "bun .codex/tools/aidlc.ts";

function parseTrustDocument(source: string): TrustDocument {
  return parse(source) as unknown as TrustDocument;
}

function trustEntries(): TrustEntries {
  const emitter = require(join(REPO_ROOT, "harness", "codex", "emit.ts")) as {
    trustEntries: (...args: [
      string,
      string | undefined,
      string,
      string,
      string,
      string,
    ]) => string;
  };
  return (
    project,
    hooksJson,
    harnessDir = ".codex",
    harnessName = "codex",
    invoke = "aidlc",
  ) => emitter.trustEntries(
    project,
    hooksJson,
    harnessDir,
    harnessName,
    invoke,
    TRUSTED_ROUTE_NAMESPACE,
  );
}

function expectedTrustKeys(hooksJsonPath: string): string[] {
  return TRUST_SUFFIXES.map((suffix) => `${hooksJsonPath}:${suffix}`);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function runDoctorWithCodexVersion(version: string): {
  status: number;
  output: string;
} {
  const root = mkdtempSync(join(tmpdir(), "t150-codex-version-"));
  try {
    const project = join(root, "project");
    cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(project, ".codex"), {
      recursive: true,
    });
    cpSync(join(REPO_ROOT, "dist", "codex", "aidlc"), join(project, "aidlc"), {
      recursive: true,
    });

    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    if (process.platform === "win32") {
      // The doctor executes the resolved path without a shell. Node-compatible
      // spawnSync rejects .cmd files; use a small native CLI (as in t255).
      const source = join(binDir, "codex.cs");
      const executable = join(binDir, "codex.exe");
      writeFileSync(source, `using System;
public static class CodexVersionFixture {
  public static int Main(string[] args) {
    if (args.Length != 1 || args[0] != "--version") return 2;
    Console.WriteLine(${JSON.stringify(`codex-cli ${version}`)});
    return 0;
  }
}
`);
      const compiler = join(
        process.env.WINDIR ?? "C:\\Windows",
        "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe",
      );
      const compiled = spawnSync(
        compiler,
        ["/nologo", "/optimize+", "/target:exe", `/out:${executable}`, source],
        { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) },
      );
      if (compiled.error || compiled.status !== 0) {
        throw new Error(`Codex fixture compile failed: ${compiled.error?.message || compiled.stderr || compiled.stdout}`);
      }
      const probe = spawnSync(executable, ["--version"], { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
      expect(probe.error).toBeUndefined();
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout.trim()).toBe(`codex-cli ${version}`);
    } else {
      const fakeCodex = join(binDir, "codex");
      writeFileSync(fakeCodex, `#!/bin/sh\necho "codex-cli ${version}"\n`);
      chmodSync(fakeCodex, 0o755);
    }

    const tool = join(project, ".codex", "tools", "aidlc-utility.ts");
    const result = spawnSync(
      process.execPath,
      [tool, "doctor", "--verbose", "--project-dir", project],
      {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: project,
      encoding: "utf-8",
      env: {
        ...process.env,
        // The version-floor fixture exercises copied source, not the host install.
        AIDLC_INSTALL_ROOT: join(root, "install"),
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
      },
    );
    return {
      status: result.status ?? -1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("t150 dist/codex packaging determinism + trust", () => {
  test("1: codex package generation is deterministic", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "codex", "--check"], {
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
      "deterministic across two independent build(s) for codex",
    );
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("2: packaged .ts files differ only at declared projection tokens", () => {
    // tools/ + hooks/ carry the deterministic core. The codex adapter
    // (authored shell, aidlc-codex-*.ts) has no claude counterpart and is
    // exempt. Harness-local Bun paths are the declared source projection.
    const divergent: string[] = [];
    for (const sub of ["tools", "hooks"]) {
      const dstDir = join(CODEX_DST, sub);
      for (const file of walk(dstDir)) {
        if (!file.endsWith(".ts")) continue;
        if (/aidlc-codex-[^/]+\.ts$/.test(file)) continue;
        const rel = file.slice(dstDir.length + 1);
        const src = join(CLAUDE_SRC, sub, rel);
        let codex = readFileSync(file, "utf-8");
        const claude = readFileSync(src, "utf-8");
        codex = codex.replaceAll(
          "bun .codex/tools/",
          "bun .claude/tools/",
        );
        if (rel === "aidlc-plugin.ts") {
          codex = codex.replace(
            '.replaceAll(".codex", harnessDir)',
            '.replaceAll(".claude", harnessDir)',
          );
        }
        if (codex !== claude) divergent.push(`${sub}/${rel}`);
      }
    }
    expect(divergent).toEqual([]);
  });

  test("3: shipped codex prose carries no bun .claude/tools commands", () => {
    const r = spawnSync(
      "grep",
      ["-rn", "bun .claude/tools/", join(REPO_ROOT, "dist", "codex")],
      { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" },
    );
    // grep exits 1 on no matches — exactly what we want.
    expect(r.status).toBe(1);
  });

  test("4: method relocated to workspace-root aidlc/spaces/default/memory/; native rules/ is Starlark-only", () => {
    // The AIDLC method ("memory") no longer ships under .codex/aidlc-rules/ (the
    // old D-10 rename target). It relocated OUT of the harness dir to the
    // workspace root — one hand-editable copy, neutral filenames, identical
    // across harnesses. Reached via AGENTS.md auto-merge + AIDLC_RULES_DIR.
    const memoryDir = join(REPO_ROOT, "dist", "codex", "aidlc", "spaces", "default", "memory");
    const memoryTop = readdirSync(memoryDir);
    expect(memoryTop).toContain("org.md");
    expect(memoryTop).toContain("team.md");
    expect(memoryTop).toContain("project.md");
    expect(readdirSync(join(memoryDir, "phases"))).toContain("construction.md");
    // .codex/aidlc-rules/ is GONE — the method left the harness dir entirely.
    expect(() => readdirSync(join(CODEX_DST, "aidlc-rules"))).toThrow();
    // .codex/rules/ remains Codex's native Starlark permission-rules dir.
    const nativeRules = readdirSync(join(CODEX_DST, "rules"));
    expect(nativeRules).toEqual(["default.rules"]);
    const defaultRules = readFileSync(join(CODEX_DST, "rules", "default.rules"), "utf-8");
    expect(defaultRules).toContain(
      'prefix_rule(pattern = ["bun", ".codex/tools/"], decision = "allow")',
    );
    expect(defaultRules).not.toContain('prefix_rule(pattern = ["aidlc"]');
    // The resolver seam re-points at the relocated method (relative to the
    // workspace root, where codex runs), NOT the old .codex/aidlc-rules.
    const config = readFileSync(join(CODEX_DST, "config.toml"), "utf-8");
    expect(config).toContain('AIDLC_RULES_DIR = "aidlc/spaces/default/memory"');
    expect(config).toContain("[agents]\nmax_depth = 1");
    // The compiled graph's rule display paths are harness-neutral now.
    const graph = readFileSync(join(CODEX_DST, "tools", "data", "stage-graph.json"), "utf-8");
    expect(graph).toContain('"aidlc/spaces/default/memory/org.md"');
    expect(graph).not.toContain(".codex/aidlc-rules/");
    expect(graph).not.toContain('".claude/rules/');
  });

  test("Codex config injects the native onboarding in both distribution channels", () => {
    for (const channel of ["dist", "dist-release"]) {
      const root = join(REPO_ROOT, channel, "codex", ".codex");
      const raw = readFileSync(join(root, "config.toml"), "utf-8");
      // The parser's object return type omits these shipped Codex config fields.
      const config = Bun.TOML.parse(raw) as {
        developer_instructions?: string;
        shell_environment_policy?: { set?: Record<string, string> };
      };
      const onboarding = readFileSync(join(root, "onboarding.md"), "utf-8");
      expect(typeof config.developer_instructions).toBe("string");
      // Bun 1.3.14 incorrectly preserves the opening newline of a TOML literal string.
      const instructions = config.developer_instructions as string;
      expect(instructions.replace(/^\n/, "")).toBe(onboarding);
      const standardConfig = parse(raw) as typeof config;
      expect(standardConfig.developer_instructions).toBe(onboarding);
      expect(config.developer_instructions).toContain("# AI-DLC on Codex CLI");
      expect(config.developer_instructions).toContain(".agents/skills/");
      expect(config.shell_environment_policy).toMatchObject({
        set: { AIDLC_RULES_DIR: "aidlc/spaces/default/memory" },
      });
      expect(raw).toContain('set = { AIDLC_RULES_DIR = "aidlc/spaces/default/memory" }');
      if (channel === "dist-release") {
        expect(config.developer_instructions).toContain("- **Runtime**:");
        expect(config.developer_instructions).not.toMatch(/\bbun\b/);
      }
    }
  });

  test("5: hooks.json wires only Codex-real events through the adapter (no SessionEnd)", () => {
    const wiring = JSON.parse(readFileSync(join(CODEX_DST, "hooks.json"), "utf-8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>>;
    };
    expect(Object.keys(wiring.hooks).sort()).toEqual(
      ["PostToolUse", "PreCompact", "PreToolUse", "SessionStart", "Stop", "SubagentStop", "UserPromptSubmit"].sort(),
    );
    // Matchers per the verified tool-name map.
    const postMatchers = wiring.hooks.PostToolUse.map((g) => g.matcher).sort();
    expect(postMatchers).toEqual(["Bash", "apply_patch", "request_user_input", "update_plan"]);
    expect(
      wiring.hooks.PostToolUse.find((group) => group.matcher === "request_user_input")
        ?.hooks[0]?.command,
    ).toBe("bun .codex/tools/aidlc.ts engine adapter codex record-human-turn");
    expect(
      wiring.hooks.PreToolUse.find((group) => group.matcher === "Bash")
        ?.hooks[0]?.command,
    ).toBe("bun .codex/tools/aidlc.ts engine adapter codex bind-bash-session");
    // Every registration routes through the single authored adapter.
    for (const groups of Object.values(wiring.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          expect(h.command).toMatch(
            /^bun \.codex\/tools\/aidlc\.ts engine adapter codex [a-z-]+$/,
          );
          const compound = /(?:continue-workflow|audit-and-sensors)$/.test(h.command);
          expect(h.timeout, h.command).toBe(compound ? 3600 : 1800);
        }
      }
    }
  });

  test("6: the complete shipped trust-seed is valid TOML and exactly matches trustEntries()", () => {
    // The installer generates entries through the trust command and pastes its
    // stdout into $CODEX_HOME/config.toml, so paths always pass through the TOML
    // serializer and Codex runs the hooks without a TUI trust pass.
    // The pre-seed is only sound while every shipped hash matches the live hook
    // identity emit.ts hashes. Guard that by calling the REAL exported
    // trustEntries() (not an inlined copy of the recipe) and asserting it
    // reproduces the shipped body verbatim for the <PROJECT_DIR> template. If
    // trustHash's recipe, HOOK_WIRING, or the adapter command ever drifts, the
    // shipped hashes go stale and Codex silently rejects every hook — this fails
    // then, where --check cannot (a buggy emit regenerates the same wrong bytes).
    const emitTrustEntries = trustEntries();
    const shipped = readFileSync(join(CODEX_DST, "trust-seed.toml"), "utf-8");
    const parsed = parseTrustDocument(shipped);
    expect(Object.keys(parsed.hooks.state)).toEqual(
      expectedTrustKeys("<PROJECT_DIR>/.codex/hooks.json"),
    );
    // The shipped file is a header comment block + the trustEntries() body. The
    // body begins at the first [hooks.state ...] line.
    const bodyStart = shipped.indexOf("[hooks.state");
    expect(bodyStart).toBeGreaterThan(-1);
    const header = shipped.slice(0, bodyStart);
    expect(header).toContain(
      "projected `bun .codex/tools/aidlc.ts engine adapter codex ...`",
    );
    expect(header).toContain("replace the full set");
    expect(header).toContain("appending a second set creates invalid TOML");
    expect(header).not.toMatch(/replac\w*\s+<PROJECT_DIR>/i);
    const shippedBody = shipped.slice(bodyStart).trimEnd();
    const produced = emitTrustEntries(
      "<PROJECT_DIR>",
      undefined,
      ".codex",
      "codex",
      SOURCE_INVOKE,
    ).trimEnd();
    expect(produced).toBe(shippedBody);
    // And the real session_start hash is a sha256 over the live adapter identity
    // — a concrete anchor so a silent recipe change can't pass by emitting a
    // self-consistent but wrong hash for every entry.
    expect(shippedBody).toContain(
      'session_start:0:0"]\ntrusted_hash = "sha256:58956c1f8f0b66e96c0f4d02e26946e79979e0f30599e8dc06a512ebecf03843"',
    );
  });

  test("7: default trust paths round-trip Unix and Windows path characters exactly", () => {
    const emitTrustEntries = trustEntries();
    const cases = [
      {
        project: "/tmp/example-proj",
        hooksJson: "/tmp/example-proj/.codex/hooks.json",
      },
      {
        project: '/srv/AI DLC/project "quoted"\\literal',
        hooksJson: '/srv/AI DLC/project "quoted"\\literal/.codex/hooks.json',
      },
      {
        project: String.raw`C:\Users\Jane Doe\AI "DLC"`,
        hooksJson: String.raw`C:\Users\Jane Doe\AI "DLC"\.codex\hooks.json`,
      },
      {
        project: String.raw`\\server\shared projects\AI "DLC"`,
        hooksJson: String.raw`\\server\shared projects\AI "DLC"\.codex\hooks.json`,
      },
      {
        project: "//server/share/project",
        hooksJson: String.raw`\\server\share\project\.codex\hooks.json`,
      },
    ];

    for (const { project, hooksJson } of cases) {
      const output = emitTrustEntries(project);
      const parsed = parseTrustDocument(output);
      expect(Object.keys(parsed.hooks.state)).toEqual(expectedTrustKeys(hooksJson));
      for (const entry of Object.values(parsed.hooks.state)) {
        expect(entry.trusted_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    }

    // Pin the installed-command identity separately from the copy-channel
    // anchor above; its explicit SessionStart timeout is also 1800 seconds.
    expect(emitTrustEntries("/tmp/example-proj")).toStartWith(
      '[hooks.state."/tmp/example-proj/.codex/hooks.json:session_start:0:0"]\n' +
        'trusted_hash = "sha256:0ba8b12bad0f77c2bf9a996ec8e533c53a6e451fe37c31de2626e27514e35e63"\n\n',
    );
  });

  test("8: explicit hooks-json paths are preserved and complete CLI stdout parses", () => {
    const project = "/tmp/project path that must not replace the hook path";
    const hooksJson = String.raw`D:\custom hooks\hook "set"\hooks.json`;
    const emitTrustEntries = trustEntries();
    const expected = emitTrustEntries(project, hooksJson);
    const direct = parseTrustDocument(expected);
    expect(Object.keys(direct.hooks.state)).toEqual(expectedTrustKeys(hooksJson));

    const r = spawnSync(
      "bun",
      [PACKAGE_SCRIPT, "codex", "trust", "--project", project, "--hooks-json", hooksJson],
      {
        timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
        encoding: "utf-8",
        cwd: REPO_ROOT,
      },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    // console.log adds one newline to the already newline-terminated TOML.
    expect(r.stdout).toBe(`${expected}\n`);
    const parsedStdout = parseTrustDocument(r.stdout);
    expect(Object.keys(parsedStdout.hooks.state)).toEqual(expectedTrustKeys(hooksJson));
    expect(r.stdout).not.toContain(project);
  });

  test("9: trust subcommand accepts fully qualified Windows project roots", () => {
    const cases = [
      {
        project: String.raw`C:\workspace\AI DLC`,
        hooksJson: String.raw`C:\workspace\AI DLC\.codex\hooks.json`,
      },
      {
        project: String.raw`\\server\share\AI DLC`,
        hooksJson: String.raw`\\server\share\AI DLC\.codex\hooks.json`,
      },
      {
        project: "//server/share/AI DLC",
        hooksJson: String.raw`\\server\share\AI DLC\.codex\hooks.json`,
      },
    ];

    for (const { project, hooksJson } of cases) {
      const r = spawnSync("bun", [PACKAGE_SCRIPT, "codex", "trust", "--project", project], {
        timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
        encoding: "utf-8",
        cwd: REPO_ROOT,
      });
      expect(r.status, project).toBe(0);
      expect(r.stderr, project).toBe("");
      expect(Object.keys(parseTrustDocument(r.stdout).hooks.state)).toEqual(
        expectedTrustKeys(hooksJson),
      );
    }
  });

  test("10: trust subcommand rejects malformed, non-qualified, unknown, and duplicate arguments", () => {
    const cases: Array<{ args: string[]; error: string }> = [
      {
        args: ["codex", "trust", "--hooks-json", "--project", "/tmp/project"],
        error: "--hooks-json requires an absolute path",
      },
      {
        args: ["codex", "trust", "--project", "relative/project"],
        error: "--project must be a fully qualified absolute path",
      },
      {
        args: ["codex", "trust", "--project", "/tmp/project", "--hooks-json", "hooks.json"],
        error: "--hooks-json must be a fully qualified absolute path",
      },
      {
        args: ["codex", "trust", "--project", String.raw`\workspace`],
        error: "--project must be a fully qualified absolute path",
      },
      {
        args: ["codex", "trust", "--project", String.raw`\\server`],
        error: "--project must be a fully qualified absolute path",
      },
      {
        args: ["codex", "trust", "--project", "//server"],
        error: "--project must be a fully qualified absolute path",
      },
      {
        args: [
          "codex",
          "trust",
          "--project",
          "/tmp/project",
          "--hooks-json",
          String.raw`\custom\hooks.json`,
        ],
        error: "--hooks-json must be a fully qualified absolute path",
      },
      {
        args: ["codex", "trust", "--project", "/tmp/project", "--hooks-josn", "/tmp/hooks.json"],
        error: 'unknown argument "--hooks-josn"',
      },
      {
        args: [
          "codex",
          "trust",
          "--project",
          "/tmp/project",
          "--project",
          "/tmp/other",
        ],
        error: "--project may be specified only once",
      },
    ];

    for (const { args, error } of cases) {
      const r = spawnSync("bun", [PACKAGE_SCRIPT, ...args], {
        timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
        encoding: "utf-8",
        cwd: REPO_ROOT,
      });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr, args.join(" ")).toContain(error);
      expect(r.stderr, args.join(" ")).toContain(
        "usage: package.ts codex trust --project <abs-dir> [--hooks-json <abs-path>]",
      );
    }
  });

  test("11: skills tree — every runner carries the S9f implicit-invocation guard; the orchestrator does not", () => {
    const skillsDir = join(REPO_ROOT, "dist", "codex", ".agents", "skills");
    const dirs = readdirSync(skillsDir).filter((d) =>
      statSync(join(skillsDir, d)).isDirectory(),
    );
    // 42 skills: orchestrator + 30 stage runners + init + compose + 5 scope runners
    // + 3 session + aidlc-knowledge. The last one only ships here because
    // harness/codex/emit.ts names it explicitly: codex does not enumerate
    // core/skills/, so this count is what catches a skill missing from that array.
    expect(dirs.length).toBe(42);
    for (const d of dirs) {
      const guard = join(skillsDir, d, "agents", "openai.yaml");
      if (d === "aidlc") {
        // The entry point stays implicitly invocable.
        let exists = true;
        try {
          statSync(guard);
        } catch {
          exists = false;
        }
        expect(exists).toBe(false);
        // The orchestrator ships its question-rendering annex beside SKILL.md.
        expect(readdirSync(join(skillsDir, d)).sort()).toEqual([
          "SKILL.md",
          "question-rendering.md",
        ]);
      } else {
        expect(readFileSync(guard, "utf-8")).toContain("allow_implicit_invocation: false");
      }
    }
    // Stage runners drive the source-channel Bun tool.
    const probe = readFileSync(join(skillsDir, "aidlc-intent-capture", "SKILL.md"), "utf-8");
    expect(probe).toContain(
      "bun .codex/tools/aidlc-orchestrate.ts next --stage intent-capture --single",
    );
  });

  test("12: trust subcommand substitutes the project path into every entry", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "codex", "trust", "--project", "/tmp/example-proj"], {
      timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
    expect(r.status).toBe(0);
    const parsed = parseTrustDocument(r.stdout);
    const entries = Object.keys(parsed.hooks.state);
    const wiring = JSON.parse(readFileSync(join(CODEX_DST, "hooks.json"), "utf-8")) as {
      hooks: Record<string, Array<unknown>>;
    };
    const groupCount = Object.values(wiring.hooks).reduce((n, g) => n + g.length, 0);
    expect(entries.length).toBe(groupCount);
    expect(entries).toEqual(expectedTrustKeys("/tmp/example-proj/.codex/hooks.json"));
    expect(r.stdout).not.toContain("<PROJECT_DIR>");
  });

  test.each(["0.144.9", "0.145.0"])("13: doctor enforces the compact-session reload floor for Codex %s", (version) => {
    const result = runDoctorWithCodexVersion(version);
    expect(result.status, result.output).toBe(0);
    if (version === "0.144.9") {
      expect(result.output).toContain(
        "Harness CLI: codex codex-cli 0.144.9 is below 0.145.0",
      );
      expect(result.output).toContain(
        "Install or upgrade Codex CLI to 0.145.0 or later",
      );
    } else {
      expect(result.output).toContain("Harness CLI: codex codex-cli 0.145.0");
    }
    // Each version owns one native fixture and doctor run, including cleanup.
    // Compiler/probe backstops use the shared native policy for each version.
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("14: both generated Codex configs select workspace-write at the TOML root", () => {
    for (const output of ["dist", "dist-release"]) {
      const configPath = join(REPO_ROOT, output, "codex", ".codex", "config.toml");
      const config = parse(readFileSync(configPath, "utf-8"));
      // A text match also accepts sandbox_mode inside shell_environment_policy,
      // where it does not select the sandbox. Check the generated TOML structure.
      expect(config.sandbox_mode, configPath).toBe("workspace-write");
      expect(config.shell_environment_policy, configPath).toEqual({
        set: { AIDLC_RULES_DIR: "aidlc/spaces/default/memory" },
      });
      // Keep the existing network policy and absence of extra grants/approval
      // overrides while correcting only the sandbox setting's table placement.
      expect(config.sandbox_workspace_write, configPath).toEqual({
        network_access: true,
      });
      expect(config.approval_policy, configPath).toBeUndefined();
    }
  });
});
