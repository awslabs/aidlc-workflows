// covers: function:buildTagString, function:buildMagnitudeLines, function:metricPrefix
//
// t268 - metrics magnitude lines (aidlc-metrics.ts). The metrics helper runs
// UNDER the audit lock, so every unit here is pure string work: no transcript
// I/O, no ledger read, no network. We assert:
//   (1) buildTagString produces the exact comma-joined tag body the counter line
//       has always used - the regression that guards the refactor.
//   (2) buildMagnitudeLines turns a STAGE_COMPLETED usage rollup into the
//       expected token counters + cost gauge + per-model / per-agent variants,
//       under a configurable metric-name prefix.
//   (3) an event WITHOUT usage fields emits NO magnitude lines ([]).
//   (4) metricPrefix honours AIDLC_METRICS_PREFIX with a default of "aidlc".
//   (5) the metrics transport has no built-in collector destination; the
//       endpoint comes only from AIDLC_METRICS_ENDPOINT at runtime.
//
// MECHANISM: none. Pure functions imported in-process from the shipped dist
// tree; deterministic, zero tokens, zero network.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildMagnitudeLines,
  buildTagString,
  metricPrefix,
  type MetricContext,
} from "../../dist/claude/.claude/tools/aidlc-metrics.ts";
import { AIDLC_VERSION } from "../../dist/claude/.claude/tools/aidlc-version.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function filesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

afterEach(() => {
  delete process.env.AIDLC_METRICS_PREFIX;
});

function ctx(overrides: Partial<MetricContext> = {}): MetricContext {
  return {
    env: "dev",
    space: "default",
    scope: null,
    stage: null,
    phase: null,
    user: "tester",
    host: "box",
    harness: "claude",
    ...overrides,
  };
}

describe("metricPrefix - configurable namespace with an aidlc default", () => {
  test("defaults to 'aidlc' when unset", () => {
    delete process.env.AIDLC_METRICS_PREFIX;
    expect(metricPrefix()).toBe("aidlc");
  });
  test("honours AIDLC_METRICS_PREFIX", () => {
    process.env.AIDLC_METRICS_PREFIX = "myorg.aidlc";
    expect(metricPrefix()).toBe("myorg.aidlc");
  });
  test("empty/whitespace override falls back to 'aidlc'", () => {
    process.env.AIDLC_METRICS_PREFIX = "   ";
    expect(metricPrefix()).toBe("aidlc");
  });
  test("sanitises a StatsD-unsafe prefix", () => {
    process.env.AIDLC_METRICS_PREFIX = "a b:c,d";
    expect(metricPrefix()).toBe("a_b_c_d");
  });
});

describe("buildTagString (counter-line regression)", () => {
  test("produces the historical inlined tag body byte-for-byte", () => {
    const c = ctx({ scope: "feature", stage: "code-generation", phase: "CONSTRUCTION" });
    const expected = [
      "service:aidlc",
      "env:dev",
      `version:${AIDLC_VERSION}`,
      "space:default",
      "harness:claude",
      "user:tester",
      "host:box",
      "scope:feature",
      "stage:code-generation",
      "phase:CONSTRUCTION",
    ].join(",");
    expect(buildTagString(c)).toBe(expected);
    // Full counter line, unchanged shape under the default prefix.
    expect(`aidlc.stage_completed:1|c|#${buildTagString(c)}`).toBe(
      `aidlc.stage_completed:1|c|#${expected}`,
    );
  });

  test("optional scope/stage/phase omitted when absent (order preserved)", () => {
    expect(buildTagString(ctx())).toBe(
      [
        "service:aidlc",
        "env:dev",
        `version:${AIDLC_VERSION}`,
        "space:default",
        "harness:claude",
        "user:tester",
        "host:box",
      ].join(","),
    );
  });

  test("reserved characters in tag values are sanitised", () => {
    const c = ctx({ space: "a b:c,d" });
    expect(buildTagString(c)).toContain("space:a_b_c_d");
  });
});

