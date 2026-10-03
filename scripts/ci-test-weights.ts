// Test-duration weights for CI scheduling. Weights only balance unit shards and
// order integration files; they never select, skip, or fail a test.
//
//   refresh <evidence-dir>       rewrite the checked-in weights from downloaded
//                                deterministic CI evidence (each file at its
//                                slowest OS)
//   report <tier> <stamp-file>   warn about files that outgrew their weight;
//                                always exits 0, because a stale weight only
//                                makes CI slower
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type OrderWeights, readSummaryRows, type ShardConfig, validateShardConfig,
} from "../tests/lib/test-sharding.ts";

const REPO_ROOT = join(import.meta.dir, "..");
export const UNIT_WEIGHTS = "tests/unit-shard-weights.json";
export const INTEGRATION_WEIGHTS = "tests/integration-weights.json";
/** A file over its weight by both margins is worth a refresh; single runs vary up to 2x. */
export const DRIFT_SECONDS = 60;
export const DRIFT_RATIO = 1.5;
export const REFRESH_HINT =
  "gh run download <green merge-group run id> -p 'ci-deterministic-*' -D <dir>, then bun scripts/ci-test-weights.ts refresh <dir>";

export type WeightTier = "unit" | "integration";
const ARTIFACT = /^(?:ci|full-suite)-deterministic-(unit-\d+|integration)-(Linux|macOS|Windows)$/;

/** tier -> name -> OS -> passing durations in seconds */
export type Samples = Record<WeightTier, Map<string, Map<string, number[]>>>;

/** The summary a deterministic job wrote, located through its recorded stamp. */
export function summaryFromStamp(stampFile: string, logsRoot: string): string | undefined {
  if (!existsSync(stampFile)) return undefined;
  const stamp = readFileSync(stampFile, "utf8").trim();
  if (!stamp) return undefined;
  for (const dir of [stamp, join(logsRoot, stamp.split(/[\\/]/).pop()!)]) {
    const summary = join(dir, "summary.txt");
    if (existsSync(summary)) return summary;
  }
  return undefined;
}

function artifactDirs(root: string, depth = 2): Array<{ dir: string; tier: WeightTier; os: string }> {
  const found: Array<{ dir: string; tier: WeightTier; os: string }> = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const match = ARTIFACT.exec(name);
    if (match) found.push({ dir, tier: match[1] === "integration" ? "integration" : "unit", os: match[2] });
    else if (depth > 0) found.push(...artifactDirs(dir, depth - 1));
  }
  return found;
}

/** Passing per-file durations from every deterministic artifact under root. */
export function collectSamples(root: string): Samples {
  const samples: Samples = { unit: new Map(), integration: new Map() };
  for (const { dir, tier, os } of artifactDirs(root)) {
    const summary = summaryFromStamp(join(dir, "tmp", "ci-deterministic", "stamp.txt"), join(dir, "tests", "logs"));
    if (!summary) {
      process.stderr.write(`skipped ${basename(dir)}: no summary.txt\n`);
      continue;
    }
    for (const row of readSummaryRows(readFileSync(summary, "utf8"))) {
      if (row.status !== "PASS" || !Number.isFinite(row.seconds)) continue;
      const byOs = samples[tier].get(row.name) ?? new Map<string, number[]>();
      byOs.set(os, [...(byOs.get(os) ?? []), row.seconds]);
      samples[tier].set(row.name, byOs);
    }
  }
  return samples;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Each file's median on each OS, then its slowest OS, to a tenth of a second. */
export function slowestOsWeights(samples: Map<string, Map<string, number[]>>): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const [name, byOs] of samples) {
    const slowest = Math.max(...[...byOs.values()].map(median));
    weights[name] = Math.max(0.1, Math.round(slowest * 10) / 10);
  }
  return weights;
}

/** Result-row names of the current integration tier, as summaries print them. */
export function integrationNames(repoRoot: string): string[] {
  const names = readdirSync(join(repoRoot, "tests", "integration"))
    .filter((file) => file.endsWith(".test.ts")).map((file) => file.replace(/\.test\.ts$/, ""));
  const plugins = join(repoRoot, "plugins");
  for (const plugin of existsSync(plugins) ? readdirSync(plugins) : []) {
    const tests = join(plugins, plugin, "tests");
    if (!existsSync(tests)) continue;
    for (const file of readdirSync(tests).filter((entry) => entry.endsWith(".test.ts"))) {
      names.push(`plugin-${plugin}-${file.replace(/\.test\.ts$/, "")}`);
    }
  }
  return names.sort();
}

function merged(current: string[], measured: Record<string, number>, previous: Record<string, number>): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const key of [...current].sort()) {
    const weight = measured[key] ?? previous[key];
    if (weight !== undefined) weights[key] = weight;
  }
  return weights;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Rewrite both weight files; files with no new measurement keep their old weight. */
