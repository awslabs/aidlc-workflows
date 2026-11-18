// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next, subcommand:aidlc-jump:reopen, audit:ARTIFACT_REUSED
//
// A team's main checkout that works every Unit itself (no team has taken one)
// walks the Units one at a time, as a solo walk does. On re-entry the person's
// Redo for the Unit the walk is on, at its step, goes as on the solo walk,
// whether they name that Unit, the step, or neither: a jump that names the
// Unit reopens the step but records no Redo, so the stage would ask Keep,
// Modify or Redo again, and the stage's own redo starts every Unit's finished
// steps over. The reopen carries the Redo (`--via redo`), and the step comes
// back to be redone from the start with the question answered. The solo walk's
// lines are pinned by t342-construction-checkpoint-routing.
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

// The stage's checks are not this file's subject and its fixture documents are
// not written for them.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 3);

const SESSION = "01995000-7a11-7000-8000-00000000e3e5";

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

type Step = {
  kind?: string;
  stage?: string;
  unit?: string;
  gate?: boolean;
  message?: string;
  receipt?: string;
  artifact_reuse?: { decision: string; unit: string };
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

// One design step of the Unit's, as the agent does it: started, its files
// written, reviewed READY and recorded complete through the tools.
function design(proj: string, unit: string, stage: string): void {
  const record = dirname(stateFile(proj));
  const { produces, reviewed } = DESIGN[stage];
  const reviewer = "aidlc-architecture-reviewer-agent";
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

// A feature piece of work on a team's main checkout that no team has taken a
// Unit from, so it walks every Unit itself, Current Stage on Functional Design
// as the walk leaves it. alpha has done its first `designed` design steps.
// Team approvals come once at the end of each Unit unless `rhythm` says after
// every stage.
function walk(designed: number, rhythm: "unit-end" | "per-stage" = "unit-end"): string {
  const units = ["alpha", "beta"];
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  const created = run(proj, "aidlc-utility.ts", ["intent-create", "--scope", "feature"]);
  expect(created.status, created.out).toBe(0);
  const path = stateFile(proj);
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
  writeFileSync(join(dirname(path), "runtime-graph.json"), `${JSON.stringify({
    bolt_dag: { units: units.map((name) => ({ name, depends_on: [] })), batches: [units] },
  }, null, 2)}\n`);
  for (const stage of Object.keys(DESIGN).slice(0, designed)) design(proj, "alpha", stage);
  return proj;
}

// The person's Redo on re-entry, as the agent reports it.
function redo(proj: string, words: string, named: string[]): string {
  says(proj, words);
  const res = run(proj, "aidlc-orchestrate.ts", ["report", "--result", "resumed", "--choice", "redo", ...named]);
  expect(res.status, res.out).toBe(0);
  const step = JSON.parse(res.out.split("\n").find((line) => line.trim().startsWith("{")) ?? "{}") as Step;
  expect(step.kind, res.out).toBe("print");
  return String(step.message);
}

// The engine commands a print names for the agent to run, in order. The park
// it names is only for a person who also asked to stop there.
function commands(message: string): string[] {
  return [...message.matchAll(/`bun \.claude\/tools\/(aidlc[a-z-]*\.ts) ([^`]*)`/g)]
    .map((match) => `${match[1]} ${match[2]}`)
    .filter((command) => command !== "aidlc-orchestrate.ts park --person-asked");
}

// The print carried out as the agent carries it out: the commands it names,
// and the `next --stage` move it names, followed in turn.
function follow(proj: string, message: string): void {
  for (const command of commands(message)) {
    const [tool, ...args] = command.split(" ");
    const ran = run(proj, tool, args);
    expect(ran.status, `${command}\n${ran.out}`).toBe(0);
  }
  const move = /Run `next (--stage [^`]+)`/.exec(message)?.[1];
  if (move !== undefined) follow(proj, String(next(proj, move.split(" ")).message));
}

// The Redo answers the person gave on re-entry, as the record keeps them.
function redoAnswers(proj: string): string[] {
  return readAuditShardEvents(proj)
    .filter((row) => row.event === "ARTIFACT_REUSED" && auditBlockField(row.block, "Decision") === "redo")
    .map((row) => `${auditBlockField(row.block, "Stage")}/${auditBlockField(row.block, "Unit")} ${auditBlockField(row.block, "Source")}`);
}

describe("a Redo on re-entry for the Unit a team main is walking", () => {
  // alpha is part way through NFR Design: started, one file written.
  const midStep = (): string => {
    const proj = walk(2);
    const at = next(proj);
    expect(`${at.kind} ${at.stage}/${at.unit}`, JSON.stringify(at)).toBe("run-stage nfr-design/alpha");
    const started = run(proj, "aidlc-state.ts", ["unit", "start", "--stage", "nfr-design", "--unit", "alpha"]);
    expect(started.status, started.out).toBe(0);
    const dir = join(dirname(stateFile(proj)), "construction", "alpha", "nfr-design");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, artifactFilename("performance-design")), "# performance-design for alpha, a first try\n");
    return proj;
  };

  for (const [words, named] of [
    ["redo", []],
    ["redo NFR Design", ["--target", "nfr-design"]],
    ["redo alpha's NFR Design from scratch", ["--unit", "alpha"]],
    ["redo alpha's NFR Design from scratch", ["--target", "nfr-design", "--unit", "alpha"]],
  ] as Array<[string, string[]]>) {
    test(`at the step alpha is on (${named.join(" ") || "nothing named"}): redone from the start, the Redo recorded once, not asked again`, () => {
      const proj = midStep();
      const message = redo(proj, words, named);
      follow(proj, message);
      // The step comes back with the person's Redo as its answer: the stage
      // redoes it from the start without asking Keep, Modify or Redo.
      const back = next(proj);
      expect(`${back.kind} ${back.stage}/${back.unit} ${back.gate ?? false}`, JSON.stringify(back)).toBe("run-stage nfr-design/alpha false");
      expect(back.artifact_reuse, `${message}\n${JSON.stringify(back)}`).toEqual({ decision: "redo", unit: "alpha" });
      expect(redoAnswers(proj)).toEqual(["nfr-design/alpha Redo on re-entry"]);
      expect(commands(message), message).toEqual([
        "aidlc-jump.ts reopen --target nfr-design --stages nfr-design,infrastructure-design,code-generation --units alpha --via redo --scope feature",
      ]);
      expect(message).toContain('tell the person in one line: "Redoing NFR Design for unit alpha from the start."');
      // alpha's finished steps are kept, and beta has nothing redone.
      expect(readAuditShardEvents(proj).filter((row) => row.event === "STAGE_JUMPED")).toEqual([]);
      // The answer is spent once alpha starts the step again.
      const started = run(proj, "aidlc-state.ts", ["unit", "start", "--stage", "nfr-design", "--unit", "alpha"]);
      expect(started.status, started.out).toBe(0);
      expect(next(proj).artifact_reuse).toBeUndefined();
    });
  }

  for (const [words, named] of [["redo", []], ["redo functional design for alpha", ["--unit", "alpha"]]] as Array<[string, string[]]>) {
    test(`with approvals after every stage, alpha waiting at its Functional Design approval (${named.join(" ") || "nothing named"}): that step is redone`, () => {
      const proj = walk(1, "per-stage");
      const gate = next(proj);
      expect(`${gate.stage}/${gate.unit} ${gate.gate}`, JSON.stringify(gate)).toBe("functional-design/alpha true");
      const message = redo(proj, words, named);
      follow(proj, message);
      const back = next(proj);
      expect(`${back.kind} ${back.stage}/${back.unit} ${back.gate ?? false}`, JSON.stringify(back)).toBe("run-stage functional-design/alpha false");
      expect(back.artifact_reuse, `${message}\n${JSON.stringify(back)}`).toEqual({ decision: "redo", unit: "alpha" });
      expect(redoAnswers(proj)).toEqual(["functional-design/alpha Redo on re-entry"]);
      expect(commands(message), message).toEqual([
        "aidlc-jump.ts reopen --target functional-design " +
          "--stages functional-design,nfr-requirements,nfr-design,infrastructure-design,code-generation --units alpha --via redo --scope feature",
      ]);
      expect(readAuditShardEvents(proj).filter((row) => row.event === "STAGE_JUMPED")).toEqual([]);
    });
  }

  test("with approvals after every stage, alpha waiting at its NFR Requirements approval: the step named is redone", () => {
    const proj = walk(1, "per-stage");
    expect(next(proj).gate).toBe(true);
    says(proj, "Approve");
    const approved = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "functional-design", "--unit", "alpha", "--result", "approved", "--user-input", "Approve",
    ]);
    expect(approved.status, approved.out).toBe(0);
    expect(next(proj).stage).toBe("nfr-requirements");
    design(proj, "alpha", "nfr-requirements");
    const gate = next(proj);
    expect(`${gate.stage}/${gate.unit} ${gate.gate}`, JSON.stringify(gate)).toBe("nfr-requirements/alpha true");
    const message = redo(proj, "redo alpha's NFR Requirements", ["--target", "nfr-requirements", "--unit", "alpha"]);
    follow(proj, message);
    const back = next(proj);
    expect(`${back.kind} ${back.stage}/${back.unit} ${back.gate ?? false}`, JSON.stringify(back)).toBe("run-stage nfr-requirements/alpha false");
    expect(back.artifact_reuse, `${message}\n${JSON.stringify(back)}`).toEqual({ decision: "redo", unit: "alpha" });
    expect(redoAnswers(proj)).toEqual(["nfr-requirements/alpha Redo on re-entry"]);
    expect(commands(message), message).toEqual([
      "aidlc-jump.ts reopen --target nfr-requirements " +
        "--stages nfr-requirements,nfr-design,infrastructure-design,code-generation --units alpha --via redo --scope feature",
    ]);
  });

  // A Redo for a Unit the walk is not on is the jump that names it, as on the
  // solo walk; t-team-skip-mid-walk pins where that jump goes.
  test("a Redo naming beta, while alpha is on its step, is the jump that names beta", () => {
    const proj = midStep();
    const message = redo(proj, "redo beta", ["--unit", "beta"]);
    expect(message).toContain("Run `next --stage nfr-design --unit beta`");
    expect(redoAnswers(proj)).toEqual([]);
  });
});
