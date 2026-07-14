// t150-codex-packaging: dist/codex parity + drift guard + trust-seed recipe.
//
// covers: file:tools/aidlc-lib.ts
//
// WHAT. Three contracts land here:
//   (1) The committed dist/codex tree is byte-identical to what
//       `bun scripts/package.ts codex` regenerates from dist/claude/.claude
//       (modulo the script's single sanctioned prefix-transform class).
//       Drift fails with the regen command — same UX as aidlc-runner-gen
//       check and kiro's t141.
//   (2) Core parity: every .ts under dist/codex/.codex/tools/ and the core
//       hook bodies are BYTE-IDENTICAL to their dist/claude sources (the
//       architecture-B invariant: the generator may transform prose/data
//       paths, never code).
//   (3) The S9a trust-hash recipe in the packager reproduces the hash the
//       spike recorded live (findings §S9a) — the installer pre-seed is only
//       sound while this stays true.
//
// WHY SUBPROCESS. Same idiom as kiro's t141: the packager is a CLI; we pin
// its observable behavior, not its internals.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const CODEX_DST = join(REPO_ROOT, "dist", "codex", ".codex");
const TRUST_SUFFIXES = [
  "session_start:0:0",
  "user_prompt_submit:0:0",
  "pre_tool_use:0:0",
  "post_tool_use:0:0",
  "post_tool_use:1:0",
  "post_tool_use:2:0",
  "pre_compact:0:0",
  "post_compact:0:0",
  "subagent_stop:0:0",
  "stop:0:0",
] as const;

type TrustDocument = {
  hooks: {
    state: Record<string, { trusted_hash: string }>;
  };
};

type TrustEntries = (project: string, hooksJson?: string) => string;

function parseTrustDocument(source: string): TrustDocument {
  return parse(source) as unknown as TrustDocument;
}

