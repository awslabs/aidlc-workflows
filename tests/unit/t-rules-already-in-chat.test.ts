// covers: function:chatHoldsRules, function:recordRulesLoad, function:noteRulesDelivered, function:clearRulesDelivered, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:continue
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
//   - Claude Code loads them at startup, resume, clear, compact and fork, but
//     not after a mid-chat edit, so the pointer needs the hashes the session
//     start recorded for this chat to match the files now. A resume or fork
//     after an edit may leave older copies in the chat: full text.
//   - Codex has no include: the pointer needs this thread to have been given
//     the bundle, with no session start or compaction since, and no compaction
//     in its rollout after it.
//   - Kiro IDE, Cursor and Copilot, and every missing signal: full text.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
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
  receipt?: string;
  rules_content?: Array<{ path: string; text: string }>;
  rules_held?: string;
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
async function next(
  proj: string,
  harness: string,
  env: Record<string, string>,
): Promise<{ results: Printed[]; bytes: number; final: Printed }> {
  const engine = join(proj, HARNESS_DIR[harness], "tools", "aidlc-orchestrate.ts");
  const results: Printed[] = [];
  let bytes = 0;
  let args = ["next"];
  for (let hop = 0; hop < 10; hop++) {
    const stdout = await run(proj, [process.execPath, engine, ...args], env);
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

function pointerOnly(delivery: { results: Printed[]; final: Printed }): boolean {
  return delivery.results.length === 1 &&
    delivery.final.kind === "run-stage" &&
    typeof delivery.final.rules_held === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(delivery.final.rules_held) &&
    delivery.final.rules_content === undefined;
}

describe("Claude Code: the memory the host loaded at the chat's last load", () => {
  test("a chat that loaded these exact files gets a pointer; an edit sends the text until the next load", async () => {
    const proj = await projectFor("claude");
    const sid = randomUUID();
    const env = { AIDLC_SESSION_OVERRIDE: sid, CLAUDE_CODE_SESSION_ID: sid, CLAUDECODE: "1" };
    await sessionStart(proj, "claude", sid, "startup");
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
    // So does /clear, under its new chat id.
    const cleared = randomUUID();
    await sessionStart(proj, "claude", cleared, "clear");
    expect(pointerOnly(await next(proj, "claude", {
      AIDLC_SESSION_OVERRIDE: cleared, CLAUDE_CODE_SESSION_ID: cleared, CLAUDECODE: "1",
    }))).toBe(true);
  });

  test("a resume or a fork after an edit, a different chat, or no session start: the text", async () => {
    const proj = await projectFor("claude");
    const sid = randomUUID();
    const env = { AIDLC_SESSION_OVERRIDE: sid, CLAUDE_CODE_SESSION_ID: sid, CLAUDECODE: "1" };
    await sessionStart(proj, "claude", sid, "startup");
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
    expect(pointerOnly(await next(proj, "kiro", env))).toBe(true);
    editTeam(proj, "Every queue has a dead-letter alarm.");
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
    expect(pointerOnly(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: sid, OPENCODE: "1" }))).toBe(true);
    expect(sentInFull(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: sid }))).toBe(true);

    const config = join(proj, "opencode.json");
    const parsed = JSON.parse(readFileSync(config, "utf-8")) as { instructions: string[] };
    writeFileSync(config, JSON.stringify({ ...parsed, instructions: parsed.instructions.filter((entry) => !entry.includes("/memory/")) }));
    const fresh = randomUUID();
    await sessionStart(proj, "opencode", fresh, "startup");
    expect(sentInFull(await next(proj, "opencode", { AIDLC_SESSION_OVERRIDE: fresh, OPENCODE: "1" }))).toBe(true);
  });
});

describe("Codex: this thread was given the bundle and nothing since could have dropped it", () => {
  test("the text once, then the pointer; a compaction, a resume or a compacted rollout sends it again", async () => {
    const proj = await projectFor("codex");
    const sid = randomUUID();
    const rollout = join(proj, "rollout.jsonl");
    writeFileSync(rollout, `${JSON.stringify({ timestamp: new Date(Date.now() - 60_000).toISOString(), type: "session_meta", payload: { id: sid } })}\n`);
    const env = { AIDLC_SESSION_OVERRIDE: sid, CODEX_THREAD_ID: sid, CODEX_SESSION_ID: sid };
    await sessionStart(proj, "codex", sid, "startup", { TRANSCRIPT: rollout });
    const first = await next(proj, "codex", env);
    expect(sentInFull(first)).toBe(true);
    const second = await next(proj, "codex", env);
    expect(pointerOnly(second)).toBe(true);
    expect(second.bytes).toBeLessThan(first.bytes);

    // The Stop hook's own consultation runs in a hook with no Codex variable:
    // the payload names the chat, so it answers what the agent was answered.
    const probe = { AIDLC_SESSION_OVERRIDE: sid, AIDLC_STOP_HOOK_PROBE: "1" };
    expect(pointerOnly(await next(proj, "codex", probe))).toBe(true);

    await preCompact(proj, "codex", sid);
    // A consultation never counts as handing the text over.
    expect(sentInFull(await next(proj, "codex", probe))).toBe(true);
    expect(sentInFull(await next(proj, "codex", env))).toBe(true);
    expect(pointerOnly(await next(proj, "codex", env))).toBe(true);

    // A compaction no hook reported, seen in the thread's own rollout.
    appendFileSync(rollout, `${JSON.stringify({ timestamp: new Date(Date.now() + 1_000).toISOString(), type: "compacted", payload: { message: "" } })}\n`);
    expect(sentInFull(await next(proj, "codex", env))).toBe(true);

    await sessionStart(proj, "codex", sid, "resume", { TRANSCRIPT: rollout });
    expect(sentInFull(await next(proj, "codex", env))).toBe(true);
    // Another thread's command never uses this thread's record.
    expect(sentInFull(await next(proj, "codex", { AIDLC_SESSION_OVERRIDE: sid, CODEX_THREAD_ID: randomUUID() }))).toBe(true);
  });
});

describe("tools with no proven copy keep sending the text", () => {
  for (const harness of ["kiro-ide", "cursor", "copilot"]) {
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
