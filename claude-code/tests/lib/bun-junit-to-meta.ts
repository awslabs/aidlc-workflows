#!/usr/bin/env bun
// bun-junit-to-meta.ts — D7 "tier-zero" glue tool.
//
// Normalizes bun's JUnit XML output into the existing `.meta` sidecar shape
// so the bash runner's aggregation (run-tests.sh aggregate_tier_results,
// :322-347) stays UNCHANGED. The runner's bash-file branch writes a 6-line
// `.meta` per file from TAP output (:283-294); a bun `.test.ts` file produces
// JUnit XML instead, and this tool maps that XML onto the identical 6-line
// shape so the parent's `source <meta>` + per-FILE aggregation are agnostic to
// how the file ran.
//
// WHY THE GLUE EXISTS (decision D7): bun's process exit is 0/1 (pass/any-fail)
// and cannot express the runner's "exit == number of FAILED FILES" contract
// (run-tests.sh :413 smoke fail-fast, :577 final). The runner derives
// FAILED_FILES by counting `.meta` files whose STATUS=FAIL — one increment per
// FILE regardless of how many testcases failed inside it. So the bun exit code
// is discarded; STATUS in the `.meta` is the single source of truth the parent
// reads, and RC here is a self-consistent exit code (0 PASS / 1 FAIL) the tool
// itself returns for any direct caller.
//
// ─── VERIFIED bun 1.2.22 JUnit XML SHAPE (probed this session) ───────────────
// Command: bun test <file> --reporter=junit --reporter-outfile=<X>
//
//   <testsuites name="bun test" tests=".." assertions=".." failures=".."
//               skipped=".." time="<float seconds>">      <-- ROOT: authoritative
//     <testsuite name="<file>" file=".." tests=".." failures=".." skipped=".."
//                time="0" ...>                            <-- per-FILE wrapper
//       <testsuite name="<describe>" ... time="0">        <-- per describe() block
//         <testcase name=".." time="<float>" ...>         <-- a test
//           <failure type="AssertionError" />             <-- present iff failed
//         </testcase>
//         <testcase ...><skipped /></testcase>            <-- present iff skipped
//       </testsuite>
//       <testcase .../>                                   <-- top-level (no describe)
//     </testsuite>
//   </testsuites>
//
// CITED real attributes observed:
//   - ROOT <testsuites>: tests, assertions, failures, skipped, time.
//     `tests` counts ALL testcases INCLUDING skipped. `time` is the only place
//     the real wall-clock float lives — every inner <testsuite time> is "0".
//   - failing <testcase> carries a nested empty <failure type="AssertionError" />.
//   - skipped <testcase> carries a nested empty <skipped />.
//   - bun process exit: 1 on any failure, 0 otherwise (incl. all-skip).
//   - EMPTY suite (describe with zero tests / no runnable tests): bun writes NO
//     outfile at all and exits 0. This tool treats a missing/empty input file as
//     0 tests / 0 failures / PASS / RC=0 — consistent with bun's exit 0.
//   - IMPORT/COLLECTION CRASH: a `.test.ts` that throws at import makes bun exit
//     NONZERO but ALSO write no outfile — byte-identical XML signal to the empty
//     suite above. The two are distinguishable ONLY by bun's exit code, so the
//     caller MUST pass `--bun-rc <$?>`; with it, a nonzero rc + empty XML maps to
//     STATUS=FAIL / FAILED=1 (not a vacuous PASS). See buildMeta + check 4 of the
//     W2 adversarial verify.
//
// ─── .meta CONTRACT (run-tests.sh :287-292, re-confirmed this session) ───────
// Exactly 6 lines, bash-sourceable (KEY=value, no spaces around =), in order:
//   NAME=<basename, no extension>
//   STATUS=<PASS|FAIL>
//   TESTS=<count of testcases>
//   FAILED=<count of failures>
//   DURATION=<seconds, may be float>
//   RC=<process exit code>
//
// MAPPING DECISIONS:
//   - ONE input JUnit file -> ONE `.meta`. The runner names one `.meta` per
//     FILE, and one bun `.test.ts` file produces one JUnit document with exactly
//     one root <testsuites>. If a document ever contains MULTIPLE root-level
//     <testsuite> elements (not the bun-1.2.22 shape, but defended for safety),
//     they are SUMMED into the single `.meta` — because the runner's unit is the
//     FILE, and a file is one `.meta`. We never emit more than one `.meta`.
//   - TESTS  = root <testsuites tests>  (total testcases, including skipped),
//     falling back to the sum of root-level <testsuite tests> if the root attr
//     is absent.
//   - FAILED = root <testsuites failures> (fallback: sum of <testsuite failures>,
//     final fallback: count of <failure ...> elements).
//   - STATUS = FAIL iff FAILED > 0; PASS otherwise. (Skips do NOT fail a file —
//     mirrors bun exit 0 on all-skip, and the runner treats only rc!=0 as FAIL.)
//   - DURATION = root <testsuites time> float seconds (fallback: 0). Sources fine
//     in bash; the bash-file branch emits an integer here, the contract permits a
//     float, and aggregate does float-free integer += only on TESTS/FAILED.
//   - RC = 0 when PASS, 1 when FAIL. Self-consistent with STATUS; the parent never
//     reads RC for aggregation (it keys off STATUS), but RC keeps the `.meta`
//     faithful to the bash-file shape and gives a direct caller a real exit code.
//
// CLI CONTRACT:
//   bun bun-junit-to-meta.ts --xml <junit.xml> --out <target.meta> [--name <NAME>] [--bun-rc <N>]
//   bun bun-junit-to-meta.ts <junit.xml> <target.meta> [<NAME>]   (positional)
//
//   --xml / 1st positional : path to the JUnit XML (bun --reporter-outfile target).
//                            May be missing/empty -> treated as the empty-suite case.
//   --out / 2nd positional : path to write the 6-line `.meta` (written atomically:
//                            temp file + rename, mirroring the runner's mv).
//   --name / 3rd positional: the NAME value. If omitted, derived from the `.meta`
//                            target's basename minus a single trailing extension
//                            (e.g. t106.none.meta -> t106.none ... see deriveName).
//                            Sanitized to [A-Za-z0-9._-] so `source <meta>` is safe.
//   --bun-rc <N>           : bun's process exit code ($? from the `bun test` run).
//                            OPTIONAL but the runner SHOULD always pass it: it is
//                            the only signal that distinguishes an import crash
//                            (rc!=0, no XML) from a genuine empty suite (rc=0, no
//                            XML). Without it, an import crash maps to PASS.
//
//   Process exits with the RC it wrote into the `.meta` (= --bun-rc when given,
//   else 0 PASS / 1 FAIL). A usage error (no --out) exits 2 on stderr.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export interface MetaCounts {
  name: string;
  status: "PASS" | "FAIL";
  tests: number;
  failed: number;
  duration: string; // kept as a string so we preserve bun's float formatting verbatim
  rc: number;
}

