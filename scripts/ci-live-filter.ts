import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { codeView } from "../tests/gen-coverage-registry.ts";
import { discoverClaudeRequiredTests } from "../tests/harness/claude-gate.ts";
import { TEST_MATRIX_LIVE_GATES, type AllowedLiveGate } from "../tests/lib/test-matrix.ts";

interface Family {
  env: Partial<Record<AllowedLiveGate, "1">>;
  platforms: readonly NodeJS.Platform[];
  hosting: "hosted" | "excluded";
  requireCoverage: boolean;
  reason?: string;
}

const REPO_ROOT = resolve(import.meta.dir, "..");
const hostedPlatforms = ["linux", "darwin", "win32"] as const;
export const FAMILIES = {
  "kiro-ide": { env: { AIDLC_KIRO_IDE_LIVE: "1" }, platforms: [], hosting: "excluded", requireCoverage: true, reason: "needs a dedicated isolated Windows desktop host with a separate low-privilege Kiro identity; tracked as a follow-up" },
  "kiro-tui": { env: { AIDLC_KIRO_TUI_LIVE: "1", AIDLC_TUI_LIVE: "1" }, platforms: [], hosting: "excluded", requireCoverage: true, reason: "needs a dedicated isolated Windows desktop host with a separate low-privilege Kiro identity; tracked as a follow-up" },
  "kiro-acp": { env: { AIDLC_KIRO_ACP_LIVE: "1" }, platforms: [], hosting: "excluded", requireCoverage: true, reason: "needs a dedicated isolated Windows desktop host with a separate low-privilege Kiro identity; tracked as a follow-up" },
  codex: { env: { AIDLC_CODEX_EXEC_LIVE: "1" }, platforms: hostedPlatforms, hosting: "hosted", requireCoverage: true },
  opencode: { env: { AIDLC_OPENCODE_RUN_LIVE: "1" }, platforms: hostedPlatforms, hosting: "hosted", requireCoverage: true },
  cursor: { env: { AIDLC_CURSOR_RUN_LIVE: "1" }, platforms: [], hosting: "excluded", requireCoverage: true, reason: "no credential separation: vendor CLI reads the API key from the agent environment" },
  copilot: { env: { AIDLC_COPILOT_EXEC_LIVE: "1" }, platforms: [], hosting: "excluded", requireCoverage: true },
  "claude-tui": { env: { AIDLC_TUI_LIVE: "1" }, platforms: hostedPlatforms, hosting: "hosted", requireCoverage: true },
  "claude-sdk": { env: { AIDLC_CLAUDE_SDK_LIVE: "1" }, platforms: hostedPlatforms, hosting: "hosted", requireCoverage: true },
  "release-contract": { env: { AIDLC_RELEASE_CONTRACT_LIVE: "1" }, platforms: hostedPlatforms, hosting: "hosted", requireCoverage: false },
} as const satisfies Record<string, Family>;
export type LiveFamily = keyof typeof FAMILIES;
export const VERIFICATION_FAMILIES = ["all", "claude-sdk", "claude-tui", "codex", "opencode"] as const;
export type VerificationFamily = (typeof VERIFICATION_FAMILIES)[number];

let invocationFiles: Map<LiveFamily, string[]> | undefined;
function liveInvocationFiles(): Map<LiveFamily, string[]> {
  // A CI invocation uses one immutable checkout. Matrix planning and selection
  // share its inventory instead of rescanning every source file for every row.
  invocationFiles ??= classifyLiveFiles(REPO_ROOT);
  return invocationFiles;
}

