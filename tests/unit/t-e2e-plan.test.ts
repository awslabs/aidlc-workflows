import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { e2eCaseCounts, planE2eFile, readE2eTimings, readJUnitEvidence, validateJUnitEvidence } from "../lib/e2e-plan.ts";

const scratchDirs: string[] = [];
const fixtureRoot = resolve(import.meta.dir, "../../tmp/e2e-plan-tests");

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(name: string, source: string): string {
  mkdirSync(fixtureRoot, { recursive: true });
  const dir = mkdtempSync(join(fixtureRoot, "source-"));
  scratchDirs.push(dir);
  const file = join(dir, name);
  // Planning must read source without importing it, launching a driver, or
  // depending on any of the deliberately unavailable fixture imports.
  writeFileSync(file, `throw new Error("fixture source must never execute");\n${source}\n`);
  return file;
}

// Generate call expressions and the terminal driver path at runtime so the
// coverage scanner cannot mistake this deterministic unit for a live test.
function call(driver: string, args = "{}"): string {
  return `await ${driver}(${args});`;
}

const terminalDriver = ["tui", "drive.ts"].join("-");

function terminalSource(command: string): string {
  return [
    `const driver = "../harness/${terminalDriver}";`,
    call("Bun.spawn", `[process.execPath, driver, "spawn", "--", "${command}"]`),
  ].join("\n");
}

