// covers: function:keepWritesDuringWork, function:sayWritesDuringWork, hook:aidlc-plan-approval-guard
// covers: subcommand:aidlc-state:approve
//
// The person's files the agent changed while the work was still before Code
// Generation, at a stage that writes only AI-DLC's own records, are said once
// at that work's next approval, with the same way back the pick's line gives,
// and nothing is blocked (a Copilot CLI release journey on Windows Server: the
// agent changed src\app.js at the Requirements Analysis gate, after the plan
// pick and before any code plan, and only its own words said so). Each write
// goes through AI-DLC's PreToolUse guard, as the host runs it, and then
// happens; the person's own edits reach no hook and are never named. The
// guard's answer is the same as before in every case.

import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  resetAidlcEnv,
  runOrchestrateNext,
  seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(AIDLC_SRC, "tools");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const STATE = join(TOOLS, "aidlc-state.ts");
const CHAT = "01995000-7a11-7000-8000-00000000cbc1";
// Only the gate's own setup: the stage's files, review and handoffs are not what is tested.
const GATE_SETUP = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_DISABLE_ENSEMBLE_EVIDENCE: "1",
};
const LEAD = /During [A-Z][A-Za-z ]+?(?: and [A-Z][A-Za-z ]+?)?, /;

function chatEnv(proj: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: CHAT,
    AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0", CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, ...extra,
  };
  delete env.VSCODE_IPC_HOOK;
  delete env.VSCODE_PID;
  delete env.TERM_PROGRAM;
  return env;
}

