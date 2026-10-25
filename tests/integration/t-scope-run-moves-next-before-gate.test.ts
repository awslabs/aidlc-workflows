// covers: scope:classic, scope:bugfix, subcommand:aidlc-orchestrate:next, audit:REVIEW_COMPLETED
//
// A person move in a scope run, with no model (tests/harness/scope-run.ts),
// between a stage's finished review and its approval gate. A `next` there, or a
// new chat's `/aidlc --resume`, brings the step the review's verdict named: the
// learnings question when it was never asked (a step that ends the turn),
// otherwise the gate's own report. It never hands the stage again, with its
// "Now working on" line for written, reviewed work and a second review request
// the stage's one pass refuses, and a new chat says where it picks up. Classic's
// six Inception reviewer stages (Requirements Analysis to Contract Design), and
// bugfix's Requirements Analysis, which runs with learnings off; there a
// revision's re-review goes on to the revised gate. A note the person asked to
// add at the learnings question and that is not written yet keeps the stage's
// own route, so the ritual can run again; once it is written, the gate comes.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentStandIn, auditEvents, cleanupScopeProjects, clip, createScopeProject, type Directive, field, PersonScript,
  SCOPE_RUN_TIMEOUT_MS, sourceStages,
} from "../harness/scope-run.ts";

afterAll(() => cleanupScopeProjects());

const REVIEWED = [
  "requirements-analysis", "user-stories", "refined-mockups", "domain-design", "units-generation", "contract-design",
];
// Stages with no reviewer, left out to keep the walk short.
const SKIPPED = ["practices-discovery", "delivery-planning"];
const CONSTRUCTION = new Set(sourceStages().filter((s) => s.phase === "construction").map((s) => s.slug));
const LEARNINGS = "Anything to add for next time?";
const LEARNINGS_CHOICES = ["Nothing to add", "Add a note"];
const LEARNINGS_KEEP = "Which notes from this step should I keep as practices for future work?";
const LEARNINGS_KEEP_NONE = "Keep none of these";

type Point = "review" | "learnings" | "gate";

/** The walk stops at a point between a stage's review and its gate, where the move is made. */
class AtPoint extends Error {
  constructor(readonly point: Point, readonly stage: string) {
    super(`${point} at ${stage}`);
  }
}

/**
 * A scope walk that stops for a move once at each named point of a stage (the
 * verdict just recorded, the open learnings question, the open gate) and runs
 * until Construction starts, or until the stage `endsAt` names. Each problem a
 * move meets is kept, and the walk goes on to the next stage either way, so
 * every stage is checked.
 */
class Walk {
  readonly agent: AgentStandIn;
  readonly problems: string[] = [];
  readonly moved: string[] = [];
  private watching: { stage: string; seen: Directive[] } | null = null;
  private readonly stopped = new Set<string>();

  constructor(
    shape: "code" | "empty",
    at: Partial<Record<Point, readonly string[]>>,
    endsAt: (stage: string) => boolean = (stage) => CONSTRUCTION.has(stage),
  ) {
    const { host } = createScopeProject(shape);
    const stop = (point: Point, stage: string) => {
      const key = `${point} ${stage}`;
      if (!(at[point] ?? []).includes(stage) || this.stopped.has(key)) return;
      this.stopped.add(key);
      throw new AtPoint(point, stage);
    };
    this.agent = new AgentStandIn(host, new PersonScript(host), {
      units: ["alpha", "beta"],
      afterReview: (stage, unit) => {
        if (unit === null) stop("review", stage);
      },
      answers: {
        learnings: (stage) => {
          stop("learnings", stage);
          return "Nothing to add";
        },
        approve: (stage) => {
          stop("gate", stage);
          return "Approve";
        },
      },
      until: (d) => {
        if (this.watching === null) return d.kind === "run-stage" && endsAt(String(d.stage));
        this.watching.seen.push(d);
        return d.kind === "run-stage" && d.stage === this.watching.stage && d.gate_only === true;
      },
    });
  }

  run(first: Directive, move: (point: Point, stage: string) => Directive): void {
    let d = first;
    for (;;) {
      try {
        this.agent.drive(d);
        return;
      } catch (error) {
        if (!(error instanceof AtPoint)) throw error;
        this.moved.push(`${error.point} ${error.stage}`);
        d = move(error.point, error.stage);
      }
    }
  }

