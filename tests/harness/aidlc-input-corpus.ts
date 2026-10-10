// The /aidlc input corpus (tests/fixtures/aidlc-input/corpus.json) and the fixture mechanics its two checks share:
// the workspace states, the person's turn through each host's own human-turn hook, `next` as the agent runs it,
// and the message record the hook writes. The unit check (tests/unit/t-aidlc-input-corpus.test.ts) runs the
// engine's first step for every item; the live check (tests/e2e/t-live-aidlc-input-corpus.serial.test.ts) drives a
// sample through real agents.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import corpus from "../fixtures/aidlc-input/corpus.json";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";
import { AIDLC_SRC, FIXTURES_DIR, REPO_ROOT, createOrchestrationTestProject, intentsDirOf, recordArtifactWriteViaHook, seededRecordDir, seededStateFile } from "./fixtures.ts";
import { testGuardEnvironment } from "./runner-profile.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { splitKiroCommandArgs, writeSessionBinding, writeSessionPidEntry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

/**
 * Where the person is when they type the line:
 * fresh: no workflow yet. work-open: a bugfix mid-Inception. plan-question-open: a code plan awaiting approval.
 * gate-open: a stage gate awaiting approval (review READY, summary confirmed, so an approval goes through).
 * two-similar-records: auth and auth-fix, the second active. plan-offer-open: a fresh workspace where they typed
 * "build a notes app" and the plan offer is on screen. routing-question-open: open work where they typed "fix the
 * login" and the routing question is on screen. stage-question-asked: the agent asked a stage question in chat.
 * parked: the open work parked. finished: all stages done. archived: the selected record archived.
 * second-chat: open work, typed from a chat that has not joined it. kiro-pick: two records, none selected in this
 * chat, the pick question on screen. hooks-off: the host's hooks never ran (the hook is not driven).
 * unattended: AIDLC_UNATTENDED=1 on the hook and the engine.
 */
export type State =
  | "fresh" | "work-open" | "plan-question-open" | "gate-open" | "two-similar-records"
  | "plan-offer-open" | "routing-question-open" | "stage-question-asked" | "parked" | "finished" | "archived"
  | "second-chat" | "kiro-pick" | "hooks-off" | "unattended";
export type Harness = "claude" | "codex" | "kiro" | "kiro-ide";
export type ArgvVariant = "posix" | "kiro-cli" | "kiro-ide-pwsh";

export interface EngineExpectation {
  /** Directive kinds the first step may return (`print`, `ask`, `error`, `run-stage`, `done`). */
  kinds: string[];
  /** Strings the directive must carry word for word: the command it names, the flags, the record, the words. */
  names?: string[];
  /** The message record's `words` (null for a line with no words of the person's). */
  words?: string | null;
  /** The message record's `settings`, as the config setter names them. */
  settings?: Array<[string, string]>;
  /** No `ask`: no question of the engine's reaches the person at this step (a plain-words status line may). */
  no_ask?: boolean;
  /** Strings that must not appear: a wrong record name, a scope the person did not say. */
  never?: string[];
}

/** What is true on disk, and what the person saw, after a real agent acted on the line (the live check). */
export interface EndExpectation {
  /** `none`: no new record; `same`: the open record untouched and no new one; an object: a new record exists. */
  work?: "none" | "same" | { scope?: string; words?: string };
  /** The active record's label after the run. */
  active?: string;
  /** Fields of the active work's state file, as `[field, value it must contain]`. */
  set?: Array<[string, string]>;
  gate?: "approved" | "rejected" | "open";
  plan?: "approved" | "changes" | "open";
  /** Questions to the person allowed (Claude Code only); defaults to 1 when `ambiguous`, else 0 when `no_ask`. */
  asks?: number;
}

export interface CorpusItem {
  id: string;
  category: string;
  /** What reaches `next` after the entry word. */
  input: string;
  /** What the person typed when it differs from `input` (the agent slipped a flag into `next`). */
  typed?: string;
  /** The entry word when not `/aidlc`: `$aidlc` on Codex, `""` for plain chat (nothing of the line reaches `next`). */
  entry?: string;
  argv?: Partial<Record<ArgvVariant, string[]>>;
  state: State;
  meaning: string;
  expected: { engine: EngineExpectation; end?: EndExpectation };
  ambiguous?: boolean;
  source?: string;
  documented?: string;
  after?: string;
  unsure?: boolean;
}

