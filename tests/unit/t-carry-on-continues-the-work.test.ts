// covers: subcommand:aidlc-orchestrate:next, function:takePersonsOwnLine, function:wordsAlreadyRead
//
// No word list decides what the person meant. "carry on", "proceed", "ok go" or
// "keep going please" typed after /aidlc over work in progress are words like
// any other: the engine hands them to the agent with one exact command per
// reading, the bare `next` among them, and the agent runs the one it read.
// Before, five listed words carried on at once and every other way of saying it
// reached a reading print that named no carry-on command (live on Kiro CLI the
// person got "Work is already in progress on ... You said: "proceed". What
// should I do? 1. Part of the active work ..."). Where work is here but none is
// selected in this chat (a teammate's clone), the same reading comes first, so
// "carry on" is never offered as new work, and the bare `next` the print names
// is not read as that line again (takePersonsOwnLine, wordsAlreadyRead), and words
// that name one piece and ask for it to go on ("continue auth") get the pick
// question's own one-step answer, `next --pick <name>`, so the person never
// says it twice. Team mode (Unit Ownership: team) gets the reading too. Every path also checks the
// chain the agent is told to follow: a stage step or one question within three
// engine calls, and never the same print twice.

import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { env as chatEnv, say } from "../harness/aidlc-input-corpus.ts";
import {
  AIDLC_SRC,
  REPO_ROOT,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const CLAUDE_TOOLS = join(AIDLC_SRC, "tools");
const KIRO_TOOLS = join(REPO_ROOT, "dist", "kiro", ".kiro", "tools");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");
const COMPLETED = join(FIXTURES_DIR, "state-completed.md");

// Ways a person says "go on", in the shapes they type them: the five words the
// engine used to list, and the ones it never knew, read the same way now.
const GO_ON: string[][] = [
  ["carry", "on"],
  ["carry on"],
  ["proceed"],
  ["ok", "go"],
  ["go", "ahead"],
  ["keep going please"],
  ["continue"],
  ["resume"],
  ["Please, keep going!"],
  ["let's", "continue"],
];

type Directive = Record<string, unknown> & {
  kind?: string;
  ask_type?: string;
  stage?: string;
  question?: string;
  message?: string;
};

const REQUEST = /--request ([0-9a-f]{8})/;
// The print names the bare `next` as the command for words that only ask to go on.
const BARE_NEXT = /next` with nothing after it|re-run `next`/;
const REENTRY = "report --result resumed --choice <redo|jump|fresh>";
// The pick step's print names the switch it runs before the bare `next`.
const PICK_STEP = /intent switch (\S+)`, print its output verbatim, then run/;
// The pieces of work the none-selected reading print lists, by exact name.
const piecesNamed = (message: string): string[] =>
  (/^Work is in progress here \(([^)]*)\)/.exec(message)?.[1] ?? "").split(", ").filter(Boolean);
const ROUTING_QUESTION = "new-work-routing";

function next(tools: string, proj: string, args: string[], env: NodeJS.ProcessEnv = { ...process.env }): Directive {
  const r = runOrchestrateNext(join(tools, "aidlc-orchestrate.ts"), proj, args, { cwd: proj, env });
  expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
  return r.directive as Directive;
}

/** The directive with every request id blanked: two readings of different words are the same step. */
const upToIds = (d: Directive): string => JSON.stringify(d).replace(/[0-9a-f]{8}/g, "<id>");

function questionTexts(proj: string): string[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => (JSON.parse(readFileSync(join(dir, name), "utf-8")) as { text: string }).text);
}

function switchTool(tools: string, proj: string, name: string): void {
  const r = spawnSync(process.execPath, [join(tools, "aidlc-utility.ts"), "intent", "switch", name, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env: { ...process.env },
  });
  expect(r.status, `switch ${name}: ${r.stdout}${r.stderr}`).toBe(0);
}

function stateTool(proj: string, verb: string): void {
  const r = spawnSync(process.execPath, [join(CLAUDE_TOOLS, "aidlc-state.ts"), verb, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
  });
  expect(r.status, `${verb}: ${r.stdout}${r.stderr}`).toBe(0);
}

/**
 * The chain the agent is told to follow from a words line, for one reading of
 * the words: "go-on" runs the bare `next` each print names (through the unpark
 * step when a print names it); "request" runs the `next --request <id>` each
 * print names; "pick" runs the `next --pick <name>` the print names for the one
 * piece the words name, then the switch and the bare `next` that step names. It
 * must end in a step that is not a print within three engine calls, and no
 * print may come back a second time.
 */