  /**
   * The move's step should be the gate's own report: drive it on to the gate
   * and keep what it met there. Anything else is a problem, and the agent opens
   * the gate itself so the walk goes on. Returns the gate shown.
   */
  toGate(where: string, stage: string, first: Directive, result: "awaiting-approval" | "revised", pickUp: boolean): Directive {
    const rows = auditEvents(this.agent.host.proj).length;
    const wrong = stepProblems(first, pickUp);
    if (first.kind === "print" && !String(first.message).includes(`report --stage ${stage} --result ${result}\``)) {
      wrong.push(`the step names no gate report: ${clip(String(first.message), 400)}`);
    }
    if (wrong.length > 0) {
      this.problems.push(...wrong.map((problem) => `${where}: ${problem}`));
      this.agent.report(stage, "--result", result);
      return this.agent.next();
    }
    this.watching = { stage, seen: [] };
    let seen: Directive[];
    try {
      this.agent.drive(first);
      seen = this.watching.seen;
    } finally {
      this.watching = null;
    }
    const gate = seen.at(-1) as Directive;
    if (gate.gate_only !== true) this.problems.push(`${where}: the gate never came: ended at ${String(gate.kind)}`);
    for (const d of seen.filter((d) => d.kind === "run-stage" && d.stage === stage && d.gate_only !== true)) {
      this.problems.push(`${where}: on the way to the gate, the stage again: ${clip(String(d.narration ?? ""), 200)}`);
    }
    for (const row of auditEvents(this.agent.host.proj).slice(rows)) {
      if (row.event === "REVIEW_REQUESTED" && field(row.block, "Stage") === stage) {
        this.problems.push(`${where}: a second review was requested`);
      }
      if (row.block.includes("REVIEW_BUDGET_EXHAUSTED")) this.problems.push(`${where}: the review cap refused a request`);
    }
    return gate;
  }

  /**
   * The move's step should be the learnings ritual, ending the turn at its
   * question. The caller asks it either way, so the walk goes on.
   */
  learningsStep(where: string, first: Directive, pickUp: boolean): void {
    const wrong = stepProblems(first, pickUp);
    if (first.kind === "print" && !/run the learnings ritual and ask its questions/.test(String(first.message))) {
      wrong.push(`the step names no learnings ritual: ${clip(String(first.message), 400)}`);
    }
    // The question ends the turn, so the turn may end at it.
    const stop = this.agent.host.stop();
    if (stop.blocked) wrong.push(`the turn may not end at the learnings question: ${clip(stop.reason, 300)}`);
    this.problems.push(...wrong.map((problem) => `${where}: ${problem}`));
  }

  /** The learnings question each stage put to the person, counted. */
  learningsAsked(): Record<string, number> {
    const asked: Record<string, number> = {};
    for (const q of this.agent.asked.filter((q) => q.what === "learnings")) asked[q.stage] = (asked[q.stage] ?? 0) + 1;
    return asked;
  }
}

/** What is wrong with a step between a stage's review and its gate, whatever it should name. */
function stepProblems(d: Directive, pickUp: boolean): string[] {
  const problems: string[] = [];
  const said = String(d.narration ?? "");
  if (d.kind !== "print") {
    problems.push(`handed ${String(d.kind)} ${String(d.stage ?? "")}${d.gate_only === true ? " gate_only" : ""}, not the next step`);
  }
  if (said.includes("Now working on")) problems.push(`the person reads "${clip(said, 300)}"`);
  if (pickUp && !said.includes("Picking up where we left off, at ")) problems.push("a new chat is not told where it picks up");
  return problems;
}

/** The person answers the open learnings question; the agent records it as the step says. */
function answerLearnings(agent: AgentStandIn, stage: string, pick = "Nothing to add"): void {
  agent.askPerson("learnings", stage, LEARNINGS, LEARNINGS_CHOICES, pick);
  agent.must("log", "answer", "--stage", stage, "--details", pick);
}

/** A note the person picked or gave, written as the ritual's persist step writes it. */
function writeNote(agent: AgentStandIn, stage: string, note: string, source: "user_addition" | "orchestrator"): void {
  const surfaced = agent.must("learnings", "surface", "--slug", stage);
  const file = String(surfaced.selections_file);
  agent.host.write(file, `${JSON.stringify({
    stage_slug: stage, space: surfaced.space, intent: surfaced.intent,
    selections: [{ candidate_id: "c1", type: "learning", scope: "project", heading: "Corrections", text: note, source }],
  })}\n`);
  agent.must("learnings", "persist", "--slug", stage, "--selections-json", file);
}

