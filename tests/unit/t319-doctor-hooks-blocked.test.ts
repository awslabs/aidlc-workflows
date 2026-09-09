// covers: subcommand:aidlc-utility:doctor
//
// Doctor must distinguish a truly fresh install from a workflow whose hooks
// have never executed, and must surface Claude Code managed policy that makes
// project hooks impossible to run.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function freshProject(): string {
  const project = setupIntegrationProject();
  created.push(project);
  mkdirSync(join(project, ".managed-policy"), { recursive: true });
  return project;
}

function runUtility(
  project: string,
  args: string[],
  envOverrides: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
    AIDLC_HARNESS_DIR: ".claude",
    AIDLC_MANAGED_SETTINGS_PATH: join(
      project,
      ".managed-policy",
      "managed-settings.json",
    ),
    ...envOverrides,
  };
  if (!Object.hasOwn(envOverrides, "AIDLC_HARNESS_NAME")) {
    delete env.AIDLC_HARNESS_NAME;
  }
  return spawnSync(
    process.execPath,
    [
      join(project, ".claude", "tools", "aidlc-utility.ts"),
      ...args,
      "--project-dir",
      project,
    ],
    {
      cwd: project,
      encoding: "utf-8",
      env,
      timeout: 30_000,
    },
  );
}

function output(run: ReturnType<typeof runUtility>): string {
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

function writeManagedSettings(
  project: string,
  body: Record<string, unknown>,
  relativePath = "managed-settings.json",
): void {
  const path = join(project, ".managed-policy", relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
}

function projectWithWorkflowProgress(): string {
  const project = freshProject();
  const birth = runUtility(project, [
    "intent-create",
    "--scope",
    "bugfix",
    "--label",
    "heartbeat probe",
    "--arguments",
    "exercise doctor heartbeat detection",
  ]);
  expect(birth.status, output(birth)).toBe(0);
  return project;
}

function activeHealthDir(project: string): string {
  const intentsDir = join(project, "aidlc", "spaces", "default", "intents");
  const active = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
  return join(intentsDir, active, ".aidlc-hooks-health");
}

function writeHeartbeat(project: string, timestamp: string): void {
  const health = activeHealthDir(project);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "write-audit-log.last"), timestamp, "utf-8");
}

function newestStageOrGateTimestamp(project: string): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const event of readAuditShardEvents(project)) {
    if (
      (event.event.startsWith("STAGE_") || event.event.startsWith("GATE_")) &&
      Number.isFinite(Date.parse(event.timestamp))
    ) {
      newest = Math.max(newest, Date.parse(event.timestamp));
    }
  }
  if (!Number.isFinite(newest)) {
    throw new Error("fixture produced no parseable stage/gate audit timestamp");
  }
  return newest;
}

