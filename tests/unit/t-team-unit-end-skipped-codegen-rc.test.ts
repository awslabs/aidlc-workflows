// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, audit:GATE_REJECTED
//
// A team Unit approved once at the end of the Unit skips Code Generation, the
// step that one approval sits on. At that approval the person asks for changes:
// the walk takes the Unit back through its work, and the step they skipped
// stays skipped, as a skipped Infrastructure Design does.
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

// One design step for the Unit, written, reviewed READY and recorded complete
// through the tools, as walk() does.
function workStep(proj: string, unit: string, stage: string): void {
  const { produces, reviewed } = DESIGN[stage];
  const reviewer = "aidlc-architecture-reviewer-agent";
  const started = run(proj, "aidlc-state.ts", ["unit", "start", "--stage", stage, "--unit", unit]);
  expect(started.status, started.out).toBe(0);
  const dir = join(dirname(stateFile(proj)), "construction", unit, stage);
  mkdirSync(dir, { recursive: true });
  for (const name of produces) writeFileSync(join(dir, artifactFilename(name)), `# ${name} for ${unit}, revised\n`);
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

const skip = (stage: string): string =>
  `bun .claude/tools/aidlc-orchestrate.ts report --stage ${stage} --unit alpha --result skipped --reason '${PERSON}'`;

describe("Request Changes at a unit-end approval keeps the step the Unit skipped skipped", () => {
  test("alpha skipped Code Generation: after Request Changes the walk comes back to alpha's approval, never to its Code Generation", () => {
    const proj = walk(["alpha"]);
    expect(runNamed(proj, skip("code-generation")).status).toBe(0);
    const gate = next(proj);
    expect(`${gate.stage}/${gate.unit} ${gate.gate}`, JSON.stringify(gate)).toBe("code-generation/alpha true");
    const shown = run(proj, "aidlc-orchestrate.ts", ["report", "--stage", "code-generation", "--unit", "alpha", "--result", "awaiting-approval"]);
    expect(shown.status, shown.out).toBe(0);
    says(proj, "Request Changes: the functional spec should name the greeting it returns");
    const rejected = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "code-generation", "--unit", "alpha", "--result", "rejected",
      "--user-input", "Request Changes", "--reason", "the functional spec should name the greeting it returns",
    ]);
    expect(rejected.status, rejected.out).toBe(0);
    const rejection = readAuditShardEvents(proj).filter((row) => row.event === "GATE_REJECTED").at(-1);
    const gateStages = String(auditBlockField(String(rejection?.block), "Gate Stages"));

    const handed: string[] = [];
    for (let i = 0; i < 10; i++) {
      const step = next(proj);
      const revised = /`(bun [^`]*--result revised)`/.exec(String(step.message ?? ""))?.[1];
      if (revised !== undefined) {
        handed.push(`revised:${step.stage}`);
        const ran = runNamed(proj, revised);
        expect(ran.status, ran.out).toBe(0);
        continue;
      }
      handed.push(`${step.kind} ${step.stage}/${step.unit}${step.gate ? " gate" : ""}`);
      if (step.gate || step.kind !== "run-stage" || step.stage === "code-generation" || !DESIGN[String(step.stage)]) break;
      workStep(proj, "alpha", String(step.stage));
    }
    const why = `Gate Stages ${gateStages}; walk: ${handed.join(" | ")}`;
    expect(handed, why).not.toContain("run-stage code-generation/alpha");
    expect(handed.at(-1), why).toBe("run-stage code-generation/alpha gate");
  });
});
