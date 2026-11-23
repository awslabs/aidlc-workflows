// covers: file:tests/harness/stock-permissions.ts
//
// A person on stock settings is asked before any command or write their tool
// does not allow. AI-DLC ships what its own commands need (Claude Code's allow
// rules, Codex's prefix rules and workspace-write sandbox, opencode's
// permission table), so a file tool asking inside AI-DLC's folders, a write
// outside the project, or a prompt for a command that runs one of AI-DLC's own
// tools is a break the person meets. A shell command the agent wrote that only
// names AI-DLC's folders is listed and counted under its own heading, never
// failed; any other prompt (the project's own build or test command) is theirs
// to decide and is only listed.
//
// Each case puts one request through a report and checks which list holds it,
// so every line is in exactly one of problems, folderCommands and listed.
//
// Mechanism: function - recorded request shapes, Codex and opencode JSON events, and the shipped allow lists in dist/; no model.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as stock from "../harness/stock-permissions.ts";

const { claudePromptProblems, codexSandboxProblems, opencodePermissionProblems } = stock;
const PROJECT = process.platform === "win32" ? "C:\\work\\shop" : "/work/shop";
const bash = (command: string) => ({ toolName: "Bash", input: { command } });
const LISTS = ["problems", "folderCommands", "listed"] as const;

/** The lists of a one-request report that hold a line. */
const holding = (report: object): string[] =>
  LISTS.filter((key) => ((report as Record<string, string[] | undefined>)[key] ?? []).length > 0);

const codexEvent = (command: string, output: string, exit = 1) => JSON.stringify({
  type: "item.completed",
  item: { id: "item_1", type: "command_execution", command, aggregated_output: output, exit_code: exit, status: exit ? "failed" : "completed" },
});
const opencodeEvent = (tool: string, input: Record<string, unknown>, status: string, error = "") =>
  JSON.stringify({ type: "tool_use", part: { type: "tool", tool, state: { status, input, ...(error ? { error } : { output: "ok" }) } } });
const REJECTED = "The user rejected permission to use this specific tool call.";

// Shell commands the agent wrote that name AI-DLC's folders and run none of its
// tools: the first four as live journeys recorded them (the project path is the
// test's own), then shapes that name the records or the tools folder.
const FOLDER_ONLY = [
  `mkdir -p ${PROJECT}/aidlc/spaces/default/intents/261120-monthly-sales-totals/.aidlc-engine/reviews/intent-capture/stage/e11555b29207f4f7`,
  "ls -la && echo \"---BUN---\" && which bun && bun --version && echo \"---UTI---\" && find aidlc/spaces/default/intents/261120-csv-sales-totals -name 'unit-test-instructions.md' 2>/dev/null",
  "for f in aidlc/active-memory/org.md aidlc/active-memory/team.md aidlc/active-memory/project.md aidlc/active-memory/phases/ideation.md aidlc/active-memory/phases/inception.md aidlc/active-memory/phases/construction.md aidlc/active-memory/phases/operation.md; do echo \"===== $f =====\"; cat \"$f\"; echo; done",
  "ls -t aidlc/spaces/default/intents/261120-csv-monthly-totals/.aidlc-engine/sensors/intent-capture/ | head; echo \"---\"; cat \"$(ls -t aidlc/spaces/default/intents/261120-csv-monthly-totals/.aidlc-engine/sensors/intent-capture/claim-sources-*.md | head -1)\"",
  "cat aidlc/spaces/default/intents/intents.json",
  "ls aidlc",
  "mkdir -p aidlc/spaces/default/memory/reviews",
  `sed -i 's/x/y/' ${join(PROJECT, "aidlc", "spaces", "default", "memory", "team.md")}`,
  "cat .claude/tools/aidlc.ts",
  "cd .claude/tools && ls",
  "cd aidlc && bun test",
  "bunx cowsay hi && cat .claude/tools/aidlc.ts",
  "cat bun.lock .claude/tools/aidlc.ts",
  "ls ~/.bun/ .claude/tools",
  "bun --version && ls .claude/tools-old",
];