/** A document the stage wrote and its review read. */
function reviewedDocument(agent: AgentStandIn, stage: string): string {
  const produces = (agent.worked.findLast((d) => d.stage === stage)?.produces as string[] | undefined) ?? [];
  const doc = produces.find((p) => p.endsWith(".md") && !p.endsWith("-questions.md") && existsSync(join(agent.host.proj, p)));
  if (doc === undefined) throw new Error(`${stage} wrote no document`);
  return doc;
}

describe("next between a stage's review and its gate", () => {
  // Every other stage, the agent fixes something in a reviewed document first.
  const EDITED = ["user-stories", "domain-design", "contract-design"];

  test("next between a stage's review and its gate brings the gate, not the stage again", () => {
    const walk = new Walk("empty", { learnings: REVIEWED });
    const { agent } = walk;
    walk.run(agent.begin("build the classic work", ["--scope", "classic", "--skip", SKIPPED.join(",")]), (_, stage) => {
      answerLearnings(agent, stage);
      const edit = EDITED.includes(stage);
      if (edit) {
        // Guard Policy off (classic's own): the change is carried to the gate.
        const doc = reviewedDocument(agent, stage);
        agent.host.write(doc, `${readFileSync(join(agent.host.proj, doc), "utf-8")}\nA small fix after the review.\n`);
      }
      return walk.toGate(`${stage}${edit ? " (after an edit)" : ""}`, stage, agent.next(), "awaiting-approval", false);
    });
    expect(walk.moved).toEqual(REVIEWED.map((stage) => `learnings ${stage}`));
    expect(walk.problems).toEqual([]);
    expect(walk.learningsAsked()).toEqual(Object.fromEntries(REVIEWED.map((stage) => [stage, 1])));
  }, SCOPE_RUN_TIMEOUT_MS);
});

