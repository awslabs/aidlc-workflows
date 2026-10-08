// covers: function:chatHoldsRules, function:recordRulesLoad, function:noteRulesDelivered, function:clearRulesDelivered, function:noteKiroIdeTurn, function:kiroIdeSteering, function:refreshKiroIdeSteering, function:trackedKiroIdeSteeringAsk, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:continue
//
// #2023: every `next` sent the stage's whole rule bundle again (17 KB with the
// shipped memory, 34 KB in three tool results with a grown team.md), so a long
// Construction run filled the chat with copies. A `next` now sends a short
// `rules_held` pointer instead of the text, but only where the chat provably
// holds that exact text, and the full text everywhere else:
//
//   - Kiro CLI and opencode put the memory files in context on every request
//     (live: an edit is seen at once and survives a compaction), so the pointer
//     needs only the host's own include to cover the stage's files.
//   - On every tool, a chat's first step, and a step whose bundle differs from
//     the one this chat's last step named, gets the text once, so the rules are
//     in front of the agent (live on Kiro IDE, an agent in a new chat that held
//     the rules in its steering once ignored a team rule on a pointer step).
//   - A pointer step says in one sentence where its rules are, so it works with
//     no skill loaded.
//   - Claude Code loads them at startup, resume, clear, compact and fork, but
//     not after a mid-chat edit, so the pointer needs the hashes the session
//     start recorded for this chat to match the files now. A resume or fork
//     after an edit may leave older copies in the chat: full text.
//   - Codex has no include: the pointer needs this thread to have been given
//     the bundle, with no session start or compaction since, and no compaction
//     in its rollout after it.
//   - Kiro IDE (and Kiro CLI v3 on the same files) keeps the always-included
//     steering file a chat captured when it started, through summaries and
//     reloads, never a mid-chat edit (live on 1.2.4). AI-DLC writes the memory
//     text into that gitignored file, so the pointer needs the chat's session
//     start to have found it current and unchanged since. Kiro IDE's shell has
//     no chat id, so every chat with an open turn must hold the same file.
//   - Cursor and Copilot, and every missing signal: full text.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(120_000);

const STATE_FIXTURE = join(FIXTURES_DIR, "state-brownfield-feature.md");
const STAGE_LINE = /^- \[[ x-]\] ([a-z0-9-]+) \u2014 EXECUTE$/gm;
const STAGE = "requirements-analysis";
// Host identity variables a test inherits from the shell that runs it.
const HOST_ENV = [
  "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "KIRO_SESSION_ID", "OPENCODE",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE",
  "AIDLC_PROJECT_DIR", "AIDLC_HARNESS_NAME", "AIDLC_HARNESS_DIR", "AIDLC_RUNTIME_ROOT",
  "AIDLC_RUNTIME_HARNESS_ROOT", "AIDLC_COMPILED_EXECUTABLE", "AIDLC_STOP_HOOK_PROBE",
];

type Printed = {
  kind: string;
  conductor_persona?: string;
  receipt?: string;
  rules_content?: Array<{ path: string; text: string }>;
  rules_held?: string;
  rules_held_note?: string;
  rules_in_context?: string[];
  bundle?: string;
};

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const FIXTURE_STATE = readFileSync(STATE_FIXTURE, "utf-8");
const FIXTURE_STAGES = [...FIXTURE_STATE.matchAll(STAGE_LINE)].map((match) => match[1] ?? "");

function stateAt(stage: string): string {
  const at = FIXTURE_STAGES.indexOf(stage);
  return FIXTURE_STATE
    .replace(/^(- \*\*Current Stage\*\*: ).*$/m, `$1${stage}`)
    .replace(/^(- \*\*In Progress\*\*: ).*$/m, `$1${stage}`)
    .replace(STAGE_LINE, (line, slug: string) => {
      const index = FIXTURE_STAGES.indexOf(slug);
      const mark = index < at ? "x" : index === at ? "-" : " ";
      return line.replace(/^- \[[ x-]\]/, `- [${mark}]`);
    });
}

const HARNESS_DIR: Record<string, string> = {
  claude: ".claude",
  kiro: ".kiro",
  "kiro-ide": ".kiro",
  codex: ".codex",
  opencode: ".aidlc",
  copilot: ".aidlc",
  cursor: ".cursor",
};

// A project as a configured install leaves it: the first session start writes
// AI-DLC's root parts (a file the host may already have read, so that chat gets
// the full text), and every later one finds them in place.
async function projectFor(harness: string): Promise<string> {
  const proj = copiedProject(harness);
  await sessionStart(proj, harness, randomUUID(), "startup");
  return proj;
}