export const CORPUS = corpus as CorpusItem[];
export const HARNESSES: Harness[] = ["claude", "codex", "kiro", "kiro-ide"];
export const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
export const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
export const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
export const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
export const SESSION = "01995000-7a11-7000-8000-00000000d001";
/** A second chat in the same project that never joined the open work. */
export const SECOND_SESSION = "01995000-7a11-7000-8000-00000000d002";
const REVIEWER = "aidlc-product-lead-agent";

// The source each `after` waits for, read where the change lands. `pending` and `chat-identity` wait for a work order
// nobody has yet (an owner to be named; the chat-identity tab's plan).
const coreTool = (name: string) => readFileSync(join(REPO_ROOT, "core", "tools", name), "utf-8");
export const LANDED: Record<string, () => boolean> = {
  "#2276": () => !coreTool("aidlc-command.ts").includes("DISPATCHER_RESERVED_FUTURE"),
  WO2: () => !coreTool("aidlc-orchestrate.ts").includes("unreadSettingOnly"),
  WO3: () => !coreTool("aidlc-lib.ts").includes("parseTypedGuardSwitchRequest"),
  WO5: () => !coreTool("aidlc-lib.ts").includes("CONTINUATION_PHRASES"),
  WO6: () => !coreTool("aidlc-orchestrate.ts").includes("This looks like"),
  pending: () => false,
  "chat-identity": () => false,
};
const landed = new Map<string, boolean>();
/** The change an item still waits for, or null when its EXPECTED holds on this source. */
export function waitsFor(item: CorpusItem): string | null {
  if (item.after === undefined) return null;
  const check = LANDED[item.after];
  if (check === undefined) throw new Error(`${item.id}: unknown after "${item.after}" (add it to LANDED)`);
  if (!landed.has(item.after)) landed.set(item.after, check());
  return landed.get(item.after) ? null : item.after;
}

/** The chat the item is typed from, and whether the host's hook runs before the engine. */
export const sessionOf = (item: CorpusItem): string => (item.state === "second-chat" ? SECOND_SESSION : SESSION);
export const hookRuns = (item: CorpusItem): boolean => item.state !== "hooks-off";
export const itemEnv = (item: CorpusItem): Record<string, string> => (item.state === "unattended" ? { AIDLC_UNATTENDED: "1" } : {});

// The person's line as the host delivers it: `/aidlc <typed>`, `$aidlc <typed>` on Codex, or the bare words in
// plain chat (`entry: ""`), where nothing of the line reaches `next` and the agent runs it bare.
export function typedPrompt(item: CorpusItem): string {
  const typed = item.typed ?? item.input;
  return `${item.entry ?? "/aidlc"}${typed ? ` ${typed}` : ""}`.trim();
}

/** The argv `next` gets, per way a host hands the line over (a POSIX shell's split unless the item says otherwise). */
export function argvVariants(item: CorpusItem): Array<[ArgvVariant, string[]]> {
  const variants: Array<[ArgvVariant, string[]]> = [["posix", item.argv?.posix ?? splitKiroCommandArgs(item.input)]];
  for (const variant of ["kiro-cli", "kiro-ide-pwsh"] as const) {
    if (item.argv?.[variant]) variants.push([variant, item.argv[variant] as string[]]);
  }
  return variants;
}

export interface Exec { status: number; stdout: string; stderr: string }
export async function exec(cmd: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string }): Promise<Exec> {
  // The input goes in as one buffer the runtime writes and closes itself: a hook that starts slowly under load still
  // reads the whole line, where a pipe written and ended by hand once reached a Kiro IDE hook empty on Windows.
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS));
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export interface RunOptions { session?: string; env?: Record<string, string> }
// Production guards, as a person's run has them; the chat the engine acts for is pinned the way a hook pins it.
export function env(proj: string, opts: RunOptions = {}): NodeJS.ProcessEnv {
  return {
    ...testGuardEnvironment(process.env, "production"),
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: opts.session ?? SESSION,
    AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
    ...(opts.env ?? {}),
  };
}

export interface Directive { kind?: string; ask_type?: string; message?: string; question?: string; narration?: string; [k: string]: unknown }
/** `next` as the agent runs it, with the load-steering continuations consumed. */
export async function next(proj: string, args: string[], opts: RunOptions = {}): Promise<{ status: number; directive: Directive | null; out: string }> {
  let command = ["next", "--project-dir", proj, ...args];
  for (let attempts = 0; attempts < 100; attempts++) {
    const res = await exec([process.execPath, ORCHESTRATE, ...command], { cwd: proj, env: env(proj, opts) });
    let directive: Directive | null = null;
    try {
      directive = JSON.parse(res.stdout.trim()) as Directive;
    } catch {
      /* the caller reports the raw output */
    }
    if (directive?.kind !== "load-steering" || typeof directive.receipt !== "string") {
      return { status: res.status, directive, out: `${res.stdout}${res.stderr}` };
    }
    command = ["continue", directive.receipt, "--project-dir", proj];
  }
  throw new Error("steering continuation limit exceeded");
}

