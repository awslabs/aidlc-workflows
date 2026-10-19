// covers: function:workspaceHasWork, function:sourceWorkNotFound, function:linkedWorktrees, function:nestedCheckouts, function:sourceChangedSinceStageStarted, function:sourceClaimCheckout, function:linkTargetListingRel, function:verifyStageArtifacts
//
// Code Generation finds the code where the person keeps it. Each layout is
// built with real git: AI-DLC set up in the project, the code written only in
// the layout's folder (a worktree in a child, nested or harness folder, a
// worktree of a repo kept outside the project, a clone, a submodule, a
// monorepo package, a commit of the code followed by a records-only commit, a
// link to a checkout elsewhere (a junction on Windows), and on Windows a
// worktree on another drive), and Code Generation driven through the engine as
// the conductor drives it, for the whole stage and for one Unit whose source
// manifest names the code where it is: the agent's report opens the approval
// question and the person's approval completes the stage. Code kept where the
// review cannot see it change (a harness folder, another drive) is not counted:
// the agent is told once and the person decides with the note. Runs on Linux,
// macOS (darwin) and Windows.
//
// When the check cannot see the code, Guard Policy decides: off (from the
// scope default, a memory layer or the person's switch) stands aside for the
// agent too, with one recorded line; strict and relaxed refuse the agent's own
// first report, naming the way on, and its second report puts the approval
// question to the person with the line, which their approval records; a team's
// memory-held strict keeps the check over the person's off switch.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  approvalNote,
  buildLayout,
  cleanupLayouts,
  codeOutOfSight,
  isGuardAsk,
  LAYOUTS,
  memoryGuardPolicy,
  notices,
  PERSON,
  personSays,
  reasonCodes,
  report,
  setGuardPolicy,
  sourceWorkRows,
  stageBox,
  state,
  startCodeGeneration,
  commitRecords,
  review,
  workspace,
  writeCode,
  git,
} from "../harness/source-work-layouts.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterEach(() => cleanupLayouts());

// Code the review cannot see change (a harness folder, outside the project):
// the agent is told once, the person decides with the note, and the approval
// records that AI-DLC did not find the code.
function expectPersonDecides(proj: string): void {
  const first = report(proj, "awaiting-approval", PERSON);
  expect(isGuardAsk(first), first.out).toBe(true);
  expect(reasonCodes(first)).toContain("REQUIRED_SOURCE_WORK_MISSING");
  const second = report(proj, "awaiting-approval", PERSON);
  expect(stageBox(proj), second.out).toBe("?");
  expect(notices(second).join("\n"), second.out).toContain("AI-DLC found no source changes under");
  personSays(proj);
  const approved = report(proj, "approved", PERSON, ["--user-input", "Approve"]);
  expect(stageBox(proj), approved.out).toBe("x");
  expect(approvalNote(proj)).toStartWith("not found under ");
}

