// covers: subcommand:aidlc-orchestrate:next, function:isBareContinuationPhrase, function:CONTINUATION_PHRASES
//
// A continuation phrase said on its own while work is in progress carries that
// work on. Live on Kiro CLI the person typed `/aidlc carry on` with work in
// progress and got "New work routing - Work is already in progress on: "late
// design gates test". You said: "carry on". What should I do? 1. Part of the
// active work ... 2. Separate new piece of work ... 3. Reshape the active work
// ... 4. Other". In a fresh clone, where the work is here but none is selected,
// "carry on" was offered as new work to plan. Now the phrase on its own reads as
// no words at all: the selected work goes on, or the person picks which work to
// pick up. Anything more ("carry on with a login page") is still asked about,
// and with no work in progress the phrase does what it did before.

import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
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
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const CLAUDE_TOOLS = join(AIDLC_SRC, "tools");
const KIRO_TOOLS = join(REPO_ROOT, "dist", "kiro", ".kiro", "tools");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");
const COMPLETED = join(FIXTURES_DIR, "state-completed.md");

// Every phrase on its own, and with "please" before or after, in the shapes a
// person types them.
const BARE: string[][] = [
  ["carry", "on"],
  ["carry on"],
  ["continue"],
  ["keep going"],
  ["go", "on"],
  ["resume"],
  ["please", "carry", "on"],
  ["carry on please"],
  ["Carry on, please."],
  ["Please, keep going"],
  ["KEEP GOING!"],
  ["  go   on  "],
  ["please continue"],
  ["resume please"],
];

type Directive = Record<string, unknown> & {
  kind?: string;
  ask_type?: string;
  stage?: string;
  question?: string;
  available_intents?: string[];
};

function next(tools: string, proj: string, args: string[]): Directive {
  const r = runOrchestrateNext(join(tools, "aidlc-orchestrate.ts"), proj, args, {
    cwd: proj,
    env: { ...process.env },
  });
  expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
  return r.directive as Directive;
}

function activeProject(): string {
  const proj = createOrchestrationTestProject();
  seedStateFile(proj, MID_IDEATION);
  return proj;
}

// A teammate's clone: two pieces of work on disk, none selected here.
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

describe("t-carry-on-continues-the-work: the phrase list", () => {
  test("one list, each phrase read exactly, with please before or after", async () => {
    // Loaded here so the rest of the file runs against an engine without it.
    const lib = (await import("../../core/tools/aidlc-lib.ts")) as Record<string, unknown>;
    expect(typeof lib.isBareContinuationPhrase).toBe("function");
    const CONTINUATION_PHRASES = lib.CONTINUATION_PHRASES as readonly string[];
    const isBareContinuationPhrase = lib.isBareContinuationPhrase as (text: string) => boolean;
    expect([...CONTINUATION_PHRASES]).toEqual(["carry on", "continue", "keep going", "go on", "resume"]);
    for (const words of BARE) expect(isBareContinuationPhrase(words.join(" ")), words.join(" ")).toBe(true);
    for (const words of [
      "carry on with a login page",
      "continue the login page",
      "please",
      "carry",
      "go on then do the reports",
      "resume the old plan",
      "don't carry on",
      "carry on?",
      "",
    ]) {
      expect(isBareContinuationPhrase(words), words).toBe(false);
    }
  });
});

describe("t-carry-on-continues-the-work: work in progress carries on", () => {
  for (const [harness, tools] of [["claude", CLAUDE_TOOLS], ["kiro", KIRO_TOOLS]] as const) {
    test(`${harness}: a continuation phrase on its own gets the step a bare next gets, never the routing question`, () => {
      proj = activeProject();
      const bare = next(tools, proj, []);
      expect(bare.kind).toBe("run-stage");
      for (const words of BARE) {
        const d = next(tools, proj, words);
        expect(d.ask_type, `${words.join(" ")}: ${JSON.stringify(d).slice(0, 300)}`).not.toBe("new-work-routing");
        expect(d.kind, words.join(" ")).toBe(bare.kind);
        expect(d.stage, words.join(" ")).toBe(bare.stage);
      }
    });

    test(`${harness}: words that name something after the phrase are still read, never carried on`, () => {
      proj = activeProject();
      const d = next(tools, proj, ["carry on with a login page"]);
      // Read as a possible redo, jump or fresh start, with the words kept for
      // the routing question.
      expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
      expect(String(d.message)).toContain("report --result resumed --choice <redo|jump|fresh>");
      expect(String(d.message)).toMatch(/next --request [0-9a-f]{8}/);
    });
  }
});