/** Pull the first integer-valued attribute `attr` from `tag`'s opening element. */
function attrInt(openTag: string, attr: string): number | null {
  const m = openTag.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Pull a raw string attribute (used for `time`, kept verbatim). */
function attrStr(openTag: string, attr: string): string | null {
  const m = openTag.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

/**
 * Sanitize a NAME so the emitted `.meta` line `NAME=<value>` is safe to
 * `source` in bash UNQUOTED (the runner's exact idiom, run-tests.sh:331).
 * Legitimate names are test-file basenames (`t106.none`) drawn from
 * `[A-Za-z0-9._-]`, so this is a no-op on real input; it only neutralizes a
 * hostile name (spaces, `;`, backticks, `$()`, `=`) that would otherwise let
 * `source <meta>` execute arbitrary shell. Anything outside the safe charset
 * is replaced with `_`.
 */
function sanitizeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Sanitize DURATION to a bare numeric token (`[0-9.]`). bun's `time` attr is
 * always a clean float (e.g. `0.013767`), so this is a no-op on real input; it
 * defends against a malformed/hostile `time` value reaching a sourced line.
 * Non-numeric input collapses to `0`.
 */
function sanitizeDuration(raw: string): string {
  const m = raw.match(/^[0-9]+(\.[0-9]+)?$/);
  return m ? raw : "0";
}

/**
 * Parse bun JUnit XML text into normalized counts.
 *
 * Strategy: prefer the ROOT <testsuites ...> opening tag, which carries the
 * authoritative file-level totals (tests / failures / time) in the real bun
 * shape. Fall back to summing root-level <testsuite> opening tags, then to
 * counting <failure/> elements, so a future bun reshape or a multi-suite
 * document still produces one correct `.meta`.
 *
 * `xml` empty/whitespace (the empty-suite case where bun wrote no file) yields
 * 0 tests / 0 failures.
 */
export function parseJUnit(xml: string): { tests: number; failed: number; duration: string } {
  const text = (xml ?? "").trim();
  if (text === "") return { tests: 0, failed: 0, duration: "0" };

  // ROOT <testsuites ...> opening tag (singular: there is one root document).
  const rootMatch = text.match(/<testsuites\b[^>]*>/);
  let tests: number | null = null;
  let failed: number | null = null;
  let duration: string | null = null;

  if (rootMatch) {
    const root = rootMatch[0];
    tests = attrInt(root, "tests");
    failed = attrInt(root, "failures");
    duration = attrStr(root, "time");
  }

  // Fallback: sum every <testsuite ...> OPENING tag that is a direct/standalone
  // suite element. We match opening tags only (not self-closing, none expected)
  // and sum their `tests` / `failures`. This covers a document with multiple
  // root-level <testsuite> blocks and no <testsuites> wrapper.
  if (tests === null || failed === null) {
    const suiteTags = text.match(/<testsuite\b[^>]*>/g) ?? [];
    // The bun shape nests testsuites; summing ALL of them would double-count.
    // Only sum when we have no root totals at all (i.e. no <testsuites> wrapper),
    // in which case each <testsuite> is independent.
    if (!rootMatch) {
      let tSum = 0;
      let fSum = 0;
      let dSum = 0;
      let sawDuration = false;
      for (const tag of suiteTags) {
        tSum += attrInt(tag, "tests") ?? 0;
        fSum += attrInt(tag, "failures") ?? 0;
        const d = attrStr(tag, "time");
        if (d !== null) {
          dSum += Number(d) || 0;
          sawDuration = true;
        }
      }
      tests = tSum;
      failed = fSum;
      duration = sawDuration ? String(dSum) : "0";
    }
  }

  // Final fallback for failures: count nested <failure ...> elements directly.
  if (failed === null) {
    failed = (text.match(/<failure\b/g) ?? []).length;
  }
  // Final fallback for tests: count <testcase ...> elements directly.
  if (tests === null) {
    tests = (text.match(/<testcase\b/g) ?? []).length;
  }
  if (duration === null || duration === "") duration = "0";

  return { tests, failed, duration };
}

/**
 * Derive NAME from the `.meta` target path the same way the bash runner does
 * for a TAP file: basename, then strip a single trailing extension. For a
 * target like `/results/t106.none.meta`, basename is `t106.none.meta` and we
 * strip the `.meta` -> `t106.none`. The runner's `name` is the source filename
 * minus its extension (e.g. `t106.none.test.ts` -> stripped per its own logic),
 * but since this tool is handed the `.meta` target, the basename minus `.meta`
 * reproduces the intended NAME exactly.
 */
export function deriveName(metaPath: string): string {
  const base = basename(metaPath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Build the normalized counts from XML text + a chosen NAME.
 *
 * `bunRc` is bun's process exit code (0 = no failures, nonzero = any failure
 * INCLUDING an import/collection-time crash). It is the channel that closes the
 * load-bearing D7 hole: when a `.test.ts` throws at import, bun exits nonzero
 * but writes NO JUnit file, so the parsed XML is empty (0 tests / 0 failures) —
 * indistinguishable from a genuine zero-test describe (which bun also exits 0
 * for). Without bunRc the glue would map the crash to STATUS=PASS and the file
 * would contribute +0 to FAILED_FILES, silently under-reporting the failure.
 *
 * Rule: STATUS=FAIL iff (parsed failures > 0) OR (bunRc is known and nonzero).
 * In the crash case (bunRc != 0 but parsed failed == 0) we synthesize
 * `failed = 1` so the FAIL is visible in the count, and RC mirrors bunRc.
 *
 * `bunRc` is OPTIONAL (default null): omitting it preserves the original
 * XML-only behaviour exactly, so a caller that cannot supply the exit code (or
 * the tool's own happy-path tests) is unaffected. The runner SHOULD always pass
 * it.
 */
export function buildMeta(xml: string, name: string, bunRc: number | null = null): MetaCounts {
  const parsed = parseJUnit(xml);
  const tests = parsed.tests;
  const rcFail = bunRc !== null && bunRc !== 0;
  const status: "PASS" | "FAIL" = parsed.failed > 0 || rcFail ? "FAIL" : "PASS";
  // If bun reported a nonzero exit but the XML carried no countable failure
  // (the import-crash case), surface at least one failure so STATUS=FAIL is
  // backed by a nonzero FAILED count the parent's per-FILE aggregation honors.
  const failed = status === "FAIL" && parsed.failed === 0 ? 1 : parsed.failed;
  return {
    name: sanitizeName(name),
    status,
    tests,
    failed,
    duration: sanitizeDuration(parsed.duration),
    // RC stays faithful to the real signal: bun's rc when known, else derived.
    rc: bunRc !== null ? bunRc : status === "FAIL" ? 1 : 0,
  };
}

/**
 * Render the EXACT 6-line `.meta` shape (run-tests.sh :287-292). No trailing
 * newline beyond the final line's — matches `echo` lines piped into a file
 * (each `echo` adds one `\n`, so 6 echoes => 6 lines each terminated by `\n`).
 */
export function renderMeta(m: MetaCounts): string {
  return `${[
    `NAME=${m.name}`,
    `STATUS=${m.status}`,
    `TESTS=${m.tests}`,
    `FAILED=${m.failed}`,
    `DURATION=${m.duration}`,
    `RC=${m.rc}`,
  ].join("\n")}\n`;
}

/** Atomic write: temp file in the same dir, then rename (mirrors runner's mv). */
function writeMetaAtomic(outPath: string, content: string): void {
  const tmp = `${outPath}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, outPath);
}

interface CliArgs {
  xml: string | null;
  out: string | null;
  name: string | null;
  bunRc: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { xml: null, out: null, name: null, bunRc: null };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--xml") out.xml = argv[++i] ?? null;
    else if (a === "--out") out.out = argv[++i] ?? null;
    else if (a === "--name") out.name = argv[++i] ?? null;
    else if (a === "--bun-rc") {
      const v = argv[++i];
      const n = Number(v);
      out.bunRc = v !== undefined && Number.isFinite(n) ? n : null;
    } else positional.push(a);
  }
  if (out.xml === null && positional[0] !== undefined) out.xml = positional[0];
  if (out.out === null && positional[1] !== undefined) out.out = positional[1];
  if (out.name === null && positional[2] !== undefined) out.name = positional[2];
  return out;
}

/** Read the XML file if it exists and is non-empty; else return "" (empty-suite). */
function readXmlOrEmpty(xmlPath: string | null): string {
  if (xmlPath === null) return "";
  if (!existsSync(xmlPath)) return "";
  try {
    if (statSync(xmlPath).size === 0) return "";
    return readFileSync(xmlPath, "utf8");
  } catch {
    return "";
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.out === null) {
    process.stderr.write(
      "usage: bun bun-junit-to-meta.ts --xml <junit.xml> --out <target.meta> [--name <NAME>]\n" +
        "   or: bun bun-junit-to-meta.ts <junit.xml> <target.meta> [<NAME>]\n",
    );
    return 2;
  }
  const name = args.name ?? deriveName(args.out);
  const xml = readXmlOrEmpty(args.xml);
  const meta = buildMeta(xml, name, args.bunRc);
  writeMetaAtomic(args.out, renderMeta(meta));
  return meta.rc;
}

// Run as CLI only when invoked directly (not when imported by the test).
if (import.meta.main) {
  process.exit(main());
}
