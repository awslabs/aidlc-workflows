import { mkdirSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { CI_BEDROCK_MODELS } from "./ci-credential-broker.ts";
import { FAMILIES, LIVE_RUN_CEILING_SECONDS, liveCeiling, selectedLiveFiles, type LiveFamily } from "./ci-live-filter.ts";

/** Validate before runtime setup and forward each selector as a separate argument. */
export function sandboxCommand(family: LiveFamily, platform: NodeJS.Platform, shard?: string, ceilingSeconds?: number): string[] {
  selectedLiveFiles(family, platform, shard);
  return [process.execPath, "scripts/ci-live-filter.ts", family, "--platform", platform,
    ...(shard === undefined ? [] : ["--shard", shard]),
    ...(ceilingSeconds === undefined ? [] : ["--ceiling", String(liveCeiling(String(ceilingSeconds)))]),
    "--run", "--", "--debug", "-P", "8"];
}

// A model-driven journey can fail once for reasons the same code does not
// repeat. With about 190 live legs a run, one such failure each would keep the
// suite red, so a failed model shard runs once more. It passes only if the
// second attempt passes, and that is recorded as a flake; a real defect fails
// twice. The retry must end inside the one-hour credential session the run
// step starts with, so it runs only after a short first attempt and gets the
// time that remains. The deterministic release contract never retries.
export const RETRY_FAMILIES: ReadonlySet<LiveFamily> = new Set(["claude-sdk", "claude-tui", "codex", "opencode"]);
export const LIVE_RETRY_MAX_FIRST_ATTEMPT_SECONDS = 25 * 60;
export const LIVE_RETRY_RESERVE_SECONDS = 5 * 60;

/** The retry's ceiling after a failed first attempt, or null when no retry fits. */
export function liveRetryCeiling(family: LiveFamily, firstAttemptSeconds: number): number | null {
  if (!RETRY_FAMILIES.has(family) || firstAttemptSeconds > LIVE_RETRY_MAX_FIRST_ATTEMPT_SECONDS) return null;
  return Math.floor(LIVE_RUN_CEILING_SECONDS - firstAttemptSeconds - LIVE_RETRY_RESERVE_SECONDS);
}

export interface LiveRetryRecord {
  family: LiveFamily;
  platform: NodeJS.Platform;
  shard: string | null;
  outcome: "passed" | "passed-on-retry" | "failed-twice" | "failed-without-retry";
  attempts: Array<{ exitCode: number; seconds: number; ceilingSeconds: number }>;
}

/** Run a shard, and once more after a short failed attempt; the last exit code decides. */
export async function runWithRetry(
  family: LiveFamily, platform: NodeJS.Platform, shard: string | undefined,
  attempt: (ceilingSeconds: number) => Promise<number>, now: () => number = Date.now,
): Promise<{ exitCode: number; record: LiveRetryRecord }> {
  const attempts: LiveRetryRecord["attempts"] = [];
  const timed = async (ceilingSeconds: number): Promise<number> => {
    const started = now();
    const exitCode = await attempt(ceilingSeconds);
    attempts.push({ exitCode, seconds: Math.round((now() - started) / 1000), ceilingSeconds });
    return exitCode;
  };
  const first = await timed(LIVE_RUN_CEILING_SECONDS);
  const record = (outcome: LiveRetryRecord["outcome"]): LiveRetryRecord =>
    ({ family, platform, shard: shard ?? null, outcome, attempts });
  if (first === 0) return { exitCode: 0, record: record("passed") };
  const ceiling = liveRetryCeiling(family, attempts[0].seconds);
  if (ceiling === null) return { exitCode: first, record: record("failed-without-retry") };
  console.log(`Live ${family} shard ${shard ?? "all"} failed once (exit ${first}) after ${attempts[0].seconds}s; retrying once with a ${ceiling}s ceiling.`);
  const second = await timed(ceiling);
  if (second === 0) {
    console.log(`::warning title=Flaky live test::${family} ${platform} shard ${shard ?? "all"} failed once and passed on retry; see tests/logs/live-retry-*.json`);
    return { exitCode: 0, record: record("passed-on-retry") };
  }
  return { exitCode: second, record: record("failed-twice") };
}

/** Values are explicit and nonsecret; nothing is inherited from the runner identity. */
export function sandboxEnvironment(family: LiveFamily, home: string, path: string, source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { HOME: home, PATH: path, TERM: "xterm-256color", GITHUB_ACTIONS: "true", AIDLC_TEST_PACKAGE_READY: "1", ...FAMILIES[family].env };
  if (/^[A-Za-z]:[\\/]/.test(home)) {
    Object.assign(env, {
      USERPROFILE: home, TEMP: join(home, "temp"), TMP: join(home, "temp"),
      APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
    if (family === "codex" && source.AIDLC_CODEX_BIN !== undefined) {
      const managed = win32.join(win32.dirname(home), "tools", "codex-managed.exe");
      if (source.AIDLC_CODEX_BIN.toLowerCase() !== managed.toLowerCase()) {
        throw new Error("Expected the sealed native Codex launcher");
      }
      env.AIDLC_CODEX_BIN = managed;
    }
  } else {
    Object.assign(env, { TMPDIR: join(home, "tmp"), BUN_INSTALL: join(home, ".bun"), XDG_CACHE_HOME: join(home, ".cache") });
  }
  if (family === "release-contract") return env;
  const url = new URL(source.AIDLC_BROKER_URL ?? "");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Expected loopback credential broker");
  }
  const identity = JSON.parse(source.AIDLC_BROKER_IDENTITY ?? "{}");
  if (!/^\d{12}$/.test(identity.account) || typeof identity.arn !== "string" || !identity.arn.startsWith(`arn:aws:sts::${identity.account}:assumed-role/`)) {
    throw new Error("Expected verified broker identity");
  }
  env.AIDLC_BROKER_URL = url.origin;
  env.AIDLC_BROKER_IDENTITY = JSON.stringify({ account: identity.account, arn: identity.arn });
  if (family.startsWith("claude-")) {
    Object.assign(env, CI_BEDROCK_MODELS.claude, {
      CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1", ANTHROPIC_BEDROCK_BASE_URL: url.origin,
    });
  } else if (family === "opencode") {
    env.AWS_PROFILE = "broker";
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { "amazon-bedrock": { options: {
      region: "us-east-1", endpoint: url.origin, profile: "broker", accessKeyId: "broker", secretAccessKey: "broker",
    } } } });
  }
  return env;
}