function copiedProject(harness: string): string {
  const root = join(REPO_ROOT, "dist", harness);
  const proj = createTestProject();
  projects.push(proj);
  cpSync(join(root, HARNESS_DIR[harness]), join(proj, HARNESS_DIR[harness]), { recursive: true });
  cpSync(join(root, "aidlc"), join(proj, "aidlc"), { recursive: true });
  for (const file of ["opencode.json"]) {
    try {
      cpSync(join(root, file), join(proj, file));
    } catch {
      // only opencode ships it
    }
  }
  writeFileSync(seededStateFile(proj), stateAt(STAGE), "utf-8");
  return proj;
}

function memoryFile(proj: string, name: string): string {
  return join(proj, "aidlc", "spaces", "default", "memory", name);
}

// A team practice the stage's rules now carry (substantive, so it is in the bundle).
function editTeam(proj: string, line: string): void {
  appendFileSync(memoryFile(proj, "team.md"), `\n- ${line}\n`);
}

// A named chat id is the host's own (as a hook payload or the Codex shell
// gives it), so it wins over the process tree, which every chat started in this
// test shares.
function childEnv(extra: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of HOST_ENV) delete env[key];
  return {
    ...env,
    ...(extra.AIDLC_SESSION_OVERRIDE ? { AIDLC_SESSION_OVERRIDE_SOURCE: "payload" } : {}),
    ...extra,
  };
}

async function run(
  proj: string,
  argv: string[],
  extra: Record<string, string>,
  stdin = "",
): Promise<string> {
  const child = Bun.spawn(argv, {
    cwd: proj,
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(extra),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, `${argv.join(" ")}: ${stderr}`).toBe(0);
  return stdout;
}

// The session start a host runs, through the same dispatcher its hook config names.
async function sessionStart(
  proj: string,
  harness: string,
  sessionId: string,
  source: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const tools = join(proj, HARNESS_DIR[harness], "tools", "aidlc.ts");
  if (harness === "codex") {
    await run(proj, [process.execPath, tools, "engine", "adapter", "codex", "session-start"], extra, JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source,
      ...(extra.TRANSCRIPT ? { transcript_path: extra.TRANSCRIPT } : {}),
    }));
    return;
  }
  await run(proj, [process.execPath, tools, "engine", "hook", "session-start"], {
    ...(harness === "claude" ? { CLAUDE_PROJECT_DIR: proj } : {}),
    ...extra,
  }, JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, source, cwd: proj }));
}

async function preCompact(proj: string, harness: string, sessionId: string): Promise<void> {
  const tools = join(proj, HARNESS_DIR[harness], "tools", "aidlc.ts");
  const argv = harness === "codex"
    ? [process.execPath, tools, "engine", "adapter", "codex", "validate-state"]
    : [process.execPath, tools, "engine", "hook", "validate-state"];
  await run(proj, argv, {}, JSON.stringify({ hook_event_name: "PreCompact", session_id: sessionId, trigger: "manual" }));
}

// One `next` as the agent runs it, then `continue <receipt>` for every part.
// Returns every printed directive and the bytes the chat received.
// Codex records each command's output in the thread's rollout, as it showed
// it to the model: `cut` keeps the head and tail of every rule text and drops
// the middle, as Codex does when the model asks for a small output budget.
type Rollout = { path: string; cut?: boolean };