function run(proj: string, args: string[], extra: Record<string, string> = {}): string {
  const r = spawnSync(process.execPath, [STATE, ...args, "--project-dir", proj], {
    cwd: proj, env: chatEnv(proj, extra), encoding: "utf-8",
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  return `${r.stdout}${r.stderr}`;
}

function next(proj: string, args: string[] = []): string {
  const r = runOrchestrateNext(join(TOOLS, "aidlc-orchestrate.ts"), proj, args, { cwd: proj, env: chatEnv(proj) });
  expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
  return JSON.stringify(r.directive);
}

function git(proj: string, args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=Person", "-c", "user.email=person@example.com", ...args], { cwd: proj, encoding: "utf-8" });
  expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

/** The person's line, through the prompt hook as the host runs it. */
function typed(proj: string, prompt: string): void {
  const r = spawnSync(process.execPath, [join(TOOLS, "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj, input: JSON.stringify({ session_id: CHAT, hook_event_name: "UserPromptSubmit", prompt }),
    env: chatEnv(proj), encoding: "utf-8",
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}
const later = (): void => Bun.sleepSync(1005 - (Date.now() % 1000));

/** AI-DLC's PreToolUse guard for one of the agent's calls, and its answer. */
function guardAnswer(proj: string, tool: string, input: Record<string, unknown>): number | null {
  return spawnSync(process.execPath, [GUARD], {
    cwd: proj, env: chatEnv(proj), encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: CHAT, cwd: proj, tool_name: tool, tool_input: input }),
  }).status;
}

/** The guard for a call before Code Generation: it lets every one of these through. */
function guard(proj: string, tool: string, input: Record<string, unknown>): void {
  expect(guardAnswer(proj, tool, input)).toBe(0);
}

/** The agent's file tool writing `rel`, its hooks first. */
function agentWrites(proj: string, rel: string, text: string): void {
  guard(proj, "Write", { file_path: join(proj, rel), content: text });
  mkdirSync(join(proj, rel, ".."), { recursive: true });
  writeFileSync(join(proj, rel), text);
}

/** The agent's shell command, its hooks first. */
function agentRuns(proj: string, command: string): void {
  guard(proj, "Bash", { command });
  const r = spawnSync("bash", ["-c", command], { cwd: proj, encoding: "utf-8" });
  expect(r.status, r.stderr).toBe(0);
}

const GREETER: Record<string, string> = {
  "README.md": "# greeter\n\nA tiny command-line greeter: `node src/app.js Ada` should print `Hello, Ada!`.\n",
  "src/app.js": "const name = process.argv[2];\nconsole.log('hello');\n",
  "CHANGELOG.md": "# Changelog\n",
};
const FIXED = "const name = process.argv[2];\nconsole.log('Hello, ' + name + '!');\n";

/** Bugfix work's record, Requirements Analysis running and going straight to Code Generation. */
function bugfixState(): string {
  let state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: bugfix")
    .replace(
      "- **Change Control**: strict (from scope feature)",
      "- **Guard Policy**: off (from scope bugfix)\n- **Plan Approval**: on (from scope bugfix)\n- **Review Override**: none",
    );
  // Requirements Analysis goes straight to Code Generation, as on bugfix.
  for (const slug of [
    "user-stories", "refined-mockups", "domain-design", "units-generation", "contract-design", "delivery-planning",
    "functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
  ]) {
    state = state.replace(new RegExp(`(- \\[ \\] ${slug} \\S+) EXECUTE`), "$1 SKIP");
  }
  return state;
}

/** That work at the gate of `at` (Requirements Analysis unless named), the person's greeter committed. */
function bugfixAtRequirements(at: "requirements-analysis" | "reverse-engineering" = "requirements-analysis"): string {
  const proj = createOrchestrationTestProject();
  let state = bugfixState();
  if (at === "reverse-engineering") {
    state = state.replace("- [x] reverse-engineering", "- [-] reverse-engineering")
      .replace("- [-] requirements-analysis", "- [ ] requirements-analysis")
      .replace("- **Current Stage**: requirements-analysis", "- **Current Stage**: reverse-engineering");
  }
  writeFileSync(seededStateFile(proj), state, "utf-8");
  for (const [rel, text] of Object.entries(GREETER)) {
    mkdirSync(join(proj, rel, ".."), { recursive: true });
    writeFileSync(join(proj, rel), text);
  }
  git(proj, ["init", "-q"]);
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-qm", "greeter"]);
  run(proj, ["gate-start", at], GATE_SETUP);
  return proj;
}

/** The person approves `stage`; the step after it, as the agent reads it. */
function approved(proj: string, stage = "requirements-analysis"): string {
  later();
  typed(proj, "Approve");
  run(proj, ["approve", stage, "--user-input", "Approve"], GATE_SETUP);
  return next(proj);
}

/** The work's record, rewritten as a stage's own tool would leave it (a jump, a Unit's build step). */
function setState(proj: string, edit: (state: string) => string): void {
  writeFileSync(seededStateFile(proj), edit(readFileSync(seededStateFile(proj), "utf-8")), "utf-8");
}

/** The record's own engine folder (`.aidlc-engine/<name>`), parsed, or null. */
function engineFile(proj: string, name: string): { files: Array<{ path: string }> } | null {
  const file = join(seededStateFile(proj), "..", ".aidlc-engine", name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) as { files: Array<{ path: string }> } : null;
}

/** The one line the person hears about it, from what the step carries for them. */
function said(step: string): string | null {
  const directive = JSON.parse(step) as { narration?: unknown; change_notices?: unknown };
  const text = [directive.narration, ...(Array.isArray(directive.change_notices) ? directive.change_notices : [])]
    .filter((part): part is string => typeof part === "string").join(" ");
  const at = LEAD.exec(text);
  if (at === null) return null;
  return /^.*?(?:last committed|was before|were before|to undo that|cannot be undone)\.(?=\s|$)/
    .exec(text.slice(at.index))?.[0] ?? null;
}

let proj = "";
beforeAll(() => resetAidlcEnv());
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

describe("t-changed-before-codegen: what the agent changed before Code Generation is said once at the next approval", () => {
  test("a file-tool edit and a shell append at the Requirements Analysis gate: named on the step after the approval, once", () => {
    proj = bugfixAtRequirements();
    agentWrites(proj, "src/app.js", FIXED);
    agentRuns(proj, "echo 'fixed greeting' >> CHANGELOG.md");
    expect(said(approved(proj))).toBe(
      "During Requirements Analysis, src/app.js and CHANGELOG.md were changed; " +
        "`git checkout -- src/app.js CHANGELOG.md` puts them back as last committed.",
    );
    expect(said(next(proj))).toBeNull();
    // What they held before, kept with the work, so a file put back is nobody's change in Code Generation's accounting.
    expect(engineFile(proj, "before-pick.json")?.files.map((file) => file.path)).toEqual(["src/app.js", "CHANGELOG.md"]);
    expect(engineFile(proj, "during-work.json")).toBeNull();
    // Code Generation writes the person's code: nothing written there is kept for this line, whatever the guard says.
    guardAnswer(proj, "Write", { file_path: join(proj, "src", "app.js"), content: `${FIXED}// built\n` });
    expect(engineFile(proj, "during-work.json")).toBeNull();
  });

  test("through the agent's own report of the approval, as it records it", () => {
    proj = bugfixAtRequirements();
    agentWrites(proj, "src/app.js", FIXED);
    later();
    typed(proj, "Approve");
    const r = spawnSync(process.execPath, [
      join(TOOLS, "aidlc-orchestrate.ts"), "report", "--stage", "requirements-analysis", "--result", "approved",
      "--user-input", "Approve", "--project-dir", proj,
    ], { cwd: proj, env: chatEnv(proj, GATE_SETUP), encoding: "utf-8" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const step = `${r.stdout}`.includes("src/app.js was changed") ? r.stdout.trim().split("\n").at(-1) ?? "" : next(proj);
    expect(said(step)).toBe(
      "During Requirements Analysis, src/app.js was changed; `git checkout -- src/app.js` puts it back as last committed.",
    );
  });

  test("the person's own edit, a teammate's pull, and the agent's edit it put back itself are never named", () => {
    proj = bugfixAtRequirements();
    const remote = `${proj}-remote.git`;
    git(proj, ["clone", "-q", "--bare", proj, remote]);
    git(proj, ["remote", "add", "origin", remote]);
    git(proj, ["fetch", "-q", "origin"]);
    const branch = git(proj, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const mate = `${proj}-mate`;
    git(proj, ["clone", "-q", remote, mate]);
    writeFileSync(join(mate, "src", "farewell.js"), "console.log('bye');\n");
    git(mate, ["add", "-A"]);
    git(mate, ["commit", "-qm", "teammate: farewell"]);
    git(mate, ["push", "-q", "origin", `HEAD:${branch}`]);
    writeFileSync(join(proj, "README.md"), `${GREETER["README.md"]}\nMy own note.\n`);
    git(proj, ["pull", "-q", "--ff-only", "origin", branch]);
    agentWrites(proj, "CHANGELOG.md", "# Changelog\n\n- fixed\n");
    agentWrites(proj, "CHANGELOG.md", GREETER["CHANGELOG.md"]);
    expect(said(approved(proj))).toBeNull();
    expect(engineFile(proj, "during-work.json")).toBeNull();
  });

  test("a new file is to be deleted; a file that held the person's uncommitted edits cannot be undone", () => {
    proj = bugfixAtRequirements();
    writeFileSync(join(proj, "README.md"), `${GREETER["README.md"]}\nMy own note.\n`);
    agentWrites(proj, "README.md", `${GREETER["README.md"]}\nMy own note.\n\nFixed.\n`);
    agentWrites(proj, "src/greet.js", "module.exports = (name) => 'Hello, ' + name + '!';\n");
    expect(said(approved(proj))).toBe(
      "During Requirements Analysis, README.md and src/greet.js were changed; src/greet.js is new: delete it to undo " +
        "that; README.md already had changes that were not committed, so its change cannot be undone.",
    );
  });

  test("a rejection, then the approval: named once, at the approval", () => {
    proj = bugfixAtRequirements();
    agentWrites(proj, "src/app.js", FIXED);
    later();
    typed(proj, "Request changes: say which names are allowed");
    run(proj, ["reject", "requirements-analysis", "--user-input", "Request Changes", "--feedback=say which names are allowed"], GATE_SETUP);
    expect(said(next(proj))).toBeNull();
    run(proj, ["revise", "requirements-analysis"], GATE_SETUP);
    expect(said(approved(proj))).toBe(
      "During Requirements Analysis, src/app.js was changed; `git checkout -- src/app.js` puts it back as last committed.",
    );
  });

  test("each approval names what changed since the last one; a stage left by a jump is named with the next", () => {
    proj = bugfixAtRequirements("reverse-engineering");
    agentWrites(proj, "src/app.js", FIXED);
    expect(said(approved(proj, "reverse-engineering"))).toBe(
      "During Reverse Engineering, src/app.js was changed; `git checkout -- src/app.js` puts it back as last committed.",
    );
    agentRuns(proj, "echo 'fixed greeting' >> CHANGELOG.md");
    run(proj, ["gate-start", "requirements-analysis"], GATE_SETUP);
    expect(said(approved(proj))).toBe(
      "During Requirements Analysis, CHANGELOG.md was changed; `git checkout -- CHANGELOG.md` puts it back as last committed.",
    );

    cleanupTestProject(proj);
    proj = bugfixAtRequirements("reverse-engineering");
    agentWrites(proj, "src/app.js", FIXED);
    // The person jumps on to Requirements Analysis: no approval between.
    setState(proj, (state) => state.replace("- [?] reverse-engineering", "- [S] reverse-engineering")
      .replace("- [ ] requirements-analysis", "- [-] requirements-analysis")
      .replace("- **Current Stage**: reverse-engineering", "- **Current Stage**: requirements-analysis"));
    agentRuns(proj, "echo 'fixed greeting' >> CHANGELOG.md");
    run(proj, ["gate-start", "requirements-analysis"], GATE_SETUP);
    expect(said(approved(proj))).toBe(
      "During Reverse Engineering and Requirements Analysis, src/app.js and CHANGELOG.md were changed; " +
        "`git checkout -- src/app.js CHANGELOG.md` puts them back as last committed.",
    );
  });

  test("a jump into Code Generation after the agent's edit: nothing said at Code Generation's approval", () => {
    proj = bugfixAtRequirements();
    agentWrites(proj, "src/app.js", FIXED);
    expect(engineFile(proj, "during-work.json")?.files.map((file) => file.path)).toEqual(["src/app.js"]);
    setState(proj, (state) => state.replace("- [?] requirements-analysis", "- [S] requirements-analysis")
      .replace("- [ ] code-generation", "- [-] code-generation")
      .replace("- **Current Stage**: requirements-analysis", "- **Current Stage**: code-generation"));
    run(proj, ["gate-start", "code-generation"], GATE_SETUP);
    later();
    typed(proj, "Approve");
    run(proj, ["approve", "code-generation", "--user-input", "Approve"], GATE_SETUP);
    expect(said(next(proj))).toBeNull();
    expect(engineFile(proj, "during-work.json")).toBeNull();
  });

  test("unit-major: a write while a Unit builds, or between its build steps, is never kept", () => {
    proj = bugfixAtRequirements();
    // Current Stage stays on the first per-Unit stage while the Unit works through Code Generation.
    setState(proj, (state) => state.replace("- [?] requirements-analysis", "- [x] requirements-analysis")
      .replace("- [ ] functional-design \u2014 SKIP", "- [-] functional-design \u2014 EXECUTE")
      .replace("- **Current Stage**: requirements-analysis", "- **Current Stage**: functional-design")
      .replace("## Runtime State", "## Runtime State\n- **Active Unit**: saved-search\n- **Unit Stage**: code-generation"));
    agentWrites(proj, "src/app.js", FIXED);
    expect(engineFile(proj, "during-work.json")).toBeNull();
    // Between its build steps the Unit fields are gone; the step the engine issued last is the build's.
    setState(proj, (state) => state.replace("- **Current Stage**: functional-design", "- **Current Stage**: code-generation")
      .replace("- [-] functional-design", "- [x] functional-design").replace("- [ ] code-generation", "- [-] code-generation")
      .replace(/- \*\*(Active Unit|Unit Stage)\*\*: .*\n/g, ""));
    next(proj);
    setState(proj, (state) => state.replace("- **Current Stage**: code-generation", "- **Current Stage**: functional-design"));
    agentWrites(proj, "CHANGELOG.md", "# Changelog\n\n- built\n");
    expect(engineFile(proj, "during-work.json")).toBeNull();
  });

  test("Copilot CLI: its edit during Reverse Engineering, as the CLI hands it to AI-DLC's hook, is said at the approval", () => {
    // The shipped Copilot tree, its adapter run for each host event.
    proj = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-cbc-copilot-")));
    cpSync(join(REPO_ROOT, "dist", "copilot"), proj, { recursive: true });
    for (const [rel, text] of Object.entries(GREETER)) {
      mkdirSync(join(proj, rel, ".."), { recursive: true });
      writeFileSync(join(proj, rel), text);
    }
    git(proj, ["init", "-q"]);
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-qm", "greeter"]);
    const chat = "0f3c2a54-8d1e-4b6a-9c2f-5e7d1a2b3cbc";
    const env = { ...chatEnv(proj, { AIDLC_SESSION_OVERRIDE: chat }), AIDLC_COPILOT_SESSION_ID: chat };
    const host = (target: string, payload: Record<string, unknown>): void => {
      const r = spawnSync(process.execPath, [join(proj, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target], {
        cwd: proj, env, encoding: "utf-8", input: JSON.stringify({ session_id: chat, cwd: proj, ...payload }),
      });
      expect(r.status, `${target}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout, target).not.toContain('"deny"');
    };
    const tools = join(proj, ".aidlc", "tools");
    const engine = (args: string[]): string => {
      host("guard-tool-call", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `bun .aidlc/tools/aidlc-orchestrate.ts next ${args.join(" ")}` } });
      const r = runOrchestrateNext(join(tools, "aidlc-orchestrate.ts"), proj, args, { cwd: proj, env });
      expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
      return JSON.stringify(r.directive);
    };
    const state = (args: string[]): void => {
      const r = spawnSync(process.execPath, [join(tools, "aidlc-state.ts"), ...args, "--project-dir", proj], {
        cwd: proj, env: { ...env, ...GATE_SETUP }, encoding: "utf-8",
      });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    };
    host("session-start", { hook_event_name: "SessionStart", source: "new" });
    host("record-human-turn", { hook_event_name: "UserPromptSubmit", prompt: "/aidlc fix the greeter" });
    const created = spawnSync(process.execPath, [
      join(tools, "aidlc.ts"), "engine", "intent", "create", "--scope", "bugfix", "--label", "greeter-fix", "--project-dir", proj,
    ], { cwd: proj, env, encoding: "utf-8" });
    expect(created.status, `${created.stdout}${created.stderr}`).toBe(0);
    engine([]);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = join(intents, readdirSync(intents).find((name) => existsSync(join(intents, name, "aidlc-state.md")))!);
    const stage = /\*\*Current Stage\*\*: (\S+)/.exec(readFileSync(join(record, "aidlc-state.md"), "utf-8"))![1];
    expect(stage).toBe("reverse-engineering");
    host("guard-tool-call", {
      hook_event_name: "PreToolUse", tool_name: "Edit",
      tool_input: { path: join(proj, "src", "app.js"), old_str: "console.log('hello');", new_str: "console.log('Hello, ' + name + '!');" },
    });
    writeFileSync(join(proj, "src", "app.js"), FIXED);
    state(["gate-start", stage]);
    later();
    host("record-human-turn", { hook_event_name: "UserPromptSubmit", prompt: "Approve" });
    state(["approve", stage, "--user-input", "Approve"]);
    expect(said(engine([]))).toBe(
      "During Reverse Engineering, src/app.js was changed; `git checkout -- src/app.js` puts it back as last committed.",
    );
  });
});
