// covers: function:firstStepNote, function:hookContextLine
//
// A long request AI-DLC already has whole is not typed again (#3744). The human-turn hook keeps a typed `/aidlc`
// line past the record's cut whole beside its record (#3741), and a bare `next` reads it from there. So the prompt
// hook tells the agent, in the words Kiro's first-step note already uses, that AI-DLC has the message and to run
// `next` with nothing after it: the person's words go from their paste to the work without the model typing tens of
// thousands of characters again, and nothing past a command line's limit is ever a command line. In core one place
// (firstStepNote) owns the words and when they are said, and each tool's hook only delivers them: Claude Code and
// Codex in the hook's context line, opencode and Kiro CLI's V2 engine through one key on the hook's output that only
// they ask for. On V2 the note stands in for the whole-line first call, whose word split drops the person's quote
// marks and line breaks (#3747) and can pass a Windows command line's limit (#3748), and no forwarding latch holds
// the agent to it. Kiro IDE's adapter (Kiro IDE and Kiro CLI's V3 engine) says the same sentence its own way
// (firstStepLine), held to these words by a test here; Copilot and Cursor drop a prompt hook's output, so
// nothing reaches theirs. A short message, a line with a flag or a verb, a paste holding a flag-shaped token `next`
// does not take, work already open, a message with no whole copy, a payload with no chat, a host's turn and a turn
// whose record is withheld (an unattended run; a swarm worker's worktree withholds it the same way) get no note and no
// key. No long text is an argument past what a Windows command line holds: it reaches the hook as a stdin file.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTestProject, createTestProject, seedAidlcMemory } from "../harness/fixtures.ts";
import {
  DISPATCHER,
  type Directive,
  env,
  exec,
  type Exec,
  type Harness,
  next,
  projectAt,
  say,
  SECOND_SESSION,
  SESSION,
} from "../harness/aidlc-input-corpus.ts";
import adapterPlugin from "../../harness/opencode/plugin/aidlc-opencode-adapter.ts";

setDefaultTimeout(240_000);

// The tab running these may be a chat itself: its own chat variables would name the chat the engine acts for
// (hostNamedChat), so the children never see them.
for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "KIRO_SESSION_ID", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE"]) {
  delete process.env[name];
}

const REPO_ROOT = join(import.meta.dir, "..", "..");
const NOTE = "AI-DLC: this message is an AI-DLC request and AI-DLC has it on record.";
const NOTE_STEP = "engine orchestrate next` now and do only what it prints.";
const KEY = "firstStepNote";
const LAST = "Late decisions: these override anything above, and the ledger ships with no sync.";

// About `size` characters of a spec in numbered sections with line breaks, ending with LAST; nothing in it reads as a
// flag or a plan's name.
function spec(size: number): string {
  const parts: string[] = ["Tally: a command-line task ledger for small teams."];
  for (let i = 1; parts.join("\n").length < size - LAST.length - 120; i++) {
    parts.push(`Section ${i}. The ledger keeps every task a team adds, with its owner, its due day and its notes, and a teammate can read the list at any time.`);
  }
  parts.push(LAST);
  return parts.join("\n");
}
// A markdown spec as a person pastes one: headings, a list, quotes and a fenced code block with indented lines.
function markdownSpec(size: number): string {
  const head = [
    "# Tally: a command-line task ledger for small teams",
    "",
    "## What it keeps",
    "- a title for every task, never blank",
    "- an owner, who can be changed later",
    "",
    "## How it adds a task",
    "```ts",
    "export function add(tasks: string[], title: string): string[] {",
    "    if (title.trim() === \"\") {",
    "        throw new Error(\"a task needs a title\");",
    "    }",
    "    return [...tasks, title];",
    "}",
    "```",
    "",
    "## More",
  ];
  const parts = [...head];
  for (let i = 1; parts.join("\n").length < size - LAST.length - 200; i++) {
    parts.push(`Paragraph ${i}. A teammate says "done" when a task is finished, and the ledger keeps it, marked done, so the team can look back at what it finished.`);
  }
  parts.push("", "## Late decisions", LAST);
  return parts.join("\n");
}
// The same in Japanese: three bytes a character.
function japaneseSpec(size: number): string {
  const parts: string[] = ["タリー: 小さなチームのためのタスク台帳。"];
  for (let i = 1; parts.join("\n").length < size - 40; i++) {
    parts.push(`第${i}節。台帳はチームが加えたすべてのタスクを、担当者と期日とメモと一緒に記録し、誰でもいつでも一覧を読める。`);
  }
  parts.push("最後の決定: これまでのすべてに優先する。");
  return parts.join("\n");
}

