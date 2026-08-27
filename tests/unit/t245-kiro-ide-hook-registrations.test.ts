// t245-kiro-ide-hook-registrations: structural contract test for the v2 hook
// JSON files shipped in dist/kiro-ide/.kiro/hooks/. Ensures every registration
// is valid JSON with the expected version, trigger, matcher, and adapter
// command — so a typo cannot silently disable a hook while the suite stays
// green (packaging parity only proves authored=generated, not correctness).
//
// Also pins: session-end has NO v2 registration (the IDE's Stop trigger is
// turn-scoped, not session-scoped), and all legacy .kiro.hook files are present.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUTHORED_HOOKS = join(REPO_ROOT, "harness", "kiro-ide", "hooks");
const DIST_HOOKS = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks");
const KIRO_IDE_GUIDE = join(REPO_ROOT, "docs", "guide", "harnesses", "kiro-ide.md");
const WINDOWS_EVIDENCE = join(
  REPO_ROOT,
  "docs",
  "reference",
  "research",
  "kiro-windows-output-encoding",
);

interface HookEntry {
  name: string;
  trigger: string;
  matcher?: string;
  action: { type: string; command: string };
  description?: string;
}

interface HookFile {
  version: string;
  hooks: HookEntry[];
}

// The pinned contract: every v2 hook JSON that MUST ship, with its expected
// trigger, optional matcher regex, and the adapter target embedded in its
// command string.
const EXPECTED_V2_REGISTRATIONS: Array<{
  file: string;
  trigger: string;
  matcher: string | null;
  adapterTarget: string;
}> = [
  { file: "aidlc-session-start.json", trigger: "SessionStart", matcher: null, adapterTarget: "session-start" },
  { file: "aidlc-record-human-turn.json", trigger: "UserPromptSubmit", matcher: null, adapterTarget: "record-human-turn" },
  { file: "aidlc-terminal-command.json", trigger: "UserPromptSubmit", matcher: null, adapterTarget: "verb-intercept" },
  { file: "aidlc-terminal-command-guard.json", trigger: "PreToolUse", matcher: "^(execute_bash|execute_pwsh|shell)$", adapterTarget: "terminal-command-guard" },
  { file: "aidlc-enforce-approval-gate.json", trigger: "PreToolUse", matcher: null, adapterTarget: "enforce-approval-gate" },
  { file: "aidlc-plan-approval-guard.json", trigger: "PreToolUse", matcher: null, adapterTarget: "plan-approval-guard" },
  { file: "aidlc-write-audit-log.json", trigger: "PostToolUse", matcher: "fs_write|str_replace|fs_append", adapterTarget: "audit-and-sensors" },
  { file: "aidlc-rebuild-stage-graph.json", trigger: "PostToolUse", matcher: "execute_bash", adapterTarget: "rebuild-stage-graph" },
  { file: "aidlc-sync-workflow-state.json", trigger: "PostToolUse", matcher: "execute_bash", adapterTarget: "sync-workflow-state" },
  { file: "aidlc-log-subagent.json", trigger: "PostToolUse", matcher: "^(subagent_.+|invoke_sub_agent)$", adapterTarget: "log-subagent" },
  { file: "aidlc-continue-workflow.json", trigger: "Stop", matcher: null, adapterTarget: "continue-workflow" },
];

// Legacy .kiro.hook files that MUST be present (coexistence with pre-1.0 IDE).
const EXPECTED_LEGACY_FILES = [
  "aidlc-write-audit-log.kiro.hook",
  "aidlc-enforce-approval-gate.kiro.hook",
  "aidlc-plan-approval-guard.kiro.hook",
  "aidlc-log-subagent.kiro.hook",
  "aidlc-record-human-turn.kiro.hook",
  "aidlc-terminal-command.kiro.hook",
  "aidlc-terminal-command-guard.kiro.hook",
  "aidlc-rebuild-stage-graph.kiro.hook",
  "aidlc-session-end.kiro.hook",
  "aidlc-session-start.kiro.hook",
  "aidlc-continue-workflow.kiro.hook",
  "aidlc-sync-workflow-state.kiro.hook",
];

