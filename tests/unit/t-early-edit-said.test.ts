// covers: function:keepWritesBeforePick, function:sayWritesBeforePick, function:openPlanQuestion, hook:aidlc-plan-approval-guard
//
// The person's files the agent changed while the plan question was still open
// are said once when the person's pick starts the work, with the way back, and
// nothing is blocked (P185: Copilot CLI's agent edited the greeter in its first
// turn in about 30% of first attempts, before the person had picked a plan, and
// nothing ever said so). Each write goes through AI-DLC's PreToolUse guard, as
// the host runs it, and then happens; the person's own edits, a teammate's pull
// and a generated file reach no hook and are never named. The guard's answer is
// the same as before in every case.

import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  REPO_ROOT,
  removeWorkspaceRecord,
  resetAidlcEnv,
  runOrchestrateNext,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(AIDLC_SRC, "tools");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const SESSION = "early-edit-chat-1";
const OTHER = "early-edit-chat-2";
const REQUEST = /--request ([0-9a-f]{8})/;
const WORDS = "fix the greeter: it says hello instead of greeting the person by name";
const SAID = "Before this work started,";

type Directive = Record<string, unknown> & { kind?: string; message?: string; confirm_command?: string };

function chatEnv(proj: string, session: string): NodeJS.ProcessEnv {
  return {
    ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: session,
    CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj,
  };
}

function next(proj: string, args: string[], session = SESSION): Directive {
  const r = runOrchestrateNext(join(TOOLS, "aidlc-orchestrate.ts"), proj, args, { cwd: proj, env: chatEnv(proj, session) });
  expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
  return r.directive as Directive;
}

function git(proj: string, args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=Person", "-c", "user.email=person@example.com", ...args], { cwd: proj, encoding: "utf-8" });
  expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

/** The person's line, through the prompt hook as the host runs it. */
function typed(proj: string, prompt: string, session = SESSION): void {
  const r = spawnSync(process.execPath, [join(TOOLS, "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj, input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit", prompt }),
    env: chatEnv(proj, session), encoding: "utf-8",
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}
const later = (): void => Bun.sleepSync(1005 - (Date.now() % 1000));

/** AI-DLC's PreToolUse guard for one of the agent's calls: it lets every one of these through. */
function guard(proj: string, session: string, tool: string, input: Record<string, unknown>): void {
  const r = spawnSync(process.execPath, [GUARD], {
    cwd: proj, env: chatEnv(proj, session), encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd: proj, tool_name: tool, tool_input: input }),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

/** The agent's file tool writing `rel`, its hooks first. */
function agentWrites(proj: string, rel: string, text: string, session = SESSION): void {
  guard(proj, session, "Write", { file_path: join(proj, rel), content: text });
  mkdirSync(join(proj, rel, ".."), { recursive: true });
  writeFileSync(join(proj, rel), text);
}

/** The agent's shell command, its hooks first. */
function agentRuns(proj: string, command: string, session = SESSION): void {
  guard(proj, session, "Bash", { command });
  const r = spawnSync("bash", ["-c", command], { cwd: proj, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "Agent", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "Agent", GIT_COMMITTER_EMAIL: "a@example.com" } });
  expect(r.status, r.stderr).toBe(0);
}

const GREETER: Record<string, string> = {
  "README.md": "# greeter\n\nA tiny command-line greeter: `node src/app.js Ada` should print `Hello, Ada!`.\n",
  "package.json": '{\n  "name": "greeter",\n  "version": "0.1.0"\n}\n',
  "src/app.js": "const name = process.argv[2];\nconsole.log('hello');\n",
  "test/app.test.js": "require('node:assert');\n",
  "CHANGELOG.md": "# Changelog\n",
};
const FIXED = "const name = process.argv[2];\nconsole.log('Hello, ' + name + '!');\n";

/** The person's greeter, AI-DLC installed, all of it committed (`inGit` false: a folder outside git). */
function greeter(options: { inGit?: boolean; earlierWork?: boolean; workInProgress?: boolean } = {}): string {
  const proj = createOrchestrationTestProject();
  if (!options.workInProgress) removeWorkspaceRecord(proj);
  // The hooks the host runs here are registered, as in the person's install.
  mkdirSync(join(proj, ".claude"), { recursive: true });
  copyFileSync(join(AIDLC_SRC, "settings.json"), join(proj, ".claude", "settings.json"));
  if (options.earlierWork) seedStateFile(proj, "state-completed.md");
  if (options.workInProgress) seedStateFile(proj, "state-mid-ideation.md");
  for (const [rel, text] of Object.entries(GREETER)) {
    mkdirSync(join(proj, rel, ".."), { recursive: true });
    writeFileSync(join(proj, rel), text);
  }
  if (options.inGit !== false) {
    git(proj, ["init", "-q"]);
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "greeter"]);
  }
  return proj;
}

