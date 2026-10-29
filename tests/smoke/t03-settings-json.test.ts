// covers: file:settings.json, file:tools/data/scope-grid.json, file:tools/data/stage-graph.json
//
// Schema-validation check on the SHIPPED dist/claude/.claude/settings.json: the
// permission entries, and the absence of a statusLine, a session model/effort,
// and provider/model env overrides.
//
// None of the seven enumerated unit classes
// (function/audit/scope/stage/hook/subcommand/render-surface) models a JSON
// config file's contents. The `file:settings.json` covers id above names the
// single file under test honestly; it parses through gen-coverage-registry's
// parseCoversHeader and joins to no enumerated unit. (Same convention as t47's
// `file:skills/aidlc/SKILL.md` family of shipped-file content twins.)
//
// MECHANISM = none. gen-coverage-registry derives mechanism from the DRIVERS a
// test body calls: this test calls NO driver (no driveAidlc, no tui-drive.ts,
// no spawn of an aidlc-*.ts tool or run-tests.sh), so its derived set is the
// deterministic `none` floor. Every assertion is readFileSync + JSON.parse + a
// value check on the real bytes of the shipped file; JSON.parse throws on
// malformed JSON, which is the "valid JSON" assertion.
//
// FIXTURE DISCIPLINE: the input is the REAL generated shipped file at
// dist/claude/.claude/settings.json, read-only, resolved through AIDLC_SRC from
// tests/harness/fixtures.ts. NOTHING is written; no temp project, no teardown -
// there is no mutable surface.
//
// Source under test (read fresh, parsed once at module load):
//   dist/claude/.claude/settings.json
//     .permissions.allow[]                 — pre-approved tool list
//     .statusLine                          -- ABSENT (AI-DLC's status line is each
//                                             person's choice, #1407; its value ships
//                                             in tools/data/harness.json)
//     .model / .effortLevel                -- ABSENT (session values inherit)
//     .env provider/model overrides         — absent
//     .companyAnnouncements[0]              — the welcome message; its Scopes
//                                             table is checked against the
//                                             compiled grid and stage graph
//                                             under tools/data/

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SECTIONS } from "../../core/tools/aidlc-command.ts";
import { copyChannelDispatcherCommands, copyChannelToolScripts, ROUTES } from "../../core/tools/aidlc.ts";
import { RECORDABLE_PROJECT_BYPASSES } from "../../core/tools/aidlc-settings.ts";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";

// Every read form agents were seen running for "show my settings", "what
// version", "is my setup healthy" and "what is my status", pinned on their own
// so the list cannot lose one.
const SEEN_READ_FORMS = [
  "--status",
  "--version",
  "version",
  "config --help",
  "doctor",
  "--doctor",
  "doctor --verbose",
  "--doctor --verbose",
  "config --show",
  "config --show --json",
  ...CONFIG_SECTIONS.flatMap((section) => [
    `config ${section} --show`,
    `config ${section} --show --json`,
    `config ${section} --help`,
  ]),
];

const SETTINGS_PATH = join(AIDLC_SRC, "settings.json");
const RAW = readFileSync(SETTINGS_PATH, "utf-8");

interface Settings {
  permissions?: { allow?: string[] };
  statusLine?: { command?: string };
  model?: string;
  effortLevel?: string;
  env?: Record<string, string>;
  companyAnnouncements?: string[];
}
const settings: Settings = JSON.parse(RAW);

