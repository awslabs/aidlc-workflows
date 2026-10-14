// covers: file:tests/harness/stock-permissions.ts
//
// A person on stock settings is asked before any command or write their tool
// does not allow. AI-DLC ships what its own commands need (Claude Code's allow
// rules, Codex's prefix rules and workspace-write sandbox), so a prompt for
// AI-DLC's own command or record, or a write outside the project, is a break
// the person meets. Any other prompt (the project's own build or test command)
// is theirs to decide and is only listed.
//
// Mechanism: function - recorded request shapes and Codex JSON events, no model.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { claudePromptProblems, codexSandboxProblems } from "../harness/stock-permissions.ts";

const PROJECT = process.platform === "win32" ? "C:\\work\\shop" : "/work/shop";
const bash = (command: string) => ({ toolName: "Bash", input: { command } });

describe("Claude Code in its default permission mode", () => {
  test("a prompt for AI-DLC's own command or record is a problem", () => {
    const requests = [
      bash("cat aidlc/spaces/default/intents/intents.json"),
      bash("ls aidlc"),
      bash("mkdir -p aidlc/spaces/default/memory/reviews"),
      bash("bun .claude/tools/aidlc.ts engine next | head -50"),
      bash(`sed -i 's/x/y/' ${join(PROJECT, "aidlc", "spaces", "default", "memory", "team.md")}`),
      { toolName: "Read", input: { file_path: join(PROJECT, ".claude", "settings.json") } },
      { toolName: "Write", input: { file_path: "aidlc/spaces/default/intents/notes.md", content: "x" } },
    ];
    const { problems, listed } = claudePromptProblems(requests, PROJECT);
    expect(problems).toHaveLength(requests.length);
    expect(problems[0]).toBe('AI-DLC\'s own command or record asked for permission: Bash "cat aidlc/spaces/default/intents/intents.json"');
    expect(listed).toEqual([]);
  });

  test("a write outside the project is a problem, wherever it points", () => {
    const outside = process.platform === "win32" ? "C:\\Users\\p\\AppData\\Local\\Temp\\x.ts" : "/tmp/x.ts";
    const { problems } = claudePromptProblems([
      { toolName: "Write", input: { file_path: outside, content: "x" } },
      { toolName: "Edit", input: { file_path: join(PROJECT, "..", "other", "a.ts"), old_string: "a", new_string: "b" } },
    ], PROJECT);
    expect(problems).toEqual([
      `a write outside the project asked for permission: Write ${JSON.stringify(outside)}`,
      `a write outside the project asked for permission: Edit ${JSON.stringify(join(PROJECT, "..", "other", "a.ts"))}`,
    ]);
  });

  test("the project's own commands and files are only listed", () => {
    const { problems, listed } = claudePromptProblems([
      bash("bun test"),
      bash("git diff --stat"),
      bash("ls src"),
      { toolName: "Read", input: { file_path: join(PROJECT, "src", "price.ts") } },
      { toolName: "WebFetch", input: { url: "https://example.com/aidlc/x" } },
    ], PROJECT);
    expect(problems).toEqual([]);
    expect(listed).toEqual([
      'Bash "bun test"', 'Bash "git diff --stat"', 'Bash "ls src"',
      `Read ${JSON.stringify(join(PROJECT, "src", "price.ts"))}`, 'WebFetch "https://example.com/aidlc/x"',
    ]);
  });

  test("a name that only contains aidlc is not AI-DLC's record", () => {
    const { problems } = claudePromptProblems([bash("cat docs/my-aidlc/notes.md"), bash("grep -rn aidlc-workflows src")], PROJECT);
    expect(problems).toEqual([]);
  });
});

describe("Codex in its shipped workspace-write sandbox", () => {
  const event = (command: string, output: string, exit = 1) => JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "command_execution", command, aggregated_output: output, exit_code: exit, status: exit ? "failed" : "completed" },
  });

  test("the sandbox refusing a command that names .codex/ or aidlc/ is a problem", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }),
      event("/bin/bash -lc 'bun .codex/tools/aidlc-utility.ts space teamB'", "error: EROFS: Read-only file system, open '.codex/config.toml'"),
      event("/bin/bash -lc 'printf x > .codex/config.toml'", "bash: .codex/config.toml: Operation not permitted"),
      event("powershell.exe -Command \"Set-Content aidlc\\x.md y\"", "Access to the path 'C:\\work\\aidlc\\x.md' is denied."),
      event("/bin/bash -lc 'bun .codex/tools/aidlc.ts engine next'", "Next: run Reverse Engineering", 0),
    ].join("\n");
    const { problems, listed } = codexSandboxProblems(stdout);
    expect(problems).toEqual([
      "the sandbox refused AI-DLC's own command: /bin/bash -lc 'bun .codex/tools/aidlc-utility.ts space teamB' (error: EROFS: Read-only file system, open '.codex/config.toml')",
      "the sandbox refused AI-DLC's own command: /bin/bash -lc 'printf x > .codex/config.toml' (bash: .codex/config.toml: Operation not permitted)",
      "the sandbox refused AI-DLC's own command: powershell.exe -Command \"Set-Content aidlc\\x.md y\" (Access to the path 'C:\\work\\aidlc\\x.md' is denied.)",
    ]);
    expect(listed).toEqual([]);
  });

  test("a refusal of another command is listed; a clean or non-JSON run has nothing", () => {
    const refused = event("/bin/bash -lc 'touch /etc/x'", "touch: cannot touch '/etc/x': Read-only file system");
    expect(codexSandboxProblems(refused)).toEqual({ problems: [], listed: ["/bin/bash -lc 'touch /etc/x' (touch: cannot touch '/etc/x': Read-only file system)"] });
    expect(codexSandboxProblems(event("/bin/bash -lc 'bun .codex/tools/aidlc.ts engine next'", "ok", 0))).toEqual({ problems: [], listed: [] });
    expect(codexSandboxProblems("Codex's final message, not JSON\n")).toEqual({ problems: [], listed: [] });
  });
});
