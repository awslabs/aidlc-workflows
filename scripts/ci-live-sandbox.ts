import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CI_BEDROCK_MODELS } from "./ci-credential-broker.ts";
import { FAMILIES, type LiveFamily } from "./ci-live-filter.ts";

/** Values are explicit and nonsecret; nothing is inherited from the runner identity. */
export function sandboxEnvironment(family: LiveFamily, home: string, path: string, source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { HOME: home, PATH: path, TERM: "xterm-256color", GITHUB_ACTIONS: "true", AIDLC_TEST_PACKAGE_READY: "1", ...FAMILIES[family].env };
  if (/^[A-Za-z]:[\\/]/.test(home)) {
    Object.assign(env, {
      USERPROFILE: home, TEMP: join(home, "temp"), TMP: join(home, "temp"),
      APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
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
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { "amazon-bedrock": { options: {
      region: "us-east-1", endpoint: url.origin, profile: "broker", accessKeyId: "broker", secretAccessKey: "broker",
    } } } });
  }
  return env;
}

if (import.meta.main) {
  try {
    const [family, platform] = process.argv.slice(2);
    if (!["claude-sdk", "claude-tui", "codex", "opencode", "release-contract"].includes(family) || !["linux", "darwin", "win32"].includes(platform)) {
      throw new Error("Unsupported sandbox family/platform");
    }
    const home = process.env.HOME!;
    const path = process.env.PATH!;
    const env = sandboxEnvironment(family as LiveFamily, home, path, process.env);
    for (const key of ["TEMP", "APPDATA", "LOCALAPPDATA"]) if (env[key]) mkdirSync(env[key], { recursive: true });
    if (family === "codex" || family === "opencode") {
      mkdirSync(join(home, ".aws"), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, ".aws/config"), `[profile ${family === "codex" ? "codex" : "broker"}]\nregion = ${family === "codex" ? "us-east-2" : "us-east-1"}\naws_access_key_id = broker\naws_secret_access_key = broker\n`, { mode: 0o600 });
    }
    process.chdir(process.env.AIDLC_LIVE_ROOT || join(home, "workspace"));
    const child = Bun.spawn([process.execPath, "scripts/ci-live-filter.ts", family, "--platform", platform, "--run", "--", "--debug", "-P", "4"], {
      env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    process.exitCode = await child.exited;
  } catch {
    console.error("Isolated live runtime rejected its configuration");
    process.exitCode = 1;
  }
}
