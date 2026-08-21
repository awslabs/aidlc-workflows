// t146-core-hygiene: core/ prose carries the {{HARNESS_DIR}} token, never a raw
// harness-dir path literal — except a small, named carve-out set.
//
// covers: file:core/aidlc-common/protocols/stage-protocol.md, file:core/aidlc-common/protocols/stage-protocol-reviewer.md
//
// WHAT. The dist-unified keystone (MR-1) made core/ harness-neutral: every
// path that names the harness directory in .md prose is written
// `{{HARNESS_DIR}}/…` and the packager substitutes `.claude` / `.kiro` /
// `.codex` per tree. A raw `.claude/<subdir>` (or `.kiro/` / `.codex/`) path
// literal that slips into a core .md would ship verbatim into EVERY harness's
// dist — a Claude path leaking into the Kiro and Codex trees. The dist-level
// byte-parity gate (t145) catches a literal that the anchored migration WOULD
// have tokenized; this test guards the other direction — a NEW core edit that
// hardcodes a harness path instead of using the token.
//
// THE CARVE-OUTS (truthful, harness-specific prose that MUST stay literal):
//   - workspace-detection.md enumerates all three harness dirs by name when it
//     tells the scanner which dirs to exclude — `.claude/`, `.kiro/`, `.codex/`
//     are the literal directory names, not a tokenizable path.
//   - stage-protocol.md's CWD-drift note says "on Claude Code,
//     $CLAUDE_PROJECT_DIR/.claude/tools/" — a Claude-Code-specific example, true
//     only for that harness.
//   - stage-protocol-reviewer.md preserves the original Codex reviewer-binding
//     clause verbatim, including the literal `.codex/agents/` resolution path.
// Both are exactly what survives the proven anchored migration by NON-MATCH
// (the anchors only rewrite `.claude/<subdir>` path forms), so this carve-out
// list is the same set the packager and the kiro/codex dist trees already prove.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = join(REPO_ROOT, "core");

// A hit is carved out iff its (relPath, lineText) is a known truthful literal.
function isCarvedOut(relPath: string, line: string): boolean {
  // workspace-detection's three-dir enumeration: the line names .kiro/ and
  // .codex/ alongside .claude/, so it is harness-enumerating, not a path.
  if (
    relPath === "aidlc-common/stages/initialization/workspace-detection.md" &&
    line.includes(".kiro/") &&
    line.includes(".codex/")
  ) {
    return true;
  }
  // stage-protocol's Claude-Code-specific CWD-drift example.
  if (
    relPath === "aidlc-common/protocols/stage-protocol.md" &&
    line.includes("$CLAUDE_PROJECT_DIR/.claude/tools/")
  ) {
    return true;
  }
  // Reviewer module's verbatim Codex harness binding.
  if (
    relPath === "aidlc-common/protocols/stage-protocol-reviewer.md" &&
    line.includes(
      "the harness resolves its `.codex/agents/aidlc-<role>-agent.toml`",
    )
  ) {
    return true;
  }
  return false;
}

function* walkMd(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkMd(full);
    else if (full.endsWith(".md")) yield full;
  }
}

// Raw harness-dir path literals: `.claude/`, `.kiro/`, `.codex/` followed by a
// known core subdir name (the form the token replaces). Bare `.claude/` (e.g.
// inside a `(.claude/, .kiro/, .codex/)` enumeration) is matched too, then
// filtered by the carve-out predicate.
const HARNESS_PATH_RE = /\.(claude|kiro|codex)\//;

describe("t146 core hygiene — no stray harness-dir path literals in core/ prose", () => {
  test("every harness-dir path literal in core/*.md is the {{HARNESS_DIR}} token or a named carve-out", () => {
    const stray: string[] = [];
    for (const file of walkMd(CORE)) {
      const rel = relative(CORE, file);
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (!HARNESS_PATH_RE.test(line)) return;
        if (isCarvedOut(rel, line)) return;
        stray.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    if (stray.length > 0) {
      console.error(
        "stray harness-dir path literals in core/ (use {{HARNESS_DIR}} or add a carve-out):\n" +
          stray.join("\n"),
      );
    }
    expect(stray).toEqual([]);
  });

  test("the {{HARNESS_DIR}} token is actually present in core/ (migration ran)", () => {
    let tokenFiles = 0;
    for (const file of walkMd(CORE)) {
      if (readFileSync(file, "utf-8").includes("{{HARNESS_DIR}}")) tokenFiles++;
    }
    // 60 core .md files carried a tokenizable path at migration time; assert a
    // healthy floor so a botched migration (token stripped) fails loudly.
    expect(tokenFiles).toBeGreaterThan(50);
  });
});
