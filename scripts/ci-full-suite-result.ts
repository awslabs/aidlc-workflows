import { FAMILIES, liveMatrix, VERIFICATION_FAMILIES, type VerificationFamily } from "./ci-live-filter.ts";

export const FULL_SUITE_JOBS = [
  "plan", "native_terminal", "native_reconcile", "deterministic", "production_guards", "live_prepare", "live_hosted",
  "live_windows", "release_contract_windows",
] as const;

// Stable promotion rejects evidence produced under the former optional-live policy.
export const FULL_SUITE_COVERAGE_POLICY = "required-hosted-live-v1";
export const LIVE_VERIFICATION_OMITTED_JOBS = [
  "native_terminal", "native_reconcile", "deterministic", "production_guards",
] as const;
// Full verification may select an unmerged head, so it never reaches a job that
// receives OIDC or AWS credentials; live coverage of a candidate uses
// live-verification's separately authorized boundary.
export const FULL_VERIFICATION_OMITTED_JOBS = ["live_prepare", "live_hosted", "live_windows"] as const;
export type SuitePurpose = "release" | "live-verification" | "full-verification";

function isSuitePurpose(value: string): value is SuitePurpose {
  return value === "release" || value === "live-verification" || value === "full-verification";
}

type JobResult = "success" | "failure" | "cancelled" | "skipped";
export type SuiteNeeds = Record<string, { result: JobResult }>;
export interface SuiteIdentity {
  sha: string;
  runId: string;
  runAttempt: string;
}
export interface FullSuiteResult extends SuiteIdentity {
  purpose: SuitePurpose;
  verificationFamily: VerificationFamily;
  verificationTest?: string;
  verificationPlatforms?: NodeJS.Platform[];
  coveragePolicy: typeof FULL_SUITE_COVERAGE_POLICY;
  passed: boolean;
  complete: boolean;
  legs: Record<string, JobResult | "missing">;
  excluded: string[];
  disabledLegs: string[];
  omittedLegs: string[];
}

/** Release requires every job; live and full verification each omit a fixed complementary set. */
export function fullSuiteResult(
  needs: SuiteNeeds,
  identity: SuiteIdentity,
  purpose: SuitePurpose = "release",
  verificationFamily: VerificationFamily = "all",
  verificationTest = "",
): FullSuiteResult {
  const legs = Object.fromEntries([...new Set([...FULL_SUITE_JOBS, ...Object.keys(needs)])]
    .map((job) => [job, needs[job]?.result ?? "missing"]));
  const excluded = Object.entries(FAMILIES).filter(([, family]) => family.hosting === "excluded")
    .map(([name]) => name).sort();
  const omittedLegs: string[] = purpose === "live-verification" ? [...LIVE_VERIFICATION_OMITTED_JOBS]
    : purpose === "full-verification" ? [...FULL_VERIFICATION_OMITTED_JOBS] : [];
  if (purpose === "live-verification" && verificationFamily !== "all") omittedLegs.push("release_contract_windows");
  let validTestSelection = !verificationTest;
  let verificationPlatforms: NodeJS.Platform[] | undefined;
  if (verificationTest && purpose === "live-verification" && verificationFamily !== "all") {
    try {
      const hosted = liveMatrix("hosted", verificationFamily, verificationTest).include;
      const windows = liveMatrix("windows", verificationFamily, verificationTest).include;
      verificationPlatforms = [...new Set([...hosted, ...windows].map(row => row.platform))];
      validTestSelection = verificationPlatforms.length > 0;
      if (hosted.length === 0) omittedLegs.push("live_hosted");
      if (windows.length === 0) omittedLegs.push("live_windows");
    } catch { /* Unknown or mismatched selections never qualify. */ }
  }
  const passed = /^[a-f0-9]{40}$/.test(identity.sha) &&
    isSuitePurpose(purpose) &&
    validTestSelection &&
    VERIFICATION_FAMILIES.includes(verificationFamily) &&
    (purpose === "live-verification" || verificationFamily === "all") &&
    Object.entries(legs).every(([job, status]) => status === (omittedLegs.includes(job) ? "skipped" : "success"));
  return {
    ...identity,
    purpose,
    verificationFamily,
    ...(verificationTest ? { verificationTest } : {}),
    ...(verificationPlatforms ? { verificationPlatforms } : {}),
    coveragePolicy: FULL_SUITE_COVERAGE_POLICY,
    passed,
    complete: purpose === "release" && passed && excluded.length === 0,
    legs,
    excluded,
    // Retained in the evidence contract so promotion can reject historical disabled-live reports.
    disabledLegs: [],
    omittedLegs,
  };
}

if (import.meta.main) {
  const purpose = process.env.FULL_SUITE_PURPOSE ?? "release";
  if (!isSuitePurpose(purpose)) {
    console.error(`::error::Invalid full-suite purpose: ${purpose}`);
    process.exit(1);
  }
  const verificationFamily = process.env.FULL_SUITE_VERIFICATION_FAMILY ?? "all";
  if (!VERIFICATION_FAMILIES.includes(verificationFamily as VerificationFamily)) {
    console.error(`::error::Invalid verification family: ${verificationFamily}`);
    process.exit(1);
  }
  const result = fullSuiteResult(JSON.parse(process.env.FULL_SUITE_NEEDS ?? "{}") as SuiteNeeds, {
    sha: process.env.FULL_SUITE_SHA ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
  }, purpose, verificationFamily as VerificationFamily, process.env.FULL_SUITE_VERIFICATION_TEST ?? "");
  await Bun.write(process.argv[2] ?? "full-suite-result.json", `${JSON.stringify(result, null, 2)}\n`);
  if (result.excluded.length) {
    console.error(`::warning::Full suite excluded families: ${result.excluded.join(", ")}`);
  }
  if (!result.passed) {
    if (result.verificationTest && (purpose !== "live-verification" || verificationFamily === "all")) {
      console.error("::error::Exact test selection requires live-verification mode and one verification family");
    }
    if (purpose !== "live-verification" && verificationFamily !== "all") {
      const label = purpose === "release" ? "Release evidence" : "Full verification";
      console.error(`::error::${label} requires verificationFamily=all`);
    }
    console.error(`::error::Incomplete full suite for ${result.sha || process.env.FULL_SUITE_REF || "unknown ref"}: ` +
      Object.entries(result.legs).filter(([job, status]) => status !== (result.omittedLegs.includes(job) ? "skipped" : "success"))
        .map(([job, status]) => `${job}=${status}`).join(", "));
    process.exitCode = 1;
  }
}