function follow(
  tools: string,
  proj: string,
  args: string[],
  reading: "go-on" | "request" | "pick",
  env: NodeJS.ProcessEnv = { ...process.env },
): { last: Directive; calls: number } {
  const prints: string[] = [];
  let d = next(tools, proj, args, env);
  let calls = 1;
  while (d.kind === "print") {
    const message = String(d.message);
    expect(prints, `the same print twice: ${message.slice(0, 160)}`).not.toContain(message);
    prints.push(message);
    expect(calls, `a third print instead of a step: ${message.slice(0, 160)}`).toBeLessThan(3);
    if (reading === "go-on") {
      expect(message, "the print names the bare next").toMatch(BARE_NEXT);
      if (/ unpark`/.test(message)) stateTool(proj, "unpark");
      d = next(tools, proj, [], env);
    } else if (reading === "pick") {
      const picked = PICK_STEP.exec(message)?.[1];
      if (picked === undefined) {
        // The reading print: the piece the words name, from the print's own list.
        expect(message, "the print names next --pick <name>").toContain("next --pick <name>");
        const name = piecesNamed(message).find((piece) => piece.includes(args[args.length - 1]));
        expect(name, `no piece named ${args[args.length - 1]} in: ${message.slice(0, 160)}`).toBeDefined();
        d = next(tools, proj, ["--pick", name!], env);
      } else {
        // The one-step answer: the switch, then the bare next, in the same turn.
        expect(message).toMatch(/then run `[^`]* next` and follow what it returns/);
        switchTool(tools, proj, picked);
        d = next(tools, proj, [], env);
      }
    } else {
      const id = REQUEST.exec(message)?.[1];
      expect(id, message).toBeDefined();
      // The "new work" reading: the kept words back as a request; on a
      // workspace with no plan named that is the plan proposal step, which the
      // agent answers with a plan (t-plan-proposed-by-the-agent).
      d = message.includes("--propose <plan> --request")
        ? next(tools, proj, ["--propose", "feature", "--request", id!], env)
        : next(tools, proj, ["--request", id!], env);
    }
    calls++;
  }
  expect(calls).toBeLessThanOrEqual(3);
  return { last: d, calls };
}

function activeProject(): string {
  const proj = createOrchestrationTestProject();
  seedStateFile(proj, MID_IDEATION);
  return proj;
}

function teamProject(): string {
  const proj = activeProject();
  const state = seededStateFile(proj);
  writeFileSync(state, readFileSync(state, "utf-8").replace(
    "- **Current Stage**: feasibility",
    "- **Current Stage**: feasibility\n- **Unit Ownership**: team",
  ));
  return proj;
}

// A teammate's clone: two pieces of work on disk, none selected here (or the
// pieces named by `labels`, a bugfix each).
function cloneWithWork(tools: string, labels?: readonly string[]): string {
  const proj = createTestProject();
  removeWorkspaceRecord(proj);
  seedAidlcMemory(proj); // the rules a clone carries, which a stage step loads
  const pieces = labels ? labels.map((label) => ["--scope", "bugfix", "--label", label]) : [["--scope", "poc"], ["--scope", "feature"]];
  for (const piece of pieces) {
    const r = spawnSync(process.execPath, [join(tools, "aidlc-utility.ts"), "intent-create", ...piece, "--project-dir", proj], {
      cwd: proj,
      encoding: "utf-8",
      env: { ...process.env },
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  }
  rmSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), { force: true });
  return proj;
}

