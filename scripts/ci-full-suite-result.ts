import { FAMILIES } from "./ci-live-filter.ts";

export const FULL_SUITE_JOBS = [
  "plan", "native_terminal", "native_reconcile", "deterministic", "production_guards", "live_prepare", "live_hosted",
  "live_windows", "release_contract_windows",
] as const;

// Stable promotion rejects evidence produced under the former optional-live policy.
export const FULL_SUITE_COVERAGE_POLICY = "required-hosted-live-v1";

type JobResult = "success" | "failure" | "cancelled" | "skipped";
export type SuiteNeeds = Record<string, { result: JobResult }>;
export interface SuiteIdentity {
  sha: string;
  runId: string;
  runAttempt: string;
}
export interface FullSuiteResult extends SuiteIdentity {
  coveragePolicy: typeof FULL_SUITE_COVERAGE_POLICY;
  passed: boolean;
  complete: boolean;
  legs: Record<string, JobResult | "missing">;
  excluded: string[];
  disabledLegs: string[];
}

/** Every declared job, including hosted live coverage, must succeed. */
export function fullSuiteResult(
  needs: SuiteNeeds,
  identity: SuiteIdentity,
): FullSuiteResult {
  const legs = Object.fromEntries([...new Set([...FULL_SUITE_JOBS, ...Object.keys(needs)])]
    .map((job) => [job, needs[job]?.result ?? "missing"]));
  const excluded = Object.entries(FAMILIES).filter(([, family]) => family.hosting === "excluded")
    .map(([name]) => name).sort();
  const passed = /^[a-f0-9]{40}$/.test(identity.sha) &&
    Object.values(legs).every((status) => status === "success");
  return {
    ...identity,
    coveragePolicy: FULL_SUITE_COVERAGE_POLICY,
    passed,
    complete: passed && excluded.length === 0,
    legs,
    excluded,
    // Retained in the evidence contract so promotion can reject historical disabled-live reports.
    disabledLegs: [],
  };
}

if (import.meta.main) {
  const result = fullSuiteResult(JSON.parse(process.env.FULL_SUITE_NEEDS ?? "{}") as SuiteNeeds, {
    sha: process.env.FULL_SUITE_SHA ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
  });
  await Bun.write(process.argv[2] ?? "full-suite-result.json", `${JSON.stringify(result, null, 2)}\n`);
  if (result.excluded.length) {
    console.error(`::warning::Full suite excluded families: ${result.excluded.join(", ")}`);
  }
  if (!result.passed) {
    console.error(`::error::Incomplete full suite for ${result.sha || process.env.FULL_SUITE_REF || "unknown ref"}: ` +
      Object.entries(result.legs).filter(([, status]) => status !== "success")
        .map(([job, status]) => `${job}=${status}`).join(", "));
    process.exitCode = 1;
  }
}
