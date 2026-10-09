// covers: scope:poc, scope:express
//
// Person moves in a scope run, with no model (tests/harness/scope-run.ts): the
// person answers in their own words, and types settings with new work. The
// reply-reading rule is owned by t-own-words-gates; settings over an open
// question by t114 and t198. These runs check the wiring across a whole scope.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, intentsDirOf } from "../harness/fixtures.ts";
import {
  activeRecord,
  auditEvents,
  expectedStages,
  field,
  runScope,
  SCOPE_RUN_TIMEOUT_MS,
  scopeRunProblems,
  type ScopeRun,
} from "../harness/scope-run.ts";

const runs: ScopeRun[] = [];
afterAll(() => {
  for (const run of runs) cleanupTestProject(run.proj);
});

const stateLine = (state: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(state)?.[1]?.trim() ?? null;

describe("the person's own words", () => {
  test("a sentence approves a gate and answers a question; the approval keeps their words and nothing is asked twice", () => {
    const run = runScope("poc", {
      answers: {
        approve: (stage) => (stage === "requirements-analysis" ? "ok that makes sense, approve" : "Approve"),
        question: (stage) => (stage === "requirements-analysis" ? "the first one, please" : "A"),
      },
    });
    runs.push(run);
    expect(scopeRunProblems(run)).toEqual([]);
    const events = auditEvents(run.proj);
    const at = (event: string) =>
      events.filter((e) => e.event === event && field(e.block, "Stage") === "requirements-analysis");
    expect(at("GATE_APPROVED").map((e) => field(e.block, "Person Reply"))).toEqual(["ok that makes sense, approve"]);
    expect(at("STAGE_AWAITING_APPROVAL")).toHaveLength(1);
    const answers = at("QUESTION_ANSWERED").map((e) => field(e.block, "Details"));
    expect(answers).toContain("A");
  }, SCOPE_RUN_TIMEOUT_MS);
});

describe("settings typed with new work", () => {
  test("--learnings on typed with the request carries through express, which ships it off", () => {
    const run = runScope("express", { flags: ["--learnings", "on"] });
    runs.push(run);
    expect(run.declared.learnings).toBe(false);
    expect(scopeRunProblems(run, { skip: ["learnings"] })).toEqual([]);
    const state = readFileSync(activeRecord(run.proj).state, "utf-8");
    expect(stateLine(state, "Learnings")).toMatch(/^on \(/);
    expect(stateLine(state, "Learnings")).not.toContain("from scope");
    const stages = run.agent.directives.filter((d) => d.kind === "run-stage" && d.ceremony);
    expect(stages.length).toBeGreaterThan(0);
    for (const d of stages) expect((d.ceremony as Record<string, string>).learnings).toBe("on");
    const learned = auditEvents(run.proj).filter((e) => e.event === "QUESTION_ANSWERED" && field(e.block, "Details") === "Nothing to add");
    expect(learned.length).toBeGreaterThan(0);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("a setting typed with a new description while other work is active lands on the new work, which runs to done", () => {
    let typed = false;
    const run = runScope("poc", {
      answers: { newWork: () => "2, as express work" },
      afterApproval: (stage, agent) => {
        if (stage !== "requirements-analysis" || typed) return undefined;
        typed = true;
        return agent.personTypes('/aidlc --learnings on "add a health endpoint"');
      },
    });
    runs.push(run);
    expect(typed).toBe(true);
    // The new work is the active one now and finished; the poc work is untouched.
    const created = activeRecord(run.proj);
    const state = readFileSync(created.state, "utf-8");
    expect(stateLine(state, "Scope")).toBe("express");
    expect(stateLine(state, "Learnings")).toMatch(/^on \(/);
    expect(stateLine(state, "Status")).toBe("Completed");
    expect(scopeRunProblems({ ...run, scope: "express", declared: { ...run.declared } }, {
      stages: expectedStages("express", false),
      skip: ["switches"],
    })).toEqual([]);
    const intents = intentsDirOf(run.proj);
    const others = JSON.parse(readFileSync(join(intents, "intents.json"), "utf-8")) as { dirName: string }[];
    const poc = others.map((i) => join(intents, i.dirName, "aidlc-state.md")).filter((p) => p !== created.state && existsSync(p));
    expect(poc).toHaveLength(1);
    expect(stateLine(readFileSync(poc[0], "utf-8"), "Scope")).toBe("poc");
  }, SCOPE_RUN_TIMEOUT_MS);
});