/** The person's first line, the agent's proposal step, and the plan question it returns. */
function planQuestion(proj: string, session = SESSION): Directive {
  typed(proj, `/aidlc ${WORDS}`, session);
  later();
  const proposal = next(proj, ["--", WORDS], session);
  const id = REQUEST.exec(String(proposal.message))?.[1];
  expect(id, String(proposal.message).slice(0, 300)).toBeDefined();
  const ask = next(proj, ["--propose", "bugfix", "--request", id!], session);
  expect(ask.kind, JSON.stringify(ask).slice(0, 300)).toBe("ask");
  return ask;
}

/** The person picks the plan in `session`; the work is created; the first step after it, as the agent reads it. */
function pick(proj: string, ask: Directive, session = SESSION): string {
  later();
  typed(proj, "1", session);
  const confirm = String(ask.confirm_command);
  const start = next(proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" "), session);
  expect(String(start.message), JSON.stringify(start).slice(0, 400)).toContain("intent create");
  const id = REQUEST.exec(confirm)![1];
  const created = spawnSync(process.execPath, [
    join(TOOLS, "aidlc.ts"), "engine", "intent", "create", "--scope", "bugfix", "--request", id, "--label", "greeter-fix",
    "--project-dir", proj,
  ], { cwd: proj, env: chatEnv(proj, session), encoding: "utf-8" });
  expect(created.status, `${created.stdout}${created.stderr}`).toBe(0);
  // The agent's next engine command, its hooks first, as the host runs them.
  guard(proj, session, "Bash", { command: "bun .claude/tools/aidlc-orchestrate.ts next" });
  return JSON.stringify(next(proj, [], session));
}

/** What the work keeps of the files changed before its pick (aidlc-before-pick.ts), or null. */
function keptWithWork(proj: string): Array<{ path: string }> | null {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  for (const name of readdirSync(intents)) {
    const file = join(intents, name, ".aidlc-engine", "before-pick.json");
    if (existsSync(file)) return (JSON.parse(readFileSync(file, "utf-8")) as { files: Array<{ path: string }> }).files;
  }
  return null;
}

/** The one line the person hears about it, from what the step carries for them. */
function said(step: string): string | null {
  const directive = JSON.parse(step) as { narration?: unknown; change_notices?: unknown };
  const text = [directive.narration, ...(Array.isArray(directive.change_notices) ? directive.change_notices : [])]
    .filter((part): part is string => typeof part === "string").join(" ");
  return /Before this work started,.*?(?:last committed|was before|were before|to undo that|cannot be undone)\.(?=\s|$)/
    .exec(text)?.[0] ?? null;
}

let proj = "";
beforeAll(() => resetAidlcEnv());
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

