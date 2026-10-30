// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-utility:recompose, audit:UNIT_SKIPPED
//
// A skip the person asks for while Construction walks Unit by Unit is carried
// out. The record's Current Stage stays on the walk's first stage (Functional
// Design) while a Unit is on a later step, so "skip code generation" used to be
// sent to recompose as a stage ahead, and recompose's check that later stages
// keep what they read refused it (Build and Test reads what Code Generation
// writes). The engine now names both ways, this Unit only or every Unit from
// here, and the agent runs the one the person meant. "Skip build and test"
// mid-walk is a plan change recompose now carries out for the person too.
//
// Mechanism: cli - spawns the shipped tools against temp projects created via
// intent-create, walked to a Unit's step through the tools; the person's words
// go through the human-turn hook every harness uses.

import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { cleanupTestProject, runOrchestrateNext, setupIntegrationProject } from "../harness/fixtures.ts";
import {
  artifactFilename, auditBlockField, MESSAGE_FILL, MESSAGE_SLOT, readAllAuditShards, readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

// The stage's checks run once before its review or gate, and again at the gate
// (completionChecksStep, t-checks-before-review); this file's fixture documents
// are not written for them and its subject is not them, so they stay off here.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 3);

const SESSION = "01995000-7a11-7000-8000-00000000e3e3";
const PERSON = "the person asked to skip it";

const env: Record<string, string | undefined> = { ...process.env, AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_UNATTENDED: "0" };
for (const key of ["AIDLC_SCOPE_MAPPING", "AIDLC_SCOPE_GRID", "AIDLC_SCOPES_DIR", "AIDLC_COMPOSED_SCOPES_DIR", "AIDLC_STAGE_GRAPH", "AWS_AIDLC_DEFAULT_SCOPE"]) {
  delete env[key];
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

const DESIGN: Record<string, { produces: string[]; reviewed: string }> = {
  "functional-design": { produces: ["entities", "rules", "functional-spec", "frontend-components", "traceability"], reviewed: "functional-spec" },
  "nfr-requirements": {
    produces: ["performance-requirements", "security-requirements", "scalability-requirements", "reliability-requirements", "observability-requirements", "tech-stack-decisions", "traceability"],
    reviewed: "security-requirements",
  },
  "nfr-design": {
    produces: ["performance-design", "security-design", "scalability-design", "reliability-design", "observability-design", "logical-components", "traceability"],
    reviewed: "security-design",
  },
  "infrastructure-design": { produces: ["infrastructure-specification", "monitoring-design", "cicd-pipeline", "traceability"], reviewed: "cicd-pipeline" },
};
const CODE = ["code-generation-plan", "unit-test-instructions", "code-summary", "traceability"];

function run(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...env, CLAUDE_PROJECT_DIR: proj },
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// What the person types, through the human-turn hook every harness uses; the
// id of the message the hook kept.
function says(proj: string, prompt: string): string | null {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(res.status, res.stderr).toBe(0);
  const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1);
  return turn === undefined ? null : auditBlockField(turn.block, "Message Id");
}

function stateFile(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const record = readdirSync(intents).find((name) => existsSync(join(intents, name, "aidlc-state.md")));
  return join(intents, String(record), "aidlc-state.md");
}

type Step = {
  kind?: string;
  stage?: string;
  unit?: string;
  message?: string;
  receipt?: string;
  construction_checkpoint?: unknown;
  kept_replies?: unknown;
};

function next(proj: string, args: string[] = []): Step {
  const tool = join(proj, ".claude", "tools", "aidlc-orchestrate.ts");
  const opts = { cwd: proj, env: { ...env, CLAUDE_PROJECT_DIR: proj } };
  let step = runOrchestrateNext(tool, proj, args, opts).directive as Step;
  if (step?.kind === "load-steering") {
    const res = run(proj, "aidlc-orchestrate.ts", ["continue", String(step.receipt)]);
    step = JSON.parse(res.out.split("\n").find((line) => line.trim().startsWith("{")) ?? "{}") as Step;
  }
  return step;
}

// A feature piece of work walked Unit by Unit, Current Stage left on
// Functional Design as the walk leaves it. `units[0]`'s first `designed`
// design steps (all four with true, none with false) are written, reviewed
// READY and recorded complete through the tools, so it is on the next one, or
// on its Code Generation after all four.
// The person turned the summary confirmation off earlier.
function walk(units: string[], designed: boolean | number = true): string {
  const steps = Object.entries(DESIGN).slice(0, designed === true ? 4 : designed === false ? 0 : designed);
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  const created = run(proj, "aidlc-utility.ts", ["intent-create", "--scope", "feature"]);
  expect(created.status, created.out).toBe(0);
  const path = stateFile(proj);
  const record = dirname(path);
  let seen = false;
  const lines = readFileSync(path, "utf-8").split("\n").map((line) => {
    const row = /^- \[.\] ([a-z0-9-]+) \u2014 (EXECUTE|SKIP)$/.exec(line);
    if (!row) return line;
    if (row[1] === "functional-design") {
      seen = true;
      return `- [-] ${row[1]} \u2014 ${row[2]}`;
    }
    return !seen && row[2] === "EXECUTE" ? `- [x] ${row[1]} \u2014 ${row[2]}` : line;
  });
  writeFileSync(path, lines.join("\n")
    .replace(/- \*\*Current Stage\*\*: .*/, "- **Current Stage**: functional-design")
    .replace(/- \*\*In Progress\*\*: .*/, "- **In Progress**: functional-design")
    .replace(/- \*\*Lifecycle Phase\*\*: .*/, "- **Lifecycle Phase**: CONSTRUCTION")
    .replace("- **State Version**: 8", "- **State Version**: 8\n- **Unit Ownership**: solo\n- **Skeleton Stance**: on")
    .replace(/- \*\*Summary Confirmation\*\*: .*/, "- **Summary Confirmation**: off (set by you)"));
  writeFileSync(join(record, "runtime-graph.json"), `${JSON.stringify({
    bolt_dag: { units: units.map((name) => ({ name, depends_on: [] })), batches: [units] },
  }, null, 2)}\n`);
  const unit = units[0];
  const reviewer = "aidlc-architecture-reviewer-agent";
  for (const [stage, { produces, reviewed }] of steps) {
    const dir = join(record, "construction", unit, stage);
    mkdirSync(dir, { recursive: true });
    for (const name of produces) writeFileSync(join(dir, artifactFilename(name)), `# ${name} for ${unit}\n`);
    const review = ["review", "--stage", stage, "--reviewer", reviewer, "--unit", unit, "--iteration", "1"];
    const asked = run(proj, "aidlc-log.ts", review);
    expect(asked.status, asked.out).toBe(0);
    appendFileSync(join(dir, artifactFilename(reviewed)),
      `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`);
    const verdict = run(proj, "aidlc-log.ts", [...review, "--verdict", "READY"]);
    expect(verdict.status, verdict.out).toBe(0);
    for (const verb of ["start", "complete"]) {
      const done = run(proj, "aidlc-state.ts", ["unit", verb, "--stage", stage, "--unit", unit]);
      expect(done.status, done.out).toBe(0);
    }
  }
  const at = next(proj);
  expect(at.kind, JSON.stringify(at)).toBe("run-stage");
  expect(at.stage).toBe([...Object.keys(DESIGN), "code-generation"][steps.length]);
  expect(at.unit).toBe(unit);
  return proj;
}

function named(step: Step): string[] {
  return [...String(step.message).matchAll(/`([^`]*(?:engine recompose|aidlc-orchestrate\.ts report)[^`]*)`/g)]
    .map((match) => match[1])
    .filter((command) => !command.includes("--add"));
}

function runNamed(proj: string, command: string): { status: number; out: string } {
  const words = command.split(" ");
  const at = words.findIndex((word) => word.endsWith("aidlc.ts") || word.endsWith("aidlc-orchestrate.ts"));
  const args: string[] = [];
  let quoted: string | null = null;
  for (const word of words.slice(at + 1)) {
    if (quoted !== null) {
      quoted += ` ${word}`;
      if (word.endsWith("'")) {
        args.push(quoted.slice(1, -1));
        quoted = null;
      }
    } else if (word.startsWith("'") && !word.endsWith("'")) quoted = word;
    else args.push(word.replace(/^'(.*)'$/, "$1"));
  }
  return run(proj, words[at].endsWith("aidlc.ts") ? "aidlc.ts" : "aidlc-orchestrate.ts", args);
}

const THIS_UNIT = `bun .claude/tools/aidlc-orchestrate.ts report --stage code-generation --unit alpha --result skipped --reason '${PERSON}'`;
const EVERY_UNIT = `bun .claude/tools/aidlc.ts engine recompose --skip code-generation --reason '${PERSON}'`;
// The walk's first stage is the record's Current Stage itself: skipped for one
// Unit at its beat, and for every Unit from here by the stage's own skip.
const FIRST_THIS_UNIT = `bun .claude/tools/aidlc-orchestrate.ts report --stage functional-design --unit alpha --result skipped --reason '${PERSON}'`;
const FIRST_EVERY_UNIT = `bun .claude/tools/aidlc-orchestrate.ts report --stage functional-design --result skipped --reason '${PERSON}'`;
const EVERY_FROM = "If they name no Unit, they mean every Unit from here";

describe("a skip the person asks for while Construction walks Unit by Unit is carried out", () => {
  test("Code Generation for this Unit only: the Unit is skipped, owes no checkpoint, and the walk goes on to the next Unit", () => {
    const proj = walk(["alpha", "beta"]);
    says(proj, "skip code generation for this unit, I'll write that code myself");
    const step = next(proj, ["--skip", "code-generation"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(named(step)).toContain(THIS_UNIT);
    expect(step.message).toContain(
      '"Skipped Code Generation for the alpha Unit; the other Units still get it. It can still be run for that Unit with `/aidlc --stage code-generation --unit alpha`."',
    );
    // Words that name no Unit mean every Unit from here: the engine asks no question.
    expect(step.message).not.toContain('only, or for every Unit from here?');
    const skipped = runNamed(proj, THIS_UNIT);
    expect(skipped.status, skipped.out).toBe(0);
    expect(skipped.out).toContain('for unit \\"alpha\\" only');
    expect(readAllAuditShards(proj)).toMatch(/\*\*Event\*\*: UNIT_SKIPPED\n\*\*Stage\*\*: code-generation\n\*\*Unit\*\*: alpha\n\*\*Reason\*\*: the person asked to skip it\n/);
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- [ ] code-generation \u2014 EXECUTE");
    // No checkpoint asks to approve a Unit with no code: beta's design is next.
    const after = next(proj);
    expect(after.kind, JSON.stringify(after)).toBe("run-stage");
    expect(after.stage).toBe("functional-design");
    expect(after.unit).toBe("beta");
    expect(after.construction_checkpoint ?? null).toBeNull();
    // beta's own question, still unanswered, is not handed the skip.
    const questions = join(dirname(stateFile(proj)), "construction", "beta", "functional-design", "functional-design-questions.md");
    mkdirSync(dirname(questions), { recursive: true });
    writeFileSync(questions, "# Functional Design Questions\n\n## Question 1\nWhat does it greet?\n\n[Answer]:\n");
    expect(JSON.stringify(next(proj).kept_replies ?? null)).not.toContain("skip code generation");
  });

  // A setting asked for in plain words beside the skip names the message they
  // asked in, so it lands as theirs (t-set-by-you-needs-their-reply).
  test("a setting asked for beside the skip names their message", () => {
    const proj = walk(["alpha", "beta"]);
    const id = says(proj, "skip code generation for this unit, and turn the sensors off");
    expect(id).not.toBeNull();
    const step = next(proj, ["--skip", "code-generation", "--sensors", "off"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).toContain(`config set sensors off --message '${MESSAGE_SLOT}'\`${MESSAGE_FILL} (${id}, sent `);
    expect(step.message).toContain("and print its output verbatim.");
    expect(step.message).not.toContain("--person-words");
  });

  test("this Unit only when the Unit's code files are already written: still skipped as the person asked", () => {
    const proj = walk(["alpha", "beta"]);
    const dir = join(dirname(stateFile(proj)), "construction", "alpha", "code-generation");
    mkdirSync(dir, { recursive: true });
    for (const name of CODE) writeFileSync(join(dir, artifactFilename(name)), `# ${name} for alpha\n`);
    const step = next(proj, ["--skip", "code-generation"]);
    expect(named(step)).toContain(THIS_UNIT);
    const skipped = runNamed(proj, THIS_UNIT);
    expect(skipped.status, skipped.out).toBe(0);
    expect(skipped.out).toContain('for unit \\"alpha\\" only');
    expect(next(proj).unit).toBe("beta");
  });

  test("Code Generation for every Unit from here: the plan stops running it and the walk goes on to the next Unit", () => {
    const proj = walk(["alpha", "beta"]);
    const step = next(proj, ["--skip", "code-generation"]);
    expect(named(step)).toContain(EVERY_UNIT);
    expect(step.message).toContain('"Skipped Code Generation for every Unit from here. You can undo that until Build and Test starts."');
    expect(step.message).toContain(
      "If they later ask to undo skipping it for every Unit, run " +
        "`bun .claude/tools/aidlc.ts engine recompose --add code-generation`.",
    );
    const replanned = runNamed(proj, EVERY_UNIT);
    expect(replanned.status, replanned.out).toBe(0);
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- [ ] code-generation \u2014 SKIP");
    const after = next(proj);
    expect(after.kind, JSON.stringify(after)).toBe("run-stage");
    expect(after.stage).toBe("functional-design");
    expect(after.unit).toBe("beta");
    expect(after.construction_checkpoint ?? null).toBeNull();
  });

  // Current Stage stays on the walk's first step while the Units take the
  // walk, so the undo of a walk step taken off the plan holds until the stage
  // after the walk starts; at Build and Test it is behind the work.
  test("Code Generation for every Unit from here: its undo holds until Build and Test starts, and is refused there", () => {
    const proj = walk(["alpha", "beta"]);
    const step = next(proj, ["--skip", "code-generation"]);
    const undo = /If they later ask to undo skipping it for every Unit, run `([^`]*)`/.exec(String(step.message))?.[1] ?? "";
    expect(undo, step.message).toContain("engine recompose --add code-generation");
    expect(runNamed(proj, EVERY_UNIT).status).toBe(0);
    const back = runNamed(proj, undo);
    expect(back.status, back.out).toBe(0);
    expect(runNamed(proj, EVERY_UNIT).status).toBe(0);
    const jumped = run(proj, "aidlc-jump.ts", ["execute", "--target", "build-and-test", "--direction", "forward", "--scope", "feature"]);
    expect(jumped.status, jumped.out).toBe(0);
    const late = runNamed(proj, undo);
    expect(late.status).not.toBe(0);
    expect(late.out).toContain("--stage code-generation --single");
  });

  test("with no other Unit left to build it, one command skips it, the stage is marked skipped, and the line names the Unit", () => {
    const proj = walk(["alpha"]);
    const step = next(proj, ["--skip", "code-generation"]);
    expect(named(step)).toEqual([THIS_UNIT]);
    expect(step.message).toContain(
      '"Skipped Code Generation for the alpha Unit. It can still be run for that Unit with `/aidlc --stage code-generation --unit alpha`."',
    );
    const skipped = runNamed(proj, THIS_UNIT);
    expect(skipped.status, skipped.out).toBe(0);
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- [S] code-generation \u2014 EXECUTE");
    const after = next(proj);
    expect(after.stage === "code-generation" && after.unit === "alpha", JSON.stringify(after)).toBe(false);
    expect(after.construction_checkpoint ?? null).toBeNull();
  });

  // Marked skipped because every Unit skipped it, not skipped where it stood:
  // its Units' skips, not its mark, say who owes it, so an add does not claim
  // to put it back (the way back is the Unit's own run the skip line named).
  test("a stage every Unit skipped, added again, is not said to be back on the plan, and its mark stays", () => {
    const proj = walk(["alpha"]);
    expect(runNamed(proj, THIS_UNIT).status).toBe(0);
    const before = readFileSync(stateFile(proj), "utf-8");
    expect(before).toContain("- [S] code-generation \u2014 EXECUTE");
    const step = next(proj, ["--add", "code-generation"]);
    expect(String(step.message), JSON.stringify(step)).not.toContain("back on the plan");
    expect(String(step.message), JSON.stringify(step)).not.toContain("recompose --add");
    const added = run(proj, "aidlc.ts", ["engine", "recompose", "--add", "code-generation"]);
    expect(added.status, added.out).not.toBe(0);
    expect(added.out).toContain("its checkbox is not pending ([skipped])");
    expect(readFileSync(stateFile(proj), "utf-8")).toBe(before);
  });

  test("Code Generation named while the Unit is still on its design: the step says it covers every Unit", () => {
    const proj = walk(["alpha", "beta"], false);
    const step = next(proj, ["--skip", "code-generation"]);
    expect(named(step)).toEqual([EVERY_UNIT]);
    expect(step.message).toContain("covers every Unit");
    expect(step.message).toContain('"Code Generation can be skipped for one Unit while that Unit is working on it; the alpha Unit is on Functional Design now."');
    expect(step.message).toContain('"Skipped Code Generation for every Unit from here. You can undo that until Build and Test starts."');
  });

  test("Build and Test said mid-walk is taken off the plan, and the Unit carries on", () => {
    const proj = walk(["alpha", "beta"]);
    const step = next(proj, ["--skip", "build-and-test"]);
    expect(named(step)).toEqual([`bun .claude/tools/aidlc.ts engine recompose --skip build-and-test --reason '${PERSON}'`]);
    // Build and Test is no step of the walk: its undo holds until the work moves past it (t-skip-undo-window).
    expect(step.message).toContain('"Skipped Build and Test. You can undo that until the work moves past it."');
    const replanned = runNamed(proj, named(step)[0]);
    expect(replanned.status, replanned.out).toBe(0);
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- [ ] build-and-test \u2014 SKIP");
    const after = next(proj);
    expect(after.stage, JSON.stringify(after)).toBe("code-generation");
    expect(after.unit).toBe("alpha");
  });

  // What keeps a plan change the agent or the composer makes on its own from
  // starving a later stage: without the person's reason recompose still refuses.
  test("a plan change that starves a later stage is still refused when the person did not ask for it", () => {
    const proj = walk(["alpha", "beta"]);
    const before = readFileSync(stateFile(proj), "utf-8");
    const own = run(proj, "aidlc.ts", ["engine", "recompose", "--skip", "code-generation"]);
    expect(own.status).not.toBe(0);
    expect(own.out).toContain("Recompose rejected by the strict validator");
    expect(readFileSync(stateFile(proj), "utf-8")).toBe(before);
  });

  test("the agent's own skip of the Unit's Code Generation is refused, naming next --skip", () => {
    const proj = walk(["alpha", "beta"]);
    const before = readFileSync(stateFile(proj), "utf-8");
    const own = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "code-generation", "--unit", "alpha", "--result", "skipped", "--reason", "the person will write it",
    ]);
    expect(own.out).toContain("only a CONDITIONAL stage can report skipped");
    expect(own.out).toContain(
      "If the person asked to skip it, run `bun .claude/tools/aidlc-orchestrate.ts next --skip code-generation`: " +
        "its step skips it the way they asked, for one Unit only or for every Unit.",
    );
    expect(readFileSync(stateFile(proj), "utf-8")).toBe(before);
  });

  // A new chat opened at the Unit's open question gets the person's plain
  // words, not a typed skip: the step for words at that question names the
  // skip too, as the one at a stage's approval question does.
  test("in a new chat, plain words at the Unit's open stage question name the skip", () => {
    const proj = walk(["alpha", "beta"]);
    const asked = run(proj, "aidlc-log.ts", [
      "decision", "--stage", "code-generation", "--unit", "alpha", "--decision", "Which greeting library?", "--options", "None,Intl",
    ]);
    expect(asked.status, asked.out).toBe(0);
    const step = next(proj, ["skip code generation for this unit"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).toContain(
      "If it asks to skip this stage, run `bun .claude/tools/aidlc-orchestrate.ts next --skip code-generation` and follow what it returns.",
    );
  });

  test("in a new chat, plain words at the Unit's open code plan question name the skip", () => {
    const proj = walk(["alpha", "beta"]);
    const dir = join(dirname(stateFile(proj)), "construction", "alpha", "code-generation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, artifactFilename("code-generation-plan")),
      "# Code Generation Plan for alpha\n\n## Summary\n\n- Builds: greet()\n- Touches: src/greet.ts\n- Tests: 2 unit tests\n\n" +
        `## Steps\n\n- [ ] Step 1: write greet\n\n${renderTestingContract(resolveTestingPosture(proj))}`);
    writeFileSync(join(dir, artifactFilename("unit-test-instructions")), "# Unit Test Instructions for alpha\n\nRun the tests.\n");
    const question = next(proj);
    expect(question.kind, JSON.stringify(question)).toBe("ask");
    const step = next(proj, ["skip code generation for this unit"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(step.message).toContain(
      "If it asks to skip Code Generation, run `bun .claude/tools/aidlc-orchestrate.ts next --skip code-generation` and follow what it returns.",
    );
  });

  // The words the person typed are spent by their own skip only: a step the
  // agent skips for a Unit on its own reading leaves them kept.
  test("the agent's own skip of a Unit's step that may be skipped keeps the person's words", () => {
    const proj = walk(["alpha", "beta"], 3);
    says(proj, "we deploy everything with the team's usual pipeline");
    const kept = (): string => {
      const found: string[] = [];
      const visit = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) visit(path);
          else found.push(readFileSync(path, "utf-8"));
        }
      };
      const dir = join(dirname(stateFile(proj)), ".aidlc-engine", "gate-words");
      if (existsSync(dir)) visit(dir);
      return found.join("\n");
    };
    expect(kept()).toContain("the team's usual pipeline");
    const own = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "infrastructure-design", "--unit", "alpha", "--result", "skipped", "--reason", "a library with no deployment",
    ]);
    expect(own.status, own.out).toBe(0);
    expect(own.out).toContain('for unit \\"alpha\\" only');
    expect(kept()).toContain("the team's usual pipeline");
  });

  // What the person asks for one Unit is done for that Unit only: another
  // step of the walk named with it is not taken off the plan for every Unit,
  // and the one line names every change that is made.
  test("this Unit only, with another walk step and a stage after the walk named too: only the Unit's step is skipped for it, and the line names every change", () => {
    const proj = walk(["alpha", "beta"], 1);
    const message = String(next(proj, ["--skip", "nfr-requirements,code-generation,build-and-test"]).message);
    const only = message.slice(message.indexOf("If their words mean the alpha Unit only"), message.indexOf(EVERY_FROM));
    expect(only, message).toContain("report --stage nfr-requirements --unit alpha --result skipped");
    expect(only).toContain(`engine recompose --skip build-and-test --reason '${PERSON}'`);
    expect(only).not.toMatch(/recompose --skip [^`]*code-generation/);
    expect(only).toContain(
      '"Skipped NFR Requirements for the alpha Unit and Build and Test; the other Units still get NFR Requirements. ' +
        "It can still be run for that Unit with `/aidlc --stage nfr-requirements --unit alpha`. You can undo the rest until the work moves past Build and Test. " +
        'Code Generation can be skipped for one Unit while that Unit is working on it."',
    );
    const every = message.slice(message.indexOf(EVERY_FROM));
    expect(every).toContain(`engine recompose --skip nfr-requirements,code-generation,build-and-test --reason '${PERSON}'`);
    expect(every).toContain(
      '"Skipped NFR Requirements and Code Generation for every Unit from here, and Build and Test. You can undo that until CI Pipeline starts."',
    );
  });

  // A Unit stopped on its step (paused, at its summary or its checkpoint) is
  // still that Unit's: a step of the walk named then covers every Unit, and
  // the step says so, as for a step the Unit has not reached.
  test("a walk step named while the Unit is paused on it: the step says it covers every Unit", () => {
    const proj = walk(["alpha", "beta"], 1);
    for (const args of [
      ["unit", "start", "--stage", "nfr-requirements", "--unit", "alpha"],
      ["unit", "pause", "--stage", "nfr-requirements", "--unit", "alpha", "--reason", "waiting on the security team",
        "--next-action", "write the security requirements"],
    ]) {
      const done = run(proj, "aidlc-state.ts", args);
      expect(done.status, done.out).toBe(0);
    }
    const step = next(proj, ["--skip", "nfr-requirements"]);
    expect(named(step)).toEqual([`bun .claude/tools/aidlc.ts engine recompose --skip nfr-requirements --reason '${PERSON}'`]);
    expect(step.message).toContain("covers every Unit");
    expect(step.message).toContain(
      '"NFR Requirements can be skipped for one Unit while that Unit is working on it; the alpha Unit is paused on NFR Requirements now."',
    );
    expect(step.message).toContain('"Skipped NFR Requirements for every Unit from here. You can undo that until Build and Test starts."');
  });

  // With no other Unit left to take the step, the Unit's own step is skipped
  // either way; only the other walk step named with it depends on the words.
  test("the last Unit to take its step, with another walk step named too: its own step is skipped either way, and the line names it", () => {
    const proj = walk(["alpha"], 1);
    const message = String(next(proj, ["--skip", "nfr-requirements,code-generation"]).message);
    const unitSkip = `report --stage nfr-requirements --unit alpha --result skipped --reason '${PERSON}'`;
    const only = message.slice(message.indexOf("If their words mean the alpha Unit only"), message.indexOf(EVERY_FROM));
    expect(only, message).toContain(unitSkip);
    expect(only).not.toMatch(/recompose --skip [^`]*code-generation/);
    expect(only).toContain(
      '"Skipped NFR Requirements for the alpha Unit. It can still be run for that Unit with `/aidlc --stage nfr-requirements --unit alpha`. ' +
        'Code Generation can be skipped for one Unit while that Unit is working on it."',
    );
    const every = message.slice(message.indexOf(EVERY_FROM));
    expect(every).toContain(unitSkip);
    expect(every).toContain(`engine recompose --skip code-generation --reason '${PERSON}'`);
    expect(every).toContain(
      '"Skipped NFR Requirements for the alpha Unit, and Code Generation for every Unit from here. It can still be run for that Unit with ' +
        '`/aidlc --stage nfr-requirements --unit alpha`. You can undo the rest until Build and Test starts."',
    );
    expect(message).not.toContain('only, or for every Unit from here?');
    expect(message).not.toContain("run nothing");
  });
});