if (import.meta.main) {
  try {
    const [family, platform, shard, ...extra] = process.argv.slice(2);
    if (extra.length || !["claude-sdk", "claude-tui", "codex", "opencode", "release-contract"].includes(family) || !["linux", "darwin", "win32"].includes(platform)) {
      throw new Error("Unsupported sandbox family/platform");
    }
    const command = sandboxCommand(family as LiveFamily, platform as NodeJS.Platform, shard);
    const home = process.env.HOME!;
    const path = process.env.PATH!;
    const env = sandboxEnvironment(family as LiveFamily, home, path, process.env);
    for (const key of ["TEMP", "APPDATA", "LOCALAPPDATA"]) if (env[key]) mkdirSync(env[key], { recursive: true });
    if (family === "codex" || family === "opencode") {
      mkdirSync(join(home, ".aws"), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, ".aws/config"), `[profile ${family === "codex" ? "codex" : "broker"}]\nregion = ${family === "codex" ? "us-east-2" : "us-east-1"}\naws_access_key_id = broker\naws_secret_access_key = broker\n`, { mode: 0o600 });
    }
    process.chdir(process.env.AIDLC_LIVE_ROOT || join(home, "workspace"));
    const { exitCode, record } = await runWithRetry(family as LiveFamily, platform as NodeJS.Platform, shard, (ceiling) => {
      const argv = ceiling === LIVE_RUN_CEILING_SECONDS ? command
        : sandboxCommand(family as LiveFamily, platform as NodeJS.Platform, shard, ceiling);
      return Bun.spawn(argv, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
    });
    // The collectors upload tests/logs whole, so the record travels with the evidence.
    if (record.outcome !== "passed") {
      mkdirSync("tests/logs", { recursive: true });
      const slug = `${family}-${platform}-${(shard ?? "all").replace("/", "of")}`;
      writeFileSync(join("tests/logs", `live-retry-${slug}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }
    process.exitCode = exitCode;
  } catch {
    console.error("Isolated live runtime rejected its configuration");
    process.exitCode = 1;
  }
}
