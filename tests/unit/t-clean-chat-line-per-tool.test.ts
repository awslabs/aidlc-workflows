// covers: function:cleanChatLine, function:newChatStep, function:createPrintDirective, subcommand:aidlc-orchestrate:next
//
// New work started beside other work in a chat carries on in that chat, and
// the person is offered once to start it in a clean chat instead. The offer
// names the step of the tool they are in, from that tree's own harness.json
// (each manifest's newChatStep), and the agent says it once the work exists
// and before its first stage, where the person can still take it.
//
// Measured on main 17a37b7bb: on Kiro CLI (the kiro-ide tree outside Kiro
// IDE) the line named Kiro IDE's step ("open a new chat, pick the aidlc
// agent"), on the Kiro CLI v2 tree "open a new chat", which is no Kiro CLI
// step; and on every tree the line rode the first stage's change_notices,
// said before the person replies, so it reached them with the first gate
// after that stage had run in the old chat (a live Kiro CLI run: 9.5 minutes).

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestProject, REPO_ROOT, toPortablePath } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SESSION = "01995000-7a11-7000-8000-00000000c1ea";
const LEAD = "To start this in a clean chat instead, ";
const KIRO_IDE_STEP = "open a new chat, pick the aidlc agent, then type /aidlc";
const KIRO_CLI_STEP = "type /chat new, then /aidlc";

type Row = { tree: string; dir: string; host: string; env: Record<string, string>; step: string };

// The agent's shell in each host: Kiro IDE's commands carry TERM_PROGRAM=kiro;
// Kiro CLI started from VS Code's terminal carries TERM_PROGRAM=vscode beside
// VS Code's own VSCODE_PID, which rules Kiro IDE out.
const ROWS: Row[] = [
  { tree: "claude", dir: ".claude", host: "Claude Code", env: {}, step: "type /clear, then /aidlc" },
  { tree: "codex", dir: ".codex", host: "Codex", env: {}, step: "open a new chat, then type $aidlc" },
  { tree: "copilot", dir: ".aidlc", host: "Copilot", env: {}, step: "open a new chat, then type /aidlc" },
  { tree: "cursor", dir: ".cursor", host: "Cursor", env: {}, step: "open a new chat, then type /aidlc" },
  { tree: "kiro", dir: ".kiro", host: "Kiro CLI on its v2 engine", env: {}, step: KIRO_CLI_STEP },
  { tree: "kiro-ide", dir: ".kiro", host: "Kiro IDE", env: { TERM_PROGRAM: "kiro" }, step: KIRO_IDE_STEP },
  { tree: "kiro-ide", dir: ".kiro", host: "Kiro CLI", env: {}, step: KIRO_CLI_STEP },
  {
    tree: "kiro-ide",
    dir: ".kiro",
    host: "Kiro CLI in VS Code's terminal",
    env: { TERM_PROGRAM: "vscode", VSCODE_PID: "4242" },
    step: KIRO_CLI_STEP,
  },
  { tree: "opencode", dir: ".aidlc", host: "opencode", env: {}, step: "start a new session, then type /aidlc" },
];

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

// A project set up from the tree's copy runtime, as a person copies it.
function project(tree: string): string {
  let proj = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-clean-chat-"));
  try {
    proj = realpathSync(proj);
  } catch {
    // Keep the temp path as created.
  }
  proj = toPortablePath(proj);
  projects.push(proj);
  cpSync(join(REPO_ROOT, "dist", tree), proj, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: proj });
  return proj;
}

// One chat in the host the row names, attended; the hooks are not under test.
function chatEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "AIDLC_PROJECT_DIR",
    "CLAUDE_PROJECT_DIR",
    "AIDLC_HARNESS_NAME",
    "AIDLC_HARNESS_DIR",
    "AIDLC_COMPILED_EXECUTABLE",
    "AIDLC_RUNTIME_ROOT",
    "AIDLC_RUNTIME_HARNESS_ROOT",
    "AIDLC_UNATTENDED",
    "TERM_PROGRAM",
    "VSCODE_IPC_HOOK",
    "VSCODE_PID",
  ]) delete env[key];
  return {
    ...env,
    AIDLC_SESSION_OVERRIDE: SESSION,
    AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    ...extra,
  };
}

type Step = Record<string, unknown> & { kind: string; message?: string; narration?: string; receipt?: string };