describe("metrics destination configuration", () => {
  test("has no built-in collector URL and reads the destination only from the environment", () => {
    const source = readFileSync(
      join(REPO_ROOT, "core", "tools", "aidlc-metrics.ts"),
      "utf-8",
    );

    expect(source).not.toMatch(/https?:\/\//i);
    expect(source).toMatch(
      /const metricsEndpoint = process\.env\.AIDLC_METRICS_ENDPOINT;\s+if \(!metricsEndpoint\) return;/,
    );
    expect(source).toContain('postMetric(metricsEndpoint, lines.join("\\n"));');
    expect(source.match(/^\s*postMetric\(/gm)?.length).toBe(1);
  });

  test("ships no metrics endpoint in any authored harness surface", () => {
    const configuredFiles = filesUnder(join(REPO_ROOT, "harness")).filter((path) =>
      readFileSync(path, "utf-8").includes("AIDLC_METRICS_ENDPOINT"),
    );
    expect(configuredFiles).toEqual([]);
  });
});

describe("buildMagnitudeLines", () => {
  const tags = buildTagString(ctx({ stage: "code-generation" }));
  const PREFIX = "aidlc";

  test("STAGE_COMPLETED with usage => token counters + cost gauge + variants", () => {
    const fields = {
      "Tokens In": "12000",
      "Tokens Out": "3400",
      "Cache Read": "500",
      "Cache Write": "700",
      "Cost USD": "1.68",
      "By Model": "opus-4-8=1.23; sonnet-4-6=0.45",
      "By Agent": "main=1.10; general-purpose=0.58",
    };
    const lines = buildMagnitudeLines("STAGE_COMPLETED", fields, tags, PREFIX);

    expect(lines).toContain(`aidlc.tokens.input:12000|c|#${tags}`);
    expect(lines).toContain(`aidlc.tokens.output:3400|c|#${tags}`);
    expect(lines).toContain(`aidlc.cache.read:500|c|#${tags}`);
    expect(lines).toContain(`aidlc.cache.write:700|c|#${tags}`);
    expect(lines).toContain(`aidlc.cost.usd:1.68|g|#${tags}`);

    // Per-model cost gauges carry an extra model: tag.
    expect(lines).toContain(`aidlc.cost.usd:1.23|g|#${tags},model:opus-4-8`);
    expect(lines).toContain(`aidlc.cost.usd:0.45|g|#${tags},model:sonnet-4-6`);

    // Per-agent cost gauges carry an extra agent: tag.
    expect(lines).toContain(`aidlc.cost.usd:1.1|g|#${tags},agent:main`);
    expect(lines).toContain(`aidlc.cost.usd:0.58|g|#${tags},agent:general-purpose`);

    // Exactly the nine lines above - no extras.
    expect(lines.length).toBe(9);
  });

  test("a custom prefix is applied to every line", () => {
    const fields = { "Tokens In": "5", "By Model": "opus-4-8=1.00" };
    const lines = buildMagnitudeLines("STAGE_COMPLETED", fields, tags, "myorg.aidlc");
    expect(lines).toContain(`myorg.aidlc.tokens.input:5|c|#${tags}`);
    expect(lines).toContain(`myorg.aidlc.cost.usd:1|g|#${tags},model:opus-4-8`);
    expect(lines.every((l) => l.startsWith("myorg.aidlc."))).toBe(true);
  });

  test("unknown-model stage (tokens, no Cost USD/By Model) => token lines only, no cost", () => {
    const fields = {
      "Tokens In": "500",
      "Tokens Out": "700",
      "Cache Read": "0",
      "Cache Write": "0",
    };
    const lines = buildMagnitudeLines("STAGE_COMPLETED", fields, tags, PREFIX);
    expect(lines).toContain(`aidlc.tokens.input:500|c|#${tags}`);
    expect(lines).toContain(`aidlc.tokens.output:700|c|#${tags}`);
    expect(lines).toContain(`aidlc.cache.read:0|c|#${tags}`);
    // A zero Cache Write still emits a counter (0 is a real value, not absent).
    expect(lines).toContain(`aidlc.cache.write:0|c|#${tags}`);
    expect(lines.some((l) => l.startsWith("aidlc.cost.usd"))).toBe(false);
    expect(lines.length).toBe(4);
  });

  test("Cost USD literal 'null' (unpriceable) => still emits token lines, no cost gauge", () => {
    const fields = {
      "Tokens In": "500",
      "Tokens Out": "700",
      "Cache Read": "0",
      "Cost USD": "null",
      "By Model": "gpt-4o=null",
    };
    const lines = buildMagnitudeLines("STAGE_COMPLETED", fields, tags, PREFIX);
    expect(lines).toContain(`aidlc.tokens.input:500|c|#${tags}`);
    // The `=null` breakdown segment is skipped - no fabricated cost gauge.
    expect(lines.some((l) => l.startsWith("aidlc.cost.usd"))).toBe(false);
    expect(lines.length).toBe(3);
  });

  test("Tokens By Model / By Agent => per-dimension token counters", () => {
    const fields = {
      "Tokens In": "16000",
      "Tokens Out": "5000",
      "Cache Read": "2000",
      "Cache Write": "80000",
      "Tokens By Model": "opus-4-8=12.3k/4.1k/2k/79.6k; sonnet-4-6=3.7k/900/0/0",
      "Tokens By Agent": "main=12.3k/4.1k/2k/79.6k; aidlc-developer-agent=3.7k/900/0/0",
    };
    const lines = buildMagnitudeLines("STAGE_COMPLETED", fields, tags, PREFIX);
    expect(lines).toContain(`aidlc.tokens.input:12300|c|#${tags},model:opus-4-8`);
    expect(lines).toContain(`aidlc.tokens.output:4100|c|#${tags},model:opus-4-8`);
    expect(lines).toContain(`aidlc.cache.read:2000|c|#${tags},model:opus-4-8`);
    expect(lines).toContain(`aidlc.cache.write:79600|c|#${tags},model:opus-4-8`);
    expect(lines).toContain(`aidlc.tokens.input:3700|c|#${tags},model:sonnet-4-6`);
    expect(lines).toContain(`aidlc.cache.read:0|c|#${tags},model:sonnet-4-6`);
    expect(lines).toContain(`aidlc.cache.write:0|c|#${tags},model:sonnet-4-6`);
    expect(lines).toContain(`aidlc.tokens.input:12300|c|#${tags},agent:main`);
    expect(lines).toContain(`aidlc.cache.write:79600|c|#${tags},agent:main`);
    expect(lines).toContain(
      `aidlc.tokens.output:900|c|#${tags},agent:aidlc-developer-agent`,
    );
    // 4 aggregate + 8 per-model (4x2) + 8 per-agent (4x2) = 20 lines.
    expect(lines.length).toBe(20);
  });

  test("legacy 3-part triple still parses (cacheWrite defaults to 0)", () => {
    const fields = {
      "Tokens In": "12000",
      "Tokens By Model": "opus-4-8=12.3k/4.1k/2k",
    };
    const lines = buildMagnitudeLines("STAGE_COMPLETED", fields, tags, PREFIX);
    expect(lines).toContain(`aidlc.tokens.input:12300|c|#${tags},model:opus-4-8`);
    expect(lines).toContain(`aidlc.tokens.output:4100|c|#${tags},model:opus-4-8`);
    expect(lines).toContain(`aidlc.cache.read:2000|c|#${tags},model:opus-4-8`);
    expect(lines).toContain(`aidlc.cache.write:0|c|#${tags},model:opus-4-8`);
    // 1 aggregate (Tokens In only) + 4 per-model = 5 lines.
    expect(lines.length).toBe(5);
  });

  test("event WITHOUT usage fields => [] (ordinary events keep only their counter)", () => {
    expect(buildMagnitudeLines("STAGE_STARTED", { Stage: "x", Phase: "y" }, tags, PREFIX)).toEqual([]);
    expect(buildMagnitudeLines("SESSION_STARTED", {}, tags, PREFIX)).toEqual([]);
  });

  test("malformed breakdown segments are skipped, not thrown", () => {
    const fields = {
      "Tokens In": "1",
      "By Model": "opus-4-8=1.23; garbage; =0.5; sonnet-4-6=notanumber",
    };
    const lines = buildMagnitudeLines("WORKFLOW_COMPLETED", fields, tags, PREFIX);
    expect(lines).toContain(`aidlc.cost.usd:1.23|g|#${tags},model:opus-4-8`);
    // Only the one well-formed model segment survives.
    expect(lines.filter((l) => l.includes("model:")).length).toBe(1);
  });
});