function isoSecond(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

describe("t319 doctor detects hooks blocked before their first heartbeat", () => {
  test("zero heartbeats with no workflow progress keeps the fresh-install advisory", () => {
    const run = runUtility(freshProject(), ["doctor", "--verbose"]);
    expect(output(run)).toContain(
      "ok    Hook heartbeats: not yet fired (first workflow stage will populate)",
    );
  });

  test("AIDLC_HOOK_DEBUG-only health data does not create a false failure", () => {
    const project = freshProject();
    const health = join(seededRecordDir(project), ".aidlc-hooks-health");
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "hook-debug.log"), "debug only\n", "utf-8");

    const run = runUtility(project, ["doctor", "--verbose"]);
    expect(output(run)).toContain(
      "ok    Hook heartbeats: not yet fired (first workflow stage will populate)",
    );
  });

  test("zero heartbeats after workflow progress fails and warns about hook approval restart", () => {
    const project = projectWithWorkflowProgress();

    const run = runUtility(project, ["doctor", "--verbose"]);
    expect(run.status).toBe(1);
    expect(output(run)).toMatch(
      /fail {2}Hooks have never executed although this workflow has progressed [1-9]\d* stages?/,
    );
    expect(output(run)).toContain("1. Run /hooks to check hook approval and policy state.");
    expect(output(run)).toContain("approval does not take effect until a full restart");
    expect(output(run)).toContain(
      "only your Claude Code administrator can lift allowManagedHooksOnly in managed-settings.json",
    );
    expect(output(run)).toContain("AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1");
    expect(output(run)).toContain("AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD=1");
    expect(output(run)).toMatch(
      /ok {4}Human-turn receipts: 0 HUMAN_TURN rows across \d+ stage\/gate event\(s\) \(advisory\)/,
    );
  }, 30_000);

  test("allowManagedHooksOnly=true fails with the administrator and bypass guidance", () => {
    const project = freshProject();
    writeManagedSettings(project, { allowManagedHooksOnly: true });

    const run = runUtility(project, ["doctor", "--verbose"]);
    expect(run.status).toBe(1);
    expect(output(run)).toContain(
      "fail  Claude managed hook policy: allowManagedHooksOnly=true",
    );
    expect(output(run)).toContain(
      "only the Claude Code administrator can lift it in managed-settings.json",
    );
    expect(output(run)).toContain("AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1");
    expect(output(run)).toContain("AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD=1");
  });

  test("managed settings fragments merge alphabetically and a later false clears the finding", () => {
    const project = freshProject();
    writeManagedSettings(
      project,
      { allowManagedHooksOnly: true },
      "managed-settings.d/10-restrict.json",
    );
    writeManagedSettings(
      project,
      { allowManagedHooksOnly: false },
      "managed-settings.d/20-release.json",
    );

    const run = runUtility(project, ["doctor", "--verbose"]);
    expect(output(run)).not.toContain("Claude managed hook policy");
  });

  test("managed-settings.d participates in disableAllHooks without changing managed precedence", () => {
    const project = freshProject();
    writeManagedSettings(project, { disableAllHooks: true });
    writeManagedSettings(
      project,
      { disableAllHooks: false, allowManagedHooksOnly: true },
      "managed-settings.d/10-policy.json",
    );

    const run = runUtility(project, ["doctor", "--verbose"]);
    expect(run.status).toBe(1);
    expect(output(run)).toContain(
      "ok    Hooks enabled (resolved disableAllHooks is not true)",
    );
    expect(output(run)).toContain(
      "fail  Claude managed hook policy: allowManagedHooksOnly=true",
    );
  });

  test("absent/false policy emits no finding, and a non-Claude harness never probes it", () => {
    const absentProject = freshProject();
    expect(output(runUtility(absentProject, ["doctor", "--verbose"]))).not.toContain(
      "Claude managed hook policy",
    );

    const falseProject = freshProject();
    writeManagedSettings(falseProject, { allowManagedHooksOnly: false });
    expect(output(runUtility(falseProject, ["doctor", "--verbose"]))).not.toContain(
      "Claude managed hook policy",
    );

    const otherHarnessProject = freshProject();
    writeManagedSettings(otherHarnessProject, {
      allowManagedHooksOnly: true,
      disableAllHooks: true,
    });
    const otherHarnessOutput = output(
      runUtility(otherHarnessProject, ["doctor", "--verbose"], {
        AIDLC_HARNESS_NAME: "codex",
      }),
    );
    expect(otherHarnessOutput).not.toContain("Claude managed hook policy");
    expect(otherHarnessOutput).not.toContain("Hooks DISABLED");
    expect(otherHarnessOutput).not.toContain("Hooks enabled");
  }, 30_000);

  test("stale heartbeats fail when workflow progress is more than five minutes newer", () => {
    const project = projectWithWorkflowProgress();
    const heartbeat = "2000-01-01T00:00:00Z";
    writeHeartbeat(project, heartbeat);

    const run = runUtility(project, ["doctor", "--verbose"]);
    expect(run.status).toBe(1);
    expect(output(run)).toContain(`fail  Hooks last fired ${heartbeat}, but the workflow last advanced `);
    expect(output(run)).toContain("1. Run /hooks to check hook approval and policy state.");
    expect(output(run)).toContain("AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1");
    expect(output(run)).toContain("AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD=1");
  });

  test("four-minute heartbeat lag stays within the same-turn slack", () => {
    const project = projectWithWorkflowProgress();
    const latestAdvance = newestStageOrGateTimestamp(project);
    const heartbeat = isoSecond(latestAdvance - 4 * 60 * 1000);
    writeHeartbeat(project, heartbeat);

    const run = runUtility(project, ["doctor", "--verbose"]);
    expect(run.status, output(run)).toBe(0);
    expect(output(run)).toContain(
      `ok    Hooks last fired: write-audit-log ${heartbeat}`,
    );
  });

  test("unparseable heartbeat content is visible but does not fail doctor", () => {
    const project = projectWithWorkflowProgress();
    writeHeartbeat(project, "not-a-timestamp");

    const run = runUtility(project, ["doctor", "--verbose"]);
    expect(run.status, output(run)).toBe(0);
    expect(output(run)).toContain(
      "ok    Hooks last fired: write-audit-log not-a-timestamp",
    );
  });

  test("a fresh heartbeat keeps the existing passing label", () => {
    const project = projectWithWorkflowProgress();
    const latestAdvance = newestStageOrGateTimestamp(project);
    const heartbeat = isoSecond(latestAdvance + 1_000);
    writeHeartbeat(project, heartbeat);

    const run = runUtility(project, ["doctor", "--verbose"]);
    expect(run.status, output(run)).toBe(0);
    expect(output(run)).toContain(
      `ok    Hooks last fired: write-audit-log ${heartbeat}`,
    );
  });
});