function recordOutput(rollout: Rollout, stdout: string): void {
  let shown = stdout;
  if (rollout.cut) {
    const directive = JSON.parse(stdout) as Printed;
    for (const rule of directive.rules_content ?? []) {
      rule.text = `${rule.text.slice(0, 40)}\n...3071 tokens truncated...\n${rule.text.slice(-40)}`;
    }
    shown = `Warning: truncated output (original token count: 5071)\n${JSON.stringify(directive)}`;
  }
  appendFileSync(rollout.path, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: { type: "function_call_output", output: `Process exited with code 0\nOutput:\n${shown}` },
  })}\n`);
}

function recordCompaction(rollout: Rollout, at: Date): void {
  appendFileSync(rollout.path, `${JSON.stringify({ timestamp: at.toISOString(), type: "compacted", payload: { message: "" } })}\n`);
}

async function next(
  proj: string,
  harness: string,
  env: Record<string, string>,
  rollout?: Rollout,
): Promise<{ results: Printed[]; bytes: number; final: Printed }> {
  const engine = join(proj, HARNESS_DIR[harness], "tools", "aidlc-orchestrate.ts");
  const results: Printed[] = [];
  let bytes = 0;
  let args = ["next"];
  for (let hop = 0; hop < 10; hop++) {
    const stdout = await run(proj, [process.execPath, engine, ...args], env);
    if (rollout) recordOutput(rollout, stdout);
    bytes += Buffer.byteLength(stdout, "utf-8");
    const directive = JSON.parse(stdout) as Printed;
    results.push(directive);
    if (directive.kind !== "load-steering") return { results, bytes, final: directive };
    args = ["continue", directive.receipt ?? ""];
  }
  throw new Error("rules did not reach run-stage in 10 hops");
}

function sentInFull(delivery: { results: Printed[]; final: Printed }): boolean {
  return delivery.final.kind === "run-stage" &&
    delivery.final.rules_held === undefined &&
    (delivery.results.length > 1 || (delivery.final.rules_content?.length ?? 0) > 0);
}

const POINTER_NOTE =
  "This step's rules are the AI-DLC memory text already in your context; apply them to every file you write in this step.";

function pointerOnly(delivery: { results: Printed[]; final: Printed }): boolean {
  return delivery.results.length === 1 &&
    delivery.final.kind === "run-stage" &&
    typeof delivery.final.rules_held === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(delivery.final.rules_held) &&
    delivery.final.rules_held_note === POINTER_NOTE &&
    delivery.final.rules_content === undefined;
}

describe("Claude Code: the memory the host loaded at the chat's last load", () => {
  test("a chat that loaded these exact files gets a pointer; an edit sends the text until the next load", async () => {
    const proj = await projectFor("claude");
    const sid = randomUUID();
    const env = { AIDLC_SESSION_OVERRIDE: sid, CLAUDE_CODE_SESSION_ID: sid, CLAUDECODE: "1" };
    await sessionStart(proj, "claude", sid, "startup");
    // The chat's first step hands it the text once.
    expect(sentInFull(await next(proj, "claude", env))).toBe(true);
    const first = await next(proj, "claude", env);
    expect(pointerOnly(first), JSON.stringify(first.final).slice(0, 400)).toBe(true);
    expect(first.final.rules_in_context?.length).toBeGreaterThan(0);
    expect(first.bytes).toBeLessThan(8_000);

    editTeam(proj, "Every API change carries a contract test.");
    const edited = await next(proj, "claude", env);
    expect(sentInFull(edited)).toBe(true);
    expect(JSON.stringify(edited.results)).toContain("Every API change carries a contract test.");
    // Still the text while the chat holds only the older copy.
    expect(sentInFull(await next(proj, "claude", env))).toBe(true);

    // A compaction reloads the files from disk: the pointer again.
    await sessionStart(proj, "claude", sid, "compact");
    expect(pointerOnly(await next(proj, "claude", env))).toBe(true);
    // So does /clear, under its new chat id, after that chat's first step.
    const cleared = randomUUID();
    const clearedEnv = { AIDLC_SESSION_OVERRIDE: cleared, CLAUDE_CODE_SESSION_ID: cleared, CLAUDECODE: "1" };
    await sessionStart(proj, "claude", cleared, "clear");
    expect(sentInFull(await next(proj, "claude", clearedEnv))).toBe(true);
    expect(pointerOnly(await next(proj, "claude", clearedEnv))).toBe(true);
  });

  test("a resume or a fork after an edit, a different chat, or no session start: the text", async () => {
    const proj = await projectFor("claude");
    const sid = randomUUID();
    const env = { AIDLC_SESSION_OVERRIDE: sid, CLAUDE_CODE_SESSION_ID: sid, CLAUDECODE: "1" };
    await sessionStart(proj, "claude", sid, "startup");
    expect(sentInFull(await next(proj, "claude", env))).toBe(true);
    expect(pointerOnly(await next(proj, "claude", env))).toBe(true);
    // A resume with the files unchanged keeps the pointer.
    await sessionStart(proj, "claude", sid, "resume");
    expect(pointerOnly(await next(proj, "claude", env))).toBe(true);

    editTeam(proj, "Release notes name every migration.");
    await sessionStart(proj, "claude", sid, "resume");
    // The resumed chat holds the old copy beside the new one.
    expect(sentInFull(await next(proj, "claude", env))).toBe(true);

    const forked = randomUUID();
    await sessionStart(proj, "claude", forked, "fork");
    expect(sentInFull(await next(proj, "claude", {
      AIDLC_SESSION_OVERRIDE: forked, CLAUDE_CODE_SESSION_ID: forked, CLAUDECODE: "1",
    }))).toBe(true);

    // The command runs in another chat than the one recorded.
    const other = randomUUID();
    await sessionStart(proj, "claude", other, "startup");
    expect(sentInFull(await next(proj, "claude", {
      AIDLC_SESSION_OVERRIDE: other, CLAUDE_CODE_SESSION_ID: randomUUID(), CLAUDECODE: "1",
    }))).toBe(true);
    // No session start recorded for this chat at all.
    const unseen = randomUUID();
    expect(sentInFull(await next(proj, "claude", {
      AIDLC_SESSION_OVERRIDE: unseen, CLAUDE_CODE_SESSION_ID: unseen, CLAUDECODE: "1",
    }))).toBe(true);
  });

  test("an import that does not name a rule file of the stage: the text", async () => {
    const proj = await projectFor("claude");
    editTeam(proj, "Pair on every schema change.");
    const stub = join(proj, ".claude", "rules", "aidlc.md");
    writeFileSync(stub, readFileSync(stub, "utf-8").replace(/^@.*\/memory\/team\.md\n/m, ""));
    const sid = randomUUID();
    await sessionStart(proj, "claude", sid, "startup");
    expect(sentInFull(await next(proj, "claude", {
      AIDLC_SESSION_OVERRIDE: sid, CLAUDE_CODE_SESSION_ID: sid, CLAUDECODE: "1",
    }))).toBe(true);
  });
});

describe("Kiro CLI and opencode: the host sends the memory files with every request", () => {
  test("Kiro CLI: the pointer inside the chat, even after an edit; the text outside it or on an upgraded agent", async () => {
    const proj = await projectFor("kiro");
    const sid = randomUUID();
    const env = { AIDLC_SESSION_OVERRIDE: sid, KIRO_SESSION_ID: sid };
    await sessionStart(proj, "kiro", sid, "startup");
    expect(sentInFull(await next(proj, "kiro", env))).toBe(true);
    expect(pointerOnly(await next(proj, "kiro", env))).toBe(true);
    // Kiro holds the edited file at once, but the step after a change hands the
    // text once, so the change is in front of the agent; then the pointer again.
    editTeam(proj, "Every queue has a dead-letter alarm.");
    const changed = await next(proj, "kiro", env);
    expect(sentInFull(changed)).toBe(true);
    expect(JSON.stringify(changed.results)).toContain("Every queue has a dead-letter alarm.");
    expect(pointerOnly(await next(proj, "kiro", env))).toBe(true);
    // A chat resumed after the rules changed while it was closed: the text once.
    editTeam(proj, "Every alarm names its runbook.");
    await sessionStart(proj, "kiro", sid, "startup");
    expect(sentInFull(await next(proj, "kiro", env))).toBe(true);
    expect(pointerOnly(await next(proj, "kiro", env))).toBe(true);

    expect(sentInFull(await next(proj, "kiro", { AIDLC_SESSION_OVERRIDE: sid }))).toBe(true);

    // An agent file rewritten to the 3.0 format: what that engine loads is not proven.
    const agentPath = join(proj, ".kiro", "agents", "aidlc.json");
    const agent = JSON.parse(readFileSync(agentPath, "utf-8")) as Record<string, unknown>;
    writeFileSync(agentPath, JSON.stringify({ ...agent, hooks: [] }, null, 2));
    const upgraded = randomUUID();
    await sessionStart(proj, "kiro", upgraded, "startup");
    expect(sentInFull(await next(proj, "kiro", { AIDLC_SESSION_OVERRIDE: upgraded, KIRO_SESSION_ID: upgraded }))).toBe(true);
  });

  test("opencode: the pointer under opencode; the text outside it or without the memory instructions", async () => {
    const proj = await projectFor("opencode");
    const sid = randomUUID();
    await sessionStart(proj, "opencode", sid, "startup");
    expect(sentInFull(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: sid, OPENCODE: "1" }))).toBe(true);
    expect(pointerOnly(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: sid, OPENCODE: "1" }))).toBe(true);
    editTeam(proj, "Every endpoint has an owner.");
    expect(sentInFull(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: sid, OPENCODE: "1" }))).toBe(true);
    expect(pointerOnly(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: sid, OPENCODE: "1" }))).toBe(true);
    expect(sentInFull(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: sid }))).toBe(true);

    const config = join(proj, "opencode.json");
    const parsed = JSON.parse(readFileSync(config, "utf-8")) as { instructions: string[] };
    writeFileSync(config, JSON.stringify({ ...parsed, instructions: parsed.instructions.filter((entry) => !entry.includes("/memory/")) }));
    const fresh = randomUUID();
    await sessionStart(proj, "opencode", fresh, "startup");
    expect(sentInFull(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: fresh, OPENCODE: "1" }))).toBe(true);
  });

  // A team that keeps opencode.jsonc writes comments and trailing commas in
  // it; the include proof reads that file as jsonc, so the pointer still
  // replaces the text once the chat holds it.
  test("opencode: a commented opencode.jsonc with the memory instructions still proves the include", async () => {
    const proj = await projectFor("opencode");
    const config = join(proj, "opencode.json");
    const body = JSON.stringify(JSON.parse(readFileSync(config, "utf-8")), null, 2).slice(1, -1).trimEnd();
    rmSync(config);
    writeFileSync(join(proj, "opencode.jsonc"), `{\n  // The team keeps its config as jsonc, with a trailing comma.${body},\n}\n`);
    const sid = randomUUID();
    await sessionStart(proj, "opencode", sid, "startup");
    expect(sentInFull(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: sid, OPENCODE: "1" }))).toBe(true);
    expect(pointerOnly(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: sid, OPENCODE: "1" }))).toBe(true);
  });
});