// A command that runs one of AI-DLC's own tools, by the spellings agents and shells use, and in a chain.
const OWN_TOOL = [
  "bun .claude/tools/aidlc.ts engine next | head -50",
  `cd ${PROJECT} && bun .claude/tools/aidlc.ts engine next`,
  `bun ${PROJECT}/.claude/tools/aidlc-utility.ts space x`,
  "bun \"$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts\" engine next",
  "bun \"$CLAUDE_PROJECT_DIR\"/.claude/tools/aidlc.ts engine next",
  "bun \"/work/my shop/.claude/tools/aidlc.ts\" engine next",
  "bun C:/work/shop/.claude/tools/aidlc.ts engine next",
  "bun C:\\work\\shop\\.claude\\tools\\aidlc.ts engine next",
  "cd C:\\work\\shop && bun .claude\\tools\\aidlc-state.ts get",
  "& \"C:\\Program Files\\bun\\bun.exe\" .claude\\tools\\aidlc.ts engine next",
  "bun .claude/tools/aidlc.ts engine next && cat aidlc/x.md",
  "bun $(git rev-parse --show-toplevel)/.claude/tools/aidlc.ts engine next",
  "bun /work/my\\ shop/.claude/tools/aidlc.ts engine next",
  "bash -c \"bun \\\"$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts\\\" engine next\"",
  "~/.bun/bin/bun .claude/tools/aidlc.ts engine next",
  "\"$HOME/.bun/bin/bun\" .claude/tools/aidlc.ts engine next",
  "$(which bun) .claude/tools/aidlc.ts engine next",
  "bun --cwd /work/shop .claude/tools/aidlc.ts engine next",
  "bun \"$CLAUDE_PROJECT_DIR\"/\".claude/tools/aidlc.ts\" engine next",
  "bun \\\n  .claude/tools/aidlc.ts engine next",
  "cd .claude/tools && bun aidlc.ts engine next",
  "cd \"$CLAUDE_PROJECT_DIR/.claude/tools\"; bun ./aidlc-state.ts get",
  "T=.claude/tools; bun $T/aidlc.ts engine next",
  "bun $(dirname $(git rev-parse --git-dir))/.claude/tools/aidlc.ts engine next",
  "\"$(which bun)\" .claude/tools/aidlc.ts engine next",
  "bun --cwd \"$(git rev-parse --show-toplevel)\" .claude/tools/aidlc.ts engine next",
  "bun --cwd \"/work/my shop\" .claude/tools/aidlc.ts engine next",
  "bun --cwd .claude/tools aidlc.ts engine next",
  "pushd .claude/tools && bun aidlc.ts engine next",
  "Set-Location .claude\\tools; bun aidlc.ts engine next",
  "cd -- .claude/tools && bun aidlc.ts engine next",
  "cd .claude/tools && \"$HOME/.bun/bin/bun\" aidlc.ts engine next",
  "bun `git rev-parse --show-toplevel`/.claude/tools/aidlc.ts engine next",
  "bun \"$(cd \"$CLAUDE_PROJECT_DIR\" && pwd)/.claude/tools/aidlc.ts\" engine next",
  "bun \"$CLAUDE_PROJECT_DIR/\".claude/tools/aidlc.ts engine next",
  "bun .claude//tools/aidlc.ts engine next",
  "bun 2>/dev/null .claude/tools/aidlc.ts engine next",
  "find .claude/tools -name 'aidlc-state.ts' -exec bun {} get \\;",
  "bun -e 'await import(\"./.claude/tools/aidlc.ts\")'",
  "bun.exe .claude\\tools\\aidlc.ts engine next",
  "BUN.EXE .claude\\tools\\aidlc.ts engine next",
  "bun.cmd .claude\\tools\\aidlc.ts engine next",
  "$BUN .claude/tools/aidlc.ts engine next",
];

// A line that names the launcher and the tools folder fails even when it runs
// neither: a word check cannot tell the two apart.
const NAMES_BOTH = [
  "bun --version && cat .claude/tools/aidlc.ts",
  "grep -rn bun .claude/tools/",
];

// Runs the word check cannot see (stock-permissions.ts says which): listed and
// counted like the agent's other lines, so a new gap shows as a change here.
const KNOWN_GAPS = [
  "node .claude/tools/aidlc.ts engine next",
  "./.claude/tools/aidlc.ts engine next",
  "$LAUNCHER .claude/tools/aidlc.ts engine next",
  "cd .claude && bun tools/aidlc.ts engine next",
  "bun .claude/hooks/aidlc-x.ts",
];

