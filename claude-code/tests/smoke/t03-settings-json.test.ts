// covers: file:settings.json
//
// In-process port of tests/smoke/t03-settings-json.sh (TAP plan 16),
// mechanism = none. The .sh is a schema-validation check on the SHIPPED
// dist/claude/.claude/settings.json: it `jq`-parsed the file and asserted the
// presence/value of permission entries, the statusLine command, the orchestrator
// model pin, and the Bedrock env block (enable flag, region, three model IDs).
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
// FIXTURE DISCIPLINE: the input is the REAL committed shipped file at
// dist/claude/.claude/settings.json, read-only, resolved through AIDLC_SRC from
// tests/harness/fixtures.ts (the same anchor the .sh's $SETTINGS pointed at —
// fixtures resolves AIDLC_SRC to <repo>/dist/claude/.claude). NOTHING is written;
// no temp project, no teardown — there is no mutable surface.
//
// Source under test (read fresh, parsed once at module load):
//   dist/claude/.claude/settings.json
//     .permissions.allow[]                 — pre-approved tool list
//     .statusLine.command                  — references aidlc-statusline.ts
//     .model                               — "opus[1m]" orchestrator pin
//     .env.CLAUDE_CODE_USE_BEDROCK         — "1" (Bedrock enabled)
//     .env.AWS_REGION                      — non-empty (Bedrock requires it)
//     .env.ANTHROPIC_DEFAULT_OPUS_MODEL    — "us.anthropic.claude-opus-4-8"
//     .env.ANTHROPIC_DEFAULT_SONNET_MODEL  — "us.anthropic.claude-sonnet-4-6"
//     .env.ANTHROPIC_DEFAULT_HAIKU_MODEL   — "us.anthropic.claude-haiku-4-5-20251001-v1:0"
//
// Old TAP -> new test parity (1:1, all 16 .sh assertions; no guarantee dropped):
//   .sh 1      jq empty (valid JSON)                       -> "settings.json is valid JSON"
//   .sh 2-9    permissions.allow contains <8 tools>        -> one test() per tool,
//                Read/Edit/Write/Bash/Glob/Grep/Task/WebSearch (8 tests)
//   .sh 10     statusLine.command -> aidlc-statusline.ts   -> "statusLine.command references aidlc-statusline.ts"
//   .sh 11     model == opus[1m]                           -> "model is pinned to opus[1m]"
//   .sh 12     env.CLAUDE_CODE_USE_BEDROCK == 1            -> "env.CLAUDE_CODE_USE_BEDROCK is 1"
//   .sh 13     env.AWS_REGION non-empty                    -> "env.AWS_REGION is set"
//   .sh 14     env.ANTHROPIC_DEFAULT_OPUS_MODEL pinned     -> "env.ANTHROPIC_DEFAULT_OPUS_MODEL is pinned"
//   .sh 15     env.ANTHROPIC_DEFAULT_SONNET_MODEL pinned   -> "env.ANTHROPIC_DEFAULT_SONNET_MODEL is pinned"
//   .sh 16     env.ANTHROPIC_DEFAULT_HAIKU_MODEL pinned    -> "env.ANTHROPIC_DEFAULT_HAIKU_MODEL is pinned"

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

describe("orchestrator model pin [.sh test 11]", () => {
  test("model is pinned to opus[1m]", () => {
    // .sh asserted exact string equality (`[ "$MODEL" = "opus[1m]" ]`).
    expect(settings.model).toBe("opus[1m]");
  });
});

describe("Bedrock env block [.sh tests 12-16]", () => {
  const env = settings.env ?? {};

  test("env.CLAUDE_CODE_USE_BEDROCK is 1 [.sh test 12]", () => {
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });

  test("env.AWS_REGION is set [.sh test 13]", () => {
    // .sh asserted non-empty (`[ -n "$AWS_REGION_VAL" ]`) — Bedrock requires
    // a region; Claude Code does not read it from ~/.aws.
    expect(typeof env.AWS_REGION).toBe("string");
    expect((env.AWS_REGION ?? "").length).toBeGreaterThan(0);
  });

  test("env.ANTHROPIC_DEFAULT_OPUS_MODEL is pinned [.sh test 14]", () => {
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("us.anthropic.claude-opus-4-8");
  });

  test("env.ANTHROPIC_DEFAULT_SONNET_MODEL is pinned [.sh test 15]", () => {
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      "us.anthropic.claude-sonnet-4-6",
    );
  });

  test("env.ANTHROPIC_DEFAULT_HAIKU_MODEL is pinned [.sh test 16]", () => {
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });
});