function trustEntries(): TrustEntries {
  const emitter = require(join(REPO_ROOT, "harness", "codex", "emit.ts")) as {
    trustEntries: TrustEntries;
  };
  return emitter.trustEntries;
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

describe("t150 dist/codex packaging parity + drift guard", () => {
  test("1: committed dist/codex matches the packaging script (drift guard)", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "codex", "--check"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
    if (r.status !== 0) {
      // Surface the script's own stale-file list — it names the fix.
      console.error(r.stderr);
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("in sync");
  });

  test("2: every packaged .ts file is byte-identical to its dist/claude source (code is never transformed)", () => {
    // tools/ + hooks/ carry the deterministic core. The codex adapter
    // (authored shell, aidlc-codex-*.ts) has no claude counterpart and is
    // exempt; everything else must match its source byte-for-byte.
    const divergent: string[] = [];
    for (const sub of ["tools", "hooks"]) {
      const dstDir = join(CODEX_DST, sub);
      for (const file of walk(dstDir)) {
        if (!file.endsWith(".ts")) continue;
        if (/aidlc-codex-[^/]+\.ts$/.test(file)) continue;
        const rel = file.slice(dstDir.length + 1);
        const src = join(CLAUDE_SRC, sub, rel);
        if (!readFileSync(file).equals(readFileSync(src))) divergent.push(`${sub}/${rel}`);
      }
    }
    expect(divergent).toEqual([]);
  });

  test("3: shipped codex prose carries no bun .claude/tools commands", () => {
    const r = spawnSync(
      "grep",
      ["-rn", "bun .claude/tools/", join(REPO_ROOT, "dist", "codex")],
      { encoding: "utf-8" },
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
    // The resolver seam re-points at the relocated method (relative to the
    // workspace root, where codex runs), NOT the old .codex/aidlc-rules.
    const config = readFileSync(join(CODEX_DST, "config.toml"), "utf-8");
    expect(config).toContain('AIDLC_RULES_DIR = "aidlc/spaces/default/memory"');
    // The compiled graph's rule display paths are harness-neutral now.
    const graph = readFileSync(join(CODEX_DST, "tools", "data", "stage-graph.json"), "utf-8");
    expect(graph).toContain('"aidlc/spaces/default/memory/org.md"');
    expect(graph).not.toContain(".codex/aidlc-rules/");
    expect(graph).not.toContain('".claude/rules/');
  });

  test("5: hooks.json wires only Codex-real events through the adapter (no SessionEnd)", () => {
    const wiring = JSON.parse(readFileSync(join(CODEX_DST, "hooks.json"), "utf-8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(wiring.hooks).sort()).toEqual(
      ["PostCompact", "PostToolUse", "PreCompact", "PreToolUse", "SessionStart", "Stop", "SubagentStop", "UserPromptSubmit"].sort(),
    );
    // Matchers per the verified tool-name map.
    const postMatchers = wiring.hooks.PostToolUse.map((g) => g.matcher).sort();
    expect(postMatchers).toEqual(["Bash", "apply_patch", "update_plan"]);
    // Every registration routes through the single authored adapter.
    for (const groups of Object.values(wiring.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          expect(h.command).toMatch(/^bun \.codex\/hooks\/aidlc-codex-adapter\.ts [a-z-]+$/);
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
      "bun scripts/package.ts codex trust --project <abs-dir> [--hooks-json <abs-path>]",
    );
    expect(header).not.toMatch(/replac\w*\s+<PROJECT_DIR>/i);
    const shippedBody = shipped.slice(bodyStart).trimEnd();
    const produced = emitTrustEntries("<PROJECT_DIR>").trimEnd();
    expect(produced).toBe(shippedBody);
    // And the real session_start hash is a sha256 over the live adapter identity
    // — a concrete anchor so a silent recipe change can't pass by emitting a
    // self-consistent but wrong hash for every entry.
    expect(shippedBody).toContain(
      'session_start:0:0"]\ntrusted_hash = "sha256:ec7321a5902723dfe5d1b79fe13a48724fdf69a2029f83d4168ae28da6121c96"',
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
    ];

    for (const { project, hooksJson } of cases) {
      const output = emitTrustEntries(project);
      const parsed = parseTrustDocument(output);
      expect(Object.keys(parsed.hooks.state)).toEqual(expectedTrustKeys(hooksJson));
      for (const entry of Object.values(parsed.hooks.state)) {
        expect(entry.trusted_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    }

    // The common Unix form remains byte-identical to the historical output.
    expect(emitTrustEntries("/tmp/example-proj")).toStartWith(
      '[hooks.state."/tmp/example-proj/.codex/hooks.json:session_start:0:0"]\n' +
        'trusted_hash = "sha256:ec7321a5902723dfe5d1b79fe13a48724fdf69a2029f83d4168ae28da6121c96"\n\n',
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

  test("9: trust subcommand rejects malformed, relative, unknown, and duplicate arguments", () => {
    const cases: Array<{ args: string[]; error: string }> = [
      {
        args: ["codex", "trust", "--hooks-json", "--project", "/tmp/project"],
        error: "--hooks-json requires an absolute path",
      },
      {
        args: ["codex", "trust", "--project", "relative/project"],
        error: "--project must be an absolute path",
      },
      {
        args: ["codex", "trust", "--project", "/tmp/project", "--hooks-json", "hooks.json"],
        error: "--hooks-json must be an absolute path",
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

  test("10: skills tree — every runner carries the S9f implicit-invocation guard; the orchestrator does not", () => {
    const skillsDir = join(REPO_ROOT, "dist", "codex", ".agents", "skills");
    const dirs = readdirSync(skillsDir).filter((d) =>
      statSync(join(skillsDir, d)).isDirectory(),
    );
    // 39 skills: orchestrator + 29 stage runners + init + compose + 4 scope runners + 3 session.
    expect(dirs.length).toBe(39);
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
    // Stage runners drive the codex tools path (harness interpolation held).
    const probe = readFileSync(join(skillsDir, "aidlc-intent-capture", "SKILL.md"), "utf-8");
    expect(probe).toContain("bun .codex/tools/aidlc-orchestrate.ts next --stage intent-capture --single");
  });

  test("11: trust subcommand substitutes the project path into every entry", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "codex", "trust", "--project", "/tmp/example-proj"], {
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
});