describe("Claude Code in its default permission mode", () => {
  test.each(OWN_TOOL)("a prompt for a command that runs AI-DLC's own tool fails the drive: %s", (command) => {
    expect(holding(claudePromptProblems([bash(command)], PROJECT))).toEqual(["problems"]);
  });

  test.each(FOLDER_ONLY)("a shell command that only names AI-DLC's folders is listed and counted, not failed: %s", (command) => {
    expect(holding(claudePromptProblems([bash(command)], PROJECT))).toEqual(["folderCommands"]);
  });

  test.each(NAMES_BOTH)("a line that names the launcher and the tools folder fails, though it runs neither: %s", (command) => {
    expect(holding(claudePromptProblems([bash(command)], PROJECT))).toEqual(["problems"]);
  });

  test.each(KNOWN_GAPS)("a run the word check cannot see is listed and counted, not failed: %s", (command) => {
    expect(holding(claudePromptProblems([bash(command)], PROJECT))).toEqual(["folderCommands"]);
  });

  test("a file tool asking inside aidlc/ or .claude/ fails the drive", () => {
    for (const request of [
      { toolName: "Write", input: { file_path: "aidlc/spaces/default/intents/notes.md", content: "x" } },
      { toolName: "Write", input: { file_path: join(PROJECT, "aidlc", "spaces", "default", "intents", "notes.md"), content: "x" } },
      { toolName: "Edit", input: { file_path: ".claude/settings.json", old_string: "a", new_string: "b" } },
      { toolName: "Edit", input: { file_path: join(PROJECT, ".claude", "tools", "aidlc.ts"), old_string: "a", new_string: "b" } },
      { toolName: "Read", input: { file_path: join(PROJECT, ".claude", "settings.json") } },
    ]) {
      expect(holding(claudePromptProblems([request], PROJECT)), JSON.stringify(request)).toEqual(["problems"]);
    }
  });

  test("a write outside the project fails the drive, wherever it points", () => {
    const outside = process.platform === "win32" ? "C:\\Users\\p\\AppData\\Local\\Temp\\x.ts" : "/tmp/x.ts";
    for (const request of [
      { toolName: "Write", input: { file_path: outside, content: "x" } },
      { toolName: "Edit", input: { file_path: join(PROJECT, "..", "other", "a.ts"), old_string: "a", new_string: "b" } },
    ]) {
      expect(holding(claudePromptProblems([request], PROJECT)), JSON.stringify(request)).toEqual(["problems"]);
    }
  });

  test("the project's own commands and files are only listed, and a name that only contains aidlc is not AI-DLC's", () => {
    for (const request of [
      bash("bun test"),
      bash("git diff --stat"),
      bash("ls src"),
      bash("cat docs/my-aidlc/notes.md"),
      bash("grep -rn aidlc-workflows src"),
      bash("bun --version && ls my.claude/tools"),
      { toolName: "Read", input: { file_path: join(PROJECT, "src", "price.ts") } },
      { toolName: "WebFetch", input: { url: "https://example.com/aidlc/x" } },
    ]) {
      expect(holding(claudePromptProblems([request], PROJECT)), JSON.stringify(request)).toEqual(["listed"]);
    }
  });

  test("each list says what it holds", () => {
    const write = { toolName: "Write", input: { file_path: "aidlc/spaces/default/intents/notes.md", content: "x" } };
    const outside = { toolName: "Write", input: { file_path: join(PROJECT, "..", "other", "a.ts"), content: "x" } };
    expect(claudePromptProblems([bash(OWN_TOOL[0]), write, outside, bash("ls aidlc"), bash("bun test")], PROJECT)).toEqual({
      problems: [
        'a command that runs AI-DLC\'s own tool asked for permission: Bash "bun .claude/tools/aidlc.ts engine next | head -50"',
        'a file tool asked for permission inside AI-DLC\'s folders: Write "aidlc/spaces/default/intents/notes.md"',
        `a write outside the project asked for permission: Write ${JSON.stringify(join(PROJECT, "..", "other", "a.ts"))}`,
      ],
      folderCommands: ['Bash "ls aidlc"'],
      listed: ['Bash "bun test"'],
    });
  });
});

describe("the heading a job log shows for the listed shell commands", () => {
  test("the count, then one line for each command", () => {
    const { folderCommands } = claudePromptProblems(FOLDER_ONLY.slice(0, 2).map(bash), PROJECT);
    expect(stock.folderCommandsBlock(folderCommands)).toBe([
      "Shell commands that name AI-DLC folders, listed not failed (2)",
      `  Bash ${JSON.stringify(FOLDER_ONLY[0])}`,
      `  Bash ${JSON.stringify(FOLDER_ONLY[1])}`,
    ].join("\n"));
  });

  test("none still prints the heading with its count", () => {
    expect(stock.folderCommandsBlock([])).toBe("Shell commands that name AI-DLC folders, listed not failed (0)");
  });
});

