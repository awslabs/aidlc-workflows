// covers: subcommand:aidlc-orchestrate:next
//
// When a claimed Unit is complete, approved and published in the checkout that
// claimed it, the notice says it waits for review on main and how this checkout
// is freed, with no command to type: what is left is offered where it is due
// (the review on a checkout with no claim, which pin needs). Both shapes of a
// claimed checkout read the same words, and neither is sent to "unscoped main"
// or "the main checkout": in the project's own checkout that claimed the Unit
// (#3282) the person is already in the project's main checkout.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  ORCH,
  UNIT,
  appendMainHumanTurn,
  cleanupTempDirs,
  clone,
  completeUnitOnMain,
  git,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const DONE =
  'Unit "alpha" is complete and approved in this checkout, and published for review on main. ' +
  "Once it lands on main, pull main here and this checkout is free again.";

// The claimed checkout with alpha worked through every stage and published,
// Current Stage where the walk leaves it (the Unit's last stage).
function doneIn(checkout: string): Record<string, unknown> {
  writeFileSync(
    seededStateFile(checkout),
    readFileSync(seededStateFile(checkout), "utf-8")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"),
  );
  return nextDirective(checkout);
}

describe("a claimed Unit's end-of-Unit notice says where the rest is done", () => {
  test("in the project's own checkout that claimed the Unit", () => {
    const { seed: lead, remote } = makeSeed();
    // The lead's own checkout: its shard is on main, where Inception ran.
    appendMainHumanTurn(lead);
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "lead inception audit"]);
    git(lead, ["push", "origin", "main"]);
    prepareCandidate(remote, "alpha", "lead", { checkout: lead });
    expect(doneIn(lead)).toMatchObject({ kind: "notice", message: DONE, unit: "alpha" });
    // What it says is so: this checkout does not pin, a checkout with no claim does.
    expect(runMergeTool(UNIT, ["pin", "alpha"], lead).out).toContain("Unit pinning must run from an unscoped main checkout.");
    const pinned = runMergeTool(UNIT, ["pin", "alpha"], clone(remote, "fresh"));
    expect(pinned.status, pinned.out).toBe(0);
  });

  test("in a team's own clone", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "team-a");
    expect(doneIn(checkout)).toMatchObject({ kind: "notice", message: DONE, unit: "alpha" });
  });
});

// The claimed Unit is the plan's last: every other Unit is built on main, so
// the walk moves this checkout's record on to Build and Test once the Unit is
// done. Build and Test is the lead's, once every Unit lands; here the Unit's
// own step stays the step, however often the person comes back, and a record
// an older AI-DLC left there reads the same.
// `endsAtCodeGeneration`: the plan has no stage after the Units' (classic with
// Build and Test taken off), so the walk marks the whole work finished instead.
function lastUnitClaimed(publish = true, endsAtCodeGeneration = false): string {
  const { seed: lead, remote } = makeSeed(parallelDependencyBody());
  completeUnitOnMain(lead, "beta");
  if (endsAtCodeGeneration) {
    writeFileSync(
      seededStateFile(lead),
      readFileSync(seededStateFile(lead), "utf-8")
        .replace("- **Scope**: feature", "- **Scope**: classic")
        .replace("build-and-test \u2014 EXECUTE", "build-and-test \u2014 SKIP")
        .replace("ci-pipeline \u2014 EXECUTE", "ci-pipeline \u2014 SKIP"),
    );
  }
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", "beta built on main"]);
  git(lead, ["push", "origin", "main"]);
  return prepareCandidate(remote, "alpha", "team-a", { publish }).checkout;
}
const stateField = (checkout: string, field: string): string =>
  new RegExp(`^- \\*\\*${field}\\*\\*: (.*)$`, "m").exec(readFileSync(seededStateFile(checkout), "utf-8"))?.[1] ?? "";
const UNPUBLISHED = 'Unit "alpha" is complete and approved in this checkout. ' +
  "Once it lands on main, pull main here and this checkout is free again.";

describe("a claimed checkout whose record moved on to Build and Test", () => {
  test("published: the wait for the lead, every time, never Build and Test", () => {
    const checkout = lastUnitClaimed();
    expect(doneIn(checkout)).toMatchObject({ kind: "notice", message: DONE, unit: "alpha" });
    expect(stateField(checkout, "Current Stage")).toBe("build-and-test");
    expect(nextDirective(checkout)).toMatchObject({ kind: "notice", message: DONE, unit: "alpha" });
  });

  test("not published: the offer to publish it, once, and Not now is the wait", () => {
    const checkout = lastUnitClaimed(false);
    writeFileSync(
      seededStateFile(checkout),
      readFileSync(seededStateFile(checkout), "utf-8")
        .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: build-and-test")
        .replace(/^- \[ \] build-and-test /m, "- [-] build-and-test "),
    );
    expect(nextDirective(checkout)).toMatchObject({
      kind: "ask", ask_type: "team-handover", handovers: ["publish"], unit: "alpha",
    });
    // Not now runs next: the Unit's own step again, not the same question.
    expect(nextDirective(checkout)).toMatchObject({ kind: "notice", message: UNPUBLISHED, unit: "alpha" });
  });
});

// The plan ends at Code Generation: the walk marks this checkout's work
// finished once its Unit, the last, is done. The Unit has still to reach the
// lead, so its own step stays the step there too, typed words or not.
describe("a claimed checkout whose plan ends at Code Generation", () => {
  test("not published: the offer to publish it, then the wait, never finished", () => {
    const checkout = lastUnitClaimed(false, true);
    expect(doneIn(checkout)).toMatchObject({
      kind: "ask", ask_type: "team-handover", handovers: ["publish"], unit: "alpha",
    });
    expect(stateField(checkout, "Status")).toBe("Completed");
    expect(nextDirective(checkout)).toMatchObject({ kind: "notice", message: UNPUBLISHED, unit: "alpha" });
    // Typed words get the step work in progress gets, never the finished-work
    // route; "carry on" then runs a bare next, the Unit's step. Run as the
    // agent runs it, with no flag after the words (runMergeTool adds one).
    const words = spawnSync(process.execPath, [ORCH, "next", "morning, let's carry on with alpha"], {
      cwd: checkout,
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: checkout, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" },
    });
    expect(words.status, `${words.stdout}${words.stderr}`).toBe(0);
    const step = JSON.parse(words.stdout);
    expect(step.kind).toBe("print");
    expect(step.message).toContain("Work is in progress");
    expect(nextDirective(checkout)).toMatchObject({ kind: "notice", message: UNPUBLISHED, unit: "alpha" });
  });

  test("published: the wait for the lead, never finished", () => {
    const checkout = lastUnitClaimed(true, true);
    expect(doneIn(checkout)).toMatchObject({ kind: "notice", message: DONE, unit: "alpha" });
    expect(nextDirective(checkout)).toMatchObject({ kind: "notice", message: DONE, unit: "alpha" });
  });
});
