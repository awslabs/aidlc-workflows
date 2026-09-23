import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CI_BEDROCK_MODELS } from "./ci-credential-broker.ts";

/** The credential-bearing startup step exits before any agent or installer runs. */
export function brokerChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(?:BROKER_|AIDLC_BROKER_|AWS_|ANTHROPIC_|CLAUDE_|KIRO_API_KEY$|CURSOR_API_KEY$|GH_TOKEN$|GITHUB_TOKEN$|ACTIONS_)/i.test(key)) delete env[key];
  }
  // Preserve RUNNER_TRACKING_ID so Actions still owns cleanup of the detached broker.
  return env;
}

export async function startBrokerProcess(input: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
}): Promise<{ port: number; account: string; arn: string }> {
  const child = spawn(process.execPath, [join(import.meta.dir, "ci-credential-broker.ts")], {
    cwd: join(import.meta.dir, ".."), env: brokerChildEnvironment(process.env),
    detached: true, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  });
  try {
    const identity = await new Promise<{ port: number; account: string; arn: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Credential broker startup timed out")), 60_000);
      let buffer = "";
      const fail = () => { clearTimeout(timer); reject(new Error("Credential broker startup failed")); };
      child.once("error", fail);
      child.once("exit", fail);
      child.stdin.once("error", fail);
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 4096) { fail(); return; }
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        try {
          const value = JSON.parse(buffer.slice(0, newline));
          if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
            !/^\d{12}$/.test(value.account) || !/^arn:aws:sts::\d{12}:[^\r\n]+$/.test(value.arn)) throw new Error();
          clearTimeout(timer);
          resolve({ port: value.port, account: value.account, arn: value.arn });
        } catch { fail(); }
      });
      child.stdin.end(JSON.stringify(input));
    });
    child.stdout.destroy();
    child.unref();
    return identity;
  } catch (error) {
    child.kill();
    throw error;
  }
}

if (import.meta.main) {
  try {
    const family = process.argv[2];
    if (!["claude-sdk", "claude-tui", "codex", "opencode"].includes(family)) throw new Error("Unsupported broker family");
    const { BROKER_ACCESS_KEY_ID, BROKER_SECRET_ACCESS_KEY, BROKER_SESSION_TOKEN } = process.env;
    if (!BROKER_ACCESS_KEY_ID || !BROKER_SECRET_ACCESS_KEY || !BROKER_SESSION_TOKEN) throw new Error("Broker startup credentials are missing");
    if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required");
    const region = family === "codex" ? "us-east-2" : "us-east-1";
    const identity = await startBrokerProcess({
      accessKeyId: BROKER_ACCESS_KEY_ID, secretAccessKey: BROKER_SECRET_ACCESS_KEY,
      sessionToken: BROKER_SESSION_TOKEN, region,
    });
    const url = `http://127.0.0.1:${identity.port}`;
    const exported: Record<string, string> = {
      AIDLC_BROKER_URL: url,
      AIDLC_BROKER_IDENTITY: JSON.stringify({ account: identity.account, arn: identity.arn }),
      AWS_REGION: region,
    };
    if (family.startsWith("claude-")) {
      Object.assign(exported, CI_BEDROCK_MODELS.claude, {
        CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
        ANTHROPIC_BEDROCK_BASE_URL: url,
      });
    } else {
      exported.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = url;
      const awsDirectory = join(homedir(), ".aws");
      mkdirSync(awsDirectory, { recursive: true, mode: 0o700 });
      const profile = family === "codex" ? "codex" : "broker";
      writeFileSync(join(awsDirectory, "config"),
        `[profile ${profile}]\nregion = ${region}\naws_access_key_id = broker\naws_secret_access_key = broker\n`, { mode: 0o600 });
      if (family === "opencode") exported.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        provider: { "amazon-bedrock": { options: { region, endpoint: url, profile: "broker", accessKeyId: "broker", secretAccessKey: "broker" } } },
      });
    }
    appendFileSync(process.env.GITHUB_ENV, Object.entries(exported).map(([key, value]) => `${key}=${value}\n`).join(""));
    console.log(JSON.stringify(identity));
  } catch {
    console.error("Credential broker startup failed; no credentials were exported");
    process.exitCode = 1;
  }
}
