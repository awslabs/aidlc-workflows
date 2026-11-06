// covers: function:cleanChatLine, function:newChatStep, function:shippedNewChatStep, function:harnessIsAGuess, function:createPrintDirective, function:sayPendingPersonLines, subcommand:aidlc-orchestrate:next
//
// New work started beside other work in a chat carries on in that chat, and
// the person is offered once to start it in a clean chat instead. The offer
// names the step of the tool they are in, from that tree's own harness.json
// (each manifest's newChatStep), and the new work's first stage step says it
// in its own line (narration), as the step comes, before the stage's work.
//
// Measured on main 17a37b7bb: on Kiro CLI (the kiro-ide tree outside Kiro
// IDE) the line named Kiro IDE's step ("open a new chat, pick the aidlc
// agent"), on the Kiro CLI v2 tree "open a new chat", which is no Kiro CLI
// step; and on every tree the line rode the first stage's change_notices,
// said before the person replies, so it reached them with the first gate
// after that stage had run in the old chat (a live Kiro CLI run: 9.5 minutes).
// Handed instead as an order in the creation step's message, the agent on
// Kiro CLI 3.1.0 still said it only at the end of the turn; the first stage
// step's narration it said at once (live run, 2026-11-06).

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestProject, REPO_ROOT, toPortablePath } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { newChatStep } from "../../dist/kiro/.kiro/tools/aidlc-new-chat.ts";

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
const CLAUDE = ROWS[0];
const KIRO_CLI = ROWS[6];

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