describe("settings.json — JSON validity [.sh test 1]", () => {
  test("settings.json is valid JSON", () => {
    // JSON.parse throws SyntaxError on invalid JSON; re-parsing inside the
    // assertion makes the contract observable rather than relying on the
    // module-load parse alone.
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

  // Turning a recorded check back on only raises it, so the one form the
  // skills name runs as it is. Turning a check off stays the person's click,
  // and so does any form that changes something else as well.
  test("turning a recorded check back on runs with no prompt; turning one off shows Claude Code's prompt", () => {
    const flags = "bun .claude/tools/aidlc.ts config flags";
    for (const name of RECORDABLE_PROJECT_BYPASSES) {
      expect(claudeBashEffect(`${flags} --clear-bypass ${name} --yes`), name).toBe("allow");
    }
    const check = "AIDLC_DISABLE_REVIEW_FREEZE_HOOK";
    for (const command of [
      `${flags} --bypass ${check} --local --yes`,
      `${flags} --bypass ${check} --yes`,
      `${flags} --bypass ${check} --global --yes`,
      `${flags} --clear-bypass ${check} --bypass AIDLC_DISABLE_SENSORS --yes`,
      `${flags} --bypass AIDLC_DISABLE_SENSORS --clear-bypass ${check} --yes`,
      `${flags} --clear-bypass ${check} --yes --bypass AIDLC_DISABLE_SENSORS`,
      `${flags} --clear-bypass ${check} --yes --question-retention-days 1`,
      `${flags} --clear-bypass ${check} --yes --project-dir ../other`,
      `${flags} --clear-bypass ${check} --yes --global`,
      `${flags} --clear-bypass AIDLC_NOT_A_SWITCH --yes`,
      `${flags} --clear-bypass "${check}" --yes`,
      `${flags} --clear-bypass ${check} --yes && ${flags} --bypass AIDLC_DISABLE_SENSORS --local --yes`,
    ]) {
      expect(claudeBashEffect(command), command).toBe("prompt");
    }
  });

  // Every script behind a route that can change the machine prompts, so a new
  // one cannot slip in.
  test("every read form agents run works with no prompt on the copy channel", () => {
    for (const form of SEEN_READ_FORMS) {
      expect(claudeBashEffect(`bun .claude/tools/aidlc.ts ${form}`), form).toBe("allow");
    }
    for (const form of ["config", "config --yes", "--config", "config models --show --global"]) {
      expect(claudeBashEffect(`bun .claude/tools/aidlc.ts ${form}`), form).toBe("prompt");
    }
  });

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
    const raise = new RegExp(
      `^bun \\.claude/tools/aidlc\\.ts config flags --clear-bypass (?:${RECORDABLE_PROJECT_BYPASSES.join("|")}) --yes$`,
    );
    const configChange = (command: string) =>
      /^bun \.claude\/tools\/aidlc\.ts config\b/.test(command) && !/ --(?:show --json|help)$/.test(command) &&
      !raise.test(command);
    // The skill names the command-line tool's own help only as the command not
    // to run ("`--help` goes here too ... is the command-line tool's own help,
    // not the AI-DLC help the person asked for"), so it needs no entry.
    named.delete("bun .claude/tools/aidlc.ts --help");
    for (const span of named) {
      const commands = span.includes("<section>")
        ? CONFIG_SECTIONS.map((section) => span.replace("<section>", section))
        : span.includes("<switch>")
        ? RECORDABLE_PROJECT_BYPASSES.map((name) => span.replace("<switch>", name))
        : span.includes("AIDLC_DISABLE_<NAME>")
        ? RECORDABLE_PROJECT_BYPASSES.filter((name) => name.startsWith("AIDLC_DISABLE_"))
          .map((name) => span.replace("AIDLC_DISABLE_<NAME>", name))
        : [span];
      for (const command of commands) {
        expect(claudeBashEffect(command), command).toBe(configChange(command) ? "prompt" : "allow");
      }
    }
  });
});

