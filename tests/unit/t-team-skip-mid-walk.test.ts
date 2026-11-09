// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-utility:recompose, audit:UNIT_SKIPPED
//
// A team's main checkout that works every Unit itself (no team has taken one)
// walks the Units one at a time, as a solo walk does. The plan-change step read
// only the solo walk, so a person's "skip code generation for alpha" there took
// Code Generation off the plan for every Unit, beta included, and "skip
// functional design for alpha" was sent to recompose, which refuses the current
// stage. The step now offers the solo walk's reading on that main too: that
// Unit only, or every Unit from here, as the person's words say. The way back
// the one-Unit line names, a jump that names the Unit, was refused there ("was
// approved for every unit at its stage approval"); it now reopens the step for
// that Unit alone, and another Unit's open step is set aside for it and picked
// up after, as on the solo walk. The solo walk's lines are pinned by
// t-skip-mid-walk, and a claimed clone's skip by t-team-unit-skip-handed-out-step.
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
import { artifactFilename, auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The stage's checks run once before its review or gate, and again at the gate
// (completionChecksStep, t-checks-before-review); this file's fixture documents
// are not written for them and its subject is not them, so they stay off here.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 3);

const SESSION = "01995000-7a11-7000-8000-00000000e3e4";
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

function run(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...env, CLAUDE_PROJECT_DIR: proj },
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// What the person types, through the human-turn hook every harness uses.
function says(proj: string, prompt: string): void {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(res.status, res.stderr).toBe(0);
}

function stateFile(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const record = readdirSync(intents).find((name) => existsSync(join(intents, name, "aidlc-state.md")));
  return join(intents, String(record), "aidlc-state.md");
}

type Step = { kind?: string; stage?: string; unit?: string; gate?: boolean; message?: string; receipt?: string };

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

// A feature piece of work on a team's main checkout that no team has taken a
// Unit from, so it walks every Unit itself, Current Stage on Functional Design
// as the walk leaves it. `units[0]`'s first `designed` design steps (all four
// with true, none with false) are started, written, reviewed READY and
// recorded complete through the tools, so it is on the next one, or on its
// Code Generation after all four. The person turned the summary confirmation
// off earlier. Team approvals come once at the end of each Unit unless
// `rhythm` says after every stage.
function walk(units: string[], designed: boolean | number = true, rhythm: "unit-end" | "per-stage" = "unit-end"): string {
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
    .replace(
      "- **State Version**: 8",
      `- **State Version**: 8\n- **Unit Ownership**: team\n- **Unit Gate Rhythm**: ${rhythm}\n- **Skeleton Stance**: on`,
    )
    .replace(/- \*\*Summary Confirmation\*\*: .*/, "- **Summary Confirmation**: off (set by you)"));
  writeFileSync(join(record, "runtime-graph.json"), `${JSON.stringify({
    bolt_dag: { units: units.map((name) => ({ name, depends_on: [] })), batches: [units] },
  }, null, 2)}\n`);
  const unit = units[0];
  const reviewer = "aidlc-architecture-reviewer-agent";
  for (const [stage, { produces, reviewed }] of steps) {
    // The team walk hands a step out until its files are written, so the Unit
    // starts it first, as the agent does.
    const started = run(proj, "aidlc-state.ts", ["unit", "start", "--stage", stage, "--unit", unit]);
    expect(started.status, started.out).toBe(0);
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
    const done = run(proj, "aidlc-state.ts", ["unit", "complete", "--stage", stage, "--unit", unit]);
    expect(done.status, done.out).toBe(0);
  }
  const at = next(proj);
  expect(at.unit, JSON.stringify(at)).toBe(unit);
  return proj;
}

// The engine commands the step names, undo commands left out.
function named(step: Step): string[] {
  return [...String(step.message).matchAll(/`([^`]*(?:engine recompose|aidlc-orchestrate\.ts report)[^`]*)`/g)]
    .map((match) => match[1])
    .filter((command) => !command.includes("--add"));
}