describe("Code Generation finds the code where the person keeps it", () => {
  for (const layout of LAYOUTS) {
    for (const perUnit of [false, true]) {
      const name = `${layout.name}, ${perUnit ? "one Unit" : "the whole stage"}`;
      test.skipIf(layout.skip !== undefined && layout.skip !== false)(name, () => {
        const { proj } = buildLayout(layout, perUnit);
        if (layout.outOfReview) {
          expectPersonDecides(proj);
          return;
        }
        const gate = report(proj, "awaiting-approval");
        expect(isGuardAsk(gate), gate.out).toBe(false);
        expect(stageBox(proj), gate.out).toBe("?");
        expect(sourceWorkRows(proj)).toEqual([]);
        const approved = report(proj, "approved", {}, ["--user-input", "Approve"]);
        expect(stageBox(proj), approved.out).toBe("x");
      });
    }
  }

  // The review binds only what the source walk lists, so code in a harness
  // folder is never recorded as found: an edit after the review there goes to
  // the person with the note, not through as reviewed code.
  test("code in a harness-folder worktree edited after the review goes to the person, not through as reviewed", () => {
    const layout = LAYOUTS.find((entry) => entry.name === "a worktree in the harness folder");
    if (layout === undefined) throw new Error("layout missing");
    const { proj, codeDir } = buildLayout(layout, false);
    writeCode(codeDir, "export const login = 2;\n");
    expectPersonDecides(proj);
    expect(sourceWorkRows(proj).map((row) => row.lookedIn).join(" ")).not.toContain(".claude");
  });

  // The agent's own completion verbs see the same places.
  test("advance, finalize and complete-workflow find the code in a nested worktree", () => {
    const layout = LAYOUTS.find((entry) => entry.name === "a nested worktree");
    if (layout === undefined) throw new Error("layout missing");
    for (const verb of ["advance", "finalize", "complete-workflow"]) {
      const { proj } = buildLayout(layout, false);
      const done = state(proj, [verb, "code-generation"]);
      expect(done.out, verb).not.toContain("workspace_requires");
      expect(done.out, verb).not.toContain("no source work is evident");
    }
  });

  // A nested checkout's files are judged by its own git; a file the project's
  // own .gitignore leaves out is still no reviewed source.
  test("a Unit manifest naming a file the project root's git ignores is still refused", () => {
    const proj = workspace("notes.log\n");
    startCodeGeneration(proj, true);
    commitRecords(proj);
    writeFileSync(join(proj, "notes.log"), "not source\n");
    const refused = review(proj, true, [{ path: "notes.log" }]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("is ignored by Git and cannot be source-review evidence");
  });

  // A brownfield tree with nothing new since the stage began still says no to
  // the agent: the check keeps catching a report with no code written.
  test("a brownfield tree with nothing new since the stage began is refused to the agent, naming where it looked", () => {
    const proj = workspace("");
    writeCode(proj, "export const legacy = 1;\n");
    git(proj, ["add", "src"]);
    git(proj, ["commit", "-q", "-m", "brownfield code"]);
    startCodeGeneration(proj, false);
    commitRecords(proj);
    expect(review(proj, false, []).rc).toBe(0);
    const refused = report(proj, "awaiting-approval");
    expect(isGuardAsk(refused), refused.out).toBe(true);
    expect(reasonCodes(refused)).toContain("REQUIRED_SOURCE_WORK_MISSING");
    expect(refused.out).toContain("no source work is evident under");
    expect(stageBox(proj)).toBe("-");
  });
});

describe("when the check cannot see the code", () => {
  for (const policy of ["strict", "relaxed"] as const) {
    test(`Guard Policy ${policy}: the agent's first report is refused with the way on, the second puts the question to the person`, () => {
      const { proj } = codeOutOfSight();
      setGuardPolicy(proj, policy, "set by you");
      const first = report(proj, "awaiting-approval", PERSON);
      expect(isGuardAsk(first), first.out).toBe(true);
      expect(first.directive?.agent_work, first.out).toBe(true);
      expect(first.out).toContain("run the same report again: the approval question then goes to the person with this note");
      expect(first.out).not.toContain("nothing I can safely do");
      expect(stageBox(proj)).toBe("-");
      const second = report(proj, "awaiting-approval", PERSON);
      expect(isGuardAsk(second), second.out).toBe(false);
      expect(stageBox(proj), second.out).toBe("?");
      expect(notices(second).join("\n"), second.out).toContain("AI-DLC found no source changes under");
      expect(notices(second).join("\n")).toContain("If your code is somewhere else, approve as usual; if it is missing, ask for changes.");
      expect(sourceWorkRows(proj).map((row) => row.outcome)).toEqual(["told the agent", "put to the person"]);
      personSays(proj);
      const approved = report(proj, "approved", PERSON, ["--user-input", "Approve"]);
      expect(stageBox(proj), approved.out).toBe("x");
      expect(approvalNote(proj)).toStartWith("not found under ");
    });
  }

  const offSources: Array<{ name: string; set: (proj: string) => void }> = [
    { name: "the scope default", set: (proj) => setGuardPolicy(proj, "off", "from scope poc") },
    {
      name: "a memory layer",
      set: (proj) => {
        setGuardPolicy(proj, "strict", "from scope feature");
        memoryGuardPolicy(proj, "off");
      },
    },
    { name: "the person's switch", set: (proj) => setGuardPolicy(proj, "off", "set by you") },
  ];
  for (const source of offSources) {
    test(`Guard Policy off from ${source.name}: the check stands aside for the agent too, with one recorded line`, () => {
      const { proj } = codeOutOfSight();
      source.set(proj);
      const gate = report(proj, "awaiting-approval", PERSON);
      expect(isGuardAsk(gate), gate.out).toBe(false);
      expect(stageBox(proj), gate.out).toBe("?");
      expect(notices(gate).join("\n"), gate.out).toContain("AI-DLC found no source changes under");
      expect(sourceWorkRows(proj).map((row) => row.outcome)).toEqual(["stood aside"]);
      // Said once: the gate shown again says nothing more.
      const again = report(proj, "awaiting-approval", PERSON);
      expect(notices(again).join("\n")).not.toContain("AI-DLC found no source changes");
      expect(sourceWorkRows(proj)).toHaveLength(1);
    });
  }

  test("a team's memory-held strict keeps the check over the person's off switch", () => {
    const { proj } = codeOutOfSight();
    memoryGuardPolicy(proj, "strict");
    setGuardPolicy(proj, "off", "set by you");
    const first = report(proj, "awaiting-approval", PERSON);
    expect(isGuardAsk(first), first.out).toBe(true);
    expect(reasonCodes(first)).toContain("REQUIRED_SOURCE_WORK_MISSING");
    expect(sourceWorkRows(proj).map((row) => row.outcome)).toEqual(["told the agent"]);
  });

  // Where no approval would be the person's reply after the gate, the second
  // report cannot stand for it: the refusal stays.
  test("with the human-presence check switched off, the refusal stays on every report", () => {
    const { proj } = codeOutOfSight();
    for (const attempt of [1, 2]) {
      const refused = report(proj, "awaiting-approval");
      expect(isGuardAsk(refused), `report ${attempt}: ${refused.out}`).toBe(true);
      expect(reasonCodes(refused)).toContain("REQUIRED_SOURCE_WORK_MISSING");
      expect(refused.out).not.toContain("the approval question then goes to the person");
    }
    expect(stageBox(proj)).toBe("-");
    expect(sourceWorkRows(proj)).toEqual([]);
  });

  test("the person's own approval before the gate opened goes through, recorded with the note", () => {
    const { proj } = codeOutOfSight();
    personSays(proj);
    const approved = report(proj, "approved", PERSON, ["--user-input", "Approve"]);
    expect(isGuardAsk(approved), approved.out).toBe(false);
    expect(stageBox(proj), approved.out).toBe("x");
    expect(approvalNote(proj)).toStartWith("not found under ");
  });
});
