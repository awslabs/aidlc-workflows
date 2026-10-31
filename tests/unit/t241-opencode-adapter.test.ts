// t241-opencode-adapter: execute the authored plugin factory against synthetic
// opencode lifecycle calls and real or purpose-built core hook subprocesses.
//
// covers: function:KNOWN_HARNESS_DIRS, hook:aidlc-rebuild-stage-graph

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import adapterPlugin, {
  type PluginInput,
} from "../../harness/opencode/plugin/aidlc-opencode-adapter.ts";
import { windowsScriptLaunch } from "../../core/tools/aidlc-executable-path.ts";

const createAdapter = adapterPlugin.server;
import {
  createTestProject,
  seedAidlcMemory,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  auditBlockField,
  inspectSubagentInflight,
  readAuditShardEvents,
  readSessionBinding,
  subagentInflightMarkerPath,
  writeSessionBinding,
  stateDigest,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { writeActiveDirectiveMarker } from "../../core/tools/aidlc-lib.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TEST_AIDLC_COMMAND = [
  process.execPath,
  join(REPO_ROOT, "tests", "harness", "aidlc-hook-driver.ts"),
] as const;
const TEST_ENTRYPOINTS = new Set([
  "tools/aidlc-orchestrate.ts",
  "tools/aidlc-state.ts",
  "tools/aidlc-utility.ts",
  "hooks/aidlc-continue-workflow.ts",
]);
const scratch: string[] = [];
// A request the launcher cannot carry goes through the file `next` reads.
const REQUEST_FILE_STEP =
  "with your file tool to aidlc/.aidlc-request-text/request.txt in this project, and run the same command with " +
  "--request-file aidlc/.aidlc-request-text/request.txt in place of the request's words";

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshProject(): string {
  const root = mkdtempSync(join(tmpdir(), "t241-opencode-"));
  scratch.push(root);
  mkdirSync(join(root, ".aidlc", "hooks"), { recursive: true });
  mkdirSync(join(root, ".aidlc", "tools"), { recursive: true });
  return root;
}

function freshInstalledProject(): string {
  const root = createTestProject();
  scratch.push(root);
  cpSync(
    join(REPO_ROOT, "dist", "opencode", ".aidlc"),
    join(root, ".aidlc"),
    { recursive: true },
  );
  seedAidlcMemory(root);
  return root;
}

function seedUnapprovedCodeGeneration(root: string): void {
  seedStateFile(root, "state-construction.md");
  const statePath = join(seededRecordDir(root), "aidlc-state.md");
  const state = readFileSync(statePath, "utf-8").replace(
    /^- \*\*Current Stage\*\*:.*$/m,
    "- **Current Stage**: code-generation",
  );
  writeFileSync(statePath, state);
  writeActiveDirectiveMarker(root, {
    kind: "run-stage",
    stage: "code-generation",
    state_sha256: stateDigest(state),
  });
}

function readAudit(root: string): string {
  const auditDir = seededAuditDir(root);
  return readdirSync(auditDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readFileSync(join(auditDir, name), "utf-8"))
    .join("\n");
}

function appendInteractionEvent(
  root: string,
  event: "DECISION_RECORDED" | "QUESTION_ANSWERED" | "STAGE_STARTED",
  stage: string,
): void {
  const shard = seededAuditShard(root);
  mkdirSync(dirname(shard), { recursive: true });
  appendFileSync(
    shard,
    `\n## ${event}\n` +
      `**Timestamp**: ${new Date().toISOString()}\n` +
      `**Event**: ${event}\n` +
      `**Stage**: ${stage}\n\n---\n`,
    "utf-8",
  );
}

