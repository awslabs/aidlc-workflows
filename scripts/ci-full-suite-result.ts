export const FULL_SUITE_JOBS = [
  "plan", "native_terminal", "native_reconcile", "deterministic", "live_hosted",
  "live_kiro_windows",
] as const;

type JobResult = "success" | "failure" | "cancelled" | "skipped";
export type SuiteNeeds = Record<string, { result: JobResult }>;
export interface SuiteIdentity {
  sha: string;
  runId: string;
  runAttempt: string;
}
export interface SuiteVariables {
  kiro?: string;
}
export interface FullSuiteResult extends SuiteIdentity {
  passed: boolean;
  complete: boolean;
  legs: Record<string, JobResult | "missing">;
  excluded: string[];
}

/** Only explicitly disabled, skipped families are exempt from the passing gate. */
export function fullSuiteResult(
  needs: SuiteNeeds,
  identity: SuiteIdentity,
  variables: SuiteVariables = {},
): FullSuiteResult {
  const legs = Object.fromEntries([...new Set([...FULL_SUITE_JOBS, ...Object.keys(needs)])]
    .map((job) => [job, needs[job]?.result ?? "missing"]));
  const disabled: Record<string, boolean> = {
    live_kiro_windows: variables.kiro !== "1",
  };
  const excluded = Object.keys(legs).filter((job) => legs[job] === "skipped" && disabled[job]);
  const passed = /^[a-f0-9]{40}$/.test(identity.sha) && Object.entries(legs)
    .every(([job, result]) => result === "success" || (result === "skipped" && disabled[job]));
  return {
    ...identity,
    passed,
    complete: passed && excluded.length === 0,
    legs,
    excluded,
  };
}

if (import.meta.main) {
  const result = fullSuiteResult(JSON.parse(process.env.FULL_SUITE_NEEDS ?? "{}") as SuiteNeeds, {
    sha: process.env.FULL_SUITE_SHA ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
  }, {
    kiro: process.env.AIDLC_NIGHTLY_KIRO_RUNNERS,
  });
  await Bun.write(process.argv[2] ?? "full-suite-result.json", `${JSON.stringify(result, null, 2)}\n`);
  if (result.excluded.length) {
    console.error(`::warning::Full suite excluded disabled legs: ${result.excluded.join(", ")}`);
  }
  if (!result.passed) {
    console.error(`Incomplete full suite for ${result.sha || process.env.FULL_SUITE_REF || "unknown ref"}: ` +
      Object.entries(result.legs).filter(([job, status]) => status !== "success" && !result.excluded.includes(job))
        .map(([job, status]) => `${job}=${status}`).join(", "));
    process.exitCode = 1;
  }
}
