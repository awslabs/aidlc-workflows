// A person move in a scope run, with no model (tests/harness/scope-run.ts):
// classic with two Units, Functional Design kept, both Units built and
// approved, and the walk at Build and Test. The person then goes back. The
// t-scope-run-moves-jump-back* files make the moves; these are their steps.

import { expect } from "bun:test";
import { cleanupTestProject } from "./fixtures.ts";
import {
  type AgentStandIn,
  auditEvents,
  type Directive,
  field,
  runScope,
  type ScopeRun,
  ScopeRunStuck,
} from "./scope-run.ts";

export const UNITS = ["core", "extra"];
// Functional Design is kept, so a jump back past it, or not, means something.
const SKIPPED = [
  "practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design",
  "delivery-planning", "nfr-requirements", "nfr-design", "infrastructure-design",
];

export type Policy = "off" | "strict";

const runs: ScopeRun[] = [];
export function cleanupJumpBackRuns(): void {
  for (const run of runs.splice(0)) cleanupTestProject(run.proj);
}

/** Where the person speaks: the run stops there and the test makes their move. */
class PersonSpeaks extends ScopeRunStuck {}

/**
 * Both Units approved at their checkpoints. "gate": Build and Test's approval
 * is open. "work": Build and Test's work is handed out (`first`).
 */
export function toBuildAndTest(policy: Policy, at: "gate" | "work"): { run: ScopeRun; first?: Directive } {
  let stopped = false;
  let run: ScopeRun | undefined;
  try {
    runScope("classic", {
      units: UNITS,
      flags: ["--skip", SKIPPED.join(","), ...(policy === "strict" ? ["--guard-policy", "strict"] : [])],
      answers: {
        approve: (stage) => {
          if (at === "gate" && stage === "build-and-test" && !stopped) {
            stopped = true;
            throw new PersonSpeaks("Build and Test's approval is open");
          }
          return "Approve";
        },
      },
      afterCheckpoint: (unit) => {
        if (at === "work" && unit === UNITS.at(-1) && !stopped) {
          stopped = true;
          throw new PersonSpeaks("both Units are approved");
        }
      },
    });
  } catch (error) {
    if (!(error instanceof PersonSpeaks) || !error.run) throw error;
    run = error.run;
  }
  if (!run) throw new Error("the run reached done without stopping where the person speaks");
  runs.push(run);
  if (at === "gate") return { run };
  // The stage completions after the last checkpoint, up to Build and Test's work.
  const { agent } = run;
  let d = agent.next();
  for (let i = 0; i < 12 && !(d.kind === "run-stage" && d.stage === "build-and-test"); i++) {
    if (d.kind === "run-stage") agent.runStage(d);
    d = agent.next();
  }
  expect(d.stage).toBe("build-and-test");
  return { run, first: d };
}

/** Run the one engine command a print names, then `next`. */
export function followPrint(agent: AgentStandIn, d: Directive): { ran: string; said: string; next: Directive } {
  const message = String(d.message ?? "");
  const command = /`(bun \.claude\/tools\/[^`]+)`/.exec(message)?.[1];
  expect(command, message).toBeDefined();
  const res = agent.host.bash(command!);
  expect(res.status, res.stdout + res.stderr).toBe(0);
  return { ran: command!, said: message, next: agent.next() };
}

export function approved(agent: AgentStandIn, unit: string): boolean {
  const res = agent.host.engine("bolt", "checkpoint", "--action", "status", "--unit", unit, "--kind", "unit");
  return (JSON.parse(res.stdout.trim()) as { approved?: boolean }).approved === true;
}

export type Marks = { worked: number; asked: number; rows: Set<string> };
const rowKey = (row: { shard: string; pos: number }) => `${row.shard}#${row.pos}`;

export const marksOf = (agent: AgentStandIn): Marks => ({
  worked: agent.worked.length,
  asked: agent.asked.length,
  rows: new Set(auditEvents(agent.host.proj).map(rowKey)),
});

/** What happened after the move: each stage pass, question and review request, with its Unit. */
export function after(agent: AgentStandIn, marks: Marks): { worked: string[]; asked: string[]; reviewed: string[] } {
  return {
    worked: agent.worked.slice(marks.worked).map((d) => `${String(d.stage)}/${typeof d.unit === "string" ? d.unit : "-"}`),
    asked: agent.asked.slice(marks.asked).map((q) => `${q.what} at ${q.stage}${q.unit ? ` for ${q.unit}` : ""}`),
    reviewed: auditEvents(agent.host.proj)
      .filter((row) => row.event === "REVIEW_REQUESTED" && !marks.rows.has(rowKey(row)))
      .map((row) => `${field(row.block, "Stage")}/${field(row.block, "Unit") ?? "-"}`),
  };
}

/** The person's words at Build and Test's open gate, read as a jump (SKILL: report --result resumed). */
export function jumpAtGate(agent: AgentStandIn, words: string, target: string, unit?: string): Directive {
  agent.askPerson("approval", "build-and-test", "build-and-test is ready for your review. How would you like to proceed?",
    ["Approve", "Request Changes"], words);
  const report = agent.host.engine("orchestrate", "report", "--result", "resumed", "--choice", "jump",
    "--target", target, ...(unit ? ["--unit", unit] : []));
  expect(report.status, report.stdout + report.stderr).toBe(0);
  const accepted = JSON.parse(report.stdout.trim()) as Directive;
  const named = /`next((?: [^`]*)?)`/.exec(String(accepted.message ?? ""))?.[1]?.trim().split(/\s+/).filter(Boolean);
  expect(named, String(accepted.message)).toBeDefined();
  return agent.next(...named!);
}

/** The first step after the move is Code Generation (its work, or its plan question) for the Unit(s) named. */
export function expectCodeGenerationFor(d: Directive, unit?: string): void {
  const shown = JSON.stringify(d).slice(0, 1200);
  expect(d.stage, shown).toBe("code-generation");
  if (unit !== undefined && d.kind === "run-stage") expect(d.unit, shown).toBe(unit);
}

/** Only these Units' stage passes, and only at these stages. */
export const unitWork = (lines: string[]) => lines.filter((line) => UNITS.some((unit) => line.endsWith(`/${unit}`)));
