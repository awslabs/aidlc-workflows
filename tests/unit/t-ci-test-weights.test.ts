// covers: file:scripts/ci-test-weights.ts, file:tests/lib/test-sharding.ts
//
// CI test weights balance unit shards and order integration files. They only
// change how long CI takes: refresh measures them from CI evidence, and the
// report warns about stale ones without ever failing a job.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRIFT_RATIO, DRIFT_SECONDS, INTEGRATION_WEIGHTS, integrationNames, refreshWeights, reportDrift, slowestOsWeights, weightDrift,
} from "../../scripts/ci-test-weights.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  orderLongestFirst, parseOrderWeights, readSummaryRows, type ShardConfig, validateShardConfig,
} from "../lib/test-sharding.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-test-weights-"));
  roots.push(root);
  return root;
}
function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function summary(rows: Array<[string, string, number]>): string {
  return [
    "AI-DLC Test Run Summary", "", "Per-file results:",
    `  ${"File".padEnd(40)} Status Assertions     Failed   Duration`,
    ...rows.map(([name, status, seconds]) => `  ${name.padEnd(40)} ${status.padEnd(6)} ${"3".padStart(10)} ${"0".padStart(10)} ${`${seconds}s`.padStart(10)}`),
    "", "Totals:", "  Result: PASS", "",
  ].join("\n");
}
/** One downloaded CI artifact, laid out the way deterministic-tests.yml uploads it. */
function artifact(root: string, name: string, rows: Array<[string, string, number]>, windowsStamp = false): void {
  const stamp = "2026-10-03T08-57-43Z-p3576";
  const recorded = windowsStamp ? `D:\\a\\repo\\repo\\tests\\logs\\${stamp}` : `/home/runner/work/repo/tests/logs/${stamp}`;
  write(join(root, name, "tmp", "ci-deterministic", "stamp.txt"), `${recorded}\n`);
  write(join(root, name, "tests", "logs", stamp, "summary.txt"), summary(rows));
}

describe("summary rows and longest-first order", () => {
  test("reads every per-file row with its status and raw duration", () => {
    expect(readSummaryRows(summary([["t08", "PASS", 1.5], ["t-live", "SKIP", 0], ["t09", "FAIL", 22.25]]))).toEqual([
      { name: "t08", status: "PASS", seconds: 1.5, duration: "1.5" },
      { name: "t-live", status: "SKIP", seconds: 0, duration: "0" },
      { name: "t09", status: "FAIL", seconds: 22.25, duration: "22.25" },
    ]);
    expect(readSummaryRows("t-broken FAIL 1 1 1..2s")[0].seconds).toBeNaN();
  });

  test("starts the longest file first; unweighted files take the default and ties keep name order", () => {
    const config = { defaultSeconds: 1, weights: { b: 30, d: 0.5, e: 30 } };
    expect(orderLongestFirst(["a", "b", "c", "d", "e"], (name) => name, config)).toEqual(["b", "e", "a", "c", "d"]);
    expect(orderLongestFirst([], (name: string) => name, config)).toEqual([]);
  });

  test.each([
    ["not JSON", "{"],
    ["null", "null"],
    ["no default", '{"weights":{}}'],
    ["zero default", '{"defaultSeconds":0,"weights":{}}'],
    ["no weights", '{"defaultSeconds":1}'],
    ["negative weight", '{"defaultSeconds":1,"weights":{"a":-1}}'],
    ["text weight", '{"defaultSeconds":1,"weights":{"a":"5"}}'],
  ])("an unusable order-weights file means name order: %s", (_label, text) => {
    expect(parseOrderWeights(text)).toBeUndefined();
  });

  test("the checked-in integration weights parse and name only current integration files", () => {
    const config = parseOrderWeights(readFileSync(join(REPO_ROOT, INTEGRATION_WEIGHTS), "utf8"));
    expect(config).toBeDefined();
    const names = new Set(integrationNames(REPO_ROOT));
    expect(Object.keys(config!.weights).filter((name) => !names.has(name))).toEqual([]);
    expect(Object.keys(config!.weights).length).toBeGreaterThan(0);
  });

  test("the checked-in unit weights name only current unit files and keep the compiled affinity", () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, "tests/unit-shard-weights.json"), "utf8")) as ShardConfig;
    const unit = readdirSync(join(REPO_ROOT, "tests/unit")).filter((file) => file.endsWith(".test.ts"));
    expect(() => validateShardConfig(unit, config)).not.toThrow();
    expect(config.affinityGroups).toContainEqual(["t238-build-binaries.test.ts", "t249-copilot-adapter.test.ts"]);
  });
});