function writeHook(root: string, name: string, source: string): void {
  const path = join(root, ".aidlc", "hooks", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf-8");
}

function copyCore(root: string, relativePath: string): void {
  const source = join(REPO_ROOT, "core", relativePath);
  const destination = join(root, ".aidlc", relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (relativePath === "tools/aidlc-lib.ts") {
    for (const dependency of [
      "aidlc-settings.ts",
      "aidlc-markdown.ts",
      "aidlc-locks.ts",
      "aidlc-review-records.ts",
      "aidlc-record-core.ts",
      "aidlc-learned-date.ts",
      "aidlc-unit-landing.ts",
      "aidlc-kiro-chat-record.ts",
      "aidlc-install-paths.ts",
      "aidlc-distribution.ts",
      "aidlc-channel.ts",
      "aidlc-version.ts",
      "aidlc-guard-fences.ts",
      "aidlc-guard-switch.ts",
      "aidlc-guard-operation.ts",
      "aidlc-reply-reader.ts",
      "aidlc-runtime-budget.ts",
      "aidlc-lock-line.ts",
      "aidlc-review-manifest.ts",
      "aidlc-command.ts",
      "aidlc-color.ts",
    ]) {
      copyFileSync(
        join(REPO_ROOT, "core", "tools", dependency),
        join(root, ".aidlc", "tools", dependency),
      );
    }
  }
}

// `echo`, when set, gets each prompt's parts as opencode hands them to
// chat.message: a part keeps the id it was sent with (opencode 1.18.18).
function fakeClient(parentBySession: Record<string, string | undefined> = {}) {
  const prompts: Array<{ id: string; text: string; synthetic?: boolean; partId?: string }> = [];
  const echo: { to?: (sessionID: string, parts: Array<Record<string, unknown>>) => Promise<void> } = {};
  const client: PluginInput["client"] = {
    session: {
      get: async ({ path }) => ({
        data: parentBySession[path.id]
          ? { parentID: parentBySession[path.id] }
          : {},
      }),
      prompt: async ({ path, body }) => {
        prompts.push({ id: path.id, text: body.parts[0]?.text ?? "", synthetic: body.parts[0]?.synthetic, partId: body.parts[0]?.id });
        await echo.to?.(path.id, body.parts.map((part) => ({ ...part })));
      },
    },
  };
  return { client, prompts, echo };
}

function postTool(tool: string, args: Record<string, unknown>) {
  return {
    tool,
    sessionID: "main",
    callID: `call-${tool}`,
    args,
  };
}

function createTestAdapter(
  client: PluginInput["client"],
  directory: string,
) {
  return createAdapter({
    client,
    directory,
    aidlcEntrypoints: TEST_ENTRYPOINTS,
    aidlcCommand: TEST_AIDLC_COMMAND,
  });
}

// A file write through each of opencode's three file tools, and a to-do list
// whose task in progress names its stage the way the stage protocol asks.
const FILE_WRITES: Array<[string, Record<string, unknown>]> = [
  ["write", { filePath: "aidlc/notes.md" }],
  ["edit", { filePath: "aidlc/notes.md" }],
  ["apply_patch", { patchText: "*** Begin Patch\n*** Update File: aidlc/notes.md\n*** End Patch" }],
];
const TODO_IN_PROGRESS = { todos: [{ content: "Running Requirements Analysis [requirements-analysis]", status: "in_progress" }] };

describe("t241 OpenCode adapter command boundary and transition filter", () => {
  test("plan-approval guard calls carry the OpenCode session id", async () => {
    const root = freshProject();
    const capture = join(root, "guard-input.jsonl");
    for (const hook of [
      "aidlc-deliver-stage-rules.ts",
      "aidlc-review-freeze.ts",
      "aidlc-reviewer-scope.ts",
      "aidlc-state-transition-guard.ts",
    ]) {
      writeFileSync(join(root, ".aidlc", "hooks", hook), "export async function run(): Promise<number> { return 0; }\n");
    }
    writeFileSync(
      join(root, ".aidlc", "hooks", "aidlc-plan-approval-guard.ts"),
      [
        'import { appendFileSync } from "node:fs";',
        "export async function run(input: string): Promise<number> {",
        `  appendFileSync(${JSON.stringify(capture)}, input + "\\n");`,
        "  return 0;",
        "}",
      ].join("\n"),
    );
    // A child (task-tool) session is sent as the main session that owns it,
    // since only the main session has a binding.
    const { client } = fakeClient({ "S-OC-child": "S-OC-worker", "S-OC-worker": "S-OC" });
    const adapter = await createTestAdapter(client, root);
    const before = adapter["tool.execute.before"];
    await before({ tool: "write", sessionID: "S-OC", callID: "w" }, { args: { filePath: join(root, "src", "a.ts") } });
    await before(
      { tool: "task", sessionID: "S-OC", callID: "t" },
      { args: { subagent_type: "aidlc-developer-agent", prompt: "AIDLC-UNIT: todo-core" } },
    );
    await before(
      { tool: "write", sessionID: "S-OC-child", callID: "cw" },
      { args: { filePath: join(root, "src", "b.ts") } },
    );
    const sessions = readFileSync(capture, "utf-8").trim().split("\n")
      .map((line) => (JSON.parse(line) as { session_id?: unknown }).session_id);
    expect(sessions).toEqual(["S-OC", "S-OC", "S-OC"]);
  });

  test("state-transition, review-freeze and reviewer-scope calls carry the owning session id", async () => {
    const root = freshProject();
    const recorder = (capture: string) => [
      'import { appendFileSync } from "node:fs";',
      "export async function run(input: string): Promise<number> {",
      `  appendFileSync(${JSON.stringify(capture)}, input + "\\n");`,
      "  return 0;",
      "}",
    ].join("\n");
    const guards = ["aidlc-state-transition-guard.ts", "aidlc-review-freeze.ts", "aidlc-reviewer-scope.ts"];
    for (const hook of ["aidlc-deliver-stage-rules.ts", "aidlc-plan-approval-guard.ts"]) {
      writeFileSync(join(root, ".aidlc", "hooks", hook), "export async function run(): Promise<number> { return 0; }\n");
    }
    for (const hook of guards) writeFileSync(join(root, ".aidlc", "hooks", hook), recorder(join(root, `${hook}.jsonl`)));
    const { client } = fakeClient({ "S-OC-child": "S-OC" });
    const adapter = await createTestAdapter(client, root);
    const before = adapter["tool.execute.before"];
    await before({ tool: "bash", sessionID: "S-OC-child", callID: "b" }, { args: { command: "echo hi" } });
    await before({ tool: "write", sessionID: "S-OC-child", callID: "w" }, { args: { filePath: join(root, "src", "a.ts") } });
    for (const hook of guards) {
      const sessions = readFileSync(join(root, `${hook}.jsonl`), "utf-8").trim().split("\n")
        .map((line) => (JSON.parse(line) as { session_id?: unknown }).session_id);
      expect({ hook, sessions: [...new Set(sessions)] }).toEqual({ hook, sessions: ["S-OC"] });
    }
  });

  test("a child session's record forwards carry the owning session", async () => {
    const root = freshProject();
    const recorder = (capture: string) => [
      'import { appendFileSync } from "node:fs";',
      "export async function run(input: string): Promise<number> {",
      `  appendFileSync(${JSON.stringify(capture)}, input + "\\n");`,
      "  return 0;",
      "}",
    ].join("\n");
    // Every forward a child's event makes: the task dispatch, a bash call's
    // record writes, a file write's audit and sensors, the to-do sync, the
    // subagent completion and the compaction.
    const recorded = [
      "aidlc-deliver-stage-rules.ts",
      "aidlc-rebuild-stage-graph.ts",
      "aidlc-write-audit-log.ts",
      "aidlc-run-sensors.ts",
      "aidlc-sync-workflow-state.ts",
      "aidlc-log-subagent.ts",
      "aidlc-validate-state.ts",
    ];
    for (const hook of ["aidlc-plan-approval-guard.ts", "aidlc-review-freeze.ts", "aidlc-reviewer-scope.ts", "aidlc-state-transition-guard.ts"]) {
      writeFileSync(join(root, ".aidlc", "hooks", hook), "export async function run(): Promise<number> { return 0; }\n");
    }
    for (const hook of recorded) writeFileSync(join(root, ".aidlc", "hooks", hook), recorder(join(root, `${hook}.jsonl`)));
    const { client } = fakeClient({ "S-OC-child": "S-OC" });
    const adapter = await createTestAdapter(client, root);
    await adapter["tool.execute.before"](
      { tool: "task", sessionID: "S-OC-child", callID: "t" },
      { args: { subagent_type: "aidlc-developer-agent", prompt: "AIDLC-UNIT: todo-core" } },
    );
    await adapter["tool.execute.after"]({ tool: "bash", sessionID: "S-OC-child", callID: "b", args: { command: "echo hi" } });
    for (const [tool, args] of FILE_WRITES) await adapter["tool.execute.after"]({ tool, sessionID: "S-OC-child", callID: tool, args });
    await adapter["tool.execute.after"]({ tool: "todowrite", sessionID: "S-OC-child", callID: "td", args: TODO_IN_PROGRESS });
    await adapter["tool.execute.after"]({ tool: "task", sessionID: "S-OC-child", callID: "t", args: { subagent_type: "aidlc-developer-agent" } });
    await adapter["experimental.session.compacting"]({ sessionID: "S-OC-child" });
    for (const hook of recorded) {
      const path = join(root, `${hook}.jsonl`);
      if (!existsSync(path)) continue;
      const sessions = readFileSync(path, "utf-8").trim().split("\n")
        .map((line) => (JSON.parse(line) as { session_id?: unknown }).session_id);
      expect({ hook, sessions: [...new Set(sessions)] }).toEqual({ hook, sessions: ["S-OC"] });
    }
    for (const hook of ["aidlc-write-audit-log.ts", "aidlc-run-sensors.ts", "aidlc-sync-workflow-state.ts", "aidlc-log-subagent.ts", "aidlc-validate-state.ts"]) {
      expect({ hook, ran: existsSync(join(root, `${hook}.jsonl`)) }).toEqual({ hook, ran: true });
    }
  });

  test("a child whose owner cannot be confirmed still has its file writes and to-do update recorded, with no session", async () => {
    const root = freshProject();
    const recorder = (capture: string) => [
      'import { appendFileSync } from "node:fs";',
      "export async function run(input: string): Promise<number> {",
      `  appendFileSync(${JSON.stringify(capture)}, input + "\\n");`,
      "  return 0;",
      "}",
    ].join("\n");
    const recorded = ["aidlc-write-audit-log.ts", "aidlc-run-sensors.ts", "aidlc-sync-workflow-state.ts"];
    for (const hook of recorded) writeFileSync(join(root, ".aidlc", "hooks", hook), recorder(join(root, `${hook}.jsonl`)));
    const { client } = fakeClient({ "S-OC-child": "S-OC" });
    client.session.get = async () => {
      throw new Error("transient");
    };
    const adapter = await createTestAdapter(client, root);
    for (const [tool, args] of FILE_WRITES) await adapter["tool.execute.after"]({ tool, sessionID: "S-OC-child", callID: tool, args });
    await adapter["tool.execute.after"]({ tool: "todowrite", sessionID: "S-OC-child", callID: "td", args: TODO_IN_PROGRESS });
    for (const hook of recorded) {
      const payloads = readFileSync(join(root, `${hook}.jsonl`), "utf-8").trim().split("\n")
        .map((line) => JSON.parse(line) as { session_id?: unknown });
      expect({ hook, sessions: [...new Set(payloads.map((payload) => "session_id" in payload ? payload.session_id : "absent"))] })
        .toEqual({ hook, sessions: ["absent"] });
    }
  });

  test("an owner lookup that fails refuses the call instead of guarding it under another session", async () => {
    const root = freshProject();
    const recorder = (capture: string) => [
      'import { appendFileSync } from "node:fs";',
      "export async function run(input: string): Promise<number> {",
      `  appendFileSync(${JSON.stringify(capture)}, input + "\\n");`,
      "  return 0;",
      "}",
    ].join("\n");
    const guards = [
      "aidlc-state-transition-guard.ts",
      "aidlc-review-freeze.ts",
      "aidlc-reviewer-scope.ts",
      "aidlc-plan-approval-guard.ts",
    ];
    writeFileSync(join(root, ".aidlc", "hooks", "aidlc-deliver-stage-rules.ts"), "export async function run(): Promise<number> { return 0; }\n");
    for (const hook of guards) writeFileSync(join(root, ".aidlc", "hooks", hook), recorder(join(root, `${hook}.jsonl`)));
    let failing: "throw" | "empty" | false = "throw";
    const { client } = fakeClient({ "S-OC-child": "S-OC" });
    const get = client.session.get;
    client.session.get = async (request) => {
      if (failing === "throw") throw new Error("transient");
      if (failing === "empty") return { data: undefined } as Awaited<ReturnType<typeof get>>;
      return get(request);
    };
    const adapter = await createTestAdapter(client, root);
    const before = adapter["tool.execute.before"];
    const calls = [
      () => before({ tool: "bash", sessionID: "S-OC-child", callID: "b" }, { args: { command: "echo hi" } }),
      () => before({ tool: "write", sessionID: "S-OC-child", callID: "w" }, { args: { filePath: join(root, "src", "a.ts") } }),
    ];
    for (const mode of ["throw", "empty"] as const) {
      failing = mode;
      for (const call of calls) await expect(call()).rejects.toThrow("could not confirm");
    }
    for (const hook of guards) expect({ hook, ran: existsSync(join(root, `${hook}.jsonl`)) }).toEqual({ hook, ran: false });
    // The failure is not remembered: once the lookup answers, the owner is used.
    failing = false;
    for (const call of calls) await call();
    for (const hook of guards) {
      const sessions = readFileSync(join(root, `${hook}.jsonl`), "utf-8").trim().split("\n")
        .map((line) => (JSON.parse(line) as { session_id?: unknown }).session_id);
      expect({ hook, sessions: [...new Set(sessions)] }).toEqual({ hook, sessions: ["S-OC"] });
    }
  });

  test("rejects compound aidlc commands but leaves one invocation and unrelated bash alone", async () => {
    const root = freshProject();
    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    const before = adapter["tool.execute.before"];
    const invoke = (callID: string, command: string) =>
      before(
        { tool: "bash", sessionID: "main", callID },
        { args: { command } },
      );
    await expect(
      invoke("safe", "aidlc engine state approve"),
    ).resolves.toBeUndefined();
    await expect(
      invoke("quoted", 'aidlc engine status "a && b"'),
    ).resolves.toBeUndefined();
    await expect(
      invoke("unrelated", "echo ok && touch /tmp/example"),
    ).resolves.toBeUndefined();
    await expect(
      invoke(
        "compound",
        "aidlc engine status && touch /tmp/example",
      ),
    ).rejects.toThrow("one direct invocation");
    await expect(
      invoke("redirect", "bun .aidlc/hooks/aidlc-continue-workflow.ts > /tmp/example"),
    ).rejects.toThrow("one direct invocation");
    await expect(
      invoke("unknown", "aidlc engine payload"),
    ).resolves.toBeUndefined();
    await expect(
      invoke(
        "quote-bypass",
        "aidlc engine status 'a\\' ; touch /tmp/x #'",
      ),
    ).rejects.toThrow("one direct invocation");
  });

  // A live run's first request carried a pasted spec with an apostrophe and a
  // line break; both ways the agent quoted it were refused, so the work could
  // not start. These are those two commands, byte for byte.
  const SPEC =
    "Build this for our office. <document>Meeting room booking. Staff see today's rooms (name, seats, screen yes/no) " +
    "and free slots in 30-minute steps from 08:00 to 18:00. They book a free slot with their name and a title; they can " +
    "cancel their own booking. A room cannot be double booked. A wall screen per room shows the current and next booking.\n" +
    "</document>  Keep the first version small.";
  const START_SINGLE = `bun .aidlc/tools/aidlc.ts engine orchestrate next --scope feature '${SPEC.replaceAll("'", "'\\''")}'`;
  const START_DOUBLE = `bun .aidlc/tools/aidlc.ts engine orchestrate next --scope feature "${SPEC}"`;

  test("a pasted request with an apostrophe and a line break starts in any usual quoting, as one argument", async () => {
    const root = freshProject();
    // With no shell set, opencode runs /bin/sh on POSIX and cmd.exe on Windows.
    // Both are read the same way on every OS, so each is checked everywhere.
    const adapterOn = async (platform: NodeJS.Platform) => {
      const { client } = fakeClient();
      const adapter = await createAdapter({
        client,
        directory: root,
        aidlcEntrypoints: new Set([...TEST_ENTRYPOINTS, "tools/aidlc.ts"]),
        aidlcCommand: TEST_AIDLC_COMMAND,
        platform,
      });
      return (callID: string, command: string) =>
        adapter["tool.execute.before"]({ tool: "bash", sessionID: "main", callID }, { args: { command } });
    };
    const sh = await adapterOn("linux");
    const cmd = await adapterOn("win32");
    const pasted = [
      START_SINGLE,
      START_DOUBLE,
      `bun .aidlc/tools/aidlc.ts engine orchestrate next '${SPEC.replaceAll("'", `'"'"'`)}'`,
    ];
    const escaped = "aidlc engine orchestrate next today\\'s\\ rooms";
    for (const [i, command] of [...pasted, escaped].entries()) {
      await expect(sh(`ok-${i}`, command)).resolves.toBeUndefined();
    }
    // cmd.exe cannot carry the line break, so the request goes through the file
    // `next` reads; it gives the backslash no meaning, so that one is refused.
    for (const [i, command] of pasted.entries()) {
      await expect(cmd(`cmd-ok-${i}`, command)).rejects.toThrow(REQUEST_FILE_STEP);
    }
    await expect(cmd("cmd-escaped", escaped)).rejects.toThrow("one direct invocation");
    // Still one command only: chaining, substitution and expansion outside or
    // inside double quotes, and $'...', which /bin/sh may read as more than one
    // word, are refused. cmd.exe gives $ and the backtick no meaning, so there
    // the quoted ones are one plain argument.
    const posixExpansions = [
      "bun .aidlc/tools/aidlc.ts engine orchestrate next \"today's $(touch /tmp/x)\"",
      "bun .aidlc/tools/aidlc.ts engine orchestrate next \"today's `touch /tmp/x`\"",
      "bun .aidlc/tools/aidlc.ts engine orchestrate next \"$HOME\"",
    ];
    for (const [i, command] of posixExpansions.entries()) {
      await expect(sh(`expand-${i}`, command)).rejects.toThrow("one direct invocation");
      await expect(cmd(`cmd-expand-${i}`, command)).resolves.toBeUndefined();
    }
    // Chained after a request, or joined by a line continuation: refused by
    // both, on cmd.exe through the request file wherever a line break is in it.
    for (const [i, [command, onCmd]] of ([
      [`${START_SINGLE} ; touch /tmp/x`, REQUEST_FILE_STEP],
      [`${START_SINGLE}\ntouch /tmp/x`, REQUEST_FILE_STEP],
      ["bun .aidlc/tools/aidlc.ts engine orchestrate next $'today\\'s rooms\\; touch /tmp/x'", "one direct invocation"],
      ["aidlc engine orchestrate next today\\' ; touch /tmp/x", "one direct invocation"],
      // A line continuation: the shell joins the lines, the later guards do not.
      ["aidlc engine orchestrate next today\\\naidlc engine state approve", REQUEST_FILE_STEP],
      ["aidlc engine orchestrate next \"today\\\naidlc engine state approve\"", REQUEST_FILE_STEP],
    ] as const).entries()) {
      await expect(sh(`no-${i}`, command)).rejects.toThrow("one direct invocation");
      await expect(cmd(`cmd-no-${i}`, command)).rejects.toThrow(onCmd);
    }
  });

  test("the boundary reads a command the way the shell opencode is set to use reads it", async () => {
    const root = freshProject();
    const adapterWith = async (config: PluginInput["client"]["config"]) => {
      const { client } = fakeClient();
      const adapter = await createAdapter({
        client: { ...client, config },
        directory: root,
        aidlcEntrypoints: new Set([...TEST_ENTRYPOINTS, "tools/aidlc.ts"]),
        aidlcCommand: TEST_AIDLC_COMMAND,
      });
      return (callID: string, command: string) =>
        adapter["tool.execute.before"]({ tool: "bash", sessionID: "main", callID }, { args: { command } });
    };
    const plain = 'bun .aidlc/tools/aidlc.ts engine orchestrate next --scope feature "Staff see today\'s rooms"';
    // cmd.exe reads a single quote as a plain character, and neither cmd.exe
    // nor PowerShell reads a backslash as an escape: under them these POSIX
    // forms are refused, and cmd.exe ends a command at a line break.
    for (const [shell, config] of [
      ["pwsh", { get: async () => ({ data: { shell: "pwsh" } }) }],
      ["cmd", { get: async () => ({ data: { shell: "C:\\Windows\\System32\\cmd.exe" } }) }],
    ] as const) {
      const invoke = await adapterWith(config);
      await expect(invoke(`${shell}-plain`, plain)).resolves.toBeUndefined();
      for (const [i, command] of [
        START_SINGLE,
        ...(shell === "cmd" ? [START_DOUBLE] : []),
        "aidlc engine orchestrate next today\\'s",
        "aidlc engine orchestrate next a\\;b",
        "aidlc engine orchestrate next '\"' ; touch x ; '\"'",
        "aidlc engine orchestrate next \"a\\\" ; touch x ; \\\"\"",
        ...(shell === "cmd" ? ["aidlc engine orchestrate next \"%PATH%\""] : []),
      ].entries()) {
        await expect(invoke(`${shell}-${i}`, command)).rejects.toThrow(/one direct invocation|cannot reach AI-DLC through/);
      }
    }
    // A shell it cannot learn, or a setting it cannot read, passes no AIDLC
    // command, and the refusal names the setting to change.
    for (const [i, config] of [
      { get: async () => ({ data: { shell: "rc" } }) },
      { get: async () => ({ data: undefined }) },
      { get: async () => { throw new Error("offline"); } },
    ].entries()) {
      const invoke = await adapterWith(config);
      await expect(invoke(`unknown-plain-${i}`, plain)).rejects.toThrow("could not confirm that here");
      await expect(invoke(`unknown-aidlc-${i}`, 'aidlc engine orchestrate next "a; touch x"')).rejects.toThrow("could not confirm that here");
    }
    // A POSIX shell set by path reads the usual quoting.
    const bash = await adapterWith({ get: async () => ({ data: { shell: "C:\\Program Files\\Git\\bin\\bash.exe" } }) });
    await expect(bash("posix-single", START_SINGLE)).resolves.toBeUndefined();
    await expect(bash("posix-double", START_DOUBLE)).resolves.toBeUndefined();
  });

  // Commands each shell runs as one call with these arguments, as AI-DLC's own
  // commands and the opencode skill write them there.
  const PWSH_OK: Array<[string, string[]]> = [
    ["aidlc engine orchestrate report --stage x --result approved --user-input 'Approve'", ["Approve"]],
    ["bun .aidlc/tools/aidlc.ts engine orchestrate next 'Staff see today''s rooms; 50% booked!'", ["Staff see today's rooms; 50% booked!"]],
    ['bun .aidlc/tools/aidlc.ts engine orchestrate next "Staff see today\'s rooms; 50% booked!"', ["Staff see today's rooms; 50% booked!"]],
    // Bun is a program of its own: nothing reads its arguments again.
    ["bun .aidlc/tools/aidlc.ts engine orchestrate next 'R&D books rooms | QA\nat 50% of %TEMP%'", ["R&D books rooms | QA\nat 50% of %TEMP%"]],
    [START_DOUBLE, ["--scope", "feature", SPEC]],
  ];
  // PowerShell 7 hands Bun an empty argument, a " inside a word and a trailing
  // backslash as written.
  const PWSH7_OK: Array<[string, string[]]> = [
    [
      "bun .aidlc/tools/aidlc.ts engine orchestrate next 'Rename \"Tasks\" to \"Todos\"' '' 'C:\\dir\\'",
      ['Rename "Tasks" to "Todos"', "", "C:\\dir\\"],
    ],
  ];
  const CMD_OK: Array<[string, string[]]> = [
    ['bun .aidlc/tools/aidlc.ts engine orchestrate next "Staff see today\'s rooms; 50% booked!"', ["Staff see today's rooms; 50% booked!"]],
    ['aidlc engine orchestrate next "Rename \u201cTasks\u201d, R&D | QA"', ["Rename \u201cTasks\u201d, R&D | QA"]],
    ['bun .aidlc/tools/aidlc.ts engine orchestrate next "Wow, say !T241_VALUE now"', ["Wow, say !T241_VALUE now"]],
    // cmd.exe expands neither $ nor the backtick, so text holding them and an &
    // (refused by PowerShell, which names cmd.exe) can be sent from here.
    ['aidlc engine orchestrate next "Price rooms at $5k & up for `R&D`"', ["Price rooms at $5k & up for `R&D`"]],
    ['bun .aidlc/tools/aidlc.ts engine orchestrate next $PATH "$HOME & `whoami`"', ["$PATH", "$HOME & `whoami`"]],
  ];

  test("PowerShell and cmd.exe each read their own quoting, and a quote either reads differently is refused", async () => {
    const root = freshProject();
    const adapterWith = async (shell: string, platform: NodeJS.Platform = "win32") => {
      const { client } = fakeClient();
      const adapter = await createAdapter({
        client: { ...client, config: { get: async () => ({ data: { shell } }) } },
        directory: root,
        aidlcEntrypoints: new Set([...TEST_ENTRYPOINTS, "tools/aidlc.ts"]),
        aidlcCommand: TEST_AIDLC_COMMAND,
        platform,
      });
      return (callID: string, command: string) =>
        adapter["tool.execute.before"]({ tool: "bash", sessionID: "main", callID }, { args: { command } });
    };
    // Windows PowerShell 5.1 and cmd.exe, wherever the tests run.
    const pwsh = await adapterWith("powershell");
    const cmd = await adapterWith("cmd.exe");
    for (const [i, [command]] of PWSH_OK.entries()) await expect(pwsh(`ps-ok-${i}`, command)).resolves.toBeUndefined();
    for (const [i, [command]] of CMD_OK.entries()) await expect(cmd(`cmd-ok-${i}`, command)).resolves.toBeUndefined();
    // PowerShell ends a quote at a typographic or doubled quote and joins a
    // word to a quote, so these do not reach the tool as written.
    for (const [i, command] of [
      'aidlc engine orchestrate next "fix \u201d; New-Item x; \u201c"',
      "aidlc engine orchestrate next 'fix \u2019; New-Item x; \u2018'",
      'aidlc engine orchestrate next "a""; New-Item x; ""b"',
      "aidlc engine orchestrate next 'a''; New-Item x; ''b'x",
      "aidlc engine orchestrate next 'a'b",
      "aidlc engine orchestrate next 'Rename \"Tasks\"'",
      "aidlc engine orchestrate next 'C:\\dir\\'",
      "aidlc engine orchestrate next ''",
      "aidlc engine orchestrate next a,b",
      "aidlc engine orchestrate next *",
      "aidlc engine orchestrate next a\u00a0b",
    ].entries()) {
      await expect(pwsh(`ps-no-${i}`, command)).rejects.toThrow("one direct invocation");
    }
    // The aidlc launcher hands its arguments to cmd.exe on Windows, and
    // PowerShell passes a word with no space on bare. Each refusal names a step
    // that works: cmd.exe keeps & | < > ^ inside double quotes; nothing on
    // Windows keeps a line break or a %NAME% or !NAME! pair, so a request goes
    // through a file, and any other text is the person's to write.
    for (const [i, [command, step]] of [
      ["aidlc engine orchestrate next 'R&D'", "Set \"shell\" in opencode's settings to cmd.exe"],
      ["aidlc engine orchestrate next 'Book rooms\nfor R and D'", REQUEST_FILE_STEP],
      ["aidlc engine orchestrate next '%APPDATA% and %TEMP%'", REQUEST_FILE_STEP],
      ["aidlc engine orchestrate next '50%' 'of %TEMP'", REQUEST_FILE_STEP],
      ["aidlc engine orchestrate next 'say !T241_VALUE! now'", REQUEST_FILE_STEP],
      ["aidlc engine log answer --stage requirements-analysis --details 'Book rooms\nfor R and D'", "Ask the person how to write the text"],
    ].entries()) {
      await expect(pwsh(`ps-launcher-${i}`, command)).rejects.toThrow(step);
    }
    // cmd.exe reads a single quote as a plain character, replaces %NAME% even
    // inside quotes, and a program reads \" as a quote inside a word.
    for (const [i, command] of [
      "aidlc engine orchestrate next 'Approve'",
      'aidlc engine orchestrate next "a\\" & touch x & "b"',
      'aidlc engine orchestrate next R^&D',
      'aidlc engine log answer --stage requirements-analysis --details "%APPDATA%"',
    ].entries()) {
      await expect(cmd(`cmd-no-${i}`, command)).rejects.toThrow("one direct invocation");
    }
    // cmd.exe ends a command at a line break and replaces a %NAME% or !NAME!
    // pair even inside quotes, so a request holding one goes through a file.
    for (const [i, command] of [
      'aidlc engine orchestrate next "%APPDATA%"',
      'aidlc engine orchestrate next "say !T241_VALUE! now"',
      'aidlc engine orchestrate next "Book rooms\nfor R and D"',
      'bun .aidlc/tools/aidlc.ts engine orchestrate next --scope feature "50% of %TEMP%"',
    ].entries()) {
      await expect(cmd(`cmd-file-${i}`, command)).rejects.toThrow(REQUEST_FILE_STEP);
    }
    // PowerShell 7 on Windows hands Bun its arguments as written, and the aidlc
    // launcher one command line read again by cmd.exe.
    const pwsh7 = await adapterWith("pwsh");
    for (const [i, [command]] of [...PWSH_OK, ...PWSH7_OK].entries()) {
      await expect(pwsh7(`ps7-ok-${i}`, command)).resolves.toBeUndefined();
    }
    for (const [i, [command, refusal]] of [
      ["aidlc engine orchestrate next 'Rename \"Tasks\"'", REQUEST_FILE_STEP],
      ["aidlc engine orchestrate next 'C:\\dir\\'", REQUEST_FILE_STEP],
      ["aidlc engine log answer --stage x --details 'C:\\dir\\'", "Ask the person how to write the text"],
      ["aidlc engine orchestrate next ''", "Leave it out and run the command again"],
      ["aidlc engine orchestrate next 'R&D'", "Set \"shell\" in opencode's settings to cmd.exe"],
      ['bun .aidlc/tools/aidlc.ts engine orchestrate next "fix \u201d; New-Item x; \u201c"', "one direct invocation"],
    ].entries()) {
      await expect(pwsh7(`ps7-no-${i}`, command)).rejects.toThrow(refusal);
    }
    // PowerShell on Linux or macOS hands a program its arguments one by one, and
    // `aidlc` there is no cmd.exe launcher: the person's text passes as written.
    const posixPwsh = await adapterWith("pwsh", "linux");
    for (const [i, command] of [
      "aidlc engine orchestrate next 'R&D books rooms | QA\nat 50% of %TEMP%'",
      "aidlc engine orchestrate next 'Rename \"Tasks\"' 'C:\\dir\\' ''",
      "bun .aidlc/tools/aidlc.ts engine orchestrate next 'Rename \"Tasks\" for R&D'",
    ].entries()) {
      await expect(posixPwsh(`posix-ps-ok-${i}`, command)).resolves.toBeUndefined();
    }
    for (const [i, command] of [
      'aidlc engine orchestrate next "fix \u201d; New-Item x; \u201c"',
      'aidlc engine orchestrate next "a""; New-Item x; ""b"',
      "aidlc engine orchestrate next 'a'b",
      "aidlc engine orchestrate next *",
    ].entries()) {
      await expect(posixPwsh(`posix-ps-no-${i}`, command)).rejects.toThrow("one direct invocation");
    }
  });

  // On Windows the native install's `aidlc` is aidlc.cmd, which Windows starts
  // only through cmd.exe: a hook started as a bare `aidlc` failed with ENOENT,
  // the plugin went on as if it had run, and no hook ever ran (measured on
  // Windows Server with the 2.11.1 install). The launch is what the person's
  // shell would find; anything else starts as before.
  test("a hook's launch on Windows goes through cmd.exe only for a .cmd or .bat the shell would find", () => {
    const root = mkdtempSync(join(tmpdir(), "t241-launch-"));
    scratch.push(root);
    const folder = (name: string, files: string[]) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      for (const file of files) writeFileSync(join(dir, file), "", { mode: 0o755 });
      return dir;
    };
    const cmdOnly = folder("native-bin", ["aidlc", "aidlc.cmd"]);
    const withExe = folder("exe-bin", ["aidlc.exe", "aidlc.cmd"]);
    const none = folder("empty-bin", []);
    // Windows allows % and ! in an account name, and the default install sits under the profile.
    const account = folder("Users\\me%USERNAME%!x!\\bin", ["aidlc.cmd"]);
    const hookArgs = ["engine", "hook", "session-start"];
    const comSpec = "C:\\Windows\\system32\\cmd.exe";
    // Windows names the variable Path, and ComSpec as it likes.
    // The launcher's path reaches cmd.exe through the environment, so nothing in it is read again.
    expect(windowsScriptLaunch("aidlc", hookArgs, "win32", { Path: `${none};${cmdOnly}`, ComSpec: comSpec })).toEqual({
      file: comSpec,
      args: ["/d", "/v:off", "/s", "/c", '""%AIDLC_CMD_SCRIPT%" engine hook session-start"'],
      env: { AIDLC_CMD_SCRIPT: resolve(cmdOnly, "aidlc.cmd") },
    });
    expect(windowsScriptLaunch("aidlc", hookArgs, "win32", { PATH: cmdOnly })).toMatchObject({ file: "cmd.exe" });
    // An .exe, nothing on PATH, a command named by its path, or another platform: started as named.
    expect(windowsScriptLaunch("aidlc", hookArgs, "win32", { Path: withExe })).toBeNull();
    expect(windowsScriptLaunch("aidlc", hookArgs, "win32", { Path: none })).toBeNull();
    expect(windowsScriptLaunch("aidlc", hookArgs, "linux", { PATH: cmdOnly })).toBeNull();
    expect(windowsScriptLaunch(join(cmdOnly, "aidlc.cmd"), hookArgs, "win32", { Path: cmdOnly })).toBeNull();
    expect(windowsScriptLaunch("bun", [".aidlc/tools/aidlc.ts", ...hookArgs], "win32", { Path: none })).toBeNull();
    // A path with % or ! is started as it is; only a word cmd.exe would read again, or a " no Windows path holds, is not.
    expect(windowsScriptLaunch("aidlc", hookArgs, "win32", { Path: account })).toMatchObject({
      env: { AIDLC_CMD_SCRIPT: resolve(account, "aidlc.cmd") },
    });
    expect(windowsScriptLaunch("aidlc", ["engine", "hook", "a&b"], "win32", { Path: cmdOnly })).toBe("refused");
    // Windows cannot make a folder whose name holds a ", so this one runs elsewhere.
    if (process.platform !== "win32") {
      expect(windowsScriptLaunch("aidlc", hookArgs, "win32", { Path: folder('bin"q', ["aidlc.cmd"]) })).toBe("refused");
    }
  });

  test.skipIf(process.platform !== "win32")("on Windows the plugin's hooks reach the aidlc.cmd launcher the install puts on PATH", async () => {
    const root = freshProject();
    // As under an account folder whose name holds % and !.
    const bin = join(root, "me%USERNAME%!x!", "bin");
    mkdirSync(bin, { recursive: true });
    const capture = join(root, "launched.json");
    const engine = join(bin, "fake-engine.ts");
    writeFileSync(
      engine,
      [
        'import { writeFileSync } from "node:fs";',
        "const input = await Bun.stdin.text();",
        `writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), projectDir: process.env.AIDLC_PROJECT_DIR, cwd: process.cwd(), input }));`,
        'process.stdout.write(JSON.stringify({ additionalContext: "active" }) + "\\n");',
        "",
      ].join("\n"),
      "utf-8",
    );
    // cmd.exe expands % inside a batch file, so the paths are written with it
    // doubled, as the install writes its own launcher (windowsShim).
    const literal = (path: string) => path.replaceAll("%", "%%");
    writeFileSync(join(bin, "aidlc.cmd"), `@echo off\r\n"${literal(process.execPath)}" "${literal(engine)}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf-8");
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const saved = process.env[pathKey];
    process.env[pathKey] = `${bin};${saved ?? ""}`;
    try {
      const { client } = fakeClient();
      const adapter = await createAdapter({
        client,
        directory: root,
        aidlcEntrypoints: TEST_ENTRYPOINTS,
        aidlcCommand: ["aidlc", "engine"],
        platform: "win32",
      });
      await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "first" }] });
    } finally {
      process.env[pathKey] = saved;
    }
    expect(existsSync(capture)).toBe(true);
    const launched = JSON.parse(readFileSync(capture, "utf-8")) as { args: string[]; projectDir: string; cwd: string };
    expect(launched.args.slice(0, 2)).toEqual(["engine", "hook"]);
    expect(launched.args).not.toContain("--project-dir");
    expect(launched.projectDir).toBe(root);
    expect(resolve(launched.cwd).toLowerCase()).toBe(resolve(root).toLowerCase());
  });

  // What cmd.exe and Windows PowerShell hand the program, through the same
  // `shell` spawn opencode uses, for the commands the adapter accepts there.
  test.skipIf(process.platform !== "win32")("cmd.exe and PowerShell hand the tool those commands' arguments, unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "t241-win-"));
    scratch.push(root);
    mkdirSync(join(root, ".aidlc", "tools"), { recursive: true });
    writeFileSync(
      join(root, ".aidlc", "tools", "aidlc.ts"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf-8",
    );
    // A launcher built like the installed aidlc.cmd: cmd.exe reads its
    // arguments again before PowerShell hands them to the engine.
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "aidlc-shim.ps1"),
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8\r\n[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($args)))\r\n",
      "utf-8",
    );
    writeFileSync(
      join(bin, "aidlc.cmd"),
      [
        "@echo off",
        `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${join(bin, "aidlc-shim.ps1")}" %*`,
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
      "utf-8",
    );
    // Windows names the variable Path; a second PATH key would be ignored.
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const env = { ...process.env, [pathKey]: `${bin};${process.env[pathKey] ?? ""}` };
    // PowerShell 7 runs where it is installed (GitHub's Windows runners have it).
    const pwsh7 = Bun.which("pwsh", { PATH: env[pathKey] ?? "" });
    for (const [shell, cases] of [
      ["cmd.exe", CMD_OK],
      ["powershell.exe", PWSH_OK],
      ...(pwsh7 ? [[pwsh7, [...PWSH_OK, ...PWSH7_OK]] as const] : []),
    ] as const) {
      for (const [command, tail] of cases) {
        const run = spawnSync(command, { cwd: root, env, shell, encoding: "utf-8" });
        expect(run.status, `${shell}: ${command}\n${run.stderr}`).toBe(0);
        const argv = JSON.parse(run.stdout) as string[];
        expect(argv.slice(-tail.length), `${shell}: ${command}`).toEqual(tail);
        expect(existsSync(join(root, "x")), `${shell}: ${command}`).toBe(false);
      }
    }
    // With delayed expansion on, a lone ! may drop out, but no variable's value
    // reaches the tool.
    for (const [command] of CMD_OK) {
      const run = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/v:on", "/s", "/c", `"${command}"`], {
        cwd: root,
        env: { ...env, T241_VALUE: "expanded-value" },
        encoding: "utf-8",
        windowsVerbatimArguments: true,
      });
      expect(run.status, `cmd /v:on: ${command}\n${run.stderr}`).toBe(0);
      expect(run.stdout, `cmd /v:on: ${command}`).not.toContain("expanded-value");
    }
  });

  test.skipIf(process.platform === "win32")("/bin/sh hands the tool those quoted requests as one argument, unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "t241-sh-"));
    scratch.push(root);
    mkdirSync(join(root, ".aidlc", "tools"), { recursive: true });
    writeFileSync(
      join(root, ".aidlc", "tools", "aidlc.ts"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      "utf-8",
    );
    for (const command of [START_SINGLE, START_DOUBLE]) {
      const run = Bun.spawnSync({ cmd: ["/bin/sh", "-c", command], cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      expect(JSON.parse(run.stdout.toString())).toEqual(["engine", "orchestrate", "next", "--scope", "feature", SPEC]);
    }
  });

  test("an OpenCode state transition passes the real runtime hook command gate", async () => {
    const root = freshProject();
    copyCore(root, "hooks/aidlc-rebuild-stage-graph.ts");
    copyCore(root, "tools/aidlc-lib.ts");
    copyCore(root, "tools/aidlc-runtime.ts");
    copyCore(root, "tools/aidlc-artifact-vocabulary.ts");
    copyCore(root, "tools/aidlc-runtime-paths.ts");
    mkdirSync(join(root, "aidlc"), { recursive: true });
    writeFileSync(join(root, "aidlc", ".aidlc-hook-debug"), "", "utf-8");

    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    await adapter["tool.execute.after"](
      postTool("bash", {
        command: "aidlc engine state approve",
      }),
    );

    const debug = readFileSync(
      join(
        root,
        "aidlc",
        "spaces",
        "default",
        "intents",
        ".aidlc-engine/hooks-health",
        "hook-debug.log",
      ),
      "utf-8",
    );
    expect(debug).toContain("rebuild-stage-graph\texit: audit empty");
    expect(debug).not.toContain("exit: command not a transition tool");
  });

  test("post-shell creation forwards the invoking session and result", async () => {
    const root = freshProject();
    const trace = join(root, "runtime-input.json");
    writeHook(
      root,
      "aidlc-rebuild-stage-graph.ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(trace)}, await Bun.stdin.text(), "utf-8");
`,
    );
    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    await adapter["tool.execute.after"](
      postTool("bash", {
        command: "bun .aidlc/tools/aidlc.ts engine intent create --scope poc",
      }),
      {
        output: "Intent created: fixture-record (space: default)\n",
      },
    );

    const payload = JSON.parse(readFileSync(trace, "utf-8")) as {
      session_id?: string;
      tool_input?: { command?: string };
      tool_response?: string;
    };
    expect(payload.session_id).toBe("main");
    expect(payload.tool_input?.command).toContain("engine intent create");
    expect(payload.tool_response).toContain("Intent created: fixture-record");
  });

  test("a hook that ends before it reads its input leaves no broken-pipe error in opencode's process", async () => {
    const root = freshProject();
    writeHook(root, "aidlc-rebuild-stage-graph.ts", "process.exit(0);\n");
    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    // bun test fails the case on an error nothing caught, as opencode run
    // prints it and exits 1.
    let answered = 0;
    for (let call = 0; call < 3; call++) {
      const done = adapter["tool.execute.after"](
        postTool("bash", { command: "bun .aidlc/tools/aidlc.ts engine intent create --scope poc" }),
        { output: "Intent created: fixture-record (space: default)\n" },
      );
      // A busy host: the hook has exited before its input reaches the pipe.
      process.nextTick(() => Bun.sleepSync(200));
      await done;
      answered++;
    }
    await new Promise((settle) => setTimeout(settle, 50));
    expect(answered).toBe(3);
  });
});

describe("t241 OpenCode adapter reviewer scope", () => {
  test("blocks a sibling-unit read and allows the dispatched unit", async () => {
    const root = freshProject();
    copyCore(root, "hooks/aidlc-reviewer-scope.ts");
    // The hook reads a shell command's write targets through the shared parser
    // shipped beside it in every tree.
    copyCore(root, "hooks/review-freeze-command.ts");
    copyCore(root, "tools/aidlc-audit.ts");
    copyCore(root, "tools/aidlc-lib.ts");
    copyCore(root, "tools/aidlc-artifact-vocabulary.ts");
    copyCore(root, "tools/aidlc-runtime-paths.ts");

    const recordRoot = join(root, "aidlc", "spaces", "default", "intents");
    const current = join(recordRoot, "construction", "U01", "design.md");
    const sibling = join(recordRoot, "construction", "U02", "design.md");
    mkdirSync(dirname(current), { recursive: true });
    mkdirSync(dirname(sibling), { recursive: true });
    writeFileSync(current, "# current\n", "utf-8");
    writeFileSync(sibling, "# sibling\n", "utf-8");
    mkdirSync(dirname(join(recordRoot, ".aidlc-engine/reviewer-dispatch.json")), { recursive: true });
    writeFileSync(
      join(recordRoot, ".aidlc-engine/reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "U01",
        exempt: [],
      }),
      "utf-8",
    );

    const { client } = fakeClient({ reviewer: "main" });
    const adapter = await createTestAdapter(client, root);
    await adapter["chat.message"](
      {
        sessionID: "reviewer",
        agent: "aidlc-architecture-reviewer-agent",
      },
      { parts: [{ type: "text", text: "review" }] },
    );

    const before = adapter["tool.execute.before"];
    await expect(
      before(
        { tool: "read", sessionID: "reviewer", callID: "sibling" },
        { args: { filePath: sibling } },
      ),
    ).rejects.toThrow(/This review cannot open/i);
    await expect(
      before(
        { tool: "read", sessionID: "reviewer", callID: "current" },
        { args: { filePath: current } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      before(
        { tool: "list", sessionID: "reviewer", callID: "sibling-list" },
        { args: { path: dirname(sibling) } },
      ),
    ).rejects.toThrow(/This review cannot open/i);
  });
});

describe("t241 OpenCode adapter state-transition guard", () => {
  test("leaves a direct lifecycle verb to the state tool and allows read-only state queries", async () => {
    const root = freshProject();
    copyCore(root, "hooks/aidlc-state-transition-guard.ts");
    copyCore(root, "hooks/review-freeze-command.ts");
    copyCore(root, "hooks/runtime-integrity.ts");
    copyCore(root, "tools/aidlc-lib.ts");
    copyCore(root, "tools/aidlc-command.ts");
    copyCore(root, "tools/aidlc-color.ts");
    copyCore(root, "tools/aidlc-artifact-vocabulary.ts");
    copyCore(root, "tools/aidlc-runtime-paths.ts");

    const { client } = fakeClient();
    const adapter = await createAdapter({
      client,
      directory: root,
      aidlcEntrypoints: TEST_ENTRYPOINTS,
      aidlcCommand: TEST_AIDLC_COMMAND,
    });
    const before = adapter["tool.execute.before"];
    const invoke = (callID: string, command: string) =>
      before(
        { tool: "bash", sessionID: "main", callID },
        { args: { command } },
      );
    // The state tool refuses it when it runs, whatever the spelling.
    await expect(
      invoke("direct", "bun .aidlc/tools/aidlc-state.ts approve user-stories"),
    ).resolves.toBeUndefined();
    await expect(
      invoke("readonly", "bun .aidlc/tools/aidlc-state.ts show"),
    ).resolves.toBeUndefined();
    await expect(
      invoke("engine", "bun .aidlc/tools/aidlc-orchestrate.ts next"),
    ).resolves.toBeUndefined();
  });

  test("blocks lifecycle routing from a named AIDLC worker while preserving the main conductor", async () => {
    const root = freshProject();
    copyCore(root, "hooks/aidlc-state-transition-guard.ts");
    copyCore(root, "hooks/review-freeze-command.ts");
    copyCore(root, "hooks/runtime-integrity.ts");
    copyCore(root, "tools/aidlc-lib.ts");
    copyCore(root, "tools/aidlc-command.ts");
    copyCore(root, "tools/aidlc-color.ts");
    copyCore(root, "tools/aidlc-artifact-vocabulary.ts");
    copyCore(root, "tools/aidlc-runtime-paths.ts");

    const { client } = fakeClient({ worker: "main" });
    const adapter = await createAdapter({
      client,
      directory: root,
      aidlcEntrypoints: new Set([
        ...TEST_ENTRYPOINTS,
        "tools/aidlc-orchestrate.ts",
      ]),
      aidlcCommand: TEST_AIDLC_COMMAND,
    });
    await adapter["chat.message"](
      { sessionID: "worker", agent: "aidlc-design-agent" },
      { parts: [{ type: "text", text: "contribute" }] },
    );
    const before = adapter["tool.execute.before"];
    const command = "bun .aidlc/tools/aidlc-orchestrate.ts next --resume";

    await expect(
      before(
        { tool: "bash", sessionID: "worker", callID: "worker-route" },
        { args: { command } },
      ),
    ).rejects.toThrow(/only the main workflow session can change stage status or routing/i);
    await expect(
      before(
        { tool: "bash", sessionID: "main", callID: "main-route" },
        { args: { command } },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("t241 OpenCode adapter dispatch rules", () => {
  test("task input is rewritten with exact active-stage rules", async () => {
    const root = freshInstalledProject();
    seedAidlcMemory(root);
    seedStateFile(root, "state-mid-inception.md");
    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    const output = {
      args: {
        subagent_type: "aidlc-product-agent",
        prompt:
          "Run .aidlc/aidlc-common/stages/inception/user-stories.md.",
        run_in_background: true,
      },
    };

    await adapter["tool.execute.before"](
      { tool: "task", sessionID: "main", callID: "rules" },
      output,
    );

    const prompt = String(output.args.prompt ?? "");
    expect(prompt).toContain("first-class");
    expect(prompt).toContain("Given/When/Then");
    expect(prompt).toContain("AIDLC_DISPATCH_RULES_BEGIN");
    expect(inspectSubagentInflight(root).freshCount).toBe(1);

    await adapter["tool.execute.after"]({
      tool: "task",
      sessionID: "main",
      callID: "rules",
      args: output.args,
    });
    expect(existsSync(subagentInflightMarkerPath(root))).toBe(false);
  });
});

describe("t241 OpenCode native plan-approval payloads", () => {
  test("write, bash, and developer task paths block before a human-owned receipt", async () => {
    const root = freshInstalledProject();
    seedAidlcMemory(root);
    seedUnapprovedCodeGeneration(root);
    const { client } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    const before = adapter["tool.execute.before"];

    await expect(
      before(
        { tool: "write", sessionID: "main", callID: "write" },
        { args: { filePath: join(root, "src", "blocked.ts") } },
      ),
    ).rejects.toThrow(/plan|approval/i);
    await expect(
      before(
        { tool: "bash", sessionID: "main", callID: "bash" },
        { args: { command: "sort input.txt -o src/blocked.txt" } },
      ),
    ).rejects.toThrow(/plan|approval/i);
    await expect(
      before(
        { tool: "task", sessionID: "main", callID: "task" },
        {
          args: {
            subagent_type: "aidlc-developer-agent",
            prompt:
              "AIDLC-STAGE: code-generation\n" +
              `AIDLC-TESTING-CONTRACT: sha256:${"a".repeat(64)}`,
          },
        },
      ),
    ).rejects.toThrow(/plan|approval/i);
  });
});

// The Stop hook's nudge is for a run nobody attends (and autonomous
// Construction); an attended, gated run ends its turn ("an attended run ...
// sends no nudge" below). The plugin runs the hook with its own environment,
// so these idles are read where nobody attends.
async function idleWhereNobodyAttends(
  adapter: Awaited<ReturnType<typeof createAdapter>>,
  idle: Parameters<Awaited<ReturnType<typeof createAdapter>>["event"]>[0],
): Promise<void> {
  const before = process.env.AIDLC_UNATTENDED;
  process.env.AIDLC_UNATTENDED = "1";
  try {
    await adapter.event(idle);
  } finally {
    if (before === undefined) delete process.env.AIDLC_UNATTENDED;
    else process.env.AIDLC_UNATTENDED = before;
  }
}

describe("t241 OpenCode adapter write and session lifecycle", () => {
  test("apply_patch emits audit then sensor calls for every affected path", async () => {
    const root = freshProject();
    const trace = join(root, "hook-calls.ndjson");
    for (const [file, label] of [
      ["aidlc-write-audit-log.ts", "audit"],
      ["aidlc-run-sensors.ts", "sensor"],
    ] as const) {
      writeHook(
        root,
        file,
        `import { appendFileSync } from "node:fs";
const input = await Bun.stdin.text();
appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(`${label}\t`)} + input + "\\n", "utf-8");
`,
      );
    }
    const patchText = `*** Begin Patch
*** Add File: src/one.ts
+export const one = 1;
*** Update File: src/two.ts
@@
-old
+next
*** End Patch
`;
    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    await adapter["tool.execute.after"](
      postTool("apply_patch", { patchText }),
    );

    const calls = readFileSync(trace, "utf-8")
      .trim()
      .split("\n")
      .map((line) => {
        const [label, payload] = line.split("\t", 2);
        return {
          label,
          path: (
            JSON.parse(payload) as { tool_input: { file_path: string } }
          ).tool_input.file_path,
        };
      });
    expect(calls).toEqual([
      { label: "audit", path: join(root, "src/one.ts") },
      { label: "sensor", path: join(root, "src/one.ts") },
      { label: "audit", path: join(root, "src/two.ts") },
      { label: "sensor", path: join(root, "src/two.ts") },
    ]);
  });

  test("relative apply_patch paths pass the real audit hook's absolute record gate", async () => {
    const root = freshInstalledProject();
    seedStateFile(root, "state-init-active.md");
    mkdirSync(dirname(seededAuditShard(root)), { recursive: true });
    writeFileSync(seededAuditShard(root), "# AI-DLC Audit Log\n", "utf-8");
    const artifact = join(
      seededRecordDir(root),
      "initialization",
      "state-init",
      "state-notes.md",
    );
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, "# state\n", "utf-8");
    const patchText = `*** Begin Patch
*** Add File: ${relative(root, artifact)}
+# state
*** End Patch
`;

    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    await adapter["tool.execute.after"](
      postTool("apply_patch", { patchText }),
    );

    expect(readAudit(root)).toContain("ARTIFACT_CREATED");
    expect(readAudit(root)).toContain("initialization > state-init > state-notes.md");
  });

  test("session-start retries until an active workflow is available, then stops retrying", async () => {
    const root = freshProject();
    const marker = join(root, "workflow-active");
    const count = join(root, "session-start-count");
    writeHook(
      root,
      "aidlc-session-start.ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const countFile = ${JSON.stringify(count)};
const n = existsSync(countFile) ? Number(readFileSync(countFile, "utf-8")) : 0;
writeFileSync(countFile, String(n + 1), "utf-8");
await Bun.stdin.text();
if (existsSync(${JSON.stringify(marker)})) {
  process.stdout.write(JSON.stringify({ additionalContext: "active" }) + "\\n");
}
`,
    );
    writeHook(root, "aidlc-record-human-turn.ts", "await Bun.stdin.text();\n");

    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    const chat = adapter["chat.message"];
    await chat(
      { sessionID: "main" },
      { parts: [{ type: "text", text: "first" }] },
    );
    expect(readFileSync(count, "utf-8")).toBe("1");

    writeFileSync(marker, "", "utf-8");
    await chat(
      { sessionID: "main" },
      { parts: [{ type: "text", text: "second" }] },
    );
    await chat(
      { sessionID: "main" },
      { parts: [{ type: "text", text: "third" }] },
    );
    expect(readFileSync(count, "utf-8")).toBe("2");
  });

  test("concurrent idle events inject one nudge for a session", async () => {
    const root = freshProject();
    const stopCount = join(root, "stop-count");
    writeHook(
      root,
      "aidlc-session-start.ts",
      `await Bun.stdin.text();
process.stdout.write(JSON.stringify({ additionalContext: "active" }) + "\\n");
`,
    );
    writeHook(root, "aidlc-record-human-turn.ts", "await Bun.stdin.text();\n");
    writeHook(
      root,
      "aidlc-continue-workflow.ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const countFile = ${JSON.stringify(stopCount)};
const n = existsSync(countFile) ? Number(readFileSync(countFile, "utf-8")) : 0;
writeFileSync(countFile, String(n + 1), "utf-8");
await Bun.stdin.text();
await Bun.sleep(100);
process.stdout.write(JSON.stringify({ decision: "block", reason: "continue" }) + "\\n");
`,
    );

    const { client, prompts } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ type: "text", text: "start" }] },
    );
    const idle = {
      event: {
        type: "session.idle",
        properties: { sessionID: "main" },
      },
    };
    await Promise.all([adapter.event(idle), adapter.event(idle)]);

    expect(readFileSync(stopCount, "utf-8")).toBe("1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain("continue");
  });

  test("session idle forwards the session id to the Stop hook", async () => {
    const root = freshProject();
    const stopInput = join(root, "stop-input.json");
    writeHook(
      root,
      "aidlc-session-start.ts",
      `await Bun.stdin.text();
process.stdout.write(JSON.stringify({ additionalContext: "active" }) + "\\n");
`,
    );
    writeHook(root, "aidlc-record-human-turn.ts", "await Bun.stdin.text();\n");
    writeHook(
      root,
      "aidlc-continue-workflow.ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(stopInput)}, await Bun.stdin.text(), "utf-8");
`,
    );

    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ type: "text", text: "start" }] },
    );
    await adapter.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "main" },
      },
    });

    const payload = JSON.parse(readFileSync(stopInput, "utf-8")) as {
      session_id?: string;
    };
    expect(payload.session_id).toBe("main");
  });

  test("turn-one idle reaches the real Stop hook when workflow state is created during the turn", async () => {
    const root = freshInstalledProject();
    const { client, prompts } = fakeClient();
    const adapter = await createTestAdapter(client, root);

    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ type: "text", text: "start a workflow" }] },
    );
    seedStateFile(root, "state-init-active.md");
    // The direct fixture write stands in for intent-create, so mirror the
    // production writer that replaces the cold intent:null binding.
    writeSessionBinding(
      root,
      "main",
      "default",
      basename(seededRecordDir(root)),
      "switch",
    );
    await idleWhereNobodyAttends(adapter, {
      event: {
        type: "session.idle",
        properties: { sessionID: "main" },
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0].synthetic).toBe(true);
  });

  // A live run: new work made from one chat, then a new chat on it. A plain
  // question there was followed by a hidden nudge that started the new work's
  // first stage. The question ends the turn; an advance still leads to the nudge.
  test("in a new chat on work made from another chat, a plain question gets no nudge, and an advance still does", async () => {
    const root = freshInstalledProject();
    const engine = (session: string, ...args: string[]) => {
      const run = Bun.spawnSync({
        // This engine's own option rides ahead of the person's words, which is
        // where every caller of it puts it: among their words it is a word of
        // their request.
        cmd: [
          process.execPath, join(root, ".aidlc", "tools", "aidlc.ts"),
          "--project-dir", root, "engine", ...args,
        ],
        cwd: root,
        env: { ...process.env, AIDLC_SESSION_OVERRIDE: session, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      return run.stdout.toString();
    };
    const offer = JSON.parse(engine("other-chat", "orchestrate", "next", "--scope", "poc", "build a lunch poll")) as { message?: string };
    const request = /--request ([0-9a-f]{8})/.exec(String(offer.message))?.[1];
    expect(request, String(offer.message)).toBeDefined();
    engine("other-chat", "intent", "create", "--scope", "poc", "--request", request ?? "", "--label", "lunch-poll");

    const { client, prompts } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    const idle = { event: { type: "session.idle", properties: { sessionID: "main" } } };
    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "what does the lunch poll do?" }] });
    await idleWhereNobodyAttends(adapter, idle);
    expect(prompts).toHaveLength(0);

    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "carry on" }] });
    await Bun.sleep(20);
    expect(JSON.parse(engine("main", "orchestrate", "next")).kind).not.toBe("print");
    await idleWhereNobodyAttends(adapter, idle);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].synthetic).toBe(true);
  });

  test("two chats in one opencode process: each chat's shell command acts on its own work", async () => {
    const root = freshInstalledProject();
    const { client } = fakeClient({ ses_a_helper: "ses_a" });
    const adapter = await createAdapter({ client, directory: root });
    // opencode asks the plugin for each shell command's environment.
    const shellEnv = async (sessionID?: string) => {
      const output = { env: {} as Record<string, string> };
      await adapter["shell.env"]({ cwd: root, sessionID, callID: "call" }, output);
      return output.env;
    };
    const engine = async (chat: string, ...args: string[]) => {
      const run = Bun.spawnSync({
        cmd: [process.execPath, join(root, ".aidlc", "tools", "aidlc.ts"), "--project-dir", root, "engine", ...args],
        cwd: root,
        env: { ...process.env, ...(await shellEnv(chat)) },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      return run.stdout.toString();
    };
    const startWork = async (chat: string, request: string, label: string) => {
      // The second piece of work is asked whether it is new; both answers carry the request.
      const offer = await engine(chat, "orchestrate", "next", "--scope", "poc", request);
      const id = /--request ([0-9a-f]{8})/.exec(offer)?.[1];
      expect(id, offer).toBeDefined();
      await engine(chat, "intent", "create", "--scope", "poc", "--request", id ?? "", "--label", label);
    };
    const on = (chat: string) => {
      const binding = readSessionBinding(root, chat);
      return `${(binding?.intent ?? "none").replace(/^.*-(farewell|version)$/, "$1")} ${binding?.source}`;
    };
    // B's session-start runs last, so the process names chat B.
    await adapter["chat.message"]({ sessionID: "ses_a" }, { parts: [{ type: "text", text: "add a farewell command" }] });
    await adapter["chat.message"]({ sessionID: "ses_b" }, { parts: [{ type: "text", text: "add a version flag" }] });
    await startWork("ses_a", "add a farewell command", "farewell");
    expect([on("ses_a"), on("ses_b")]).toEqual(["farewell create", "none none"]);
    await startWork("ses_b", "add a version flag", "version");
    expect([on("ses_a"), on("ses_b")]).toEqual(["farewell create", "version create"]);
    await engine("ses_a", "intent", readSessionBinding(root, "ses_a")?.intent ?? "");
    expect([on("ses_a"), on("ses_b")]).toEqual(["farewell switch", "version create"]);
    // A helper's commands are its owner's; opencode's own terminal names no chat.
    expect(await shellEnv("ses_a_helper")).toEqual({ AIDLC_SESSION_OVERRIDE: "ses_a", AIDLC_SESSION_OVERRIDE_SOURCE: "payload" });
    expect(await shellEnv(undefined)).toEqual({});
  });

  test("two chats in one opencode process: a file write and a to-do update are recorded on their own chat's work", async () => {
    const root = freshInstalledProject();
    const { client } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    const engine = async (chat: string, ...args: string[]) => {
      const output = { env: {} as Record<string, string> };
      await adapter["shell.env"]({ cwd: root, sessionID: chat, callID: "call" }, output);
      const run = Bun.spawnSync({
        cmd: [process.execPath, join(root, ".aidlc", "tools", "aidlc.ts"), "--project-dir", root, "engine", ...args],
        cwd: root,
        env: { ...process.env, ...output.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      return run.stdout.toString();
    };
    const startWork = async (chat: string, scope: string, request: string, label: string) => {
      const offer = await engine(chat, "orchestrate", "next", "--scope", scope, request);
      const id = /--request ([0-9a-f]{8})/.exec(offer)?.[1];
      expect(id, offer).toBeDefined();
      await engine(chat, "intent", "create", "--scope", scope, "--request", id ?? "", "--label", label);
    };
    const stageStep = async (chat: string) => {
      let step = JSON.parse(await engine(chat, "orchestrate", "next")) as { kind?: string; receipt?: string; stage?: string; produces?: string[] };
      while (step.kind === "load-steering") step = JSON.parse(await engine(chat, "orchestrate", "continue", step.receipt ?? ""));
      expect(step.kind).toBe("run-stage");
      return step;
    };
    // B's session-start runs last, so the process names chat B.
    await adapter["chat.message"]({ sessionID: "ses_a" }, { parts: [{ type: "text", text: "add a farewell command" }] });
    await adapter["chat.message"]({ sessionID: "ses_b" }, { parts: [{ type: "text", text: "add a version flag" }] });
    await startWork("ses_a", "poc", "add a farewell command", "farewell");
    await startWork("ses_b", "bugfix", "add a version flag", "version");
    const a = await stageStep("ses_a");
    const b = await stageStep("ses_b");
    expect(a.stage).not.toBe(b.stage);
    const record = (chat: string) => join(root, "aidlc", "spaces", "default", "intents", readSessionBinding(root, chat)?.intent ?? "");
    const currentStage = (chat: string) =>
      /^- \*\*Current Stage\*\*: (.*)$/m.exec(readFileSync(join(record(chat), "aidlc-state.md"), "utf-8"))?.[1];
    const artifactRows = (chat: string, file: string) => {
      const audit = join(record(chat), "audit");
      return readdirSync(audit).filter((name) => name.endsWith(".md"))
        .map((name) => readFileSync(join(audit, name), "utf-8"))
        .join("\n").split("\n## ").filter((row) => /^\*\*Event\*\*: ARTIFACT_(CREATED|UPDATED)$/m.test(row) && row.includes(file)).length;
    };
    // Chat A's agent writes its stage's first file and marks its stage in progress.
    const file = a.produces?.[0] ?? "";
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "# Intent\n\nA farewell command.\n");
    await adapter["tool.execute.after"]({ tool: "write", sessionID: "ses_a", callID: "w", args: { filePath: file } });
    await adapter["tool.execute.after"]({
      tool: "todowrite",
      sessionID: "ses_a",
      callID: "td",
      args: { todos: [{ content: `Running ${a.stage} [${a.stage}]`, status: "in_progress" }] },
    });
    expect({
      artifactRows: [artifactRows("ses_a", file), artifactRows("ses_b", file)],
      currentStages: [currentStage("ses_a"), currentStage("ses_b")],
    }).toEqual({ artifactRows: [1, 0], currentStages: [a.stage, b.stage] });
  });

  test("idle suppresses its nudge for an open logged question and restores it after the answer", async () => {
    const root = freshInstalledProject();
    seedStateFile(root, "state-brownfield-feature.md");
    appendInteractionEvent(root, "STAGE_STARTED", "requirements-analysis");
    appendInteractionEvent(root, "DECISION_RECORDED", "requirements-analysis");
    const { client, prompts } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });

    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ type: "text", text: "start" }] },
    );
    const idle = {
      event: {
        type: "session.idle",
        properties: { sessionID: "main" },
      },
    };
    await idleWhereNobodyAttends(adapter, idle);
    expect(prompts).toHaveLength(0);

    appendInteractionEvent(root, "QUESTION_ANSWERED", "requirements-analysis");
    await idleWhereNobodyAttends(adapter, idle);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].synthetic).toBe(true);
  });

  // A live run: in a new chat on open work, a read-only /aidlc --status was
  // followed by a hidden nudge that started the open stage. The status ends
  // the turn; a step that hands out work still leads to the nudge.
  test("idle sends no nudge after a read-only status, and still nudges after the agent is handed work", async () => {
    const root = freshInstalledProject();
    seedStateFile(root, "state-brownfield-feature.md");
    const { client, prompts } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    const engine = (...args: string[]) => {
      const run = Bun.spawnSync({
        cmd: [process.execPath, join(root, ".aidlc", "tools", "aidlc.ts"), "engine", "orchestrate", ...args, "--project-dir", root],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      return JSON.parse(run.stdout.toString()) as { kind: string };
    };
    const idle = { event: { type: "session.idle", properties: { sessionID: "main" } } };

    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "/aidlc --status" }] });
    expect(engine("next", "--status").kind).toBe("print");
    await idleWhereNobodyAttends(adapter, idle);
    expect(prompts).toHaveLength(0);

    expect(engine("next").kind).not.toBe("print");
    await idleWhereNobodyAttends(adapter, idle);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].synthetic).toBe(true);
  });

  // In an attended, gated run the agent handed work that ends its turn (a
  // question asked in prose, a mid-stage stop) gets no hidden nudge: the person
  // is there, and their next message carries the work on.
  test("an attended run sends no nudge after the agent is handed work", async () => {
    const root = freshInstalledProject();
    seedStateFile(root, "state-brownfield-feature.md");
    const { client, prompts } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "Guide me through the questions" }] });
    const run = Bun.spawnSync({
      cmd: [process.execPath, join(root, ".aidlc", "tools", "aidlc.ts"), "engine", "orchestrate", "next", "--project-dir", root],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect((JSON.parse(run.stdout.toString()) as { kind: string }).kind).not.toBe("print");
    await adapter.event({ event: { type: "session.idle", properties: { sessionID: "main" } } });
    expect(prompts).toHaveLength(0);
  });

  test("a typed summary-confirmation off in chat reaches the real record-human-turn hook, and the setter records it as the person's choice", async () => {
    const root = freshInstalledProject();
    seedStateFile(root, "state-brownfield-feature.md");
    writeSessionBinding(root, "main", "default", basename(seededRecordDir(root)));
    const statePath = join(seededRecordDir(root), "aidlc-state.md");
    const ceremonyRows = () =>
      readAuditShardEvents(root).filter((entry) => entry.event === "CEREMONY_SET");
    const { client } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });

    // chat.message forwards what the person typed as the UserPromptSubmit prompt.
    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ type: "text", text: "/aidlc config set summary-confirmation off" }] },
    );

    // The hook records their line and applies nothing; the agent runs the setter
    // the engine names, and the setting is recorded as theirs.
    const setterRun = () => Bun.spawnSync({
      cmd: [
        process.execPath,
        join(root, ".aidlc", "tools", "aidlc.ts"),
        "engine", "config", "set", "summary-confirmation", "off",
        "--project-dir", root,
      ],
      cwd: root,
      env: {
        ...process.env,
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
        AIDLC_SESSION_OVERRIDE: undefined,
        AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const applied = setterRun();
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);
    const state = readFileSync(statePath, "utf-8");
    expect(state).toContain("- **Summary Confirmation**: off (set by you)");
    const audit = ceremonyRows();
    expect(audit).toHaveLength(1);
    expect(auditBlockField(audit[0].block, "New")).toBe("off");
    expect(auditBlockField(audit[0].block, "Source")).toBe("you");

    // A later agent-run command repeat neither writes nor relabels the choice.
    const repeated = setterRun();
    expect(repeated.exitCode, repeated.stderr.toString()).toBe(0);
    expect(repeated.stdout.toString()).toContain("Summary Confirmation is already off (set by you)");
    expect(readFileSync(statePath, "utf-8")).toBe(state);
    expect(ceremonyRows()).toEqual(audit);
  });

  test("a transient child lookup failure is not cached as a main session", async () => {
    const root = freshProject();
    const minted = join(root, "minted");
    writeHook(root, "aidlc-session-start.ts", "await Bun.stdin.text();\n");
    writeHook(
      root,
      "aidlc-record-human-turn.ts",
      `import { appendFileSync } from "node:fs";
await Bun.stdin.text();
appendFileSync(${JSON.stringify(minted)}, "mint\\n");
`,
    );
    let lookups = 0;
    const client: PluginInput["client"] = {
      session: {
        get: async () => {
          lookups += 1;
          if (lookups === 1) throw new Error("transient");
          return { data: { parentID: "main" } };
        },
        prompt: async () => {},
      },
    };
    const adapter = await createTestAdapter(client, root);

    for (const text of ["first", "second"]) {
      await adapter["chat.message"](
        { sessionID: "child" },
        { parts: [{ type: "text", text }] },
      );
    }

    expect(lookups).toBe(2);
    expect(() => readFileSync(minted, "utf-8")).toThrow();
  });

  test("idle serialization is released before a nudge prompt delivers the next idle", async () => {
    const root = freshProject();
    const stopCount = join(root, "stop-count");
    writeHook(
      root,
      "aidlc-session-start.ts",
      `await Bun.stdin.text();
process.stdout.write(JSON.stringify({ additionalContext: "active" }) + "\\n");
`,
    );
    writeHook(root, "aidlc-record-human-turn.ts", "await Bun.stdin.text();\n");
    writeHook(
      root,
      "aidlc-continue-workflow.ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const countFile = ${JSON.stringify(stopCount)};
const n = existsSync(countFile) ? Number(readFileSync(countFile, "utf-8")) : 0;
writeFileSync(countFile, String(n + 1), "utf-8");
await Bun.stdin.text();
if (n === 0) process.stdout.write(JSON.stringify({ decision: "block", reason: "continue" }) + "\\n");
`,
    );
    let adapter: Awaited<ReturnType<typeof createAdapter>>;
    const client: PluginInput["client"] = {
      session: {
        get: async () => ({ data: {} }),
        prompt: async ({ path }) => {
          await adapter.event({
            event: {
              type: "session.idle",
              properties: { sessionID: path.id },
            },
          });
        },
      },
    };
    adapter = await createTestAdapter(client, root);
    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ type: "text", text: "start" }] },
    );
    await adapter.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "main" },
      },
    });

    expect(readFileSync(stopCount, "utf-8")).toBe("2");
  });
});

describe("t241 OpenCode adapter: what the person sees", () => {
  function nudgingProject(): { root: string; stopCount: string } {
    const root = freshProject();
    const stopCount = join(root, "stop-count");
    writeHook(
      root,
      "aidlc-session-start.ts",
      `await Bun.stdin.text();
process.stdout.write(JSON.stringify({ additionalContext: "active" }) + "\\n");
`,
    );
    writeHook(root, "aidlc-record-human-turn.ts", "await Bun.stdin.text();\n");
    writeHook(
      root,
      "aidlc-continue-workflow.ts",
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const countFile = ${JSON.stringify(stopCount)};
const n = existsSync(countFile) ? Number(readFileSync(countFile, "utf-8")) : 0;
writeFileSync(countFile, String(n + 1), "utf-8");
await Bun.stdin.text();
process.stdout.write(JSON.stringify({ decision: "block", reason: "continue" }) + "\\n");
`,
    );
    return { root, stopCount };
  }
  const idle = { event: { type: "session.idle", properties: { sessionID: "main" } } };

  test("the end-of-turn nudge is a synthetic part, so the person's chat does not show it", async () => {
    const { root } = nudgingProject();
    const { client, prompts } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "start" }] });
    await adapter.event(idle);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toBe("continue");
    expect(prompts[0].synthetic).toBe(true);
  });

  test("the nudge is known by the part this plugin sent, not by its words: it is never the person's turn, and a message of theirs in any words is", async () => {
    const { root } = nudgingProject();
    const turns = join(root, "turns.jsonl");
    writeHook(
      root,
      "aidlc-record-human-turn.ts",
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(turns)}, (await Bun.stdin.text()) + "\\n");\n`,
    );
    const recorded = () =>
      existsSync(turns)
        ? readFileSync(turns, "utf-8").trim().split("\n").map((line) => (JSON.parse(line) as { prompt: string }).prompt)
        : [];
    const { client, prompts, echo } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    echo.to = (sessionID, parts) => adapter["chat.message"]({ sessionID }, { parts });
    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ id: "prt_p1", type: "text", text: "start" }] });
    await adapter.event(idle);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].partId).toStartWith("prt_");
    expect(recorded()).toEqual(["start"]);
    const said = "[aidlc-forwarding-nudge] is that line from AI-DLC?";
    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ id: "prt_p2", type: "text", text: said }] });
    expect(recorded()).toEqual(["start", said]);
  });

  // What the human-turn hook is handed for each message, in order.
  function recordingProject(): { root: string; recorded: () => string[] } {
    const { root } = nudgingProject();
    const turns = join(root, "turns.jsonl");
    writeHook(
      root,
      "aidlc-record-human-turn.ts",
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(turns)}, (await Bun.stdin.text()) + "\\n");\n`,
    );
    const recorded = () =>
      existsSync(turns)
        ? readFileSync(turns, "utf-8").trim().split("\n").map((line) => (JSON.parse(line) as { prompt: string }).prompt)
        : [];
    return { root, recorded };
  }

  // Live on opencode 1.19.4 run with an editor connected (Zed's terminal, or
  // VS Code's with the editor extension): a message sent after the open file
  // changed came as opencode's own note, marked synthetic, then the typed
  // words. The record kept the note as the person's words and lost theirs.
  test("a message opencode starts with its note about the editor's open file records only what the person typed", async () => {
    const { root, recorded } = recordingProject();
    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    const note = "<system-reminder>Note: The user opened the file \"/work/src/app.ts\". This may or may not be relevant " +
      "to the current task.</system-reminder>\n";
    const editor = { type: "text", text: note, synthetic: true, metadata: { kind: "editor_context", source: "websocket" } };
    const typed: Array<Record<string, unknown>> = [editor, { type: "text", text: "approve" }];
    await adapter["chat.message"]({ sessionID: "main" }, { parts: typed });
    // An editor file and nothing typed: nothing of theirs, and never the note.
    const empty: Array<Record<string, unknown>> = [editor, { type: "text", text: "" }];
    await adapter["chat.message"]({ sessionID: "main" }, { parts: empty });
    expect(recorded()).toEqual(["approve", ""]);
  });

  test("every text part the person sent is recorded, in order", async () => {
    const { root, recorded } = recordingProject();
    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    const parts: Array<Record<string, unknown>> = [
      { type: "text", text: "approve" },
      { type: "file", mime: "text/plain", url: "file:///work/notes.md" },
      { type: "text", text: "Called the Read tool with the following input: {\"filePath\":\"/work/notes.md\"}", synthetic: true },
      { type: "text", text: "and rename the handler" },
    ];
    await adapter["chat.message"]({ sessionID: "main" }, { parts });
    expect(recorded()).toEqual(["approve\nand rename the handler"]);
  });

  // opencode shows an ignored part and never sends it to the agent: not what
  // the person typed (an MCP prompt's text for the user, for one).
  test("a part opencode marks ignored is left out", async () => {
    const { root, recorded } = recordingProject();
    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    await adapter["chat.message"]({ sessionID: "main" }, {
      parts: [{ type: "text", text: "shown to the person only", ignored: true }, { type: "text", text: "go on" }],
    });
    expect(recorded()).toEqual(["go on"]);
  });

  test("a message with no typed text part forwards its first text part, as before", async () => {
    const { root, recorded } = recordingProject();
    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    await adapter["chat.message"]({ sessionID: "main" }, {
      parts: [{ type: "text", text: "The following tool was executed by the user", synthetic: true }],
    });
    expect(recorded()).toEqual(["The following tool was executed by the user"]);
  });

  test("after the person stops a turn with Esc, no nudge follows until they write again", async () => {
    const { root, stopCount } = nudgingProject();
    const { client, prompts } = fakeClient();
    const adapter = await createTestAdapter(client, root);
    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "start" }] });
    await adapter.event({
      event: {
        type: "session.error",
        properties: { sessionID: "main", error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
      },
    });
    await adapter.event(idle);
    await adapter.event(idle);
    expect(existsSync(stopCount)).toBe(false);
    expect(prompts).toHaveLength(0);

    // Another error is not the person stopping.
    await adapter.event({
      event: { type: "session.error", properties: { sessionID: "other", error: { name: "APIError" } } },
    });
    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "go on" }] });
    await adapter.event(idle);
    expect(readFileSync(stopCount, "utf-8")).toBe("1");
    expect(prompts).toHaveLength(1);
  });

  // A live run: after a read-only /aidlc --status a nudge started the open
  // stage, the person pressed Reject on its first command, and a second nudge
  // made the agent carry on and write files. A Reject ends the turn.
  const replied = (sessionID: string, answer: Record<string, string>) => ({
    event: { type: "permission.replied", properties: { sessionID, requestID: "per_1", ...answer } },
  });

  test("after the person rejects a command, no nudge follows until they write again", async () => {
    const { root, stopCount } = nudgingProject();
    const { client, prompts } = fakeClient({ worker: "main" });
    const adapter = await createTestAdapter(client, root);
    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "start" }] });
    await adapter.event(replied("main", { reply: "once" }));
    await adapter.event(idle);
    expect(prompts).toHaveLength(1);

    for (const [sessionID, answer] of [
      ["main", { reply: "reject" }],
      ["main", { response: "reject" }],
      ["worker", { reply: "reject" }],
    ] as const) {
      await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "go on" }] });
      await adapter.event(replied(sessionID, answer));
      await adapter.event(idle);
      await adapter.event(idle);
      expect(prompts, `${sessionID} ${JSON.stringify(answer)}`).toHaveLength(1);
    }
    expect(readFileSync(stopCount, "utf-8")).toBe("1");

    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "carry on" }] });
    await adapter.event(idle);
    expect(prompts).toHaveLength(2);
  });

  test("a Reject in a helper's chat whose owner cannot be confirmed still ends the person's turn", async () => {
    for (const lookup of ["throws", "has no record"] as const) {
      const { root } = nudgingProject();
      const prompts: string[] = [];
      const client: PluginInput["client"] = {
        session: {
          get: async ({ path }) => {
            if (path.id === "main") return { data: {} };
            if (lookup === "throws") throw new Error("lookup failed");
            return {};
          },
          prompt: async ({ body }) => {
            prompts.push(body.parts[0]?.text ?? "");
          },
        },
      };
      const adapter = await createTestAdapter(client, root);
      await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "start" }] });
      await adapter.event(replied("worker", { reply: "reject" }));
      await adapter.event(idle);
      expect(prompts, lookup).toHaveLength(0);
      await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "go on" }] });
      await adapter.event(idle);
      expect(prompts, lookup).toHaveLength(1);
    }
  });

  // What opencode does for a typed /aidlc: its command hook gets the command
  // name and arguments with the template part, then chat.message gets the
  // same parts with ids.
  async function runCommand(
    adapter: Awaited<ReturnType<typeof createTestAdapter>>,
    sessionID: string,
    template: string,
    args: string,
  ): Promise<Array<Record<string, unknown>>> {
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: template.replace("$ARGUMENTS", args).trim() }];
    await adapter["command.execute.before"]({ command: "aidlc", sessionID, arguments: args }, { parts });
    parts.forEach((part, i) => { part.id = `prt_${i}`; });
    await adapter["chat.message"]({ sessionID }, { parts });
    return parts;
  }
  function commandTemplate(root: string): string {
    const commandFile = join(REPO_ROOT, "dist", "opencode", ".opencode", "command", "aidlc.md");
    mkdirSync(join(root, ".opencode", "command"), { recursive: true });
    copyFileSync(commandFile, join(root, ".opencode", "command", "aidlc.md"));
    return readFileSync(commandFile, "utf-8").replace(/^---\n[\s\S]*?\n---\n/, "");
  }

  test("/aidlc shows what the person typed and keeps the command text for the agent", async () => {
    const root = freshProject();
    const template = commandTemplate(root);
    const recorded = join(root, "prompt.json");
    writeHook(root, "aidlc-session-start.ts", "await Bun.stdin.text();\n");
    writeHook(
      root,
      "aidlc-record-human-turn.ts",
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(recorded)}, await Bun.stdin.text(), "utf-8");
`,
    );
    const expanded = template.replace("$ARGUMENTS", "fix the sales report end date").trim();
    const { client } = fakeClient();
    const adapter = await createTestAdapter(client, root);

    const parts = await runCommand(adapter, "main", template, "fix the sales report end date");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "text", text: expanded, synthetic: true });
    expect(parts[1]).toMatchObject({ type: "text", text: "/aidlc fix the sales report end date", ignored: true });
    expect(parts[1].synthetic).toBeUndefined();
    // The person's turn is what they typed, as on every other harness.
    expect(JSON.parse(readFileSync(recorded, "utf-8")).prompt).toBe("/aidlc fix the sales report end date");

    const bare = await runCommand(adapter, "main", template, "");
    expect(bare[1]).toMatchObject({ text: "/aidlc", ignored: true });
    expect(JSON.parse(readFileSync(recorded, "utf-8")).prompt).toBe("/aidlc");

    // Another command is left as opencode sent it.
    const other: Array<Record<string, unknown>> = [{ type: "text", text: "Review the diff." }];
    await adapter["command.execute.before"]({ command: "review", sessionID: "main", arguments: "" }, { parts: other });
    expect(other).toEqual([{ type: "text", text: "Review the diff." }]);

    // A message that only reads like the command is shown and recorded as it is.
    const pasted: Array<Record<string, unknown>> = [{ id: "prt_9", type: "text", text: expanded }];
    await adapter["chat.message"]({ sessionID: "main" }, { parts: pasted });
    expect(pasted).toEqual([{ id: "prt_9", type: "text", text: expanded }]);
    expect(JSON.parse(readFileSync(recorded, "utf-8")).prompt).toBe(expanded);
  });

  test("a setting typed through /aidlc reaches the real human-turn hook, and the setter records it as the person's choice", async () => {
    const root = freshInstalledProject();
    seedStateFile(root, "state-brownfield-feature.md");
    writeSessionBinding(root, "main", "default", basename(seededRecordDir(root)));
    const template = commandTemplate(root);
    const { client, prompts, echo } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
    echo.to = (sessionID, parts) => adapter["chat.message"]({ sessionID }, { parts });
    const statePath = join(seededRecordDir(root), "aidlc-state.md");
    const ceremonyRows = () => readAuditShardEvents(root).filter((entry) => entry.event === "CEREMONY_SET");

    // Text that reads like the command, typed or sent without running it,
    // changes nothing; neither does a command run in another chat.
    const before = readFileSync(statePath, "utf-8");
    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ id: "prt_1", type: "text", text: template.replace("$ARGUMENTS", "config set summary-confirmation off").trim() }] },
    );
    await adapter["command.execute.before"](
      { command: "aidlc", sessionID: "other", arguments: "config set summary-confirmation off" },
      { parts: [{ type: "text", text: template.replace("$ARGUMENTS", "config set summary-confirmation off").trim() }] },
    );
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(ceremonyRows()).toHaveLength(0);

    // A nudge that arrives between the command and its message does not take
    // the command's place.
    const args = "config set summary-confirmation off";
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: template.replace("$ARGUMENTS", args).trim() }];
    await adapter["command.execute.before"]({ command: "aidlc", sessionID: "main", arguments: args }, { parts });
    writeHook(
      root,
      "aidlc-continue-workflow.ts",
      'await Bun.stdin.text();\nprocess.stdout.write(JSON.stringify({ decision: "block", reason: "keep going" }) + "\\n");\n',
    );
    await adapter.event({ event: { type: "session.idle", properties: { sessionID: "main" } } });
    expect(prompts).toHaveLength(1);
    parts.forEach((part, i) => { part.id = `prt_c${i}`; });
    await adapter["chat.message"]({ sessionID: "main" }, { parts });
    // Their line is on record for this chat; the setter the agent runs for it
    // records the setting as theirs.
    expect(ceremonyRows()).toHaveLength(0);
    const applied = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(root, ".aidlc", "tools", "aidlc.ts"),
        "engine", "config", "set", "summary-confirmation", "off",
        "--project-dir", root,
      ],
      cwd: root,
      env: {
        ...process.env,
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
        AIDLC_SESSION_OVERRIDE: undefined,
        AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);
    expect(readFileSync(statePath, "utf-8")).toContain("- **Summary Confirmation**: off (set by you)");
    const rows = ceremonyRows();
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
  });
});
