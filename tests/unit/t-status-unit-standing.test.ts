// covers: function:unitWalkStanding, function:unitWalkStops, function:unitProgress, function:parseBoltDag, subcommand:aidlc-utility:status, hook:aidlc-statusline
//
// Status over work built one Unit at a time (#3628). The dependency file Units
// Generation writes has no heading over its edge block, and the status view and
// the status line read Units from it with a pattern that needed one, so with
// the first Unit done both said "CONSTRUCTION 0/6", and Next Stage named the
// stage after the block's first one whatever Unit the work was on. Status now
// says where each Unit stands, from the walk that hands out the next step, and
// names the next stage of the Unit in progress; the status line counts the Unit
// its step names. Work built stage by stage reads as before.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject, parseBoltDag as libParseBoltDag,
  reviewArtifactFingerprint, validateUnitName as libValidateUnitName,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { parseBoltDag, validateUnitName } from "../../dist/claude/.claude/tools/aidlc-unit-dag.ts";
import { validateUnitName as recordsValidateUnitName } from "../../dist/claude/.claude/tools/aidlc-review-records.ts";
import { unitProgress } from "../../dist/claude/.claude/tools/aidlc-unit-walk-view.ts";

// The stage checks are not this file's subject and its documents are not
// written for them.
process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const ORCH = join(AIDLC_SRC, "tools/aidlc-orchestrate.ts");
const SIX = ["u1", "u2", "u3", "u4", "u5", "u6"];
const THREE = ["u1", "u2", "u3"];

type DagFile = "stage" | "heading" | "crlf" | "malformed" | "none";
type Options = {
  dag?: DagFile;
  stance?: "on" | "off";
  checkpoints?: "enabled" | "disabled";
  iteration?: "unit-major" | "stage-major";
  current?: string;
  version?: string;
};

// The dependency file in the shape the Units Generation stage asks for: a
// fenced yaml block that starts with `units:`, under whatever heading.
function dependencyFile(units: string[], dag: DagFile): string {
  const entries = units.map((u) => `  - name: ${u}\n    depends_on: []\n`).join("");
  const block = `\`\`\`yaml\nunits:\n${entries}\`\`\`\n`;
  if (dag === "heading") return `# Unit Dependency DAG\n\n## Machine-Readable Edge Block\n\n${block}`;
  if (dag === "malformed") return "# Unit of Work Dependencies\n\n```yaml\nunits:\n  - name: u1\n    depends_on: [nobody]\n```\n";
  const text = `# Unit of Work Dependencies\n\n## Dependency DAG\n\nEvery Unit stands alone.\n\n${block}`;
  return dag === "crlf" ? text.replaceAll("\n", "\r\n") : text;
}

