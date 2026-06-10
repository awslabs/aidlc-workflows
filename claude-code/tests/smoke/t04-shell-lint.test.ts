// covers:
//
// t04 — shell anti-pattern lint. Migrated from tests/smoke/t04-shell-lint.sh
// (TAP plan 2, two awk-based corpus scanners). The .sh had no `# covers:`
// header (it is a structural lint over the test suite's own .sh corpus, not a
// unit contract on a shipped tool), so this twin's covers id list is empty too
// — matching the smoke meta-guard house style in
// tests/smoke/t02-hook-executability.test.ts and t-scope-mapping-guard.test.ts.
//
// Mechanism: none. Subject is the suite's own *.sh corpus on disk
// (tests/**/*.sh) — a pure structural file scan with zero LLM, zero tokens,
// zero process boundary. We port the two awk scanners into TypeScript and run
// them in-process over the SAME corpus the .sh resolved (TESTS_ROOT =
// "$SCRIPT_DIR/.." == <REPO_ROOT>/tests, here REPO_ROOT/tests).
//
// What the .sh guards (verbatim from its header, t04-shell-lint.sh:1-18):
//   Pattern A — a trailing `[ ... ] && action` as the LAST non-blank,
//     non-comment line of a function body, with no `|| fallback`. Under
//     `set -e` a falsy `[` exit propagates through the function return and
//     kills the caller mid-script (#34: tap.sh `not_ok` killed multi-case
//     tests mid-plan). Guard scope: function bodies only.
//   Pattern B — `$VAR` adjacent to a non-printable-ASCII byte without `${...}`
//     braces. Under `set -u` bash reads the UTF-8 continuation bytes as part of
//     the identifier and exits "unbound variable" (#41: t21b `→` arrow crashed
//     the script before assertions could fire).
//
// Port of the scanners (faithful to the .sh's awk):
//   isCandidateA(line)  <- awk is_candidate (t04:25-29):
//       /^[[:space:]]*\[[^]]*\][[:space:]]*&&[[:space:]]*[^|&]+$/  AND
//       index(line,"||")==0  AND  line not a comment.
//   scanA(text)  <- the in_fn state machine (t04:32-49): on `name() {` enter a
//       body and reset last_cand/last_code; on `}` at col 0 emit iff the most
//       recent code line WAS a candidate; otherwise track last_code / last_cand
//       over non-blank, non-comment body lines.
//   scanB(text)  <- the Pattern-B awk (t04:62-70):
//       /\$[A-Za-z_][A-Za-z0-9_]*[^ -~\t]/  on any non-comment line.
//
// Old TAP -> new test parity (1:1, every .sh `ok` row -> a named test()):
//   .sh test 1 (Pattern A: corpus has no trailing `[..] &&` last-line, #34)
//        -> "corpus has no trailing '[ ... ] && action' as a function's last line (#34)"
//   .sh test 2 (Pattern B: corpus has no unbraced $VAR before non-ASCII, #41)
//        -> "corpus has no unbraced $VAR adjacent to a non-ASCII byte (#41)"
//
// STRONGER than the .sh (which only proves the live corpus is currently clean):
// this twin also proves each detector ACTUALLY FIRES on crafted violations
// (§6-E rigor — a guard whose failure event never fires is not a guard). The
// negative cases pin the exact #34 / #41 shapes and the safe-pattern carve-outs
// (a `|| fallback` line, an AND-OR outside a function body, a braced ${VAR}).

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

// TESTS_ROOT mirrors the .sh's `cd "$SCRIPT_DIR/.."` (t04:13) — the tests/ dir.
const TESTS_ROOT = join(REPO_ROOT, "tests");

/** All *.sh files under tests/, the .sh's `find "$TESTS_ROOT" -name "*.sh"`. */
function shellFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...shellFiles(p));
    else if (entry.endsWith(".sh")) out.push(p);
  }
  return out;
}

/**
 * Pattern-A candidate: a trailing `[ ... ] && action` with no `||` fallback,
 * not a comment. Mirrors awk is_candidate (t04:25-29). The awk char class
 * [[:space:]] is whitespace; [^]] is "not a closing bracket".
 */
function isCandidateA(line: string): boolean {
  if (/^\s*#/.test(line)) return false;
  if (line.includes("||")) return false;
  return /^\s*\[[^\]]*\]\s*&&\s*[^|&]+$/.test(line);
}

/**
 * Pattern-A corpus scan: returns `file:line` hits where a candidate is the
 * LAST non-blank/non-comment line of a function body (the body-closing `}` at
 * column 0 immediately follows it, code-line-wise). Ports the awk state
 * machine in t04:32-49.
 */
function scanA(text: string, fileName: string): string[] {
  const hits: string[] = [];
  const lines = text.split("\n");
  let inFn = false;
  let lastCand = 0;
  let lastCode = 0;
  // awk NR is 1-based.
  for (let i = 0; i < lines.length; i++) {
    const nr = i + 1;
    const s = lines[i];
    // Enter function body on `name() {` (awk t04:33-35).
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{?\s*$/.test(s)) {
      inFn = true;
      lastCand = 0;
      lastCode = 0;
      continue;
    }
    if (inFn && /^\}\s*$/.test(s)) {
      // Body-closing `}` at column 0 (awk t04:36-41).
      if (lastCand > 0 && lastCand === lastCode) {
        hits.push(`${fileName}:${lastCand}: trailing [..] && in function body`);
      }
      inFn = false;
      continue;
    }
    if (inFn) {
      if (/^\s*$/.test(s)) continue; // blank
      if (/^\s*#/.test(s)) continue; // comment
      lastCode = nr;
      if (isCandidateA(s)) lastCand = nr;
    }
  }
  return hits;
}