describe("refresh", () => {
  function repo(): string {
    const root = tempRoot();
    for (const file of ["t-a.test.ts", "t-b.test.ts", "t-c.test.ts", "t-new.test.ts"]) write(join(root, "tests", "unit", file), "");
    for (const file of ["t-x.test.ts", "t-y.serial.test.ts"]) write(join(root, "tests", "integration", file), "");
    write(join(root, "plugins", "kit", "tests", "plugin.test.ts"), "");
    write(join(root, "tests", "unit-shard-weights.json"), `${JSON.stringify({
      defaultSeconds: 1,
      weights: { "t-a.test.ts": 5, "t-c.test.ts": 40, "t-gone.test.ts": 9 },
      affinityGroups: [["t-a.test.ts", "t-b.test.ts"]],
    })}\n`);
    return root;
  }

  test("weighs each file at the median of its slowest OS and keeps what it did not measure", () => {
    const root = repo();
    const evidence = join(tempRoot(), "runs");
    // Two runs; Windows is slowest for t-a, macOS for t-b. FAIL and SKIP rows are not measurements.
    artifact(join(evidence, "1"), "ci-deterministic-unit-1-Windows", [["t-a", "PASS", 100], ["t-b", "PASS", 2], ["t-c", "FAIL", 999]], true);
    artifact(join(evidence, "2"), "ci-deterministic-unit-1-Windows", [["t-a", "PASS", 120], ["t-b", "PASS", 4]], true);
    artifact(join(evidence, "1"), "ci-deterministic-unit-7-macOS", [["t-a", "PASS", 30], ["t-b", "PASS", 10.04]]);
    artifact(join(evidence, "1"), "ci-deterministic-integration-Linux", [
      ["t-x", "PASS", 300], ["t-y.serial", "PASS", 20], ["plugin-kit-plugin", "PASS", 0.01], ["t-live", "SKIP", 0],
    ]);
    // Smoke and e2e evidence never feeds unit or integration weights.
    artifact(join(evidence, "1"), "ci-deterministic-e2e-Linux", [["t-a", "PASS", 5000]]);

    expect(refreshWeights(evidence, root)).toEqual({ unit: 3, integration: 3 });
    const unit = JSON.parse(readFileSync(join(root, "tests", "unit-shard-weights.json"), "utf8")) as ShardConfig;
    expect(unit).toEqual({
      defaultSeconds: 1,
      // t-a: Windows median 110 beats macOS 30; t-b: macOS 10.04 rounds to 10;
      // t-c keeps its old weight (its only row failed); t-gone is dropped; t-new stays unweighted.
      weights: { "t-a.test.ts": 110, "t-b.test.ts": 10, "t-c.test.ts": 40 },
      affinityGroups: [["t-a.test.ts", "t-b.test.ts"]],
    });
    const integration = JSON.parse(readFileSync(join(root, INTEGRATION_WEIGHTS), "utf8"));
    expect(integration).toEqual({
      defaultSeconds: 1,
      weights: { "plugin-kit-plugin": 0.1, "t-x": 300, "t-y.serial": 20 },
    });
    expect(Object.keys(unit.weights)).toEqual([...Object.keys(unit.weights)].sort());
  });

  test("refuses evidence with no unit or integration summary and leaves the weights alone", () => {
    const root = repo();
    const before = readFileSync(join(root, "tests", "unit-shard-weights.json"), "utf8");
    const evidence = tempRoot();
    artifact(evidence, "ci-deterministic-smoke-Linux", [["t-a", "PASS", 5]]);
    expect(() => refreshWeights(evidence, root)).toThrow("no deterministic unit or integration evidence");
    expect(readFileSync(join(root, "tests", "unit-shard-weights.json"), "utf8")).toBe(before);
  });

  test("slowest-OS weights never round down to zero", () => {
    expect(slowestOsWeights(new Map([["t", new Map([["Linux", [0.01, 0.02, 0.03]]])]]))).toEqual({ t: 0.1 });
  });
});