describe("E2E source classification", () => {
  test("only native Windows Codex files share the sandbox initialization lane", () => {
    const codex = fixture("t-exec-codex-fixture.serial.test.ts", call("execCodex"));
    const kiro = fixture("t-ide-kiro-fixture.serial.test.ts", call("launchKiroIde"));
    expect(planE2eFile(codex, {}, "win32")).toMatchObject({
      resources: ["bedrock"], serialGroup: "windows-codex", exclusive: false,
    });
    expect(planE2eFile(codex, {}, "linux").serialGroup).toBeUndefined();
    expect(planE2eFile(codex, {}, "darwin").serialGroup).toBeUndefined();
    expect(planE2eFile(kiro, {}, "win32").serialGroup).toBeUndefined();
  });

  test("a numeric live SDK test requires Bedrock even without a driver-family filename", () => {
    const file = fixture("t901-live-sdk.test.ts", [
      'import { driveAidlc } from "../harness/sdk-drive.ts";',
      'const seconds = Number(process.env.AIDLC_TEST_TIMEOUT ?? "420");',
      call("driveAidlc", '{ prompt: "/aidlc --status" }'),
    ].join("\n"));
    expect(planE2eFile(file)).toEqual({
      file,
      resources: ["bedrock"],
      estimatedSeconds: 420,
      exclusive: false,
      requiresClaude: true,
      tui: false,
      liveGates: [],
    });
  });

  test.each(["t902-editor.test.ts", "t-ide-kiro-editor.serial.test.ts"])(
    "Kiro IDE reserves both Kiro and IDE slots for %s",
    (name) => {
      const file = fixture(name, [
        'import { launchKiroIde } from "../harness/kiro-ide-driver.ts";',
        'if (process.env.AIDLC_KIRO_IDE_LIVE === "1") {',
        call("launchKiroIde", '{ workspace: "fixture" }'),
        "}",
      ].join("\n"));
      expect(planE2eFile(file)).toMatchObject({
        file,
        resources: ["kiro", "ide"],
        exclusive: false,
        requiresClaude: false,
        tui: false,
        liveGates: ["AIDLC_KIRO_IDE_LIVE"],
      });
    },
  );

  test("mixed SDK and IDE work declares each resource and live gate only once", () => {
    const file = fixture("t903-mixed.test.ts", [
      'const ide = process.env.AIDLC_KIRO_IDE_LIVE === "1";',
      'const sdk = process.env.AIDLC_CLAUDE_SDK_LIVE === "1";',
      'const sameGate = process.env.AIDLC_KIRO_IDE_LIVE;',
      call("driveAidlc"),
      call("driveAidlc"),
      call("launchKiroIde"),
      call("driveKiroAcp"),
    ].join("\n"));
    expect(planE2eFile(file)).toMatchObject({
      resources: ["bedrock", "kiro", "ide"],
      requiresClaude: true,
      liveGates: ["AIDLC_CLAUDE_SDK_LIVE", "AIDLC_KIRO_IDE_LIVE"],
    });
  });

  test.each([
    {
      name: "t-tui-claude-fixture.serial.test.ts",
      source: terminalSource("claude"),
      resources: ["bedrock"],
      requiresClaude: true,
      tui: true,
    },
    {
      name: "t-tui-kiro-fixture.serial.test.ts",
      source: terminalSource("kiro-cli"),
      resources: ["kiro"],
      requiresClaude: false,
      tui: true,
    },
    {
      name: "t-acp-kiro-fixture.serial.test.ts",
      source: call("driveKiroAcp"),
      resources: ["kiro"],
      requiresClaude: false,
      tui: false,
    },
    {
      name: "t-exec-codex-fixture.serial.test.ts",
      source: call("execCodex"),
      resources: ["bedrock"],
      requiresClaude: false,
      tui: false,
    },
    {
      name: "t-run-opencode-fixture.serial.test.ts",
      source: call("runOpencode"),
      resources: ["bedrock"],
      requiresClaude: false,
      tui: false,
    },
  ])("audited serial driver family remains schedulable: $name", (entry) => {
    const file = fixture(entry.name, entry.source);
    expect(planE2eFile(file)).toMatchObject({
      file,
      resources: entry.resources,
      requiresClaude: entry.requiresClaude,
      tui: entry.tui,
      exclusive: false,
    });
  });

  test("an unknown serial family retains exclusivity even with a recognized SDK call", () => {
    const file = fixture("t904-unknown.serial.test.ts", call("driveAidlc"));
    expect(planE2eFile(file)).toMatchObject({
      resources: ["bedrock"],
      requiresClaude: true,
      exclusive: true,
    });
    const deterministic = fixture("t905-unknown.serial.test.ts", "export const value = 1;");
    expect(planE2eFile(deterministic)).toMatchObject({
      resources: [],
      requiresClaude: false,
      exclusive: true,
    });
  });

  const mentionedDrivers = [
    call("driveAidlc"),
    call("launchKiroIde"),
    call("driveKiroAcp"),
    call("execCodex"),
    call("execOpencode"),
    call("runOpencode"),
    terminalSource("claude"),
    'const sdk = process.env.AIDLC_CLAUDE_SDK_LIVE;',
    'const ide = process.env.AIDLC_KIRO_IDE_LIVE;',
    'const seconds = Number(process.env.AIDLC_TEST_TIMEOUT ?? "999");',
  ].join("\n");

  test.each([
    ["line comments", mentionedDrivers.split("\n").map((line) => `// ${line}`).join("\n")],
    ["block comments", `/*\n${mentionedDrivers}\n*/`],
    ["trailing comments", `const value = 1; // ${mentionedDrivers.replaceAll("\n", " ")}`],
  ])("%s do not create dependencies, live gates, or timing hints", (_label, source) => {
    const file = fixture("t906-comments.test.ts", source);
    expect(planE2eFile(file)).toEqual({
      file,
      resources: [],
      requiresClaude: false,
      tui: false,
      liveGates: [],
      estimatedSeconds: 30,
      exclusive: false,
    });
  });

  test("comment-like text in a URL does not hide a real SDK call later on the line", () => {
    const file = fixture("t907-url.test.ts", [
      "// fixture glob: tests/fixtures/**/*.ts",
      `const url = "https://example.test/fixture"; ${call("driveAidlc")}`,
    ].join("\n"));
    expect(planE2eFile(file)).toMatchObject({ resources: ["bedrock"], requiresClaude: true });
  });

  test("a deterministic numeric test needs no live resource or gate", () => {
    const file = fixture("t908-deterministic.test.ts", "export const sum = 1 + 2;");
    expect(planE2eFile(file)).toEqual({
      file,
      resources: [],
      requiresClaude: false,
      tui: false,
      liveGates: [],
      estimatedSeconds: 30,
      exclusive: false,
    });
  });
});

