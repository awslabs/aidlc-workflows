// covers: file:hooks/aidlc-kiro-adapter.ts, function:KIRO_HOOK_GROUPS
//
// Kiro IDE shows a "Run Command Hook" card for every hook run (#2022), and what
// AI-DLC did after each write (the audit row and the sensors) and after each
// command (the stage graph, the stage sync, a new piece of work's chat) was a
// card of its own: two cards for every write and every command. Kiro passes no
// PostToolUse output to the agent or the person, so that work now runs at the
// start of the next card that runs anyway: the guard before the next write,
// command or hand-off, the card for the person's next message, or the turn's
// end. The person's message is one card too. Each case runs the adapter the
// way Kiro does, one process per card, and records what the core hooks got.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  REPO_ROOT,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const KIRO_IDE_TREE = join(REPO_ROOT, "dist", "kiro-ide", ".kiro");
const CLONE_ID = "testclonecatch1";
const SESSION = "S-CATCH";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function shardName(): string {
  const host = hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "host";
  return `${host}-${CLONE_ID}.md`;
}

// A core hook stand-in that records the hook name and what the adapter handed it.
function recorder(capture: string, hook: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    "export async function run(input: string): Promise<number> {",
    `  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ hook: ${JSON.stringify(hook)}, input: JSON.parse(input || "{}") }) + "\\n");`,
    "  return 0;",
    "}",
    "if (import.meta.main) process.exit(await run(await Bun.stdin.text()));",
  ].join("\n");
}

