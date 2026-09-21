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

/** Qualify tiers (and plugin names) to avoid collisions in all three runner aliases. */
export function liveFilter(files: readonly string[], platform?: NodeJS.Platform): string {
  const selected = files.filter((file) => !platform || !PLATFORM_ONLY[file] || PLATFORM_ONLY[file].includes(platform));
  const names = selected.map((file) => {
    const parts = file.replaceAll("\\", "/").split("/");
    const name = basename(file, ".test.ts");
    const qualified = parts[0] === "plugins" ? `plugins-plugin-${parts[1]}-${name}` : `${parts[1]}-${name}`;
    return qualified.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return names.length === 0 ? "^(?!)$" : `^(?:${names.join("|")})$`;
}

/** Runner modes follow the selected files, never an assumed family tier layout. */
export function liveRunnerArgs(family: LiveFamily, platform: NodeJS.Platform): string[] {
  const spec: Family = FAMILIES[family];
  if (!spec.platforms.includes(platform)) throw new Error(`${family} does not support ${platform}`);
  const files = classifyLiveFiles(REPO_ROOT).get(family)!
    .filter((file) => !PLATFORM_ONLY[file] || PLATFORM_ONLY[file].includes(platform));
  if (!files.length) throw new Error(`${family} has no selected files on ${platform}`);
  const tiers = new Set(files.map((file) => file.startsWith("plugins/") ? "integration" : file.split("/")[1]));
  const args = ["unit", "integration", "e2e"].filter((tier) => tiers.has(tier)).map((tier) => `--${tier}`);
  if (tiers.has("e2e")) args.push("--isolated-e2e", "--bedrock-parallel", "2");
  if (spec.requireCoverage) args.push("--require-coverage");
  args.push("--filter", liveFilter(files));
  return args;
}

/** Preserve argument boundaries and keep the discovery-owned selection authoritative. */
export function liveRunnerCommand(family: LiveFamily, platform: NodeJS.Platform, passthrough: readonly string[] = []): string[] {
  return [join(REPO_ROOT, "tests/run-tests.ts"), ...passthrough, ...liveRunnerArgs(family, platform)];
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
    let platform: NodeJS.Platform | undefined;
    let mode: "filter" | "args" | "run" = "filter";
    let passthrough: string[] = [];
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      if (option === "--args" && mode === "filter") mode = "args";
      else if (option === "--run" && mode === "filter") mode = "run";
      else if (option === "--" && mode === "run") {
        passthrough = options.slice(index + 1);
        break;
      } else if (option === "--platform" && !platform && ["linux", "darwin", "win32"].includes(options[index + 1])) {
        platform = options[++index] as NodeJS.Platform;
      } else throw new Error(`invalid option: ${option}`);
    }
    if (family === "--list" && mode === "filter") {
      console.log(JSON.stringify(Object.fromEntries(classifyLiveFiles(REPO_ROOT)), null, 2));
    } else if (Object.hasOwn(FAMILIES, family ?? "")) {
      if (mode === "run") {
        const command = liveRunnerCommand(family as LiveFamily, platform ?? process.platform, passthrough);
        const child = Bun.spawn([process.execPath, ...command], {
          env: liveRunnerEnvironment(process.env),
          cwd: REPO_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit",
        });
        process.exitCode = await child.exited;
      } else {
        console.log(mode === "args"
          ? liveRunnerArgs(family as LiveFamily, platform ?? process.platform).join("\n")
          : liveFilter(classifyLiveFiles(REPO_ROOT).get(family as LiveFamily)!, platform));
      }
    } else throw new Error(`unknown family: ${family}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Usage: bun scripts/ci-live-filter.ts <${Object.keys(FAMILIES).join("|")}|--list> [--platform linux|darwin|win32] [--args | --run -- RUNNER_ARGS...]`);
    process.exitCode = 2;
  }
}