// Literal runner-summary rows: status and assertion counts are historical
// observations, while only duration influences scheduling.
const HISTORY = `AI-DLC Test Run Summary
======================
Timestamp: 2026-09-11T00:00:00Z
Tiers: e2e
Mode: debug (streaming + driver traces)

Per-file results:
  File                                     Status Assertions Failed Duration
  ----                                     ------ ---------- ------ --------
  t901-live-sdk                            PASS   8          0      72.5s
  t908-deterministic                       FAIL   4          2      13.75s
  t-removed-from-inventory                 SKIP   0          0      2.25s
  t-zero-duration                          SKIP   0          0      0s

Totals:
  Test files: 4
  Failed files: 1
  Total assertions: 12
  Failed assertions: 2
  Result: FAIL
`;

describe("E2E historical timing hints", () => {
  test.each(["LF", "CRLF"])("reads positive durations across statuses from a %s summary", (lineEndings) => {
    const text = lineEndings === "CRLF" ? HISTORY.replaceAll("\n", "\r\n") : HISTORY;
    expect(readE2eTimings(text)).toEqual({
      "t901-live-sdk.test.ts": 72.5,
      "t908-deterministic.test.ts": 13.75,
      "t-removed-from-inventory.test.ts": 2.25,
    });
  });

  test("history changes estimates without filtering new files or reviving obsolete ones", () => {
    const files = [
      fixture("t901-live-sdk.test.ts", call("driveAidlc")),
      fixture("t908-deterministic.test.ts", "export const value = 1;"),
      fixture("t909-new-editor.test.ts", [
        'const seconds = Number(process.env.AIDLC_TEST_TIMEOUT ?? "600");',
        call("launchKiroIde"),
      ].join("\n")),
      fixture("t910-new-default.test.ts", "export const value = 2;"),
    ];
    const weights = readE2eTimings(HISTORY);
    const originalWeights = { ...weights };
    const baseline = files.map((file) => planE2eFile(file));
    const weighted = files.map((file) => planE2eFile(file, weights));
    expect(weighted.map(({ file }) => file)).toEqual(files);
    expect(weighted.map(({ estimatedSeconds }) => estimatedSeconds)).toEqual([72.5, 13.75, 600, 30]);
    expect(weighted.map(({ estimatedSeconds: _seconds, ...rest }) => rest)).toEqual(
      baseline.map(({ estimatedSeconds: _seconds, ...rest }) => rest),
    );
    expect(weights).toEqual(originalWeights);
  });

  test("the complete on-disk E2E inventory receives exactly one plan per file with sparse history", () => {
    const directory = resolve(import.meta.dir, "../e2e");
    const files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => join(directory, entry.name))
      .sort();
    expect(files.length).toBeGreaterThan(1);
    const weightedFile = files[0];
    const weights = readE2eTimings([
      `${basename(weightedFile, ".test.ts")} PASS 1 0 123.5s`,
      "t-obsolete-fixture FAIL 1 1 999s",
    ].join("\n"));
    const plans = files.map((file) => planE2eFile(file, weights));
    const plannedFiles = plans.map(({ file }) => file);
    expect(plannedFiles).toEqual(files);
    expect(new Set(plannedFiles).size).toBe(files.length);
    expect(plans.filter(({ file }) => file === weightedFile)).toHaveLength(1);
    expect(plans.find(({ file }) => file === weightedFile)?.estimatedSeconds).toBe(123.5);
    for (const entry of plans) {
      const unweighted = planE2eFile(entry.file);
      expect(entry).toEqual({
        ...unweighted,
        estimatedSeconds: entry.file === weightedFile ? 123.5 : unweighted.estimatedSeconds,
      });
      expect(Number.isFinite(entry.estimatedSeconds)).toBe(true);
      expect(entry.estimatedSeconds).toBeGreaterThan(0);
      expect(new Set(entry.resources).size).toBe(entry.resources.length);
      expect(entry.resources.every((resource) => ["bedrock", "kiro", "ide"].includes(resource))).toBe(true);
    }
  });

  test.each([
    ["empty", ""],
    ["whitespace", " \n\t "],
    ["header only", "AI-DLC Test Run Summary\nPer-file results:\n"],
    ["unrelated format", '{"t901-live-sdk.test.ts": 72.5}'],
    ["non-numeric duration", "t-broken FAIL 1 1 unknowns"],
    ["invalid decimal", "t-broken FAIL 1 1 1..2s"],
    ["non-finite duration", "t-broken FAIL 1 1 Infinitys"],
    ["negative duration", "t-broken FAIL 1 1 -2s"],
    ["no positive duration", "t-empty SKIP 0 0 0s"],
  ])("rejects a malformed or unusable summary: %s", (_label, text) => {
    expect(() => readE2eTimings(text)).toThrow("--e2e-timings");
  });

  test("a valid row does not hide a malformed duration in another summary row", () => {
    // Regression expectation: corrupt per-file data should surface an error,
    // not silently discard the row and fall back to an unrelated estimate.
    const text = "t-valid PASS 2 0 4.5s\nt-broken FAIL 2 1 1..2s\n";
    expect(() => readE2eTimings(text)).toThrow("--e2e-timings");
  });
});