describe("a new chat between a stage's review and its gate", () => {
  // At the open learnings question the chat ends; the new chat shows it again and the person answers it there.
  const ANSWERED_IN_NEW_CHAT = ["requirements-analysis", "domain-design"];
  // The person answers the learnings question, then the chat ends before the gate.
  const ANSWERED_BEFORE = ["user-stories", "units-generation"];
  // The chat ends right after the review, before the learnings question is asked.
  const AFTER_REVIEW = ["refined-mockups", "contract-design"];

  test("a new chat between a stage's review and its gate picks up at the gate (learnings on)", () => {
    const walk = new Walk("empty", { learnings: [...ANSWERED_IN_NEW_CHAT, ...ANSWERED_BEFORE], review: AFTER_REVIEW });
    const { agent } = walk;
    walk.run(agent.begin("build the classic work", ["--scope", "classic", "--skip", SKIPPED.join(",")]), (point, stage) => {
      if (point === "review") {
        agent.host.newSession();
        const first = agent.personTypes("/aidlc --resume");
        walk.learningsStep(`${stage} (after the review)`, first, true);
        agent.learnings({ stage });
        return walk.toGate(`${stage} (after the review, then learnings)`, stage, agent.next(), "awaiting-approval", false);
      }
      if (ANSWERED_IN_NEW_CHAT.includes(stage)) {
        agent.host.newSession();
        const again = agent.personTypes("/aidlc --resume");
        expect(String(again.message), JSON.stringify(again)).toContain("has a question you asked");
        answerLearnings(agent, stage);
        return walk.toGate(`${stage} (answered in the new chat)`, stage, agent.next(), "awaiting-approval", false);
      }
      answerLearnings(agent, stage);
      agent.host.newSession();
      return walk.toGate(`${stage} (answered, then a new chat)`, stage, agent.personTypes("/aidlc --resume"), "awaiting-approval", true);
    });
    expect(walk.moved.sort()).toEqual([
      ...[...ANSWERED_IN_NEW_CHAT, ...ANSWERED_BEFORE].map((stage) => `learnings ${stage}`),
      ...AFTER_REVIEW.map((stage) => `review ${stage}`),
    ].sort());
    expect(walk.problems).toEqual([]);
    expect(walk.learningsAsked()).toEqual(Object.fromEntries(REVIEWED.map((stage) => [stage, 1])));
  }, SCOPE_RUN_TIMEOUT_MS);

  test("a pick to add a note that is not yet written keeps the stage's route; once written, the gate comes", () => {
    const stages = ["requirements-analysis", "user-stories", "refined-mockups"];
    const walk = new Walk("empty", { learnings: stages }, (stage) => stage === "domain-design");
    const { agent } = walk;
    // The chat ends with a pick not yet written; the new chat must not be taken past it to the gate.
    const resumedBeforeTheNote = (where: string) => {
      agent.host.newSession();
      const first = agent.personTypes("/aidlc --resume");
      if (String(first.message ?? "").includes("No further review pass follows")) {
        walk.problems.push(`${where}: handed the step after the review: ${clip(String(first.message), 300)}`);
      }
      expect(first.kind, JSON.stringify(first)).not.toBe("error");
    };
    walk.run(agent.begin("build the classic work", ["--scope", "classic", "--skip", SKIPPED.join(",")]), (_, stage) => {
      if (stage === "refined-mockups") {
        // The question box asked which diary notes to keep as well; the person kept one.
        agent.person.pick(LEARNINGS_KEEP, [LEARNINGS_KEEP_NONE, "Use the design system's spacing"], "Use the design system's spacing");
        answerLearnings(agent, stage);
        resumedBeforeTheNote(`${stage} (a kept note not yet written)`);
        writeNote(agent, stage, "Use the design system's spacing", "orchestrator");
        return walk.toGate(`${stage} (the kept note written in the new chat)`, stage, agent.next(), "awaiting-approval", false);
      }
      // The person picks Add a note; the agent asks what it should say, and that ends the turn.
      answerLearnings(agent, stage, "Add a note");
      if (stage === "requirements-analysis") {
        resumedBeforeTheNote(`${stage} (a note to add not yet written)`);
        agent.person.say("Name each requirement after the person who asked for it.");
        writeNote(agent, stage, "Name each requirement after the person who asked for it.", "user_addition");
        return walk.toGate(`${stage} (the note written in the new chat)`, stage, agent.next(), "awaiting-approval", false);
      }
      agent.person.say("Keep each story to one screen.");
      writeNote(agent, stage, "Keep each story to one screen.", "user_addition");
      agent.host.newSession();
      return walk.toGate(`${stage} (the note written, then a new chat)`, stage, agent.personTypes("/aidlc --resume"), "awaiting-approval", true);
    });
    expect(walk.moved).toEqual(stages.map((stage) => `learnings ${stage}`));
    expect(walk.problems).toEqual([]);
    const notes = auditEvents(agent.host.proj).filter((row) => row.event === "RULE_LEARNED");
    expect(notes.map((row) => [field(row.block, "Stage"), field(row.block, "Source")])).toEqual([
      ["requirements-analysis", "user_addition"], ["user-stories", "user_addition"], ["refined-mockups", "orchestrator"],
    ]);
  }, SCOPE_RUN_TIMEOUT_MS);

  test("a new chat between a stage's review and its gate picks up at the gate (learnings off, and a revision)", () => {
    const stage = "requirements-analysis";
    const walk = new Walk("code", { review: [stage], gate: [stage] });
    const { agent } = walk;
    walk.run(agent.begin("fix the bug", ["--scope", "bugfix"]), (point) => {
      if (point === "review") {
        agent.host.newSession();
        return walk.toGate(`${stage} (after the review)`, stage, agent.personTypes("/aidlc --resume"), "awaiting-approval", true);
      }
      // At the gate the person asks for a change; the agent revises, and the
      // reviewer looks again. The chat ends right after that verdict.
      agent.askPerson("approval", stage, `${stage} is ready for your review. How would you like to proceed?`,
        ["Approve", "Request Changes"], "Request Changes");
      agent.report(stage, "--result", "rejected", "--user-input", "Request Changes");
      const doc = reviewedDocument(agent, stage);
      agent.host.write(doc, `${readFileSync(join(agent.host.proj, doc), "utf-8")}\nThe change the person asked for.\n`);
      agent.review({ stage, reviewer: agent.worked.findLast((d) => d.stage === stage)?.reviewer });
      agent.host.newSession();
      return walk.toGate(`${stage} (after the revision's review)`, stage, agent.personTypes("/aidlc --resume"), "revised", true);
    });
    expect(walk.moved).toEqual([`review ${stage}`, `gate ${stage}`]);
    expect(walk.problems).toEqual([]);
    expect(walk.learningsAsked()).toEqual({});
  }, SCOPE_RUN_TIMEOUT_MS);
});
