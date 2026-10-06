// t153-engine-directive-harness-seam: a conductor directive string built in
// core/tools/*.ts (or core/hooks/*.ts) that tells the conductor to run a tool
// MUST resolve both halves of the seam at run time — WHICH tree through
// harnessDir(), and HOW to launch through aidlcInvocation()/
// aidlcToolInvocation(). Each half fails independently.
//
// covers: function:harnessDir, function:aidlcToolInvocation, function:aidlcInvocation
//
// WHY THIS GUARD EXISTS. The deterministic engine emits `print` directives whose
// `message` tells the conductor to run a tool, e.g.
//   `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts init --scope ...\` ...`
// The .ts tools are BYTE-COPIED into every harness dist; harnessDir() resolves
// the right tree at RUN time. A directive that hardcodes one harness directory
// ships verbatim into the others and tells their conductors to run a tool at a
// path that does not exist there.
//
// This is the exact CRIT-class seam bug the dist-unified review found for the
// rules dir (rulesSubdir). The merge-endgame re-homed v0.6.8's createPrintDirective
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
// The launcher guard reads that same form from the other side: any tree
// spelling, no `bun` prefix.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = join(REPO_ROOT, "core");
const SCAN_DIRS = [join(CORE, "tools"), join(CORE, "hooks")];

// A `bun <dir>/tools/` (or /hooks/) shell-command fragment whose <dir> is a
// HARDCODED harness directory literal rather than a ${harnessDir()} call.
// Matches every shipped harness directory and its tools/hooks variants. Does
// NOT match `bun ${harnessDir()}/tools/` (the seam) nor
// `bun dist/claude/.claude/tools/` (an install-instruction path, which names the
// distributable, not a runtime directive the conductor executes).
const HARDCODED_DIRECTIVE_RE =
  /bun\s+\.(claude|kiro|codex|aidlc|cursor)\/(tools|hooks)\//;

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

  // A `bun <dir>/tools/` prefix hardcodes the copy channel: native installs ship
  // no `.ts` under the harness tree and need no bun on PATH, so the conductor is
  // handed a command it cannot run — worst at the Stop hook, which blocks
  // turn-end. The split-literal pattern catches the concatenated form
  // (`run \`bun " + hd + "/tools/...`) that the line-oriented guard above misses.
  const BUN_PREFIXED_TOOL_RE =
    /bun\s+(?:\$\{[^}]*\}|\.[A-Za-z0-9_.-]+)\/(?:tools|hooks)\/aidlc-[A-Za-z0-9_-]+\.ts/;
  const BUN_PREFIX_SPLIT_RE = /bun\s*["'`]\s*\+\s*$/;

  // Spelling BOTH channels on one line is a receipt-matching enumeration
  // (aidlc-lib.ts hashes each spelling), not a command for a conductor.
  const enumeratesBothChannels = (line: string): boolean =>
    /["'`]aidlc engine /.test(line);

  test("no directive launches a tool through a hardcoded `bun` prefix", () => {
    const stray: string[] = [];
    for (const scanDir of SCAN_DIRS) {
      for (const file of walkTs(scanDir)) {
        // The resolver itself owns the copy-channel spelling it returns.
        if (file.endsWith("aidlc-runtime-paths.ts")) continue;
        const rel = relative(CORE, file);
        readFileSync(file, "utf-8").split("\n").forEach((line, i) => {
          if (line.trimStart().startsWith("//")) return;
          if (enumeratesBothChannels(line)) return;
          if (BUN_PREFIXED_TOOL_RE.test(line) || BUN_PREFIX_SPLIT_RE.test(line)) {
            stray.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    if (stray.length > 0) {
      console.error(
        "directives launching a tool through a hardcoded `bun` prefix (use " +
          "aidlcToolInvocation()/aidlcInvocation() so native installs resolve " +
          "`aidlc engine <route>`):\n" + stray.join("\n"),
      );
    }
    expect(stray).toEqual([]);
  });

  // Negative control: the scan above passes trivially if the patterns match nothing.
  test("the `bun` prefix patterns match the shapes that shipped broken", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture reproduces literal source syntax
    const singleLine = "`Run \\`bun ${harnessDir()}/tools/aidlc-orchestrate.ts next\\`.`";
    const split = '"... on approve run `bun " +';
    expect(BUN_PREFIXED_TOOL_RE.test(singleLine)).toBe(true);
    expect(BUN_PREFIX_SPLIT_RE.test(split)).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture reproduces literal source syntax
    const resolvedSeam = '`${aidlcToolInvocation("orchestrate")} next`';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture reproduces literal source syntax
    const bothChannels = '["aidlc engine jump", `bun ${harnessDir()}/tools/aidlc-jump.ts`]';
    expect(BUN_PREFIXED_TOOL_RE.test(resolvedSeam)).toBe(false);
    expect(enumeratesBothChannels(bothChannels)).toBe(true);
  });

  test("aidlcToolInvocation() is the active directive invocation seam", () => {
    // Positive control: engine directives MUST call the channel-aware helper.
    // Exclude its declaration so this proves call sites remain in active use.
    let seamUses = 0;
    for (const scanDir of SCAN_DIRS) {
      for (const file of walkTs(scanDir)) {
        if (file.endsWith("aidlc-runtime-paths.ts")) continue;
        const src = readFileSync(file, "utf-8");
        const m = src.match(/aidlcToolInvocation\(/g);
        if (m) seamUses += m.length;
      }
    }
    expect(seamUses).toBeGreaterThan(0);
  });
});