describe("t-early-edit-said: what the agent changed before the person picked a plan is said once, with the way back", () => {
  test("a file-tool edit and a shell append: named on the first step after the pick, with the checkout, once", () => {
    proj = greeter();
    const ask = planQuestion(proj);
    agentWrites(proj, "src/app.js", FIXED);
    agentRuns(proj, "echo 'fixed greeting' >> CHANGELOG.md");
    expect(said(pick(proj, ask))).toBe(
      "Before this work started, src/app.js and CHANGELOG.md were changed; " +
        "`git checkout HEAD -- src/app.js CHANGELOG.md` puts them back as last committed.",
    );
    expect(JSON.stringify(next(proj, []))).not.toContain(SAID);
    // What they held before, kept with the work for Code Generation's accounting of a file put back.
    expect(keptWithWork(proj)?.map((file) => file.path)).toEqual(["src/app.js", "CHANGELOG.md"]);
  });

  test("the person's own edits, a teammate's pull and a generated file are never named", () => {
    proj = greeter();
    const remote = `${proj}-remote.git`;
    git(proj, ["clone", "-q", "--bare", proj, remote]);
    git(proj, ["remote", "add", "origin", remote]);
    git(proj, ["fetch", "-q", "origin"]);
    git(proj, ["branch", "-q", `--set-upstream-to=origin/${git(proj, ["branch", "--show-current"])}`]);
    const mate = `${proj}-teammate`;
    git(proj, ["clone", "-q", remote, mate]);
    writeFileSync(join(mate, "src", "farewell.js"), "console.log('bye');\n");
    git(mate, ["add", "-A"]);
    git(mate, ["commit", "-qm", "teammate"]);
    git(mate, ["push", "-q", "origin", "HEAD"]);
    appendFileSync(join(proj, "README.md"), "\nMy own note, not committed yet.\n");
    const ask = planQuestion(proj);
    writeFileSync(join(proj, "package.json"), '{\n  "name": "greeter",\n  "version": "0.2.0"\n}\n');
    git(proj, ["pull", "-q", "--ff-only"]);
    mkdirSync(join(proj, "gen"), { recursive: true });
    writeFileSync(join(proj, "gen", "app.bundle.js"), "/* generated */\n");
    expect(said(pick(proj, ask))).toBeNull();
    cleanupTestProject(remote);
    cleanupTestProject(mate);
  });

  test("beside the person's own changes, only the agent's edit is named", () => {
    proj = greeter();
    appendFileSync(join(proj, "README.md"), "\nMy own note, not committed yet.\n");
    const ask = planQuestion(proj);
    writeFileSync(join(proj, "package.json"), '{\n  "name": "greeter",\n  "version": "0.2.0"\n}\n');
    agentWrites(proj, "src/app.js", FIXED);
    expect(said(pick(proj, ask))).toBe(
      "Before this work started, src/app.js was changed; `git checkout HEAD -- src/app.js` puts it back as last committed.",
    );
  });

  test("a new file, a file holding the person's uncommitted edits, and an edit the agent undid itself", () => {
    proj = greeter();
    appendFileSync(join(proj, "README.md"), "\nMy own note, not committed yet.\n");
    const ask = planQuestion(proj);
    agentWrites(proj, "README.md", "# greeter\n");
    agentWrites(proj, "test/app.test.js", "broken\n");
    agentWrites(proj, "test/app.test.js", GREETER["test/app.test.js"]);
    agentWrites(proj, "src/greet.js", "module.exports = (n) => 'Hello, ' + n;\n");
    expect(said(pick(proj, ask))).toBe(
      "Before this work started, README.md and src/greet.js were changed; src/greet.js is new: delete it to undo that; " +
        "README.md already had changes that were not committed, so its change cannot be undone.",
    );
  });

  test("the agent committed its edit before the pick: the line names the commit that holds the file as it was", () => {
    proj = greeter();
    const before = git(proj, ["rev-parse", "HEAD"]);
    const ask = planQuestion(proj);
    agentWrites(proj, "src/app.js", FIXED);
    agentRuns(proj, "git add src/app.js && git commit -qm 'greet by name'");
    expect(said(pick(proj, ask))).toBe(
      `Before this work started, src/app.js was changed; \`git checkout ${before.slice(0, 12)} -- src/app.js\` puts it back as it was before.`,
    );
  });

  test("the agent staged its edit before the pick: the checkout names HEAD, so it puts the file back", () => {
    proj = greeter();
    const ask = planQuestion(proj);
    agentWrites(proj, "src/app.js", FIXED);
    agentRuns(proj, "git add src/app.js");
    expect(said(pick(proj, ask))).toBe(
      "Before this work started, src/app.js was changed; `git checkout HEAD -- src/app.js` puts it back as last committed.",
    );
    // The command does what the line says.
    git(proj, ["checkout", "HEAD", "--", "src/app.js"]);
    expect(readFileSync(join(proj, "src", "app.js"), "utf-8")).toBe(GREETER["src/app.js"]);
  });

  test("a plan typed with the request: an edit before the work starts is named, never as before a pick", () => {
    proj = greeter();
    typed(proj, `/aidlc bugfix ${WORDS}`);
    later();
    const start = next(proj, ["--scope", "bugfix", "--", WORDS]);
    const id = REQUEST.exec(String(start.message))?.[1];
    expect(String(start.message), JSON.stringify(start).slice(0, 300)).toContain("intent create");
    agentWrites(proj, "src/app.js", FIXED);
    const created = spawnSync(process.execPath, [
      join(TOOLS, "aidlc.ts"), "engine", "intent", "create", "--scope", "bugfix", "--request", id!, "--label", "greeter-fix",
      "--project-dir", proj,
    ], { cwd: proj, env: chatEnv(proj, SESSION), encoding: "utf-8" });
    expect(created.status, `${created.stdout}${created.stderr}`).toBe(0);
    guard(proj, SESSION, "Bash", { command: "bun .claude/tools/aidlc-orchestrate.ts next" });
    expect(said(JSON.stringify(next(proj, [])))).toBe(
      "Before this work started, src/app.js was changed; `git checkout HEAD -- src/app.js` puts it back as last committed.",
    );
  });

  test("a clean file under core.autocrlf reads as last committed", () => {
    proj = greeter();
    git(proj, ["config", "core.autocrlf", "true"]);
    writeFileSync(join(proj, "src", "app.js"), GREETER["src/app.js"].replaceAll("\n", "\r\n"));
    // Clean to git: the CRLF bytes are the committed LF blob (`git status` may still list it until the index is
    // refreshed, so content is what is compared).
    expect(git(proj, ["diff", "--stat", "--", "src/app.js"])).toBe("");
    const ask = planQuestion(proj);
    agentWrites(proj, "src/app.js", FIXED.replaceAll("\n", "\r\n"));
    expect(said(pick(proj, ask))).toBe(
      "Before this work started, src/app.js was changed; `git checkout HEAD -- src/app.js` puts it back as last committed.",
    );
  });

  test("a file in a repository nested in the project gets git -C", () => {
    proj = greeter();
    mkdirSync(join(proj, "lib"), { recursive: true });
    writeFileSync(join(proj, "lib", "util.js"), "module.exports = 1;\n");
    git(join(proj, "lib"), ["init", "-q"]);
    git(join(proj, "lib"), ["add", "-A"]);
    git(join(proj, "lib"), ["commit", "-qm", "lib"]);
    const ask = planQuestion(proj);
    agentWrites(proj, "lib/util.js", "module.exports = 2;\n");
    expect(said(pick(proj, ask))).toBe(
      "Before this work started, lib/util.js was changed; `git -C lib checkout HEAD -- util.js` puts it back as last committed.",
    );
  });

  test("a project outside git: named, and that it cannot be undone", () => {
    proj = greeter({ inGit: false });
    const ask = planQuestion(proj);
    agentWrites(proj, "src/app.js", FIXED);
    expect(said(pick(proj, ask))).toBe(
      "Before this work started, src/app.js was changed; src/app.js is not in git, so its change cannot be undone.",
    );
  });

  test("a project with earlier, finished work still names the agent's edit", () => {
    proj = greeter({ earlierWork: true });
    const ask = planQuestion(proj);
    agentWrites(proj, "src/app.js", FIXED);
    expect(said(pick(proj, ask))).toContain("src/app.js was changed; `git checkout HEAD -- src/app.js`");
  });

  test("beside work in progress: the plan question the person's new-work answer leads to is the window", () => {
    proj = greeter({ workInProgress: true });
    typed(proj, `/aidlc ${WORDS}`);
    later();
    const read = next(proj, ["--", WORDS]);
    const routing = next(proj, ["--request", REQUEST.exec(String(read.message))![1]]);
    expect(routing.ask_type, JSON.stringify(routing).slice(0, 300)).toBe("new-work-routing");
    later();
    typed(proj, "separate, it is new work");
    const command = String(routing.new_intent_command);
    const proposal = next(proj, command.slice(command.indexOf(" next ") + 6).split(" "));
    const ask = next(proj, ["--propose", "bugfix", "--request", REQUEST.exec(String(proposal.message))![1]]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 300)).toBe("scope-confirm");
    agentWrites(proj, "src/app.js", FIXED);
    expect(said(pick(proj, ask))).toBe(
      "Before this work started, src/app.js was changed; `git checkout HEAD -- src/app.js` puts it back as last committed.",
    );
  });

  test("another chat's agent writing is not this chat's: nothing is named at this chat's pick", () => {
    proj = greeter();
    const ask = planQuestion(proj);
    agentWrites(proj, "src/app.js", FIXED, OTHER);
    expect(said(pick(proj, ask))).toBeNull();
  });

  test("the pick made in a second chat names what the first chat's agent changed, there", () => {
    proj = greeter();
    const ask = planQuestion(proj);
    agentWrites(proj, "src/app.js", FIXED);
    expect(said(pick(proj, ask, OTHER))).toContain("src/app.js was changed;");
  });

  test("with no agent write before the pick, nothing is said and nothing is kept with the work", () => {
    proj = greeter();
    const ask = planQuestion(proj);
    expect(said(pick(proj, ask))).toBeNull();
    expect(keptWithWork(proj)).toBeNull();
  });

  test("Copilot CLI: its edit, as the CLI hands it to AI-DLC's hook (Edit with path), is said at the pick", () => {
    // The shipped Copilot tree, its adapter run for each host event, as in the live leg this payload was taken from.
    proj = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-early-edit-copilot-")));
    cpSync(join(REPO_ROOT, "dist", "copilot"), proj, { recursive: true });
    for (const [rel, text] of Object.entries(GREETER)) {
      mkdirSync(join(proj, rel, ".."), { recursive: true });
      writeFileSync(join(proj, rel), text);
    }
    git(proj, ["init", "-q"]);
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "greeter"]);
    const chat = "0f3c2a54-8d1e-4b6a-9c2f-5e7d1a2b3c4d";
    const env = { ...chatEnv(proj, chat), AIDLC_COPILOT_SESSION_ID: chat };
    const host = (target: string, payload: Record<string, unknown>): void => {
      const r = spawnSync(process.execPath, [join(proj, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target], {
        cwd: proj, env, encoding: "utf-8", input: JSON.stringify({ session_id: chat, cwd: proj, ...payload }),
      });
      expect(r.status, `${target}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout, target).not.toContain('"deny"');
    };
    const tools = join(proj, ".aidlc", "tools");
    const engine = (args: string[]): Directive => {
      host("guard-tool-call", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `bun .aidlc/tools/aidlc-orchestrate.ts next ${args.join(" ")}` } });
      const r = runOrchestrateNext(join(tools, "aidlc-orchestrate.ts"), proj, args, { cwd: proj, env });
      expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
      return r.directive as Directive;
    };
    host("session-start", { hook_event_name: "SessionStart", source: "new" });
    host("record-human-turn", { hook_event_name: "UserPromptSubmit", prompt: `/aidlc ${WORDS}` });
    later();
    const proposal = engine(["--", WORDS]);
    const ask = engine(["--propose", "bugfix", "--request", REQUEST.exec(String(proposal.message))![1]]);
    expect(ask.kind, JSON.stringify(ask).slice(0, 300)).toBe("ask");
    const confirm = String(ask.confirm_command);
    const id = REQUEST.exec(confirm)![1];
    host("guard-tool-call", {
      hook_event_name: "PreToolUse", tool_name: "Edit",
      tool_input: { path: join(proj, "src", "app.js"), old_str: "console.log('hello');", new_str: "console.log('Hello, ' + name + '!');" },
    });
    writeFileSync(join(proj, "src", "app.js"), FIXED);
    later();
    host("record-human-turn", { hook_event_name: "UserPromptSubmit", prompt: "1" });
    expect(String(engine(confirm.slice(confirm.indexOf(" next ") + 6).split(" ")).message)).toContain("intent create");
    const created = spawnSync(process.execPath, [
      join(tools, "aidlc.ts"), "engine", "intent", "create", "--scope", "bugfix", "--request", id, "--label", "greeter-fix",
      "--project-dir", proj,
    ], { cwd: proj, env, encoding: "utf-8" });
    expect(created.status, `${created.stdout}${created.stderr}`).toBe(0);
    expect(said(JSON.stringify(engine([])))).toBe(
      "Before this work started, src/app.js was changed; `git checkout HEAD -- src/app.js` puts it back as last committed.",
    );
  });
});
