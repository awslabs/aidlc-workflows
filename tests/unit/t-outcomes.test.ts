// covers: file:tests/harness/outcomes.ts
//
// The live tests assert what a person meets or what the engine recorded, never
// the route the agent took to get there. Each case below is a break one of
// those tests exists to catch (it must still fail) or a route the agent may
// take that the person cannot tell apart (it must pass). Seeded audit rows and
// state text stand in for a live run, so no model is needed.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seededAuditShard, seededStateFile } from "../harness/fixtures.ts";
import { markersChanged, newlySkipped, stageEvents } from "../harness/outcomes.ts";
import { PersonTurnLedger } from "../harness/person-turns.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

function project(): string {
  const dir = createTestProject();
  projects.push(dir);
  return dir;
}

// A piece of work the engine reads as the active one: its record has a state file.
function work(): string {
  const dir = project();
  writeFileSync(seededStateFile(dir), state({ "reverse-engineering": "EXECUTE" }));
  return dir;
}

let clock = 0;
function row(dir: string, event: string, fields: Record<string, string> = {}): void {
  const shard = seededAuditShard(dir);
  mkdirSync(dirname(shard), { recursive: true });
  const at = new Date(Date.UTC(2026, 9, 14, 12, 0, clock++)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const lines = Object.entries(fields).map(([name, value]) => `**${name}**: ${value}`);
  appendFileSync(shard, [`## ${event}`, `**Timestamp**: ${at}`, `**Event**: ${event}`, ...lines, "", "---", "", ""].join("\n"));
}

// Stage Progress lines as the engine writes them (an em dash between slug and action).
function state(actions: Record<string, string>): string {
  return `${Object.entries(actions).map(([slug, action]) => `- [ ] ${slug} \u2014 ${action}`).join("\n")}\n`;
}

/** Stage lines with their run markers ("x", " ", "-"), every action EXECUTE. */
function progress(markers: Record<string, string>): string {
  return `${Object.entries(markers).map(([slug, mark]) => `- [${mark}] ${slug} \u2014 EXECUTE`).join("\n")}\n`;
}

describe("t-outcomes", () => {
  describe("an isolated stage completes once, on the record (t-journey-workspace)", () => {
    const single = "single-stage:reverse-engineering";

    test("a bare report the agent runs beside the real one writes nothing, so the completion counts once", () => {
      const dir = work();
      const probe = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), "report"], {
        cwd: dir,
        encoding: "utf-8",
        env: { ...process.env, AIDLC_UNATTENDED: "1" },
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(probe.stdout).toContain('"kind":"error"');
      row(dir, "STAGE_STARTED", { Stage: "reverse-engineering", Workflow: single });
      row(dir, "STAGE_COMPLETED", { Stage: "reverse-engineering", Workflow: single });
      expect(stageEvents(dir, "STAGE_COMPLETED", "reverse-engineering", single)).toBe(1);
      expect(stageEvents(dir, "STAGE_COMPLETED", "reverse-engineering")).toBe(1);
    });

    test("a second isolated completion counts twice", () => {
      const dir = work();
      row(dir, "STAGE_COMPLETED", { Stage: "reverse-engineering", Workflow: single });
      row(dir, "STAGE_COMPLETED", { Stage: "reverse-engineering", Workflow: single });
      expect(stageEvents(dir, "STAGE_COMPLETED", "reverse-engineering", single)).toBe(2);
    });

    test("a completion against the main workflow shows over every workflow", () => {
      const dir = work();
      row(dir, "STAGE_COMPLETED", { Stage: "reverse-engineering", Workflow: single });
      row(dir, "STAGE_COMPLETED", { Stage: "reverse-engineering" });
      expect(stageEvents(dir, "STAGE_COMPLETED", "reverse-engineering", single)).toBe(1);
      expect(stageEvents(dir, "STAGE_COMPLETED", "reverse-engineering")).toBe(2);
    });

    test("a gate opened for the stage shows", () => {
      const dir = work();
      row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "reverse-engineering" });
      expect(stageEvents(dir, "STAGE_AWAITING_APPROVAL", "reverse-engineering")).toBe(1);
      expect(stageEvents(dir, "STAGE_AWAITING_APPROVAL", "requirements-analysis")).toBe(0);
    });
  });

  // t126 drops its gate witness: the person-turn check every drive runs is the
  // one owner of "a gate resolution has a reply from the person after it opened".
  describe("an approval needs a reply after its gate opened (t126)", () => {
    const prompt = "/aidlc poc Build a local CLI that converts CSV input to formatted JSON output. " +
      "Use the simplest sensible stack, and approve each gate.";

    test("an approval on the opening prompt's standing instruction is flagged", () => {
      const dir = project();
      row(dir, "WORKFLOW_STARTED");
      const drive = new PersonTurnLedger(dir);
      drive.sent(prompt);
      row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "requirements-analysis" });
      row(dir, "GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve" });
      const [problem, ...rest] = drive.unbacked();
      expect(rest).toEqual([]);
      expect(problem).toContain("GATE_APPROVED requirements-analysis");
    });

    test("a differently worded approval menu answered after the gate opened backs it", () => {
      const dir = project();
      row(dir, "WORKFLOW_STARTED");
      const drive = new PersonTurnLedger(dir);
      drive.sent(prompt);
      row(dir, "STAGE_AWAITING_APPROVAL", { Stage: "requirements-analysis" });
      drive.sent('{"Requirements are ready. Continue?":"Approve & continue"}', 1);
      row(dir, "GATE_APPROVED", { Stage: "requirements-analysis", "User Input": "Approve & continue" });
      expect(drive.unbacked()).toEqual([]);
    });
  });

  describe("a plan change skips the stages the person named and no others (t196)", () => {
    const before = state({ "reverse-engineering": "SKIP", "market-research": "EXECUTE", "team-formation": "EXECUTE", "user-stories": "EXECUTE" });

    test("both named stages skipped, an earlier skip not counted", () => {
      const after = state({ "reverse-engineering": "SKIP", "market-research": "SKIP", "team-formation": "SKIP", "user-stories": "EXECUTE" });
      expect(newlySkipped(before, after)).toEqual(["market-research", "team-formation"]);
    });

    test("a stage the person did not name skipped shows", () => {
      const after = state({ "reverse-engineering": "SKIP", "market-research": "SKIP", "team-formation": "SKIP", "user-stories": "SKIP" });
      expect(newlySkipped(before, after)).toEqual(["market-research", "team-formation", "user-stories"]);
    });
  });

  // Codex compose-inflight: a plan change edits the plan, never the run state;
  // after the person's Approve the agent may carry on into the current stage.
  describe("a plan change leaves the work where it stands (Codex compose-inflight)", () => {
    const before = progress({ "state-init": "x", "intent-capture": " ", "market-research": " " });

    test("the current stage starting is the agent carrying on, not a change", () => {
      const after = progress({ "state-init": "x", "intent-capture": "-", "market-research": " " });
      expect(markersChanged(before, after, "intent-capture")).toEqual([]);
    });

    test("a completed stage reopened shows", () => {
      const after = progress({ "state-init": " ", "intent-capture": " ", "market-research": " " });
      expect(markersChanged(before, after, "intent-capture")).toEqual(["state-init"]);
    });

    test("a stage ahead of the cursor started shows", () => {
      const after = progress({ "state-init": "x", "intent-capture": " ", "market-research": "-" });
      expect(markersChanged(before, after, "intent-capture")).toEqual(["market-research"]);
    });
  });
});
