// covers: function:validateDocumentIndex function:validateDocumentMetadata function:validDocumentPath function:derivativeIsCurrent function:effectiveExtractionState function:isTombstoned function:DOCUMENTKB_SCHEMA_VERSION function:EXTRACTION_STATES function:SOURCE_KINDS
//
// t288 - the DocumentKB index + per-document metadata schema. `index.json` and
// `metadata.json` are COMMITTED files, so they arrive from a clone, a merge, a
// rebase, or a hand-edit: they are untrusted input, and a reader that trusts
// their shape is an arbitrary-file-read with extra steps.
//
// Mechanism: none. Pure data-in / data-out validators - zero I/O, zero spawn,
// zero LLM, zero tokens. A direct import satisfies the "none" minMechanism.
//
// Subject under test: dist/claude/.claude/tools/aidlc-documentkb-schema.ts (the
// SHIPPED distributable, not core/ - a guard reverted only in core/ still passes
// when the test imports dist, which would fake the "the test observes the
// defect" conclusion).
//
// The contract, and why each half exists:
//
//   schema_version is top-level and FAILS CLOSED on an unsupported value. A
//   forward-version file rewritten by an older writer silently loses whatever
//   fields the newer schema added, so refusing is the non-destructive answer.
//
//   `source` is DISCRIMINATED on kind, so "managed carrying an alias" and
//   "linked with no alias" are both unspellable rather than merely discouraged.
//
//   `path` is never absolute and never contains `..` in either kind. An absolute
//   path in committed metadata leaks one developer's layout to every clone, and
//   is the traversal primitive besides.
//
//   `extraction` is a six-state union because each state implies a DIFFERENT
//   remedy; collapsing them into one "unsupported" string sends the user down
//   the wrong path.
//
//   derivatives are REVISION-BOUND. `invalidated` is DERIVED from a digest
//   mismatch, not merely a value a writer may set, so an edited original cannot
//   serve stale extracted text under a fresh digest.
//
//   duplicate ids are rejected on READ. Lookups are by id, so every row after
//   the first would be silently unreachable.
//
//   related_intent_ids is OMITTED when space-wide; an EMPTY LIST IS INVALID
//   (ambiguous between "space-wide" and "scoped to nothing"), and every member
//   is a canonical UUID because a slug is a renameable display name.

import { describe, expect, test } from "bun:test";
import {
  derivativeIsCurrent,
  DOCUMENTKB_SCHEMA_VERSION,
  effectiveExtractionState,
  EXTRACTION_STATES,
  isTombstoned,
  SOURCE_KINDS,
  validDocumentPath,
  validateDocumentIndex,
  validateDocumentMetadata,
} from "../../dist/claude/.claude/tools/aidlc-documentkb-schema.ts";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const CONTENT_DIGEST = "c".repeat(64);
const UUID = "019fda80-8f8d-7bfa-b56c-983cf0353faa";
const UUID2 = "019fda80-8f8d-7bfa-b56c-983cf0353fab";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID,
    source: { kind: "managed", path: "documents/security/policy.pdf" },
    sha256: DIGEST,
    bytes: 48213,
    indexed_at: "2026-08-07T04:15:37Z",
    // A COMPLETE `extracted` record per the design's "Carries" column — see
    // DESIGN_CONFORMANT_EXTRACTION below. It has to be complete, or every test
    // using this helper would be asserting against a record the writer could
    // never legitimately produce.
    extraction: {
      state: "extracted",
      extractor: { name: "pdftotext", version: "24.02.0" },
      chars: 18422,
      truncated: false,
      source_revision: DIGEST,
    },
    summary: { state: "absent" },
    ...overrides,
  };
}

function index(rows: Record<string, unknown>[], version = DOCUMENTKB_SCHEMA_VERSION) {
  return { schema_version: version, documents: rows };
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: DOCUMENTKB_SCHEMA_VERSION,
    ...row(),
    content_trust: "untrusted",
    content_handling: "data-not-instructions",
    ...overrides,
  };
}

/** The first error mentioning `needle`, or "" — asserts on the REASON, not just
 *  that something failed, so a validator rejecting for an unrelated reason
 *  cannot pass a negative test. */