/** A Kiro IDE project with a running piece of work whose after-call hooks record what they get. */
function project(): { dir: string; capture: string } {
  const dir = mkdtempSync(join(tmpdir(), "t-catch-up-"));
  created.push(dir);
  cpSync(KIRO_IDE_TREE, join(dir, ".kiro"), { recursive: true });
  const intents = intentsDirOf(dir, DEFAULT_SPACE);
  cpSync(join(KIRO_IDE_TREE, "tools", "data", "memory-seed"), join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), {
    recursive: true,
  });
  mkdirSync(seededRecordDir(dir), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
  writeFileSync(join(intents, "active-intent"), `${DEFAULT_RECORD_DIR}\n`);
  writeFileSync(
    join(intents, "intents.json"),
    `${JSON.stringify([{ uuid: "00000000-0000-7000-8000-000000000001", slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" }], null, 2)}\n`,
  );
  writeFileSync(seededStateFile(dir), readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"));
  writeFileSync(join(dir, "aidlc", ".aidlc-clone-id"), `${CLONE_ID}\n`);
  mkdirSync(seededAuditDir(dir), { recursive: true });
  writeFileSync(join(seededAuditDir(dir), shardName()), "# AI-DLC Audit Log\n");
  const capture = join(dir, "after-call.jsonl");
  for (const [file, hook] of [
    ["aidlc-write-audit-log.ts", "write-audit-log"],
    ["aidlc-run-sensors.ts", "run-sensors"],
    ["aidlc-rebuild-stage-graph.ts", "rebuild-stage-graph"],
    ["aidlc-sync-workflow-state.ts", "sync-workflow-state"],
    ["aidlc-continue-workflow.ts", "continue-workflow"],
  ]) {
    writeFileSync(join(dir, ".kiro", "hooks", file), recorder(capture, hook));
  }
  return { dir, capture };
}

function card(dir: string, target: string, payload: Record<string, unknown>): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_UNATTENDED: undefined,
    AIDLC_COMPILED_EXECUTABLE: "",
    CLAUDE_PROJECT_DIR: dir,
  };
  delete env.USER_PROMPT;
  const r = spawnSync("bun", [join(dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), target], {
    cwd: dir,
    input: JSON.stringify({ cwd: dir, session_id: SESSION, ...payload }),
    encoding: "utf-8",
    env: env as NodeJS.ProcessEnv,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

function dispatcherCard(dir: string, target: string, payload: Record<string, unknown>): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string | undefined> = { ...process.env, AIDLC_COMPILED_EXECUTABLE: "", CLAUDE_PROJECT_DIR: dir };
  delete env.USER_PROMPT;
  const r = spawnSync("bun", [join(dir, ".kiro", "tools", "aidlc.ts"), "engine", "adapter", "kiro-ide", target], {
    cwd: dir,
    input: JSON.stringify({ cwd: dir, session_id: SESSION, ...payload }),
    encoding: "utf-8",
    env: env as NodeJS.ProcessEnv,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

const guard = (dir: string, tool_name: string, tool_input: Record<string, unknown>) =>
  card(dir, "guard-tool-call", { hook_event_name: "PreToolUse", tool_name, tool_input });
const turnEnd = (dir: string) => card(dir, "continue-workflow", { hook_event_name: "Stop" });
const message = (dir: string, prompt: string) =>
  card(dir, "person-message", { hook_event_name: "UserPromptSubmit", prompt });

interface Recorded {
  hook: string;
  input: { hook_event_name?: string; session_id?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: string };
}

function recorded(capture: string): Recorded[] {
  if (!existsSync(capture)) return [];
  return readFileSync(capture, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Recorded);
}

describe("t-kiro-ide-catch-up: what Kiro ran after a write or a command runs in the next card", () => {
  test("a write the guard lets through is recorded once, by the next card, with the chat's session", () => {
    const { dir, capture } = project();
    const notes = join(seededRecordDir(dir), "notes.md");
    const first = guard(dir, "fs_write", { path: notes, text: "# Notes\n" });
    expect(first.code, first.stderr).toBe(0);
    writeFileSync(notes, "# Notes\n");
    expect(recorded(capture)).toEqual([]);

    const next = guard(dir, "execute_pwsh", { command: "node --version", cwd: dir });
    expect(next.code, next.stderr).toBe(0);
    const forwarded = recorded(capture).filter((r) => r.hook === "write-audit-log" || r.hook === "run-sensors");
    expect(forwarded.map((r) => r.hook)).toEqual(["write-audit-log", "run-sensors"]);
    for (const r of forwarded) {
      expect(r.input.hook_event_name).toBe("PostToolUse");
      expect(r.input.session_id).toBe(SESSION);
      expect(r.input.tool_name).toBe("Write");
      expect(r.input.tool_input?.file_path).toBe(notes);
    }

    const third = guard(dir, "fs_write", { path: join(dir, "README.md"), text: "x" });
    expect(third.code, third.stderr).toBe(0);
    expect(recorded(capture).filter((r) => r.hook === "write-audit-log")).toHaveLength(1);
  });

  test("an edit is recorded as an Edit, and the turn's end records it before the end-of-turn check", () => {
    const { dir, capture } = project();
    const notes = join(seededRecordDir(dir), "notes.md");
    writeFileSync(notes, "before\n");
    expect(guard(dir, "str_replace", { path: notes, oldStr: "before", newStr: "after" }).code).toBe(0);
    writeFileSync(notes, "after\n");
    const end = turnEnd(dir);
    expect(end.code, end.stderr).toBe(0);
    const hooks = recorded(capture);
    expect(hooks.map((r) => r.hook)).toEqual(["write-audit-log", "run-sensors", "continue-workflow"]);
    expect(hooks[0].input.tool_name).toBe("Edit");
  });

  test("a refused write, and a write that leaves its file as it was, record nothing", () => {
    const { dir, capture } = project();
    const refused = guard(dir, "fs_write", { path: ".kiro/hooks/aidlc-kiro-adapter.ts", text: "// probe" });
    expect(refused.code).toBe(2);
    const readme = join(dir, "README.md");
    writeFileSync(readme, "# Project\n");
    expect(guard(dir, "fs_write", { path: readme, text: "# Project\n" }).code).toBe(0);
    // Still unchanged at the next call: it waits, as a call may still be writing.
    expect(guard(dir, "execute_pwsh", { command: "node --version", cwd: dir }).code).toBe(0);
    expect(turnEnd(dir).code).toBe(0);
    expect(recorded(capture).filter((r) => r.hook === "write-audit-log" || r.hook === "run-sensors")).toEqual([]);
    // At the turn's end every call has finished, so nothing is left waiting.
    const pending = join(dir, "aidlc", ".aidlc-sessions", "kiro-ide-pending");
    expect(existsSync(pending) ? readdirSync(pending) : []).toEqual([]);
  });

  test("a command's after-work runs at the next card: the graph rebuild, then the stage sync, for the chat", () => {
    const { dir, capture } = project();
    expect(guard(dir, "execute_pwsh", { command: "npm test", cwd: dir }).code).toBe(0);
    expect(recorded(capture)).toEqual([]);
    const next = guard(dir, "fs_write", { path: join(dir, "README.md"), text: "x" });
    expect(next.code, next.stderr).toBe(0);
    const ran = recorded(capture);
    expect(ran.map((r) => r.hook)).toEqual(["rebuild-stage-graph", "sync-workflow-state"]);
    for (const r of ran) expect(r.input.session_id).toBe(SESSION);
    // Once: the next card has nothing left to do for that command.
    expect(guard(dir, "execute_pwsh", { command: "node --version", cwd: dir }).code).toBe(0);
    expect(recorded(capture).filter((r) => r.hook === "rebuild-stage-graph")).toHaveLength(1);
  });

  test("after intent create, the next card hands the rebuild the record the command made, so the chat joins it", () => {
    const { dir, capture } = project();
    const command = "bun .kiro/tools/aidlc.ts engine intent create --scope poc";
    expect(guard(dir, "execute_pwsh", { command, cwd: dir }).code).toBe(0);
    const made = "notes-app-1234abcd";
    mkdirSync(join(intentsDirOf(dir, DEFAULT_SPACE), made), { recursive: true });
    writeFileSync(join(intentsDirOf(dir, DEFAULT_SPACE), made, "aidlc-state.md"), "# State\n");
    const said = message(dir, "go on");
    expect(said.code, said.stderr).toBe(0);
    const rebuild = recorded(capture).find((r) => r.hook === "rebuild-stage-graph");
    expect(rebuild?.input.session_id).toBe(SESSION);
    expect(rebuild?.input.tool_response).toContain(`Intent created: ${made} (space: ${DEFAULT_SPACE})`);
  });

  test("the person's message is one card: it records the turn, then runs a typed AI-DLC command, and both reach the agent", () => {
    const { dir } = project();
    const order = join(dir, "message-order.txt");
    writeFileSync(
      join(dir, ".kiro", "hooks", "aidlc-record-human-turn.ts"),
      [
        'import { appendFileSync } from "node:fs";',
        'if (process.argv.includes("--internal-aidlc-record-human-turn")) {',
        `  appendFileSync(${JSON.stringify(order)}, "record-human-turn\\n");`,
        '  process.stdout.write(JSON.stringify({ additionalContext: "TURN NOTED" }));',
        "  process.exit(0);",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, ".kiro", "tools", "aidlc-utility.ts"),
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(order)}, "utility\\n");`,
        'process.stdout.write("STATUS FROM THE UTILITY\\n");',
      ].join("\n"),
    );
    for (const run of [message, (d: string, p: string) => dispatcherCard(d, "person-message", { hook_event_name: "UserPromptSubmit", prompt: p })]) {
      writeFileSync(order, "");
      const r = run(dir, "/aidlc --status");
      expect(r.code, r.stderr).toBe(0);
      expect(readFileSync(order, "utf-8").trim().split("\n")).toEqual(["record-human-turn", "utility"]);
      const noted = r.stdout.indexOf("TURN NOTED");
      const relayed = r.stdout.indexOf("STATUS FROM THE UTILITY");
      expect(noted, r.stdout).toBeGreaterThanOrEqual(0);
      expect(relayed, r.stdout).toBeGreaterThan(noted);
      expect(r.stdout.slice(noted, relayed)).toContain("\n");
    }
  });

  test("a project that still has its after-write and after-command cards keeps them, so nothing is recorded twice", () => {
    const { dir, capture } = project();
    for (const [file, hook] of [
      ["aidlc-write-audit-log.json", { name: "aidlc-write-audit-log", trigger: "PostToolUse", matcher: "fs_write|str_replace|fs_append", action: { type: "command", command: "aidlc engine adapter kiro-ide audit-and-sensors" } }],
      ["aidlc-after-shell.json", { name: "aidlc-after-shell", trigger: "PostToolUse", matcher: "execute_bash|execute_pwsh|shell", action: { type: "command", command: "aidlc engine adapter kiro-ide after-shell" } }],
    ] as const) {
      writeFileSync(join(dir, ".kiro", "hooks", file), JSON.stringify({ version: "v1", hooks: [hook] }));
    }
    const notes = join(seededRecordDir(dir), "notes.md");
    expect(guard(dir, "fs_write", { path: notes, text: "x" }).code).toBe(0);
    writeFileSync(notes, "x");
    expect(guard(dir, "execute_pwsh", { command: "npm test", cwd: dir }).code).toBe(0);
    expect(turnEnd(dir).code).toBe(0);
    expect(recorded(capture).map((r) => r.hook)).toEqual(["continue-workflow"]);
  });
});