// The native release runs AI-DLC through the installed `aidlc` command. It
// pre-approves the engine prefix and, exactly as written, the same read-only
// and turn-back-on commands as the copy channel, so reading a setting or
// running doctor needs no click there either; any change still asks.
describe("permissions.allow on the native release", () => {
  const nativeAllow = (JSON.parse(
    readFileSync(join(REPO_ROOT, "dist-release", "claude", ".claude", "settings.json"), "utf-8"),
  ) as Settings).permissions?.allow ?? [];
  function nativeEffect(command: string): "allow" | "prompt" {
    return nativeAllow.some((rule) => {
      const m = /^Bash\((.*)\)$/.exec(rule);
      if (!m) return false;
      const glob = m[1].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
      return new RegExp(`^${glob}$`).test(command);
    })
      ? "allow"
      : "prompt";
  }
  const check = "AIDLC_DISABLE_REVIEW_FREEZE_HOOK";

  test("the engine prefix and each exact read-only and turn-back-on command are the only AI-DLC entries", () => {
    expect(nativeAllow.filter((entry) => entry.includes("aidlc"))).toEqual([
      "Bash(aidlc engine *)",
      ...copyChannelDispatcherCommands().map((command) => `Bash(aidlc ${command})`),
    ]);
  });

  test("reading a setting, doctor, status, version and turning a check back on run with no prompt", () => {
    for (const form of SEEN_READ_FORMS) {
      expect(nativeEffect(`aidlc ${form}`), form).toBe("allow");
    }
    for (const command of [
      "aidlc engine orchestrate next",
      "aidlc doctor",
      "aidlc --doctor",
      "aidlc status",
      "aidlc --status",
      "aidlc version",
      "aidlc --version",
      "aidlc config --help",
      ...CONFIG_SECTIONS.flatMap((section) => [
        `aidlc config ${section} --show --json`,
        `aidlc config ${section} --help`,
      ]),
      ...RECORDABLE_PROJECT_BYPASSES.map((name) => `aidlc config flags --clear-bypass ${name} --yes`),
    ]) {
      expect(nativeEffect(command), command).toBe("allow");
    }
  });

  test("the guided setup, any config change, turning a check off and the machine commands still prompt", () => {
    for (const command of [
      "aidlc config",
      "aidlc config --yes",
      "aidlc --config",
      "aidlc config models --show --global",
      "aidlc config --pin 2.10.0",
      "aidlc config --unpin",
      "aidlc config --channel preview",
      "aidlc config models --show --json --global",
      "aidlc config models --deciding-effort high --project --yes",
      `aidlc config flags --bypass ${check} --local --yes`,
      `aidlc config flags --bypass ${check} --yes`,
      `aidlc config flags --clear-bypass ${check} --bypass AIDLC_DISABLE_SENSORS --yes`,
      `aidlc config flags --clear-bypass ${check} --yes --bypass AIDLC_DISABLE_SENSORS`,
      `aidlc config flags --clear-bypass ${check} --yes --global`,
      "aidlc config flags --clear-bypass AIDLC_NOT_A_SWITCH --yes",
      "aidlc doctor --fix",
      "aidlc doctor && aidlc update",
      "aidlc update",
      "aidlc use 2.10.0",
      "aidlc uninstall --yes",
      "aidlc system config global set offline true",
    ]) {
      expect(nativeEffect(command), command).toBe("prompt");
    }
  });
});