const midInception = () => readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8");
const STAGE = "requirements-analysis";
const stageDir = (proj: string) => join(seededRecordDir(proj), "inception", STAGE);

function writeStageFiles(proj: string, summaryConfirmed: boolean): void {
  const dir = stageDir(proj);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n## Overview\n\nA to-do app whose titles are never blank.\n\n## Functional Requirements\n\n- FR-1: a blank title is refused.\n", "utf-8");
  writeFileSync(join(dir, `${STAGE}-questions.md`),
    "# Questions\n\n## Q1\n\nShould a blank title be refused?\n\n[Answer]: Yes\n" +
      // The section waits blank; the `log decision` and `log answer` pair below records the person's confirmation.
      (summaryConfirmed ? "\n## Consolidated Summary Confirmation\n\nDoes this all look correct before I generate the artifact?\n\n- Looks correct\n- Request changes\n\n[Answer]: \n" : ""),
    "utf-8");
}

async function createIntent(proj: string, label: string, words: string): Promise<void> {
  const created = await exec(
    [process.execPath, UTILITY, "intent-create", "--scope", "bugfix", "--arguments", words, "--label", label, "--project-dir", proj],
    { cwd: proj, env: { ...process.env } },
  );
  if (created.status !== 0) throw new Error(`intent-create failed: ${created.stdout}${created.stderr}`);
}

