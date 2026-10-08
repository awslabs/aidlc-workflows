// covers: file:tools/aidlc-state.ts, file:tools/aidlc-review-brief.ts, file:knowledge/aidlc-shared/audit-format.md
//
// A stage gate is where the person decides, and until now the record said only
// THAT they approved, never what they were approving (#2098). The gate-open row
// now carries what the engine computed and what the agent showed: the stage the
// approval continues to, the digest of the review brief rendered for the gate,
// the state of the checks, and the decisions the artifacts left to the person.
// Record-only: no gate is ever refused for it.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  AIDLC_SRC,
  REPO_ROOT,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  auditBlockField,
  findStageBySlug,
  nextInScopeStage,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const BRIEF = join(AIDLC_SRC, "tools", "aidlc-review-brief.ts");
const STAGE = "feasibility"; // state-mid-ideation.md: Current Stage feasibility, Scope feature

let proj: string;

function run(tool: string, args: string[]): { rc: number; out: string } {
  const env = { ...process.env };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
  // The row reads the checks the audit holds; no sensor runs during the test.
  env.AIDLC_DISABLE_SENSORS = "1";
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const r = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function rows(event: string) {
  return readAuditShardEvents(proj).filter((row) => row.event === event);
}

function field(row: { block: string }, name: string): string | null {
  return auditBlockField(row.block, name);
}

function openGate(): { block: string } {
  expect(run(STATE, ["checkbox", `${STAGE}=in-progress`]).rc).toBe(0);
  const r = run(STATE, ["gate-start", STAGE]);
  expect(r.rc, r.out).toBe(0);
  const open = rows("STAGE_AWAITING_APPROVAL");
  expect(open.length).toBeGreaterThan(0);
  return open.at(-1)!;
}

function stageDir(): string {
  const dir = join(seededRecordDir(proj), "ideation", STAGE);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(name: string, body: string): string {
  const path = join(stageDir(), `${name}.md`);
  writeFileSync(path, body);
  return path;
}

// The dispatcher records an artifact's Output path project-relative with
// forward slashes on every OS (relativizePath); the row the gate reads is keyed
// the same way, so the fixture rows spell it so too.
function outputPath(absolute: string): string {
  return relative(proj, absolute).split(sep).join("/");
}

function sensorRow(event: "SENSOR_PASSED" | "SENSOR_FAILED", fireId: string, outputRel: string, findings = 1): void {
  appendAuditEntry(event, {
    "Fire id": fireId,
    "Sensor ID": "required-sections",
    "Stage slug": STAGE,
    "Output path": outputRel,
    ...(event === "SENSOR_PASSED" ? { "Duration ms": "12" } : { "Detail path": `.aidlc-engine/sensors/${fireId}.json`, "Findings count": String(findings) }),
  }, proj);
}

const DECISIONS = "# Feasibility Assessment\n\nContent.\n\n## Decisions needed\n\n```aidlc-decisions\ndecisions:\n" +
  "  - id: D1\n    decision: The overflow threshold per numeric mode\n    owner: person\n    blocking: true\n" +
  "  - id: D2\n    decision: Whether the CLI ships a man page\n    owner: person\n    blocking: false\n```\n";

describe("t-gate-asks-record: the gate row says what the person was asked to decide", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
  });
  afterEach(() => cleanupTestProject(proj));

  test("the row names the next in-scope stage the approval continues to, from the engine's own computation", () => {
    const row = openGate();
    const content = readFileSync(seededStateFile(proj), "utf-8");
    const expected = nextInScopeStage(STAGE, "feature", content);
    expect(expected).not.toBeNull();
    expect(field(row, "Next Stage")).toBe(expected!.slug);
    // The display name the gate reply shows is this slug's name: one source for both.
    expect(findStageBySlug(expected!.slug)?.name).toBe(expected!.name);
  });

  test("with no review brief rendered, the row says so", () => {
    expect(field(openGate(), "Brief Digest")).toBe("none");
  });

  test("the brief the agent renders for the gate is kept as printed, and the row carries its digest", () => {
    const rendered = run(BRIEF, ["review", "--stage", STAGE, "--why", "first"]);
    expect(rendered.rc, rendered.out).toBe(0);
    const briefs = join(seededRecordDir(proj), ".aidlc-engine", "reviews", STAGE, "stage", "briefs");
    expect(existsSync(briefs)).toBe(true);
    const kept = readdirSync(briefs).filter((name) => name.endsWith(".md"));
    expect(kept).toHaveLength(1);
    const text = readFileSync(join(briefs, kept[0]), "utf-8");
    expect(text).toBe(rendered.out);
    const digest = createHash("sha256").update(text).digest("hex");
    expect(kept[0]).toBe(`${digest}.md`);
    expect(JSON.parse(readFileSync(join(briefs, "latest.json"), "utf-8"))).toMatchObject({ digest, why: "first" });
    expect(field(openGate(), "Brief Digest")).toBe(`sha256:${digest}`);
  });

  // Live (dev-1, 2026-10-08): the agent renders the brief one second AFTER the gate row is written, as the protocol
  // orders it, so the gate-open row says none in the normal flow. The approval row is written after the brief was
  // shown: it carries the digest of what the person decided on.
  test("the approval row carries the digest of the brief rendered after the gate opened; none when none was", () => {
    const open = openGate();
    expect(field(open, "Brief Digest")).toBe("none");
    const rendered = run(BRIEF, ["review", "--stage", STAGE, "--why", "first"]);
    expect(rendered.rc, rendered.out).toBe(0);
    const digest = createHash("sha256").update(rendered.out).digest("hex");
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const approved = run(STATE, ["approve", STAGE, "--user-input", "Approve"]);
    expect(approved.rc, approved.out).toBe(0);
    expect(field(rows("GATE_APPROVED").at(-1)!, "Brief Digest")).toBe(`sha256:${digest}`);
  });

  test("an approval with no brief rendered says none", () => {
    openGate();
    appendAuditEntry("HUMAN_TURN", {}, proj);
    expect(run(STATE, ["approve", STAGE, "--user-input", "Approve"]).rc).toBe(0);
    expect(field(rows("GATE_APPROVED").at(-1)!, "Brief Digest")).toBe("none");
  });

  // AIDA on #2166 (F1): the kept brief was written with link-following calls under a path that joined an unchecked
  // Unit name. A cloned repo can carry a planted link under the record's reviews tree; the keep must never follow it,
  // and the brief must still print.
  test("a briefs folder that is a link to the outside is not written through; the brief still prints", () => {
    const outside = mkdtempSync(join(tmpdir(), "aidlc-outside-"));
    const scopeDir = join(seededRecordDir(proj), ".aidlc-engine", "reviews", STAGE, "stage");
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(outside, join(scopeDir, "briefs"));
    const rendered = run(BRIEF, ["review", "--stage", STAGE, "--why", "first"]);
    expect(rendered.rc, rendered.out).toBe(0);
    expect(rendered.out.length).toBeGreaterThan(0);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(scopeDir, "briefs")).isSymbolicLink()).toBe(true);
    expect(field(openGate(), "Brief Digest")).toBe("none");
  });

  test("a latest.json that is a link to the outside is left alone; the file it points at keeps its content", () => {
    const outside = mkdtempSync(join(tmpdir(), "aidlc-outside-"));
    const target = join(outside, "keep.json");
    writeFileSync(target, "untouched\n");
    const briefs = join(seededRecordDir(proj), ".aidlc-engine", "reviews", STAGE, "stage", "briefs");
    mkdirSync(briefs, { recursive: true });
    symlinkSync(target, join(briefs, "latest.json"));
    const rendered = run(BRIEF, ["review", "--stage", STAGE, "--why", "first"]);
    expect(rendered.rc, rendered.out).toBe(0);
    expect(readFileSync(target, "utf-8")).toBe("untouched\n");
    expect(lstatSync(join(briefs, "latest.json")).isSymbolicLink()).toBe(true);
  });

  test("a unit name that is not one is never joined into the kept brief's path", () => {
    const rendered = run(BRIEF, ["review", "--stage", STAGE, "--why", "first", "--unit", "../../escape"]);
    expect(rendered.rc, rendered.out).toBe(0);
    expect(existsSync(join(seededRecordDir(proj), ".aidlc-engine", "reviews", STAGE, "units"))).toBe(false);
    expect(existsSync(join(seededRecordDir(proj), "escape"))).toBe(false);
  });

  test("the row lists the latest result of every applicable check per declared artifact, failures first, with the detail path", () => {
    const rel = outputPath(join(seededRecordDir(proj), "ideation", STAGE, "feasibility-assessment.md"));
    writeArtifact("feasibility-assessment", "# Feasibility Assessment\n\nContent.\n");
    writeArtifact("constraint-register", "# Constraint Register\n\nContent.\n");
    sensorRow("SENSOR_PASSED", "aaaa0001", rel);
    sensorRow("SENSOR_FAILED", "aaaa0002", rel, 3);
    const row = openGate();
    const state = field(row, "Sensor State") ?? "";
    expect(state.startsWith(`required-sections@${rel}=failed(3) [detail: .aidlc-engine/sensors/aaaa0002.json]`), state).toBe(true);
    expect(state).toContain("constraint-register.md=not-run");
  });

  test("the latest terminal result of a check wins: a pass after a failure reads as passed", () => {
    const rel = outputPath(join(seededRecordDir(proj), "ideation", STAGE, "feasibility-assessment.md"));
    writeArtifact("feasibility-assessment", "# Feasibility Assessment\n\nContent.\n");
    sensorRow("SENSOR_FAILED", "aaaa0002", rel, 3);
    sensorRow("SENSOR_PASSED", "aaaa0003", rel);
    const state = field(openGate(), "Sensor State") ?? "";
    expect(state).toContain(`required-sections@${rel}=passed`);
    expect(state).not.toContain("failed(");
  });

  test("decisions the artifacts leave to the person are recorded at the gate and accepted open by Approve; a block the engine cannot read never stops the gate", () => {
    writeArtifact("feasibility-assessment", DECISIONS);
    const row = openGate();
    expect(field(row, "Open Decisions")).toBe("2");
    expect(field(row, "Decisions")).toBe("D1, D2");
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const approved = run(STATE, ["approve", STAGE, "--user-input", "Approve"]);
    expect(approved.rc, approved.out).toBe(0);
    expect(field(rows("GATE_APPROVED").at(-1)!, "Decisions Accepted Open")).toBe("D1, D2");
  });

  test("no block records zero decisions", () => {
    writeArtifact("feasibility-assessment", "# Feasibility Assessment\n\nContent.\n");
    const plain = openGate();
    expect(field(plain, "Open Decisions")).toBe("0");
    expect(field(plain, "Decisions")).toBeNull();
  });

  test("a block the engine cannot read records unreadable, and the gate still opens", () => {
    writeArtifact("constraint-register", "# Constraint Register\n\n```aidlc-decisions\ndecisions: [not a list\n```\n");
    const row = openGate();
    expect(field(row, "Open Decisions")).toBe("unreadable (constraint-register.md)");
    expect(field(row, "Decisions")).toBeNull();
  });

  test("every gate-open emit in the state tool carries the four fields", () => {
    const source = readFileSync(join(REPO_ROOT, "core", "tools", "aidlc-state.ts"), "utf-8");
    const emits = source.match(/\(pd, "STAGE_AWAITING_APPROVAL"/g) ?? [];
    expect(emits.length).toBe(6);
    expect((source.match(/\.\.\.gateAskFields\(/g) ?? []).length).toBe(6);
  });

  test("no stage file names a fixed next phase at its gate: the engine's next stage is the only source", () => {
    const stagesDir = join(REPO_ROOT, "core", "aidlc-common", "stages");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".md") && /(continue|proceed) to (Ideation|Inception|Construction|Operation)\b/i.test(readFileSync(path, "utf-8"))) {
          offenders.push(path.slice(stagesDir.length + 1));
        }
      }
    };
    walk(stagesDir);
    expect(offenders).toEqual([]);
  });

  test("audit-format.md lists the four fields on the gate-open row and the accepted decisions on the approval row", () => {
    const doc = readFileSync(join(REPO_ROOT, "core", "knowledge", "aidlc-shared", "audit-format.md"), "utf-8");
    const open = doc.split("\n").find((line) => line.startsWith("| `STAGE_AWAITING_APPROVAL` |")) ?? "";
    for (const name of ["Next Stage", "Brief Digest", "Sensor State", "Open Decisions"]) expect(open).toContain(name);
    const approved = doc.split("\n").find((line) => line.startsWith("| `GATE_APPROVED` |")) ?? "";
    expect(approved).toContain("Decisions Accepted Open");
    expect(approved).toContain("Brief Digest");
  });
});
