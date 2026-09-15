// covers: function:isAutonomousConstructionGate, subcommand:aidlc-bolt:set-autonomy, subcommand:aidlc-state:approve, subcommand:aidlc-orchestrate:report
//
// An early human grant must not double as the first stage's approval.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  isAutonomousConstructionGate,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

let project = "";
afterEach(() => {
  if (project) cleanupTestProject(project);
  project = "";
});

function run(tool: "bolt" | "state" | "orchestrate", args: string[]) {
  const tools = {
    bolt: "aidlc-bolt.ts",
    state: "aidlc-state.ts",
    orchestrate: "aidlc-orchestrate.ts",
  };
  const env: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
  };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_ALLOW_DIRECT_AUDIT_EVENTS;
  const result = spawnSync(
    process.execPath,
    [join(AIDLC_SRC, "tools", tools[tool]), ...args, "--project-dir", project],
    { encoding: "utf-8", env },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    output: `${result.stdout}${result.stderr}`,
  };
}

function setup(
  stage: string,
  stance: string,
  iteration = "stage-major",
  status: "in-progress" | "awaiting-approval" = "awaiting-approval",
) {
  project = createTestProject();
  seedStateFile(project, join(import.meta.dir, "../fixtures/state-construction-bolt1.md"));
  const path = seededStateFile(project);
  const state = readFileSync(path, "utf-8")
    .replace(`- [ ] ${stage} — EXECUTE`, `- [${status === "in-progress" ? "-" : "?"}] ${stage} — EXECUTE`)
    .replace("**Current Stage**: functional-design", `**Current Stage**: ${stage}`)
    .replace("## Runtime State", [
      "## Runtime State",
      `- **Skeleton Stance**: ${stance}`,
      `- **Construction Iteration**: ${iteration}`,
    ].join("\n"));
  writeFileSync(path, state);
  appendAuditEntry(
    status === "in-progress" ? "STAGE_STARTED" : "STAGE_AWAITING_APPROVAL",
    { Stage: stage },
    project,
  );
  appendAuditEntry("HUMAN_TURN", {}, project);
  const grant = run("bolt", ["set-autonomy", "--mode", "autonomous"]);
  expect(grant.status, grant.output).toBe(0);
}

describe("t339 on-demand autonomy preserves protected stage approvals", () => {
  for (const stance of ["on", "off", "scope-dependent"]) {
    test(`the first ${stance} stage still needs its own human approval`, () => {
      setup("functional-design", stance);
      const before = readFileSync(seededStateFile(project), "utf-8");
      const refused = run("state", ["approve", "functional-design", "--user-input", "Approve"]);
      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain("no new human reply");
      expect(readFileSync(seededStateFile(project), "utf-8")).toBe(before);
      expect(readAllAuditShards(project)).not.toContain("**Event**: GATE_APPROVED");

      appendAuditEntry("HUMAN_TURN", {}, project);
      const approved = run("state", ["approve", "functional-design", "--user-input", "Approve"]);
      // This focused fixture has no reviewer artifacts. The real human reply
      // passes the authority check and reaches the independent review guard.
      expect(approved.output).not.toContain("no new human reply");
      expect(approved.output).toContain("has not reviewed the current output");
    });
  }

  test("a later stage-major completion uses the recorded grant", () => {
    setup("build-and-test", "off");
    const approved = run("state", ["approve", "build-and-test"]);
    expect(approved.status, approved.output).toBe(0);
    expect(readAllAuditShards(project)).toContain("**Event**: GATE_APPROVED");
  });

  test("a conditional skip protects the next approval without moving it after completion", () => {
    setup("functional-design", "on", "stage-major", "in-progress");
    const path = seededStateFile(project);
    // Isolate approval authority from reviewer work; the fixture already uses
    // the unit runner's artifact/summary guard exemptions, never its human one.
    writeFileSync(path, readFileSync(path, "utf-8").replace(
      "## Runtime State",
      "## Runtime State\n- **Review Override**: none",
    ));

    const skipped = run("orchestrate", [
      "report", "--stage", "functional-design", "--result", "skipped",
      "--reason", "Simple logic changes with no new business logic",
    ]);
    expect(skipped.status, skipped.output).toBe(0);
    expect(JSON.parse(skipped.stdout).kind).toBe("done");
    expect(readFileSync(path, "utf-8")).toContain("- [S] functional-design — EXECUTE");
    expect(readFileSync(path, "utf-8")).toContain("**Current Stage**: nfr-requirements");
    expect(readAllAuditShards(project)).toContain("**Skip Kind**: conditional-runtime");

    const opened = run("state", ["gate-start", "nfr-requirements"]);
    expect(opened.status, opened.output).toBe(0);
    const before = readFileSync(path, "utf-8");
    const reportRefused = run("orchestrate", [
      "report", "--stage", "nfr-requirements", "--result", "approved",
    ]);
    expect(JSON.parse(reportRefused.stdout).kind).toBe("error");
    expect(reportRefused.output).toContain("did not match an offered choice");
    const refused = run("state", [
      "approve", "nfr-requirements", "--user-input", "Approve",
    ]);
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("no new human reply");
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(readAllAuditShards(project)).not.toContain("**Event**: GATE_APPROVED");

    appendAuditEntry("HUMAN_TURN", {}, project);
    const approved = run("state", [
      "approve", "nfr-requirements", "--user-input", "Approve",
    ]);
    expect(approved.status, approved.output).toBe(0);
    expect(readFileSync(path, "utf-8")).toContain("- [x] nfr-requirements — EXECUTE");

    // No additional HUMAN_TURN or --user-input: [x] remains the anchor.
    const later = run("orchestrate", [
      "report", "--stage", "nfr-design", "--result", "approved",
    ]);
    expect(later.status, later.output).toBe(0);
    expect(readFileSync(path, "utf-8")).toContain("- [x] nfr-design — EXECUTE");
  });

  test("approved overrides select the anchor in graph order, not checkbox order", () => {
    const state = [
      "- **Scope**: infra",
      "- **Construction Autonomy Mode**: autonomous",
      "- [ ] nfr-requirements — EXECUTE",
      "- [ ] functional-design — EXECUTE",
    ].join("\n");
    const functional = { slug: "functional-design", phase: "construction" };
    const nfr = { slug: "nfr-requirements", phase: "construction" };
    // The approved plan promotes Functional Design ahead of infra's stock anchor.
    expect(isAutonomousConstructionGate(state, functional)).toBe(false);
    expect(isAutonomousConstructionGate(state, nfr)).toBe(true);
    const skippedPlan = state.replace("functional-design — EXECUTE", "functional-design — SKIP");
    expect(isAutonomousConstructionGate(skippedPlan, nfr)).toBe(false);
  });

  test("unit-major retains its human stage approvals", () => {
    setup("nfr-requirements", "off", "unit-major");
    const refused = run("state", ["approve", "nfr-requirements", "--user-input", "Approve"]);
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("no new human reply");
  });

  test("revocation restores a later stage's human approval", () => {
    setup("nfr-requirements", "off");
    expect(run("bolt", ["set-autonomy", "--mode", "gated"]).status).toBe(0);
    const refused = run("state", ["approve", "nfr-requirements", "--user-input", "Approve"]);
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("no new human reply");
  });
});
