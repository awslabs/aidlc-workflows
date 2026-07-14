// covers: function:extractMarkdownSection
//
// t80 — practices-runtime: extractMarkdownSection edge cases + the
// practices-event --type empty emit (v0.4.0 milestone 13).
// Technique: example-based.
//
// In-process migration of tests/unit/t80-practices-runtime.sh (TAP plan 7).
//
// MECHANISM SPLIT (mirrors the .sh assertion-by-assertion):
//   IN-PROCESS (import + call, mechanism none): tests 1-4 and 7 — five
//     extractMarkdownSection(inlineString) pure calls. The .sh ran a single
//     `bun -e` block (cases 1-4) plus one more `bun -e` (case 7) against
//     inline string literals and grepped the JSON-stringified return. Here
//     each becomes a direct extractMarkdownSection(...) call asserting the
//     SAME observable return — no CLI shell, no argv, no process.exit, so
//     all five port to in-process expect()s. This is the ONLY unit claimed
//     in covers: (function:extractMarkdownSection, minMechanism none —
//     verified verbatim in tests/.coverage-registry.json:698).
//   EXERCISED-FOR-PARITY, NOT CLAIMED (spawnSync, cli mechanism): tests 5-6
//     spawn `aidlc-state.ts practices-event --type empty` against a fixture
//     project and inspect the written audit.md, exactly as the .sh did. The
//     practices-event subcommand lives in aidlc-state.ts (out of scope here,
//     a `cli`-mechanism surface) — a `.none` file CANNOT credit a cli unit
//     (ladder: none < cli < sdk < tui). These two stay spawnSync(BUN, [...])
//     to preserve the .sh's behavioural contract (envelope + audit-row
//     fields) WITHOUT claiming coverage. Mirrors t89/t66's stance on their
//     CLI-boundary cases.
//
// Source read for this port:
//   dist/claude/.claude/tools/aidlc-lib.ts:1612
//     extractMarkdownSection(content, heading): string — strips fenced code
//     blocks first (stripFencedCodeBlocks :1643), matches the heading line
//     anchored `^<heading>[ \t]*$` (trailing-whitespace tolerant, exact-
//     match so `## Walking` never matches `## Walking Skeleton`), then
//     returns the slice up to the next `^## ` heading or EOF. Returns "" on
//     absent heading. Trailing newlines preserved (no .trim()).
//   dist/claude/.claude/tools/aidlc-state.ts:1006 handlePracticesEvent
//     — `--type empty` emits PRACTICES_SECTION_EMPTY and prints the envelope
//     {"emitted":"PRACTICES_SECTION_EMPTY","fields_count":N}; audit fields
//     render as `**Section**: ...` / `**Fallback**: ...` (aidlc-audit.ts:253).
//
// PARITY NOTE (honest): the .sh case 1 accepted EITHER `""` OR `"\n"` for the
// body-less section ("caller trims"). The real helper returns the single
// newline between the heading and the next `##` (verified at :1628/:1634), so
// this port pins the stronger fact — the returned body is whitespace-only
// (trims to "") — covering both shapes the .sh allowed.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractMarkdownSection,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const STATE_TS = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const GREENFIELD_STUB = join(import.meta.dir, "..", "fixtures", "greenfield-todo");

const BUN = process.execPath; // the bun binary running this test, for CLI-boundary checks

// =========================================================================
// Tests 1-4 + 7: extractMarkdownSection regex edge cases (IN-PROCESS).
// The .sh built these via inline `bun -e` string literals; ported as direct
// calls asserting the same JSON-equivalent return.
// =========================================================================

describe("t80 extractMarkdownSection edge cases (in-process)", () => {
  // .sh case 1 (PROBE EMPTY): body-less section returns whitespace-only.
  // rules-reading.md §1: caller treats this as empty after trim. The .sh
  // accepted "" OR "\n"; we pin the stronger "whitespace-only" contract.
  test("body-less section returns whitespace-only body (caller trims to empty)", () => {
    const empty = "## Walking Skeleton\n\n## Branching\nfoo\n";
    const body = extractMarkdownSection(empty, "## Walking Skeleton");
    expect(body.trim()).toBe("");
  });

  // .sh case 2 (PROBE COMMENT): HTML-comment-only section returns the literal
  // comment body verbatim — the helper does NOT treat it as empty; the CALLER
  // (orchestrator) decides emptiness for all-comment sections.
  test("HTML-comment-only section returns the literal comment body", () => {
    const commented =
      "## Walking Skeleton\n<!-- placeholder -->\n\n## Branching\nfoo\n";
    const body = extractMarkdownSection(commented, "## Walking Skeleton");
    expect(body).toContain("<!-- placeholder -->");
  });

  // .sh case 3 (PROBE WS): trailing whitespace on the heading line is
  // tolerated (regex anchors `[ \t]*$`); the body still extracts. The .sh
  // grepped for a leading "body"; here we pin the body content directly.
  test("tolerates trailing whitespace on the heading line", () => {
    const ws = "## Walking Skeleton   \nbody\n## Branching\nfoo";
    const body = extractMarkdownSection(ws, "## Walking Skeleton");
    expect(body).toBe("body\n");
  });

  // .sh case 4 (PROBE SUB): searching for "## Walking" against a doc whose
  // only heading is "## Walking Skeleton" must return "" — exact end-of-line
  // match, no sub-heading false positive.
  test("requires exact heading match (no sub-heading false positive)", () => {
    const sub = "## Walking Skeleton\nskeleton-body\n## Branching\nbranch-body";
    expect(extractMarkdownSection(sub, "## Walking")).toBe("");
  });

  // .sh case 7 (FENCED): a `## Heading` line inside a ``` fence must NOT be
  // mistaken for the real section. The real `## Walking Skeleton` appears
  // after a fenced teaching-example `## Walking Skeleton: never`; the helper
  // strips fences first, so the returned body is the real one.
  test("ignores '## Heading' lines inside fenced code blocks", () => {
    const doc =
      "## Branching\nuse trunk-based.\n\n```\n## Walking Skeleton: never\n```\n\n## Walking Skeleton\nreal-body\n";
    const body = extractMarkdownSection(doc, "## Walking Skeleton");
    expect(body).toContain("real-body");
    // The fenced teaching-example line is NOT surfaced as the section body.
    expect(body).not.toContain("never");
  });
});