const MIXED_CASES = `
  <testsuite name="file" tests="5" failures="2" skipped="1">
    <testsuite name="nested" tests="3" failures="2" skipped="0">
      <testcase name="passes" time="0.1" />
      <testcase name="fails one"><failure type="AssertionError" /></testcase>
      <testcase name="fails two"><failure type="AssertionError">expected true</failure></testcase>
    </testsuite>
    <testcase name="another pass" time="0.2" />
    <testcase name="unavailable live gate"><skipped message="gate unset" /></testcase>
  </testsuite>
`;

describe("E2E case counts", () => {
  test.each([
    ["root totals", `<testsuites tests="5" failures="2" skipped="1">${MIXED_CASES}</testsuites>`],
    ["no root totals", `<testsuites name="bun test">${MIXED_CASES}</testsuites>`],
    ["missing skip total", `<testsuites tests="5" failures="2">${MIXED_CASES}</testsuites>`],
    ["single suite root", MIXED_CASES],
  ])("separates pass, fail, and skip without double-counting nested suites: %s", (_label, xml) => {
    expect(e2eCaseCounts(xml)).toEqual({ total: 5, passed: 2, failed: 2, skipped: 1 });
  });

  test("all skipped cases contribute zero passes even when file-level status would be PASS", () => {
    const xml = `<testsuites tests="2" failures="0" skipped="2">
      <testsuite name="live">
        <testcase name="first"><skipped /></testcase>
        <testcase name="second"><skipped /></testcase>
      </testsuite>
    </testsuites>`;
    expect(e2eCaseCounts(xml)).toEqual({ total: 2, passed: 0, failed: 0, skipped: 2 });
  });

  test("only successful cases count as passes", () => {
    const xml = `<testsuites tests="2" failures="0" skipped="0">
      <testsuite name="deterministic">
        <testcase name="first" />
        <testcase name="second" />
      </testsuite>
    </testsuites>`;
    expect(e2eCaseCounts(xml)).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 });
  });

  test.each([
    ["missing report", ""],
    ["whitespace", " \n\t "],
    ["empty suite", '<testsuites tests="0" failures="0" skipped="0"></testsuites>'],
    ["truncated report before cases", '<?xml version="1.0"?>\n<testsuites'],
    ["collection crash without XML", 'error: Cannot find package "missing-fixture"\n'],
    ["collection crash with an empty report", `<testsuites tests="0" failures="0" skipped="0">
      <testsuite name="collection">
        <system-err>Cannot find package missing-fixture</system-err>
      </testsuite>
    </testsuites>`],
  ])("empty or crashed collection has no fabricated case results: %s", (_label, xml) => {
    expect(e2eCaseCounts(xml)).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
  });
});

// Copied from retained Bun 1.3.14 t112 calibration reports, not reconstructed
// XML shapes. Only the machine-specific hostname is normalized.
// Stamp: 2026-09-16T09-19-40Z-p3277626/t112-calibration/
// Pass/fail: t112-runner-exit-3IOZSV/2026-09-16T09-19-50Z-p3278264/
// Skip: t112-runner-exit-lKNezR/2026-09-16T09-19-57Z-p3279049/
const RETAINED_BUN_PASS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="1" failures="0" skipped="0" time="0.071842299">
  <testsuite name="tests/smoke/t951-pass.test.ts" file="tests/smoke/t951-pass.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="fixture-host">
    <testcase name="seeded pass 1" classname="" time="0.000074" file="tests/smoke/t951-pass.test.ts" line="3" assertions="1" />
  </testsuite>
