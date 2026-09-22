import { FAMILIES } from "./ci-live-filter.ts";

export const FULL_SUITE_JOBS = [
  "plan", "native_terminal", "native_reconcile", "deterministic", "live_prepare", "live_hosted",
  "live_windows", "release_contract_windows",
] as const;

type JobResult = "success" | "failure" | "cancelled" | "skipped";
export type SuiteNeeds = Record<string, { result: JobResult }>;
export interface SuiteIdentity {
  sha: string;
  runId: string;
  runAttempt: string;
}
export interface FullSuiteResult extends SuiteIdentity {
  passed: boolean;
  complete: boolean;
  legs: Record<string, JobResult | "missing">;
  excluded: string[];
  disabledLegs: string[];
}

/** Enabled jobs must succeed; disabled live legs must be skipped, not counted as coverage. */
export function fullSuiteResult(
  needs: SuiteNeeds,
  identity: SuiteIdentity,
  { live }: { live?: string },
): FullSuiteResult {
  const legs = Object.fromEntries([...new Set([...FULL_SUITE_JOBS, ...Object.keys(needs)])]
    .map((job) => [job, needs[job]?.result ?? "missing"]));
  const excluded = Object.entries(FAMILIES).filter(([, family]) => family.hosting === "excluded")
    .map(([name]) => name).sort();
  const disabledLegs = live === "1" ? [] : ["live_prepare", "live_hosted", "live_windows"];
  const passed = /^[a-f0-9]{40}$/.test(identity.sha) && Object.entries(legs)
    .every(([job, status]) => status === (disabledLegs.includes(job) ? "skipped" : "success"));
  return {
    ...identity,
    passed,
    complete: passed && excluded.length === 0 && disabledLegs.length === 0,
    legs,
    excluded,
    disabledLegs,
  };
}

if (import.meta.main) {
  const result = fullSuiteResult(JSON.parse(process.env.FULL_SUITE_NEEDS ?? "{}") as SuiteNeeds, {
    sha: process.env.FULL_SUITE_SHA ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
  }, { live: process.env.AIDLC_NIGHTLY_LIVE });
  await Bun.write(process.argv[2] ?? "full-suite-result.json", `${JSON.stringify(result, null, 2)}\n`);
  if (result.disabledLegs.length) {
    console.error(`::warning::Full suite ran with the live lanes disabled (AIDLC_NIGHTLY_LIVE unset): ${result.disabledLegs.join(", ")}`);
  }
  if (result.excluded.length) {
    console.error(`::warning::Full suite excluded families: ${result.excluded.join(", ")}`);
  }
  if (!result.passed) {
    const unexpectedRuns = result.disabledLegs.filter((job) => result.legs[job] === "success" || result.legs[job] === "failure");
    if (unexpectedRuns.length) {
      console.error("::error::Live-lane configuration error: AIDLC_NIGHTLY_LIVE is not '1' but these jobs ran: " +
        unexpectedRuns.map((job) => `${job}=${result.legs[job]}`).join(", "));
    }
    console.error(`Incomplete full suite for ${result.sha || process.env.FULL_SUITE_REF || "unknown ref"}: ` +
      Object.entries(result.legs).filter(([job, status]) => status !== (result.disabledLegs.includes(job) ? "skipped" : "success"))
        .map(([job, status]) => `${job}=${status}`).join(", "));
    process.exitCode = 1;
  }
}