// =========================================================================
// Tests 5-6: practices-event --type empty emit (spawnSync CLI-boundary).
// EXERCISED-FOR-PARITY, NOT CLAIMED in covers: — aidlc-state.ts is a `cli`
// surface and this is a `.none` file (ladder forbids the credit). Kept as
// a spawn so the .sh's envelope + audit-row-fields contract is preserved.
// =========================================================================

describe("t80 practices-event --type empty (spawnSync CLI-boundary, parity-only)", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length) {
      try {
        rmSync(scratch.pop()!, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  /** Rebuild `setup_integration_project --with-greenfield-stub`: a temp dir
   *  with aidlc-docs/, the framework .claude copied in, and the greenfield
   *  README stub. Returns the project dir. Nothing under tests/fixtures/ is
   *  written — the stub is COPIED FROM there into the temp project. */
  function setupIntegrationProject(): string {
    const proj = mkdtempSync(join(tmpdir(), "t80-proj-"));
    scratch.push(proj);
    mkdirSyncRecursive(join(proj, "aidlc-docs"));
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    cpSync(GREENFIELD_STUB, proj, { recursive: true });
    return proj;
  }

  function mkdirSyncRecursive(dir: string): void {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(dir, { recursive: true });
  }

  // .sh case 5: --type empty returns the PRACTICES_SECTION_EMPTY envelope.
  // The .sh grepped the compact JSON `"emitted":"PRACTICES_SECTION_EMPTY"`;
  // we parse stdout and assert the field, which is strictly stronger.
  test("--type empty returns PRACTICES_SECTION_EMPTY envelope", () => {
    const proj = setupIntegrationProject();
    const res = spawnSync(
      BUN,
      [
        STATE_TS,
        "practices-event",
        "--type",
        "empty",
        "--field",
        "Section: Walking Skeleton",
        "--field",
        "Fallback: org.md",
        "--project-dir",
        proj,
      ],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout) as { emitted: string };
    expect(envelope.emitted).toBe("PRACTICES_SECTION_EMPTY");
  });

  // .sh case 6: the PRACTICES_SECTION_EMPTY audit row carries Section +
  // Fallback fields. The .sh awk-sliced the block until the next `---` and
  // grepped for `**Section**: Walking Skeleton` / `**Fallback**: org.md`.
  test("PRACTICES_SECTION_EMPTY audit row carries Section + Fallback fields", () => {
    const proj = setupIntegrationProject();
    const res = spawnSync(
      BUN,
      [
        STATE_TS,
        "practices-event",
        "--type",
        "empty",
        "--field",
        "Section: Walking Skeleton",
        "--field",
        "Fallback: org.md",
        "--project-dir",
        proj,
      ],
      { encoding: "utf8" },
    );
    expect(res.status).toBe(0);

    // P9: the flat aidlc-docs/audit.md is retired. practices-event's
    // appendAuditEvent CREATES the bare SPACE record root's per-clone shard on
    // first emit (no state seeded → no intent resolves → bare root); read it via
    // the shard glob (readAllAuditShards).
    const audit = readAllAuditShards(proj);
    // Slice the PRACTICES_SECTION_EMPTY block up to the next `---` separator
    // (mirrors the .sh's `awk '/PRACTICES_SECTION_EMPTY/{flag=1} flag && /^---$/{exit} flag'`).
    const start = audit.indexOf("PRACTICES_SECTION_EMPTY");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = audit.slice(start);
    const sepIdx = rest.indexOf("\n---");
    const block = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
    expect(block).toContain("**Section**: Walking Skeleton");
    expect(block).toContain("**Fallback**: org.md");
  });
});