describe("Codex: this thread was given the bundle and nothing since could have dropped it", () => {
  test("the text once, then the pointer; a compaction, a resume or a compacted rollout sends it again", async () => {
    const proj = await projectFor("codex");
    const sid = randomUUID();
    const rollout = { path: join(proj, "rollout.jsonl") };
    writeFileSync(rollout.path, `${JSON.stringify({ timestamp: new Date(Date.now() - 60_000).toISOString(), type: "session_meta", payload: { id: sid } })}\n`);
    const env = { AIDLC_SESSION_OVERRIDE: sid, CODEX_THREAD_ID: sid, CODEX_SESSION_ID: sid };
    await sessionStart(proj, "codex", sid, "startup", { TRANSCRIPT: rollout.path });
    const first = await next(proj, "codex", env, rollout);
    expect(sentInFull(first)).toBe(true);
    const second = await next(proj, "codex", env, rollout);
    expect(pointerOnly(second)).toBe(true);
    expect(second.bytes).toBeLessThan(first.bytes);

    // The Stop hook's own consultation runs in a hook with no Codex variable:
    // the payload names the chat, so it answers what the agent was answered.
    const probe = { AIDLC_SESSION_OVERRIDE: sid, AIDLC_STOP_HOOK_PROBE: "1" };
    expect(pointerOnly(await next(proj, "codex", probe))).toBe(true);

    await preCompact(proj, "codex", sid);
    recordCompaction(rollout, new Date());
    // A consultation never counts as handing the text over.
    expect(sentInFull(await next(proj, "codex", probe))).toBe(true);
    expect(sentInFull(await next(proj, "codex", env, rollout))).toBe(true);
    expect(pointerOnly(await next(proj, "codex", env, rollout))).toBe(true);
    // A compaction no hook reported, seen in the thread's own rollout.
    recordCompaction(rollout, new Date(Date.now() + 1_000));
    expect(sentInFull(await next(proj, "codex", env, rollout))).toBe(true);

    await sessionStart(proj, "codex", sid, "resume", { TRANSCRIPT: rollout.path });
    expect(sentInFull(await next(proj, "codex", env, rollout))).toBe(true);
    // Another thread's command never uses this thread's record.
    expect(sentInFull(await next(proj, "codex", { AIDLC_SESSION_OVERRIDE: sid, CODEX_THREAD_ID: randomUUID() }))).toBe(true);
  });

  test("rules Codex cut short (inline or in parts) are sent again until a whole copy is in the rollout", async () => {
    for (const grown of [false, true]) {
      const proj = await projectFor("codex");
      // A grown team.md sends the rules in parts before the run-stage.
      if (grown) editTeam(proj, Array.from({ length: 40 }, (_, index) => `Team practice ${index}: ${"x".repeat(900)}`).join("\n- "));
      const sid = randomUUID();
      const rollout: Rollout = { path: join(proj, "rollout.jsonl") };
      writeFileSync(rollout.path, "");
      const env = { AIDLC_SESSION_OVERRIDE: sid, CODEX_THREAD_ID: sid, CODEX_SESSION_ID: sid };
      await sessionStart(proj, "codex", sid, "startup", { TRANSCRIPT: rollout.path });
      // The model asked for a small output budget: Codex kept each rule's ends.
      const cut = await next(proj, "codex", env, { ...rollout, cut: true });
      expect(sentInFull(cut)).toBe(true);
      // The thread holds only part of the text: all of it again, and again.
      const again = await next(proj, "codex", env, { ...rollout, cut: true });
      expect(sentInFull(again)).toBe(true);
      // The chat's first step also carried the conductor persona, so the rules
      // travelled in parts beside it whatever their size. From the second step
      // on, the shape is the rules' own: inline while they fit, in parts once
      // the team's memory grows.
      expect(again.results.length > 1, `parts when grown=${grown}`).toBe(grown);
      expect(sentInFull(await next(proj, "codex", env, rollout))).toBe(true);
      // A whole copy is in the rollout now.
      expect(pointerOnly(await next(proj, "codex", env, rollout))).toBe(true);
    }
  });
});

