// covers: subcommand:aidlc-orchestrate:next, function:planProposalDirective, function:freshWorkOfferDirective, function:nextFlagShape
//
// The plan for a request the person typed in their own words is proposed by the
// agent, not matched from a keyword list. `next "<request>"` on a workspace
// with no plan named keeps the request as a question and returns one print for
// the agent: the request, every plan this install ships (its length here,
// whether it splits the work into Units, what it is for, its author's hints)
// and the two commands that answer it. The agent
// runs `next --propose <plan> --request <id>` (or `--propose compose`) and the
// engine renders the same plan question the person always got, with that plan,
// so their yes still runs the exact prebuilt creation command. Before, a
// keyword list in the engine picked the plan: "deploy the site to staging" was
// infra by the word deploy, "it's broken" was bugfix, and "The password reset
// link is broken, it goes to a 404" got the compose offer with no plan at all.
// Every path here also runs the chain the agent is told to follow: one
// question for the person within three engine calls, never the same print
// twice, and the question asked once.

import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { getField, hooksHealthDir, loadScopeMapping, nextFlagShape, readAuditShardEvents, splitKiroCommandArgs, validScopes } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { nextArgsAreOnlyWords, parseNextFlags } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import {
  AIDLC_SRC,
  REPO_ROOT,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  planOffer,
  removeWorkspaceRecord,
  resetAidlcEnv,
  runOrchestrateNext,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const CLAUDE_TOOLS = join(AIDLC_SRC, "tools");
const KIRO_TOOLS = join(REPO_ROOT, "dist", "kiro", ".kiro", "tools");
const ORCH = join(CLAUDE_TOOLS, "aidlc-orchestrate.ts");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");
const COMPLETED = join(FIXTURES_DIR, "state-completed.md");

type Directive = Record<string, unknown> & {
  kind?: string;
  ask_type?: string;
  message?: string;
  question?: string;
  proposed_scope?: string;
  confirm_command?: string;
  compose_command?: string;
  new_intent_command?: string;
  scope_commands?: Array<{ scope: string; command: string; stages?: string }>;
};

const REQUEST = /--request ([0-9a-f]{8})/;
const PROPOSAL = "--propose <plan> --request";

function next(tools: string, proj: string, args: string[], env: NodeJS.ProcessEnv = { ...process.env }): Directive {
  const r = runOrchestrateNext(join(tools, "aidlc-orchestrate.ts"), proj, args, { cwd: proj, env });
  expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
  return r.directive as Directive;
}

function reply(proj: string, prompt: string, session: string): void {
  const r = spawnSync(process.execPath, [join(CLAUDE_TOOLS, "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
    env: { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: session, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

function answerArgs(command: unknown): string[] {
  const text = String(command);
  return text.slice(text.indexOf(" next ") + 6).split(" ");
}

/**
 * The creation the plan question's yes names, run as the agent runs it (where
 * work exists but none is selected, the yes meets the question of which piece
 * this is first; it is a separate new piece): the new work exists and is selected.
 */
function createFromConfirm(proj: string, ask: Directive, env: NodeJS.ProcessEnv = { ...process.env }): string {
  let created = next(CLAUDE_TOOLS, proj, answerArgs(ask.confirm_command), env);
  if (created.kind === "ask" && created.new_intent_command !== undefined) created = next(CLAUDE_TOOLS, proj, answerArgs(created.new_intent_command), env);
  expect(created.kind, JSON.stringify(created).slice(0, 300)).toBe("print");
  const id = REQUEST.exec(String(created.message))![1];
  const made = spawnSync(process.execPath, [join(CLAUDE_TOOLS, "aidlc-utility.ts"), "intent-create", "--scope", String(ask.proposed_scope), "--request", id, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
    env: { ...env, CLAUDE_PROJECT_DIR: proj },
  });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  return id;
}

function questionTexts(proj: string): Array<{ id: string; text: string; proposedScope: string; origin: string; settings?: unknown; answeredBy?: string }> {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")));
}

/**
 * The chain the agent follows from a request: the proposal print answered with
 * `plan`, a none-selected or words-alone print answered with its "new work"
 * reading plus the plan, until a step that is not a print. Within three engine
 * calls, never the same print twice.
 */
function follow(tools: string, proj: string, args: string[], plan: string, env: NodeJS.ProcessEnv = { ...process.env }): { last: Directive; calls: number } {
  const prints: string[] = [];
  let d = next(tools, proj, args, env);
  let calls = 1;
  while (d.kind === "print") {
    const message = String(d.message);
    expect(prints, `the same print twice: ${message.slice(0, 160)}`).not.toContain(message);
    prints.push(message);
    expect(calls, `a third print instead of a step: ${message.slice(0, 160)}`).toBeLessThan(3);
    const id = REQUEST.exec(message)?.[1];
    expect(id, message.slice(0, 200)).toBeDefined();
    d = message.includes(PROPOSAL)
      ? next(tools, proj, ["--propose", plan, "--request", id!], env)
      : next(tools, proj, ["--request", id!, "--propose", plan], env);
    calls++;
  }
  expect(calls).toBeLessThanOrEqual(3);
  return { last: d, calls };
}

function fresh(): string {
  const proj = createTestProject();
  removeWorkspaceRecord(proj);
  return proj;
}

function activeProject(): string {
  const proj = createOrchestrationTestProject();
  seedStateFile(proj, MID_IDEATION);
  return proj;
}

function cloneWithWork(tools: string): string {
  const proj = createTestProject();
  removeWorkspaceRecord(proj);
  for (const scope of ["poc", "feature"]) {
    const r = spawnSync(process.execPath, [join(tools, "aidlc-utility.ts"), "intent-create", "--scope", scope, "--project-dir", proj], {
      cwd: proj,
      encoding: "utf-8",
      env: { ...process.env },
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  }
  rmSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), { force: true });
  return proj;
}

let proj = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

describe("t-plan-proposed-by-the-agent: no keyword list", () => {
  test("the engine keeps no classifier over the person's words", async () => {
    const utility = (await import("../../core/tools/aidlc-utility.ts")) as Record<string, unknown>;
    expect(utility.inferScopeFromText).toBeUndefined();
    expect(typeof utility.findScopeByKeyword).toBe("function");
  });

  test("--propose takes every plan this install ships, and compose, read at call time", () => {
    const shape = nextFlagShape("--propose");
    expect(shape?.value).toBe("words");
    expect(shape?.value === "words" ? shape.words : []).toEqual([...validScopes(), "compose"]);
  });
});

describe("t-plan-proposed-by-the-agent: a fresh workspace", () => {
  const REQUEST_TEXT = "security review of the login";

  test("words with no plan named return the proposal step for the agent, never the plan question at once", () => {
    proj = fresh();
    const before = readAuditShardEvents(proj).length;
    const d = next(CLAUDE_TOOLS, proj, [REQUEST_TEXT]);
    const note = JSON.stringify(d).slice(0, 400);
    expect(d.kind, note).toBe("print");
    expect(d.ask_type, note).toBeUndefined();
    expect(d.narration, note).toBeUndefined();
    const message = String(d.message);
    expect(message).toContain(`"${REQUEST_TEXT}"`);
    expect(message).toContain(PROPOSAL);
    expect(message).toContain("--propose compose --request");
    expect(message).not.toContain("This looks like");
    for (const scope of validScopes()) expect(message).toMatch(new RegExp(`${scope} \\(\\d+ stages?(, [^)]*)?\\):`));
    expect(message).toContain("hints: fix, bug, broken, bugfix");
    const kept = questionTexts(proj);
    expect(kept.map((q) => q.text)).toContain(REQUEST_TEXT);
    expect(kept.find((q) => q.text === REQUEST_TEXT)?.proposedScope).toBe("");
    expect(readAuditShardEvents(proj).length).toBe(before);
  });

  // "Fix the two bugs as two units side by side" got bugfix, which builds in
  // one piece: the list never said which plans have Units. Each plan says it
  // from its own stages; reading the request stays the agent's.
  test("the plans list says which plans split the work into Units, from each plan's own stages", () => {
    proj = fresh();
    const message = String(next(CLAUDE_TOOLS, proj, ["fix two bugs, as two units side by side"]).message);
    const scopes = loadScopeMapping();
    for (const scope of validScopes()) {
      const marked = new RegExp(`(^|/ |Plans: )${scope} \\(\\d+ stages?, splits the work into Units\\):`).test(message);
      expect(marked, scope).toBe(scopes[scope]?.stages["units-generation"] === "EXECUTE");
    }
    expect(message).toMatch(/classic \(\d+ stages, splits the work into Units\):/);
    expect(message).toMatch(/bugfix \(\d+ stages\):/);
  });

  test("the proposal step re-run with its request is the same step: same id, same print", () => {
    proj = fresh();
    const first = next(CLAUDE_TOOLS, proj, [REQUEST_TEXT]);
    const id = REQUEST.exec(String(first.message))?.[1];
    expect(id).toBeDefined();
    const again = next(CLAUDE_TOOLS, proj, ["--request", id!]);
    expect(again).toEqual(first);
    expect(questionTexts(proj).filter((q) => q.text === REQUEST_TEXT)).toHaveLength(1);
  });

  test("the agent's plan builds the plan question with it, and the person's yes is the same prebuilt command", () => {
    proj = fresh();
    const first = next(CLAUDE_TOOLS, proj, [REQUEST_TEXT]);
    const id = REQUEST.exec(String(first.message))![1];
    const ask = next(CLAUDE_TOOLS, proj, ["--propose", "security-patch", "--request", id]);
    const note = JSON.stringify(ask).slice(0, 500);
    expect(ask.kind, note).toBe("ask");
    expect(ask.ask_type, note).toBe("scope-confirm");
    expect(ask.proposed_scope).toBe("security-patch");
    expect(String(ask.question)).toContain(`I'd run the "security-patch" plan for: "${REQUEST_TEXT}"`);
    expect(String(ask.question)).toMatch(/\d+ stages?/);
    expect(String(ask.question)).toContain("go ahead with it, use a different plan, or tailor one to this task?");
    expect(String(ask.question)).not.toContain("This looks like");
    expect(String(ask.confirm_command)).toMatch(/next --scope security-patch --request [0-9a-f]{8}$/);
    expect(String(ask.compose_command)).toMatch(/next compose --request [0-9a-f]{8}$/);
    expect(ask.scope_commands?.map((row) => row.scope)).toEqual([...validScopes()]);
    for (const row of ask.scope_commands ?? []) expect(row.stages).toMatch(/^\d+ stages?$/);
    const created = next(CLAUDE_TOOLS, proj, String(ask.confirm_command).split(" ").slice(String(ask.confirm_command).split(" ").indexOf("next") + 1));
    expect(created.kind, JSON.stringify(created).slice(0, 300)).toBe("print");
    expect(String(created.message)).toContain("intent create --scope security-patch --request");
  });

  test("the compose proposal is the compose offer, as before", () => {
    proj = fresh();
    const ask = planOffer(ORCH, proj, ["The password reset link is broken, it goes to a 404"], "compose").directive as Directive;
    expect(ask.kind, JSON.stringify(ask).slice(0, 300)).toBe("ask");
    expect(ask.ask_type).toBe("compose-offer");
    expect(String(ask.question)).toContain("None of the ready-made plans is an obvious fit for:");
    expect(String(ask.compose_command)).toMatch(/next compose --request [0-9a-f]{8}$/);
    expect(ask.scope_commands?.map((row) => row.scope)).toEqual([...validScopes()]);
  });

  test("the plan the agent proposes is its reading, not a word's: a bug report gets bugfix, a deployment gets infra", () => {
    proj = fresh();
    const bug = planOffer(ORCH, proj, ["The password reset link is broken, it goes to a 404"], "bugfix").directive as Directive;
    expect(bug.ask_type, JSON.stringify(bug).slice(0, 300)).toBe("scope-confirm");
    expect(bug.proposed_scope).toBe("bugfix");
    cleanupTestProject(proj);
    proj = fresh();
    const deploy = planOffer(ORCH, proj, ["deploy the site to staging"], "feature").directive as Directive;
    expect(deploy.ask_type, JSON.stringify(deploy).slice(0, 300)).toBe("scope-confirm");
    expect(deploy.proposed_scope).toBe("feature");
  });

  test("settings typed with the request ride the proposal and the plan question's commands", () => {
    proj = fresh();
    const first = next(CLAUDE_TOOLS, proj, ["--depth", "minimal", "--learnings", "off", "fix the login"]);
    expect(first.kind, JSON.stringify(first).slice(0, 300)).toBe("print");
    expect(String(first.message)).toContain(PROPOSAL);
    const id = REQUEST.exec(String(first.message))![1];
    expect(questionTexts(proj).find((q) => q.id === id)?.settings).toBeDefined();
    const ask = next(CLAUDE_TOOLS, proj, ["--propose", "bugfix", "--request", id]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 300)).toBe("scope-confirm");
    const commands = [String(ask.confirm_command), String(ask.compose_command), ...(ask.scope_commands ?? []).map((row) => row.command)];
    for (const command of commands) expect(command).toContain("--depth minimal --learnings off");
  });

  test("a plan the table does not hold is the value reading step, said to the agent", () => {
    proj = fresh();
    const first = next(CLAUDE_TOOLS, proj, [REQUEST_TEXT]);
    const id = REQUEST.exec(String(first.message))![1];
    const d = next(CLAUDE_TOOLS, proj, ["--propose", "banana", "--request", id]);
    expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
    expect(String(d.message)).toContain("`--propose` with");
    expect(String(d.message)).toContain("compose");
    expect(String(d.message)).not.toContain("I could not read");
  });

  test("--propose with no plan, or with no request, is a print for the agent, never an error", () => {
    proj = fresh();
    const noValue = next(CLAUDE_TOOLS, proj, ["--propose"]);
    expect(noValue.kind, JSON.stringify(noValue).slice(0, 300)).toBe("print");
    expect(String(noValue.message)).toContain("needs the plan to propose");
    const noRequest = next(CLAUDE_TOOLS, proj, ["--propose", "bugfix"]);
    expect(noRequest.kind, JSON.stringify(noRequest).slice(0, 300)).toBe("print");
    expect(String(noRequest.message)).toContain("needs its request");
    for (const d of [noValue, noRequest]) {
      expect(d.narration).toBeUndefined();
      expect(JSON.stringify(d)).not.toContain('"kind":"error"');
    }
  });

  test("the chain ends in the plan question within three engine calls", () => {
    proj = fresh();
    const chain = follow(CLAUDE_TOOLS, proj, ["build a notes app"], "feature");
    expect(chain.last.ask_type, JSON.stringify(chain.last).slice(0, 300)).toBe("scope-confirm");
    expect(chain.calls).toBe(2);
  });
});

describe("t-plan-proposed-by-the-agent: finished work and new work beside active work", () => {
  test("words over finished work get the proposal step, then the plan question", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, COMPLETED);
    expect(next(CLAUDE_TOOLS, proj, []).kind).toBe("done");
    const chain = follow(CLAUDE_TOOLS, proj, ["add CSV export"], "feature");
    expect(chain.last.ask_type, JSON.stringify(chain.last).slice(0, 300)).toBe("scope-confirm");
    expect(String(chain.last.question)).toContain('"add CSV export"');
    expect(chain.calls).toBe(2);
  });

  test("--new-intent with no plan gets the proposal step; the plan question's yes creates the new work", () => {
    proj = activeProject();
    const first = next(CLAUDE_TOOLS, proj, ["--new-intent", "add CSV export"]);
    expect(first.kind, JSON.stringify(first).slice(0, 300)).toBe("print");
    expect(String(first.message)).toContain(PROPOSAL);
    const id = REQUEST.exec(String(first.message))![1];
    const ask = next(CLAUDE_TOOLS, proj, ["--propose", "feature", "--request", id]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 300)).toBe("scope-confirm");
    const confirm = String(ask.confirm_command);
    const created = next(CLAUDE_TOOLS, proj, confirm.split(" ").slice(confirm.split(" ").indexOf("next") + 1));
    expect(created.kind, JSON.stringify(created).slice(0, 300)).toBe("print");
    expect(String(created.message)).toContain("intent create --scope feature --request");
  });

  test("words beside active work: the agent's plan rides the routing question, which names it", () => {
    proj = activeProject();
    const read = next(CLAUDE_TOOLS, proj, ["add CSV export"]);
    expect(read.kind, JSON.stringify(read).slice(0, 300)).toBe("print");
    expect(String(read.message)).toContain("add `--propose <plan>`");
    const id = REQUEST.exec(String(read.message))![1];
    const ask = next(CLAUDE_TOOLS, proj, ["--request", id, "--propose", "feature"]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 300)).toBe("new-work-routing");
    expect(ask.proposed_scope).toBe("feature");
    expect(String(ask.question)).toContain('as "feature" work');
    expect(String(ask.new_intent_command)).toContain("--new-intent --scope feature --request");
  });

  test("with no plan proposed, the routing question says the plan comes next, and that answer reaches the proposal step", () => {
    proj = activeProject();
    const read = next(CLAUDE_TOOLS, proj, ["add CSV export"]);
    const id = REQUEST.exec(String(read.message))![1];
    const ask = next(CLAUDE_TOOLS, proj, ["--request", id]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 300)).toBe("new-work-routing");
    expect(ask.proposed_scope).toBe("");
    expect(String(ask.question)).toContain("you pick its plan next");
    expect(String(ask.new_intent_command)).not.toContain("--scope");
    const command = String(ask.new_intent_command);
    const step = next(CLAUDE_TOOLS, proj, command.split(" ").slice(command.split(" ").indexOf("next") + 1));
    expect(step.kind, JSON.stringify(step).slice(0, 300)).toBe("print");
    expect(String(step.message)).toContain(PROPOSAL);
    // The agent's plan answers the new-work question that answer derived, never
    // the routing question again: the plan question, then creation.
    const stepId = REQUEST.exec(String(step.message))![1];
    expect(stepId).not.toBe(id);
    const plan = next(CLAUDE_TOOLS, proj, ["--propose", "feature", "--request", stepId]);
    expect(plan.ask_type, JSON.stringify(plan).slice(0, 300)).toBe("scope-confirm");
    const confirm = String(plan.confirm_command);
    const created = next(CLAUDE_TOOLS, proj, confirm.split(" ").slice(confirm.split(" ").indexOf("next") + 1));
    expect(created.kind, JSON.stringify(created).slice(0, 300)).toBe("print");
    expect(String(created.message)).toContain("intent create --scope feature --request");
  });
});