function fixture(units: string[], options: Options = {}) {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  const current = options.current ?? "functional-design";
  // The state's checkbox lines separate the slug and its action with U+2014.
  const sep = "\u2014";
  const at = STAGES.indexOf(current);
  const box = (slug: string) => slug === current ? "-" : at === -1 || STAGES.indexOf(slug) < at ? "x" : " ";
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Status Unit standing
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: ${options.version ?? "8"}
- **Unit Ownership**: solo
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: ${options.stance ?? "off"}
- **Construction Iteration**: ${options.iteration ?? "unit-major"}
- **Construction Checkpoints**: ${options.checkpoints ?? "enabled"}
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Review Override**: none
- **Change Control**: strict
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${STAGES.map((stage) => `- [${box(stage)}] ${stage} ${sep} EXECUTE`).join("\n")}
- [${current === "build-and-test" ? "-" : " "}] build-and-test ${sep} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
- **Last Completed Stage**: ${at === -1 ? "code-generation" : "delivery-planning"}
${at === -1 ? "" : "- **Next Stage**: nfr-requirements\n"}`);
  seedBoltDag(p, units);
  const dag = options.dag ?? "stage";
  if (dag !== "none") {
    const dir = join(seededRecordDir(p), "inception", "units-generation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "unit-of-work-dependency.md"), dependencyFile(units, dag));
  }
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of units) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  return p;
}

// The Unit's steps written and receipted, as `unit complete` leaves them.
function cover(p: string, unit: string, selected = STAGES) {
  for (const slug of selected) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({ stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }] }));
    }
    const fingerprint = reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true });
    expect(fingerprint).not.toBeNull();
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: unit, Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
      "Artifact Fingerprint": fingerprint!,
    }, p);
  }
}

// Every step the Unit owes skipped, with the person's reason.
function skipUnit(p: string, unit: string) {
  for (const slug of STAGES) {
    appendAuditEntry("UNIT_SKIPPED", {
      Stage: slug, Unit: unit, Reason: "The person asked to leave this Unit out.",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
    }, p);
  }
}

function tool(p: string, name: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env,
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout;
}

function human(p: string, prompt: string, session: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

// The command each Unit's checkpoint runs, agreed with the person once.
function recordCommand(p: string, units: string[]) {
  if (readFileSync(seededStateFile(p), "utf-8").includes("- **Construction Verification Command**:")) return;
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, `const fs=require('node:fs'); for(const unit of ${JSON.stringify(units)}) if(!fs.existsSync('src/'+unit+'.ts'))process.exit(1);`);
  const quote = (value: string) => process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "standing-command"];
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], env);
  human(p, "Approve", "standing-command");
  tool(p, "log", ["answer", ...identity, "--details", "Approve"], env);
  tool(p, "state", ["set-construction-verification-command", command], env);
}

// The person approves the Unit at its checkpoint.
function approve(p: string, unit: string, units: string[], kind: "unit" | "skeleton" = "unit") {
  recordCommand(p, units);
  const bolt = (args: string[]) => JSON.parse(tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", kind, ...args]));
  expect(bolt(["--action", "verify"]).verified).toBe(true);
  bolt(["--action", "ask", "--session", "standing-checkpoint"]);
  human(p, "Approve", "standing-checkpoint");
  expect(bolt(["--action", "approve", "--session", "standing-checkpoint", "--user-input", "Approve"]).approved).toBe(true);
}

type Directive = { kind: string; stage?: string; unit?: string; construction_checkpoint?: { unit: string } };

function next(p: string): Directive {
  const result = runOrchestrateNext(ORCH, p, []);
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as Directive;
}

function startStep(p: string, unit: string, stage: string) {
  tool(p, "state", ["unit", "start", "--stage", stage, "--unit", unit]);
}

function status(p: string, args: string[] = []): string {
  return tool(p, "utility", ["status", ...args]);
}

function line(out: string, label: string): string {
  return out.split("\n").find((row) => row.trimStart().startsWith(label)) ?? "";
}

function statusline(p: string): string {
  const result = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [process.execPath, join(AIDLC_SRC, "hooks", "aidlc-statusline.ts")],
    stdin: new TextEncoder().encode(JSON.stringify({ workspace: { project_dir: p } })),
    stdout: "pipe",
    stderr: "pipe",
  });
  return `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
}

// Every file under the project, by content: status reads and writes nothing.
function snapshot(p: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(p, path), createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
  };
  walk(p);
  return files;
}

