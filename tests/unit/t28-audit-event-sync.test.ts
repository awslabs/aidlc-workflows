// covers: file:tools/aidlc-audit.ts, file:knowledge/aidlc-shared/audit-format.md
//
// t28 — audit event-type SYNC contract. Migrated from
// tests/unit/t28-audit-event-sync.sh (TAP plan 7). The .sh validated that the
// canonical event-type taxonomy is in lock-step across two shipped source
// files, plus that the heading map is exhaustive and the count is pinned to a
// baseline. Pure-bash, "no bun or claude required (L1)" — a cross-file
// structural drift guard with zero process boundary and zero LLM.
//
// Mechanism: none. This is a pure structural / source-inspection check over
// the shipped bytes — read the two files in-process, extract their event-type
// sets with the SAME extraction rules the .sh's sed/grep used, and assert the
// set relationships. There is no argv / exit-code / stdout / audit.md seam to
// cross (the .sh never ran a tool), and `VALID_EVENT_TYPES` / `EVENT_HEADINGS`
// are module-private (NOT exported from aidlc-audit.ts), so the contract is
// precisely the textual cross-file sync the .sh asserted — preserved by
// parsing the same byte ranges in-process. No spawn, no tokens.
//
// Subject under test (the shipped distributable):
//   - dist/claude/.claude/tools/aidlc-audit.ts
//       :19-113  const VALID_EVENT_TYPES = new Set([ "STAGE_STARTED", ... ]);
//       :117-185 const EVENT_HEADINGS: Record<string,string> = { TYPE: "...", };
//   - dist/claude/.claude/knowledge/aidlc-shared/audit-format.md
//       "## Event Registry (69 events, 18 categories)" .. "## Hook-Generated"
//       — backtick-delimited `EVENT_TYPE` cells in the registry tables.
//
// Extraction parity with the .sh (so the sets are byte-identical to what the
// .sh compared):
//   - TS_EVENTS  (.sh L16): the lines from `new Set([` through `]);`, all
//       "[A-Z_]+" double-quoted tokens, deduped + sorted.
//   - MD_EVENTS  (.sh L24): the lines from `## Event Registry` through
//       `## Hook-Generated`, all `[A-Z_]+` backtick-delimited tokens, deduped
//       + sorted. (The ✓ MANDATORY marker is not [A-Z_], so it never leaks
//       into a token — same as the .sh.)
//
// Test-design note (house style): assert the OBSERVABLE cross-file contract
// the .sh asserted against the real bytes on disk — never re-declare the
// taxonomy here. The expected sets are DERIVED from the files, not hard-coded;
// only the canonical COUNT (69) is pinned as a literal, exactly as the .sh's
// test 7 baseline did.
//
// Old TAP -> new test parity (1:1, no guarantee dropped):
//   .sh test 1 (assert_gt TS_COUNT 0)                 -> "extracts a non-empty event set from aidlc-audit.ts"
//   .sh test 2 (assert_gt MD_COUNT 0)                 -> "extracts a non-empty event set from audit-format.md"
//   .sh test 3 (every TS event in MD)                 -> "every aidlc-audit.ts event appears in audit-format.md"
//   .sh test 4 (every MD event in TS)                 -> "every audit-format.md event appears in aidlc-audit.ts"
//   .sh test 5 (EVENT_HEADINGS has every TS event)    -> "EVENT_HEADINGS maps every VALID_EVENT_TYPES member"
//   .sh test 6 (assert_eq TS_COUNT MD_COUNT)          -> "event counts match across the two files"
//   .sh test 7 (assert_eq TS_COUNT - baseline pin)    -> "VALID_EVENT_TYPES.size === 71 (baseline pin)"

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the same root the .sh resolved
// AUDIT_TS and AUDIT_MD under ($AIDLC_SRC/tools, $AIDLC_SRC/knowledge/...).
const AUDIT_TS = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const AUDIT_MD = join(AIDLC_SRC, "knowledge", "aidlc-shared", "audit-format.md");

// The canonical baseline pinned by .sh test 7. Bump WITH the source when an
// event is added (v0.6.0 Wave 4 milestone 16: +SWARM_DEGRADED took this to 67;
// v2.1.3: +WORKFLOW_PARKED +WORKFLOW_UNPARKED took it to 69; v2.1.4:
// -TEST_RUN_MODE_ENABLED took it to 68; +HUMAN_TURN took it to 69;
// +RECOMPOSED (adaptive composer) takes it to 70; +REVIEWER_SCOPE_BLOCKED
// (the reviewer-scope PreToolUse hook) takes it to 71).
const CANONICAL_COUNT = 71;

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
    if (end.test(line)) break; // sed stops at the FIRST end after entering.
  }
  return out.join("\n");
}

/** Deduped + sorted list of `pattern` matches in `block`, stripped of `strip`
 *  delimiters — the .sh's `grep -oE ... | tr -d ... | sort -u` pipeline. */