describe("t-carry-on-continues-the-work: what is waiting on the person stays as it is", () => {
  test("at an open approval the words are still read as its possible answer", () => {
    proj = activeProject();
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace("- [-] feasibility", "- [?] feasibility"));
    const d = next(CLAUDE_TOOLS, proj, ["carry", "on"]);
    expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
    expect(String(d.message)).toContain('Stage "feasibility" is waiting for the person\'s approval, and their reply may answer it.');
  });

  test("parked work still says it is parked", () => {
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
});

describe("t-carry-on-continues-the-work: work here but none selected", () => {
  for (const [harness, tools] of [["claude", CLAUDE_TOOLS], ["kiro", KIRO_TOOLS]] as const) {
    test(`${harness}: the phrase on its own asks which work to pick up, as a bare next does`, () => {
      proj = cloneWithWork(tools);
      const bare = next(tools, proj, []);
      expect(bare.ask_type, JSON.stringify(bare).slice(0, 300)).toBe("intent-pick");
      for (const words of [["carry", "on"], ["keep going"], ["Please continue."]]) {
        const d = next(tools, proj, words);
        expect(d.ask_type, `${words.join(" ")}: ${JSON.stringify(d).slice(0, 300)}`).toBe("intent-pick");
        expect(d.question).toBe(bare.question);
        expect(JSON.stringify(d)).not.toContain('"carry on"');
      }
    });
  }

  test("words that name new work are still routed as new work", () => {
    proj = cloneWithWork(CLAUDE_TOOLS);
    const d = next(CLAUDE_TOOLS, proj, ["carry on with a login page"]);
    expect(d.ask_type, JSON.stringify(d).slice(0, 300)).not.toBe("intent-pick");
    expect(JSON.stringify(d)).toContain("carry on with a login page");
  });
});

describe("t-carry-on-continues-the-work: no work in progress is unchanged", () => {
  test("an empty workspace reads the phrase as before", () => {
    proj = createTestProject();
    removeWorkspaceRecord(proj);
    const d = next(CLAUDE_TOOLS, proj, ["carry", "on"]);
    expect(d.kind).toBe("ask");
    expect(d.ask_type, JSON.stringify(d).slice(0, 300)).toBe("compose-offer");
  });

  test("finished work reads the phrase as before", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, COMPLETED);
    expect(next(CLAUDE_TOOLS, proj, []).kind).toBe("done");
    const d = next(CLAUDE_TOOLS, proj, ["carry", "on"]);
    expect(d.ask_type, JSON.stringify(d).slice(0, 300)).toBe("compose-offer");
  });
});

describe("t-carry-on-continues-the-work: beside the re-entry reading", () => {
  // The person parked ("stop for now") and came back: a bare next carries the
  // work on through the unpark step, and so does a continuation phrase.
  function parkThenComeBack(p: string): void {
    appendAuditEntry("HUMAN_TURN", {}, p);
    const r = spawnSync(process.execPath, [join(CLAUDE_TOOLS, "aidlc-state.ts"), "park", "--project-dir", p], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: p,
      env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    appendAuditEntry("HUMAN_TURN", {}, p);
  }

  test("after a park, with the person back, the phrase gets exactly what a bare next gets", () => {
    proj = activeProject();
    parkThenComeBack(proj);
    const bare = next(CLAUDE_TOOLS, proj, []);
    expect(bare.kind).toBe("print");
    expect(String(bare.message)).toContain("unpark");
    for (const words of [["resume"], ["carry", "on"], ["please keep going"]]) {
      expect(next(CLAUDE_TOOLS, proj, words), words.join(" ")).toEqual(bare);
    }
  });

  test("while the work is active the phrase never gets the re-entry reading or the routing question", () => {
    proj = activeProject();
    const d = next(CLAUDE_TOOLS, proj, ["carry", "on"]);
    expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("run-stage");
    expect(JSON.stringify(d)).not.toContain("report --result resumed");
    expect(d.ask_type).not.toBe("new-work-routing");
  });

  test("words that ask to go back are still read as a re-entry", () => {
    proj = activeProject();
    const d = next(CLAUDE_TOOLS, proj, ["take me back to requirements analysis"]);
    expect(d.kind, JSON.stringify(d).slice(0, 300)).toBe("print");
    expect(String(d.message)).toContain("report --result resumed --choice <redo|jump|fresh>");
  });
});