// Kiro IDE's hooks, as the host runs them: a prompt (UserPromptSubmit, which
// starts a chat that has not started) and the end of a turn (Stop).
async function kiroIdeHook(proj: string, target: string, payload: Record<string, unknown>): Promise<string> {
  return await run(
    proj,
    [process.execPath, join(proj, ".kiro", "tools", "aidlc.ts"), "engine", "adapter", "kiro-ide", target],
    {},
    JSON.stringify({ cwd: proj, ...payload }),
  );
}

function kiroIdePrompt(proj: string, sessionId: string): Promise<string> {
  return kiroIdeHook(proj, "record-human-turn", { hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "carry on" });
}

function kiroIdeStop(proj: string, sessionId: string): Promise<string> {
  return kiroIdeHook(proj, "continue-workflow", { hook_event_name: "Stop", session_id: sessionId });
}

const kiroChat = (): string => `sess_${randomUUID()}`;
// The chat runs `next` in a shell with no chat id (Kiro IDE).
const inKiroIde = (sid: string): Record<string, string> => ({ AIDLC_SESSION_OVERRIDE: sid });
const STEERING = [".kiro", "steering", "aidlc-active-memory.md"];

// A copy whose first chat ran a turn: its session start wrote the memory text
// into the steering file (that chat had captured the shipped reference form).
async function kiroIdeProject(): Promise<string> {
  const proj = copiedProject("kiro-ide");
  const first = kiroChat();
  await kiroIdePrompt(proj, first);
  expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(first)))).toBe(true);
  await kiroIdeStop(proj, first);
  return proj;
}

