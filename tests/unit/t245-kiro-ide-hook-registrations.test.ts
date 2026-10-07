// t245-kiro-ide-hook-registrations: structural contract test for the v2 hook
// JSON files shipped in dist/kiro-ide/.kiro/hooks/. Ensures every registration
// is valid JSON with the expected version, trigger, matcher, and adapter
// command — so a typo cannot silently disable a hook while the suite stays
// green (packaging parity only proves authored=generated, not correctness).
//
// Also pins: session-end has NO v2 registration (Kiro's Stop trigger is
// turn-scoped, not session-scoped), every registration carries a timeout, and
// no IDE 0.x .kiro.hook file ships (IDE 1.x never executes them).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalWriteTool,
  isKiroDelegationTool,
  isKiroShellTool,
  isPlanApprovalSafeReadTool,
  KIRO_HOOK_GROUPS,
  KIRO_HOOK_MATCHERS,
  mutationCapableTool,
} from "../../harness/kiro-ide/hooks/aidlc-kiro-tool-names.ts";

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
  timeout?: number;
}

interface HookFile {
  version: string;
  hooks: HookEntry[];
}

// The pinned contract: every v2 hook JSON that MUST ship, with its expected
// trigger, optional matcher regex, and the adapter target embedded in its
// command string. Each matcher is built from the adapter's tool-name table
// (harness/kiro-ide/hooks/aidlc-kiro-tool-names.ts), so a name the adapter
// routes and the registration that delivers it cannot drift apart.
const EXPECTED_V2_REGISTRATIONS: Array<{
  file: string;
  trigger: string;
  matcher: string | null;
  adapterTarget: string;
}> = [
  { file: "aidlc-session-start.json", trigger: "SessionStart", matcher: null, adapterTarget: "session-start" },
  { file: "aidlc-record-human-turn.json", trigger: "UserPromptSubmit", matcher: null, adapterTarget: "record-human-turn" },
  { file: "aidlc-terminal-command.json", trigger: "UserPromptSubmit", matcher: null, adapterTarget: "verb-intercept" },
  // Kiro IDE shows a card for every hook run (#2022), so the five tool-call
  // checks share one registration and the two after-shell hooks another.
  { file: "aidlc-guard-tool-call.json", trigger: "PreToolUse", matcher: KIRO_HOOK_MATCHERS.notReadPreToolUse, adapterTarget: "guard-tool-call" },
  { file: "aidlc-write-audit-log.json", trigger: "PostToolUse", matcher: KIRO_HOOK_MATCHERS.auditedWrite, adapterTarget: "audit-and-sensors" },
  { file: "aidlc-after-shell.json", trigger: "PostToolUse", matcher: KIRO_HOOK_MATCHERS.shellPostToolUse, adapterTarget: "after-shell" },
  { file: "aidlc-log-subagent.json", trigger: "PostToolUse", matcher: KIRO_HOOK_MATCHERS.delegateCompletion, adapterTarget: "log-subagent" },
  { file: "aidlc-continue-workflow.json", trigger: "Stop", matcher: null, adapterTarget: "continue-workflow" },
];

