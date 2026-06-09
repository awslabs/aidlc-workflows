// covers: function:parseStageFrontmatter
//
// Content-structure port of tests/unit/t14-stage-content-validation.sh (TAP
// plan 160 = 32 stage files x 5 assertions each). Mechanism = none.
//
// The .sh's first two per-stage assertions ("has Phase field" / "has Lead
// Agent field") drove the COVERS target — parseStageFrontmatter — through a
// `bun -e` one-shot (frontmatter_field, t14...:15-23) that imported the
// function from aidlc-lib.ts, parsed a stage file, and printed the named
// scalar (empty string if absent/non-string). parseStageFrontmatter is a PURE
// function — "no I/O, no validation" (aidlc-lib.ts:884-888) — and aidlc-lib.ts
// carries NO `import.meta.main` block (grep-verified: 0 matches), so it is a
// library, not a CLI entrypoint. There is no process boundary to keep as a
// spawn seam: every contract migrates to in-process expect() calls. We read
// each shipped stage .md with readFileSync and call parseStageFrontmatter
// directly, replacing the per-file `bun -e` subprocess (one spawn per field
// per file in the .sh) with a single in-process parse per file. Zero spawns
// remain, zero LLM, zero tokens.
//
// The remaining three .sh assertions per stage (stage-protocol reference,
// Steps/PART heading, Outputs reference) were bash greps over the raw file
// bytes (assert_grep / grep -q / grep -qi). They exercise the stage-file
// CONTENT contract, not parseStageFrontmatter, and migrate to the same
// regex/substring checks over the readFileSync bytes — same observable (the
// substring/heading is present in the file), expressed in TS.
//
// FIXTURE DISCIPLINE: this test reads the SHIPPED stage files under
// dist/claude/.claude/skills/aidlc/stages/ (resolved via AIDLC_SRC from
// tests/harness/fixtures.ts, exactly as the .sh resolved $AIDLC_SRC). It writes
// nothing, mutates nothing, and spawns nothing. The stage set is discovered the
// same way the .sh did: iterate every phase dir, then every *.md inside it.
//
// PARITY NOTE on the .sh frontmatter_field "empty string if absent or
// non-string" protocol: the original reduced parseStageFrontmatter's object
// return to a single printed scalar so bash could test `[ -n "$val" ]`. In
// process we assert the object field directly — the field is present, a string,
// and non-empty — which is strictly STRONGER than the .sh's bare non-empty
// test: the .sh would also pass if the value were a non-string truthy that
// frontmatter_field happened to stringify, whereas here we pin `typeof === string`
// AND `.length > 0`, matching frontmatter_field's `typeof v === 'string' ? v : ''`
// reduction (t14...:21) before the `[ -n ]` test.
//
// EQUAL-OR-STRONGER additions (beyond the 160 .sh assertions):
//   - S1: a count guard asserting exactly 32 stage files are discovered, so a
//     dropped/renamed stage dir surfaces as a hard failure instead of silently
//     shrinking the matrix (the .sh's `plan 160` would have caught a count
//     drift only as a TAP plan/observed mismatch; here it is an explicit assert).
//   - S2: a guard that parseStageFrontmatter throws on a non-string argument and
//     on frontmatter-less input — pins the two documented throw paths
//     (aidlc-lib.ts:896-904) that the .sh never exercised (it only ever fed real
//     stage-file strings). Strengthens coverage of the COVERS target itself.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");