// The walk's first stage is the record's Current Stage itself, so the step for
// a skip of it named the whole stage's report, which the skip check refuses
// while a Unit is on that stage ("Cannot skip ... without naming its unit"). It
// now names the two forms the later steps get: the Unit's own skip, or, for
// every Unit from here, the stage's own skip where it stands.
describe("a skip the person asks for at the walk's first stage, while a Unit is on it", () => {
  const segment = (message: string, from: string, to?: string): { message: string } =>
    ({ message: message.slice(message.indexOf(from), to === undefined ? undefined : message.indexOf(to)) });

  test("this Unit only: skipped for alpha, which goes on to its NFR Requirements", () => {
    const proj = walk(["alpha", "beta"], false);
    says(proj, "skip functional design for this unit");
    const step = next(proj, ["--skip", "functional-design"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    const only = segment(String(step.message), "If their words mean the alpha Unit only", EVERY_FROM);
    expect(named(only), String(step.message)).toEqual([FIRST_THIS_UNIT]);
    expect(only.message).toContain(
      '"Skipped Functional Design for the alpha Unit; the other Units still get it. It can still be run for that Unit with `/aidlc --stage functional-design --unit alpha`."',
    );
    const skipped = runNamed(proj, FIRST_THIS_UNIT);
    expect(skipped.status, skipped.out).toBe(0);
    expect(skipped.out).toContain('for unit \\"alpha\\" only');
    const after = next(proj);
    expect(`${after.kind} ${after.stage}/${after.unit}`, JSON.stringify(after)).toBe("run-stage nfr-requirements/alpha");
  });

  test("every Unit from here: the stage is skipped where it stands, alpha goes on, and beta never gets it", () => {
    const proj = walk(["alpha", "beta"], false);
    const step = next(proj, ["--skip", "functional-design"]);
    const every = segment(String(step.message), EVERY_FROM);
    expect(named(every), String(step.message)).toEqual([FIRST_EVERY_UNIT]);
    expect(every.message).toContain(
      '"Skipped Functional Design for every Unit from here. It can still be run on its own with `/aidlc --stage functional-design --single`."',
    );
    const skipped = runNamed(proj, FIRST_EVERY_UNIT);
    expect(skipped.status, skipped.out).toBe(0);
    expect(skipped.out).not.toContain('"kind":"error"');
    const state = readFileSync(stateFile(proj), "utf-8");
    expect(state).toContain("- [S] functional-design \u2014 EXECUTE");
    expect(state).toContain("- **Current Stage**: nfr-requirements");
    // alpha's other steps, each skipped for it as the person asks, then beta:
    // its walk starts at NFR Requirements.
    let at = next(proj);
    for (const stage of ["nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"]) {
      expect(`${at.kind} ${at.stage}/${at.unit}`, JSON.stringify(at)).toBe(`run-stage ${stage}/alpha`);
      const own = run(proj, "aidlc-orchestrate.ts", ["report", "--stage", stage, "--unit", "alpha", "--result", "skipped", "--reason", PERSON]);
      expect(own.status, own.out).toBe(0);
      at = next(proj);
    }
    expect(`${at.kind} ${at.stage}/${at.unit}`, JSON.stringify(at)).toBe("run-stage nfr-requirements/beta");
  });

  test("every Unit from here, then asked back as the next stage starts: it is back on the plan and alpha runs it next", () => {
    const proj = walk(["alpha", "beta"], false);
    next(proj, ["--skip", "functional-design"]);
    expect(runNamed(proj, FIRST_EVERY_UNIT).status).toBe(0);
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- **Current Stage**: nfr-requirements");
    const step = next(proj, ["--add", "functional-design"]);
    expect(String(step.message), JSON.stringify(step)).toContain("Put Functional Design back on the plan.");
    const added = run(proj, "aidlc.ts", ["engine", "recompose", "--add", "functional-design"]);
    expect(added.status, added.out).toBe(0);
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- [ ] functional-design \u2014 EXECUTE");
    const route = next(proj);
    const jump = /`[^`]*aidlc-jump\.ts (execute --target functional-design --direction backward[^`]*)`/.exec(String(route.message))?.[1];
    expect(jump, JSON.stringify(route)).toBeDefined();
    const jumped = run(proj, "aidlc-jump.ts", String(jump).split(" "));
    expect(jumped.status, jumped.out).toBe(0);
    const at = next(proj);
    expect(`${at.kind} ${at.stage}/${at.unit}`, JSON.stringify(at)).toBe("run-stage functional-design/alpha");
  });

  // A scope switch typed with the skip runs first; the walk's first stage is
  // then skipped as the skip alone skips it, never sent to recompose.
  test("with a scope switch in the same command: the switch runs first, then this Unit or every Unit from here", () => {
    const proj = walk(["alpha", "beta"], false);
    const step = next(proj, ["--scope", "refactor", "--skip", "functional-design"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    const message = String(step.message);
    expect(message).toStartWith("Run `bun .claude/tools/aidlc.ts engine scope change --scope refactor`");
    expect(message).not.toContain("engine recompose --skip functional-design");
    expect(named(segment(message, "If their words mean the alpha Unit only", EVERY_FROM)), message).toEqual([FIRST_THIS_UNIT]);
    expect(named(segment(message, EVERY_FROM)), message).toEqual([FIRST_EVERY_UNIT]);
    const switched = runNamed(proj, "bun .claude/tools/aidlc.ts engine scope change --scope refactor");
    expect(switched.status, switched.out).toBe(0);
    const skipped = runNamed(proj, FIRST_EVERY_UNIT);
    expect(skipped.status, skipped.out).toBe(0);
    const state = readFileSync(stateFile(proj), "utf-8");
    expect(state).toContain("- **Scope**: refactor");
    expect(state).toContain("- [S] functional-design — EXECUTE");
  });

  test("every Unit from here in the person's own words: the next stage's question is not handed them", () => {
    const proj = walk(["alpha", "beta"], false);
    says(proj, "skip functional design, we have the design already");
    const step = next(proj, ["--skip", "functional-design"]);
    const skipped = runNamed(proj, named(segment(String(step.message), EVERY_FROM))[0]);
    expect(skipped.status, skipped.out).toBe(0);
    const questions = join(dirname(stateFile(proj)), "construction", "alpha", "nfr-requirements", "nfr-requirements-questions.md");
    mkdirSync(dirname(questions), { recursive: true });
    writeFileSync(questions, "# NFR Requirements Questions\n\n## Question 1\nWhich latency target?\n\n[Answer]:\n");
    const asked = next(proj);
    expect(asked.stage, JSON.stringify(asked)).toBe("nfr-requirements");
    expect(JSON.stringify(asked.kept_replies ?? null)).not.toContain("we have the design already");
  });

  test("with no other Unit left to take it, one command skips it for that Unit", () => {
    const proj = walk(["alpha"], false);
    const step = next(proj, ["--skip", "functional-design"]);
    expect(named(step), String(step.message)).toEqual([FIRST_THIS_UNIT]);
    expect(step.message).toContain(
      '"Skipped Functional Design for the alpha Unit. It can still be run for that Unit with `/aidlc --stage functional-design --unit alpha`."',
    );
    const skipped = runNamed(proj, FIRST_THIS_UNIT);
    expect(skipped.status, skipped.out).toBe(0);
    const after = next(proj);
    expect(`${after.kind} ${after.stage}/${after.unit}`, JSON.stringify(after)).toBe("run-stage nfr-requirements/alpha");
  });

  // NFR Requirements is still ahead while Functional Design is Current Stage:
  // the plan change runs first, then the stage's own skip moves Current Stage.
  test("with the next step named too, for every Unit from here: both commands are admitted in the order named", () => {
    const proj = walk(["alpha", "beta"], false);
    const step = next(proj, ["--skip", "functional-design,nfr-requirements"]);
    const commands = named(segment(String(step.message), EVERY_FROM));
    expect(commands, String(step.message)).toEqual([
      `bun .claude/tools/aidlc.ts engine recompose --skip nfr-requirements --reason '${PERSON}'`,
      FIRST_EVERY_UNIT,
    ]);
    for (const command of commands) {
      const ran = runNamed(proj, command);
      expect(ran.status, ran.out).toBe(0);
      expect(ran.out).not.toContain('"kind":"error"');
    }
    const state = readFileSync(stateFile(proj), "utf-8");
    expect(state).toContain("- [S] functional-design \u2014 EXECUTE");
    expect(state).toContain("- [ ] nfr-requirements \u2014 SKIP");
    const after = next(proj);
    expect(`${after.kind} ${after.stage}/${after.unit}`, JSON.stringify(after)).toBe("run-stage nfr-design/alpha");
    // The first step's own skip moved the work past NFR Requirements in the same
    // request, so no undo window is offered for it, only the run on its own.
    expect(segment(String(step.message), EVERY_FROM).message).toContain(
      '"Skipped Functional Design and NFR Requirements for every Unit from here. Either one can still be run on its own with ' +
        '`/aidlc --stage functional-design --single` or `/aidlc --stage nfr-requirements --single`."',
    );
    const undo = /If they later ask to undo skipping it for every Unit, run `([^`]*)`/.exec(String(step.message))?.[1] ?? "";
    const late = runNamed(proj, undo);
    expect(late.status).not.toBe(0);
    expect(late.out).toContain("--stage nfr-requirements --single");
  });

  // With every stage after it named too, the first step's own skip finishes
  // the work in the same reply: no undo window is left, only the run on its own.
  test("with every stage after it named too, for every Unit from here: the line names the run on its own", () => {
    const proj = walk(["alpha", "beta"], false);
    const rows = readFileSync(stateFile(proj), "utf-8").split("\n")
      .map((line) => /^- \[ \] ([a-z0-9-]+) \u2014 EXECUTE$/.exec(line)?.[1])
      .filter((slug): slug is string => slug !== undefined);
    const step = next(proj, ["--skip", ["functional-design", ...rows].join(",")]);
    const every = segment(String(step.message), EVERY_FROM);
    expect(every.message, String(step.message)).toContain(
      "Any of them can still be run on its own with `/aidlc --stage functional-design --single`",
    );
    expect(every.message).not.toContain("You can undo");
    for (const command of named(every)) {
      const ran = runNamed(proj, command);
      expect(ran.status, ran.out).toBe(0);
    }
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- **Status**: Completed");
    const undo = /If they later ask to undo skipping it for every Unit, run `([^`]*)`/.exec(String(step.message))?.[1] ?? "";
    const late = runNamed(proj, undo);
    expect(late.status).not.toBe(0);
    expect(late.out).toContain("this work is finished");
  });

  // Words that name another Unit are neither this Unit nor every Unit: that
  // Unit's step is skipped for it while it works on it.
  test("words naming another Unit skip nothing now, and the line says when that Unit's step can be skipped", () => {
    for (const [designed, stage, name] of [[false, "functional-design", "Functional Design"], [1, "nfr-requirements", "NFR Requirements"]] as const) {
      const proj = walk(["alpha", "beta"], designed);
      const message = String(next(proj, ["--skip", stage]).message);
      const other = message.slice(message.indexOf("If they name another Unit"), message.indexOf(EVERY_FROM));
      expect(other, message).toContain(
        `run nothing and tell them in one line: "${name} can be skipped for one Unit while that Unit is working on it; the alpha Unit is on ${name} now." and stop.`,
      );
      expect(named({ message: other })).toEqual([]);
    }
  });

  // An earlier Unit's finished work for the stage keeps its approval: only the
  // Units from here on are skipped, each on its own record.
  test("every Unit from here after an earlier Unit did the stage: skipped for this Unit and the later ones only", () => {
    const proj = walk(["alpha", "beta", "gamma"]);
    const alphaCode = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "code-generation", "--unit", "alpha", "--result", "skipped", "--reason", PERSON,
    ]);
    expect(alphaCode.status, alphaCode.out).toBe(0);
    const onBeta = next(proj);
    expect(`${onBeta.kind} ${onBeta.stage}/${onBeta.unit}`, JSON.stringify(onBeta)).toBe("run-stage functional-design/beta");
    const step = next(proj, ["--skip", "functional-design"]);
    const every = segment(String(step.message), EVERY_FROM);
    const command = named(every);
    expect(command, String(step.message)).toEqual([FIRST_EVERY_UNIT]);
    expect(every.message).toContain(
      '"Skipped Functional Design for every Unit from here. It can still be run for the beta Unit with ' +
        '`/aidlc --stage functional-design --unit beta`, and for each Unit after it the same way."',
    );
    const skipped = runNamed(proj, command[0]);
    expect(skipped.status, skipped.out).toBe(0);
    expect(skipped.out).not.toContain('"kind":"error"');
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- [-] functional-design \u2014 EXECUTE");
    const audit = readAllAuditShards(proj);
    for (const unit of ["beta", "gamma"]) {
      expect(audit).toMatch(new RegExp(`\\*\\*Event\\*\\*: UNIT_SKIPPED\\n\\*\\*Stage\\*\\*: functional-design\\n\\*\\*Unit\\*\\*: ${unit}\\n`));
    }
    expect(audit).not.toMatch(/\*\*Event\*\*: UNIT_SKIPPED\n\*\*Stage\*\*: functional-design\n\*\*Unit\*\*: alpha\n/);
    expect(audit).not.toMatch(/\*\*Event\*\*: STAGE_SKIPPED\n\*\*Stage\*\*: functional-design\n/);
    const after = next(proj);
    expect(`${after.kind} ${after.stage}/${after.unit}`, JSON.stringify(after)).toBe("run-stage nfr-requirements/beta");
    // The way back the line names: that Unit's step reopened for it.
    const back = next(proj, ["--stage", "functional-design", "--unit", "beta"]);
    expect(back.kind, JSON.stringify(back)).toBe("print");
    expect(back.message).toContain("reopen --target functional-design");
    expect(back.message).toContain("--units beta");
  });

  test("the agent's own skip of the whole stage, naming no Unit, is still refused, naming the Unit's own skip", () => {
    const proj = walk(["alpha", "beta"], false);
    const before = readFileSync(stateFile(proj), "utf-8");
    const own = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "functional-design", "--result", "skipped", "--reason", "the design is already done",
    ]);
    expect(own.out).toContain('Cannot skip \\"functional-design\\" without naming its unit');
    expect(own.out).toContain("--unit alpha --result skipped");
    expect(readFileSync(stateFile(proj), "utf-8")).toBe(before);
  });
});