function extractSorted(block: string, pattern: RegExp, strip: string): string[] {
  const matches = block.match(pattern) ?? [];
  const stripRe = new RegExp(`[${strip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]`, "g");
  return [...new Set(matches.map((m) => m.replace(stripRe, "")))].sort();
}

// --- TS_EVENTS (.sh L16): VALID_EVENT_TYPES set members. ---
const auditTsBody = readFileSync(AUDIT_TS, "utf-8");
const TS_BLOCK = sedRange(auditTsBody, /new Set\(\[/, /\]\);/);
const TS_EVENTS = extractSorted(TS_BLOCK, /"[A-Z_]+"/g, '"');

// --- MD_EVENTS (.sh L24): backtick event tokens in the Event Registry. ---
const auditMdBody = readFileSync(AUDIT_MD, "utf-8");
const MD_BLOCK = sedRange(auditMdBody, /## Event Registry/, /## Hook-Generated/);
const MD_EVENTS = extractSorted(MD_BLOCK, /`[A-Z_]+`/g, "`");

// --- EVENT_HEADINGS block (.sh L57): the heading map keys. The .sh sliced
// `/EVENT_HEADINGS/,/};/` and substring-grepped each TS event against it. We
// parse the keys structurally for a STRONGER co-membership check. ---
const HEADINGS_BLOCK = sedRange(auditTsBody, /EVENT_HEADINGS/, /^};/);
const HEADINGS_KEYS = new Set(
  [...HEADINGS_BLOCK.matchAll(/^\s+([A-Z_]+):/gm)].map((m) => m[1]),
);

describe("t28 audit event-type sync (migrated from t28-audit-event-sync.sh, plan 7)", () => {
  // .sh test 1: assert_gt TS_COUNT 0.
  test("extracts a non-empty event set from aidlc-audit.ts [.sh test 1]", () => {
    expect(TS_EVENTS.length).toBeGreaterThan(0);
  });

  // .sh test 2: assert_gt MD_COUNT 0.
  test("extracts a non-empty event set from audit-format.md [.sh test 2]", () => {
    expect(MD_EVENTS.length).toBeGreaterThan(0);
  });

  // .sh test 3: every TS event found in MD. STRONGER than the .sh's
  // accumulate-missing loop: name the exact offenders if any leak through.
  test("every aidlc-audit.ts event appears in audit-format.md [.sh test 3]", () => {
    const mdSet = new Set(MD_EVENTS);
    const missingFromMd = TS_EVENTS.filter((e) => !mdSet.has(e));
    expect(
      missingFromMd,
      `aidlc-audit.ts events missing from audit-format.md: ${missingFromMd.join(", ")}`,
    ).toEqual([]);
  });

  // .sh test 4: every MD event found in TS.
  test("every audit-format.md event appears in aidlc-audit.ts [.sh test 4]", () => {
    const tsSet = new Set(TS_EVENTS);
    const missingFromTs = MD_EVENTS.filter((e) => !tsSet.has(e));
    expect(
      missingFromTs,
      `audit-format.md events missing from aidlc-audit.ts: ${missingFromTs.join(", ")}`,
    ).toEqual([]);
  });

  // .sh test 5: EVENT_HEADINGS has an entry for every VALID_EVENT_TYPES member.
  // STRONGER than the .sh's substring grep: assert exact-key membership against
  // the parsed heading-map keys, naming any unmapped event type.
  test("EVENT_HEADINGS maps every VALID_EVENT_TYPES member [.sh test 5]", () => {
    const missingHeadings = TS_EVENTS.filter((e) => !HEADINGS_KEYS.has(e));
    expect(
      missingHeadings,
      `VALID_EVENT_TYPES members with no EVENT_HEADINGS entry: ${missingHeadings.join(", ")}`,
    ).toEqual([]);
  });

  // .sh test 6: assert_eq TS_COUNT MD_COUNT. STRONGER: the two SETS are equal,
  // not merely the same cardinality (set-equality implies count-equality and
  // subsumes tests 3+4, but we keep the count assertion explicit for parity).
  test("event counts match across the two files [.sh test 6]", () => {
    expect(MD_EVENTS.length).toBe(TS_EVENTS.length);
    expect(MD_EVENTS).toEqual(TS_EVENTS); // both deduped + sorted; full set parity.
  });

  // .sh test 7: assert_eq TS_COUNT - the canonical baseline pin, bumped when
  // events are added or removed. (#367 added WORKFLOW_PARKED/UNPARKED -> 69;
  // #369 removed TEST_RUN_MODE_ENABLED -> 68; HUMAN_TURN took it to 69; the adaptive composer added RECOMPOSED -> 70; REVIEWER_SCOPE_BLOCKED took it to 71.)
  test("VALID_EVENT_TYPES.size === 71 (baseline pin) [.sh test 7]", () => {
    expect(TS_EVENTS.length).toBe(CANONICAL_COUNT);
  });
});
