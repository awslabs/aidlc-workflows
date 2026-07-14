// t153-engine-directive-harness-seam: a conductor directive string built in
// core/tools/*.ts (or core/hooks/*.ts) that names the harness tools dir MUST
// go through harnessDir() — never a hardcoded `.claude/tools/` (or `.kiro/` /
// `.codex/`) literal.
//
// covers: function:harnessDir
//
// WHY THIS GUARD EXISTS. The deterministic engine emits `print` directives whose
// `message` tells the conductor to run a tool, e.g.
//   `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts init --scope ...\` ...`
// The .ts tools are BYTE-COPIED into every harness dist (dist/claude/.claude/,
// dist/kiro/.kiro/, dist/codex/.codex/) — harnessDir() resolves the right tree
// at RUN time. A directive that hardcodes `bun .claude/tools/aidlc-*.ts` instead
// would ship verbatim into the Kiro and Codex trees and tell their conductors to
// run a tool at a path that does not exist there — the workflow-birth /
// scope-change / config-change / jump directives would fail on 2 of 3 harnesses.
//
// This is the exact CRIT-class seam bug the dist-unified review found for the
// rules dir (rulesSubdir). The merge-endgame re-homed v0.6.8's birthPrintDirective
// into core/, where main's original hardcoded `.claude/tools/aidlc-utility.ts`;
// the port rewrote it to `${harnessDir()}/tools/...`. This test is the
// determinism mechanism that proves no such literal re-enters a directive string
// — t146 guards the SAME leak in core/*.md prose; this guards core/*.ts directives.
//
// SCOPE (deliberately narrow — avoids the ~59 legitimate `.claude/` literals in
// core .ts that are comments, error text naming the literal Claude tree, install
// instructions like `dist/claude/.claude/settings.json`, and the example
// directive-shape fixtures in aidlc-directive.ts). The dangerous form is
// specifically a SHELL COMMAND that runs a harness tool: `bun <harness>/tools/`.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = join(REPO_ROOT, "core");
const SCAN_DIRS = [join(CORE, "tools"), join(CORE, "hooks")];

// A `bun <dir>/tools/` (or /hooks/) shell-command fragment whose <dir> is a
// HARDCODED harness directory literal rather than a ${harnessDir()} call.
// Matches `bun .claude/tools/`, `bun .kiro/tools/`, `bun .codex/tools/` and the
// hooks variants. Does NOT match `bun ${harnessDir()}/tools/` (the seam) nor
// `bun dist/claude/.claude/tools/` (an install-instruction path, which names the
// distributable, not a runtime directive the conductor executes).
const HARDCODED_DIRECTIVE_RE =
  /bun\s+\.(claude|kiro|codex)\/(tools|hooks)\//;

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

describe("t153 engine directive harness seam — no hardcoded .claude/tools in core directives", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: test name documents literal source syntax
  test("every `bun <harness>/tools|hooks/` directive in core/*.ts uses ${harnessDir()}, not a hardcoded dir", () => {
    const stray: string[] = [];
    for (const scanDir of SCAN_DIRS) {
      for (const file of walkTs(scanDir)) {
        const rel = relative(CORE, file);
        const lines = readFileSync(file, "utf-8").split("\n");
        lines.forEach((line, i) => {
          if (HARDCODED_DIRECTIVE_RE.test(line)) {
            stray.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    if (stray.length > 0) {
      console.error(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: diagnostic prescribes literal source syntax
        "hardcoded harness-dir tool directives in core/ (use `bun ${harnessDir()}/tools/...`):\n" +
          stray.join("\n"),
      );
    }
    expect(stray).toEqual([]);
  });

  test("harnessDir() IS the idiom the engine's directive strings use (seam in active use)", () => {
    // Positive control: the engine MUST build at least some directive through
    // harnessDir() — if this drops to zero, a refactor has bypassed the seam and
    // the negative test above would be vacuously green.
    let seamUses = 0;
    for (const scanDir of SCAN_DIRS) {
      for (const file of walkTs(scanDir)) {
        const src = readFileSync(file, "utf-8");
        const m = src.match(/bun \$\{harnessDir\(\)\}\/tools\//g);
        if (m) seamUses += m.length;
      }
    }
    expect(seamUses).toBeGreaterThan(0);
  });
});
