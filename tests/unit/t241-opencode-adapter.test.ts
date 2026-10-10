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
import { basename, dirname, join, relative } from "node:path";
import createAdapter, {
  type PluginInput,
} from "../../harness/opencode/plugin/aidlc-opencode-adapter.ts";
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
      "aidlc-install-paths.ts",
      "aidlc-distribution.ts",
      "aidlc-channel.ts",
      "aidlc-version.ts",
      "aidlc-guard-fences.ts",
      "aidlc-guard-switch.ts",
      "aidlc-guard-operation.ts",
      "aidlc-reply-reader.ts",
      "aidlc-runtime-budget.ts",
    ]) {
      copyFileSync(
        join(REPO_ROOT, "core", "tools", dependency),
        join(root, ".aidlc", "tools", dependency),
      );
    }
  }
}

function fakeClient(parentBySession: Record<string, string | undefined> = {}) {
  const prompts: Array<{ id: string; text: string; synthetic?: boolean }> = [];
  const client: PluginInput["client"] = {
    session: {
      get: async ({ path }) => ({
        data: parentBySession[path.id]
          ? { parentID: parentBySession[path.id] }
          : {},
      }),
      prompt: async ({ path, body }) => {
        prompts.push({ id: path.id, text: body.parts[0]?.text ?? "", synthetic: body.parts[0]?.synthetic });
      },
    },
  };
  return { client, prompts };
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
    // A reviewer task reaches the guard as a Task too: the guard records a brief
    // that already carries the verdict, and refuses nothing for a reviewer.
    await before(
      { tool: "task", sessionID: "S-OC", callID: "t2" },
      { args: { subagent_type: "aidlc-architecture-reviewer-agent", prompt: "Review u1.\n\n**Verdict:** READY\n" } },
    );
    const calls = readFileSync(capture, "utf-8").trim().split("\n")
      .map((line) => JSON.parse(line) as { session_id?: unknown; tool_name?: string; tool_input?: { subagent_type?: string } });
    expect(calls.map((call) => call.session_id)).toEqual(["S-OC", "S-OC", "S-OC", "S-OC"]);
    expect(calls[3].tool_name).toBe("Task");
    expect(calls[3].tool_input?.subagent_type).toBe("aidlc-architecture-reviewer-agent");
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
  test("blocks direct lifecycle verbs and allows read-only state queries", async () => {
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
    await expect(
      invoke("blocked", "bun .aidlc/tools/aidlc-state.ts approve user-stories"),
    ).rejects.toThrow(/Stage status cannot be changed with aidlc-state\.ts approve/i);
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
    await adapter.event({
      event: {
        type: "session.idle",
        properties: { sessionID: "main" },
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain("[aidlc-forwarding-nudge]");
  });

  // A live run: new work made from one chat, then a new chat on it. A plain
  // question there was followed by a hidden nudge that started the new work's
  // first stage. The question ends the turn; an advance still leads to the nudge.
  test("in a new chat on work made from another chat, a plain question gets no nudge, and an advance still does", async () => {
    const root = freshInstalledProject();
    const engine = (session: string, ...args: string[]) => {
      const run = Bun.spawnSync({
        cmd: [process.execPath, join(root, ".aidlc", "tools", "aidlc.ts"), "engine", ...args, "--project-dir", root],
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
    await adapter.event(idle);
    expect(prompts).toHaveLength(0);

    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ type: "text", text: "carry on" }] });
    await Bun.sleep(20);
    expect(JSON.parse(engine("main", "orchestrate", "next")).kind).not.toBe("print");
    await adapter.event(idle);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain("[aidlc-forwarding-nudge]");
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
    await adapter.event(idle);
    expect(prompts).toHaveLength(0);

    appendInteractionEvent(root, "QUESTION_ANSWERED", "requirements-analysis");
    await adapter.event(idle);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain("[aidlc-forwarding-nudge]");
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
    await adapter.event(idle);
    expect(prompts).toHaveLength(0);

    expect(engine("next").kind).not.toBe("print");
    await adapter.event(idle);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain("[aidlc-forwarding-nudge]");
  });

  test("a typed summary-confirmation off in chat reaches the real record-human-turn hook as the person's choice", async () => {
    const root = freshInstalledProject();
    seedStateFile(root, "state-brownfield-feature.md");
    writeSessionBinding(root, "main", "default", basename(seededRecordDir(root)));
    const statePath = join(seededRecordDir(root), "aidlc-state.md");
    const ceremonyRows = () =>
      readAuditShardEvents(root).filter((entry) => entry.event === "CEREMONY_SET");
    const { client } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });

    // chat.message forwards the first text part as the UserPromptSubmit prompt.
    await adapter["chat.message"](
      { sessionID: "main" },
      { parts: [{ type: "text", text: "/aidlc config set summary-confirmation off" }] },
    );

    const state = readFileSync(statePath, "utf-8");
    expect(state).toContain("- **Summary Confirmation**: off (set by you)");
    const audit = ceremonyRows();
    expect(audit).toHaveLength(1);
    expect(auditBlockField(audit[0].block, "New")).toBe("off");
    expect(auditBlockField(audit[0].block, "Source")).toBe("you");

    // A later agent-run command repeat neither writes nor relabels the choice.
    const repeated = Bun.spawnSync({
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
    expect(prompts[0].text).toStartWith("[aidlc-forwarding-nudge]");
    expect(prompts[0].synthetic).toBe(true);
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

  test("a setting typed through /aidlc reaches the real human-turn hook as the person's choice", async () => {
    const root = freshInstalledProject();
    seedStateFile(root, "state-brownfield-feature.md");
    writeSessionBinding(root, "main", "default", basename(seededRecordDir(root)));
    const template = commandTemplate(root);
    const { client } = fakeClient();
    const adapter = await createAdapter({ client, directory: root });
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
    await adapter["chat.message"]({ sessionID: "main" }, { parts: [{ id: "prt_n", type: "text", text: "[aidlc-forwarding-nudge] keep going", synthetic: true }] });
    parts.forEach((part, i) => { part.id = `prt_c${i}`; });
    await adapter["chat.message"]({ sessionID: "main" }, { parts });
    expect(readFileSync(statePath, "utf-8")).toContain("- **Summary Confirmation**: off (set by you)");
    const rows = ceremonyRows();
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
  });
});
