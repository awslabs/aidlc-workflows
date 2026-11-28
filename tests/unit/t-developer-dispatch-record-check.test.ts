// covers: hook:aidlc-log-subagent, audit:SUBAGENT_DISPATCHED, audit:SUBAGENT_COMPLETED

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  NATIVE_STARTUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedAidlcMemory,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const UNIT = "u1-auth";
const DEVELOPER = "aidlc-developer-agent";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const SESSION = "01995000-7a11-7000-8000-00000000c0de";
const HOOKS = join(REPO_ROOT, "dist", "claude", ".claude", "hooks");

const shell: Record<string, string | undefined> = { ...process.env };
for (const key of Object.keys(shell)) if (/^CLAUDE/.test(key)) delete shell[key];
const ENV = { ...shell, CLAUDE_CODE_SESSION_ID: "5b0c7f1e-9d2a-4c1b-8f3e-2a6d4e8b9c02" };

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function recordDirOf(project: string): string {
  return join(seededRecordDir(project), "construction", UNIT, "code-generation");
}

function project(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-construction.md"));
  const statePath = join(seededRecordDir(p), "aidlc-state.md");
  const state = readFileSync(statePath, "utf-8")
    .replace(
      "- **Revision Count**: 0",
      "- **Revision Count**: 0\n- **Active Unit**: u1-auth\n- **Unit Stage**: code-generation",
    )
    .replace("- **Current Stage**: functional-design", "- **Current Stage**: code-generation");
  writeFileSync(statePath, state, "utf-8");
  const dir = recordDirOf(p);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"), "# Plan\n\n- [ ] build the login route\n", "utf-8");
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Tests\n", "utf-8");
  return p;
}

function spawn(args: string[], projectDir: string, payload: Record<string, unknown>) {
  const r = spawnSync(BUN, args, {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: {
      ...ENV,
      AIDLC_PROJECT_DIR: projectDir,
      CLAUDE_PROJECT_DIR: projectDir,
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    } as Record<string, string>,
    input: JSON.stringify(payload),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function sends(projectDir: string, agent = DEVELOPER): void {
  const r = spawn([join(HOOKS, "aidlc-deliver-stage-rules.ts")], projectDir, {
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    tool_name: "task",
    tool_input: { subagent_type: agent, prompt: "AIDLC-UNIT: u1-auth" },
    cwd: projectDir,
  });
  expect(r.status, r.out).toBe(0);
}

function finishes(projectDir: string, agent = DEVELOPER): string {
  const r = spawn([join(HOOKS, "aidlc-log-subagent.ts")], projectDir, {
    hook_event_name: "SubagentStop",
    session_id: SESSION,
    agent_type: agent,
    agent_id: `${agent}-1`,
    last_assistant_message: "Completed",
  });
  expect(r.status, r.out).toBe(0);
  return r.out;
}

function dispatchRows(projectDir: string): string[] {
  return readAllAuditShards(projectDir)
    .split("\n---\n")
    .filter((block) => block.includes("**Event**: SUBAGENT_DISPATCHED"));
}

const WARNING = "reported completed, but its record did not change";

describe("a developer dispatch that ends completed is checked against the record it was sent to change", () => {
  test("nothing written leaves the Unit and the files that did not change named at the stop", () => {
    const p = project();
    sends(p);
    expect(dispatchRows(p)).toHaveLength(1);
    expect(dispatchRows(p)[0]).toContain("**Record Digest**:");
    expect(dispatchRows(p)[0]).toContain("code-summary.md=absent");

    const out = finishes(p);
    expect(out).toContain(WARNING);
    expect(out).toContain(UNIT);
    expect(out).toContain("code-summary.md");
    expect(out).toContain("traceability.json");
    expect(out).toContain("Re-dispatch the unit");
  });

  test("a dispatch that wrote the Unit's files says nothing", () => {
    const p = project();
    sends(p);
    writeFileSync(join(recordDirOf(p), "code-summary.md"), "# Code Summary\n\nBuilt the login route.\n", "utf-8");
    writeFileSync(
      join(recordDirOf(p), "traceability.json"),
      JSON.stringify({ stage: "code-generation", unit: UNIT, upstream_ids: [], coverage: [] }, null, 2),
      "utf-8",
    );
    expect(finishes(p)).not.toContain(WARNING);
  });

  test("a ticked plan step counts as the record changing", () => {
    const p = project();
    sends(p);
    writeFileSync(
      join(recordDirOf(p), "code-generation-plan.md"),
      "# Plan\n\n- [x] build the login route\n",
      "utf-8",
    );
    expect(finishes(p)).not.toContain(WARNING);
  });

  test("another agent's dispatch is not checked", () => {
    const p = project();
    sends(p, REVIEWER);
    expect(dispatchRows(p)[0]).not.toContain("**Record Digest**:");
    expect(finishes(p, REVIEWER)).not.toContain(WARNING);
  });

  test("a developer dispatch repairing a reviewed build is not checked", () => {
    const p = project();
    appendAuditEntry("REVIEW_REQUESTED", {
      "Request Id": "r1",
      Reviewer: REVIEWER,
      Stage: "code-generation",
      Unit: UNIT,
      "Review File": `aidlc-docs/reviews/${UNIT}-code-generation-1.md`,
    }, p);
    sends(p);
    expect(finishes(p)).not.toContain(WARNING);
  });

  test("a stop with no Code Generation record to compare against is left alone", () => {
    const p = project();
    writeFileSync(
      join(seededRecordDir(p), "aidlc-state.md"),
      readFileSync(join(seededRecordDir(p), "aidlc-state.md"), "utf-8")
        .replace("- **Unit Stage**: code-generation", "- **Unit Stage**: functional-design"),
      "utf-8",
    );
    sends(p);
    expect(finishes(p)).not.toContain(WARNING);
  });
});
