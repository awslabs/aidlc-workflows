// covers: function:parseStageFrontmatter
//
// Content-structure contract over the shipped stage files. Mechanism = none.
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
// EQUAL-OR-STRONGER additions (beyond the 160 .sh assertions):
//   - S1: a count guard asserting exactly 33 stage files are discovered, so a
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

// Parse the file and return the named field IFF it is a string, else "".
function frontmatterField(path: string, key: string): string {
  const obj = parseStageFrontmatter(readFileSync(path, "utf8"));
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

describe("t14 stage-content-validation — parseStageFrontmatter (migrated from t14-stage-content-validation.sh, plan 160)", () => {
  // Pin the discovered stage count so a dropped/renamed/added stage dir fails
  // loudly here.
  test("discovers exactly 33 stage files (5 assertions each = 165)", () => {
    expect(STAGES.length).toBe(33);
  });

  // S2: pin parseStageFrontmatter's two documented throw paths - the COVERS
  // target's error contract.
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

  // The five per-stage assertions.
  // describe.each gives one labelled block per stage so a failure names the slug.
  describe.each(STAGES.map((s) => [s.slug, s.path] as const))(
    "%s",
    (slug: string, path: string) => {
      test(`${slug} has Phase field`, () => {
        const v = frontmatterField(path, "phase");
        expect(typeof v).toBe("string");
        expect(v.length).toBeGreaterThan(0);
      });

      test(`${slug} has Lead Agent field`, () => {
        const v = frontmatterField(path, "lead_agent");
        expect(typeof v).toBe("string");
        expect(v.length).toBeGreaterThan(0);
      });

      test(`${slug} references stage-protocol`, () => {
        const body = readFileSync(path, "utf8");
        expect(body).toContain("stage-protocol");
      });

      test(`${slug} has Steps/PART section`, () => {
        const body = readFileSync(path, "utf8");
        expect(/^## Steps|^## PART/m.test(body)).toBe(true);
      });

      test(`${slug} has Outputs field`, () => {
        const body = readFileSync(path, "utf8");
        expect(/outputs/i.test(body)).toBe(true);
      });
    },
  );
});