// The person parked ("stop for now") and came back.
function parkThenComeBack(p: string): void {
  appendAuditEntry("HUMAN_TURN", {}, p);
  stateTool(p, "park");
  appendAuditEntry("HUMAN_TURN", {}, p);
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

describe("t-carry-on-continues-the-work: no word list", () => {
  test("the engine keeps no list of carry-on words", async () => {
    const lib = (await import("../../core/tools/aidlc-lib.ts")) as Record<string, unknown>;
    expect(lib.CONTINUATION_PHRASES).toBeUndefined();
    expect(lib.isBareContinuationPhrase).toBeUndefined();
  });
});

describe("t-carry-on-continues-the-work: work in progress", () => {
  for (const [harness, tools] of [["claude", CLAUDE_TOOLS], ["kiro", KIRO_TOOLS]] as const) {
    test(`${harness}: every way of saying go on gets the one reading print, which names the bare next`, () => {
      proj = activeProject();
      const bare = next(tools, proj, []);
      expect(bare.kind).toBe("run-stage");
      const proceed = next(tools, proj, ["proceed"]);
      for (const words of GO_ON) {
        const d = next(tools, proj, words);
        const note = `${words.join(" ")}: ${JSON.stringify(d).slice(0, 300)}`;
        expect(d.kind, note).toBe("print");
        expect(d.ask_type, note).toBeUndefined();
        expect(String(d.message), note).toMatch(BARE_NEXT);
        expect(String(d.message), note).toContain(REENTRY);
        expect(String(d.message), note).toMatch(REQUEST);
        // One reading for every words-only line: no word is treated apart.
        expect(upToIds(d), note).toBe(upToIds(proceed));
      }
      // The bare next the agent then runs is the step a bare next always gets.
      const after = next(tools, proj, []);
      expect(after.kind).toBe("run-stage");
      expect(after.stage).toBe(bare.stage);
    });

    test(`${harness}: the chain ends in the stage step or one question, never the same print twice`, () => {
      proj = activeProject();
      const goOn = follow(tools, proj, ["carry", "on"], "go-on");
      expect(goOn.last.kind, JSON.stringify(goOn.last).slice(0, 300)).toBe("run-stage");
      expect(goOn.calls).toBe(2);
      const request = follow(tools, proj, ["proceed"], "request");
      expect(request.last.kind, JSON.stringify(request.last).slice(0, 300)).toBe("ask");
      expect(request.last.ask_type).toBe(ROUTING_QUESTION);
      expect(request.calls).toBe(2);
    });
  }

  test("the engine keeps the person's line whole for the other reading", () => {
    proj = activeProject();
    next(CLAUDE_TOOLS, proj, ["Please, keep going!"]);
    expect(questionTexts(proj)).toContain("Please, keep going!");
  });

  test("words that name something after the phrase get the same print, with the words kept", () => {
    proj = activeProject();
    const d = next(CLAUDE_TOOLS, proj, ["carry on with a login page"]);
    expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
    expect(String(d.message)).toContain(REENTRY);
    expect(questionTexts(proj)).toContain("carry on with a login page");
  });
});

describe("t-carry-on-continues-the-work: team mode", () => {
  test("Unit Ownership team: go on and a request are read, never the routing question at once", () => {
    proj = teamProject();
    expect(next(CLAUDE_TOOLS, proj, []).kind).toBe("run-stage");
    const proceed = next(CLAUDE_TOOLS, proj, ["proceed"]);
    for (const words of [["carry", "on"], ["proceed"], ["ok go"]]) {
      const d = next(CLAUDE_TOOLS, proj, words);
      const note = `${words.join(" ")}: ${JSON.stringify(d).slice(0, 300)}`;
      expect(d.kind, note).toBe("print");
      expect(String(d.message), note).toMatch(BARE_NEXT);
      expect(String(d.message), note).toMatch(REQUEST);
      // A Unit checkout refuses jumps, so the print names no redo or jump.
      expect(String(d.message), note).not.toContain(REENTRY);
      expect(upToIds(d), note).toBe(upToIds(proceed));
    }
    const goOn = follow(CLAUDE_TOOLS, proj, ["carry", "on"], "go-on");
    expect(goOn.last.kind, JSON.stringify(goOn.last).slice(0, 300)).toBe("run-stage");
    const request = follow(CLAUDE_TOOLS, proj, ["add a CSV export"], "request");
    expect(request.last.kind, JSON.stringify(request.last).slice(0, 300)).toBe("ask");
    expect(request.last.ask_type).toBe(ROUTING_QUESTION);
    expect(String(request.last.question)).toContain("add a CSV export");
  });
});

describe("t-carry-on-continues-the-work: what is waiting on the person stays as it is", () => {
  test("at an open approval the words are still read as its possible answer", () => {
    proj = activeProject();
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace("- [-] feasibility", "- [?] feasibility"));
    const d = next(CLAUDE_TOOLS, proj, ["carry", "on"]);
    expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
    expect(String(d.message)).toContain('Stage "feasibility" is waiting for the person\'s approval, and their reply may answer it.');
    const request = follow(CLAUDE_TOOLS, proj, ["proceed"], "request");
    expect(request.last.kind, JSON.stringify(request.last).slice(0, 300)).toBe("ask");
    expect(request.calls).toBe(2);
  });

  test("parked work with the person not back still says it is parked", () => {
    proj = activeProject();
    const state = seededStateFile(proj);
    writeFileSync(
      state,
      readFileSync(state, "utf-8").replace(
        "- **Current Stage**: feasibility",
        "- **Current Stage**: feasibility\n- **Parked**: 2026-10-06T00:00:00Z\n- **Parked At Stage**: feasibility",
      ),
    );
    expect(next(CLAUDE_TOOLS, proj, []).kind).toBe("parked");
    expect(next(CLAUDE_TOOLS, proj, ["carry", "on"]).kind).toBe("parked");
  });

  test("after a park, with the person back, go on is read and the bare next carries on through the unpark step", () => {
    proj = activeProject();
    parkThenComeBack(proj);
    const bare = next(CLAUDE_TOOLS, proj, []);
    expect(bare.kind).toBe("print");
    expect(String(bare.message)).toContain("unpark");
    for (const words of [["resume"], ["carry", "on"], ["please keep going"]]) {
      const d = next(CLAUDE_TOOLS, proj, words);
      const note = `${words.join(" ")}: ${JSON.stringify(d).slice(0, 300)}`;
      expect(d.kind, note).toBe("print");
      expect(String(d.message), note).toMatch(BARE_NEXT);
      expect(String(d.message), note).not.toContain("unpark");
    }
    const goOn = follow(CLAUDE_TOOLS, proj, ["carry", "on"], "go-on");
    expect(goOn.last.kind, JSON.stringify(goOn.last).slice(0, 300)).toBe("run-stage");
    expect(goOn.calls).toBe(3);
  });
});