function errorMatching(errors: string[], needle: RegExp): string {
  return errors.find((e) => needle.test(e)) ?? "";
}

/** One design-conformant `extraction` record per state, transcribed from the
 *  extraction-state table's "Carries" column in docs/guide/08-knowledge.md.
 *
 *  Read the table, not the validator, when changing this. The whole reason it
 *  exists as a literal is that a fixture built from the implementation's current
 *  requirements is circular — it proves the validator agrees with itself. */
const DESIGN_CONFORMANT_EXTRACTION: Record<string, Record<string, unknown>> = {
  // Carries: extractor{name,version}, chars, truncated, source_revision
  extracted: {
    state: "extracted",
    extractor: { name: "pdftotext", version: "24.02.0" },
    chars: 18422,
    truncated: false,
    source_revision: DIGEST,
  },
  // Carries: extractor{name,version}, source_revision. The extractor RAN.
  no_extractable_text: {
    state: "no_extractable_text",
    extractor: { name: "pdftotext", version: "24.02.0" },
    source_revision: DIGEST,
  },
  // Carries: attempted extractor.name ONLY — nothing ran, so there is no
  // version, and inventing one would be a fabricated fact. ALSO carries
  // detectedType (finding 5(c)): the mime a retry needs to re-probe once an
  // extractor for it exists -- without it, `detectMimeFromRow` fell back to
  // guessing from the file extension, and a `.docx` row could never become
  // retryable no matter what got installed later.
  extractor_unavailable: {
    state: "extractor_unavailable",
    extractor: { name: "pdftotext" },
    detectedType: "application/pdf",
  },
  // Carries: extractor{name,version}, reason
  extraction_failed: {
    state: "extraction_failed",
    extractor: { name: "pdftotext", version: "24.02.0" },
    reason: "input exceeds the 32 MiB cap and was never opened",
    detectedType: "application/pdf",
  },
  // Carries: detected type. No extractor is even configured.
  unsupported_type: {
    state: "unsupported_type",
    detectedType: "image/png",
  },
  // Carries: the STALE source_revision, which is what makes the mismatch visible.
  invalidated: {
    state: "invalidated",
    source_revision: OTHER_DIGEST,
  },
};

