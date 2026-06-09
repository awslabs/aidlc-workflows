// bun-junit-to-meta.test.ts — own bun:test for the D7 glue tool.
//
// Asserts on INLINE FIXTURE XML strings (not by spawning bun), shaped exactly
// like the real bun 1.2.22 JUnit output probed this session:
//   - ROOT <testsuites ... tests=.. failures=.. skipped=.. time="<float>">
//   - per-FILE <testsuite> wrapper (time="0")
//   - nested per-describe() <testsuite> blocks
//   - failing <testcase> carries <failure type="AssertionError" />
//   - skipped <testcase> carries <skipped />
//
// Cases covered (per the brief):
//   1. 3 testcases / 1 failure   => TESTS=3 FAILED=1 STATUS=FAIL
//   2. 5 testcases / 3 failures  => TESTS=5 FAILED=3 STATUS=FAIL
//   3. N testcases / 0 failures  => FAILED=0 STATUS=PASS
//   4. 0 testcases (empty suite) => TESTS=0 FAILED=0 STATUS=PASS RC=0
// Plus: emitted .meta is exactly 6 lines, bash-sourceable (KEY=value), NAME
// matches the requested input, and DURATION carries bun's float verbatim.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMeta,
  deriveName,
  parseJUnit,
  renderMeta,
} from "./bun-junit-to-meta.ts";

