import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_MATRICES, liveMatrix, type LiveMatrixKind, type LiveMatrixRow, type VerificationFamily } from "./ci-live-filter.ts";

export interface LiveOutcome {
  sha: string;
  runId: string;
  family: string;
  platform: string;
  shard: string;
  status: string;
}
const key = (row: Pick<LiveOutcome, "family" | "platform" | "shard">) => `${row.family}/${row.platform}/${row.shard}`;

export function plannedLiveRows(family: VerificationFamily = "all", file = ""): LiveMatrixRow[] {
  return (Object.keys(LIVE_MATRICES) as LiveMatrixKind[]).flatMap(kind => liveMatrix(kind, family, file).include);
}

/** Small status artifacts preserve real job failures even with continue-on-error. */
export function readLiveOutcomes(directory: string): unknown[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readLiveOutcomes(path);
    if (entry.name !== "live-outcome.json") return [];
    try { return [JSON.parse(readFileSync(path, "utf8"))]; }
    catch { return [{ invalid: path }]; }
  });
}

export function assessLiveOutcomes(
  raw: readonly unknown[], expected: readonly LiveMatrixRow[], identity: { sha: string; runId: string },
): { rows: LiveOutcome[]; problems: string[] } {
  const problems: string[] = [];
  const found = new Map<string, LiveOutcome>();
  const planned = new Set(expected.map(key));
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      problems.push("invalid live shard outcome");
      continue;
    }
    const row = value as LiveOutcome;
    const id = key(row);
    if (!planned.has(id) || found.has(id) || row.sha !== identity.sha || row.runId !== identity.runId ||
      !["success", "failure", "cancelled"].includes(row.status)) {
      problems.push(`invalid, duplicate or stale live shard outcome: ${id}`);
      continue;
    }
    found.set(id, row);
  }
  return {
    rows: expected.map(row => found.get(key(row)) ?? {
      ...identity, family: row.family, platform: row.platform, shard: row.shard, status: "missing",
    }),
    problems,
  };
}

if (import.meta.main) {
  const output = process.argv[2];
  const row: LiveOutcome = {
    sha: process.env.LIVE_SOURCE_SHA ?? "", runId: process.env.GITHUB_RUN_ID ?? "",
    family: process.env.LIVE_FAMILY ?? "", platform: process.env.LIVE_PLATFORM ?? "",
    shard: process.env.LIVE_SHARD ?? "", status: process.env.LIVE_JOB_STATUS ?? "",
  };
  if (!output || !/^[a-f0-9]{40}$/.test(row.sha) || !/^\d+$/.test(row.runId) ||
    !["success", "failure", "cancelled"].includes(row.status)) {
    throw new Error("Live outcome requires a source SHA, run identity and real job status");
  }
  writeFileSync(output, `${JSON.stringify(row)}\n`);
}
