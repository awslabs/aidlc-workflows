// covers: function:parseComposedScopeRecord, function:renderComposedScopeRecord, function:composedFoldBack
//
// t340 - the durable composed-scope RECORD contract.
//
// A composer-authored scope has no producer in core/, so a bare re-transpose
// cannot rebuild it. Before this record existed, compile folded it back from the
// on-disk scope-grid.json - the very file a copy-channel reinstall overwrites -
// so the sole copy of an approved scope lived in a generated tree and vanished
// silently. `aidlc/scopes/<name>.md` is now the durable source of record and the
// harness pair is its projection.
//
// This test pins the two halves that make that safe:
//
//   1. The RECORD FORMAT round-trips. A record is exactly the harness identity
//      `.md` plus one appended `## Stage Grid` section, so projecting is a pure
//      strip and back-filling is a pure append - neither direction re-renders
//      frontmatter, so no authored identity or prose is lost or reformatted.
//      Malformed input THROWS with the path named: a record's whole purpose is to
//      survive, so a silent skip would reintroduce the quiet loss it prevents.
//
//   2. composedFoldBack's SOURCE PRIORITY. Records win; the on-disk grid is the
//      one-time migration fallback for an install composed before records
//      existed; a stock name in records never shadows a stock scope; and a column
//      with no installed identity file stays dropped (an orphan is not a composed
//      scope, and resurrecting it would re-create the phantom).
//
// Mechanism = in-process: all three functions are pure, so they are called
// directly against literal inputs. No temp project, no env seams needed.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composedFoldBack,
  parseComposedScopeRecord,
  renderComposedScopeRecord,
  type ComposedScopeRecord,
} from "../../core/tools/aidlc-graph.ts";

const IDENTITY = [
  "---",
  "name: lean-feature",
  "depth: Minimal",
  "keywords: []",
  "description: composed by t340",
  "---",
  "",
  "# lean-feature",
  "",
  "Hand-written prose the composer left behind.",
  "",
].join("\n");

const STAGES: Record<string, "EXECUTE" | "SKIP"> = {
  "intent-capture": "EXECUTE",
  "requirements-analysis": "SKIP",
  "code-generation": "EXECUTE",
};

const RECORD = renderComposedScopeRecord(IDENTITY, STAGES);

// The sentinel pair, read back out of a rendered record rather than restated, so
// these tests can never drift from what the emitter actually writes.
const BEGIN = /^<!-- BEGIN aidlc composed-scope-grid:.*-->$/m.exec(RECORD)?.[0] ?? "";
const END = /^<!-- END aidlc composed-scope-grid -->$/m.exec(RECORD)?.[0] ?? "";

function recordFor(
  name: string,
  stages: Record<string, "EXECUTE" | "SKIP">,
): ComposedScopeRecord {
  return { name, identity: `---\nname: ${name}\n---\n`, stages };
}

const STOCK = new Set(["bugfix", "classic"]);

describe("t340 record format round-trip", () => {
  test("the sentinels were actually emitted (guards the two constants above)", () => {
    expect(BEGIN).toContain("BEGIN aidlc composed-scope-grid");
    expect(END).toBe("<!-- END aidlc composed-scope-grid -->");
  });

  test("render then parse recovers the name, the grid, and the identity verbatim", () => {
    const parsed = parseComposedScopeRecord(RECORD, "aidlc/scopes/lean-feature.md");
    expect(parsed.name).toBe("lean-feature");
    expect(parsed.stages).toEqual(STAGES);
    // The identity is the harness projection: the record minus the Stage Grid
    // section. Trailing-newline normalisation is the only permitted difference,
    // so the authored frontmatter AND prose survive a round-trip untouched.
    expect(parsed.identity.trimEnd()).toBe(IDENTITY.trimEnd());
  });

  test("re-rendering a parsed record is byte-stable (no drift across compiles)", () => {
    const parsed = parseComposedScopeRecord(RECORD, "r.md");
    expect(renderComposedScopeRecord(parsed.identity, parsed.stages)).toBe(RECORD);
  });

  test("the projection carries no generated region (it is harness-tree shaped)", () => {
    const parsed = parseComposedScopeRecord(RECORD, "r.md");
    expect(parsed.identity).not.toContain(BEGIN);
    expect(parsed.identity).not.toContain(END);
    expect(parsed.identity).not.toContain("```json");
  });
});