describe("statusLine [.sh test 10]", () => {
  test("the shared settings carry no statusLine; harness.json's routes through the Bun dispatcher", () => {
    // Nothing in a team file outranks the person's own status line (#1407).
    expect(Object.hasOwn(settings, "statusLine")).toBe(false);
    const shipped = JSON.parse(readFileSync(join(AIDLC_SRC, "tools", "data", "harness.json"), "utf-8")) as {
      statusLine?: { command?: string };
    };
    expect(shipped.statusLine?.command).toBe('bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine statusline');
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

describe("companyAnnouncements — the Scopes table says what each plan runs", () => {
  // The welcome message's Scopes table is written by hand next to the compiled
  // grid (tools/data/scope-grid.json, the transpose of each stage's `scopes:`
  // frontmatter), so a plan can gain a stage without the table following. Here
  // the table is derived from the grid and the stage graph, in the two-letter
  // codes the announcement's own Stages legend defines, and compared as a
  // whole, so every drifted row is named at once. The legend's codes are taken
  // by position within each phase; what pins them is the count per phase and
  // each code's first letter against the stage's name. Both tables' rows are
  // held to one width, so no row runs past its table in the terminal.
  const lines = (settings.companyAnnouncements ?? [])[0]?.split("\n") ?? [];
  const grid = JSON.parse(readFileSync(join(AIDLC_SRC, "tools", "data", "scope-grid.json"), "utf-8")) as Record<
    string,
    { stages: Record<string, "EXECUTE" | "SKIP"> }
  >;
  const graph = JSON.parse(readFileSync(join(AIDLC_SRC, "tools", "data", "stage-graph.json"), "utf-8")) as {
    slug: string;
    name: string;
    phase: string;
  }[];
  const PHASES = ["ideation", "inception", "construction", "operation"];
  const cells = (line: string) =>
    line
      .trim()
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
  const tableFrom = (start: number) => {
    let end = start;
    while (end < lines.length && lines[end].startsWith("|")) end++;
    return lines.slice(start, end);
  };
  const legendRows = tableFrom(lines.findIndex((line) => /^\| Phase\s+\| Stages\s+\|$/.test(line)));
  const scopeRows = tableFrom(lines.findIndex((line) => line.startsWith("| Scope")));
  const stagesOf = (ph: string) => graph.filter((stage) => stage.phase === ph);

  // phase -> the legend's codes in the order it lists them; continuation rows
  // leave the phase cell empty.
  const legendCodes = new Map<string, string[]>();
  let phase = "";
  for (const row of legendRows.slice(2)) {
    const [phaseCell, stagesCell] = cells(row);
    if (phaseCell) phase = phaseCell.toLowerCase();
    const codes = [...stagesCell.matchAll(/\b([A-Z]{2})=/g)].map((match) => match[1]);
    legendCodes.set(phase, [...(legendCodes.get(phase) ?? []), ...codes]);
  }
  // slug -> code, by position within the phase.
  const codeOf = new Map<string, string>();
  for (const ph of PHASES) {
    stagesOf(ph).forEach((stage, index) => {
      codeOf.set(stage.slug, (legendCodes.get(ph) ?? [])[index] ?? "");
    });
  }

  test("the Stages legend names every stage of every phase, in stage order", () => {
    for (const ph of PHASES) expect(legendCodes.get(ph)?.length, ph).toBe(stagesOf(ph).length);
    for (const stage of graph) {
      if (stage.phase === "initialization") continue;
      expect(codeOf.get(stage.slug)?.[0], `${stage.slug} reads as ${codeOf.get(stage.slug)}`).toBe(stage.name[0]);
    }
    expect(new Set(codeOf.values()).size).toBe(codeOf.size);
  });

  test("every scope row lists the stages its compiled plan runs", () => {
    const expected = (scope: string) =>
      PHASES.map((ph) => {
        const slugs = stagesOf(ph).map((stage) => stage.slug);
        const run = slugs.filter((slug) => grid[scope]?.stages[slug] === "EXECUTE");
        if (run.length === slugs.length) return "all";
        if (run.length === 0) return "-";
        return run.map((slug) => codeOf.get(slug)).join(", ");
      });
    const rows = scopeRows.slice(2).map(cells);
    expect(rows.map(([scope]) => scope).sort()).toEqual(Object.keys(grid).sort());
    expect(rows.map(([scope, , ...phaseCells]) => [scope, ...phaseCells])).toEqual(
      rows.map(([scope]) => [scope, ...expected(scope)]),
    );
  });

  test("every row of the Stages and Scopes tables is as wide as its header", () => {
    const tables = [legendRows, scopeRows];
    expect(tables.map((rows) => rows.length > 2)).toEqual([true, true]);
    expect(tables.map((rows) => rows.map((row) => row.length))).toEqual(
      tables.map((rows) => rows.map(() => rows[0].length)),
    );
  });
});