/** Same top-level tier/plugin discovery as run-tests.ts; never import test modules. */
export function discoverLiveFiles(root: string): Map<string, Set<AllowedLiveGate>> {
  const claude = new Set(discoverClaudeRequiredTests(join(root, "tests")).map(({ file }) => file));
  const directories = ["tests/unit", "tests/integration", "tests/e2e"];
  const plugins = join(root, "plugins");
  if (existsSync(plugins)) {
    for (const entry of readdirSync(plugins, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(`plugins/${entry.name}/tests`);
    }
  }
  const files = new Map<string, Set<AllowedLiveGate>>();
  for (const directory of directories) {
    if (!existsSync(join(root, directory))) continue;
    for (const name of readdirSync(join(root, directory)).sort()) {
      if (!name.endsWith(".test.ts")) continue;
      const file = `${directory}/${name}`;
      const code = codeView(readFileSync(join(root, file), "utf8"));
      const tokens = new Set(code.match(/\bAIDLC_[A-Z_]+_LIVE\b/g));
      const gates = new Set(TEST_MATRIX_LIVE_GATES.filter((gate) => tokens.has(gate) &&
        (directory !== "tests/unit" || gate === "AIDLC_RELEASE_CONTRACT_LIVE")));
      if (claude.has(file) || gates.size > 0) files.set(file, gates);
    }
  }
  return files;
}

/** Precedence assigns each file from its own live gates or derived Claude dependency. */
export function classifyLiveFiles(root: string): Map<LiveFamily, string[]> {
  const claude = new Set(discoverClaudeRequiredTests(join(root, "tests")).map(({ file }) => file));
  const partition = new Map<LiveFamily, string[]>(Object.keys(FAMILIES).map((family) => [family as LiveFamily, []]));
  for (const [file, gates] of discoverLiveFiles(root)) {
    const families = (Object.keys(FAMILIES) as LiveFamily[]).filter((family) => {
      // The first gate identifies the family; Kiro TUI also enables the shared TUI gate.
      const gate = Object.keys(FAMILIES[family].env)[0] as AllowedLiveGate;
      return gates.has(gate);
    });
    let family: LiveFamily | undefined = families.find((candidate) => candidate !== "claude-sdk" && candidate !== "release-contract");
    family ??= claude.has(file) && basename(file).startsWith("t-tui-") ? "claude-tui" : undefined;
    family ??= claude.has(file) || gates.has("AIDLC_CLAUDE_SDK_LIVE") ? "claude-sdk" : undefined;
    family ??= "release-contract";
    partition.get(family)!.push(file);
  }
  for (const files of partition.values()) files.sort();
  return partition;
}

export const PLATFORM_ONLY: Record<string, readonly NodeJS.Platform[]> = {
  "tests/e2e/t-acp-kiro-new-work-routing.serial.test.ts": ["win32"],
  "tests/e2e/t-tui-journey-orientation-windows.serial.test.ts": ["win32"],
  "tests/e2e/t-tui-windows-user-settings-isolation.serial.test.ts": ["win32"],
};

const LIVE_RUNNERS = { linux: "ubuntu-latest", darwin: "macos-15", win32: "windows-latest" } as const;
export interface LiveMatrixRow {
  family: LiveFamily;
  runner: (typeof LIVE_RUNNERS)[keyof typeof LIVE_RUNNERS];
  platform: keyof typeof LIVE_RUNNERS;
  shard: string;
  slice: string;
}

function eligibleLiveFiles(partition: Map<LiveFamily, string[]>, family: LiveFamily, platform: NodeJS.Platform): string[] {
  if (!Object.hasOwn(FAMILIES, family)) throw new Error(`unknown family: ${family}`);
  const spec: Family = FAMILIES[family];
  if (spec.hosting !== "hosted") throw new Error(`${family} is excluded from hosted live runs`);
  if (!spec.platforms.includes(platform)) throw new Error(`${family} does not support ${platform}`);
  const files = partition.get(family)!.filter((file) => !PLATFORM_ONLY[file] || PLATFORM_ONLY[file].includes(platform));
  if (!files.length) throw new Error(`${family} has no selected files on ${platform}`);
  return files;
}

/** One assigned file per shard; omitted shards preserve whole-family callers. */
export function selectedLiveFiles(family: LiveFamily, platform: NodeJS.Platform, shard?: string): string[] {
  const files = eligibleLiveFiles(liveInvocationFiles(), family, platform);
  if (shard === undefined) return files;
  const match = /^[1-9][0-9]*\/[1-9][0-9]*$/.exec(shard);
  if (!match || match[0] !== shard) throw new Error(`invalid live shard: ${shard}; expected N/M`);
  const [index, total] = shard.split("/").map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total !== files.length || index > total) {
    throw new Error(`invalid live shard: ${shard}; ${family}/${platform} requires N/${files.length} with N in 1..${files.length}`);
  }
  return [files[index - 1]];
}

