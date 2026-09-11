// Pure runner configuration: importing this module never starts a test run.
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
  };
  let levelSelected = false;
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
  return out;
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