/** A project at one of the corpus states. `proj` already holds the shipped engine and the method tree. */
export async function buildState(proj: string, state: State): Promise<void> {
  switch (state) {
    case "fresh":
    case "hooks-off":
      return;
    case "work-open":
    case "second-chat":
    case "unattended":
      writeFileSync(seededStateFile(proj), midInception(), "utf-8");
      if (state === "second-chat") writeSessionBinding(proj, SECOND_SESSION, "default", null, "unjoined");
      return;
    case "plan-question-open": {
      // A one-step bug fix at Code Generation, its plan written and not yet approved.
      writeFileSync(seededStateFile(proj), midInception()
        .replace("- **Summary Confirmation**: on (from scope bugfix)", "- **Summary Confirmation**: off (from scope bugfix)")
        .replace("- **Learnings**: on (from scope bugfix)", "- **Learnings**: off (from scope bugfix)")
        .replace("- [-] requirements-analysis ", "- [x] requirements-analysis ")
        .replace("- [ ] code-generation ", "- [-] code-generation ")
        .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
        .replace(/^- \*\*Lifecycle Phase\*\*:.*$/m, "- **Lifecycle Phase**: CONSTRUCTION")
        .replace("- **Inception**: Active", "- **Inception**: Verified")
        .replace("- **Construction**: Pending", "- **Construction**: Active"), "utf-8");
      mkdirSync(join(proj, "src"), { recursive: true });
      writeFileSync(join(proj, "src", "todo.ts"), "export const todo = (title: string) => title;\n", "utf-8");
      const requirements = join(seededRecordDir(proj), "inception", "requirements-analysis");
      mkdirSync(requirements, { recursive: true });
      writeFileSync(join(requirements, "requirements.md"), "# Requirements\n\n- FR-1: a blank title is refused.\n", "utf-8");
      const dir = join(seededRecordDir(proj), "construction", "code-generation");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "code-generation-plan.md"),
        "# Code Generation Plan\n\n## Summary\n\n- Builds: the blank-title fix\n- Touches: src/todo.ts\n" +
          "- Tests: 1 regression test\n\n## Steps\n\n- [ ] Step 1: add a failing test for a blank title in `src/todo.test.ts`\n" +
          "- [ ] Step 2: refuse a blank title in `src/todo.ts`\n\n" + renderTestingContract(resolveTestingPosture(proj)), "utf-8");
      writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/todo.test.ts`.\n", "utf-8");
      const opened = await next(proj, []);
      if (opened.directive?.ask_type !== "plan-approval") throw new Error(`plan question did not open: ${opened.out}`);
      return;
    }
    case "gate-open": {
      // A bugfix at Requirements Analysis: files written, summary confirmed, the reviewer's READY review on record,
      // the gate waiting for the person, so an approval goes through under production guards.
      writeFileSync(seededStateFile(proj), midInception(), "utf-8");
      appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
      writeStageFiles(proj, true);
      // The stage's documents, written through the host's write hook so the record knows them.
      const questions = join(stageDir(proj), `${STAGE}-questions.md`);
      recordArtifactWriteViaHook(proj, questions);
      // The consolidated summary, shown and confirmed by the person (a human turn backs the answer).
      const summaryArgs = ["--checkpoint", "summary-confirmation", "--stage", STAGE, "--questions-file", questions, "--project-dir", proj];
      const shown = await exec([process.execPath, LOG, "decision", ...summaryArgs, "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"], { cwd: proj, env: env(proj) });
      if (shown.status !== 0) throw new Error(`summary confirmation ask failed: ${shown.stdout}${shown.stderr}`);
      await say(proj, "Looks correct", "claude");
      // The agent writes the person's answer into the questions file, then records it.
      writeFileSync(questions, readFileSync(questions, "utf-8").replace(/\[Answer\]: \n$/, "[Answer]: Looks correct\n"), "utf-8");
      recordArtifactWriteViaHook(proj, questions, "Edit");
      const confirmed = await exec([process.execPath, LOG, "answer", ...summaryArgs, "--details", "Looks correct"], { cwd: proj, env: env(proj) });
      if (confirmed.status !== 0) throw new Error(`summary confirmation answer failed: ${confirmed.stdout}${confirmed.stderr}`);
      // The stage's document is saved from the confirmed answers, then reviewed.
      const requirements = join(stageDir(proj), "requirements.md");
      writeFileSync(requirements, readFileSync(requirements, "utf-8"), "utf-8");
      recordArtifactWriteViaHook(proj, requirements);
      const asked = await exec([process.execPath, LOG, "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1", "--project-dir", proj], { cwd: proj, env: env(proj) });
      if (asked.status !== 0) throw new Error(`review request failed: ${asked.stdout}${asked.stderr}`);
      const reviewFile = (JSON.parse(asked.stdout.split("\n").find((l) => l.startsWith("{")) ?? "{}") as { reviewFile?: string }).reviewFile;
      if (!reviewFile) throw new Error(`no review file named: ${asked.stdout}`);
      writeFileSync(join(proj, reviewFile),
        `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
          "### Findings\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n", "utf-8");
      const ready = await exec([process.execPath, LOG, "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1", "--verdict", "READY", "--project-dir", proj], { cwd: proj, env: env(proj) });
      if (ready.status !== 0) throw new Error(`review verdict failed: ${ready.stdout}${ready.stderr}`);
      const gate = await exec([process.execPath, ORCHESTRATE, "report", "--stage", STAGE, "--result", "awaiting-approval", "--project-dir", proj], { cwd: proj, env: env(proj) });
      if (gate.status !== 0) throw new Error(`gate did not open: ${gate.stdout}${gate.stderr}`);
      return;
    }
    case "two-similar-records":
      await createIntent(proj, "auth", "fix the login session timeout");
      await createIntent(proj, "auth-fix", "fix the password reset link");
      return;
    case "kiro-pick": {
      // Two records and no selection in this chat: the engine's pick question is what the person last saw.
      await createIntent(proj, "auth", "fix the login session timeout");
      await createIntent(proj, "auth-fix", "fix the password reset link");
      rmSync(join(intentsDirOf(proj, "default"), "active-intent"), { force: true });
      await say(proj, "/aidlc", "claude");
      const pick = await next(proj, []);
      if (pick.directive?.ask_type !== "intent-pick") throw new Error(`pick question did not open: ${pick.out}`);
      return;
    }
    case "plan-offer-open": {
      // The person typed "build a notes app" on a fresh workspace and the plan offer is on screen.
      await say(proj, "/aidlc build a notes app", "claude");
      const offer = await next(proj, ["build", "a", "notes", "app"]);
      if (offer.directive?.kind !== "ask") throw new Error(`plan offer did not open: ${offer.out}`);
      return;
    }
    case "routing-question-open": {
      // Open work; the person typed "fix the login" and the routing question is on screen.
      writeFileSync(seededStateFile(proj), midInception(), "utf-8");
      await say(proj, "/aidlc fix the login", "claude");
      const reading = await next(proj, ["fix", "the", "login"]);
      const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(reading.directive?.message ?? "")?.[1];
      if (!request) throw new Error(`no request id in the reading note: ${reading.out}`);
      const routing = await next(proj, request.split(" "));
      if (routing.directive?.ask_type !== "new-work-routing") throw new Error(`routing question did not open: ${routing.out}`);
      return;
    }
    case "stage-question-asked": {
      // Open work at Requirements Analysis; the agent asked the person a stage question in chat.
      writeFileSync(seededStateFile(proj), midInception(), "utf-8");
      writeStageFiles(proj, false);
      appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
      const asked = await exec([process.execPath, LOG, "decision", "--stage", STAGE, "--decision", "Should a blank title be refused, or saved as Untitled?", "--options", "Refuse it,Save it as Untitled", "--project-dir", proj], { cwd: proj, env: env(proj) });
      if (asked.status !== 0) throw new Error(`stage question failed: ${asked.stdout}${asked.stderr}`);
      return;
    }
    case "parked": {
      writeFileSync(seededStateFile(proj), midInception(), "utf-8");
      await say(proj, "/aidlc park", "claude");
      const parked = await exec([process.execPath, ORCHESTRATE, "park", "--project-dir", proj], { cwd: proj, env: env(proj) });
      if (parked.status !== 0) throw new Error(`park failed: ${parked.stdout}${parked.stderr}`);
      return;
    }
    case "finished":
      writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-completed.md"), "utf-8"), "utf-8");
      return;
    case "archived": {
      await createIntent(proj, "auth", "fix the login session timeout");
      const archived = await exec([process.execPath, UTILITY, "intent", "archive", "auth", "--project-dir", proj], { cwd: proj, env: env(proj) });
      if (archived.status !== 0) throw new Error(`archive failed: ${archived.stdout}${archived.stderr}`);
      return;
    }
  }
}