describe("Kiro IDE: the chat holds the steering file it captured when it started", () => {
  test("the memory text goes into the gitignored steering file; a chat that started with it gets the pointer, an edit the text", async () => {
    const proj = await kiroIdeProject();
    const steering = readFileSync(join(proj, ...STEERING), "utf-8");
    expect(steering).toMatch(/^---\ninclusion: always\n---\n/);
    expect(steering).toContain('<memory-file path="aidlc/spaces/default/memory/org.md">');
    expect(steering).toContain(readFileSync(memoryFile(proj, "org.md"), "utf-8"));
    expect(steering).toContain("Do not edit it");
    expect(readFileSync(join(REPO_ROOT, "dist", "kiro-ide", ".gitignore"), "utf-8"))
      .toContain("\n.kiro/steering/aidlc-active-memory.md\n");

    const sid = kiroChat();
    await kiroIdePrompt(proj, sid);
    // The chat's first step hands it the text once (live, an agent in a new
    // chat once ignored a team rule its steering held on a pointer step).
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(sid)))).toBe(true);
    const held = await next(proj, "kiro-ide", inKiroIde(sid));
    expect(pointerOnly(held), JSON.stringify(held.final).slice(0, 400)).toBe(true);
    expect(held.bytes).toBeLessThan(8_000);
    expect(pointerOnly(await next(proj, "kiro-ide", inKiroIde(sid)))).toBe(true);

    // The chat keeps the copy it started with: after an edit, the text every step.
    editTeam(proj, "Every queue has a dead-letter alarm.");
    const edited = await next(proj, "kiro-ide", inKiroIde(sid));
    expect(sentInFull(edited)).toBe(true);
    expect(JSON.stringify(edited.results)).toContain("Every queue has a dead-letter alarm.");
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(sid)))).toBe(true);
    await kiroIdeStop(proj, sid);

    // That step wrote the new text into the file, so a chat that starts now holds it.
    expect(readFileSync(join(proj, ...STEERING), "utf-8")).toContain("Every queue has a dead-letter alarm.");
    const later = kiroChat();
    await kiroIdePrompt(proj, later);
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(later)))).toBe(true);
    expect(pointerOnly(await next(proj, "kiro-ide", inKiroIde(later)))).toBe(true);
    await kiroIdeStop(proj, later);

    // Going back to the older chat starts nothing new for it: still the text.
    await kiroIdePrompt(proj, sid);
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(sid)))).toBe(true);
  });

  test("two chats at once: the text unless every chat with an open turn holds the same file", async () => {
    const proj = await kiroIdeProject();
    const a = kiroChat();
    await kiroIdePrompt(proj, a);
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(a)))).toBe(true);
    expect(pointerOnly(await next(proj, "kiro-ide", inKiroIde(a)))).toBe(true);
    // B starts while A's turn runs: both hold the same file, so either is fine.
    const b = kiroChat();
    await kiroIdePrompt(proj, b);
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(b)))).toBe(true);
    expect(pointerOnly(await next(proj, "kiro-ide", inKiroIde(b)))).toBe(true);

    // The memory changes and C starts with the new text while A, holding the
    // old one, still has its turn open: a command placed in C may be A's.
    editTeam(proj, "Every alarm names its runbook.");
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(b)))).toBe(true);
    await kiroIdeStop(proj, b);
    const c = kiroChat();
    await kiroIdePrompt(proj, c);
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(c)))).toBe(true);
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(c)))).toBe(true);
    // A's turn ends: C alone runs, and C holds the file.
    await kiroIdeStop(proj, a);
    expect(pointerOnly(await next(proj, "kiro-ide", inKiroIde(c)))).toBe(true);
    // A command from a chat with no open turn: the text.
    await kiroIdeStop(proj, c);
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(c)))).toBe(true);
  });

  test("Kiro CLI v3 on the same files: the chat its shell names", async () => {
    const proj = await kiroIdeProject();
    const sid = kiroChat();
    await kiroIdePrompt(proj, sid);
    expect(sentInFull(await next(proj, "kiro-ide", { ...inKiroIde(sid), KIRO_SESSION_ID: sid }))).toBe(true);
    expect(pointerOnly(await next(proj, "kiro-ide", { ...inKiroIde(sid), KIRO_SESSION_ID: sid }))).toBe(true);
    expect(sentInFull(await next(proj, "kiro-ide", { ...inKiroIde(sid), KIRO_SESSION_ID: kiroChat() }))).toBe(true);
  });

  test("a fresh clone without the file, or a memory too large to put in every chat: the text", async () => {
    const proj = await kiroIdeProject();
    // The file is gitignored, so a fresh clone has none: its first chat captured nothing.
    rmSync(join(proj, ...STEERING));
    const clone = kiroChat();
    await kiroIdePrompt(proj, clone);
    expect(existsSync(join(proj, ...STEERING))).toBe(true);
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(clone)))).toBe(true);
    await kiroIdeStop(proj, clone);
    const second = kiroChat();
    await kiroIdePrompt(proj, second);
    expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(second)))).toBe(true);
    expect(pointerOnly(await next(proj, "kiro-ide", inKiroIde(second)))).toBe(true);
    await kiroIdeStop(proj, second);

    editTeam(proj, Array.from({ length: 80 }, (_, index) => `Team practice ${index}: ${"x".repeat(900)}`).join("\n- "));
    for (const big of [kiroChat(), kiroChat()]) {
      await kiroIdePrompt(proj, big);
      expect(readFileSync(join(proj, ...STEERING), "utf-8")).toContain("#[[file:aidlc/spaces/default/memory/team.md]]");
      expect(sentInFull(await next(proj, "kiro-ide", inKiroIde(big)))).toBe(true);
      await kiroIdeStop(proj, big);
    }
  });

  test("a repo that still tracks the steering file is asked once whether to stop tracking it", async () => {
    // An earlier release shipped the file, and the team committed it.
    const proj = copiedProject("kiro-ide");
    const git = (...args: string[]) => spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
    expect(git("init", "-q").status).toBe(0);
    expect(git("add", "--", ".kiro/steering/aidlc-active-memory.md").status).toBe(0);
    const asked = await kiroIdePrompt(proj, kiroChat());
    expect(asked).toContain("Your repo tracks .kiro/steering/aidlc-active-memory.md, which AI-DLC now rebuilds for each chat.");
    expect(asked).toContain("Do you want me to stop tracking it? Your memory files stay as they are.");
    expect(asked).toContain("git rm --cached -- .kiro/steering/aidlc-active-memory.md");
    expect(await kiroIdePrompt(proj, kiroChat())).not.toContain("Your repo tracks");
  });

  test("config writes the project's memory text into the file and refreshes over the engine's copy", () => {
    const release = join(REPO_ROOT, "dist-release", "kiro-ide");
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-t-rules-kiro-ide-"));
    projects.push(dir);
    mkdirSync(join(dir, ".git"));
    const machine = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-t-rules-machine-"));
    projects.push(machine);
    const config = () => spawnSync(process.execPath, [
      join(REPO_ROOT, "core", "tools", "aidlc-init.ts"),
      "config", "--project-dir", dir, "--from", release, "--harness", "kiro-ide", "--mcp", "none", "--yes",
    ], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...childEnv({}), AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"), AIDLC_BIN_DIR: join(machine, "bin") },
    });
    const first = config();
    expect(first.status, `${first.stdout}${first.stderr}`).toBe(0);
    const steering = join(dir, ...STEERING);
    expect(readFileSync(steering, "utf-8")).toContain('<memory-file path="aidlc/spaces/default/memory/team.md">');
    // The engine writes the file again after an edit; the next refresh neither
    // refuses it as a local change nor puts the reference form back.
    editTeam(dir, "Every schema change has a migration test.");
    writeFileSync(steering, `${readFileSync(steering, "utf-8")}\n`);
    const refreshed = config();
    expect(refreshed.status, `${refreshed.stdout}${refreshed.stderr}`).toBe(0);
    expect(readFileSync(steering, "utf-8")).toContain("Every schema change has a migration test.");
    const manifest = JSON.parse(readFileSync(join(dir, ".kiro", "tools", "data", "aidlc-manifest.json"), "utf-8")) as {
      files?: Record<string, string>;
    };
    expect(Object.keys(manifest.files ?? {})).not.toContain(".kiro/steering/aidlc-active-memory.md");
  });
});

