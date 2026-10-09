// covers: file:harness/codex/emit.ts

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { REPO_ROOT } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const CODEX_DST = join(REPO_ROOT, "dist", "codex", ".codex");

// Every TOML the Codex projection ships: the per-agent role files, the project
// config, and the hook trust seed.
function emittedTomlFiles(): string[] {
  const agents = readdirSync(join(CODEX_DST, "agents"))
    .filter((name) => name.endsWith(".toml"))
    .map((name) => join(CODEX_DST, "agents", name));
  return [...agents, join(CODEX_DST, "config.toml"), join(CODEX_DST, "trust-seed.toml")].sort();
}

describe("Codex projection TOML", () => {
  // Codex reads these with a spec-strict parser and drops a whole agent role
  // on the first bad escape ("Ignoring malformed agent role definition"). Bun's
  // parser is lenient (it silently dropped the backslash of a `\|`), so the
  // strict library the emitter itself depends on is the one that must accept
  // every file; Bun is checked as well for the lenient reading.
  test("every emitted TOML parses under the strict parser and under Bun", () => {
    const files = emittedTomlFiles();
    expect(files.length).toBeGreaterThan(14);
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      expect(() => parse(text), file).not.toThrow();
      expect(() => Bun.TOML.parse(text), file).not.toThrow();
    }
  });

  // The two review personas absorb knowledge that tells the agent to write a
  // pipe inside a table cell as `\|`. The role file must hand Codex that
  // backslash as written, not as an escape sequence.
  test("a backslash in agent text reaches Codex as written", () => {
    for (const agent of ["aidlc-architecture-reviewer-agent", "aidlc-product-lead-agent"]) {
      const source = readFileSync(join(REPO_ROOT, "core", "knowledge", agent, "reviewing.md"), "utf-8");
      expect(source, `${agent} knowledge is the premise of this case`).toContain("`\\|`");
      const parsed = parse(readFileSync(join(CODEX_DST, "agents", `${agent}.toml`), "utf-8")) as {
        developer_instructions?: string;
      };
      expect(parsed.developer_instructions, agent).toContain("`\\|`");
    }
  });
});
