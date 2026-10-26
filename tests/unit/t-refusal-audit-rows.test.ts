// covers: function:recordGuardBlockedRow

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  auditFilePath,
  recordGuardBlockedRow,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, seedStateFile } from "../harness/fixtures.ts";

const projects: string[] = [];

function withShard(): { project: string; shard: string } {
  const project = createTestProject();
  projects.push(project);
  seedStateFile(project, "state-mid-ideation.md");
  const shard = auditFilePath(project);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, "# AI-DLC Audit Log\n", "utf-8");
  return { project, shard };
}

afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

describe("recordGuardBlockedRow", () => {
  test("writes one row carrying the guard, reason, target and session", () => {
    const { project, shard } = withShard();
    expect(recordGuardBlockedRow(project, {
      eventType: "STATE_TRANSITION_BLOCKED",
      hook: "state-transition-guard",
      reason: "delegated-lifecycle",
      tool: "Bash",
      target: "aidlc-state.ts gate-start",
      session: "11111111-2222-3333-4444-555555555555",
    })).toBe(true);
    const body = readFileSync(shard, "utf-8");
    expect(body).toContain("**Event**: STATE_TRANSITION_BLOCKED");
    expect(body).toContain("**Guard**: state-transition-guard");
    expect(body).toContain("**Reason**: delegated-lifecycle");
    expect(body).toContain("**Target**: aidlc-state.ts gate-start");
    expect(body).toContain("**Session**: 11111111-2222-3333-4444-555555555555");
  });

  test("every refusal writes its own row, so a loop shows in the record", () => {
    const { project, shard } = withShard();
    const row = {
      eventType: "STAGE_RULES_BLOCKED" as const,
      hook: "deliver-stage-rules",
      reason: "oversize",
    };
    expect(recordGuardBlockedRow(project, row)).toBe(true);
    expect(recordGuardBlockedRow(project, row)).toBe(true);
    const body = readFileSync(shard, "utf-8");
    expect(body.match(/STAGE_RULES_BLOCKED/g)).toHaveLength(2);
    expect(recordGuardBlockedRow(project, { ...row, reason: "rules-unreadable" })).toBe(true);
    expect(readFileSync(shard, "utf-8")).toContain("**Reason**: rules-unreadable");
  });

  test("a refusal with no audit shard writes nothing and does not throw", () => {
    const project = createTestProject();
    projects.push(project);
    expect(recordGuardBlockedRow(project, {
      eventType: "PLAN_APPROVAL_BLOCKED",
      hook: "plan-approval-guard",
      reason: "authority",
    })).toBe(false);
  });

  test("an unreadable project path is reported as no row, not as a throw", () => {
    expect(recordGuardBlockedRow("\u0000not-a-path", {
      eventType: "PLAN_APPROVAL_BLOCKED",
      hook: "plan-approval-guard",
      reason: "authority",
    })).toBe(false);
  });
});