describe("t-plan-proposed-by-the-agent: work here but none selected", () => {
  for (const [harness, tools] of [["claude", CLAUDE_TOOLS], ["kiro", KIRO_TOOLS]] as const) {
    test(`${harness}: the none-selected reading, the agent's plan, then one question, within three calls`, () => {
      proj = cloneWithWork(tools);
      const chain = follow(tools, proj, ["fix the login"], "bugfix");
      const note = JSON.stringify(chain.last).slice(0, 400);
      expect(chain.last.kind, note).toBe("ask");
      expect(chain.calls).toBeLessThanOrEqual(3);
      if (harness === "kiro") {
        // Kiro's routing harness asks which work it belongs to first, naming the plan.
        expect(chain.last.ask_type, note).toBe("new-work-routing");
        expect(chain.last.proposed_scope).toBe("bugfix");
        expect(String(chain.last.question)).toContain('as "bugfix" work');
      } else {
        expect(chain.last.ask_type, note).toBe("scope-confirm");
        expect(chain.last.proposed_scope).toBe("bugfix");
      }
    });
  }

  test("kiro: without a proposed plan the pick question says the plan comes next", () => {
    proj = cloneWithWork(KIRO_TOOLS);
    const read = next(KIRO_TOOLS, proj, ["fix the login"]);
    const id = REQUEST.exec(String(read.message))![1];
    const ask = next(KIRO_TOOLS, proj, ["--request", id]);
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 300)).toBe("new-work-routing");
    expect(String(ask.question)).toContain("you pick its plan next");
    expect(String(ask.new_intent_command)).not.toContain("--scope");
  });
});