// The synthetic identity above is convenient but it is the test author's guess
// at what a composed scope looks like. This block runs the same round-trip over
// the VERBATIM output of a live composer run (captured in
// tests/fixtures/composed-scope-live/ - see t341's header for provenance), which
// carries frontmatter keys and a multi-heading prose body the synthetic case
// does not. If the format only survives artifacts we invented, it does not
// survive.
describe("t340 round-trip over a real composer-authored scope", () => {
  const FIXTURE_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "composed-scope-live",
  );
  const liveMd = readFileSync(join(FIXTURE_DIR, "scope.md"), "utf-8");
  const liveStages = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "stages.json"), "utf-8"),
  ) as Record<string, "EXECUTE" | "SKIP">;

  test("the fixture is the real thing, not another synthetic imitation", () => {
    // Keys a hand-written imitation would not have thought to include.
    expect(liveMd).toContain("skeleton:");
    expect(liveMd).toContain("change_control:");
    // A full 33-stage grid, and a prose body with its own `##` headings.
    expect(Object.keys(liveStages).length).toBeGreaterThan(30);
    expect(liveMd).toMatch(/^## /m);
  });

  test("back-fill then parse recovers the composer's bytes and grid exactly", () => {
    const record = renderComposedScopeRecord(liveMd, liveStages);
    const parsed = parseComposedScopeRecord(record, "aidlc/scopes/live.md");
    expect(parsed.name).toBe("pipeline-hardening-observability");
    expect(parsed.stages).toEqual(liveStages);
    // The projection is the composer's file back, untouched — every frontmatter
    // key and every prose heading, with no re-rendering.
    expect(parsed.identity.trimEnd()).toBe(liveMd.trimEnd());
    expect(parsed.identity).not.toContain(BEGIN);
    // And it is stable across repeated compiles.
    expect(renderComposedScopeRecord(parsed.identity, parsed.stages)).toBe(record);
  });
});

// The identity half of a record is PROSE THE USER WROTE, so the boundary between
// it and the generated grid must be something they cannot write by accident. An
// earlier draft split on a `## Stage Grid` heading; a scope author documenting
// their own plan with that heading made the parser adopt the first ```json fence
// in their prose as the grid — resolving the scope to a DIFFERENT set of executed
// stages — and drop every authored line after the collision on the next
// write-back. These cases pin that the sentinel boundary is immune.
describe("t340 authored prose cannot capture the grid boundary", () => {
  const hostile = [
    "---",
    "name: hostile",
    "depth: Minimal",
    "keywords: []",
    "---",
    "",
    "# hostile",
    "",
    "## Stage Grid", // the exact heading the old format split on
    "",
    "My plan, for humans (do not edit by hand):",
    "",
    "```json",
    '{ "stages": { "DECOY": "EXECUTE" } }', // a decoy fence in authored prose
    "```",
    "",
    "More authored prose that must survive.",
    "",
  ].join("\n");
  const real: Record<string, "EXECUTE" | "SKIP"> = {
    "intent-capture": "EXECUTE",
    "units-generation": "SKIP",
  };

  test("the real grid is adopted, not the decoy fence in the prose", () => {
    const parsed = parseComposedScopeRecord(
      renderComposedScopeRecord(hostile, real),
      "aidlc/scopes/hostile.md",
    );
    expect(parsed.stages).toEqual(real);
    expect(parsed.stages.DECOY).toBeUndefined();
  });

  test("every authored line survives, including the colliding heading", () => {
    const parsed = parseComposedScopeRecord(
      renderComposedScopeRecord(hostile, real),
      "aidlc/scopes/hostile.md",
    );
    expect(parsed.identity.trimEnd()).toBe(hostile.trimEnd());
    expect(parsed.identity).toContain("## Stage Grid");
    expect(parsed.identity).toContain("do not edit by hand");
    expect(parsed.identity).toContain("More authored prose that must survive.");
  });

  test("the round trip stays byte-stable, so repeated compiles never erode it", () => {
    const record = renderComposedScopeRecord(hostile, real);
    const parsed = parseComposedScopeRecord(record, "aidlc/scopes/hostile.md");
    expect(renderComposedScopeRecord(parsed.identity, parsed.stages)).toBe(record);
  });

  test("a duplicated sentinel is refused rather than resolved by guesswork", () => {
    const record = renderComposedScopeRecord(hostile, real);
    // Two generated regions: which one is the grid is unanswerable, and guessing
    // is how a wrong plan gets adopted silently.
    const doubled = record + record;
    expect(() => parseComposedScopeRecord(doubled, "aidlc/scopes/hostile.md")).toThrow(
      /exactly one of each is required/,
    );
  });

  test("render refuses an identity that already carries a sentinel", () => {
    const record = renderComposedScopeRecord(hostile, real);
    expect(() => renderComposedScopeRecord(record, real)).toThrow(
      /already contains an aidlc composed-scope-grid sentinel/,
    );
  });
});