const sha = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");
const notes = (out: string): number => out.split(NOTE).length - 1;
const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});
async function project(state: Parameters<typeof projectAt>[0]): Promise<string> {
  const proj = await projectAt(state);
  projects.push(proj);
  return proj;
}

interface Question { id: string; text: string; createdAt: string; proposedScope?: string }
function newest(proj: string): Question | undefined {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as Question)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1);
}
const copies = (proj: string): string[] => {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "messages");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".txt")) : [];
};
// The hook's context line as the host reads it, and the key only an adapter that asks gets.
function contextLine(out: string): { context: string; key: unknown; keys: string[] } {
  const line = out.trim().split("\n").find((l) => l.startsWith("{"));
  if (line === undefined) return { context: "", key: undefined, keys: [] };
  const parsed = JSON.parse(line) as Record<string, unknown> & { hookSpecificOutput?: { additionalContext?: string } };
  return { context: String(parsed.hookSpecificOutput?.additionalContext ?? ""), key: parsed[KEY], keys: Object.keys(parsed) };
}
// The core hook driven directly with a payload an adapter builds (the dispatcher's own hook entry).
function coreHook(proj: string, prompt: string, extra: Record<string, unknown>, session = SESSION): Promise<Exec> {
  return exec([process.execPath, DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    env: env(proj, { session }),
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, cwd: proj, prompt, ...extra }),
  });
}
// Kiro IDE's person-message card (catch-up, the human-turn hook, then the first step), as Kiro runs it.
async function kiroIdeCard(proj: string, prompt: string): Promise<Exec> {
  if (!existsSync(join(proj, ".kiro"))) cpSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro"), join(proj, ".kiro"), { recursive: true });
  return exec([process.execPath, join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "person-message"], {
    cwd: proj,
    env: { ...env(proj), CLAUDE_PROJECT_DIR: undefined, USER_PROMPT: undefined },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }),
  });
}
// The work a bare `next` starts from the person's line: the plan proposal step naming the whole request.
async function bareNextTakesIt(proj: string, words: string, opts: { session?: string } = {}): Promise<Directive | null> {
  const first = await next(proj, [], opts);
  expect(String(first.directive?.message ?? ""), first.out.slice(0, 400)).toContain("propose");
  expect(sha(newest(proj)?.text ?? ""), "the paste byte for byte, its line breaks included").toBe(sha(words));
  return first.directive;
}