describe("t-carry-on-continues-the-work: work here but none selected in this chat", () => {
  for (const [harness, tools] of [["claude", CLAUDE_TOOLS], ["kiro", KIRO_TOOLS]] as const) {
    test(`${harness}: words alone get the reading print naming the pieces, the bare next and the request`, () => {
      proj = cloneWithWork(tools);
      const bare = next(tools, proj, []);
      expect(bare.ask_type, JSON.stringify(bare).slice(0, 300)).toBe("intent-pick");
      for (const words of [["carry", "on"], ["proceed"], ["Please continue."], ["fix the login"]]) {
        const d = next(tools, proj, words);
        const note = `${words.join(" ")}: ${JSON.stringify(d).slice(0, 300)}`;
        expect(d.kind, note).toBe("print");
        expect(String(d.message), note).toMatch(BARE_NEXT);
        expect(String(d.message), note).toContain("intent switch <name>");
        expect(String(d.message), note).toMatch(REQUEST);
        expect(String(d.message), note).not.toContain("You said");
        expect(questionTexts(proj), note).toContain(words.join(" "));
      }
      // Without a chat identity nothing re-reads the line: the bare next asks
      // which piece to pick up, as it always did.
      const goOn = follow(tools, proj, ["carry", "on"], "go-on");
      expect(goOn.last.ask_type, JSON.stringify(goOn.last).slice(0, 300)).toBe("intent-pick");
      expect(goOn.last.question).toBe(bare.question);
      expect(goOn.calls).toBe(2);
      // The kept words come back as the request they may be: the same ask the
      // words got at once before, one agent read later.
      const request = follow(tools, proj, ["fix the login"], "request");
      expect(request.last.kind, JSON.stringify(request.last).slice(0, 300)).toBe("ask");
      expect(request.last.ask_type).toBe(harness === "kiro" ? ROUTING_QUESTION : "scope-confirm");
      expect(String(request.last.question)).toContain("fix the login");
      // Kiro asks which work it belongs to at once; the others take the plan
      // proposal step first, then the plan the agent proposes, then the question.
      expect(request.calls).toBe(harness === "kiro" ? 2 : 3);
    });
  }

  // With a chat identity the hook kept the person's `/aidlc` line, and a bare
  // `next` on a workspace with no work selected reads that line in the agent's
  // place (takePersonsOwnLine). After the reading print, the bare next the agent
  // runs must not become "carry on" again, or the words would be offered as new
  // work: the line the print already read is skipped.
  for (const host of ["claude", "kiro-ide"] as const) {
    for (const words of ["carry on", "proceed"]) {
      test(`${host}: "/aidlc ${words}" typed in the chat: the reading print, then the bare next asks which piece to pick up`, async () => {
        const tools = host === "claude" ? CLAUDE_TOOLS : KIRO_TOOLS;
        proj = cloneWithWork(tools);
        const pick = next(tools, proj, []);
        expect(pick.ask_type, JSON.stringify(pick).slice(0, 300)).toBe("intent-pick");
        const hook = await say(proj, `/aidlc ${words}`, host);
        expect(hook.status, `${hook.stdout}${hook.stderr}`).toBe(0);
        const engine = host === "claude" ? tools : join(proj, ".kiro", "tools");
        const env = chatEnv(proj);
        const read = next(engine, proj, words.split(" "), env);
        expect(read.kind, JSON.stringify(read).slice(0, 300)).toBe("print");
        expect(String(read.message)).toMatch(BARE_NEXT);
        const after = next(engine, proj, [], env);
        expect(after.kind, JSON.stringify(after).slice(0, 300)).toBe("ask");
        expect(after.ask_type).toBe("intent-pick");
        expect(after.question).toBe(pick.question);
        // Said again later, the same words are read again, not skipped.
        await Bun.sleep(1100);
        const again = await say(proj, `/aidlc ${words}`, host);
        expect(again.status, `${again.stdout}${again.stderr}`).toBe(0);
        const reread = next(engine, proj, [], env);
        expect(reread.kind, JSON.stringify(reread).slice(0, 300)).toBe("print");
        expect(String(reread.message)).toMatch(BARE_NEXT);
      });
    }
  }
});