describe("Codex in its shipped workspace-write sandbox", () => {
  test.each([
    "/bin/bash -lc 'bun .codex/tools/aidlc-utility.ts space teamB'",
    "powershell.exe -Command \"bun .codex\\tools\\aidlc.ts engine next\"",
    "/bin/bash -lc 'cd /work/shop && bun /work/shop/.codex/tools/aidlc.ts engine next'",
    "powershell.exe -Command \"Set-Location .codex\\tools; bun aidlc.ts engine next\"",
  ])("the sandbox refusing a command that runs AI-DLC's own tool fails the turn: %s", (command) => {
    expect(holding(codexSandboxProblems(codexEvent(command, "error: EROFS: Read-only file system, open '.codex/config.toml'")))).toEqual(["problems"]);
  });

  test.each([
    ["/bin/bash -lc 'printf x > .codex/config.toml'", "bash: .codex/config.toml: Operation not permitted"],
    ["powershell.exe -Command \"Set-Content aidlc\\x.md y\"", "Access to the path 'C:\\work\\aidlc\\x.md' is denied."],
  ])("a refused command that only names AI-DLC's folders is listed and counted, not failed: %s", (command, output) => {
    expect(holding(codexSandboxProblems(codexEvent(command, output)))).toEqual(["folderCommands"]);
  });

  test("a refusal of another command is listed; a clean or non-JSON run has nothing", () => {
    expect(holding(codexSandboxProblems(codexEvent("/bin/bash -lc 'touch /etc/x'", "touch: cannot touch '/etc/x': Read-only file system")))).toEqual(["listed"]);
    expect(holding(codexSandboxProblems(codexEvent("/bin/bash -lc 'bun .codex/tools/aidlc.ts engine next'", "ok", 0)))).toEqual([]);
    expect(holding(codexSandboxProblems("Codex's final message, not JSON\n"))).toEqual([]);
  });

  test("each list says what it holds, one line for each command", () => {
    const stdout = [
      codexEvent("/bin/bash -lc 'bun .codex/tools/aidlc-utility.ts space teamB'", "error: EROFS: Read-only file system, open '.codex/config.toml'"),
      codexEvent("/bin/bash -lc 'cat <<EOF > aidlc/notes.md\nhi\nEOF'", "bash: aidlc/notes.md: Read-only file system"),
      codexEvent("/bin/bash -lc 'touch /etc/x'", "touch: cannot touch '/etc/x': Read-only file system"),
    ].join("\n");
    expect(codexSandboxProblems(stdout)).toEqual({
      problems: [
        "the sandbox refused a command that runs AI-DLC's own tool: \"/bin/bash -lc 'bun .codex/tools/aidlc-utility.ts space teamB'\" (error: EROFS: Read-only file system, open '.codex/config.toml')",
      ],
      folderCommands: ["\"/bin/bash -lc 'cat <<EOF > aidlc/notes.md\\nhi\\nEOF'\" (bash: aidlc/notes.md: Read-only file system)"],
      listed: ["\"/bin/bash -lc 'touch /etc/x'\" (touch: cannot touch '/etc/x': Read-only file system)"],
    });
  });
});

describe("opencode on the shipped permission table", () => {
  test("a refused call that runs AI-DLC's own tool or touches its files fails the turn", () => {
    for (const event of [
      opencodeEvent("bash", { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next" }, "error", REJECTED),
      opencodeEvent("edit", { filePath: "/work/proj/.aidlc/hooks/aidlc-x.ts" }, "error", REJECTED),
    ]) {
      expect(holding(opencodePermissionProblems(event)), event).toEqual(["problems"]);
    }
  });

  test("a refused shell command that only names AI-DLC's folders is listed and counted, not failed", () => {
    expect(holding(opencodePermissionProblems(opencodeEvent("bash", { command: "rm -r aidlc/spaces/default/intents/old" }, "error", REJECTED))))
      .toEqual(["folderCommands"]);
  });

  test("another refusal is listed; a call that ran or failed on its own has nothing", () => {
    expect(holding(opencodePermissionProblems(opencodeEvent("bash", { command: "rm -r ./scratch-dir" }, "error", REJECTED)))).toEqual(["listed"]);
    expect(holding(opencodePermissionProblems([
      opencodeEvent("bash", { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next" }, "completed"),
      opencodeEvent("bash", { command: "bun .aidlc/tools/aidlc.ts engine orchestrate report" }, "error", "exit 1"),
      "not json",
    ].join("\n")))).toEqual([]);
  });

  test("each list says what it holds", () => {
    const stdout = [
      opencodeEvent("bash", { command: "bun .aidlc/tools/aidlc.ts engine orchestrate next" }, "error", REJECTED),
      opencodeEvent("edit", { filePath: "/work/proj/.aidlc/hooks/aidlc-x.ts" }, "error", REJECTED),
      opencodeEvent("bash", { command: "rm -r aidlc/spaces/default/intents/old" }, "error", REJECTED),
      opencodeEvent("bash", { command: "rm -r ./scratch-dir" }, "error", REJECTED),
    ].join("\n");
    expect(opencodePermissionProblems(stdout)).toEqual({
      problems: [
        "opencode refused a command that runs AI-DLC's own tool on the shipped permissions: bash \"bun .aidlc/tools/aidlc.ts engine orchestrate next\"",
        "opencode refused a call inside AI-DLC's folders on the shipped permissions: edit \"/work/proj/.aidlc/hooks/aidlc-x.ts\"",
      ],
      folderCommands: ["bash \"rm -r aidlc/spaces/default/intents/old\""],
      listed: ["bash \"rm -r ./scratch-dir\""],
    });
  });
});
