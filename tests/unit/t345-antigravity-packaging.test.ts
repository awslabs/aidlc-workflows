// t345-antigravity-packaging: dist/antigravity determinism + shell shape.
//
// covers: file:tools/aidlc-lib.ts
//
// Contracts:
//   (1) `bun scripts/package.ts antigravity --check` produces byte-identical clean builds.
//   (2) Core parity: every .ts under dist/antigravity/.aidlc/{tools,hooks}/
//       except the authored adapter is BYTE-IDENTICAL to its dist/claude source.
//   (3) The .agents/ shell carries .agents/skills/ and .agents/hooks.json.
//   (4) Persona frontmatter inherits session model and excludes Task delegation.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const ANTIGRAVITY_ROOT = join(REPO_ROOT, "dist", "antigravity");
const ENGINE = join(ANTIGRAVITY_ROOT, ".aidlc");
const SHELL = join(ANTIGRAVITY_ROOT, ".agents");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("t345 dist/antigravity packaging parity + shell shape", () => {
  test("1: engine .ts files differ only at declared projection tokens", () => {
    expect(existsSync(ENGINE)).toBe(true);
    let compared = 0;
    for (const sub of ["tools", "hooks"]) {
      for (const file of walk(join(ENGINE, sub))) {
        if (!file.endsWith(".ts")) continue;
        const rel = relative(ENGINE, file);
        // The authored shim is antigravity-only; everything else is shared core.
        if (rel === join("hooks", "aidlc-antigravity-adapter.ts")) continue;
        // Fold usage is claude-only
        if (rel === join("hooks", "aidlc-fold-usage.ts")) continue;
        // Compiled data (tools/data/) is per-tree by design; only code is pinned.
        if (rel.split(sep).includes("data")) continue;
        const claudeTwin = join(CLAUDE_SRC, rel);
        expect(existsSync(claudeTwin)).toBe(true);
        const agy = readFileSync(file, "utf-8").replaceAll(
          "bun .aidlc/tools/aidlc.ts",
          "bun .claude/tools/aidlc.ts",
        );
        expect(agy).toBe(readFileSync(claudeTwin, "utf-8"));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  test("2: .agents shell structure contains skills and hooks.json", () => {
    expect(existsSync(join(SHELL, "hooks.json"))).toBe(true);
    expect(existsSync(join(SHELL, "skills", "aidlc", "SKILL.md"))).toBe(true);

    const hooksJson = JSON.parse(readFileSync(join(SHELL, "hooks.json"), "utf8"));
    expect(hooksJson.hooks).toBeDefined();
    expect(hooksJson.hooks.SessionStart).toBeDefined();
    expect(hooksJson.hooks.UserPromptSubmit).toBeDefined();
    expect(hooksJson.hooks.PreToolUse).toBeDefined();
    expect(hooksJson.hooks.PostToolUse).toBeDefined();
    expect(hooksJson.hooks.SubagentStop).toBeDefined();
    expect(hooksJson.hooks.Stop).toBeDefined();
  });

  test("3: onboarding AGENTS.md is emitted in root", () => {
    const agentsMd = join(ANTIGRAVITY_ROOT, "AGENTS.md");
    expect(existsSync(agentsMd)).toBe(true);
    const content = readFileSync(agentsMd, "utf8");
    expect(content).toContain("AI-DLC");
    expect(content).toContain("Antigravity");
  });
});