describe("t-status-unit-standing: status says where each Unit stands", () => {
  test("six Units, the dependency file as Units Generation writes it, u1 done: no 0/6, each Unit named, Next Stage the walk's", () => {
    const p = fixture(SIX);
    cover(p, "u1");
    approve(p, "u1", SIX);
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "u2" });
    const out = status(p);
    const row = line(out, "CONSTRUCTION");
    expect(row).not.toMatch(/\b0\/6\b/);
    expect(row).toEndWith("Unit 2 of 6: u1 done, u2, u3, u4, u5 and u6 not started");
    expect(line(out, "Next Stage:")).toBe("Next Stage:     Functional Design for u2");
    expect(line(out, "Last Completed:")).toBe("Last Completed: Delivery Planning");
    expect(statusline(p)).toContain("CONSTRUCTION Unit 2 of 6");
  });

  test("once u2 starts its first step it is at it, and Next Stage is its next one", () => {
    const p = fixture(SIX);
    cover(p, "u1");
    approve(p, "u1", SIX);
    next(p);
    startStep(p, "u2", "functional-design");
    const out = status(p);
    expect(line(out, "CONSTRUCTION")).toEndWith("Unit 2 of 6: u1 done, u2 at Functional Design, u3, u4, u5 and u6 not started");
    expect(line(out, "Next Stage:")).toBe("Next Stage:     NFR Requirements for u2");
  });

  test("one Unit at Code Generation: Next Stage is the step, then once it starts, the Unit's checkpoint", () => {
    const p = fixture(["u1"]);
    cover(p, "u1", STAGES.slice(0, 4));
    expect(next(p)).toMatchObject({ stage: "code-generation", unit: "u1" });
    const before = status(p);
    expect(line(before, "CONSTRUCTION")).toEndWith("Unit 1 of 1: u1 at Code Generation");
    expect(line(before, "Next Stage:")).toBe("Next Stage:     Code Generation for u1");
    startStep(p, "u1", "code-generation");
    expect(line(status(p), "Next Stage:")).toBe("Next Stage:     the Unit checkpoint for u1");
  });

  test("two Units, alpha done and beta at its checkpoint: Next Stage is the stage after the block", () => {
    const p = fixture(["alpha", "beta"]);
    cover(p, "alpha");
    approve(p, "alpha", ["alpha", "beta"]);
    cover(p, "beta");
    expect(next(p).construction_checkpoint?.unit).toBe("beta");
    const out = status(p);
    expect(line(out, "CONSTRUCTION")).toEndWith("Unit 2 of 2: alpha done, beta at the Unit checkpoint");
    expect(line(out, "Next Stage:")).toBe("Next Stage:     Build and Test");
  });

  test("a Unit skipped for every step reads skipped, and the walk's Unit is counted", () => {
    const p = fixture(THREE);
    cover(p, "u1");
    approve(p, "u1", THREE);
    skipUnit(p, "u2");
    expect(next(p)).toMatchObject({ stage: "functional-design", unit: "u3" });
    const out = status(p);
    expect(line(out, "CONSTRUCTION")).toEndWith("Unit 3 of 3: u1 done, u2 skipped, u3 not started");
    expect(line(out, "Next Stage:")).toBe("Next Stage:     Functional Design for u3");
  });

  test("a Unit a jump reopened is at its step again", () => {
    const p = fixture(THREE);
    cover(p, "u1");
    approve(p, "u1", THREE);
    next(p);
    tool(p, "jump", ["reopen", "--target", "code-generation", "--units", "u1"]);
    expect(line(status(p), "CONSTRUCTION")).toEndWith("Unit 1 of 3: u1 at Code Generation, u2 and u3 not started");
  });

  test("with the walking skeleton on, the skeleton's approval counts", () => {
    const p = fixture(THREE, { stance: "on" });
    cover(p, "u1");
    approve(p, "u1", THREE, "skeleton");
    expect(next(p)).toMatchObject({ stage: "functional-design", unit: "u2" });
    expect(line(status(p), "CONSTRUCTION")).toEndWith("Unit 2 of 3: u1 done, u2 and u3 not started");
    expect(statusline(p)).toContain("CONSTRUCTION Unit 2 of 3 > Functional Design for u2");
  });

  test("with Construction checkpoints off, a Unit whose steps are done counts", () => {
    const p = fixture(THREE, { checkpoints: "disabled" });
    cover(p, "u1");
    expect(next(p)).toMatchObject({ stage: "functional-design", unit: "u2" });
    expect(line(status(p), "CONSTRUCTION")).toEndWith("Unit 2 of 3: u1 done, u2 and u3 not started");
    expect(statusline(p)).toContain("CONSTRUCTION Unit 2 of 3 > Functional Design for u2");
  });

  test("the status line names and counts the Unit its Unit Stage field names, with no step on record", () => {
    const p = fixture(THREE);
    writeFileSync(seededStateFile(p), readFileSync(seededStateFile(p), "utf-8")
      .replace("- **Status**: Running\n", "- **Status**: Running\n- **Active Unit**: u2\n- **Unit Stage**: nfr-requirements\n"));
    expect(statusline(p)).toContain("CONSTRUCTION Unit 2 of 3 > NFR Requirements for u2");
  });

  test("the dependency file with CRLF line ends, or with the old heading, reads its Units", () => {
    for (const dag of ["crlf", "heading"] as const) {
      const p = fixture(SIX, { dag });
      cover(p, "u1");
      approve(p, "u1", SIX);
      next(p);
      expect(line(status(p), "CONSTRUCTION"), dag).toEndWith("Unit 2 of 6: u1 done, u2, u3, u4, u5 and u6 not started");
      expect(unitProgress(seededRecordDir(p), "unit-major"), dag).toEqual({ current: 2, total: 6 });
    }
  });

  test("a dependency file the engine cannot read gives no Unit count, as the engine reads no Units", () => {
    const p = fixture(SIX, { dag: "malformed" });
    expect(unitProgress(seededRecordDir(p), "unit-major")).toBeNull();
    const row = line(status(p), "CONSTRUCTION");
    expect(row).toMatch(/ 0\/6$/);
    expect(row).not.toContain("Unit");
  });

  test("with no dependency file, the compiled graph gives the Units, as before", () => {
    const p = fixture(SIX, { dag: "none" });
    cover(p, "u1");
    approve(p, "u1", SIX);
    next(p);
    expect(unitProgress(seededRecordDir(p), "unit-major")).toEqual({ current: 2, total: 6 });
    expect(line(status(p), "CONSTRUCTION")).toEndWith("Unit 2 of 6: u1 done, u2, u3, u4, u5 and u6 not started");
  });

  test("work built stage by stage reads as before: the stage count and the Next Stage field", () => {
    const p = fixture(SIX, { iteration: "stage-major" });
    const out = status(p);
    expect(line(out, "CONSTRUCTION")).toMatch(/ 0\/6$/);
    expect(out).not.toContain("not started");
    expect(line(out, "Next Stage:")).toBe("Next Stage:     NFR Requirements");
  });

  test("past the block, at Build and Test, status reads as before", () => {
    const p = fixture(THREE, { current: "build-and-test" });
    for (const unit of THREE) cover(p, unit);
    const out = status(p);
    expect(line(out, "CONSTRUCTION")).toMatch(/ 5\/6$/);
    expect(out).not.toContain("not started");
    expect(out).not.toContain("Next Stage:");
  });

  test("status for a record named with --intent keeps the light count", () => {
    const p = fixture(SIX);
    cover(p, "u1");
    approve(p, "u1", SIX);
    next(p);
    expect(line(status(p, ["--intent", basename(seededRecordDir(p))]), "CONSTRUCTION")).toEndWith("Unit 2 of 6");
  });

  test("status writes nothing", () => {
    const p = fixture(SIX);
    cover(p, "u1");
    approve(p, "u1", SIX);
    next(p);
    startStep(p, "u2", "functional-design");
    const before = snapshot(p);
    status(p);
    expect(snapshot(p)).toEqual(before);
  });

  // A record an older AI-DLC wrote waits for the next step to bring it up;
  // reading the walk would bring it up in place, so status reads as before.
  test("status on a record an older AI-DLC wrote writes nothing and keeps the light count", () => {
    const p = fixture(SIX, { version: "7" });
    cover(p, "u1");
    approve(p, "u1", SIX);
    const before = snapshot(p);
    const row = line(status(p), "CONSTRUCTION");
    expect(snapshot(p)).toEqual(before);
    expect(row).toEndWith("Unit 2 of 6");
  });

  test("one DAG grammar and one Unit name rule: aidlc-lib and the review records re-export them", () => {
    expect(libParseBoltDag).toBe(parseBoltDag);
    expect(libValidateUnitName).toBe(validateUnitName);
    expect(recordsValidateUnitName).toBe(validateUnitName);
    const body = dependencyFile(["api", "auth"], "stage").replace("- name: auth\n    depends_on: []", "- name: auth\n    depends_on: [api]");
    expect(parseBoltDag(body)).toEqual({
      ok: true,
      units: [{ name: "api", depends_on: [] }, { name: "auth", depends_on: ["api"] }],
      batches: [["api"], ["auth"]],
    });
  });
});
