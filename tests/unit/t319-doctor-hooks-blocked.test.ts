// covers: subcommand:aidlc-utility:doctor
//
// Doctor must distinguish a truly fresh install from a workflow whose hooks
// have never executed, and must surface Claude Code managed policy that makes
// project hooks impossible to run.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  REPO_ROOT,
  cleanupTestProject,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
}

function output(run: ReturnType<typeof runUtility>): string {
  return `${run.stdout ?? ""}${run.stderr ?? ""}`;
}

// The fixture runs the Claude tools tree; giving its shipped harness data Kiro
// IDE's hookActivation block makes the doctor read it as a Kiro IDE install.
function asKiroIde(project: string): Record<string, string> {
  const kiroIde = JSON.parse(readFileSync(
    join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "tools", "data", "harness.json"),
    "utf-8",
  )) as { hookActivation?: unknown };
  expect(kiroIde.hookActivation).toBeDefined();
  const path = join(project, ".claude", "tools", "data", "harness.json");
  const shipped = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  writeFileSync(
    path,
    `${JSON.stringify({ ...shipped, hookActivation: kiroIde.hookActivation }, null, 2)}\n`,
  );
  return { AIDLC_HARNESS_NAME: "kiro-ide" };
}

const KIRO_IDE_ADVICE = ["Reload Window", "Restricted Mode", "agent picker", "Kiro IDE"];

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
  return join(intentsDir, active, ".aidlc-engine/hooks-health");
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

  // Kiro IDE runs no hooks in an untrusted or unreloaded window. Its adapter
  // leaves a heartbeat on every chat message before the first workflow, so
  // none yet gets the harness's trust and reload steps.
  test("Kiro IDE with no heartbeat warns that the hooks have not run, with the trust and reload steps", () => {
    const project = freshProject();
    const run = runUtility(project, ["doctor", "--verbose"], asKiroIde(project));
    const text = output(run);
    expect(text).toContain("warn  AIDLC hooks have not run in this project yet");
    expect(text).toContain(
      "fix: This is expected before your first chat message here. If you already sent one, Kiro IDE is not running AIDLC hooks in this window: trust the folder if the Restricted Mode banner shows at the top of the window (select Manage, then Trust), run \"Developer: Reload Window\" from the Command Palette",
    );
    expect(text).toContain("choose the aidlc agent in the chat panel's agent picker, then send a message.");
    expect(text).not.toContain("Hook heartbeats: not yet fired");
  });

  test("Kiro IDE with a chat message's heartbeat reports the hooks as fired", () => {
    const project = freshProject();
    // Where the adapter's prompt heartbeat lands with no intent (t218 pins the write).
    const health = join(project, "aidlc", "spaces", "default", "intents", ".aidlc-engine", "hooks-health");
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "terminal-command.last"), isoSecond(Date.now()), "utf-8");

    const run = runUtility(project, ["doctor", "--verbose"], asKiroIde(project));
    expect(output(run)).toContain("ok    Hooks last fired: terminal-command ");
    expect(output(run)).not.toContain("AIDLC hooks have not run in this project yet");
  });

  test("Kiro IDE after workflow progress fails with the Kiro reload steps", () => {
    const project = projectWithWorkflowProgress();

    const run = runUtility(project, ["doctor", "--verbose"], asKiroIde(project));
    expect(run.status).toBe(1);
    expect(output(run)).toMatch(
      /fail {2}Hooks have never executed although this workflow has progressed [1-9]\d* stages?/,
    );
    expect(output(run)).toContain(
      "In Kiro IDE, trust the folder if the Restricted Mode banner shows at the top of the window (select Manage, then Trust), run \"Developer: Reload Window\"",
    );
    expect(output(run)).toContain("In Kiro CLI, exit and start `kiro-cli` again in this folder.");
    expect(output(run)).not.toContain("AIDLC hooks have not run in this project yet");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Only a harness that ships hookActivation gets the not-run-yet warning or
  // Kiro IDE's steps; every other harness keeps the fresh-install advisory.
  for (const harness of ["claude", "kiro", "codex", "cursor", "opencode", "copilot"]) {
    test(`${harness} before any heartbeat keeps the fresh-install advisory with no Kiro IDE advice`, () => {
      const run = runUtility(freshProject(), ["doctor", "--verbose"], {
        AIDLC_HARNESS_NAME: harness,
      });
      const text = output(run);
      expect(text).toContain(
        "ok    Hook heartbeats: not yet fired (first workflow stage will populate)",
      );
      expect(text).not.toContain("AIDLC hooks have not run in this project yet");
      for (const advice of KIRO_IDE_ADVICE) expect(text).not.toContain(advice);
    });
  }

  test("Kiro CLI after workflow progress fails with the generic restart advice", () => {
    const project = projectWithWorkflowProgress();

    const run = runUtility(project, ["doctor", "--verbose"], { AIDLC_HARNESS_NAME: "kiro" });
    expect(run.status).toBe(1);
    expect(output(run)).toContain(
      "verify this harness's hook registration or trust configuration, then fully restart the harness",
    );
    for (const advice of KIRO_IDE_ADVICE) expect(output(run)).not.toContain(advice);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("AIDLC_HOOK_DEBUG-only health data does not create a false failure", () => {
    const project = freshProject();
    const health = join(seededRecordDir(project), ".aidlc-engine/hooks-health");
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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // A record created before heartbeats moved under .aidlc-engine/ keeps them at
  // the legacy path until the next hook fires. The relocated stores that
  // already shipped (sensors, summary authorization, source review) read the
  // legacy name until the new one exists; heartbeats did not, so doctor read an
  // absent directory as "the hooks never ran" on every upgraded project whose
  // workflow was still in flight.
  test("heartbeats written before the engine-dir move are still read", () => {
    const project = projectWithWorkflowProgress();
    const intentsDir = join(project, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
    const legacyHealth = join(intentsDir, active, ".aidlc-hooks-health");
    mkdirSync(legacyHealth, { recursive: true });
    writeFileSync(
      join(legacyHealth, "write-audit-log.last"),
      isoSecond(newestStageOrGateTimestamp(project)),
      "utf-8",
    );

    const run = runUtility(project, ["doctor", "--verbose"]);
    expect(output(run)).not.toContain("Hooks have never executed");
    expect(output(run)).toMatch(/ok {4}Hooks last fired: write-audit-log /);

    // The new location wins as soon as it exists: the legacy path is a read
    // fallback, not a merge.
    const currentHealth = activeHealthDir(project);
    mkdirSync(currentHealth, { recursive: true });
    writeFileSync(
      join(currentHealth, "session-start.last"),
      isoSecond(newestStageOrGateTimestamp(project)),
      "utf-8",
    );
    const afterMove = runUtility(project, ["doctor", "--verbose"]);
    expect(output(afterMove)).toMatch(/ok {4}Hooks last fired: session-start /);
    expect(output(afterMove)).not.toMatch(/Hooks last fired:[^\n]*write-audit-log/);
    expect(output(afterMove)).not.toContain("Hooks have never executed");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