</testsuites>
`;
const RETAINED_BUN_FAIL = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="1" failures="1" skipped="0" time="0.07208909">
  <testsuite name="tests/smoke/t901-fail.test.ts" file="tests/smoke/t901-fail.test.ts" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="fixture-host">
    <testcase name="seeded failure 1" classname="" time="0.00062" file="tests/smoke/t901-fail.test.ts" line="3" assertions="1">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>
`;
const RETAINED_BUN_SKIP = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="0" failures="0" skipped="1" time="0.076805914">
  <testsuite name="tests/smoke/t971-skip.test.ts" file="tests/smoke/t971-skip.test.ts" tests="1" assertions="0" failures="0" skipped="1" time="0" hostname="fixture-host">
    <testcase name="seeded skip 1" classname="" time="0" file="tests/smoke/t971-skip.test.ts" line="2" assertions="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>
`;

describe("detailed JUnit case identities", () => {
  test.each([
    ["pass", RETAINED_BUN_PASS, "seeded pass 1", "PASS", "tests/smoke/t951-pass.test.ts"],
    ["fail", RETAINED_BUN_FAIL, "seeded failure 1", "FAIL", "tests/smoke/t901-fail.test.ts"],
    ["skip", RETAINED_BUN_SKIP, "seeded skip 1", "SKIP", "tests/smoke/t971-skip.test.ts"],
  ] as const)("retains real Bun %s identity and outcome", (_label, xml, name, outcome, file) => {
    const detailed = readJUnitEvidence(xml);
    expect(detailed.complete).toBe(true);
    if (!detailed.complete) throw new Error(detailed.error);
    expect(detailed.testcases).toEqual([{ classname: "", name, outcome, file }]);
    expect(validateJUnitEvidence(xml)).toEqual({ complete: true, cases: detailed.cases });
  });

  test("decodes identity entities, ignores diagnostic markup, and preserves suite file annotation", () => {
    const xml = `<testsuites tests="2" failures="0" errors="1" skipped="0">
      <testsuite file="tests/identity.test.ts">
        <testcase classname="suite &amp; &quot;quoted&quot;" name="日本語 &#x1f9ea; &#10;"><error><![CDATA[<testcase name="false"/>]]></error></testcase>
        <testcase classname="a different suite" name="日本語 &#x1f9ea; &#10;"/>
      </testsuite>
    </testsuites>`;
    const detailed = readJUnitEvidence(xml);
    expect(detailed.complete).toBe(true);
    if (!detailed.complete) throw new Error(detailed.error);
    expect(detailed.testcases).toEqual([
      { classname: 'suite & "quoted"', name: "日本語 🧪 \n", outcome: "FAIL", file: "tests/identity.test.ts" },
      { classname: "a different suite", name: "日本語 🧪 \n", outcome: "PASS", file: "tests/identity.test.ts" },
    ]);
    expect(detailed.cases).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
  });

  test("duplicate identities cannot satisfy a matrix while the legacy count API remains unchanged", () => {
    const xml = '<testsuites tests="2" failures="0" skipped="0"><testsuite><testcase name="same"/><testcase name="same"/></testsuite></testsuites>';
    expect(validateJUnitEvidence(xml)).toEqual({ complete: true, cases: { total: 2, passed: 2, failed: 0, skipped: 0 } });
    expect(readJUnitEvidence(xml)).toMatchObject({ complete: false, error: expect.stringContaining("duplicate testcase identity") });
  });

  test("empty or truncated identity evidence fails closed", () => {
    expect(readJUnitEvidence(RETAINED_BUN_PASS.replace('name="seeded pass 1"', 'name=""')).complete).toBe(false);
    expect(readJUnitEvidence(RETAINED_BUN_PASS.slice(0, -20)).complete).toBe(false);
  });
});

describe("complete JUnit evidence", () => {
  test.each([
    ["retained passing report", RETAINED_BUN_PASS, { total: 1, passed: 1, failed: 0, skipped: 0 }],
    ["retained failing report", RETAINED_BUN_FAIL, { total: 1, passed: 0, failed: 1, skipped: 0 }],
    ["retained skipped report", RETAINED_BUN_SKIP, { total: 1, passed: 0, failed: 0, skipped: 1 }],
    ["nested mixed outcomes", `<testsuites tests="5" failures="2" skipped="1">${MIXED_CASES}</testsuites>`,
      { total: 5, passed: 2, failed: 2, skipped: 1 }],
    ["single suite root", MIXED_CASES, { total: 5, passed: 2, failed: 2, skipped: 1 }],
  ])("validates %s without mistaking report integrity for passing coverage", (_label, xml, cases) => {
    expect(validateJUnitEvidence(xml)).toEqual({ complete: true, cases });
    expect(e2eCaseCounts(xml)).toEqual(cases);
  });

  test("entity quoting, CRLF, BOM and XML diagnostics preserve the observed case counts", () => {
    const xml = `\ufeff<?xml version = '1.0' encoding = 'UTF-8' standalone = 'yes'?>
