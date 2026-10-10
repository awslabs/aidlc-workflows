// The /aidlc input corpus (tests/fixtures/aidlc-input/corpus.json) and the fixture mechanics its two checks share:
// the five workspace states, the person's turn through each host's own human-turn hook, `next` as the agent runs
// it, and the message record the hook writes. The unit check (tests/unit/t-aidlc-input-corpus.test.ts) runs the
// engine's first step for every item; the live check (tests/e2e/t-live-aidlc-input-corpus.serial.test.ts) drives a
// sample through real agents.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import corpus from "../fixtures/aidlc-input/corpus.json";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";
import { AIDLC_SRC, FIXTURES_DIR, REPO_ROOT, createOrchestrationTestProject, seededRecordDir, seededStateFile } from "./fixtures.ts";
import { testGuardEnvironment } from "./runner-profile.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { splitKiroCommandArgs, writeSessionPidEntry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

export type State = "fresh" | "work-open" | "plan-question-open" | "gate-open" | "two-similar-records";
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
  /** One of these phrasings appears in the agent's final text (case-insensitive). */
  says?: string[];
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
export const SESSION = "01995000-7a11-7000-8000-00000000d001";

// The source each `after` waits for, read where the change lands.
const coreTool = (name: string) => readFileSync(join(REPO_ROOT, "core", "tools", name), "utf-8");
export const LANDED: Record<string, () => boolean> = {
  "#2276": () => !coreTool("aidlc-command.ts").includes("DISPATCHER_RESERVED_FUTURE"),
  WO2: () => !coreTool("aidlc-orchestrate.ts").includes("unreadSettingOnly"),
  WO3: () => !coreTool("aidlc-lib.ts").includes("parseTypedGuardSwitchRequest"),
  WO5: () => !coreTool("aidlc-lib.ts").includes("CONTINUATION_PHRASES"),
  WO6: () => !coreTool("aidlc-orchestrate.ts").includes("This looks like"),
  pending: () => false,
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
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdin: opts.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.input !== undefined && proc.stdin) {
    proc.stdin.write(opts.input);
    proc.stdin.end();
  }
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

// Production guards, as a person's run has them.
export function env(proj: string): NodeJS.ProcessEnv {
  return {
    ...testGuardEnvironment(process.env, "production"),
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_UNATTENDED: "0",
  };
}

export interface Directive { kind?: string; ask_type?: string; message?: string; question?: string; narration?: string; [k: string]: unknown }
/** `next` as the agent runs it, with the load-steering continuations consumed. */
export async function next(proj: string, args: string[]): Promise<{ status: number; directive: Directive | null; out: string }> {
  let command = ["next", "--project-dir", proj, ...args];
  for (let attempts = 0; attempts < 100; attempts++) {
    const res = await exec([process.execPath, ORCHESTRATE, ...command], { cwd: proj, env: env(proj) });
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

/** A project at one of the corpus states. `proj` already holds the shipped engine and the method tree. */
export async function buildState(proj: string, state: State): Promise<void> {
  switch (state) {
    case "fresh":
      return;
    case "work-open":
      writeFileSync(seededStateFile(proj), midInception(), "utf-8");
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
      // A bugfix at Requirements Analysis whose stage files are written and whose gate waits for the person.
      writeFileSync(seededStateFile(proj), midInception(), "utf-8");
      const dir = join(seededRecordDir(proj), "inception", "requirements-analysis");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n- FR-1: a blank title is refused.\n", "utf-8");
      writeFileSync(join(dir, "requirements-analysis-questions.md"), "# Questions\n\n## Q1\n\nShould a blank title be refused?\n\n[Answer]: \n", "utf-8");
      appendAuditEntry("STAGE_STARTED", { Stage: "requirements-analysis" }, proj);
      const gate = await exec(
        [process.execPath, ORCHESTRATE, "report", "--stage", "requirements-analysis", "--result", "awaiting-approval", "--project-dir", proj],
        { cwd: proj, env: { ...process.env, AIDLC_SKIP_REVIEWER_GATE_GUARD: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" } },
      );
      if (gate.status !== 0) throw new Error(`gate did not open: ${gate.stdout}${gate.stderr}`);
      return;
    }
    case "two-similar-records": {
      for (const [label, words] of [["auth", "fix the login session timeout"], ["auth-fix", "fix the password reset link"]]) {
        const created = await exec(
          [process.execPath, UTILITY, "intent-create", "--scope", "bugfix", "--arguments", words, "--label", label, "--project-dir", proj],
          { cwd: proj, env: { ...process.env } },
        );
        if (created.status !== 0) throw new Error(`intent-create failed: ${created.stdout}${created.stderr}`);
      }
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
export async function say(proj: string, prompt: string, harness: Harness): Promise<Exec> {
  if (harness === "claude") {
    return exec([process.execPath, DISPATCHER, "engine", "hook", "record-human-turn"],
      { cwd: proj, env: env(proj), input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }) });
  }
  const tree = harness === "codex" ? ".codex" : ".kiro";
  if (!existsSync(join(proj, tree))) cpSync(join(REPO_ROOT, "dist", harness, tree), join(proj, tree), { recursive: true });
  const unset = { ...env(proj), CLAUDE_PROJECT_DIR: undefined, AIDLC_UNATTENDED: undefined, USER_PROMPT: undefined };
  if (harness === "codex") {
    writeSessionPidEntry(proj, process.pid, SESSION);
    return exec([process.execPath, join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], {
      cwd: proj,
      env: { ...unset, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined },
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, turn_id: "t1", cwd: proj, prompt }),
    });
  }
  return exec([process.execPath, join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), harness === "kiro" ? "verb-intercept" : "record-human-turn"], {
    cwd: proj,
    env: unset,
    input: JSON.stringify({ hook_event_name: harness === "kiro" ? "userPromptSubmit" : "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }),
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