const RETIRED_HOOK_BASENAMES = [
  "audit-logger",
  "block",
  "mint",
  "runtime-compile",
  "stop",
  "sync-statusline",
  // Folded into aidlc-guard-tool-call and aidlc-after-shell (#2022).
  "enforce-approval-gate",
  "plan-approval-guard",
  "review-freeze",
  "state-transition-guard",
  "terminal-command-guard",
  "rebuild-stage-graph",
  "sync-workflow-state",
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
          expect(hook.action.command).toContain(
            `engine adapter kiro-ide ${reg.adapterTarget}`,
          );
          // Kiro's default command timeout is 60 seconds; the engine work these
          // hooks forward to (sensors, continuation) can run far longer.
          expect(hook.timeout ?? 0).toBeGreaterThanOrEqual(1800);
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
        // The forms captured live: invoke_sub_agent and subagent_<agent> on
        // Kiro IDE (#459/#543), orchestrate_subagent on Kiro CLI v3.
        expect(matcher.test("invoke_sub_agent")).toBe(true);
        expect(matcher.test("orchestrate_subagent")).toBe(true);
        expect(matcher.test("subagent_aidlc-product-lead-agent")).toBe(true);
        expect(matcher.test("subagent_aidlc-developer-agent")).toBe(true);
        // A fork-added delegate that does not follow the aidlc-*-agent naming
        // must still reach the adapter.
        expect(matcher.test("subagent_my-custom-reviewer")).toBe(true);
        // Unrelated tools must not.
        expect(matcher.test("fs_write")).toBe(false);
        expect(matcher.test("execute_bash")).toBe(false);
      });

      // Kiro compiles a matcher with new RegExp and tests it against the tool
      // name; one that does not compile makes the hook never run, so the
      // checks would stop silently. The reads are the only tools left out.
      test("the one guard card skips exactly the table's reads, as Kiro compiles its matcher", () => {
        const parsed = parseHookJson(tree.dir, "aidlc-guard-tool-call.json");
        const matcher = new RegExp(parsed.hooks[0].matcher ?? "");
        for (const name of [
          "read", "fs_read", "read_file", "read_files", "read_code", "list_directory", "file_search", "glob",
          "grep_search", "grep", "web_fetch", "web_search", "disclose_context", "thinking", "todo_list",
        ]) {
          expect(isPlanApprovalSafeReadTool(name), name).toBe(true);
          expect(matcher.test(name), name).toBe(false);
        }
        for (const name of [
          "fs_write", "str_replace", "fs_append", "write", "create_file", "delete_file", "apply_patch", "edit_file",
          "execute_bash", "execute_pwsh", "shell", "invoke_sub_agent", "orchestrate_subagent",
          "subagent_aidlc-developer-agent", "subagent_response", "memory", "user_input", "report_progress",
          "mcp_some_server_tool", "read_file_and_write", "some_future_tool", "",
        ]) {
          expect(matcher.test(name), name).toBe(true);
        }
      });

      test("the tool-name table ships beside the adapter, which reads it", () => {
        expect(existsSync(join(tree.dir, "aidlc-kiro-tool-names.ts"))).toBe(true);
        expect(readFileSync(join(tree.dir, "aidlc-kiro-adapter.ts"), "utf-8"))
          .toContain('from "./aidlc-kiro-tool-names.ts"');
      });

      test("session-end has NO v2 registration (Stop is turn-scoped, not session-scoped)", () => {
        expect(existsSync(join(tree.dir, "aidlc-session-end.json"))).toBe(false);
      });

      test("dispatch-rules has NO IDE registration (the brief paste is the delivery channel)", () => {
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

  test("no IDE 0.x .kiro.hook file ships (IDE 1.x never executes them)", () => {
    for (const dir of [AUTHORED_HOOKS, DIST_HOOKS]) {
      expect(readdirSync(dir).filter((f) => f.endsWith(".kiro.hook"))).toEqual([]);
    }
  });

  test("upgrade instructions remove retired hook registrations before overlaying the new tree", () => {
    const guide = readFileSync(KIRO_IDE_GUIDE, "utf-8");
    const cleanupStart = guide.indexOf("for retired_hook in");
    const overlayCopy = guide.indexOf(
      'cp -R "$RUNTIME_ROOT/kiro-ide/.kiro/."',
    );

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

// Each check that now shares a registration keeps the tools its own
// registration selected, in the order Kiro ran those files (file-name order).
describe("t245 one card runs the checks that had their own cards", () => {
  test("the guard card runs the five tool-call checks in their old order with their old matchers", () => {
    expect(KIRO_HOOK_GROUPS["guard-tool-call"]).toEqual([
      { target: "enforce-approval-gate", matcher: KIRO_HOOK_MATCHERS.notReadPreToolUse },
      { target: "plan-approval-guard", matcher: KIRO_HOOK_MATCHERS.notReadPreToolUse },
      { target: "review-freeze", matcher: KIRO_HOOK_MATCHERS.writeOrShellPreToolUse },
      { target: "state-transition-guard", matcher: KIRO_HOOK_MATCHERS.writeOrShellPreToolUse },
      { target: "terminal-command-guard", matcher: KIRO_HOOK_MATCHERS.shellPreToolUse },
    ]);
  });

  test("the after-shell card runs the rebuild, then the sync, for the old shell matcher", () => {
    expect(KIRO_HOOK_GROUPS["after-shell"]).toEqual([
      { target: "rebuild-stage-graph", matcher: KIRO_HOOK_MATCHERS.shellPostToolUse },
      { target: "sync-workflow-state", matcher: KIRO_HOOK_MATCHERS.shellPostToolUse },
    ]);
  });

  test("each card's matcher reaches every tool one of its checks acts on", () => {
    for (const [file, group] of [
      ["aidlc-guard-tool-call.json", "guard-tool-call"],
      ["aidlc-after-shell.json", "after-shell"],
    ] as const) {
      const registration = new RegExp(parseHookJson(AUTHORED_HOOKS, file).hooks[0].matcher ?? "");
      for (const name of [
        "read_file", "list_directory", "fs_write", "str_replace", "fs_append", "delete_file", "execute_bash",
        "execute_pwsh", "shell", "invoke_sub_agent", "subagent_response", "memory", "some_future_tool",
      ]) {
        const anyCheck = KIRO_HOOK_GROUPS[group].some((member) => new RegExp(member.matcher).test(name));
        expect(registration.test(name), `${file} ${name}`).toBe(anyCheck);
      }
    }
  });
});

// The names Kiro CLI v3 and Kiro IDE 1.x report for writes, shells, delegations
// and reads (as seen in PreToolUse payloads on Kiro CLI 2.27.1 and Kiro IDE
// 1.2.4; the captures are not in this repository) keep the classification the
// adapter gave them before the table. This pins the table, not the capture.
describe("t245 Kiro tool-name table keeps the adapter's classification", () => {
  test("writes, shells and delegations on both surfaces", () => {
    expect(canonicalWriteTool("fs_write")).toBe("Write");
    expect(canonicalWriteTool("str_replace")).toBe("Edit");
    expect(isKiroShellTool("execute_bash")).toBe(true);
    for (const name of ["invoke_sub_agent", "orchestrate_subagent", "subagent_aidlc-developer-agent"]) {
      expect(isKiroDelegationTool(name), name).toBe(true);
    }
    // The completion shell is not a dispatch.
    expect(isKiroDelegationTool("subagent_response")).toBe(false);
  });

  test("Kiro CLI reads are safe reads; a name the table does not know may mutate", () => {
    for (const name of ["read_file", "file_search", "fs_read"]) {
      expect(isPlanApprovalSafeReadTool(name), name).toBe(true);
      expect(mutationCapableTool(name), name).toBe(false);
    }
    expect(mutationCapableTool("some_future_tool")).toBe(true);
    expect(mutationCapableTool("")).toBe(false);
  });
});