describe("t288 the happy path is genuinely accepted", () => {
  test("a minimal valid index round-trips", () => {
    const r = validateDocumentIndex(index([row()]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.documents[0].id).toBe(UUID);
  });

  test("an empty document list is valid — a fresh DocumentKB has no rows", () => {
    expect(validateDocumentIndex(index([])).ok).toBe(true);
  });

  test("a space-wide row OMITS related_intent_ids entirely", () => {
    const r = validateDocumentIndex(index([row()]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("related_intent_ids" in r.value.documents[0]).toBe(false);
    }
  });

  test("an intent-scoped row carries canonical UUIDs", () => {
    expect(validateDocumentIndex(index([row({ related_intent_ids: [UUID, UUID2] })])).ok).toBe(true);
  });

  test("every declared extraction state is accepted with its required fields", () => {
    // Drives off the exported union so a state added to the type without a
    // decision here cannot slip through untested.
    expect([...EXTRACTION_STATES]).toEqual([
      "extracted",
      "no_extractable_text",
      "extractor_unavailable",
      "extraction_failed",
      "unsupported_type",
      "invalidated",
    ]);
    // The DESIGN-CONFORMANT record for each state, transcribed from the
    // extraction-state table's "Carries" column — NOT reverse-engineered from
    // what the validator happens to accept. That distinction is the point: an
    // earlier version of this test built each record from the implementation's
    // requirements, so it could not see that `extracted` was under-enforced or
    // that `extractor_unavailable` was being wrongly refused.
    for (const [state, extraction] of Object.entries(DESIGN_CONFORMANT_EXTRACTION)) {
      const r = validateDocumentIndex(index([row({ extraction })]));
      expect(r.ok, `${state}: ${r.ok ? "" : r.errors.join("; ")}`).toBe(true);
    }
    // And the table covers the whole union, so a new state cannot be added
    // without a design-conformant fixture here.
    expect(Object.keys(DESIGN_CONFORMANT_EXTRACTION).sort()).toEqual([...EXTRACTION_STATES].sort());
  });

  test("both source kinds are accepted in their own shape", () => {
    expect([...SOURCE_KINDS]).toEqual(["managed", "linked"]);
    expect(validateDocumentIndex(index([row()])).ok).toBe(true);
    expect(validateDocumentIndex(index([
      row({ source: { kind: "linked", alias: "corp-policies", path: "security/policy.pdf" } }),
    ])).ok).toBe(true);
  });
});

describe("t288 schema_version fails CLOSED", () => {
  test("a FORWARD version is refused rather than rewritten", () => {
    const r = validateDocumentIndex(index([], DOCUMENTKB_SCHEMA_VERSION + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The message must explain the non-destructive intent, because the user's
      // instinct on seeing this is to delete the file.
      expect(errorMatching(r.errors, /schema_version must be/)).toContain("refuses");
    }
  });

  test("a missing or non-numeric version is refused", () => {
    for (const bad of [undefined, null, "1", 0, 1.5, [], {}]) {
      const r = validateDocumentIndex({ schema_version: bad, documents: [] });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("the version check precedes row validation, so the report is not noise", () => {
    // A wrong version with garbage rows should report the version only — telling
    // the user their rows are malformed against the WRONG schema is misleading.
    const r = validateDocumentIndex({ schema_version: 99, documents: [{ garbage: true }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(1);
  });

  test("metadata.json gets the same treatment", () => {
    expect(validateDocumentMetadata(metadata({ schema_version: 99 })).ok).toBe(false);
  });
});

describe("t288 path containment — committed paths are untrusted", () => {
  test("validDocumentPath accepts only relative POSIX paths", () => {
    for (const ok of ["a.pdf", "documents/a.pdf", "a/b/c/d.pdf", "with space.pdf", "a-b_c.pdf"]) {
      expect(validDocumentPath(ok), ok).toBe(true);
    }
  });

  test("validDocumentPath refuses traversal, absolutes, backslashes, and NUL", () => {
    for (const bad of [
      "..",
      "../secret",
      "../../../../secret",
      "documents/../../../secret",
      "/etc/passwd",
      "C:\\Windows\\x",
      "\\\\server\\share",
      "a\\b",
      "a//b",
      "",
      "a/\0b",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(validDocumentPath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("a traversal source path is refused with a reason naming the leak", () => {
    const r = validateDocumentIndex(index([
      row({ source: { kind: "managed", path: "../../../../secret" } }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /source\.path/)).toMatch(/leaks|relative/);
  });

  test("an absolute source path is refused in BOTH kinds", () => {
    expect(validateDocumentIndex(index([
      row({ source: { kind: "managed", path: "/etc/passwd" } }),
    ])).ok).toBe(false);
    expect(validateDocumentIndex(index([
      row({ source: { kind: "linked", alias: "x", path: "/etc/passwd" } }),
    ])).ok).toBe(false);
  });

  test("content and summary paths are contained too, not just source", () => {
    expect(validateDocumentIndex(index([row({ content: "../../../etc/passwd" })])).ok).toBe(false);
    expect(validateDocumentIndex(index([
      row({ summary: { state: "generated", path: "../../x.md", source_revision: DIGEST } }),
    ])).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL BINDING of `content` and `summary.path` to the row's OWN id. The
// finding this closes: `validDocumentPath` (above) only forbids
// absolute/backslash/`..`/NUL, so it never asserts the path is anchored under
// THIS row's `documentkb/<id>/`. A hand-edited row A can carry
// `content: "documentkb/<B>/content.md"` -- a well-formed, IN-BOUNDS path that
// never leaves documentkb/ -- and pass validation while `show <A> --json`
// returns row A's citation next to row B's text. No escape check catches this,
// because the string never climbs out of documentkb/; the fix is binding the
// path to the id, not more path hardening.
//
// The escape variant (`content: "../../../../etc/hosts"`) is ALREADY refused
// by validDocumentPath's `..` check above -- this describes a DIFFERENT gap,
// not a stronger version of the same one.
// ─────────────────────────────────────────────────────────────────────────────
describe("t288 content and summary.path are CANONICALLY BOUND to the row's own id", () => {
  test("content pointing at ANOTHER row's own well-formed path is refused", () => {
    const r = validateDocumentIndex(index([
      row({ content: `documentkb/${UUID2}/content.md`, content_sha256: CONTENT_DIGEST }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /content/)).toMatch(new RegExp(UUID));
  });

  test("content pointing at the row's OWN id is accepted", () => {
    expect(validateDocumentIndex(index([
      row({ content: `documentkb/${UUID}/content.md`, content_sha256: CONTENT_DIGEST }),
    ])).ok).toBe(true);
  });

  test("content requires its own digest, and the digest is absent without content", () => {
    expect(validateDocumentIndex(index([
      row({ content: `documentkb/${UUID}/content.md` }),
    ])).ok).toBe(false);
    expect(validateDocumentIndex(index([
      row({ content_sha256: CONTENT_DIGEST }),
    ])).ok).toBe(false);
  });

  test("summary.path pointing at another row's own well-formed path is refused", () => {
    const r = validateDocumentIndex(index([
      row({
        summary: {
          state: "generated",
          path: `documentkb/${UUID2}/summary.md`,
          source_revision: DIGEST,
        },
      }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /summary\.path/)).toMatch(new RegExp(UUID));
  });

  test("summary.path pointing at the row's OWN id is accepted", () => {
    expect(validateDocumentIndex(index([
      row({
        summary: {
          state: "generated",
          path: `documentkb/${UUID}/summary.md`,
          source_revision: DIGEST,
        },
      }),
    ])).ok).toBe(true);
  });

  test("RED-verify: the escape variant is refused by validDocumentPath already, not by this binding", () => {
    // Documents the correction to the reviewer's framing: this is a SEPARATE
    // gap from the traversal check, and the traversal check alone is not the
    // fix for the cross-row binding above.
    expect(validDocumentPath("../../../../etc/hosts")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A malformed `removed_at` must not read as a LIVE row. `isTombstoned()`
// treats anything other than a non-empty string as ACTIVE, so `{}` or `null`
// passing validation would let a hand-edited catalog present a removed
// document as indexed.
// ─────────────────────────────────────────────────────────────────────────────
describe("t288 a malformed removed_at is refused, not silently read as live", () => {
  test("removed_at: {} is refused", () => {
    const r = validateDocumentIndex(index([row({ removed_at: {} })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /removed_at/)).toBeTruthy();
  });

  test("removed_at: null is refused", () => {
    expect(validateDocumentIndex(index([row({ removed_at: null })])).ok).toBe(false);
  });

  test("removed_at: '' (empty string) is refused", () => {
    // isTombstoned() already treats "" as not-tombstoned; the schema must not
    // accept a value its own reader would silently reinterpret.
    expect(validateDocumentIndex(index([row({ removed_at: "" })])).ok).toBe(false);
  });

  test("removed_at: 12345 (a number) is refused", () => {
    expect(validateDocumentIndex(index([row({ removed_at: 12345 })])).ok).toBe(false);
  });

  // Finding 5(a): the OLD check was `typeof === "string" && length > 0` -- bare
  // non-emptiness, not the ISO-timestamp shape the error message itself
  // promises ("must be a non-empty ISO timestamp string"). Measured against
  // the shipped tool: `removed_at: "not-a-date"` PASSED validation outright.
  test("removed_at: 'not-a-date' is refused -- non-empty is not the same promise as ISO", () => {
    const r = validateDocumentIndex(index([row({ removed_at: "not-a-date" })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /removed_at/)).toBeTruthy();
  });

  test("removed_at: 'yesterday' is refused", () => {
    expect(validateDocumentIndex(index([row({ removed_at: "yesterday" })])).ok).toBe(false);
  });

  test("removed_at: a bare date with no time component is refused", () => {
    // Shape-plausible (a real calendar date) but not what this schema's own
    // writer ever emits -- `now` is always a full timestamp. Date.parse alone
    // would accept this; the regex half of the check is what refuses it.
    expect(validateDocumentIndex(index([row({ removed_at: "2026-08-07" })])).ok).toBe(false);
  });

  test("removed_at: a shape-valid but impossible calendar date is refused", () => {
    // Passes the regex's character-class shape, fails Date.parse -- proving
    // the check is genuinely TWO gates, neither redundant with the other.
    expect(
      validateDocumentIndex(index([row({ removed_at: "2026-13-45T00:00:00Z" })])).ok,
    ).toBe(false);
    expect(
      validateDocumentIndex(index([row({ removed_at: "2026-02-31T00:00:00Z" })])).ok,
    ).toBe(false);
  });

  test("a genuine ISO-string removed_at with a numeric offset is still accepted", () => {
    expect(validateDocumentIndex(index([
      row({
        removed_at: "2026-08-07T05:00:00+00:00",
        extraction: DESIGN_CONFORMANT_EXTRACTION.unsupported_type,
      }),
    ])).ok).toBe(true);
  });

  test("a genuine ISO-string removed_at is still accepted", () => {
    expect(validateDocumentIndex(index([
      row({
        removed_at: "2026-08-07T05:00:00Z",
        extraction: DESIGN_CONFORMANT_EXTRACTION.unsupported_type,
      }),
    ])).ok).toBe(true);
  });
});

describe("t288 source is DISCRIMINATED, not a bag of optionals", () => {
  test("an unknown kind is refused", () => {
    for (const kind of ["external", "", null, undefined, 42]) {
      expect(validateDocumentIndex(index([row({ source: { kind, path: "a.pdf" } })])).ok).toBe(false);
    }
  });

  test("a linked source REQUIRES an alias", () => {
    const r = validateDocumentIndex(index([
      row({ source: { kind: "linked", path: "security/policy.pdf" } }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /alias is required/)).not.toBe("");
  });

  test("a managed source REFUSES an alias — the discriminant must discriminate", () => {
    // Without this, a row is ambiguous about which resolution path applies:
    // under documents/ for managed, or through the alias map for linked.
    const r = validateDocumentIndex(index([
      row({ source: { kind: "managed", path: "a.pdf", alias: "corp" } }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /alias is not valid on a managed/)).not.toBe("");
  });

  test("a non-object source is refused", () => {
    for (const bad of ["documents/a.pdf", null, [], 42]) {
      expect(validateDocumentIndex(index([row({ source: bad })])).ok).toBe(false);
    }
  });
});

describe("t288 derivatives are REVISION-BOUND", () => {
  test("an extracted state REQUIRES source_revision", () => {
    const r = validateDocumentIndex(index([row({ extraction: { state: "extracted" } })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /source_revision is required/)).not.toBe("");
  });

  test("a stale derivative reports as invalidated and is NOT current", () => {
    // The regression: an edited original serving stale extracted text under a
    // fresh digest. `invalidated` must be DERIVED, not merely settable.
    const stale = row({ extraction: { state: "extracted", source_revision: OTHER_DIGEST } });
    expect(derivativeIsCurrent(stale as never)).toBe(false);
    expect(effectiveExtractionState(stale as never)).toBe("invalidated");
  });

  test("a fresh derivative is current and reports its stored state", () => {
    expect(derivativeIsCurrent(row() as never)).toBe(true);
    expect(effectiveExtractionState(row() as never)).toBe("extracted");
  });

  test("a non-extracted state is never 'current' but keeps its own remedy", () => {
    // extractor_unavailable must NOT be reported as invalidated: the remedies
    // differ (install the extractor vs re-sync), which is why the union exists.
    const unavailable = row({ extraction: { state: "extractor_unavailable" } });
    expect(derivativeIsCurrent(unavailable as never)).toBe(false);
    expect(effectiveExtractionState(unavailable as never)).toBe("extractor_unavailable");
  });

  test("a summary derivative is revision-bound too", () => {
    const ownId = "019fda80-0000-7000-8000-000000000001";
    expect(validateDocumentIndex(index([
      row({ id: ownId, summary: { state: "generated", path: `documentkb/${ownId}/summary.md` } }),
    ])).ok).toBe(false);
    expect(validateDocumentIndex(index([
      row({ id: ownId, summary: { state: "generated", path: `documentkb/${ownId}/summary.md`, source_revision: DIGEST } }),
    ])).ok).toBe(true);
  });

  test("summary is a STATE, not a path", () => {
    for (const bad of ["documentkb/x/summary.md", null, [], { state: "present" }]) {
      expect(validateDocumentIndex(index([row({ summary: bad })])).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("extraction_failed REQUIRES a reason so each bound trip is distinguishable", () => {
    // Drop `reason` from the design-conformant record and nothing else.
    const { reason, ...noReason } = DESIGN_CONFORMANT_EXTRACTION.extraction_failed;
    expect(reason).toBeDefined();
    const r = validateDocumentIndex(index([row({ extraction: noReason })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /reason is required/)).not.toBe("");
    expect(validateDocumentIndex(index([
      row({ extraction: DESIGN_CONFORMANT_EXTRACTION.extraction_failed }),
    ])).ok).toBe(true);
  });
});

describe("t288 each state's REQUIRED companions are enforced, per the design table", () => {
  // Built by deleting ONE required field from each design-conformant record, so
  // the assertion is "this field is required for this state" rather than "some
  // malformed thing was refused". An earlier version of this suite built its
  // fixtures from the implementation and therefore could not see that
  // `extracted` accepted a record carrying nothing but source_revision.
  const requiredFields: Record<string, string[]> = {
    extracted: ["extractor", "chars", "truncated", "source_revision"],
    no_extractable_text: ["extractor", "source_revision"],
    extractor_unavailable: ["extractor"],
    extraction_failed: ["extractor", "reason"],
    unsupported_type: ["detectedType"],
    invalidated: ["source_revision"],
  };

  for (const [state, fields] of Object.entries(requiredFields)) {
    for (const field of fields) {
      test(`${state} without ${field} is refused`, () => {
        const stripped = { ...DESIGN_CONFORMANT_EXTRACTION[state] };
        expect(stripped[field], `fixture must carry ${field}`).toBeDefined();
        delete stripped[field];
        const r = validateDocumentIndex(index([row({ extraction: stripped })]));
        expect(r.ok, `${state} without ${field} should be refused`).toBe(false);
        if (!r.ok) {
          // The error must name the missing field, not merely be *an* error.
          expect(errorMatching(r.errors, new RegExp(field))).not.toBe("");
        }
      });
    }
  }

  test("extracted requires an extractor VERSION, not just a name", () => {
    // The extractor ran, so a version exists and a version change is grounds
    // for re-extraction. A name-only record here would be lossy.
    const r = validateDocumentIndex(index([
      row({
        extraction: {
          ...DESIGN_CONFORMANT_EXTRACTION.extracted,
          extractor: { name: "pdftotext" },
        },
      }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /version is required/)).not.toBe("");
  });

  test("extractor_unavailable REFUSES a version — nothing ran, so there is none", () => {
    // Not pedantry: the state means no extractor was FOUND, so a version would
    // be a fabricated fact about a program that never executed.
    const r = validateDocumentIndex(index([
      row({
        extraction: {
          state: "extractor_unavailable",
          extractor: { name: "pdftotext", version: "24.02.0" },
        },
      }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /must be absent/)).not.toBe("");
  });

  test("extractor_unavailable ACCEPTS name-only (plus detectedType) — the design's own shape", () => {
    // This is the over-rejection review caught: the validator required
    // name+version for every state that carried an extractor at all, which
    // refused the exact record this state exists to express.
    expect(validateDocumentIndex(index([
      row({
        extraction: {
          state: "extractor_unavailable",
          extractor: { name: "pdftotext" },
          detectedType: "application/pdf",
        },
      }),
    ])).ok).toBe(true);
  });

  test("extractor_unavailable REQUIRES detectedType (finding 5(c))", () => {
    // Without it, a retry has no mime to re-probe against once an extractor
    // for the row's type exists -- the exact defect this pin closes.
    const r = validateDocumentIndex(index([
      row({ extraction: { state: "extractor_unavailable", extractor: { name: "pdftotext" } } }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /detectedType/)).toBeTruthy();
  });

  test("chars must be a non-negative integer when extracted", () => {
    for (const bad of [-1, 1.5, "100", null]) {
      expect(validateDocumentIndex(index([
        row({ extraction: { ...DESIGN_CONFORMANT_EXTRACTION.extracted, chars: bad } }),
      ])).ok, String(bad)).toBe(false);
    }
    expect(validateDocumentIndex(index([
      row({ extraction: { ...DESIGN_CONFORMANT_EXTRACTION.extracted, chars: 0 } }),
    ])).ok).toBe(true);
  });

  test("truncated must be a real boolean, not a truthy stand-in", () => {
    // A reader cannot distinguish a complete extraction from a capped one
    // without it, and "false"/0 would silently read as complete.
    for (const bad of ["false", 0, 1, null]) {
      expect(validateDocumentIndex(index([
        row({ extraction: { ...DESIGN_CONFORMANT_EXTRACTION.extracted, truncated: bad } }),
      ])).ok, String(bad)).toBe(false);
    }
  });
});

describe("t288 duplicate ids are rejected on READ", () => {
  test("two rows with the same id are refused, naming the id", () => {
    const r = validateDocumentIndex(index([row(), row()]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = errorMatching(r.errors, /duplicate document id/);
      expect(err).toContain(UUID);
      expect(err).toMatch(/unreachable/);
    }
  });

  test("distinct ids are fine", () => {
    expect(validateDocumentIndex(index([row(), row({ id: UUID2 })])).ok).toBe(true);
  });

  test("three copies report the id once, not twice", () => {
    const r = validateDocumentIndex(index([row(), row(), row()]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.filter((e) => /duplicate document id/.test(e)).length).toBe(1);
  });
});

describe("t288 identity is a UUID; a slug is only ever INPUT", () => {
  test("a non-UUID row id is refused", () => {
    for (const bad of ["policy-pdf", "abc", "", null, 42, UUID.slice(0, -1)]) {
      expect(validateDocumentIndex(index([row({ id: bad })])).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("an EMPTY related_intent_ids is INVALID, not 'space-wide'", () => {
    const r = validateDocumentIndex(index([row({ related_intent_ids: [] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The message must say what space-wide actually looks like, or the user
      // "fixes" it by adding a placeholder id.
      expect(errorMatching(r.errors, /related_intent_ids/)).toMatch(/OMITTED/);
    }
  });

  test("a SLUG in related_intent_ids is refused — a slug can be renamed", () => {
    const r = validateDocumentIndex(index([row({ related_intent_ids: ["auth-service"] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /must be a canonical UUID, not a slug/)).not.toBe("");
  });

  test("a non-array related_intent_ids is refused", () => {
    for (const bad of ["auth", 42, {}]) {
      expect(validateDocumentIndex(index([row({ related_intent_ids: bad })])).ok).toBe(false);
    }
  });
});

describe("t288 digest and scalar shapes", () => {
  test("sha256 must be a lowercase 64-hex digest", () => {
    for (const bad of [DIGEST.toUpperCase(), "abc", DIGEST.slice(0, 63), `${DIGEST}a`, "", null, 42]) {
      expect(validateDocumentIndex(index([row({ sha256: bad })])).ok, String(bad).slice(0, 12))
        .toBe(false);
    }
  });

  test("bytes must be a non-negative integer", () => {
    for (const bad of [-1, 1.5, "10", null, NaN]) {
      expect(validateDocumentIndex(index([row({ bytes: bad })])).ok, String(bad)).toBe(false);
    }
    expect(validateDocumentIndex(index([row({ bytes: 0 })])).ok).toBe(true);
  });

  test("indexed_at must be a valid ISO timestamp", () => {
    for (const bad of ["", "not-a-date", "2026-02-31T00:00:00Z", null, 42, {}]) {
      expect(validateDocumentIndex(index([row({ indexed_at: bad })])).ok).toBe(false);
    }
  });

  test("a state whose extractor RAN must carry both name and version", () => {
    // Extracted text is only interpretable if you know what produced it, and a
    // version change is grounds for re-extraction. Note this is per-state:
    // extractor_unavailable is the deliberate exception, covered separately.
    for (const bad of [{ name: "pdftotext" }, { version: "24.02.0" }, "pdftotext", {}, null]) {
      expect(validateDocumentIndex(index([
        row({ extraction: { ...DESIGN_CONFORMANT_EXTRACTION.extracted, extractor: bad } }),
      ])).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateDocumentIndex(index([
      row({ extraction: DESIGN_CONFORMANT_EXTRACTION.extracted }),
    ])).ok).toBe(true);
  });
});

describe("t288 metadata.json carries the untrusted framing at WRITE time", () => {
  test("a valid metadata record round-trips", () => {
    const r = validateDocumentMetadata(metadata());
    expect(r.ok, r.ok ? "" : r.errors.join("; ")).toBe(true);
  });

  test("content_trust must be exactly 'untrusted'", () => {
    for (const bad of ["trusted", "", undefined, null, true]) {
      const r = validateDocumentMetadata(metadata({ content_trust: bad }));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("content_handling must be exactly 'data-not-instructions'", () => {
    for (const bad of ["instructions", "", undefined, null]) {
      expect(validateDocumentMetadata(metadata({ content_handling: bad })).ok).toBe(false);
    }
  });

  test("the framing is REQUIRED, so it cannot be deferred to a reader", () => {
    // Whoever reads content.md later inherits whatever S1 recorded; there is no
    // second writer, so an absent framing is a permanent gap, not a default.
    const bare = metadata();
    delete bare.content_trust;
    delete bare.content_handling;
    expect(validateDocumentMetadata(bare).ok).toBe(false);
  });

  test("metadata inherits every row rule, so the rebuild input is validated too", () => {
    // metadata.json is the REBUILD source: a rebuild that trusts its input is an
    // arbitrary-file-read with extra steps.
    expect(validateDocumentMetadata(metadata({
      source: { kind: "managed", path: "../../../../secret" },
    })).ok).toBe(false);
    expect(validateDocumentMetadata(metadata({ id: "not-a-uuid" })).ok).toBe(false);
    expect(validateDocumentMetadata(metadata({ sha256: "abc" })).ok).toBe(false);
  });
});

describe("t288 tombstones", () => {
  test("a tombstoned row is detected by removed_at", () => {
    expect(isTombstoned(row() as never)).toBe(false);
    expect(isTombstoned(row({ removed_at: "2026-08-07T05:00:00Z" }) as never)).toBe(true);
    expect(isTombstoned(row({ removed_at: "" }) as never)).toBe(false);
  });

  test("a tombstone is still a VALID row — it must survive to carry its citation", () => {
    // A rule promoted in S3 cites this id; the citation must not dangle just
    // because the original is gone.
    expect(validateDocumentIndex(index([
      row({
        removed_at: "2026-08-07T05:00:00Z",
        extraction: DESIGN_CONFORMANT_EXTRACTION.unsupported_type,
      }),
    ])).ok).toBe(true);
  });
});

describe("t288 the reporting contract", () => {
  test("EVERY error is reported, not just the first", () => {
    // A hand-edited file should report all its problems in one run, or the user
    // fixes them one round-trip at a time.
    const r = validateDocumentIndex(index([
      row({ id: "nope", sha256: "abc", bytes: -1 }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  test("errors name the offending row INDEX so a large index is navigable", () => {
    const r = validateDocumentIndex(index([row(), row({ id: "nope" })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /documents\[1\]/)).not.toBe("");
  });

  test("a non-object index, and a non-array documents, are refused", () => {
    for (const bad of [null, [], "x", 42]) {
      expect(validateDocumentIndex(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateDocumentIndex({ schema_version: 1, documents: {} }).ok).toBe(false);
    expect(validateDocumentIndex({ schema_version: 1 }).ok).toBe(false);
  });

  test("no validator MUTATES its input — refusing must not rewrite", () => {
    // "assert non-zero AND no rewrite" is the invariant; a validator that
    // normalised in place would make the caller's no-rewrite promise unkeepable.
    const input = index([row({ related_intent_ids: [] })]);
    const before = JSON.stringify(input);
    validateDocumentIndex(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