<!-- <testcase name="not a case"/> -->
<testsuites tests='2' failures='1' skipped='0'>
  <testsuite tests='2' failures='1' skipped='0'>
    <properties><property name='note' value='&lt;testcase/&gt; &amp; &quot; &#x1f9ea;'/></properties>
    &#32;<testcase name='&apos;valid &gt; case &#49;'><failure message="expected &lt;actual&gt;"><![CDATA[<testcase/><skipped/> & raw text]]></failure></testcase>
    <?report diagnostic?>
    <testcase name='日本語'><system-out>escaped &lt;failure/&gt;</system-out></testcase>
    <system-err><![CDATA[</testsuite><testcase name="not a case"/>]]></system-err>
  </testsuite>
</testsuites><!-- trailing comment -->`;
    expect(validateJUnitEvidence(xml.replaceAll("\n", "\r\n"))).toEqual({
      complete: true, cases: { total: 2, passed: 1, failed: 1, skipped: 0 },
    });
  });

  test("an error outcome is counted as a failed case and reconciled separately from assertions", () => {
    const xml = `<testsuites tests="1" failures="0" errors="1" skipped="0">
      <testsuite tests="1" failures="0" errors="1" skipped="0">
        <testcase name="setup failure"><error type="Error">setup failed</error></testcase>
      </testsuite>
    </testsuites>`;
    expect(validateJUnitEvidence(xml)).toEqual({
      complete: true, cases: { total: 1, passed: 0, failed: 1, skipped: 0 },
    });
    expect(validateJUnitEvidence(xml.replace(' errors="1"', ""))).toMatchObject({ complete: false });
  });

  test("every prefix of the retained failed document stays incomplete until the root closes", () => {
    const closedAt = RETAINED_BUN_FAIL.indexOf("</testsuites>") + "</testsuites>".length;
    for (let end = 0; end < closedAt; end++) {
      const evidence = validateJUnitEvidence(RETAINED_BUN_FAIL.slice(0, end));
      expect(evidence.complete, `truncation at character ${end}`).toBe(false);
    }
    expect(validateJUnitEvidence(RETAINED_BUN_FAIL.slice(0, closedAt)).complete).toBe(true);
  });

  test.each([
    ["no document", ""],
    ["empty but closed report", '<testsuites tests="0" failures="0" skipped="0"/>'],
    ["truncated positive header", '<testsuites tests="1" failures="0" skipped="0">'],
    ["closed positive header without cases", '<testsuites tests="1" failures="0" skipped="0"/>'],
    ["case removed", RETAINED_BUN_PASS.replace(/ {4}<testcase[^\n]+\n/, "")],
    ["missing root total", RETAINED_BUN_PASS.replace(' tests="1"', "")],
    ["missing root skip total", RETAINED_BUN_PASS.replace(' skipped="0"', "")],
    ["wrong root total", RETAINED_BUN_PASS.replace(' tests="1"', ' tests="2"')],
    ["wrong nested suite total", RETAINED_BUN_PASS.replace('tests="1" assertions="1" failures="0" skipped="0" time="0"', 'tests="2" assertions="1" failures="0" skipped="0" time="0"')],
    ["unaccounted failure", RETAINED_BUN_FAIL.replace(' failures="1"', ' failures="0"')],
    ["unaccounted skip", RETAINED_BUN_SKIP.replace(' skipped="1"', ' skipped="0"')],
    ["contradictory case outcomes", RETAINED_BUN_FAIL.replace('<failure type="AssertionError" />', '<failure/><skipped/>')],
    ["duplicate failure outcome", RETAINED_BUN_FAIL.replace('<failure type="AssertionError" />', '<failure/><failure/>')],
    ["misplaced case", '<testsuites tests="1" failures="0" skipped="0"><testcase name="x"/></testsuites>'],
    ["case hidden in a diagnostic", RETAINED_BUN_FAIL.replace('<failure type="AssertionError" />', '<failure><testcase name="x"/></failure>')],
    ["comment cannot supply a case", RETAINED_BUN_PASS.replace(/(<testcase[^>]+\/>)/, "<!-- $1 -->")],
    ["missing case name", RETAINED_BUN_PASS.replace(' name="seeded pass 1"', "")],
    ["mismatched nesting", RETAINED_BUN_PASS.replace("</testsuite>", "</testcase>")],
    ["duplicate attribute", RETAINED_BUN_PASS.replace('tests="1"', 'tests="1" tests="1"')],
    ["unquoted attribute", RETAINED_BUN_PASS.replace('tests="1"', "tests=1")],
    ["unseparated attribute", RETAINED_BUN_PASS.replace('tests="1" assertions=', 'tests="1"assertions=')],
    ["extra root", RETAINED_BUN_PASS + RETAINED_BUN_PASS],
    ["trailing text", `${RETAINED_BUN_PASS}unexpected`],
    ["root declared twice", RETAINED_BUN_PASS.replace("</testsuites>", "<?xml version='1.0'?></testsuites>")],
    ["raw attribute markup", RETAINED_BUN_PASS.replace("seeded pass 1", "seeded <pass>")],
    ["undefined entity", RETAINED_BUN_PASS.replace("seeded pass 1", "&unknown;")],
    ["unterminated entity", RETAINED_BUN_PASS.replace("seeded pass 1", "&amp")],
    ["invalid numeric reference", RETAINED_BUN_PASS.replace("seeded pass 1", "&#0;")],
    ["surrogate reference", RETAINED_BUN_PASS.replace("seeded pass 1", "&#xD800;")],
    ["out of range reference", RETAINED_BUN_PASS.replace("seeded pass 1", "&#x110000;")],
    ["invalid raw character", RETAINED_BUN_PASS.replace("seeded pass 1", "seeded\u0000pass")],
    ["unpaired surrogate", RETAINED_BUN_PASS.replace("seeded pass 1", "\ud800")],
    ["invalid comment", `${RETAINED_BUN_PASS}<!-- two--dashes -->`],
    ["unfinished comment", `${RETAINED_BUN_PASS}<!--`],
    ["unfinished instruction", `${RETAINED_BUN_PASS}<?diagnostic`],
    ["unfinished CDATA", RETAINED_BUN_FAIL.replace('<failure type="AssertionError" />', "<failure><![CDATA[unfinished</failure>")],
    ["DTD", RETAINED_BUN_PASS.replace("<testsuites", '<!DOCTYPE testsuites SYSTEM "file:///unused"><testsuites')],
    ["namespace", RETAINED_BUN_PASS.replace("<testsuites", '<testsuites xmlns="urn:unrecognized"')],
  ])("rejects incomplete, malformed, or inconsistent evidence: %s", (_label, xml) => {
    const evidence = validateJUnitEvidence(xml);
    expect(evidence.complete).toBe(false);
    if (!evidence.complete) expect(evidence.error).toStartWith("Invalid JUnit evidence:");
  });

  test.each(["-1", "+1", "1.0", "1e0", "NaN", "Infinity", "9007199254740992", " 1", ""])(
    "rejects a malformed count instead of repairing it: %s",
    (count) => {
      expect(validateJUnitEvidence(RETAINED_BUN_PASS.replace('tests="1"', `tests="${count}"`)).complete).toBe(false);
      expect(validateJUnitEvidence(RETAINED_BUN_PASS.replace('failures="0"', `failures="${count}"`)).complete).toBe(false);
    },
  );

  test("the legacy reader still supplies diagnostic totals for incomplete evidence", () => {
    const truncated = '<testsuites tests="1" failures="0" skipped="0">';
    expect(e2eCaseCounts(truncated)).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(validateJUnitEvidence(truncated).complete).toBe(false);
  });
});
