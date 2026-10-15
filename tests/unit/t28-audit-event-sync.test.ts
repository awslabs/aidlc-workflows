// covers: file:tools/aidlc-audit.ts, file:knowledge/aidlc-shared/audit-format.md
//
// t28 - audit event-type SYNC contract. The canonical event-type taxonomy is
// in lock-step across two shipped source files, the heading map is exhaustive,
// and the count is pinned to a baseline: a cross-file structural drift guard
// with zero process boundary and zero LLM.
//
// Mechanism: none. This is a pure structural / source-inspection check over
// the shipped bytes: read the two files in-process, extract their event-type
// sets, and assert the set relationships. There is no argv / exit-code /
// stdout / audit seam to cross, and `VALID_EVENT_TYPES` / `EVENT_HEADINGS`
// are module-private (NOT exported from aidlc-audit.ts), so the contract is
// precisely the textual cross-file sync, checked by parsing the same byte
// ranges in-process. No spawn, no tokens.
//
// Subject under test (the shipped distributable):
//   - dist/claude/.claude/tools/aidlc-audit.ts
//       const VALID_EVENT_TYPES = new Set([ "STAGE_STARTED", ... ]);
//       const EVENT_HEADINGS: Record<string,string> = { TYPE: "...", };
//   - dist/claude/.claude/knowledge/aidlc-shared/audit-format.md
//       "## Event Registry" .. "## Hook-Generated"
//       — backtick-delimited `EVENT_TYPE` cells in the registry tables.
//
// Extraction:
//   - TS_EVENTS: the lines from `new Set([` through `]);`, all
//       "[A-Z_]+" double-quoted tokens, deduped + sorted.
//   - MD_EVENTS: the lines from `## Event Registry` through
//       `## Hook-Generated`, all `[A-Z_]+` backtick-delimited tokens, deduped
//       + sorted. (The check-mark MANDATORY marker is not [A-Z_], so it never
//       leaks into a token.)
//
// Test-design note (house style): assert the OBSERVABLE cross-file contract
// against the real bytes on disk - never re-declare the taxonomy here. The
// expected sets are DERIVED from the files, not hard-coded; only the canonical
// COUNT is pinned as a literal.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude (the shipped tree under test).
const AUDIT_TS = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const AUDIT_MD = join(AIDLC_SRC, "knowledge", "aidlc-shared", "audit-format.md");

// The canonical baseline. Bump WITH the source when an event is added or
// removed. The retired CHANGE_CONTROL_SET stays in the set as a read-only
// legacy row; REVIEW_VERDICT_DICTATED is registered but never written, so
// audits and worktree deltas that carry it still read and merge.
const CANONICAL_COUNT = 119;

/** Slice the lines of `text` BETWEEN the first line matching `start` and the
 *  next line matching `end` (inclusive of both), reproducing `sed -n
 *  '/start/,/end/p'`. */
function sedRange(text: string, start: RegExp, end: RegExp): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inRange = false;
  for (const line of lines) {
    if (!inRange) {
      if (start.test(line)) {
        inRange = true;
        out.push(line);
      }
      continue;
    }
    out.push(line);
    if (end.test(line)) break;
  }
  return out.join("\n");
}

function extractSorted(block: string, pattern: RegExp, strip: string): string[] {
  const matches = block.match(pattern) ?? [];
  const stripRe = new RegExp(`[${strip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]`, "g");
  return [...new Set(matches.map((m) => m.replace(stripRe, "")))].sort();
}

// --- TS_EVENTS: VALID_EVENT_TYPES set members. ---
const auditTsBody = readFileSync(AUDIT_TS, "utf-8");
const TS_BLOCK = sedRange(auditTsBody, /new Set\(\[/, /\]\);/);
const TS_EVENTS = extractSorted(TS_BLOCK, /"[A-Z_]+"/g, '"');

// --- MD_EVENTS: backtick event tokens in the Event Registry. ---
const auditMdBody = readFileSync(AUDIT_MD, "utf-8");
const MD_BLOCK = sedRange(auditMdBody, /## Event Registry/, /## Hook-Generated/);
const MD_EVENTS = extractSorted(MD_BLOCK, /`[A-Z_]+`/g, "`");

// --- EVENT_HEADINGS block: the heading map keys. ---
const HEADINGS_BLOCK = sedRange(auditTsBody, /EVENT_HEADINGS/, /^};/);
const HEADINGS_KEYS = new Set(
  [...HEADINGS_BLOCK.matchAll(/^\s+([A-Z_]+):/gm)].map((m) => m[1]),
);

describe("t28 audit event-type sync (migrated from t28-audit-event-sync.sh, plan 7)", () => {
  test("extracts a non-empty event set from aidlc-audit.ts [.sh test 1]", () => {
    expect(TS_EVENTS.length).toBeGreaterThan(0);
  });

  test("extracts a non-empty event set from audit-format.md [.sh test 2]", () => {
    expect(MD_EVENTS.length).toBeGreaterThan(0);
  });

  test("every aidlc-audit.ts event appears in audit-format.md [.sh test 3]", () => {
    const mdSet = new Set(MD_EVENTS);
    const missingFromMd = TS_EVENTS.filter((e) => !mdSet.has(e));
    expect(
      missingFromMd,
      `aidlc-audit.ts events missing from audit-format.md: ${missingFromMd.join(", ")}`,
    ).toEqual([]);
  });

  test("every audit-format.md event appears in aidlc-audit.ts [.sh test 4]", () => {
    const tsSet = new Set(TS_EVENTS);
    const missingFromTs = MD_EVENTS.filter((e) => !tsSet.has(e));
    expect(
      missingFromTs,
      `audit-format.md events missing from aidlc-audit.ts: ${missingFromTs.join(", ")}`,
    ).toEqual([]);
  });

  test("EVENT_HEADINGS maps every VALID_EVENT_TYPES member [.sh test 5]", () => {
    const missingHeadings = TS_EVENTS.filter((e) => !HEADINGS_KEYS.has(e));
    expect(
      missingHeadings,
      `VALID_EVENT_TYPES members with no EVENT_HEADINGS entry: ${missingHeadings.join(", ")}`,
    ).toEqual([]);
  });

  test("event counts match across the two files [.sh test 6]", () => {
    expect(MD_EVENTS.length).toBe(TS_EVENTS.length);
    expect(MD_EVENTS).toEqual(TS_EVENTS);
  });

  // The name interpolates CANONICAL_COUNT rather than hardcoding it: a literal
  // here drifts silently, since no drift guard reads test-name strings.
  test(`VALID_EVENT_TYPES.size === ${CANONICAL_COUNT} (baseline pin) [.sh test 7]`, () => {
    expect(TS_EVENTS.length).toBe(CANONICAL_COUNT);
  });
});
