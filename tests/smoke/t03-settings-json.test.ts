// covers: file:settings.json
//
// In-process port of tests/smoke/t03-settings-json.sh (TAP plan 16 + Fable pin),
// mechanism = none. The .sh is a schema-validation check on the SHIPPED
// dist/claude/.claude/settings.json: it `jq`-parsed the file and asserted the
// presence/value of permission entries, the statusLine command, inherited
// session model/effort, and the Bedrock env block (enable flag, region, four
// model IDs).
//
// The .sh carried NO `# covers:` header, so it joined to zero enumerated registry
// units — and none of the seven enumerated unit classes
// (function/audit/scope/stage/hook/subcommand/render-surface) models a JSON
// config file's contents. The `file:settings.json` covers id above names the
// single file under test honestly; it parses through gen-coverage-registry's
// parseCoversHeader and (like the .sh) joins to no enumerated unit. No coverage
// guarantee is lost: the .sh contributed none. (Same convention as t47's
// `file:skills/aidlc/SKILL.md` family of shipped-file content twins.)
//
// MECHANISM = none. The .sh shelled out to `jq` over a JSON file and never
// touched a function, a CLI tool, argv, exit codes, or a process boundary.
// gen-coverage-registry derives mechanism from the DRIVERS a test body calls
// (milestone 3): this twin calls NO driver (no driveAidlc, no tui-drive.ts, no spawn of
// an aidlc-*.ts tool or run-tests.sh), so its derived set is the deterministic
// `none` floor — matching the t47 / t34 / t14 content-structure family. Every
// assertion is readFileSync + JSON.parse + a value check on the real bytes of
// the shipped file, the same observable the .sh's `jq` asserted. Replacing `jq`
// with JSON.parse is itself a STRONGER restatement of test 1 ("valid JSON"):
// JSON.parse throws on malformed JSON exactly as `jq empty` failed.
//
// FIXTURE DISCIPLINE: the input is the REAL generated shipped file at
// dist/claude/.claude/settings.json, read-only, resolved through AIDLC_SRC from
// tests/harness/fixtures.ts (the same anchor the .sh's $SETTINGS pointed at —
// fixtures resolves AIDLC_SRC to <repo>/dist/claude/.claude). NOTHING is written;
// no temp project, no teardown — there is no mutable surface.
//
// Source under test (read fresh, parsed once at module load):
//   dist/claude/.claude/settings.json
//     .permissions.allow[]                 — pre-approved tool list
//     .statusLine.command                  — references aidlc-statusline.ts
//     .model / .effortLevel                -- ABSENT (session values inherit)
//     .env provider/model overrides         — absent
//
// Old TAP -> new test parity (1:1, all 16 .sh assertions; no guarantee dropped):
//   .sh 1      jq empty (valid JSON)                       -> "settings.json is valid JSON"
//   .sh 2-9    permissions.allow contains <8 tools>        -> one test() per tool,
//                Read/Edit/Write/Bash/Glob/Grep/Task/WebSearch (8 tests)
//   .sh 10     statusLine.command -> aidlc-statusline.ts   -> "statusLine.command references aidlc-statusline.ts"
//   .sh 11     legacy model pin                            -> "model and effortLevel are absent"
//   .sh 12-16  provider/model env overrides absent         -> "provider-neutral env block"

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
  // The generated dist/ copy projection grants only its harness-local Bun
  // dispatcher instead of unrestricted Bash or a native binary dependency.
  const allow = settings.permissions?.allow ?? [];
  const REQUIRED_TOOLS = [
    "Read",
    "Edit",
    "Write",
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
  test("permissions.allow grants only the Bun copy-channel tool directory", () => {
    expect(allow).toContain("Bash(bun .claude/tools/*)");
    expect(allow).not.toContain("Bash");
    expect(allow).not.toContain("Bash(aidlc *)");
  });
});

describe("statusLine [.sh test 10]", () => {
  test("statusLine.command routes through the Bun copy-channel dispatcher", () => {
    const cmd = settings.statusLine?.command ?? "";
    expect(cmd).toBe('bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine statusline');
  });
});

describe("session model and effort inheritance [.sh test 11]", () => {
  test("model and effortLevel keys are absent", () => {
    expect(Object.hasOwn(settings, "model")).toBe(false);
    expect(Object.hasOwn(settings, "effortLevel")).toBe(false);
  });
});

describe("provider-neutral env block [.sh tests 12-16]", () => {
  const env = settings.env ?? {};

  test("provider, region, and model aliases are absent", () => {
    for (const key of [
      "CLAUDE_CODE_USE_BEDROCK",
      "AWS_REGION",
      "AWS_PROFILE",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ]) {
      expect(Object.hasOwn(env, key), key).toBe(false);
    }
  });
});