describe("a long /aidlc paste: the agent is told AI-DLC has it whole and runs next with nothing after it (#3744)", () => {
  for (const [label, words] of [
    ["30,000 characters", spec(30_000)],
    ["100,000 characters", spec(100_000)],
    ["25,000 characters in Japanese", japaneseSpec(25_000)],
    ["a 30,000-character markdown spec with quotes and a code block", markdownSpec(30_000)],
  ] as Array<[string, string]>) {
    test(`Claude Code: ${label}: the context line carries the note once, and a bare next takes every word`, async () => {
      const proj = await project("fresh");
      const said = await say(proj, `/aidlc ${words}`, "claude");
      expect(copies(proj), "the whole text is kept beside its record").toHaveLength(1);
      const line = contextLine(said.stdout);
      expect(notes(line.context), said.stdout.slice(0, 400)).toBe(1);
      expect(line.context).toContain(NOTE_STEP);
      expect(line.keys, "Claude Code never asked for the key").not.toContain(KEY);
      await bareNextTakesIt(proj, words);
    });
  }

  test("Codex: the note reaches the agent in Codex's own envelope, with no key it does not know", async () => {
    const proj = await project("fresh");
    const words = spec(30_000);
    const said = await say(proj, `$aidlc ${words}`, "codex");
    const line = contextLine(said.stdout);
    expect(notes(line.context), said.stdout.slice(0, 400)).toBe(1);
    expect(line.keys).not.toContain(KEY);
    await bareNextTakesIt(proj, words);
  });

  test("Kiro CLI V3 and Kiro IDE: the first-step note is said once, as before", async () => {
    const proj = await project("fresh");
    const words = spec(30_000);
    const card = await kiroIdeCard(proj, `/aidlc ${words}`);
    expect(notes(card.stdout), card.stdout.slice(0, 400)).toBe(1);
    expect(card.stdout).toContain(NOTE_STEP);
    expect(card.stdout).not.toContain(KEY);
    await bareNextTakesIt(proj, words);
  });

  // Kiro CLI hands its V2 prompt hook the line as typed, or the aidlc skill's body with the line in place of every
  // $ARGUMENTS; the hook reads the person's line out of either.
  const skillBody = (): string => readFileSync(join(REPO_ROOT, "dist", "kiro", ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8");
  for (const [shape, prompt] of [
    ["the line as typed", (words: string) => `/aidlc ${words}`],
    ["the skill's body", (words: string) => skillBody().replaceAll("$ARGUMENTS", () => words)],
  ] as Array<[string, (words: string) => string]>) {
    test(`Kiro CLI V2, ${shape}: the agent is told to run next with nothing after it, and the guard lets that call run`, async () => {
      const proj = await project("fresh");
      // A call held for the turn this paste arrives on (the turn counter could not move past it), which would refuse
      // the bare next.
      const latch = join(proj, "aidlc", ".aidlc-sessions", ".kiro-cli-forwarding-latch.json");
      mkdirSync(dirname(latch), { recursive: true });
      writeFileSync(latch, `${JSON.stringify({ turn: 1, raw: "fix the sales report end date", args: ["fix", "the", "sales", "report", "end", "date"] })}\n`);
      const words = markdownSpec(30_000);
      const said = await say(proj, prompt(words), "kiro");
      expect(said.status, said.stderr).toBe(0);
      expect(notes(said.stdout), said.stdout.slice(0, 400)).toBe(1);
      expect(said.stdout).not.toContain("Your first tool call is exactly the call below");
      expect(said.stdout, "the paste is not handed back to be typed again").not.toContain(LAST);
      expect(existsSync(latch), "no call is held for the agent to match").toBe(false);
      const call = /Run `([^`]+ engine orchestrate next)` now/.exec(said.stdout)?.[1];
      expect(call, said.stdout.slice(0, 400)).toBeDefined();
      const guard = await exec([process.execPath, join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "guard-tool-call"], {
        cwd: proj,
        env: { ...env(proj), CLAUDE_PROJECT_DIR: undefined, USER_PROMPT: undefined },
        input: JSON.stringify({ hook_event_name: "preToolUse", session_id: SESSION, cwd: proj, tool_name: "shell", tool_input: { command: call } }),
      });
      expect(guard.status, guard.stderr).toBe(0);
      await bareNextTakesIt(proj, words);
    });
  }

  test("the note is Kiro's own first-step sentence, word for word", async () => {
    const kiro = readFileSync(join(REPO_ROOT, "harness", "kiro-ide", "hooks", "aidlc-kiro-adapter.ts"), "utf-8");
    expect(kiro).toContain(`return \`${NOTE} \${run}\`;`);
    expect(kiro).toContain(`engine orchestrate \${step}\\\` now and do only what it prints.\`;`);
    const proj = await project("fresh");
    const line = contextLine((await say(proj, `/aidlc ${spec(30_000)}`, "claude")).stdout).context;
    expect(line.slice(line.indexOf(NOTE))).toMatch(/^AI-DLC: this message is an AI-DLC request and AI-DLC has it on record\. Run `[^`]+ engine orchestrate next` now and do only what it prints\.$/);
  });

  test("opencode: the note rides the command's own template part; what the person sees is unchanged", async () => {
    const proj = createTestProject();
    projects.push(proj);
    cpSync(join(REPO_ROOT, "dist", "opencode", ".aidlc"), join(proj, ".aidlc"), { recursive: true });
    seedAidlcMemory(proj);
    const commandFile = join(REPO_ROOT, "dist", "opencode", ".opencode", "command", "aidlc.md");
    mkdirSync(join(proj, ".opencode", "command"), { recursive: true });
    copyFileSync(commandFile, join(proj, ".opencode", "command", "aidlc.md"));
    const template = readFileSync(commandFile, "utf-8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const client = {
      session: {
        get: async () => ({ data: {} }),
        prompt: async () => undefined,
      },
    };
    // The plugin runs inside opencode's own process, so the engine it starts inherits that process's environment.
    const saved = { ...process.env };
    for (const [name, value] of Object.entries(env(proj))) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      const adapter = await adapterPlugin.server({
        client,
        directory: proj,
        aidlcCommand: [process.execPath, join(proj, ".aidlc", "tools", "aidlc.ts"), "engine"],
      } as Parameters<typeof adapterPlugin.server>[0]);
      const run = async (args: string): Promise<Array<Record<string, unknown>>> => {
        const parts: Array<Record<string, unknown>> = [{ type: "text", text: template.replace("$ARGUMENTS", args).trim() }];
        await adapter["command.execute.before"]({ command: "aidlc", sessionID: SESSION, arguments: args }, { parts });
        parts.forEach((part, i) => { part.id = `prt_${i}`; });
        await adapter["chat.message"]({ sessionID: SESSION }, { parts });
        return parts;
      };
      const words = spec(30_000);
      const long = await run(words);
      expect(long).toHaveLength(2);
      expect(notes(String(long[0].text)), "the note once, in the template the model reads").toBe(1);
      expect(String(long[0].text).endsWith(`do only what it prints.`)).toBe(true);
      expect(long[1]).toMatchObject({ text: `/aidlc ${words}`, ignored: true });
      const short = await run("fix the sales report end date");
      expect(short[0].text, "a short line's template is as it was").toBe(template.replace("$ARGUMENTS", "fix the sales report end date").trim());
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  test("Copilot: its adapter hands the agent nothing from the prompt hook, as before", async () => {
    const proj = await project("fresh");
    const said = await say(proj, `/aidlc ${spec(30_000)}`, "copilot");
    expect(notes(said.stdout)).toBe(0);
    expect(said.stdout).not.toContain(KEY);
  });

  test("a plan word before the paste: the bare next's reading step keeps the same request as the agent's own call", async () => {
    const words = spec(30_000);
    const viaNote = await project("fresh");
    const said = await say(viaNote, `/aidlc bugfix ${words}`, "claude");
    expect(notes(contextLine(said.stdout).context)).toBe(1);
    const viaArgs = await project("fresh");
    await say(viaArgs, `/aidlc bugfix ${words}`, "claude");
    // Each path as the agent follows it: the step it gets, and the plan-word step's own command when it names one.
    const taken: Array<string | undefined> = [];
    for (const [proj, args] of [[viaNote, []], [viaArgs, ["bugfix", words]]] as Array<[string, string[]]>) {
      const step = (await next(proj, args)).directive;
      const named = [...String(step?.message ?? "").matchAll(/`[^`]*aidlc-orchestrate\.ts next([^`]*)`/g)]
        .map((m) => m[1].trim().split(/\s+/)).find((a) => a.includes("--scope") && a.includes("--request-file"));
      if (named !== undefined) await next(proj, named);
      taken.push(newest(proj)?.text);
    }
    expect(sha(taken[0] ?? ""), "everything after the plan word, byte for byte, by the note").toBe(sha(words));
    expect(sha(taken[1] ?? ""), "the same as the agent's own call").toBe(sha(words));
  });

  test("which chat: the note's next takes the line in the chat that typed it, and a second chat's does not", async () => {
    const proj = await project("fresh");
    const words = spec(30_000);
    await say(proj, `/aidlc ${words}`, "claude");
    const other = await next(proj, [], { session: SECOND_SESSION });
    expect(String(other.directive?.message ?? ""), "another chat's next never takes this chat's line").not.toContain(LAST);
    expect(newest(proj), "no request kept from it").toBeUndefined();
    await bareNextTakesIt(proj, words);
  });

  test("which chat, named the way Claude Code names it to the agent's shell: its own chat takes the line", async () => {
    // No override: the engine finds the chat from CLAUDE_CODE_SESSION_ID beside a live CLAUDE_PID (hostNamedChat).
    const asClaude = (session: string) => ({
      env: { AIDLC_SESSION_OVERRIDE: undefined, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(process.pid) } as unknown as Record<string, string>,
    });
    const proj = await project("fresh");
    const words = spec(30_000);
    await say(proj, `/aidlc ${words}`, "claude");
    const other = await next(proj, [], asClaude(SECOND_SESSION));
    expect(String(other.directive?.message ?? ""), "another chat's next never takes this chat's line").not.toContain(LAST);
    expect(newest(proj)).toBeUndefined();
    const own = await next(proj, [], asClaude(SESSION));
    expect(String(own.directive?.message ?? ""), own.out.slice(0, 400)).toContain("propose");
    expect(sha(newest(proj)?.text ?? "")).toBe(sha(words));
  });

  test("no loop: the note's next gives the plan proposal, whose own command asks the plan question", async () => {
    const proj = await project("fresh");
    const words = spec(30_000);
    await say(proj, `/aidlc ${words}`, "claude");
    const first = await bareNextTakesIt(proj, words);
    const id = /--request ([0-9a-f]{8})/.exec(String(first?.message ?? ""))?.[1];
    expect(id, String(first?.message).slice(0, 400)).toBeDefined();
    const asked = await next(proj, ["--propose", "feature", "--request", id as string]);
    expect(asked.directive?.kind, asked.out.slice(0, 400)).toBe("ask");
    expect(notes(JSON.stringify([first, asked.directive])), "no step says the note again").toBe(0);
  });
});

describe("no note and no key", () => {
  const cases: Array<[string, Parameters<typeof projectAt>[0], string, Harness]> = [
    ["a short /aidlc line", "fresh", "/aidlc fix the sales report end date", "claude"],
    ["a long plain message with no /aidlc", "fresh", spec(30_000), "claude"],
    ["a long line with a flag", "fresh", `/aidlc --scope feature ${spec(30_000)}`, "claude"],
    ["a long line with a verb", "fresh", `/aidlc compose ${spec(30_000)}`, "claude"],
    ["a long paste holding a token next does not take", "fresh", `/aidlc ${spec(15_000)}\n---\n${spec(15_000)}`, "claude"],
    ["a long paste holding a --name token", "fresh", `/aidlc add a --verbose switch. ${spec(30_000)}`, "claude"],
    ["a long line over open work", "work-open", `/aidlc ${spec(30_000)}`, "claude"],
    ["a line over the most a request can carry (no whole copy)", "fresh", `/aidlc ${spec(140_000)}`, "claude"],
    ["a short /aidlc line on Codex", "fresh", "$aidlc fix the sales report end date", "codex"],
  ];
  for (const [label, state, prompt, harness] of cases) {
    test(`${harness}: ${label}`, async () => {
      const proj = await project(state);
      const said = await say(proj, prompt, harness);
      expect(notes(said.stdout), said.stdout.slice(0, 400)).toBe(0);
      expect(said.stdout).not.toContain(KEY);
    });
  }

  test("a payload with no chat: no note (the bare next would find no line)", async () => {
    const proj = await project("fresh");
    const said = await coreHook(proj, `/aidlc ${spec(30_000)}`, {}, "");
    expect(notes(said.stdout)).toBe(0);
    expect(said.stdout).not.toContain(KEY);
  });

  test("a host's own turn: no note", async () => {
    const proj = await project("fresh");
    const said = await coreHook(proj, `/aidlc ${spec(30_000)}`, { origin: { kind: "host", reason: "a scheduled wake-up", source: "record" } });
    expect(notes(said.stdout)).toBe(0);
    expect(said.stdout).not.toContain(KEY);
  });

  test("an unattended run: no note", async () => {
    const proj = await project("fresh");
    const said = await say(proj, `/aidlc ${spec(30_000)}`, "claude", { env: { AIDLC_UNATTENDED: "1" } });
    expect(notes(said.stdout)).toBe(0);
  });

  test("the key is printed only for an adapter that asks, and a Kiro adapter's turn gets no context line of it", async () => {
    const words = spec(30_000);
    const relayed = await project("fresh");
    const quiet = await coreHook(relayed, `/aidlc ${words}`, { relays_terminal_output: true });
    expect(quiet.stdout, "nothing asked, nothing printed").toBe("");
    const asking = await project("fresh");
    const keyed = await coreHook(asking, `/aidlc ${words}`, { relays_terminal_output: true, wants_first_step_note: true });
    const line = contextLine(keyed.stdout);
    expect(String(line.key)).toContain(NOTE);
    expect(notes(line.context), "the Kiro adapters say the step their own way").toBe(0);
    const short = await project("fresh");
    const none = await coreHook(short, "/aidlc fix the sales report end date", { relays_terminal_output: true, wants_first_step_note: true });
    expect(none.stdout, "asked, but no note to say").toBe("");
  });
});