export function refreshWeights(evidenceRoot: string, repoRoot = REPO_ROOT): { unit: number; integration: number } {
  const samples = collectSamples(evidenceRoot);
  if (samples.unit.size === 0 && samples.integration.size === 0) {
    throw new Error(`no deterministic unit or integration evidence under ${evidenceRoot}`);
  }
  const unitPath = join(repoRoot, UNIT_WEIGHTS);
  const unit = JSON.parse(readFileSync(unitPath, "utf8")) as ShardConfig;
  const unitFiles = readdirSync(join(repoRoot, "tests", "unit")).filter((file) => file.endsWith(".test.ts")).sort();
  const measuredUnit = Object.fromEntries(
    Object.entries(slowestOsWeights(samples.unit)).map(([name, weight]) => [`${name}.test.ts`, weight]),
  );
  const nextUnit: ShardConfig = {
    defaultSeconds: unit.defaultSeconds,
    weights: merged(unitFiles, measuredUnit, unit.weights),
    affinityGroups: unit.affinityGroups,
  };
  validateShardConfig(unitFiles, nextUnit);
  writeFileSync(unitPath, json(nextUnit));

  const integrationPath = join(repoRoot, INTEGRATION_WEIGHTS);
  const previous = existsSync(integrationPath)
    ? (JSON.parse(readFileSync(integrationPath, "utf8")) as OrderWeights)
    : { defaultSeconds: 1, weights: {} };
  const nextIntegration: OrderWeights = {
    defaultSeconds: previous.defaultSeconds,
    weights: merged(integrationNames(repoRoot), slowestOsWeights(samples.integration), previous.weights),
  };
  writeFileSync(integrationPath, json(nextIntegration));
  return { unit: Object.keys(nextUnit.weights).length, integration: Object.keys(nextIntegration.weights).length };
}

export interface Drift {
  name: string;
  seconds: number;
  weight: number;
}

/** Files that ran DRIFT_SECONDS and DRIFT_RATIO past their weight, largest gap first. */
export function weightDrift(summaryText: string, tier: WeightTier, config: OrderWeights): Drift[] {
  const key = (name: string): string => tier === "unit" ? `${name}.test.ts` : name;
  return readSummaryRows(summaryText)
    .filter((row) => row.status !== "SKIP" && Number.isFinite(row.seconds))
    .map((row) => ({ name: row.name, seconds: row.seconds, weight: config.weights[key(row.name)] ?? config.defaultSeconds }))
    .filter((row) => row.seconds - row.weight > DRIFT_SECONDS && row.seconds > row.weight * DRIFT_RATIO)
    .sort((a, b) => (b.seconds - b.weight) - (a.seconds - a.weight) || a.name.localeCompare(b.name));
}

// Workflow-command property and data escaping, so a name cannot end the command.
const escapeData = (text: string): string => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** Warning annotations and a step-summary table; never throws. */
export function reportDrift(tier: WeightTier, stampFile: string, env = process.env, repoRoot = REPO_ROOT): string[] {
  const lines: string[] = [];
  try {
    const summary = summaryFromStamp(stampFile, join(repoRoot, "tests", "logs"));
    if (!summary) return [`Test weights: no ${tier} summary to check.`];
    const config = JSON.parse(readFileSync(join(repoRoot, tier === "unit" ? UNIT_WEIGHTS : INTEGRATION_WEIGHTS), "utf8")) as OrderWeights;
    const drift = weightDrift(readFileSync(summary, "utf8"), tier, config);
    const os = env.RUNNER_OS ?? process.platform;
    if (drift.length === 0) return [`Test weights: every ${tier} file ran within its weight on ${os}.`];
    for (const row of drift.slice(0, 10)) {
      lines.push(`::warning title=Test weight out of date::${escapeData(
        `${row.name} took ${Math.round(row.seconds)}s on ${os} but is weighted ${row.weight}s, so CI balances it badly. Refresh: ${REFRESH_HINT}`,
      )}`);
    }
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, [
        `### Test weights out of date (${tier}, ${os})`, "",
        "These files ran much longer than their weight, so CI splits or orders them badly. Nothing failed.", "",
        "| File | Took | Weighted |", "| --- | --- | --- |",
        ...drift.map((row) => `| ${row.name} | ${Math.round(row.seconds)}s | ${row.weight}s |`),
        "", `Refresh: ${REFRESH_HINT}`, "",
      ].join("\n"));
    }
  } catch (error) {
    lines.push(`Test weights: check skipped (${error instanceof Error ? error.message : String(error)}).`);
  }
  return lines;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "report") {
    const [tier, stampFile] = rest;
    if ((tier === "unit" || tier === "integration") && stampFile) {
      for (const line of reportDrift(tier, stampFile)) console.log(line);
    } else {
      console.log("Test weights: usage is report <unit|integration> <stamp-file>; check skipped.");
    }
  } else if (command === "refresh" && rest.length === 1) {
    const counts = refreshWeights(rest[0]);
    console.log(`Wrote ${UNIT_WEIGHTS} (${counts.unit} weights) and ${INTEGRATION_WEIGHTS} (${counts.integration} weights).`);
  } else {
    console.error("Usage: bun scripts/ci-test-weights.ts refresh <evidence-dir> | report <unit|integration> <stamp-file>");
    process.exitCode = 1;
  }
}
