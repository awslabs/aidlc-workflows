import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { codexBedrockEndpointConfig, codexWindowsSandboxConfig, setupCodexProject } from "../harness/exec-drive.ts";

test("Codex broker endpoint stays in the provider table and rejects non-loopback destinations", () => {
  const config = parse([
    ...codexBedrockEndpointConfig({ AIDLC_BROKER_URL: "http://127.0.0.1:4321/" }),
    "[model_providers.amazon-bedrock.aws]",
    'profile = "codex"',
    'region = "us-east-2"',
  ].join("\n"));
  expect(config.model_providers).toEqual({
    "amazon-bedrock": { base_url: "http://127.0.0.1:4321/openai/v1", aws: { profile: "codex", region: "us-east-2" } },
  });
  expect(codexBedrockEndpointConfig({})).toEqual([]);
  for (const value of ["https://example.com", "http://user@127.0.0.1:4321", "http://127.0.0.1:4321/path", "http://127.0.0.1:4321/?q=1"]) {
    expect(() => codexBedrockEndpointConfig({ AIDLC_BROKER_URL: value })).toThrow();
  }
});

test("every bespoke Codex home selects the broker and excludes its environment from shell tools", () => {
  const directory = join(import.meta.dir, "../e2e");
  const writers = readdirSync(directory).filter((file) => file.startsWith("t-exec-codex-"))
    .map((file) => ({ file, body: readFileSync(join(directory, file), "utf8") }))
    .filter(({ body }) => body.includes("[model_providers.amazon-bedrock.aws]"));
  expect(writers.length).toBeGreaterThan(0);
  for (const { file, body } of writers) {
    expect(body, file).toContain("...codexBedrockEndpointConfig()");
    expect(body, file).toContain('exclude = ["AWS_*", "AIDLC_BROKER_*"');
  }
});

test("native Windows sandbox selection preserves workspace permissions and provider configuration", () => {
  const base = [
    'sandbox_mode = "workspace-write"',
    'model_provider = "amazon-bedrock"',
    '[sandbox_workspace_write]',
    'writable_roots = ["C:\\\\test\\\\.codex"]',
    "network_access = true",
  ].join("\n");
  for (const platform of ["linux", "darwin", "win32"] as const) {
    const config = parse([base, ...codexWindowsSandboxConfig(platform)].join("\n"));
    expect(config.sandbox_mode).toBe("workspace-write");
    expect(config.model_provider).toBe("amazon-bedrock");
    expect(config.sandbox_workspace_write).toEqual({
      writable_roots: ["C:\\test\\.codex"],
      network_access: true,
    });
    if (platform === "win32") expect(config.windows).toEqual({ sandbox: "elevated" });
    else expect(config.windows).toBeUndefined();
  }
});

test("the generated Codex profile parses and trusts the exact native project path", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-exec-profile-"));
  // Native Windows supplies backslashes. On POSIX also exercise characters
  // requiring TOML escaping, instead of letting a slash-only path hide the bug.
  const parent = join(root, process.platform === "win32" ? "space ü" : 'space "quoted" segment');
  mkdirSync(parent);
  const original = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  Object.assign(process.env, { TMPDIR: parent, TMP: parent, TEMP: parent });
  try {
    const project = setupCodexProject();
    const config = parse(readFileSync(join(project.home, "config.toml"), "utf8"));
    const projects = config.projects as Record<string, { trust_level: string }>;
    expect(projects[project.proj]).toEqual({ trust_level: "trusted" });
    expect(config.model_provider).toBe("amazon-bedrock");
    expect(config.model).toBe("openai.gpt-5.5");
    expect(config.shell_environment_policy).toEqual({
      exclude: ["AWS_*", "AIDLC_BROKER_*", "ANTHROPIC_*", "KIRO_API_KEY", "CURSOR_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "ACTIONS_*"],
      set: { AIDLC_RULES_DIR: ".codex/aidlc-rules" },
    });
    if (process.platform === "win32") expect(config.windows).toEqual({ sandbox: "elevated" });
    else expect(config.windows).toBeUndefined();
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