describe("tools with no proven copy keep sending the text", () => {
  for (const harness of ["cursor", "copilot"]) {
    test(harness, async () => {
      const proj = await projectFor(harness);
      const sid = randomUUID();
      const env = {
        AIDLC_SESSION_OVERRIDE: sid, KIRO_SESSION_ID: sid, OPENCODE: "1", CLAUDE_CODE_SESSION_ID: sid, CLAUDECODE: "1",
      };
      await sessionStart(proj, harness, sid, "startup");
      expect(sentInFull(await next(proj, harness, env))).toBe(true);
      expect(sentInFull(await next(proj, harness, env))).toBe(true);
    });
  }
});

// The conductor persona (aidlc-common/conductor.md, 10.6 KB: how every agent
// writes files and runs AI-DLC's commands, the diary rules, the voice rules)
// used to ride the FIRST run-stage of the WORKFLOW only, so a person who
// carried on in a new chat, or whose chat compacted, had an agent working
// without it for the rest of the run. It now rides the first run-stage each
// CHAT sees, on the hosts whose commands name their chat; Copilot and Cursor
// keep one delivery per workflow, because there the persona travels on its own
// part and every extra delivery is one more tool call the person sees.
function personaSent(delivery: { results: Printed[] }): boolean {
  return delivery.results.some((directive) =>
    typeof directive.conductor_persona === "string" && directive.conductor_persona.length > 0
  );
}