// #2359 F1 and F4: a line that opens with a plan's name and goes on in words
// keeps every word, and the agent reads which they meant: the both-readings
// print names the pick (`--scope <plan> -- '<rest>'`, which creates with no
// question) and their words whole. No count of words decides it. The forms
// that can only be a pick stay one: the plan's name alone, in its own argument
// with the request in one more, with a colon, `--scope`, and `--propose`.
describe("t-plan-proposed-by-the-agent: a line that opens with a plan's name keeps every word, and the agent reads it", () => {
  const LINE = ["fix", "the", "login", "crash", "when", "the", "session", "expires"];
  const BOTH = "is the name of a plan and also the first word of what the person typed";
  const commandAfter = (message: unknown, lead: RegExp): string[] => {
    const command = new RegExp(`\`([^\`]* next ${lead.source}[^\`]*)\``).exec(String(message))?.[1];
    expect(command, String(message)).toBeDefined();
    return splitKiroCommandArgs(command!.slice(command!.indexOf(" next ") + 6));
  };

  test("`/aidlc bugfix fix the login`: the agent's pick reading creates bugfix for \"fix the login\", and nobody is asked", () => {
    proj = fresh();
    const d = next(CLAUDE_TOOLS, proj, ["bugfix", "fix", "the", "login"]);
    expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
    expect(d.ask_type).toBeUndefined();
    expect(String(d.message)).toContain(`\`bugfix\` ${BOTH}`);
    // The engine kept nothing of theirs yet: the agent reads the line first.
    expect(questionTexts(proj)).toEqual([]);
    const created = next(CLAUDE_TOOLS, proj, commandAfter(d.message, /--scope bugfix --/));
    expect(created.kind, JSON.stringify(created).slice(0, 300)).toBe("print");
    expect(String(created.message)).toContain("intent create --scope bugfix --request");
    expect(questionTexts(proj).map((q) => q.text)).toEqual(["fix the login"]);
  });

  test("`/aidlc classic car rental website`, split or in one argument: both readings, every word kept, and the words reading reaches the proposal step whole", () => {
    for (const argv of [["classic", "car", "rental", "website"], ["classic car rental website"]]) {
      proj = fresh();
      const d = next(CLAUDE_TOOLS, proj, argv);
      expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
      expect(String(d.message)).toContain(`\`classic\` ${BOTH}`);
      expect(String(d.message)).toContain("-- 'classic car rental website'");
      expect(String(d.message)).toContain("--scope classic -- 'car rental website'");
      expect(questionTexts(proj)).toEqual([]);
      const theirs = next(CLAUDE_TOOLS, proj, commandAfter(d.message, /-- 'classic/));
      expect(theirs.kind, JSON.stringify(theirs).slice(0, 300)).toBe("print");
      expect(String(theirs.message)).toContain(PROPOSAL);
      expect(String(theirs.message)).toContain('"classic car rental website"');
      expect(questionTexts(proj).map((q) => q.text)).toEqual(["classic car rental website"]);
      cleanupTestProject(proj);
    }
    proj = "";
  });

  test("the forms that can only be a pick stay one; every other line that opens with a plan's name is both readings, at any length", () => {
    const parse = (argv: string[]) => {
      const parsed = parseNextFlags(argv);
      return { plan: parsed.positionalScope ?? parsed.scope, intent: parsed.intent, step: parsed.readingStep?.kind };
    };
    const rest = LINE.join(" ");
    expect(parse(["bugfix"])).toEqual({ plan: "bugfix", intent: undefined, step: undefined });
    expect(parse(["bugfix", rest])).toEqual({ plan: "bugfix", intent: rest, step: undefined });
    expect(parse([`bugfix: ${rest}`])).toEqual({ plan: "bugfix", intent: rest, step: undefined });
    expect(parse(["bugfix:", ...LINE])).toEqual({ plan: "bugfix", intent: rest, step: undefined });
    expect(parse(["--scope", "bugfix", ...LINE])).toEqual({ plan: "bugfix", intent: rest, step: undefined });
    // The rest keep every word for the agent's reading, with no count of words: two
    // in one argument as much as nine, and a plan's name and one word split, which
    // is the person's two-word line passed through as typed as much as a plan the
    // agent read with a one-word request.
    for (const argv of [["bugfix", ...LINE], [`bugfix ${rest}`], splitKiroCommandArgs(`bugfix ${rest}`), ["bugfix login"], ["bugfix", "login"]]) {
      expect(parse(argv), JSON.stringify(argv)).toEqual({ plan: undefined, intent: argv.join(" "), step: "plan-word" });
    }
  });

  test("Kiro IDE's first step reads `/aidlc bugfix fix the login` as the person's words, as it reads any request", () => {
    // The adapter names the first engine step only for a line of words
    // (nextArgsAreOnlyWords over Kiro's split): a line read as a plan pick got
    // no first step, and on Kiro's Default agent AI-DLC did not start.
    for (const line of ["bugfix fix the login", "classic car rental website", `express ${LINE.join(" ")}`]) {
      expect(nextArgsAreOnlyWords(splitKiroCommandArgs(line)), line).toBe(true);
    }
    expect(nextArgsAreOnlyWords(splitKiroCommandArgs("bugfix")), "bugfix").toBe(false);
  });

  test("beside active work the line gets the same both readings, never a routing question naming that plan", () => {
    proj = activeProject();
    const d = next(CLAUDE_TOOLS, proj, ["bugfix", ...LINE]);
    expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
    expect(d.ask_type).toBeUndefined();
    expect(String(d.message)).toContain(`\`bugfix\` ${BOTH}`);
    expect(String(d.message)).toContain(`--scope bugfix -- '${LINE.join(" ")}'`);
    expect(questionTexts(proj)).toEqual([]);
  });
});

// The request's questions (the proposal step's, the plan question derived from
// it) are the creation's own request: once the work exists they are answered or
// gone. Left open, the proposal question would meet the next words line as "the
// plan question they were asked" (a re-ask about work already built) and take a
// switch typed next.
describe("t-plan-proposed-by-the-agent: creation retires the request's whole chain", () => {
  const OTHER_CHAT = "01995000-7a11-7000-8000-0000000000c2";
  const OPEN_FRONT = "has not answered the plan question";

  test("after the proposal-hop creation no question of the request remains, and the next words line meets no open question, in this chat or another", () => {
    proj = fresh();
    const ask = planOffer(ORCH, proj, ["fix the login"], "bugfix").directive as Directive;
    expect(ask.ask_type, JSON.stringify(ask).slice(0, 300)).toBe("scope-confirm");
    expect(questionTexts(proj).length).toBe(2);
    const created = createFromConfirm(proj, ask);
    // The creation's own question is gone; the proposal step's is kept, answered by it.
    expect(questionTexts(proj).map((q) => [q.text, q.answeredBy])).toEqual([["fix the login", created]]);
    // The next request, beside the work just built: the words reach the agent's
    // reading of them, never a question about the login work.
    const sameChat = next(CLAUDE_TOOLS, proj, ["add", "a", "CSV", "export"]);
    expect(sameChat.kind, JSON.stringify(sameChat).slice(0, 300)).toBe("print");
    expect(String(sameChat.message)).not.toContain(OPEN_FRONT);
    const otherChat = next(CLAUDE_TOOLS, proj, ["add", "a", "CSV", "export"], { ...process.env, AIDLC_SESSION_OVERRIDE: OTHER_CHAT });
    expect(otherChat.kind, JSON.stringify(otherChat).slice(0, 300)).toBe("print");
    expect(String(otherChat.message)).not.toContain(OPEN_FRONT);
  });

  test("the proposal step's question answered again, bare or with a plan, carries on with the work it started", () => {
    proj = fresh();
    const ask = planOffer(ORCH, proj, ["fix the login"], "bugfix").directive as Directive;
    const root = questionTexts(proj).find((q) => q.id !== REQUEST.exec(String(ask.confirm_command))![1])!.id;
    createFromConfirm(proj, ask);
    for (const args of [["--request", root], ["--propose", "bugfix", "--request", root], ["--propose", "feature", "--request", root]]) {
      const again = next(CLAUDE_TOOLS, proj, args);
      expect(again.kind, JSON.stringify(again).slice(0, 300)).toBe("print");
      expect(String(again.message)).toContain("Already started");
    }
    expect(readdirSync(join(proj, "aidlc", "spaces", "default", "intents")).filter((name) => /^\d{6}-/.test(name))).toHaveLength(1);
  });

  test.each([
    ["a bare next (Kiro IDE: the engine takes the line from the record)", []],
    ["next with the line (Claude Code)", ["--guard.review-freeze", "off"]],
  ])("a check turned off in a chat with no work selected is off for the work that chat builds next, not lost on the login work's gone question: %s", (_shape, first) => {
    // Work exists and none is selected: a switch typed bare is for the work the
    // chat creates next, and binds to the request open at the time, if any.
    proj = cloneWithWork(CLAUDE_TOOLS);
    // The person's chat runs AI-DLC's hooks: their line comes through the prompt hook.
    const health = hooksHealthDir(proj);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
    const created = createFromConfirm(proj, follow(CLAUDE_TOOLS, proj, ["fix", "the", "login"], "bugfix").last);
    expect(questionTexts(proj).length).toBeGreaterThan(0);
    expect(questionTexts(proj).every((q) => q.answeredBy === created)).toBe(true);
    // A second chat on the project, nothing selected there yet; the runner's
    // presence bypass is cleared so only the person's own typed line lowers a check.
    rmSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), { force: true });
    const chat = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: OTHER_CHAT };
    reply(proj, "/aidlc --guard.review-freeze off", OTHER_CHAT);
    // The agent's first step hands the line to the setter, which keeps it for
    // the work this chat starts next and says so; then the agent asks again and
    // the person gets the question of which work to pick up.
    const step = next(CLAUDE_TOOLS, proj, first as string[], chat);
    const setter = /Run `bun \.claude\/tools\/aidlc\.ts ([^`]+)`/.exec(String(step.message))?.[1];
    expect(setter, JSON.stringify(step).slice(0, 300)).toBe("engine config set guard.review-freeze off");
    const kept = spawnSync(process.execPath, [join(CLAUDE_TOOLS, "aidlc.ts"), ...(setter as string).split(" ")], {
      cwd: proj,
      encoding: "utf-8",
      env: { ...chat, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    });
    expect(kept.status, `${kept.stdout}${kept.stderr}`).toBe(0);
    expect(kept.stdout).toContain("is off for the work you pick up or start next (set by you)");
    const bare = next(CLAUDE_TOOLS, proj, [], chat);
    expect(bare.ask_type, JSON.stringify(bare).slice(0, 300)).toBe("intent-pick");
    expect(String(bare.question ?? ""), JSON.stringify(bare).slice(0, 300)).not.toContain("fix the login");
    // Work exists but none is selected here: the reading print, the agent's plan, the plan question.
    const offer = follow(CLAUDE_TOOLS, proj, ["add", "a", "CSV", "export"], "feature", chat).last;
    expect(offer.ask_type, JSON.stringify(offer).slice(0, 300)).toBe("scope-confirm");
    // The person goes ahead with the plan.
    reply(proj, "1", OTHER_CHAT);
    createFromConfirm(proj, offer, chat);
    const record = readFileSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), "utf-8").trim();
    const state = readFileSync(join(proj, "aidlc", "spaces", "default", "intents", record, "aidlc-state.md"), "utf-8");
    expect(getField(state, "Guards Off") ?? "", state.slice(0, 600)).toContain("review-freeze");
  });
});

describe("t-plan-proposed-by-the-agent: the reading prints name the plan clause", () => {
  test("active work, team mode and the none-selected print all tell the agent to add --propose for new work", () => {
    proj = activeProject();
    expect(String(next(CLAUDE_TOOLS, proj, ["add CSV export"]).message)).toContain("add `--propose <plan>`");
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace("- **Current Stage**: feasibility", "- **Current Stage**: feasibility\n- **Unit Ownership**: team"));
    expect(String(next(CLAUDE_TOOLS, proj, ["add CSV export"]).message)).toContain("add `--propose <plan>`");
    cleanupTestProject(proj);
    proj = cloneWithWork(CLAUDE_TOOLS);
    expect(String(next(CLAUDE_TOOLS, proj, ["add CSV export"]).message)).toContain("add `--propose <plan>`");
  });
});