// Module-scope round-trip helper used by the W2-regression describes below.
// Builds a .meta (optionally with a bunRc), writes it to a FIXED-name file in a
// temp dir (so a hostile `name` exercises NAME-CONTENT sanitization, not a
// hostile filename), and `source`s it in a clean bash to prove safety.
const _rcTmps: string[] = [];
afterEach(() => {
  for (const d of _rcTmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function writeAndSourceRc(xml: string, name: string, bunRc: number | null) {
  const dir = mkdtempSync(join(tmpdir(), "junit-meta-rc-"));
  _rcTmps.push(dir);
  const metaPath = join(dir, "out.meta"); // fixed, safe filename
  const content = renderMeta(buildMeta(xml, name, bunRc));
  writeFileSync(metaPath, content, "utf8");
  const out = execFileSync(
    "bash",
    ["-c", `set -eu; source "${metaPath}"; echo "$NAME|$STATUS|$TESTS|$FAILED|$DURATION|$RC"`],
    { encoding: "utf8" },
  ).trim();
  return { metaPath, content, sourced: out };
}

// ── Fixtures: byte-shaped like real bun 1.2.22 output ───────────────────────

// 3 testcases, 1 failure (one nested describe block).
const XML_3_1 = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="3" failures="1" skipped="0" time="0.012345">
  <testsuite name="t.test.ts" file="t.test.ts" tests="3" assertions="3" failures="1" skipped="0" time="0" hostname="h">
    <testsuite name="group A" file="t.test.ts" line="2" tests="3" assertions="3" failures="1" skipped="0" time="0" hostname="h">
      <testcase name="ok 1" classname="group A" time="0.0001" file="t.test.ts" line="3" assertions="1" />
      <testcase name="ok 2" classname="group A" time="0.0001" file="t.test.ts" line="4" assertions="1" />
      <testcase name="bad 1" classname="group A" time="0.0007" file="t.test.ts" line="5" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

// 5 testcases, 3 failures.
const XML_5_3 = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="5" failures="3" skipped="0" time="0.020000">
  <testsuite name="t.test.ts" file="t.test.ts" tests="5" assertions="5" failures="3" skipped="0" time="0" hostname="h">
    <testcase name="ok 1" classname="" time="0" file="t.test.ts" line="2" assertions="1" />
    <testcase name="ok 2" classname="" time="0" file="t.test.ts" line="3" assertions="1" />
    <testcase name="bad 1" classname="" time="0.0001" file="t.test.ts" line="4" assertions="1">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="bad 2" classname="" time="0.0001" file="t.test.ts" line="5" assertions="1">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="bad 3" classname="" time="0.0001" file="t.test.ts" line="6" assertions="1">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>`;

// 9 testcases, 0 failures — the real t106.none.test.ts shape (two describe
// blocks of 4 + one of 1), transcribed from the probe this session.
const XML_9_0 = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="9" assertions="14" failures="0" skipped="0" time="0.028891">
  <testsuite name="tests/unit/t106.none.test.ts" file="tests/unit/t106.none.test.ts" tests="9" assertions="14" failures="0" skipped="0" time="0" hostname="h">
    <testsuite name="stateFilePath()" file="tests/unit/t106.none.test.ts" line="44" tests="4" assertions="4" failures="0" skipped="0" time="0" hostname="h">
      <testcase name="a" classname="stateFilePath()" time="0.0003" file="x" line="45" assertions="1" />
      <testcase name="b" classname="stateFilePath()" time="0" file="x" line="52" assertions="1" />
      <testcase name="c" classname="stateFilePath()" time="0" file="x" line="59" assertions="1" />
      <testcase name="d" classname="stateFilePath()" time="0" file="x" line="65" assertions="1" />
    </testsuite>
    <testsuite name="auditFilePath()" file="tests/unit/t106.none.test.ts" line="72" tests="4" assertions="4" failures="0" skipped="0" time="0" hostname="h">
      <testcase name="a" classname="auditFilePath()" time="0" file="x" line="73" assertions="1" />
      <testcase name="b" classname="auditFilePath()" time="0" file="x" line="79" assertions="1" />
      <testcase name="c" classname="auditFilePath()" time="0" file="x" line="85" assertions="1" />
      <testcase name="d" classname="auditFilePath()" time="0" file="x" line="89" assertions="1" />
    </testsuite>
    <testsuite name="rel" file="tests/unit/t106.none.test.ts" line="94" tests="1" assertions="6" failures="0" skipped="0" time="0" hostname="h">
      <testcase name="x" classname="rel" time="0" file="x" line="95" assertions="6" />
    </testsuite>
  </testsuite>
</testsuites>`;

// Mixed: 2 pass + 2 fail + 1 skip = 5 tests, 2 failures. `tests` INCLUDES the
// skip (verified against the real probe). STATUS must be FAIL (failures>0),
// skips do not flip it.
const XML_SKIP_MIX = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="4" failures="2" skipped="1" time="0.013767">
  <testsuite name="t.test.ts" file="t.test.ts" tests="5" assertions="4" failures="2" skipped="1" time="0" hostname="h">
    <testsuite name="group A" file="t.test.ts" line="2" tests="3" assertions="3" failures="2" skipped="0" time="0" hostname="h">
      <testcase name="passes 1" classname="group A" time="0" file="t.test.ts" line="3" assertions="1" />
      <testcase name="fails 1" classname="group A" time="0.0007" file="t.test.ts" line="4" assertions="1">
        <failure type="AssertionError" />
      </testcase>
      <testcase name="fails 2" classname="group A" time="0.0004" file="t.test.ts" line="5" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
    <testcase name="top-level pass" classname="" time="0" file="t.test.ts" line="7" assertions="1" />
    <testcase name="a skipped one" classname="" time="0" file="t.test.ts" line="8" assertions="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;

// All-skip: 2 tests, 0 failures, exit 0 in real bun => PASS.
const XML_ALL_SKIP = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="0" failures="0" skipped="2" time="0.010998">
  <testsuite name="t.test.ts" file="t.test.ts" tests="2" assertions="0" failures="0" skipped="2" time="0" hostname="h">
    <testcase name="s1" classname="" time="0" file="t.test.ts" line="2" assertions="0"><skipped /></testcase>
    <testcase name="s2" classname="" time="0" file="t.test.ts" line="3" assertions="0"><skipped /></testcase>
  </testsuite>
</testsuites>`;

// ── parseJUnit / buildMeta unit assertions ──────────────────────────────────

describe("parseJUnit reads root totals", () => {
  test("3 testcases / 1 failure", () => {
    expect(parseJUnit(XML_3_1)).toEqual({ tests: 3, failed: 1, duration: "0.012345" });
  });
  test("5 testcases / 3 failures", () => {
    expect(parseJUnit(XML_5_3)).toEqual({ tests: 5, failed: 3, duration: "0.020000" });
  });
  test("9 testcases / 0 failures", () => {
    expect(parseJUnit(XML_9_0)).toEqual({ tests: 9, failed: 0, duration: "0.028891" });
  });
  test("skip is counted in tests but not in failures", () => {
    expect(parseJUnit(XML_SKIP_MIX)).toEqual({ tests: 5, failed: 2, duration: "0.013767" });
  });
  test("all-skip: tests counted, zero failures", () => {
    expect(parseJUnit(XML_ALL_SKIP)).toEqual({ tests: 2, failed: 0, duration: "0.010998" });
  });
  test("empty/missing XML => 0 tests, 0 failures, 0 duration", () => {
    expect(parseJUnit("")).toEqual({ tests: 0, failed: 0, duration: "0" });
    expect(parseJUnit("   \n  ")).toEqual({ tests: 0, failed: 0, duration: "0" });
  });
});

describe("buildMeta derives STATUS and RC", () => {
  test("1 failure => FAIL / RC=1", () => {
    const m = buildMeta(XML_3_1, "t");
    expect(m.status).toBe("FAIL");
    expect(m.failed).toBe(1);
    expect(m.rc).toBe(1);
  });
  test("3 failures => FAIL / RC=1, TESTS=5", () => {
    const m = buildMeta(XML_5_3, "t");
    expect(m.status).toBe("FAIL");
    expect(m.tests).toBe(5);
    expect(m.failed).toBe(3);
    expect(m.rc).toBe(1);
  });
  test("0 failures => PASS / RC=0", () => {
    const m = buildMeta(XML_9_0, "t");
    expect(m.status).toBe("PASS");
    expect(m.failed).toBe(0);
    expect(m.rc).toBe(0);
  });
  test("skip-mix with failures => FAIL", () => {
    expect(buildMeta(XML_SKIP_MIX, "t").status).toBe("FAIL");
  });
  test("all-skip => PASS / RC=0 (skips never fail a file)", () => {
    const m = buildMeta(XML_ALL_SKIP, "t");
    expect(m.status).toBe("PASS");
    expect(m.rc).toBe(0);
  });
  test("empty suite => TESTS=0 FAILED=0 PASS RC=0", () => {
    const m = buildMeta("", "t106.none");
    expect(m).toMatchObject({ name: "t106.none", status: "PASS", tests: 0, failed: 0, rc: 0 });
  });
});

describe("deriveName strips a single trailing extension from the .meta path", () => {
  test("t106.none.meta => t106.none", () => {
    expect(deriveName("/results/t106.none.meta")).toBe("t106.none");
  });
  test("t68.meta => t68", () => {
    expect(deriveName("/x/y/t68.meta")).toBe("t68");
  });
});

// ── renderMeta shape assertions: exactly 6 lines, KEY=value, correct order ──

describe("renderMeta emits the EXACT 6-line .meta shape", () => {
  test("6 lines in NAME/STATUS/TESTS/FAILED/DURATION/RC order, KEY=value", () => {
    const out = renderMeta(buildMeta(XML_3_1, "t106.none"));
    // Trailing newline after the 6th line; split drops the final empty token.
    const lines = out.split("\n");
    expect(lines[lines.length - 1]).toBe(""); // file ends with a newline
    const body = lines.slice(0, -1);
    expect(body.length).toBe(6);
    expect(body[0]).toBe("NAME=t106.none");
    expect(body[1]).toBe("STATUS=FAIL");
    expect(body[2]).toBe("TESTS=3");
    expect(body[3]).toBe("FAILED=1");
    expect(body[4]).toBe("DURATION=0.012345");
    expect(body[5]).toBe("RC=1");
    // Every line is a bash-safe KEY=value assignment (no spaces around =).
    for (const line of body) {
      expect(line).toMatch(/^[A-Z]+=[^ ]*$/);
    }
  });
});

// ── End-to-end: write a real .meta and prove bash can source it ─────────────

describe("emitted .meta is bash-sourceable and round-trips", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeAndSource(xml: string, name: string) {
    const dir = mkdtempSync(join(tmpdir(), "junit-meta-"));
    tmps.push(dir);
    const metaPath = join(dir, `${name}.meta`);
    const content = renderMeta(buildMeta(xml, name));
    Bun.write(metaPath, content);
    // Force the write to land synchronously before sourcing.
    require("node:fs").writeFileSync(metaPath, content, "utf8");
    // Source the .meta in a clean bash and echo back the variables. If any line
    // were not a valid assignment, `source` would error / produce wrong output.
    const out = execFileSync(
      "bash",
      ["-c", `set -eu; source "${metaPath}"; echo "$NAME|$STATUS|$TESTS|$FAILED|$DURATION|$RC"`],
      { encoding: "utf8" },
    ).trim();
    return { metaPath, content, sourced: out };
  }

  test("3/1 FAIL sources to the expected values", () => {
    const { content, sourced } = writeAndSource(XML_3_1, "t106.none");
    expect(content.split("\n").filter((l) => l !== "").length).toBe(6);
    expect(sourced).toBe("t106.none|FAIL|3|1|0.012345|1");
  });

  test("9/0 PASS sources to the expected values, NAME preserved", () => {
    const { sourced } = writeAndSource(XML_9_0, "t106.none");
    expect(sourced).toBe("t106.none|PASS|9|0|0.028891|0");
  });

  test("empty suite sources to 0/0 PASS RC=0", () => {
    const { sourced } = writeAndSource("", "t999.none");
    expect(sourced).toBe("t999.none|PASS|0|0|0|0");
  });
});

// ── W2 adversarial-verify regressions: the two defects the skeptic found ─────
// (1) import/collection crash: bun rc!=0 + NO xml must be FAIL, not vacuous PASS
//     (check 4 — the load-bearing D7 break). (2) hostile NAME/DURATION must not
//     break `source` (check 3 — robustness against the runner's unquoted source).
describe("bun-rc channel — import-crash must not vacuously PASS (check 4)", () => {
  test("nonzero bunRc + empty XML => FAIL, FAILED=1, RC mirrors bunRc", () => {
    const m = buildMeta("", "t500.none", 1);
    expect(m.status).toBe("FAIL");
    expect(m.tests).toBe(0);
    expect(m.failed).toBe(1); // synthesized so the FAIL is backed by a count
    expect(m.rc).toBe(1);
  });

  test("bunRc=0 + empty XML stays a genuine empty-suite PASS", () => {
    const m = buildMeta("", "t501.none", 0);
    expect(m.status).toBe("PASS");
    expect(m.failed).toBe(0);
    expect(m.rc).toBe(0);
  });

  test("omitted bunRc preserves original XML-only behaviour (back-compat)", () => {
    // No third arg → identical to the pre-fix happy path; existing tests rely on this.
    const m = buildMeta(XML_9_0, "t106.none");
    expect(m.status).toBe("PASS");
    expect(m.failed).toBe(0);
    expect(m.rc).toBe(0);
  });

  test("nonzero bunRc does NOT mask a real parsed failure count", () => {
    // XML already shows 3 failures; bunRc=1 agrees — FAILED stays 3, not clobbered to 1.
    const m = buildMeta(XML_5_3, "t106.none", 1);
    expect(m.status).toBe("FAIL");
    expect(m.failed).toBe(3);
    expect(m.rc).toBe(1);
  });

  test("aggregate increments FAILED_FILES by +1 for a crashed file", () => {
    // End-to-end: a crashed file (rc=1, no xml) writes one FAIL meta; the runner's
    // per-FILE count must see exactly +1. Round-trip through real bash source.
    const { sourced } = writeAndSourceRc("", "t502.none", 1);
    const [name, status, tests, failed, , rc] = sourced.split("|");
    expect(name).toBe("t502.none");
    expect(status).toBe("FAIL");
    expect(tests).toBe("0");
    expect(failed).toBe("1");
    expect(rc).toBe("1");
  });
});

describe("source-safety — hostile NAME/DURATION cannot execute (check 3)", () => {
  test("hostile NAME is sanitized to [A-Za-z0-9._-]; source cannot execute it", () => {
    // A name engineered to break out of `source`: spaces, ;, backticks, $().
    // The security property is that the SHELL METACHARACTERS are neutralized so
    // nothing executes — NOT that the literal letters "PWNED" disappear (they
    // survive harmlessly as part of the inert NAME token). Proof of no-execution:
    // `id` never ran, so no uid=/gid= output appears, and NAME is one safe token.
    const hostile = "evil name=x; echo OWNED `id` $(id)";
    const { sourced } = writeAndSourceRc(XML_9_0, hostile, 0);
    const name = sourced.split("|")[0];
    // Single safe token — every metachar (space ; ` $ ( ) =) was replaced with _.
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name).not.toMatch(/[ ;`$()=]/);
    // `id` did NOT execute: no uid=/gid= leaked into the sourced output, and the
    // STATUS field is exactly the second pipe-segment (proving NAME stayed one
    // field and did not spill extra shell words into the echo).
    expect(sourced).not.toMatch(/uid=\d+|gid=\d+/);
    expect(sourced.split("|")[1]).toBe("PASS");
  });

  test("hostile DURATION (shell injection in time attr) collapses to a numeric token", () => {
    const evilXml = `<?xml version="1.0"?>
<testsuites name="bun test" tests="1" failures="0" time="0; rm -rf /tmp/PWNED_MARKER">
  <testsuite name="x" tests="1" failures="0" time="0"><testcase name="a" time="0"/></testsuite>
</testsuites>`;
    const m = buildMeta(evilXml, "t503.none", 0);
    expect(m.duration).toMatch(/^[0-9]+(\.[0-9]+)?$/); // bare number, no `;`/`rm`
    expect(m.duration).not.toContain("rm");
    expect(m.duration).not.toContain(";");
  });

  test("the .meta remains exactly 6 bash-sourceable lines even with hostile input", () => {
    const { content } = writeAndSourceRc("", "a;b c$(x)", 1);
    const lines = content.split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(6);
    for (const l of lines) expect(l).toMatch(/^[A-Z]+=[A-Za-z0-9._-]*$/);
  });
});