function tool(proj: string, row: Pick<Row, "dir" | "env">, argv: string[]): Step {
  const r = spawnSync(process.execPath, argv, {
    cwd: proj,
    encoding: "utf-8",
    env: chatEnv(row.env),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout.trim()) as Step;
}

function next(proj: string, row: Pick<Row, "dir" | "env">, args: string[] = []): Step {
  return tool(proj, row, [join(proj, row.dir, "tools", "aidlc-orchestrate.ts"), "next", ...args]);
}

// The first work, which the chat then holds.
function firstWork(proj: string, row: Pick<Row, "dir" | "env">): void {
  const r = spawnSync(process.execPath, [
    join(proj, row.dir, "tools", "aidlc-utility.ts"),
    "intent-create", "--scope", "poc", "--label", "lunch poll", "--arguments", "build a lunch poll",
  ], { cwd: proj, encoding: "utf-8", env: chatEnv(row.env), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

// The creation the print names, run as the agent runs it, then the first step
// the agent acts on (its rules parts read first).
function createdAndFirstStep(proj: string, row: Pick<Row, "dir" | "env">, print: Step, scope: string): Step {
  const request = /--request ([0-9a-f]{8})/.exec(String(print.message))?.[1];
  expect(request, String(print.message)).toBeDefined();
  const made = spawnSync(process.execPath, [
    join(proj, row.dir, "tools", "aidlc.ts"), "engine", "intent", "create", "--scope", scope, "--request", request ?? "",
    "--label", "the-work",
  ], { cwd: proj, encoding: "utf-8", env: chatEnv(row.env), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  let step = next(proj, row);
  for (let parts = 0; step.kind === "load-steering" && parts < 50; parts++) {
    step = tool(proj, row, [join(proj, row.dir, "tools", "aidlc-orchestrate.ts"), "continue", String(step.receipt)]);
  }
  return step;
}

const newWork = ["--new-intent", "--scope", "bugfix", "fix the flaky login test"];
const order = (step: string) =>
  `then tell the person in one line: "${LEAD}${step}." and re-run \`next\` to continue.`;

describe("t-clean-chat-line-per-tool: the clean-chat offer names the person's own tool's step, before the stage", () => {
  for (const row of ROWS) {
    test(`${row.tree} in ${row.host}: the creation step has the agent say "${row.step}" once the work exists`, () => {
      const proj = project(row.tree);
      firstWork(proj, row);
      const print = next(proj, row, newWork);
      expect(print.kind).toBe("print");
      expect(print.message).toContain(order(row.step));
      expect(String(print.message).split("clean chat").length - 1).toBe(1);
      // Not carried with the creation's own lines, which are said before the person replies.
      expect(String(print.narration ?? "")).not.toContain("clean chat");
    });
  }

  test("the first stage step carries no clean-chat line, so it is not said with the first gate", () => {
    for (const row of [ROWS[0], ROWS[6]]) {
      const proj = project(row.tree);
      firstWork(proj, row);
      const print = next(proj, row, newWork);
      const first = createdAndFirstStep(proj, row, print, "bugfix");
      expect(first.kind, row.host).toBe("run-stage");
      expect(JSON.stringify(first), row.host).not.toContain("clean chat");
      // The creation's own lines still ride that step, as before.
      expect((first.change_notices as string[] | undefined)?.join(" ") ?? "", row.host)
        .toContain("Setting up the bugfix workflow");
    }
  });

  test("a chat that holds no other work is offered nothing new", () => {
    const row = ROWS[6];
    const proj = project(row.tree);
    const print = next(proj, row, ["--scope", "bugfix", "fix the flaky login test"]);
    expect(print.kind).toBe("print");
    expect(JSON.stringify(print)).not.toContain("clean chat");
    expect(print.message).toContain("then re-run `next` to continue.");
    expect(JSON.stringify(createdAndFirstStep(proj, row, print, "bugfix"))).not.toContain("clean chat");
  });

  test("a tree that names no step for a new chat says nothing about one", () => {
    const row = ROWS[6];
    const proj = project(row.tree);
    const data = join(proj, row.dir, "tools", "data", "harness.json");
    const shipped = JSON.parse(readFileSync(data, "utf-8")) as Record<string, unknown>;
    delete shipped.newChatStep;
    writeFileSync(data, `${JSON.stringify(shipped, null, 2)}\n`, "utf-8");
    firstWork(proj, row);
    const print = next(proj, row, newWork);
    expect(print.kind).toBe("print");
    expect(JSON.stringify(print)).not.toContain("clean chat");
    expect(print.message).toContain("then re-run `next` to continue.");
  });
});
