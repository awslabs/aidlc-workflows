export const FULL_SUITE_JOBS = [
  "plan", "native_terminal", "native_reconcile", "deterministic", "live_hosted",
  "live_kiro_linux", "live_kiro_windows", "live_cursor",
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
  cursor?: string;
}
export interface FullSuiteResult extends SuiteIdentity {
  complete: boolean;
  legs: Record<string, JobResult | "missing">;
  excluded: string[];
}

/** Missing, cancelled and intentionally disabled coverage all fail closed. */
export function fullSuiteResult(
  needs: SuiteNeeds,
  identity: SuiteIdentity,
  variables: SuiteVariables = {},
): FullSuiteResult {
  const legs = Object.fromEntries([...new Set([...FULL_SUITE_JOBS, ...Object.keys(needs)])]
    .map((job) => [job, needs[job]?.result ?? "missing"]));
  const disabled: Record<string, boolean> = {
    live_kiro_linux: variables.kiro !== "1",
    live_kiro_windows: variables.kiro !== "1",
    live_cursor: variables.cursor !== "1",
  };
  const excluded = Object.keys(legs).filter((job) => legs[job] === "skipped" && disabled[job]);
  return {
    ...identity,
    complete: /^[a-f0-9]{40}$/.test(identity.sha) && excluded.length === 0 &&
      Object.values(legs).every((result) => result === "success"),
    legs,
    excluded,
  };
}

if (import.meta.main) {
  const result = fullSuiteResult(JSON.parse(process.env.FULL_SUITE_NEEDS ?? "{}") as SuiteNeeds, {
    sha: process.env.FULL_SUITE_SHA ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
  }, { kiro: process.env.AIDLC_NIGHTLY_KIRO_RUNNERS, cursor: process.env.AIDLC_NIGHTLY_CURSOR });
  await Bun.write(process.argv[2] ?? "full-suite-result.json", `${JSON.stringify(result, null, 2)}\n`);
  if (!result.complete) {
    console.error(`Incomplete full suite for ${result.sha || process.env.FULL_SUITE_REF || "unknown ref"}: ` +
      Object.entries(result.legs).filter(([, status]) => status !== "success")
        .map(([job, status]) => `${job}=${status}`).join(", "));
    process.exitCode = 1;
  }
}
