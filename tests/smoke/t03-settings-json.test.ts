// covers: file:settings.json
//
// Structural check on the real shipped Claude settings. AI-DLC owns its hooks,
// permissions, statusline, and default workflow scope; Claude Code owns the
// user's provider, model, region, and reasoning-effort selections.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const SETTINGS_PATH = join(AIDLC_SRC, "settings.json");
const RAW = readFileSync(SETTINGS_PATH, "utf-8");

// .sh test 1: `jq empty "$SETTINGS"` succeeded => valid JSON. JSON.parse throws
// on malformed JSON, so a successful parse here IS the "valid JSON" assertion;
// the test below also asserts it does not throw, making the guarantee explicit.
interface Settings {
  permissions?: { allow?: string[] };
  statusLine?: { command?: string };
  model?: string;
  effortLevel?: string;
  env?: Record<string, string>;
}
const settings: Settings = JSON.parse(RAW);

describe("settings.json — JSON validity [.sh test 1]", () => {
  test("settings.json is valid JSON", () => {
    // JSON.parse throws SyntaxError on invalid JSON exactly as `jq empty`
    // returned non-zero; re-parsing inside the assertion makes the contract
    // observable rather than relying on the module-load parse alone.
    expect(() => JSON.parse(RAW)).not.toThrow();
    expect(typeof settings).toBe("object");
    expect(settings).not.toBeNull();
  });
});

describe("permissions.allow — pre-approved tool list [.sh tests 2-9]", () => {
  // The .sh looped `for tool in Read Edit Write Bash Glob Grep Task WebSearch`
  // and grepped each as an EXACT line (`grep -c "^${tool}$"`) in the allow
  // array. STRONGER here: assert exact membership in the parsed array, so a
  // tool that only appeared as a substring (e.g. inside
  // `Bash(bun .../tools/*)`) would NOT satisfy it — matching the .sh's
  // anchored `^...$` grep, which the bare `Bash` entry on its own line passes.
  const allow = settings.permissions?.allow ?? [];
  const REQUIRED_TOOLS = [
    "Read",
    "Edit",
    "Write",
    "Bash",
    "Glob",
    "Grep",
    "Task",
    "WebSearch",
  ];
  for (const tool of REQUIRED_TOOLS) {
    test(`permissions.allow contains ${tool}`, () => {
      expect(Array.isArray(allow)).toBe(true);
      expect(allow).toContain(tool);
    });
  }
});

describe("statusLine [.sh test 10]", () => {
  test("statusLine.command references aidlc-statusline.ts", () => {
    const cmd = settings.statusLine?.command ?? "";
    expect(cmd).toContain("aidlc-statusline.ts");
  });
});

describe("provider-neutral defaults", () => {
  const env = settings.env ?? {};

  test("model and effort inherit the user's Claude Code configuration", () => {
    expect(settings.model).toBeUndefined();
    expect(settings.effortLevel).toBeUndefined();
  });

  test("env contains only the AI-DLC workflow scope", () => {
    expect(env).toEqual({ AWS_AIDLC_DEFAULT_SCOPE: "classic" });
  });

  test("env does not redirect Claude through a project-selected provider", () => {
    for (const key of [
      "CLAUDE_CODE_USE_BEDROCK",
      "AWS_REGION",
      "AWS_PROFILE",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ]) {
      expect(env[key], key).toBeUndefined();
    }
  });
});