function editPersona(proj: string, harness: string, line: string): void {
  const path = join(proj, HARNESS_DIR[harness], "aidlc-common", "conductor.md");
  appendFileSync(path, `\n${line}\n`);
}

describe("the conductor persona reaches every chat that works on the workflow", () => {
  test("Claude Code: the chat's first step carries it, the next does not, a compaction brings it back", async () => {
    const proj = await projectFor("claude");
    const sid = randomUUID();
    const env = { AIDLC_SESSION_OVERRIDE: sid, CLAUDE_CODE_SESSION_ID: sid, CLAUDECODE: "1" };
    await sessionStart(proj, "claude", sid, "startup");
    // Mid-workflow (the fixture has finished stages behind it), so the old rule
    // sent nothing here.
    expect(personaSent(await next(proj, "claude", env))).toBe(true);
    expect(personaSent(await next(proj, "claude", env))).toBe(false);

    // The compacted chat no longer holds it.
    await preCompact(proj, "claude", sid);
    await sessionStart(proj, "claude", sid, "compact");
    expect(personaSent(await next(proj, "claude", env))).toBe(true);
    expect(personaSent(await next(proj, "claude", env))).toBe(false);

    // Another chat on the same piece of work gets its own copy, once.
    const second = randomUUID();
    const secondEnv = { AIDLC_SESSION_OVERRIDE: second, CLAUDE_CODE_SESSION_ID: second, CLAUDECODE: "1" };
    await sessionStart(proj, "claude", second, "startup");
    expect(personaSent(await next(proj, "claude", secondEnv))).toBe(true);
    expect(personaSent(await next(proj, "claude", secondEnv))).toBe(false);

    // An updated install's persona reaches a chat that already had the old one.
    editPersona(proj, "claude", "- Say the step, never the machinery.");
    const updated = await next(proj, "claude", env);
    expect(personaSent(updated)).toBe(true);
    expect(JSON.stringify(updated.results)).toContain("Say the step, never the machinery.");
    expect(personaSent(await next(proj, "claude", env))).toBe(false);
  });

  test("Kiro CLI and Codex: the same, under their own chat ids", async () => {
    for (const harness of ["kiro", "codex"]) {
      const proj = await projectFor(harness);
      const sid = harness === "kiro" ? `sess_${randomUUID()}` : randomUUID();
      const env = harness === "kiro"
        ? { AIDLC_SESSION_OVERRIDE: sid, KIRO_SESSION_ID: sid }
        : { AIDLC_SESSION_OVERRIDE: sid, CODEX_THREAD_ID: sid };
      await sessionStart(proj, harness, sid, "startup");
      expect(personaSent(await next(proj, harness, env)), harness).toBe(true);
      expect(personaSent(await next(proj, harness, env)), harness).toBe(false);
    }
  });

  test("Copilot and Cursor keep one delivery per workflow (no chat signal in the command)", async () => {
    for (const harness of ["copilot", "cursor"]) {
      const proj = await projectFor(harness);
      const sid = randomUUID();
      const env = { AIDLC_SESSION_OVERRIDE: sid, CLAUDE_CODE_SESSION_ID: sid, CLAUDECODE: "1" };
      await sessionStart(proj, harness, sid, "startup");
      // Mid-workflow and no proven chat: unchanged, so nothing new arrives.
      expect(personaSent(await next(proj, harness, env)), harness).toBe(false);
      expect(personaSent(await next(proj, harness, env)), harness).toBe(false);
    }
  });
});