// The host the row names, attended, and in a known chat unless `chat` is
// false (then the creation step keeps its own line, as with no chat id); the
// hooks are not under test.
function hostEnv(row: Pick<Row, "env">, chat: boolean): NodeJS.ProcessEnv {
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
    "AIDLC_SESSION_OVERRIDE",
    "AIDLC_SESSION_OVERRIDE_SOURCE",
    // The chat this test runs in names none of the rows' chats.
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_PID",
    "CODEX_THREAD_ID",
    "KIRO_SESSION_ID",
    "TERM_PROGRAM",
    "VSCODE_IPC_HOOK",
    "VSCODE_PID",
  ]) delete env[key];
  return {
    ...env,
    ...(chat ? { AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" } : {}),
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    ...row.env,
  };
}

type Step = Record<string, unknown> & {
  kind: string;
  message?: string;
  narration?: string;
  change_notices?: string[];
  receipt?: string;
};

function run(proj: string, row: Pick<Row, "env">, argv: string[], chat: boolean): string {
  const r = spawnSync(process.execPath, argv, {
    cwd: proj,
    encoding: "utf-8",
    env: hostEnv(row, chat),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return r.stdout;
}

function next(proj: string, row: Pick<Row, "dir" | "env">, args: string[], chat: boolean): Step {
  return JSON.parse(run(proj, row, [join(proj, row.dir, "tools", "aidlc-orchestrate.ts"), "next", ...args], chat).trim());
}

// The first work, which the chat then holds.
function firstWork(proj: string, row: Pick<Row, "dir" | "env">): void {
  run(proj, row, [
    join(proj, row.dir, "tools", "aidlc-utility.ts"),
    "intent-create", "--scope", "poc", "--label", "lunch poll", "--arguments", "build a lunch poll",
  ], true);
}

// The creation the print names, run as the agent runs it, then the first step
// the agent acts on (its rules parts read first).
function createdAndFirstStep(proj: string, row: Pick<Row, "dir" | "env">, print: Step): Step {
  const request = /--request ([0-9a-f]{8})/.exec(String(print.message))?.[1];
  expect(request, String(print.message)).toBeDefined();
  run(proj, row, [
    join(proj, row.dir, "tools", "aidlc.ts"), "engine", "intent", "create", "--scope", "bugfix", "--request", request ?? "",
    "--label", "the-work",
  ], true);
  return firstStep(proj, row);
}

function firstStep(proj: string, row: Pick<Row, "dir" | "env">): Step {
  let step = next(proj, row, [], true);
  for (let parts = 0; step.kind === "load-steering" && parts < 50; parts++) {
    step = JSON.parse(run(proj, row, [join(proj, row.dir, "tools", "aidlc-orchestrate.ts"), "continue", String(step.receipt)], true).trim());
  }
  return step;
}

const newWork = ["--new-intent", "--scope", "bugfix", "fix the flaky login test"];
const said = (step: string) => `${LEAD}${step}.`;
const offers = (text: unknown) => String(text ?? "").split("clean chat").length - 1;

describe("t-clean-chat-line-per-tool: the clean-chat offer names the person's own tool's step, before the stage", () => {
  for (const row of ROWS) {
    test(`${row.tree} in ${row.host}: the offer says "${row.step}"`, () => {
      const proj = project(row.tree);
      firstWork(proj, row);
      const print = next(proj, row, newWork, false);
      expect(print.kind).toBe("print");
      expect(String(print.narration)).toEndWith(` ${said(row.step)}`);
      expect(offers(JSON.stringify(print))).toBe(1);
    });
  }

  test("the new work's first stage step says it as the step comes, once, and not with the gate", () => {
    for (const row of [CLAUDE, KIRO_CLI]) {
      const proj = project(row.tree);
      firstWork(proj, row);
      const print = next(proj, row, newWork, true);
      expect(print.kind, row.host).toBe("print");
      expect(offers(JSON.stringify(print)), row.host).toBe(0);
      const first = createdAndFirstStep(proj, row, print);
      expect(first.kind, row.host).toBe("run-stage");
      // The stage's own line first, then the offer, both said as the step comes.
      expect(String(first.narration), row.host).toStartWith("Starting the bugfix plan");
      expect(String(first.narration), row.host).toEndWith(` ${said(row.step)}`);
      // Not among the lines said before the person replies, which still carry the creation's own.
      expect(offers(JSON.stringify(first.change_notices ?? [])), row.host).toBe(0);
      expect((first.change_notices ?? []).join(" "), row.host).toContain("Setting up the bugfix workflow");
      expect(offers(JSON.stringify(first)), row.host).toBe(1);
      // Said once: the same step asked for again does not carry it.
      expect(offers(JSON.stringify(firstStep(proj, row))), row.host).toBe(0);
    }
  });

  test("a chat that holds no other work is offered nothing new", () => {
    const row = KIRO_CLI;
    const proj = project(row.tree);
    const print = next(proj, row, ["--scope", "bugfix", "fix the flaky login test"], true);
    expect(print.kind).toBe("print");
    expect(offers(JSON.stringify(print))).toBe(0);
    expect(offers(JSON.stringify(createdAndFirstStep(proj, row, print)))).toBe(0);
  });

  test("a tree that names no step for a new chat says nothing about one", () => {
    const row = KIRO_CLI;
    const proj = project(row.tree);
    const data = join(proj, row.dir, "tools", "data", "harness.json");
    const shipped = JSON.parse(readFileSync(data, "utf-8")) as Record<string, unknown>;
    delete shipped.newChatStep;
    writeFileSync(data, `${JSON.stringify(shipped, null, 2)}\n`, "utf-8");
    firstWork(proj, row);
    const print = next(proj, row, newWork, false);
    expect(print.kind).toBe("print");
    expect(offers(JSON.stringify(print))).toBe(0);
    expect(print.message).toContain("then re-run `next` to continue.");
  });

  // A native engine in a project with several harnesses that cannot tell which
  // tool runs a command runs on the first one installed, as a guess, so its
  // tree's step can be another tool's: Kiro CLI's "/chat new" said in Cursor
  // (AIDA review 5797055097 F1). The tool whose mark the command carries is
  // told apart (t-native-engine-caller-lines).
  test("a native engine that could only guess the person's tool names no step", () => {
    const pinned = (env: Record<string, string>): string | null => {
      const keys = ["AIDLC_HARNESS_DIR", "AIDLC_HARNESS_DIR_GUESSED"] as const;
      const was = keys.map((key) => process.env[key]);
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, env);
      try {
        return newChatStep();
      } finally {
        keys.forEach((key, i) => {
          if (was[i] === undefined) delete process.env[key];
          else process.env[key] = was[i];
        });
      }
    };
    expect(pinned({ AIDLC_HARNESS_DIR: ".kiro", AIDLC_HARNESS_DIR_GUESSED: ".kiro" })).toBeNull();
    // The tool told apart, one harness installed, or the copy channel: the tree's own step.
    expect(pinned({ AIDLC_HARNESS_DIR: ".kiro" })).toBe(KIRO_CLI_STEP);
    // A guess the engine then pinned past is no longer one.
    expect(pinned({ AIDLC_HARNESS_DIR: ".kiro", AIDLC_HARNESS_DIR_GUESSED: ".claude" })).toBe(KIRO_CLI_STEP);
  });
});