// Discover every (phase, stage-file) pair the same way the .sh did:
//   for phase_dir in "$STAGES_DIR"/*/; do
//     for stage_file in "$phase_dir"*.md; do ...
// Returns { slug, path } records ordered by phase dir then file, mirroring the
// shell glob expansion order. Only regular *.md files count (the `[ -f ]` guard).
function discoverStages(): { slug: string; path: string }[] {
  const out: { slug: string; path: string }[] = [];
  for (const phase of readdirSync(STAGES_DIR, { withFileTypes: true })) {
    if (!phase.isDirectory()) continue;
    const phaseDir = join(STAGES_DIR, phase.name);
    for (const entry of readdirSync(phaseDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      out.push({
        slug: entry.name.slice(0, -3), // basename without .md
        path: join(phaseDir, entry.name),
      });
    }
  }
  return out;
}

const STAGES = discoverStages();

// Mirror of the .sh frontmatter_field helper (t14...:15-23): parse the file and
// return the named field IFF it is a string, else "". Same reduction the .sh
// applied before its `[ -n "$val" ]` test.
function frontmatterField(path: string, key: string): string {
  const obj = parseStageFrontmatter(readFileSync(path, "utf8"));
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

describe("t14 stage-content-validation — parseStageFrontmatter (migrated from t14-stage-content-validation.sh, plan 160)", () => {
  // S1 (STRONGER): the .sh planned exactly 160 assertions over 32 stages x 5.
  // Pin the discovered stage count so a dropped/renamed/added stage dir fails
  // loudly here rather than as an opaque TAP plan mismatch.
  test("discovers exactly 32 stage files (5 assertions each = 160)", () => {
    expect(STAGES.length).toBe(32);
  });

  // S2 (STRONGER): pin parseStageFrontmatter's two documented throw paths — the
  // COVERS target's error contract, which the .sh never fed (it only passed real
  // stage-file strings).
  test("parseStageFrontmatter throws on non-string input", () => {
    // @ts-expect-error — deliberately wrong arg type to exercise the guard.
    expect(() => parseStageFrontmatter(42)).toThrow(
      "parseStageFrontmatter expected string, got number",
    );
  });

  test("parseStageFrontmatter throws on frontmatter-less input", () => {
    expect(() => parseStageFrontmatter("# no frontmatter here")).toThrow(
      "missing YAML frontmatter",
    );
  });

  // The five per-stage assertions, mirroring the .sh inner loop (t14...:30-61).
  // describe.each gives one labelled block per stage so a failure names the slug,
  // matching the .sh's "<slug> has Phase field" message granularity.
  describe.each(STAGES.map((s) => [s.slug, s.path] as const))(
    "%s",
    (slug: string, path: string) => {
      // .sh assertion 1: frontmatter has non-empty `phase` field
      //   `[ -n "$phase_val" ]` -> ok "$slug has Phase field"
      // Driven by parseStageFrontmatter (the COVERS target).
      test(`${slug} has Phase field`, () => {
        const v = frontmatterField(path, "phase");
        expect(typeof v).toBe("string");
        expect(v.length).toBeGreaterThan(0);
      });

      // .sh assertion 2: frontmatter has non-empty `lead_agent` field
      //   `[ -n "$agent_val" ]` -> ok "$slug has Lead Agent field"
      // Driven by parseStageFrontmatter (the COVERS target).
      test(`${slug} has Lead Agent field`, () => {
        const v = frontmatterField(path, "lead_agent");
        expect(typeof v).toBe("string");
        expect(v.length).toBeGreaterThan(0);
      });

      // .sh assertion 3: references stage-protocol
      //   assert_grep "$stage_file" "stage-protocol" (t14...:47)
      test(`${slug} references stage-protocol`, () => {
        const body = readFileSync(path, "utf8");
        expect(body).toContain("stage-protocol");
      });

      // .sh assertion 4: has Steps or PART structural heading
      //   grep -q "^## Steps\|^## PART" (t14...:50)
      test(`${slug} has Steps/PART section`, () => {
        const body = readFileSync(path, "utf8");
        expect(/^## Steps|^## PART/m.test(body)).toBe(true);
      });

      // .sh assertion 5: has Outputs reference (case-insensitive)
      //   grep -qi "outputs" (t14...:57)
      test(`${slug} has Outputs field`, () => {
        const body = readFileSync(path, "utf8");
        expect(/outputs/i.test(body)).toBe(true);
      });
    },
  );
});
