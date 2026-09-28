// Pure runner configuration: importing this module never starts a test run.
import { resolve } from "node:path";
import { parseShardSpec, type ShardSpec } from "../lib/test-sharding.ts";

export type GuardProfile = "fixture" | "production";
export const GUARD_PROFILE_ENV = "AIDLC_TEST_GUARD_PROFILE";

export interface ParsedArgs {
  runSmoke: boolean;
  runUnit: boolean;
  runIntegration: boolean;
  runE2e: boolean;
  verbose: boolean;
  debug: boolean;
  filter: string;
  parallel: number;
  shard: ShardSpec | null;
  fullProfile: boolean;
  noLlm: boolean;
  guardProfile: GuardProfile;
  help: boolean;
  requireCoverage: boolean;
  isolatedE2e: boolean;
  e2ePlan: boolean;
  bedrockParallel: number;
  kiroParallel: number;
  ideParallel: number;
  fileTimeout: number | null;
  runTimeout: number | null;
  e2eFileTimeout: number;
  e2eTimings: string;
  e2eCancelFile: string;
  matrixPlan: string;
  matrixJob: string;
}

export class RunnerArgsError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
    readonly showUsage = false,
  ) {
    super(message);
  }
}

export function parseRunnerArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedArgs {
  const out: ParsedArgs = {
    runSmoke: false,
    runUnit: false,
    runIntegration: false,
    runE2e: false,
    verbose: false,
    debug: false,
    filter: "",
    parallel: 1,
    shard: null,
    fullProfile: false,
    noLlm: env.AIDLC_NO_LLM === "1",
    guardProfile: "fixture",
    help: false,
    requireCoverage: false,
    isolatedE2e: false,
    e2ePlan: false,
    bedrockParallel: 2,
    kiroParallel: 2,
    ideParallel: 1,
    fileTimeout: null,
    runTimeout: null,
    e2eFileTimeout: 10_800,
    e2eTimings: "",
    e2eCancelFile: "",
    matrixPlan: "",
    matrixJob: "",
  };
  let levelSelected = false;
  let workerOption = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--smoke":
        out.runSmoke = true;
        levelSelected = true;
        break;
      case "--unit":
        out.runUnit = true;
        levelSelected = true;
        break;
      case "--integration":
        out.runIntegration = true;
        levelSelected = true;
        break;
      case "--e2e":
        out.runE2e = true;
        levelSelected = true;
        break;
      case "--ci":
        out.runSmoke = out.runUnit = out.runIntegration = true;
        levelSelected = true;
        break;
      case "--release":
      case "--all":
        out.runSmoke = out.runUnit = out.runIntegration = out.runE2e = true;
        out.fullProfile = true;
        levelSelected = true;
        break;
      case "--production-guards":
        out.guardProfile = "production";
        break;
      case "--verbose":
        out.verbose = true;
        break;
      case "--no-llm":
        out.noLlm = true;
        break;
      case "--require-coverage":
        out.requireCoverage = true;
        out.verbose = true;
        break;
      case "--matrix-plan":
      case "--matrix-job": {
        const value = argv[++i];
        if (!value || value.startsWith("--")) throw new RunnerArgsError(`${arg} requires a value`, 2, true);
        if (arg === "--matrix-plan") out.matrixPlan = resolve(value);
        else out.matrixJob = value;
        break;
      }
      case "--debug":
        out.debug = out.verbose = true;
        break;
      case "--filter":
        out.filter = argv[++i] ?? "";
        if (!out.filter) {
          throw new RunnerArgsError("ERROR: --filter requires a non-empty filename regex");
        }
        break;
      case "--parallel":
      case "-P": {
        const value = argv[++i] ?? "";
        if (!/^[1-9][0-9]*$/.test(value)) {
          throw new RunnerArgsError(
            `ERROR: --parallel requires a positive integer (got: '${value || "<missing>"}')`,
          );
        }
        out.parallel = Number(value);
        break;
      }
      case "--shard":
        try {
          out.shard = parseShardSpec(argv[++i] ?? "");
        } catch (error) {
          throw new RunnerArgsError(
            `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      case "--isolated-e2e":
        out.isolatedE2e = true;
        break;
      case "--e2e-plan":
        out.e2ePlan = true;
        out.isolatedE2e = true;
        break;
      case "--file-timeout":
      case "--run-timeout": {
        const value = argv[++i] ?? "";
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
          throw new RunnerArgsError(`${arg} requires a positive safe integer`, 2, true);
        }
        if (Number(value) > 2_147_483) {
          throw new RunnerArgsError(`${arg} exceeds the supported timer range`, 2, true);
        }
        if (arg === "--file-timeout") out.fileTimeout = Number(value);
        else out.runTimeout = Number(value);
        break;
      }
      case "--bedrock-parallel":
      case "--kiro-parallel":
      case "--ide-parallel":
      case "--e2e-file-timeout": {
        const value = argv[++i] ?? "";
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
          throw new RunnerArgsError(`${arg} requires a positive safe integer`, 2, true);
        }
        const key = {
          "--bedrock-parallel": "bedrockParallel",
          "--kiro-parallel": "kiroParallel",
          "--ide-parallel": "ideParallel",
          "--e2e-file-timeout": "e2eFileTimeout",
        }[arg] as "bedrockParallel" | "kiroParallel" | "ideParallel" | "e2eFileTimeout";
        out[key] = Number(value);
        workerOption = true;
        break;
      }
      case "--e2e-timings":
        out.e2eTimings = argv[++i] ?? "";
        if (!out.e2eTimings || out.e2eTimings.startsWith("--")) throw new RunnerArgsError("--e2e-timings requires a file", 2, true);
        workerOption = true;
        break;
      case "--e2e-cancel-file":
        out.e2eCancelFile = argv[++i] ?? "";
        if (!out.e2eCancelFile || out.e2eCancelFile.startsWith("--")) throw new RunnerArgsError("--e2e-cancel-file requires a file", 2, true);
        workerOption = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        return out;
      default:
        throw new RunnerArgsError(`Unknown flag: ${arg}`, 1, true);
    }
  }
  if (!levelSelected) {
    out.runSmoke = out.runUnit = out.runIntegration = true;
  }
  if (out.shard && (!out.runUnit || out.runSmoke || out.runIntegration || out.runE2e)) {
    throw new RunnerArgsError(
      "ERROR: --shard requires --unit with no other level or profile flags",
    );
  }
  if ((out.isolatedE2e && !out.runE2e) || (workerOption && !out.isolatedE2e)) {
    throw new RunnerArgsError("isolated e2e options require --e2e --isolated-e2e or --e2e --e2e-plan; --e2e-plan implies --isolated-e2e, not --e2e", 2, true);
  }
  if (out.isolatedE2e && (!Number.isSafeInteger(out.parallel) || out.parallel > 256)) {
    throw new RunnerArgsError("isolated e2e --parallel must be a safe integer in 1..256", 2, true);
  }
  if (out.e2eFileTimeout > 2_147_483) throw new RunnerArgsError("--e2e-file-timeout exceeds the supported timer range", 2, true);
  if (out.isolatedE2e && !out.e2ePlan) out.verbose = true;
  if (!!out.matrixPlan !== !!out.matrixJob) {
    throw new RunnerArgsError("--matrix-plan and --matrix-job must be supplied together", 2, true);
  }
  if (out.matrixPlan) {
    if (out.e2ePlan) throw new RunnerArgsError("--matrix-plan requires an executed test run, not --e2e-plan", 2, true);
    out.requireCoverage = true;
    out.verbose = true;
  }
  return out;
}

/** The common cap can shorten, but cannot extend, an isolated-file deadline. */
export function runnerFileTimeoutSeconds(args: ParsedArgs, isolated: boolean): number {
  return isolated
    ? Math.min(args.e2eFileTimeout, args.fileTimeout ?? Number.POSITIVE_INFINITY)
    : args.fileTimeout ?? 7200;
}

/** POSIX exit statuses are eight bits; 256 failed files must never wrap to success. */
export function runnerFailureExitCode(failedFiles: number): number {
  return Number.isSafeInteger(failedFiles) && failedFiles > 0
    ? Math.min(255, failedFiles)
    : 1;
}

// The fixture profile preserves the runner's historical synthetic-fixture defaults.
const FIXTURE_GUARD_ENV = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVISION_BACKSTOP: "1",
  AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1",
} as const;

// Explicit zeroes also mask settings-file bypasses: resolveProjectFlag falls
// back to project/local settings only when the environment key is absent.
// Keep the recordable flags in sync with core/tools/aidlc-settings.ts.
export const PRODUCTION_GUARD_OFF_SWITCHES = [
  ...Object.keys(FIXTURE_GUARD_ENV),
  "AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS",
  "AIDLC_SKIP_REVIEWER_GATE_GUARD",
  "AIDLC_SKIP_SOURCE_FRESHNESS",
  "AIDLC_DISABLE_ENSEMBLE_EVIDENCE",
  "AIDLC_DISABLE_PLAN_APPROVAL_GUARD",
  "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK",
  "AIDLC_DISABLE_REVIEW_FREEZE_HOOK",
  "AIDLC_DISABLE_USAGE_TRACKING",
  "AIDLC_DISABLE_SENSORS",
  "AIDLC_DISABLE_LEARNINGS",
  "AIDLC_DISABLE_SUMMARY_CONFIRMATION",
] as const;

export function testGuardEnvironment(
  inherited: NodeJS.ProcessEnv,
  profile: GuardProfile,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  // A caller's diagnostic marker is never an input to profile selection.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === GUARD_PROFILE_ENV) delete env[key];
  }
  env[GUARD_PROFILE_ENV] = profile;
  if (profile === "fixture") {
    Object.assign(env, FIXTURE_GUARD_ENV);
  } else {
    // Include inherited future switches, and case variants on Windows, without
    // deleting unrelated live-model gates, credentials, or runner diagnostics.
    for (const key of Object.keys(env)) {
      if (/^AIDLC_(?:SKIP|DISABLE|ALLOW_DIRECT)_/i.test(key)) env[key] = "0";
    }
    for (const key of PRODUCTION_GUARD_OFF_SWITCHES) env[key] = "0";
  }
  return env;
}

export function guardProfileDescription(profile: GuardProfile): string {
  return profile === "production"
    ? "Guard profile: production (runner bypasses off; inherited off-switches forced to 0)"
    : "Guard profile: fixture (synthetic guard skips and direct audit authority enabled)";
}

interface PreflightResult {
  status: "PASS" | "SKIP" | "FAIL";
  cases: { total: number; skipped: number };
  evidenceComplete?: boolean;
  timedOut: boolean;
  cleanupError?: string;
}

export function preflightVerdict(
  result: PreflightResult | undefined,
  options: { liveRequested: boolean; requireCoverage: boolean },
): "pass" | "skip" | "fail" {
  if (!result || result.status === "FAIL" || result.timedOut || result.cleanupError) return "fail";
  if (result.status === "SKIP" && !options.liveRequested && !options.requireCoverage) return "skip";
  return result.status === "PASS" && result.evidenceComplete === true &&
    result.cases.total > 0 && result.cases.skipped === 0 ? "pass" : "fail";
}