describe("report", () => {
  const config = { defaultSeconds: 1, weights: { "t-ok.test.ts": 100, "t-grown.test.ts": 100, "t-noisy.test.ts": 200 } };

  test("flags a file only when it ran both a minute and half again past its weight", () => {
    expect(DRIFT_SECONDS).toBe(60);
    expect(DRIFT_RATIO).toBe(1.5);
    const text = summary([
      ["t-ok", "PASS", 140], // 40 s over: within noise
      ["t-noisy", "PASS", 290], // 90 s over but under 1.5x
      ["t-grown", "FAIL", 400], // a slow failure still shows the weight is stale
      ["t-new", "PASS", 75], // unweighted: the 1 s default
      ["t-small", "PASS", 50], // unweighted but under a minute
      ["t-live", "SKIP", 900],
    ]);
    expect(weightDrift(text, "unit", config)).toEqual([
      { name: "t-grown", seconds: 400, weight: 100 },
      { name: "t-new", seconds: 75, weight: 1 },
    ]);
    // Integration weights are keyed by the summary row name itself.
    expect(weightDrift(summary([["t-x", "PASS", 500]]), "integration", { defaultSeconds: 1, weights: { "t-x": 400 } })).toEqual([]);
  });

  function stampRepo(rows: Array<[string, string, number]>): { root: string; stamp: string } {
    const root = tempRoot();
    write(join(root, "tests", "unit-shard-weights.json"), JSON.stringify(config));
    write(join(root, "tests", "logs", "2026-10-03T00-00-00Z-p1", "summary.txt"), summary(rows));
    // A Windows runner records a drive path; the report finds the same stamp under tests/logs.
    write(join(root, "tmp", "stamp.txt"), "D:\\a\\repo\\repo\\tests\\logs\\2026-10-03T00-00-00Z-p1\r\n");
    return { root, stamp: join(root, "tmp", "stamp.txt") };
  }

  test("writes one warning per stale file and a step summary naming the refresh command", () => {
    const { root, stamp } = stampRepo([["t-grown", "PASS", 400], ["t-ok", "PASS", 101]]);
    const stepSummary = join(root, "step-summary.md");
    const lines = reportDrift("unit", stamp, { RUNNER_OS: "Windows", GITHUB_STEP_SUMMARY: stepSummary }, root);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("::warning title=Test weight out of date::t-grown took 400s on Windows but is weighted 100s");
    expect(lines[0]).toContain("bun scripts/ci-test-weights.ts refresh");
    const table = readFileSync(stepSummary, "utf8");
    expect(table).toContain("| t-grown | 400s | 100s |");
    expect(table).toContain("Nothing failed.");
  });

  test("a clean run says so and writes no step summary", () => {
    const { root, stamp } = stampRepo([["t-ok", "PASS", 101]]);
    const stepSummary = join(root, "step-summary.md");
    expect(reportDrift("unit", stamp, { RUNNER_OS: "Linux", GITHUB_STEP_SUMMARY: stepSummary }, root))
      .toEqual(["Test weights: every unit file ran within its weight on Linux."]);
    expect(() => readFileSync(stepSummary)).toThrow();
  });

  test("never throws: a missing summary or unreadable weights only skip the check", () => {
    const missing = tempRoot();
    expect(reportDrift("unit", join(missing, "absent.txt"), {}, missing)).toEqual(["Test weights: no unit summary to check."]);
    const { root, stamp } = stampRepo([["t-grown", "PASS", 400]]);
    write(join(root, "tests", "unit-shard-weights.json"), "{");
    const lines = reportDrift("unit", stamp, {}, root);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("Test weights: check skipped (");
  });

  test("a name cannot break out of the warning command", () => {
    const { root, stamp } = stampRepo([["t-%0A::error::x", "PASS", 400]]);
    const [line] = reportDrift("unit", stamp, { RUNNER_OS: "Linux" }, root);
    expect(line).toContain("t-%250A::error::x");
    expect(line.split("\n")).toHaveLength(1);
  });
});