/**
 * Pattern-B corpus scan: `$VAR` immediately followed by a byte outside
 * printable-ASCII + tab, on a non-comment line. Ports the awk in t04:62-70.
 * The awk char class `[^ -~\t]` = anything not in printable ASCII (space..~)
 * and not a tab; in a JS string/regex the equivalent excludes \x20-\x7e and \t.
 */
function scanB(text: string, fileName: string): string[] {
  const hits: string[] = [];
  const re = /\$[A-Za-z_][A-Za-z0-9_]*[^ -~\t]/;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    if (/^\s*#/.test(s)) continue; // awk: skip comment lines
    if (re.test(s)) hits.push(`${fileName}:${i + 1}: ${s}`);
  }
  return hits;
}

const FILES = shellFiles(TESTS_ROOT);

describe("t04 shell anti-pattern lint — tests/**/*.sh corpus (migrated from t04-shell-lint.sh, plan 2)", () => {
  // Sanity: the corpus is non-empty, so a clean result is real coverage and not
  // a vacuous pass over zero files (the .sh implicitly relied on `find` hitting
  // files; we make it explicit).
  test("the .sh corpus under tests/ is non-empty (scan is not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  test("corpus has no trailing '[ ... ] && action' as a function's last line (#34) [.sh test 1]", () => {
    const hits: string[] = [];
    for (const f of FILES) hits.push(...scanA(readFileSync(f, "utf8"), f));
    // .sh: ok iff pattern_a_hits is empty. Surface the first few on failure,
    // mirroring the .sh's `head -5` detail.
    expect(hits.slice(0, 5)).toEqual([]);
    expect(hits).toEqual([]);
  });

  test("corpus has no unbraced $VAR adjacent to a non-ASCII byte (#41) [.sh test 2]", () => {
    const hits: string[] = [];
    for (const f of FILES) hits.push(...scanB(readFileSync(f, "utf8"), f));
    expect(hits.slice(0, 5)).toEqual([]);
    expect(hits).toEqual([]);
  });
});

// --- §6-E: the detectors must ACTUALLY FIRE on the shapes #34/#41 describe ---
// A lint guard that can never flag is not a guard. These cases drive crafted
// violations through the SAME scanA/scanB the corpus tests use, proving the
// failure event fires — and pin the safe-pattern carve-outs so the guard does
// not over-report.
describe("t04 Pattern-A detector — #34 trailing `[..] &&` in a function body", () => {
  test("FIRES: `[ -n \"$x\" ] && echo hi` as the last body line", () => {
    const bad = ['foo() {', '  do_thing', '  [ -n "$x" ] && echo hi', '}', ''].join("\n");
    const hits = scanA(bad, "BAD.sh");
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("BAD.sh:3:");
    expect(hits[0]).toContain("trailing [..] && in function body");
  });

  test("SAFE: an `|| fallback` on the AND-OR line is not flagged", () => {
    const ok = ['foo() {', '  [ -n "$x" ] && echo hi || true', '}', ''].join("\n");
    expect(scanA(ok, "OK.sh")).toEqual([]);
  });

  test("SAFE: a trailing comment after the candidate keeps it safe (candidate not the last code line)", () => {
    const ok = [
      "foo() {",
      '  [ -n "$x" ] && echo hi',
      "  echo done",
      "}",
      "",
    ].join("\n");
    // The last code line is `echo done`, not the candidate -> no hit.
    expect(scanA(ok, "OK.sh")).toEqual([]);
  });

  test("SAFE: AND-OR pattern OUTSIDE a function body is not flagged (guard scope is bodies)", () => {
    const ok = ['[ -n "$x" ] && echo hi', ""].join("\n");
    expect(scanA(ok, "OK.sh")).toEqual([]);
  });
});

describe("t04 Pattern-B detector — #41 unbraced $VAR adjacent to a non-ASCII byte", () => {
  test("FIRES: `echo $arrow→` (unbraced var glued to a multibyte arrow)", () => {
    const bad = ["#!/bin/bash", "echo $arrow→", ""].join("\n");
    const hits = scanB(bad, "BAD.sh");
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("BAD.sh:2:");
  });

  test("SAFE: braced shell-var before a non-ASCII arrow is not flagged", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell ${...} fixture, not a JS template
    const ok = ["#!/bin/bash", "echo ${arrow}→", ""].join("\n");
    expect(scanB(ok, "OK.sh")).toEqual([]);
  });

  test("SAFE: a non-ASCII byte INSIDE a comment line is not flagged", () => {
    const ok = ["# uses $arrow→ in prose", "echo plain", ""].join("\n");
    expect(scanB(ok, "OK.sh")).toEqual([]);
  });

  test("SAFE: `$VAR` followed by ASCII (a space, then text) is not flagged", () => {
    const ok = ["echo $arrow rest", ""].join("\n");
    expect(scanB(ok, "OK.sh")).toEqual([]);
  });
});
