// covers: function:validateDocumentIndex function:validateDocumentMetadata
//
// t325 - DocumentKB S3a: the `tags` field and a pinning check of the existing
// `summary` state-transition validation in aidlc-documentkb-schema.ts.
//
// NOTE ON NUMBERING: rebasing onto v2 found t300-t324 already allocated, so
// t325 is the next free unit number.
//
// Mechanism: none. Pure data-in/data-out validators, zero I/O/spawn/LLM. A
// direct import satisfies the "none" minMechanism.
//
// Subject under test: dist/claude/.claude/tools/aidlc-documentkb-schema.ts
// (the SHIPPED distributable), per the t288 precedent — a guard reverted only
// in core/ still passes when the test imports dist, which would fake the
// "the test observes the defect" conclusion.
//
// The contract:
//
//   `tags` is OMITTED for an untagged document. Present means tagged. An
//   EMPTY ARRAY IS INVALID — the same reasoning t288 already pins for
//   `related_intent_ids`: ambiguous between "not yet tagged" and "tagged with
//   nothing". Each tag is a non-empty string, capped at MAX_TAG_LENGTH chars;
//   the array itself is capped at MAX_TAGS_PER_DOCUMENT entries.
//
//   `summary` is a two-state union (`absent` | `generated`) that was ALREADY
//   shipped complete as of S1: `generated` already requires its path bound to
//   documentkb/<id>/summary.md and a sha256 `source_revision`. This suite
//   pins that existing behaviour (§8.13: don't just read the validator, drive
//   it) rather than re-deriving new gaps — measured, not assumed.

import { describe, expect, test } from "bun:test";
import {
  DOCUMENTKB_SCHEMA_VERSION,
  effectiveSummaryState,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_DOCUMENT,
  summaryIsCurrent,
  validateDocumentIndex,
  validateDocumentMetadata,
} from "../../dist/claude/.claude/tools/aidlc-documentkb-schema.ts";

const DIGEST = "a".repeat(64);
const UUID = "019fda80-8f8d-7bfa-b56c-983cf0353faa";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID,
    source: { kind: "managed", path: "documents/security/policy.pdf" },
    sha256: DIGEST,
    bytes: 48213,
    indexed_at: "2026-08-07T04:15:37Z",
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

function index(rows: Record<string, unknown>[]) {
  return { schema_version: DOCUMENTKB_SCHEMA_VERSION, documents: rows };
}

function errorMatching(errors: string[], needle: RegExp): string {
  return errors.find((e) => needle.test(e)) ?? "";
}