function runNamed(proj: string, command: string): { status: number; out: string } {
  const words = command.split(" ");
  const at = words.findIndex((word) => /^\.claude\/tools\/aidlc[a-z-]*\.ts$/.test(word));
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
  return run(proj, words[at].slice(".claude/tools/".length), args);
}

const segment = (message: string, from: string, to?: string): Step =>
  ({ message: message.slice(message.indexOf(from), to === undefined ? undefined : message.indexOf(to)) });

// Which Units the record says skipped the stage.
function unitSkips(proj: string, stage: string): string[] {
  return readAuditShardEvents(proj)
    .filter((row) => row.event === "UNIT_SKIPPED" && auditBlockField(row.block, "Stage") === stage)
    .map((row) => String(auditBlockField(row.block, "Unit")));
}

// The commands a step names for the agent to run, in order.
function commands(step: Step): string[] {
  return [...String(step.message).matchAll(/`(bun \.claude\/tools\/aidlc[a-z-]*\.ts [^`]*)`/g)].map((match) => match[1]);
}

const report = (stage: string, unit?: string): string =>
  `bun .claude/tools/aidlc-orchestrate.ts report --stage ${stage}${unit ? ` --unit ${unit}` : ""} --result skipped --reason '${PERSON}'`;
const recompose = (stage: string): string => `bun .claude/tools/aidlc.ts engine recompose --skip ${stage} --reason '${PERSON}'`;
// alpha's team approval, given as the person gives it. After a reopen the
// approval comes back through the step that records the revision first.
const approveAlpha = (proj: string, stage: string): void => {
  let gate = next(proj);
  const revised = /`(bun [^`]*--result revised)`/.exec(String(gate.message ?? ""))?.[1];
  if (revised !== undefined) {
    const shown = runNamed(proj, revised);
    expect(shown.status, shown.out).toBe(0);
    gate = next(proj);
  }
  expect(`${gate.stage}/${gate.unit} ${gate.gate}`, JSON.stringify(gate)).toBe(`${stage}/alpha true`);
  says(proj, "Approve");
  const approved = run(proj, "aidlc-orchestrate.ts", [
    "report", "--stage", stage, "--unit", "alpha", "--result", "approved", "--user-input", "Approve",
  ]);
  expect(approved.status, approved.out).toBe(0);
};

const ONLY = "If their words mean the alpha Unit only";
const EVERY_FROM = "If they name no Unit, they mean every Unit from here";

describe("a skip the person asks for on a team main that works every Unit itself", () => {
  test("Code Generation for the alpha Unit only: alpha skips it, beta still owes it, and the line names the way back", () => {
    const proj = walk(["alpha", "beta"]);
    says(proj, "skip code generation for alpha, I'll write that code myself");
    const step = next(proj, ["--skip", "code-generation"]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    const message = String(step.message);
    expect(named(segment(message, ONLY, EVERY_FROM)), message).toEqual([report("code-generation", "alpha")]);
    expect(named(segment(message, EVERY_FROM)), message).toEqual([recompose("code-generation")]);
    expect(message).toContain(
      '"Skipped Code Generation for the alpha Unit; the other Units still get it. It can still be run for that Unit with ' +
        '`/aidlc --stage code-generation --unit alpha`." and re-run `next`',
    );
    expect(message).toContain(
      'If they name another Unit, run nothing and tell them in one line: "Code Generation can be skipped for one Unit ' +
        'while that Unit is working on it; the alpha Unit is on Code Generation now." and stop.',
    );
    const skipped = runNamed(proj, report("code-generation", "alpha"));
    expect(skipped.status, skipped.out).toBe(0);
    expect(unitSkips(proj, "code-generation")).toEqual(["alpha"]);
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- [ ] code-generation \u2014 EXECUTE");
    // alpha is done: its team approval is next, not its Code Generation.
    const after = next(proj);
    expect(after.unit, JSON.stringify(after)).toBe("alpha");
    expect(after.kind === "run-stage" && after.stage === "code-generation" && after.gate !== true, JSON.stringify(after)).toBe(false);
  });

  // Team approvals once at the end of each Unit: a step the Unit skipped owes
  // that approval nothing, so it is asked, not a recovery question for the
  // skipped step's files.
  test("with approvals at the end of each Unit, alpha's skip leads to alpha's approval", () => {
    const proj = walk(["alpha", "beta"]);
    expect(runNamed(proj, report("code-generation", "alpha")).status).toBe(0);
    const gate = next(proj);
    expect(gate.kind === "ask" && JSON.stringify(gate).includes("guard-recovery"), JSON.stringify(gate)).toBe(false);
    expect(`${gate.stage}/${gate.unit} ${gate.gate}`, JSON.stringify(gate)).toBe("code-generation/alpha true");
    says(proj, "Approve");
    const approved = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "code-generation", "--unit", "alpha", "--result", "approved", "--user-input", "Approve",
    ]);
    expect(approved.status, approved.out).toBe(0);
    const beta = next(proj);
    expect(`${beta.kind} ${beta.stage}/${beta.unit}`, JSON.stringify(beta)).toBe("run-stage functional-design/beta");
  });

  // The agent may keep the person's why after the engine's reason. The skip is
  // still theirs, the why stays in the record, and the words they typed for it
  // are spent, not handed to a later step.
  test("the one-Unit skip with the person's why after the engine's reason is still theirs", () => {
    const proj = walk(["alpha", "beta"]);
    says(proj, "skip code generation for alpha, Team B writes it by hand");
    const kept = join(dirname(stateFile(proj)), ".aidlc-engine", "gate-words");
    expect(existsSync(kept)).toBe(true);
    const why = `${PERSON}: Team B writes it by hand`;
    const skipped = runNamed(proj, report("code-generation", "alpha").replace(`'${PERSON}'`, `'${why}'`));
    expect(skipped.status, skipped.out).toBe(0);
    expect(skipped.out).toContain('"kind":"done"');
    expect(unitSkips(proj, "code-generation")).toEqual(["alpha"]);
    const row = readAuditShardEvents(proj).find((entry) => entry.event === "UNIT_SKIPPED");
    expect(auditBlockField(String(row?.block), "Reason")).toBe(why);
    expect(existsSync(kept)).toBe(false);
    approveAlpha(proj, "code-generation");
    const questions = join(dirname(stateFile(proj)), "construction", "beta", "functional-design", "functional-design-questions.md");
    mkdirSync(dirname(questions), { recursive: true });
    writeFileSync(questions, "# Functional Design Questions\n\n## Question 1\nWhat does it greet?\n\n[Answer]:\n");
    const beta = next(proj) as Step & { kept_replies?: unknown };
    expect(beta.unit, JSON.stringify(beta)).toBe("beta");
    expect(JSON.stringify(beta.kept_replies ?? null)).not.toContain("Team B writes it by hand");
  });

  test("Code Generation for every Unit from here: the plan stops running it, with the walk's undo window", () => {
    const proj = walk(["alpha", "beta"]);
    const step = next(proj, ["--skip", "code-generation"]);
    const message = String(step.message);
    expect(message).toContain('"Skipped Code Generation for every Unit from here. You can undo that until Build and Test starts."');
    expect(message).toContain(
      "If they later ask to undo skipping it for every Unit, run `bun .claude/tools/aidlc.ts engine recompose --add code-generation`.",
    );
    const replanned = runNamed(proj, recompose("code-generation"));
    expect(replanned.status, replanned.out).toBe(0);
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- [ ] code-generation \u2014 SKIP");
    expect(unitSkips(proj, "code-generation")).toEqual([]);
  });

  test("Functional Design, the walk's first step, for the alpha Unit only: alpha goes on to NFR Requirements", () => {
    const proj = walk(["alpha", "beta"], false);
    says(proj, "skip functional design for alpha");
    const step = next(proj, ["--skip", "functional-design"]);
    const message = String(step.message);
    // Never the plan change recompose refuses for the current stage.
    expect(message).not.toContain("engine recompose --skip functional-design");
    expect(named(segment(message, ONLY, EVERY_FROM)), message).toEqual([report("functional-design", "alpha")]);
    expect(named(segment(message, EVERY_FROM)), message).toEqual([report("functional-design")]);
    expect(message).toContain(
      '"Skipped Functional Design for the alpha Unit; the other Units still get it. It can still be run for that Unit with ' +
        '`/aidlc --stage functional-design --unit alpha`."',
    );
    const skipped = runNamed(proj, report("functional-design", "alpha"));
    expect(skipped.status, skipped.out).toBe(0);
    expect(unitSkips(proj, "functional-design")).toEqual(["alpha"]);
    const after = next(proj);
    expect(`${after.kind} ${after.stage}/${after.unit}`, JSON.stringify(after)).toBe("run-stage nfr-requirements/alpha");
  });

  test("Functional Design for every Unit from here: every Unit that owes it skips it", () => {
    const proj = walk(["alpha", "beta"], false);
    const step = next(proj, ["--skip", "functional-design"]);
    const message = String(step.message);
    expect(message).toContain(
      '"Skipped Functional Design for every Unit from here. It can still be run on its own with `/aidlc --stage functional-design --single`."',
    );
    const skipped = runNamed(proj, report("functional-design"));
    expect(skipped.status, skipped.out).toBe(0);
    expect(unitSkips(proj, "functional-design").sort()).toEqual(["alpha", "beta"]);
    // The way back the line names runs on a team main.
    says(proj, "actually, run functional design on its own after all");
    const single = next(proj, ["--stage", "functional-design", "--single"]);
    expect(`${single.kind} ${single.stage}`, JSON.stringify(single)).toBe("run-stage functional-design");
  });

  test("with no other Unit to take it, one command skips it for that Unit", () => {
    const proj = walk(["alpha"]);
    const step = next(proj, ["--skip", "code-generation"]);
    const message = String(step.message);
    expect(named(step), message).toEqual([report("code-generation", "alpha")]);
    expect(message).toContain(
      'tell the person in one line: "Skipped Code Generation for the alpha Unit. It can still be run for that Unit with ' +
        '`/aidlc --stage code-generation --unit alpha`." Then re-run `next`',
    );
    const skipped = runNamed(proj, report("code-generation", "alpha"));
    expect(skipped.status, skipped.out).toBe(0);
    expect(unitSkips(proj, "code-generation")).toEqual(["alpha"]);
  });

  test("Code Generation named while alpha is on Functional Design: one Unit is answered, the plan change covers every Unit", () => {
    const proj = walk(["alpha", "beta"], false);
    const step = next(proj, ["--skip", "code-generation"]);
    const message = String(step.message);
    expect(named(step), message).toEqual([recompose("code-generation")]);
    expect(message).toContain("covers every Unit");
    expect(message).toContain(
      '"Code Generation can be skipped for one Unit while that Unit is working on it; the alpha Unit is on Functional Design now."',
    );
    expect(message).toContain('"Skipped Code Generation for every Unit from here. You can undo that until Build and Test starts."');
  });

  test("a Unit waiting at its team approval: a later step for that Unit only is answered with where it stands", () => {
    const proj = walk(["alpha", "beta"], 1, "per-stage");
    const step = next(proj, ["--skip", "nfr-requirements"]);
    const message = String(step.message);
    expect(named(step), message).toEqual([recompose("nfr-requirements")]);
    expect(message).toContain(
      '"NFR Requirements can be skipped for one Unit while that Unit is working on it; the alpha Unit is waiting for its Functional Design approval now."',
    );
  });
});

// The person's way back after a one-Unit skip: a jump that names the Unit.
describe("a jump that names one Unit on a team main that works every Unit itself", () => {
  const backTo = (proj: string, stage: string, unit: string): Step => {
    says(proj, `actually, do ${stage} for ${unit} after all`);
    return next(proj, ["--stage", stage, "--unit", unit]);
  };

  test("the skip's way back reopens Code Generation for alpha alone, and the walk hands it out again", () => {
    const proj = walk(["alpha", "beta"]);
    expect(runNamed(proj, report("code-generation", "alpha")).status).toBe(0);
    const back = backTo(proj, "code-generation", "alpha");
    expect(back.kind, JSON.stringify(back)).toBe("print");
    const message = String(back.message);
    expect(message).not.toContain("can only be reopened for every unit");
    expect(commands(back)[0], message).toBe(
      "bun .claude/tools/aidlc-jump.ts reopen --target code-generation --stages code-generation --units alpha --scope feature",
    );
    expect(message).toContain('tell the person in one line: "Reopened Code Generation for unit alpha."');
    // On a team main a jump for every Unit is not a reopen (it is the plain
    // jump), so the step never names it as the way to reopen every Unit.
    expect(message).not.toContain("--every-unit");
    expect(message).toContain("If they then name a unit, run `next --stage code-generation --unit <name>`.");
    const reopened = runNamed(proj, commands(back)[0]);
    expect(reopened.status, reopened.out).toBe(0);
    const at = next(proj);
    expect(`${at.kind} ${at.stage}/${at.unit} ${at.gate ?? false}`, JSON.stringify(at)).toBe("run-stage code-generation/alpha false");
  });

  test("beta's open step is set aside for alpha, alpha goes first, and the walk stops at beta to pick it up", () => {
    const proj = walk(["alpha", "beta"]);
    expect(runNamed(proj, report("code-generation", "alpha")).status).toBe(0);
    approveAlpha(proj, "code-generation");
    const beta = next(proj);
    expect(`${beta.kind} ${beta.stage}/${beta.unit}`, JSON.stringify(beta)).toBe("run-stage functional-design/beta");
    expect(run(proj, "aidlc-state.ts", ["unit", "start", "--stage", "functional-design", "--unit", "beta"]).status).toBe(0);
    const back = backTo(proj, "code-generation", "alpha");
    const message = String(back.message);
    const [pause, reopen] = commands(back);
    expect(pause, message).toStartWith("bun .claude/tools/aidlc-state.ts unit pause --stage functional-design --unit beta ");
    expect(pause).toEndWith("--set-aside-for alpha");
    expect(reopen).toBe(
      "bun .claude/tools/aidlc-jump.ts reopen --target code-generation --stages code-generation --units alpha --scope feature",
    );
    expect(message).toContain(
      '"Paused unit beta at Functional Design and reopened Code Generation for unit alpha. You can pick beta up again any time."',
    );
    for (const command of [pause, reopen]) {
      const ran = runNamed(proj, command);
      expect(ran.status, ran.out).toBe(0);
    }
    // beta's pause, set aside for alpha, does not stop the walk while alpha has work.
    const alpha = next(proj);
    expect(`${alpha.kind} ${alpha.stage}/${alpha.unit} ${alpha.gate ?? false}`, JSON.stringify(alpha)).toBe(
      "run-stage code-generation/alpha false",
    );
    // alpha done again (the person skips it once more) and approved: the walk stops at beta to pick it up.
    expect(runNamed(proj, report("code-generation", "alpha")).status).toBe(0);
    approveAlpha(proj, "code-generation");
    const pickUp = next(proj);
    expect(pickUp.unit ?? "", JSON.stringify(pickUp)).toBe("beta");
    expect(pickUp.kind === "run-stage", JSON.stringify(pickUp)).toBe(false);
    expect(run(proj, "aidlc-state.ts", ["unit", "resume", "--stage", "functional-design", "--unit", "beta"]).status).toBe(0);
    const resumed = next(proj);
    expect(`${resumed.kind} ${resumed.stage}/${resumed.unit}`, JSON.stringify(resumed)).toBe("run-stage functional-design/beta");
  });

  test("past the Unit steps, at Build and Test, the named Unit's step is reopened and the work moves back", () => {
    const proj = walk(["alpha"]);
    expect(runNamed(proj, report("code-generation", "alpha")).status).toBe(0);
    approveAlpha(proj, "code-generation");
    const after = next(proj);
    expect(after.stage, JSON.stringify(after)).toBe("build-and-test");
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- **Current Stage**: build-and-test");
    const back = backTo(proj, "code-generation", "alpha");
    const reopen = commands(back).find((command) => command.includes("aidlc-jump.ts reopen"));
    expect(reopen, String(back.message)).toContain("--target code-generation --stages code-generation --units alpha");
    const ran = runNamed(proj, String(reopen));
    expect(ran.status, ran.out).toBe(0);
    const at = next(proj);
    expect(`${at.kind} ${at.stage}/${at.unit} ${at.gate ?? false}`, JSON.stringify(at)).toBe("run-stage code-generation/alpha false");
  });

  test("a Unit that has not reached the step: nothing to reopen, said plainly", () => {
    const proj = walk(["alpha", "beta"]);
    const back = backTo(proj, "nfr-design", "beta");
    expect(String(back.message), JSON.stringify(back)).toContain(
      '"unit beta has not reached NFR Design yet, so there is nothing to reopen."',
    );
  });

  test("a Unit that is not one of this work's: the work's Units are named", () => {
    const proj = walk(["alpha", "beta"]);
    const back = backTo(proj, "nfr-design", "gamma");
    expect(`${back.kind} ${back.message}`, JSON.stringify(back)).toContain("gamma is not one of this work's units (alpha, beta).");
  });

  test("with approvals after every stage, a Unit at its approval of the step it names reopens it, not the approval again", () => {
    const proj = walk(["alpha", "beta"], 1, "per-stage");
    const back = backTo(proj, "functional-design", "alpha");
    expect(commands(back)[0], String(back.message)).toBe(
      "bun .claude/tools/aidlc-jump.ts reopen --target functional-design " +
        "--stages functional-design,nfr-requirements,nfr-design,infrastructure-design,code-generation --units alpha --scope feature",
    );
    expect(String(back.message)).toContain('"Reopened Functional Design for unit alpha."');
    expect(runNamed(proj, commands(back)[0]).status).toBe(0);
    const at = next(proj);
    expect(`${at.kind} ${at.stage}/${at.unit} ${at.gate ?? false}`, JSON.stringify(at)).toBe("run-stage functional-design/alpha false");
  });

  // A jump that names no Unit, or asks for every Unit, is not read on the team walk.
  test("a jump naming no Unit, or every Unit, goes as it does without a Unit named", () => {
    for (const args of [["--stage", "nfr-design"], ["--stage", "nfr-design", "--every-unit"]]) {
      const proj = walk(["alpha", "beta"]);
      const step = next(proj, args);
      expect(String(step.message), JSON.stringify(step)).not.toContain("aidlc-jump.ts reopen");
      expect(commands(step)[0], JSON.stringify(step)).toBe(
        "bun .claude/tools/aidlc-jump.ts execute --target nfr-design --direction forward --scope feature",
      );
    }
  });

  test("the re-entry report's jump for a Unit that is not one of this work's asks which one", () => {
    const proj = walk(["alpha", "beta"]);
    const res = run(proj, "aidlc-orchestrate.ts", [
      "report", "--result", "resumed", "--choice", "jump", "--target", "nfr-design", "--unit", "gamma",
    ]);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("gamma is not one of this work's units (alpha, beta). Which one did you mean?");
  });
});