/** Workflow matrices share discovery and platform eligibility with execution. */
export function liveMatrix(
  kind: "hosted" | "windows",
  selectedFamily: VerificationFamily = "all",
  selectedTest = "",
): { include: LiveMatrixRow[] } {
  if (kind !== "hosted" && kind !== "windows") throw new Error(`unknown live matrix: ${kind}`);
  if (!VERIFICATION_FAMILIES.includes(selectedFamily)) throw new Error(`unknown verification family: ${selectedFamily}`);
  if (selectedTest && selectedFamily === "all") throw new Error("an exact live test requires one verification family");
  const partition = liveInvocationFiles();
  if (selectedTest && selectedFamily !== "all" &&
    (!partition.get(selectedFamily)!.includes(selectedTest) ||
      !FAMILIES[selectedFamily].platforms.some(platform => !PLATFORM_ONLY[selectedTest] || PLATFORM_ONLY[selectedTest].includes(platform)))) {
    throw new Error(`exact live test ${selectedTest} must belong to ${selectedFamily} and have a supported platform`);
  }
  const platforms = kind === "hosted" ? ["linux", "darwin"] as const : ["win32"] as const;
  const include: LiveMatrixRow[] = [];
  for (const family of Object.keys(FAMILIES) as LiveFamily[]) {
    const spec: Family = FAMILIES[family];
    if (spec.hosting !== "hosted" || (kind === "windows" && family === "release-contract")) continue;
    for (const platform of platforms) {
      if (!spec.platforms.includes(platform)) continue;
      const files = eligibleLiveFiles(partition, family, platform);
      for (let index = 1; index <= files.length; index++) {
        include.push({ family, runner: LIVE_RUNNERS[platform], platform, shard: `${index}/${files.length}`, slice: `${family}-${index}` });
      }
    }
  }
  if (!include.length) throw new Error(`${kind} has no selected live files`);
  // Start the first file for every family/platform before its second file.
  include.sort((a, b) => Number(a.shard.split("/")[0]) - Number(b.shard.split("/")[0]));
  // Filter only after discovery and shard assignment; N/M and slice identities
  // stay identical to the full run for the selected family.
  let selected = selectedFamily === "all" ? include : include.filter((row) => row.family === selectedFamily);
  if (selectedTest) {
    selected = selected.filter((row) => {
      const index = Number(row.shard.split("/")[0]) - 1;
      return eligibleLiveFiles(partition, row.family, row.platform)[index] === selectedTest;
    });
  }
  if (!selected.length && !selectedTest) throw new Error(`${kind}/${selectedFamily} has no selected live files`);
  return { include: selected };
}

