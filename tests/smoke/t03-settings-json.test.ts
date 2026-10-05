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
//   .sh 2-9    permissions.allow contains <8 tools>        -> one test() per entry,
//                Edit(/**)/Task/WebSearch (3 tests), plus "file entries stay
//                inside the project" (no bare Read/Edit/Write/Glob/Grep)
//   .sh 10     statusLine.command -> aidlc-statusline.ts   -> "statusLine.command references aidlc-statusline.ts"
//   .sh 11     legacy model pin                            -> "model and effortLevel are absent"
//   .sh 12-16  provider/model env overrides absent         -> "provider-neutral env block"

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SECTIONS } from "../../core/tools/aidlc-command.ts";
import { copyChannelDispatcherCommands, copyChannelToolScripts, ROUTES } from "../../core/tools/aidlc.ts";
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
  // `Edit(/**)` is anchored at the project root in project settings and
  // covers both Edit and Write; reads and searches inside the project need no
  // entry.
  const REQUIRED_TOOLS = [
    "Edit(/**)",
    "Task",
    "WebSearch",
  ];
  for (const tool of REQUIRED_TOOLS) {
    test(`permissions.allow contains ${tool}`, () => {
      expect(Array.isArray(allow)).toBe(true);
      expect(allow).toContain(tool);
    });
  }
  test("file entries stay inside the project", () => {
    for (const bare of ["Read", "Edit", "Write", "Glob", "Grep"]) {
      expect(allow).not.toContain(bare);
    }
    const fileEntries = allow.filter((entry) => /^(Read|Edit|Write|Glob|Grep)\(/.test(entry));
    expect(fileEntries).toEqual(["Edit(/**)"]);
  });
  // The copy channel lists AI-DLC's own commands one by one, each spelled as
  // AI-DLC runs it, so a longer name or a machine-wide change matches none.
  test("permissions.allow lists AI-DLC's own commands exactly on the copy channel", () => {
    expect(allow).toEqual([
      "Edit(/**)",
      "Bash(bun .claude/tools/aidlc.ts engine *)",
      ...copyChannelDispatcherCommands().map((command) => `Bash(bun .claude/tools/aidlc.ts ${command})`),
      ...copyChannelToolScripts().flatMap((script) => [
        `Bash(bun .claude/tools/${script})`,
        `Bash(bun .claude/tools/${script} *)`,
      ]),
      "Task",
      "WebSearch",
    ]);
    expect(settings.permissions).not.toHaveProperty("ask");
  });

  // Claude Code's Bash rules: `*` matches any sequence; a command no rule
  // names shows Claude Code's own prompt.
  function claudeBashEffect(command: string): "allow" | "prompt" {
    return allow.some((rule) => {
      const m = /^Bash\((.*)\)$/.exec(rule);
      if (!m) return false;
      const glob = m[1].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
      return new RegExp(`^${glob}$`).test(command);
    })
      ? "allow"
      : "prompt";
  }

  test("a command that changes the machine's AI-DLC install, or any setting, shows Claude Code's own prompt", () => {
    for (const command of [
      "bun .claude/tools/aidlc.ts use 2.10.0",
      "bun .claude/tools/aidlc.ts update",
      "bun .claude/tools/aidlc.ts update --check",
      "bun .claude/tools/aidlc.ts rollback",
      "bun .claude/tools/aidlc.ts uninstall --yes",
      "bun .claude/tools/aidlc.ts system config global set offline true",
      "bun .claude/tools/aidlc.ts --yes update",
      // The scripts behind those commands.
      "bun .claude/tools/aidlc-lifecycle.ts use 2.10.0",
      "bun .claude/tools/aidlc-lifecycle.ts",
      "bun .claude/tools/aidlc-machine-config.ts set offline true",
      "bun .claude/tools/aidlc-init.ts --pin 2.10.0",
      "bun .claude/tools/aidlc-doctor.ts",
      // Every config change, however its flags are spelled.
      "bun .claude/tools/aidlc.ts config --pin 2.10.0",
      "bun .claude/tools/aidlc.ts config --unpin",
      "bun .claude/tools/aidlc.ts config --channel",
      "bun .claude/tools/aidlc.ts config --channel preview",
      "bun .claude/tools/aidlc.ts config project --plugins all --download --yes",
      "bun .claude/tools/aidlc.ts config models --deciding-effort high --global --yes",
      "bun .claude/tools/aidlc.ts config models --gl\"obal\" --yes",
      "bun .claude/tools/aidlc.ts config models --deciding-effort high --project --yes",
      "bun .claude/tools/aidlc.ts config depth --depth minimal --yes",
      "bun .claude/tools/aidlc.ts config models --show --json --global",
      // A longer file name than any AI-DLC script.
      "bun .claude/tools/aidlc-log.tsx",
      "bun .claude/tools/aidlc-log.ts.bak run",
    ]) {
      expect(claudeBashEffect(command), command).toBe("prompt");
    }
  });

  // Every script behind a route that can change the machine prompts, so a new
  // one cannot slip in.
  test("the scripts behind every machine-changing command prompt", () => {
    const machine = new Set(
      ROUTES.filter((route) => route.mutationScope === "machine" || route.mutationScope === "project-and-machine")
        .map((route) => route.tool)
        .filter((tool): tool is string => tool !== undefined),
    );
    expect(machine.size).toBeGreaterThan(0);
    for (const tool of machine) {
      expect(claudeBashEffect(`bun .claude/tools/${tool}`), tool).toBe("prompt");
      expect(claudeBashEffect(`bun .claude/tools/${tool} x`), tool).toBe("prompt");
    }
  });

  test("AI-DLC's own commands, the ones its skill and stage files name included, run with no prompt", () => {
    for (const command of [
      "bun .claude/tools/aidlc.ts engine orchestrate next",
      "bun .claude/tools/aidlc.ts engine orchestrate report --stage requirements-analysis --result approved --user-input 'Approve (Recommended)'",
      "bun .claude/tools/aidlc.ts config providers --show --json",
      "bun .claude/tools/aidlc.ts --doctor",
      "bun .claude/tools/aidlc-utility.ts codekb-path",
      "bun .claude/tools/aidlc-utility.ts",
      "bun .claude/tools/aidlc.ts engine now",
    ]) {
      expect(claudeBashEffect(command), command).toBe("allow");
    }
    // Every AI-DLC command the copy tree's prose tells the agent to run.
    const named = new Set<string>();
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) visit(path);
        else if (name.endsWith(".md")) {
          for (const [, span] of readFileSync(path, "utf-8").matchAll(/`(bun \.claude\/tools\/aidlc[^`\s]*\.ts [^`\n]+)`/g)) {
            named.add(span);
          }
        }
      }
    };
    visit(AIDLC_SRC);
    expect(named.size).toBeGreaterThan(20);
    // A config change is the person's to approve in Claude Code's prompt; its
    // read-only forms run as they are, for every section.
    const configChange = (command: string) =>
      /^bun \.claude\/tools\/aidlc\.ts config\b/.test(command) && !/ --(?:show --json|help)$/.test(command);
    // The skill names the command-line tool's own help only as the command not
    // to run ("`--help` goes here too ... is the command-line tool's own help,
    // not the AI-DLC help the person asked for"), so it needs no entry.
    named.delete("bun .claude/tools/aidlc.ts --help");
    for (const span of named) {
      const commands = span.includes("<section>")
        ? CONFIG_SECTIONS.map((section) => span.replace("<section>", section))
        : [span];
      for (const command of commands) {
        expect(claudeBashEffect(command), command).toBe(configChange(command) ? "prompt" : "allow");
      }
    }
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