// Words that name one piece and ask for it to go on ("continue auth"): the print
// names `next --pick <name>`, the pick question's own one-step answer, so the
// agent selects that piece and carries on in the same turn and the person never
// says it twice; words that only name a piece keep the switch and its stop.
describe("t-carry-on-continues-the-work: words that name one piece and ask for it to go on", () => {
  for (const [harness, tools] of [["claude", CLAUDE_TOOLS], ["kiro", KIRO_TOOLS]] as const) {
    for (const labels of [["auth", "billing"], ["auth"]] as const) {
      test(`${harness}: "continue auth" over ${labels.length} piece(s), none selected: the pick, the switch and the stage step in one chain`, () => {
        proj = cloneWithWork(tools, labels);
        const d = next(tools, proj, ["continue", "auth"]);
        const note = JSON.stringify(d).slice(0, 400);
        expect(d.kind, note).toBe("print");
        expect(String(d.message), note).toContain("next --pick <name>");
        expect(String(d.message), note).toContain("intent switch <name>");
        expect(String(d.message), note).toMatch(BARE_NEXT);
        expect(piecesNamed(String(d.message)).length, note).toBe(labels.length);
        // The chain: the print, the pick step, then the stage step; no pick question, no stop.
        const chain = follow(tools, proj, ["continue", "auth"], "pick");
        expect(chain.last.kind, JSON.stringify(chain.last).slice(0, 300)).toBe("run-stage");
        expect(chain.calls).toBe(3);
        const cursor = join(proj, "aidlc", "spaces", "default", "intents", "active-intent");
        expect(existsSync(cursor)).toBe(true);
        expect(readFileSync(cursor, "utf-8")).toContain("auth");
      });
    }
  }
});

describe("t-carry-on-continues-the-work: no work in progress is the agent's plan proposal", () => {
  // Nothing to carry on: the words are a request like any other, so the agent
  // gets the plan proposal step (t-plan-proposed-by-the-agent) and the person
  // one question.
  const PROPOSAL = "--propose <plan> --request";
  function propose(p: string, args: string[]): { last: Directive; calls: number } {
    const first = next(CLAUDE_TOOLS, p, args);
    expect(first.kind, JSON.stringify(first).slice(0, 300)).toBe("print");
    expect(String(first.message)).toContain(PROPOSAL);
    const id = REQUEST.exec(String(first.message))?.[1];
    expect(id).toBeDefined();
    const last = next(CLAUDE_TOOLS, p, ["--propose", "compose", "--request", id!]);
    expect(JSON.stringify(last)).not.toContain(PROPOSAL);
    return { last, calls: 2 };
  }

  test("an empty workspace: the proposal step, then one question", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const chain = propose(proj, ["carry", "on"]);
    expect(chain.last.kind).toBe("ask");
    expect(chain.last.ask_type, JSON.stringify(chain.last).slice(0, 300)).toBe("compose-offer");
  });

  test("finished work: the proposal step, then one question", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, COMPLETED);
    expect(next(CLAUDE_TOOLS, proj, []).kind).toBe("done");
    const chain = propose(proj, ["carry", "on"]);
    expect(chain.last.ask_type, JSON.stringify(chain.last).slice(0, 300)).toBe("compose-offer");
  });
});
