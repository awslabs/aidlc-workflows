// t240-opencode-packaging: dist/opencode parity + drift guard + shell shape.
//
// covers: file:tools/aidlc-lib.ts
//
// WHAT. Four contracts land here:
//   (1) The committed dist/opencode tree is byte-identical to what
//       `bun scripts/package.ts opencode` regenerates (drift guard, same UX
//       as codex's t150 test 1).
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

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import createAdapter from "../../dist/opencode/.opencode/plugin/aidlc-opencode-adapter.ts";

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const OPENCODE_ROOT = join(REPO_ROOT, "dist", "opencode");
const ENGINE = join(OPENCODE_ROOT, ".aidlc");
const SHELL = join(OPENCODE_ROOT, ".opencode");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("t240 dist/opencode packaging parity + shell shape", () => {
  test("1: committed dist/opencode matches the packaging script (drift guard)", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "opencode", "--check"], {
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
    const divergent: string[] = [];
    for (const sub of ["tools", "hooks"]) {
      const dstDir = join(ENGINE, sub);
      for (const file of walk(dstDir)) {
        if (!file.endsWith(".ts")) continue;
        const rel = file.slice(dstDir.length + 1);
        const src = join(CLAUDE_SRC, sub, rel);
        if (!readFileSync(file).equals(readFileSync(src))) divergent.push(`${sub}/${rel}`);
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
      // Balanced/templated pin the Bedrock sonnet id; judgment omits model
      // (inherit-by-omission). Either way a bare non-provider-prefixed model
      // value would be an authoring bug on this harness.
      const model = fm.match(/^model: (.*)$/m)?.[1];
      if (model !== undefined) {
        expect(model, `${f}: opencode model carries a provider prefix`).toMatch(/^amazon-bedrock\//);
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
      { encoding: "utf-8" },
    );
    // grep exits 1 on no matches — exactly what we want.
    expect(r.status).toBe(1);
  });

  test("8: the shipped opencode.json wires skills, method instructions, and the bun allowlist", () => {
    const cfg = JSON.parse(readFileSync(join(OPENCODE_ROOT, "opencode.json"), "utf-8")) as {
      skills?: { paths?: string[] };
      instructions?: string[];
      permission?: {
        bash?: Record<string, string>;
        edit?: Record<string, string>;
      };
    };
    expect(cfg.skills?.paths).toContain(".aidlc/skills");
    expect(cfg.instructions).toContain("aidlc/spaces/default/memory/**/*.md");
    expect(cfg.permission?.bash?.["bun .aidlc/tools/*"]).toBe("allow");
    expect(cfg.permission?.edit?.[".aidlc/tools/**"]).toBe("ask");
    expect(cfg.permission?.edit?.[".aidlc/hooks/**"]).toBe("ask");
  });

  test("9: the adapter embeds exactly the shipped tool and hook entrypoints", async () => {
    const moduleExports = await import(
      "../../dist/opencode/.opencode/plugin/aidlc-opencode-adapter.ts"
    );
    expect(Object.keys(moduleExports)).toEqual(["default"]);

    const expected = ["hooks", "tools"].flatMap((dir) =>
      readdirSync(join(ENGINE, dir), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => `${dir}/${entry.name}`)
    ).sort();
    const adapter = readFileSync(
      join(OPENCODE_ROOT, ".opencode", "plugin", "aidlc-opencode-adapter.ts"),
      "utf-8",
    );
    const emitted = adapter.match(
      /\/\* @aidlc-shipped-entrypoints@ \*\/\s*(\[[\s\S]*?\])\s*,\s*\n\);/,
    )?.[1];
    expect(emitted).toBeDefined();
    expect(JSON.parse(emitted ?? "[]")).toEqual(expected);
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
    for (const entrypoint of expected) {
      await expect(
        before(
          { tool: "bash", sessionID: "main", callID: entrypoint },
          { args: { command: `bun .aidlc/${entrypoint}` } },
        ),
      ).resolves.toBeUndefined();
    }
    await expect(
      before(
        { tool: "bash", sessionID: "main", callID: "unknown" },
        { args: { command: "bun .aidlc/tools/payload.ts" } },
      ),
    ).rejects.toThrow(
      "shipped tool or hook",
    );
  });

  test("10: doctor accepts an opencode.jsonc-only install", () => {
    const root = mkdtempSync(join(tmpdir(), "t240-opencode-doctor-"));
    try {
      const project = join(root, "project");
      cpSync(OPENCODE_ROOT, project, { recursive: true });
      renameSync(join(project, "opencode.json"), join(project, "opencode.jsonc"));
      const r = spawnSync(
        "bun",
        [join(project, ".aidlc", "tools", "aidlc-utility.ts"), "doctor", "--project-dir", project],
        {
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".aidlc" },
        },
      );
      expect(r.stdout).toContain(
        "✓  opencode.json or opencode.jsonc present (permissions + method instructions glob)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