describe("t340 record parse failures name the file and never degrade silently", () => {
  // Build a body with a real generated region so each case isolates ONE defect.
  const withRegion = (frontmatter: string, fence: string): string =>
    `${frontmatter}\n\n${BEGIN}\n\n\`\`\`json\n${fence}\n\`\`\`\n\n${END}\n`;

  const cases: Array<[string, string, RegExp]> = [
    ["no frontmatter", withRegion("# just prose", "{}"), /missing frontmatter/],
    [
      "frontmatter without name",
      withRegion("---\ndepth: Minimal\n---", '{"stages":{}}'),
      /missing required frontmatter: name/,
    ],
    ["no grid region at all", "---\nname: x\n---\n\n# x\n", /has no generated grid region/],
    [
      "BEGIN sentinel but no END",
      `---\nname: x\n---\n\n${BEGIN}\n\n\`\`\`json\n{"stages":{}}\n\`\`\`\n`,
      /has no generated grid region/,
    ],
    [
      "END sentinel before BEGIN",
      `---\nname: x\n---\n\n${END}\n\n\`\`\`json\n{"stages":{}}\n\`\`\`\n\n${BEGIN}\n`,
      /END grid sentinel before its BEGIN/,
    ],
    [
      "region without a json fence",
      `---\nname: x\n---\n\n${BEGIN}\n\nnothing here\n\n${END}\n`,
      /no\s+```json fence inside it/,
    ],
    [
      "a json fence OUTSIDE the region but none inside",
      `---\nname: x\n---\n\n\`\`\`json\n{"stages":{"a":"EXECUTE"}}\n\`\`\`\n\n${BEGIN}\n\nempty\n\n${END}\n`,
      /no\s+```json fence inside it/,
    ],
    [
      "unparseable fence",
      withRegion("---\nname: x\n---", "{not json}"),
      /unparseable grid fence/,
    ],
    [
      "fence without a stages member",
      withRegion("---\nname: x\n---", '{"grid":{}}'),
      /must be an object with a "stages" member/,
    ],
    [
      "invalid action",
      withRegion("---\nname: x\n---", '{"stages":{"a":"MAYBE"}}'),
      /invalid action "MAYBE"/,
    ],
  ];
  for (const [what, body, diagnostic] of cases) {
    test(`throws on ${what}`, () => {
      expect(() => parseComposedScopeRecord(body, "aidlc/scopes/x.md")).toThrow(diagnostic);
      // Every diagnostic names the offending path so the user can act on it.
      expect(() => parseComposedScopeRecord(body, "aidlc/scopes/x.md")).toThrow(
        /aidlc\/scopes\/x\.md/,
      );
    });
  }

  test("the missing-region message names the recovery path", () => {
    // The record is committed user work, so aborting compile has to tell the
    // reader how to get moving again without inventing a repair.
    expect(() => parseComposedScopeRecord("---\nname: x\n---\n", "aidlc/scopes/x.md")).toThrow(
      /deleting this record and re-running compile/,
    );
  });
});

describe("t340 composedFoldBack source priority", () => {
  const installed = new Set(["lean", "older", "bugfix", "classic"]);

  test("a record wins over a conflicting on-disk grid column", () => {
    const onDisk = JSON.stringify({ lean: { stages: { a: "SKIP" } } });
    const r = composedFoldBack(
      { lean: recordFor("lean", { a: "EXECUTE" }) },
      onDisk,
      STOCK,
      installed,
    );
    expect(JSON.parse(r.json)).toEqual({ lean: { stages: { a: "EXECUTE" } } });
    expect([...r.recordNames]).toEqual(["lean"]);
    expect([...r.gridOnlyNames]).toEqual([]);
  });

  test("a grid-only composed column survives as the migration fallback", () => {
    const onDisk = JSON.stringify({
      bugfix: { stages: { a: "EXECUTE" } }, // stock: not composed
      older: { stages: { a: "EXECUTE", b: "SKIP" } }, // composed before records
    });
    const r = composedFoldBack({}, onDisk, STOCK, installed);
    expect(JSON.parse(r.json)).toEqual({ older: { stages: { a: "EXECUTE", b: "SKIP" } } });
    // Reported separately so the write side knows exactly what to back-fill.
    expect([...r.gridOnlyNames]).toEqual(["older"]);
    expect([...r.recordNames]).toEqual([]);
  });

  test("records and the grid fallback compose in one fold-back", () => {
    const onDisk = JSON.stringify({ older: { stages: { a: "SKIP" } } });
    const r = composedFoldBack(
      { lean: recordFor("lean", { a: "EXECUTE" }) },
      onDisk,
      STOCK,
      installed,
    );
    expect(Object.keys(JSON.parse(r.json)).sort()).toEqual(["lean", "older"]);
    expect([...r.names]).toEqual(["lean", "older"]);
  });

  test("a record named after a STOCK scope never shadows it", () => {
    const r = composedFoldBack(
      { bugfix: recordFor("bugfix", { a: "SKIP" }) },
      null,
      STOCK,
      installed,
    );
    // Stock columns come from the transpose; a same-named record must not
    // override the shipped grid or it would silently retune a stock scope.
    expect(JSON.parse(r.json)).toEqual({});
    expect([...r.names]).toEqual([]);
  });

  test("a name with no installed identity file is dropped from BOTH sources", () => {
    const onDisk = JSON.stringify({ ghost: { stages: { a: "EXECUTE" } } });
    const r = composedFoldBack(
      { alsoGhost: recordFor("alsoGhost", { a: "EXECUTE" }) },
      onDisk,
      STOCK,
      new Set(["bugfix"]),
    );
    // A grid column with no `.md` is an orphan, not a composed scope; a record
    // whose projection is still missing is materialized first, then re-read.
    expect(JSON.parse(r.json)).toEqual({});
    expect([...r.names]).toEqual([]);
  });

  test("a malformed on-disk grid contributes nothing but records still fold", () => {
    const r = composedFoldBack(
      { lean: recordFor("lean", { a: "EXECUTE" }) },
      "{not json",
      STOCK,
      installed,
    );
    expect(JSON.parse(r.json)).toEqual({ lean: { stages: { a: "EXECUTE" } } });
  });

  test("no records and no grid folds back nothing", () => {
    const r = composedFoldBack({}, null, STOCK, installed);
    expect(JSON.parse(r.json)).toEqual({});
    expect([...r.names]).toEqual([]);
  });
});