/** Qualify tiers (and plugin names) to avoid collisions in all three runner aliases. */
export function liveFilter(files: readonly string[], platform?: NodeJS.Platform): string {
  const selected = files.filter((file) => !platform || !PLATFORM_ONLY[file] || PLATFORM_ONLY[file].includes(platform));
  const names = selected.map((file) => {
    const normalized = file.replaceAll("\\", "/");
    const parts = normalized.split("/");
    const name = basename(normalized, ".test.ts");
    const qualified = parts[0] === "plugins" ? `plugins-plugin-${parts[1]}-${name}` : `${parts[1]}-${name}`;
    return qualified.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return names.length === 0 ? "^(?!)$" : `^(?:${names.join("|")})$`;
}

// Production-guard journeys skip in the fixture profile. A selection made only
// of them runs with production guards; every other selection keeps the default.
function requiresProductionGuards(file: string): boolean {
  return /\bprocess\.env\.AIDLC_TEST_GUARD_PROFILE\s*===\s*"production"/.test(
    codeView(readFileSync(join(REPO_ROOT, file), "utf8")),
  );
}

/** Live file and run ceiling; bounded by the one-hour credential session. */
export const LIVE_RUN_CEILING_SECONDS = 3600;

/** Runner modes follow the selected files, never an assumed family tier layout. */
export function liveRunnerArgs(family: LiveFamily, platform: NodeJS.Platform, shard?: string): string[] {
  const files = selectedLiveFiles(family, platform, shard);
  const spec: Family = FAMILIES[family];
  const tiers = new Set(files.map((file) => file.startsWith("plugins/") ? "integration" : file.split("/")[1]));
  const args = ["unit", "integration", "e2e"].filter((tier) => tiers.has(tier)).map((tier) => `--${tier}`);
  // Every live family, including ordinary integration/SDK, gets the same
  // independent deadline and shares one work budget with its preflight. The
  // run ceiling is the one-hour Bedrock role session assumed just before the
  // run step, so model work (which stops at the cleanup reserve) always ends
  // while its credentials are valid. Waits end on observed turn state, so a
  // stuck journey fails well before this backstop.
  const ceiling = String(LIVE_RUN_CEILING_SECONDS);
  args.push("--file-timeout", ceiling, "--run-timeout", ceiling);
  if (tiers.has("e2e")) args.push("--isolated-e2e", "--bedrock-parallel", "2", "--e2e-file-timeout", ceiling);
  if (spec.requireCoverage) args.push("--require-coverage");
  if (files.every(requiresProductionGuards)) args.push("--production-guards");
  args.push("--filter", liveFilter(files));
  return args;
}

/** Preserve argument boundaries and keep the discovery-owned selection authoritative. */
export function liveRunnerCommand(family: LiveFamily, platform: NodeJS.Platform, passthrough: readonly string[] = [], shard?: string): string[] {
  const selectors = new Set(["--smoke", "--unit", "--integration", "--e2e", "--ci", "--release", "--all", "--filter", "--shard", "--matrix-plan", "--matrix-job", "--no-llm"]);
  for (const arg of passthrough) {
    if (selectors.has(arg.split("=")[0])) throw new Error(`live file selection cannot be overridden by ${arg}`);
  }
  return [join(REPO_ROOT, "tests/run-tests.ts"), ...passthrough, ...liveRunnerArgs(family, platform, shard)];
}

/** CI control-plane tokens and startup credentials are not agent capabilities. */
export function liveRunnerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  if (env.GITHUB_ACTIONS !== "true") return env;
  for (const key of Object.keys(env)) {
    if (/^(?:BROKER_|ACTIONS_|GH_TOKEN$|GITHUB_TOKEN$|KIRO_API_KEY$|CURSOR_API_KEY$|AWS_ACCESS_KEY_ID$|AWS_SECRET_ACCESS_KEY$|AWS_SESSION_TOKEN$|AWS_WEB_IDENTITY_TOKEN_FILE$|AWS_CONTAINER_CREDENTIALS_|AWS_BEARER_TOKEN_|ANTHROPIC_API_KEY$|ANTHROPIC_AUTH_TOKEN$)/i.test(key)) delete env[key];
  }
  return env;
}

if (import.meta.main) {
  try {
    const [family, ...options] = process.argv.slice(2);
    const matrix = family === "--matrix";
    if (matrix && (!["hosted", "windows"].includes(options[0]) ||
      (options.length !== 1 && !(options.length === 3 && options[1] === "--family") &&
        !(options.length === 5 && options[1] === "--family" && options[3] === "--test")))) {
      throw new Error("expected --matrix hosted|windows [--family FAMILY [--test FILE]]");
    }
    let platform: NodeJS.Platform | undefined;
    let shard: string | undefined;
    let mode: "filter" | "args" | "run" = "filter";
    let passthrough: string[] = [];
    for (let index = 0; !matrix && index < options.length; index++) {
      const option = options[index];
      if (option === "--args" && mode === "filter") mode = "args";
      else if (option === "--run" && mode === "filter") mode = "run";
      else if (option === "--" && mode === "run") {
        passthrough = options.slice(index + 1);
        break;
      } else if (option === "--platform" && !platform && ["linux", "darwin", "win32"].includes(options[index + 1])) {
        platform = options[++index] as NodeJS.Platform;
      } else if (option === "--shard" && shard === undefined && options[index + 1] !== undefined) {
        shard = options[++index];
      } else throw new Error(`invalid option: ${option}`);
    }
    if (matrix) {
      console.log(JSON.stringify(liveMatrix(
        options[0] as "hosted" | "windows", (options[2] ?? "all") as VerificationFamily, options[4] ?? "",
      )));
    } else if (family === "--list" && mode === "filter" && shard === undefined) {
      console.log(JSON.stringify(Object.fromEntries(classifyLiveFiles(REPO_ROOT)), null, 2));
    } else if (Object.hasOwn(FAMILIES, family ?? "")) {
      if (mode === "run") {
        const command = liveRunnerCommand(family as LiveFamily, platform ?? process.platform, passthrough, shard);
        const child = Bun.spawn([process.execPath, ...command], {
          env: liveRunnerEnvironment(process.env),
          cwd: REPO_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit",
        });
        process.exitCode = await child.exited;
      } else {
        console.log(mode === "args"
          ? liveRunnerArgs(family as LiveFamily, platform ?? process.platform, shard).join("\n")
          : liveFilter(selectedLiveFiles(family as LiveFamily, platform ?? process.platform, shard)));
      }
    } else throw new Error(`unknown family: ${family}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Usage: bun scripts/ci-live-filter.ts --matrix hosted|windows [--family ${VERIFICATION_FAMILIES.join("|")} [--test FILE]]\n       bun scripts/ci-live-filter.ts <${Object.keys(FAMILIES).join("|")}|--list> [--platform linux|darwin|win32] [--shard N/M] [--args | --run -- RUNNER_ARGS...]`);
    process.exitCode = 2;
  }
}