describe("t325 tags — omitted or a bounded array of non-empty strings", () => {
  test("a row with no tags key at all is valid (the pre-S3 shape)", () => {
    const r = validateDocumentIndex(index([row()]));
    expect(r.ok).toBe(true);
    if (r.ok) expect("tags" in r.value.documents[0]).toBe(false);
  });

  test("a row with a non-empty tags array is accepted", () => {
    expect(validateDocumentIndex(index([row({ tags: ["security", "policy"] })])).ok).toBe(true);
  });

  test("an EMPTY tags array is INVALID, not 'untagged' — same reasoning as related_intent_ids", () => {
    const r = validateDocumentIndex(index([row({ tags: [] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /\.tags /)).toMatch(/OMITTED/);
  });

  test("a non-array tags value is refused", () => {
    for (const bad of ["security", 42, {}]) {
      expect(validateDocumentIndex(index([row({ tags: bad })])).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("a non-string or empty-string element is refused", () => {
    for (const bad of [42, null, "", {}, []]) {
      expect(validateDocumentIndex(index([row({ tags: [bad] })])).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("a tag over MAX_TAG_LENGTH chars is refused; exactly at the cap is accepted", () => {
    const tooLong = "x".repeat(MAX_TAG_LENGTH + 1);
    const atCap = "x".repeat(MAX_TAG_LENGTH);
    const r = validateDocumentIndex(index([row({ tags: [tooLong] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /tags\[0\]/)).toMatch(/char cap/);
    expect(validateDocumentIndex(index([row({ tags: [atCap] })])).ok).toBe(true);
  });

  test("more than MAX_TAGS_PER_DOCUMENT entries is refused; exactly at the cap is accepted", () => {
    const overCap = Array.from({ length: MAX_TAGS_PER_DOCUMENT + 1 }, (_, i) => `t${i}`);
    const atCap = Array.from({ length: MAX_TAGS_PER_DOCUMENT }, (_, i) => `t${i}`);
    const r = validateDocumentIndex(index([row({ tags: overCap })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /tags has/)).toMatch(/tag cap/);
    expect(validateDocumentIndex(index([row({ tags: atCap })])).ok).toBe(true);
  });

  test("metadata.json inherits the same tags rule as the index row", () => {
    const meta = {
      schema_version: DOCUMENTKB_SCHEMA_VERSION,
      ...row({ tags: [] }),
      content_trust: "untrusted",
      content_handling: "data-not-instructions",
    };
    expect(validateDocumentMetadata(meta).ok).toBe(false);
  });

  test("validation does not mutate the input tags array", () => {
    const input = index([row({ tags: ["a", "b"] })]);
    const before = JSON.stringify(input);
    validateDocumentIndex(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("t325 tags hardening (S3a follow-up) — trim, dedupe, control chars", () => {
  test("a whitespace-only tag ('   ') is refused, not accepted as a label", () => {
    const r = validateDocumentIndex(index([row({ tags: ["   "] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /tags\[0\]/)).toMatch(/whitespace/);
  });

  test("a tab-only tag ('\\t') is refused", () => {
    const r = validateDocumentIndex(index([row({ tags: ["\t"] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /tags\[0\]/)).not.toBe("");
  });

  test("a tag with leading/trailing whitespace is refused, not silently trimmed", () => {
    const r = validateDocumentIndex(index([row({ tags: [" security"] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /tags\[0\]/)).toMatch(/whitespace/);
  });

  test("a tag with an INTERNAL space is still valid (two-word labels are legitimate)", () => {
    expect(validateDocumentIndex(index([row({ tags: ["release branches"] })])).ok).toBe(true);
  });

  test("exact duplicate tags ('a','a') are refused", () => {
    const r = validateDocumentIndex(index([row({ tags: ["a", "a"] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /tags\[1\]/)).toMatch(/duplicates/);
  });

  test("case-variant duplicates ('A','a') are refused", () => {
    const r = validateDocumentIndex(index([row({ tags: ["A", "a"] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /tags\[1\]/)).toMatch(/duplicates/);
  });

  test("NFC vs NFD lookalike 'é' duplicates are refused", () => {
    const nfc = "é"; // é, precomposed
    const nfd = "é"; // e + combining acute accent
    expect(nfc.normalize("NFC")).not.toBe(nfd); // confirm they differ as raw strings
    const r = validateDocumentIndex(index([row({ tags: [nfc, nfd] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /tags\[1\]/)).toMatch(/duplicates/);
  });

  test("distinct-case tags on DIFFERENT documents both validate (case-fold is per-row dedupe only)", () => {
    const r = validateDocumentIndex(index([
      row({ id: UUID, tags: ["AWS"] }),
      row({
        id: "019fda80-8f8d-7bfa-b56c-983cf0353fac",
        source: { kind: "managed", path: "documents/security/other.pdf" },
        tags: ["aws"],
      }),
    ]));
    expect(r.ok).toBe(true);
  });

  test("mixed-case tag 'AWS' alone (no collision) still validates", () => {
    expect(validateDocumentIndex(index([row({ tags: ["AWS", "release branches"] })])).ok).toBe(true);
  });

  test("['a','b'] — plain distinct tags — still validates", () => {
    expect(validateDocumentIndex(index([row({ tags: ["a", "b"] })])).ok).toBe(true);
  });

  test("an embedded newline in a tag ('a\\nb') is refused", () => {
    const r = validateDocumentIndex(index([row({ tags: ["a\nb"] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /tags\[0\]/)).toMatch(/control charact/);
  });

  test("a NUL byte in a tag ('a\\0b') is refused", () => {
    const r = validateDocumentIndex(index([row({ tags: ["a\0b"] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /tags\[0\]/)).toMatch(/control charact/);
  });

  test("a path-like tag ('../../etc/passwd') is ACCEPTED — a tag is a label, not a path", () => {
    expect(validateDocumentIndex(index([row({ tags: ["../../etc/passwd"] })])).ok).toBe(true);
  });
});

describe("t325 summary state transition — pinning what S1 already shipped complete", () => {
  test("{state:'absent'} round-trips (the S1 shape)", () => {
    expect(validateDocumentIndex(index([row({ summary: { state: "absent" } })])).ok).toBe(true);
  });

  test("{state:'generated', path, source_revision} bound to the row's own id is accepted", () => {
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

  test("generated summary path pointing at ANOTHER row's id is refused (cross-row binding)", () => {
    const otherId = "019fda80-8f8d-7bfa-b56c-983cf0353fab";
    const r = validateDocumentIndex(index([
      row({
        summary: {
          state: "generated",
          path: `documentkb/${otherId}/summary.md`,
          source_revision: DIGEST,
        },
      }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /summary\.path/)).toMatch(new RegExp(UUID));
  });

  test("generated summary missing source_revision is refused", () => {
    const r = validateDocumentIndex(index([
      row({ summary: { state: "generated", path: `documentkb/${UUID}/summary.md` } }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(errorMatching(r.errors, /summary\.source_revision/)).not.toBe("");
  });

  test("generated summary with a malformed (non-sha256) source_revision is refused", () => {
    for (const bad of ["not-a-digest", DIGEST.toUpperCase(), DIGEST.slice(0, 63), 42, null]) {
      const r = validateDocumentIndex(index([
        row({
          summary: {
            state: "generated",
            path: `documentkb/${UUID}/summary.md`,
            source_revision: bad,
          },
        }),
      ]));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("a third state string is refused — the union is exactly two states", () => {
    for (const bad of ["present", "pending", "invalidated", "", null, 42]) {
      expect(
        validateDocumentIndex(index([row({ summary: { state: bad } })])).ok,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  test("a bare path string for summary (not an object/state) is refused", () => {
    expect(validateDocumentIndex(index([row({ summary: "documentkb/x/summary.md" })])).ok).toBe(false);
  });

  test("summary_sha256 is accepted only for a generated summary and must be lowercase sha256", () => {
    const generated = {
      state: "generated",
      path: `documentkb/${UUID}/summary.md`,
      source_revision: DIGEST,
    };
    expect(validateDocumentIndex(index([row({
      summary: generated,
      summary_sha256: "b".repeat(64),
    })])).ok).toBe(true);

    for (const candidate of [
      row({ summary_sha256: "b".repeat(64) }),
      row({ summary: generated, summary_sha256: "B".repeat(64) }),
      row({ summary: generated, summary_sha256: "short" }),
    ]) {
      expect(validateDocumentIndex(index([candidate])).ok).toBe(false);
    }
  });

  test("summary helpers derive current, invalidated, and tombstoned states directly", () => {
    const generated = row({
      summary: {
        state: "generated",
        path: `documentkb/${UUID}/summary.md`,
        source_revision: DIGEST,
      },
    }) as unknown as Parameters<typeof summaryIsCurrent>[0];
    expect(summaryIsCurrent(generated)).toBe(true);
    expect(effectiveSummaryState(generated)).toBe("generated");

    generated.sha256 = "b".repeat(64);
    expect(summaryIsCurrent(generated)).toBe(false);
    expect(effectiveSummaryState(generated)).toBe("invalidated");

    generated.removed_at = "2026-08-25T12:00:00Z";
    expect(summaryIsCurrent(generated)).toBe(false);
    expect(effectiveSummaryState(generated)).toBe("absent");
  });
});
