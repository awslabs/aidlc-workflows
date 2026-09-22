import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { codexWindowsSandboxConfig, setupCodexProject } from "../harness/exec-drive.ts";

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
}, 30_000);