/** A fresh project with the shipped engine and method tree at the item's state. */
export async function projectAt(state: State): Promise<string> {
  const proj = createOrchestrationTestProject();
  await buildState(proj, state);
  return proj;
}

// The person types `prompt`, through the host's own human-turn hook.
export async function say(proj: string, prompt: string, harness: Harness, opts: RunOptions = {}): Promise<Exec> {
  const session = opts.session ?? SESSION;
  if (harness === "claude") {
    return exec([process.execPath, DISPATCHER, "engine", "hook", "record-human-turn"],
      { cwd: proj, env: env(proj, opts), input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: proj, prompt }) });
  }
  const tree = harness === "codex" ? ".codex" : ".kiro";
  if (!existsSync(join(proj, tree))) cpSync(join(REPO_ROOT, "dist", harness, tree), join(proj, tree), { recursive: true });
  const unset = { ...env(proj, opts), CLAUDE_PROJECT_DIR: undefined, AIDLC_UNATTENDED: opts.env?.AIDLC_UNATTENDED, USER_PROMPT: undefined };
  if (harness === "codex") {
    writeSessionPidEntry(proj, process.pid, session);
    return exec([process.execPath, join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], {
      cwd: proj,
      env: { ...unset, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined },
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: "t1", cwd: proj, prompt }),
    });
  }
  return exec([process.execPath, join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), harness === "kiro" ? "verb-intercept" : "record-human-turn"], {
    cwd: proj,
    env: unset,
    input: JSON.stringify({ hook_event_name: harness === "kiro" ? "userPromptSubmit" : "UserPromptSubmit", session_id: session, cwd: proj, prompt }),
  });
}

export interface StoredRecord { text: string; words: string | null; settings: Array<{ key: string; value: string }>; applied: string[] }
/** The message record the hook wrote for `prompt` (or the newest one). */
export function messageRecord(proj: string, prompt: string): StoredRecord | null {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "messages");
  if (!existsSync(dir)) return null;
  const records = readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as StoredRecord & { at: string });
  return records.find((r) => r.text === prompt) ?? records.sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
}

// What Codex said to the person: `codex exec` logs every event to stderr; the agent's messages follow a line that is
// exactly "codex" and run until the next event marker (a hook, an exec, a user turn, the token count, the workspace diff
// codex exec prints after the last message). The tool log, the engine's JSON and the diff are not words to the person.
// Without any marker the agent never spoke (codex exec stopped at its own usage text or error): nothing is its words.
export function codexWords(out: string): string {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of out.split("\n")) {
    if (line === "codex") { current = []; blocks.push(""); continue; }
    if (current && /^(hook: |exec$|user$|thinking$|tokens used$|diff --git |\d{4}-\d{2}-\d{2}T\S+ (ERROR|WARN))/.test(line)) { blocks[blocks.length - 1] = current.join("\n").trim(); current = null; continue; }
    if (current) current.push(line);
  }
  if (current) blocks[blocks.length - 1] = current.join("\n").trim();
  return blocks.filter((b) => b.length > 0).join("\n\n");
}