const RETIRED_HOOK_BASENAMES = [
  "audit-logger",
  "block",
  "mint",
  "runtime-compile",
  "stop",
  "sync-statusline",
];

function parseHookJson(dir: string, file: string): HookFile {
  const path = join(dir, file);
  expect(existsSync(path), `${file} must exist`).toBe(true);
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as HookFile;
  return parsed;
}

describe("t245 Kiro IDE hook registrations (v2 schema contract)", () => {
  for (const tree of [
    { name: "authored (harness/kiro-ide/hooks)", dir: AUTHORED_HOOKS },
    { name: "dist (dist/kiro-ide/.kiro/hooks)", dir: DIST_HOOKS },
  ]) {
    describe(tree.name, () => {
      for (const reg of EXPECTED_V2_REGISTRATIONS) {
        test(`${reg.file}: version=v1, trigger=${reg.trigger}, matcher=${reg.matcher ?? "none"}, target=${reg.adapterTarget}`, () => {
          const parsed = parseHookJson(tree.dir, reg.file);
          expect(parsed.version).toBe("v1");
          expect(parsed.hooks.length).toBe(1);
          const hook = parsed.hooks[0];
          expect(hook.trigger).toBe(reg.trigger);
          if (reg.matcher) {
            expect(hook.matcher).toBe(reg.matcher);
          } else {
            expect(hook.matcher).toBeUndefined();
          }
          expect(hook.action.type).toBe("command");
          expect(hook.action.command).toContain(`aidlc-kiro-adapter.ts ${reg.adapterTarget}`);
        });
      }

      // The matcher is deliberately BROAD; the `subagent_response` exclusion is
      // the ADAPTER's job (pinned by t218 N5b), because the direct and
      // dispatcher entry points bypass this matcher entirely. Narrowing the
      // regex here — e.g. requiring a trailing `-agent` — would silently drop
      // completions from fork-added delegates whose names differ. This test
      // pins the broad reach; it must NOT be "hardened" into an exclusion.
      test("log-subagent matcher reaches every observed delegate completion name", () => {
        const parsed = parseHookJson(tree.dir, "aidlc-log-subagent.json");
        const matcher = new RegExp(parsed.hooks[0].matcher ?? "");
        // The two forms captured live on IDE 0.12.333 and 1.0.89-1.0.138 (#459/#543).
        expect(matcher.test("invoke_sub_agent")).toBe(true);
        expect(matcher.test("subagent_aidlc-product-lead-agent")).toBe(true);
        expect(matcher.test("subagent_aidlc-developer-agent")).toBe(true);
        // A fork-added delegate that does not follow the aidlc-*-agent naming
        // must still reach the adapter.
        expect(matcher.test("subagent_my-custom-reviewer")).toBe(true);
        // Unrelated tools must not.
        expect(matcher.test("fs_write")).toBe(false);
        expect(matcher.test("execute_bash")).toBe(false);
      });

      test("session-end has NO v2 registration (Stop is turn-scoped, not session-scoped)", () => {
        expect(existsSync(join(tree.dir, "aidlc-session-end.json"))).toBe(false);
      });

      test("dispatch-rules has NO IDE registration (always-included steering is the delivery channel)", () => {
        expect(existsSync(join(tree.dir, "aidlc-deliver-stage-rules.json"))).toBe(
          false,
        );
      });

      test("no unexpected v2 hook JSONs beyond the pinned set", () => {
        const allJsons = readdirSync(tree.dir).filter(
          (f) => f.startsWith("aidlc-") && f.endsWith(".json"),
        );
        const expectedSet = new Set(EXPECTED_V2_REGISTRATIONS.map((r) => r.file));
        for (const f of allJsons) {
          expect(expectedSet.has(f), `unexpected v2 hook file: ${f}`).toBe(true);
        }
        expect(allJsons.length).toBe(EXPECTED_V2_REGISTRATIONS.length);
      });
    });
  }

  describe("legacy coexistence", () => {
    for (const legacy of EXPECTED_LEGACY_FILES) {
      test(`dist ships ${legacy}`, () => {
        expect(existsSync(join(DIST_HOOKS, legacy))).toBe(true);
      });
    }
  });

  test("upgrade instructions remove retired hook registrations before overlaying the new tree", () => {
    const guide = readFileSync(KIRO_IDE_GUIDE, "utf-8");
    const cleanupStart = guide.indexOf("for retired_hook in");
    const overlayCopy = guide.indexOf("cp -R dist/kiro-ide/.kiro/.");

    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(overlayCopy).toBeGreaterThan(cleanupStart);

    const cleanup = guide.slice(cleanupStart, overlayCopy);
    for (const basename of RETIRED_HOOK_BASENAMES) {
      expect(cleanup).toContain(basename);
    }
    expect(cleanup).toMatch(
      /rm -f \\\n\s+"your-project\/\.kiro\/hooks\/aidlc-\$\{retired_hook\}\.json" \\\n\s+"your-project\/\.kiro\/hooks\/aidlc-\$\{retired_hook\}\.kiro\.hook"/,
    );
  });

  test("native Windows CLI/IDE output evidence is retained and separates transport from model prose", () => {
    const ideRows = readFileSync(
      join(WINDOWS_EVIDENCE, "kiro-ide-windows.ndjson"),
      "utf-8",
    ).trim().split("\n").map((line) =>
      JSON.parse(line) as {
        capture: string;
        deterministic_output: string;
        transport_suffix: string | null;
        allow_clicks?: number;
        model_followup: string;
      }
    );
    const baseline = ideRows.filter((row) =>
      row.capture === "current-v2-baseline"
    );
    const fixed = ideRows.filter((row) => row.capture === "2.6.75-cycle1");
    expect(baseline).toHaveLength(2);
    expect(fixed).toHaveLength(2);
    for (const row of baseline) {
      expect(row.deterministic_output).toMatch(/[█▒░─✓⇄—]/);
      expect(row.transport_suffix).toContain("powershell.exe\u001b\\");
      expect(row.model_followup.length).toBeGreaterThan(0);
    }
    for (const row of fixed) {
      expect(row.deterministic_output).toMatch(/[█▒░─✓⇄—]/);
      expect(row.transport_suffix).toBeNull();
      expect(row.allow_clicks).toBe(0);
      expect(row.model_followup.length).toBeGreaterThan(0);
    }

    const cliRows = readFileSync(
      join(WINDOWS_EVIDENCE, "kiro-cli-windows.ndjson"),
      "utf-8",
    ).trim().split("\n").map((line) =>
      JSON.parse(line) as {
        capture: string;
        runtime: string;
        platform: string;
        command: string;
        transport: {
          exit_code: number;
          deterministic_output: string;
          stderr: string;
        };
        model: {
          stop_reason: string;
          tool_calls: unknown[];
          tool_call_issues: unknown[];
          deterministic_output: string;
          followup: string;
        };
      }
    );
    expect(cliRows).toHaveLength(4);
    expect(
      cliRows.filter((row) => row.capture === "current-v2-baseline"),
    ).toHaveLength(2);
    expect(
      cliRows.filter((row) => row.capture === "2.6.75-cycle2"),
    ).toHaveLength(2);
    expect(new Set(cliRows.map((row) => row.command))).toEqual(
      new Set(["/aidlc --status", "/aidlc --doctor"]),
    );
    for (const row of cliRows) {
      expect(row.runtime).toBe("kiro-cli-chat 2.15.2");
      expect(row.platform).toBe("native Windows");
      expect(row.transport.exit_code).toBe(0);
      expect(row.transport.stderr).toBe("");
      expect(row.transport.deterministic_output).toMatch(/[█▒░─✓⇄—]/);
      expect(row.model.stop_reason).toBe("end_turn");
      expect(row.model.tool_calls).toEqual([]);
      expect(row.model.tool_call_issues).toEqual([]);
      expect(row.model.deterministic_output).toBe(
        row.transport.deterministic_output,
      );
      expect(row.model.followup.length).toBeGreaterThan(0);
    }
  });
});
