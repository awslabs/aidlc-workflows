// covers: function:sortAttemptEvents, function:attemptEventIsCrossShardTied,
// function:attemptEventDefinitelyBefore, function:maximalAttemptEvents,
// function:reviewInvalidationAttemptView, function:attemptEventAfterFrontier,
// function:reviewAttemptAccounting, function:worktreeReviewAttemptProjection,
// function:candidateReviewCoverageProjection, function:evaluateGuardRefusal,
// function:requestChangesResetIsExecutable, function:guardRefusalStreakView,
// function:recordGuardRefusal, function:guardRefusalOutput,
// function:guardRecoveryAskForRefusal, function:guardTerminalAskForRefusal,
// function:guardRecoveryAskFromRefusalText, function:guardAttemptState,
// function:humanAuthorityState, function:isRequestChangesChoice,
// function:normalizeGuardRecoveryText, function:consumeSharedDirectiveAsk,
// function:guardRecoveryFeedbackStatus, function:guardPreflight,
// directive:guard-recovery

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { validateDirective } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import {
  type AttemptView,
  type AuditShardEvent,
  artifactFilename,
  attemptEventAfterFrontier,
  attemptEventDefinitelyBefore,
  attemptEventIsCrossShardTied,
  candidateReviewCoverageProjection,
  consumeSharedDirectiveAsk,
  evaluateGuardRefusal,
  findStageBySlug,
  GUARD_REMEDY_OPS,
  GUARD_RECOVERY_ASK_TYPE,
  guardRecoveryAskForRefusal,
  guardRecoveryAskFromRefusalText,
  guardRecoveryFeedbackStatus,
  guardRefusalOutput,
  guardRefusalStreakView,
  guardTerminalAskForRefusal,
  isRequestChangesChoice,
  isTeamUnitOwnership,
  normalizeGuardRecoveryText,
  maximalAttemptEvents,
  recordGuardRefusal,
  readAllAuditShards,
  recoveryGuidance,
  requestChangesResetIsExecutable,
  reviewInvalidationAttemptView,
  reviewAttemptAccounting,
  sortAttemptEvents,
  splitKiroCommandArgs,
  stateDigest,
  teamUnitGateStatus,
  worktreeReviewAttemptProjection,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { guardPreflight } from "../../dist/claude/.claude/tools/aidlc-state.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedAuditFile,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const projects: string[] = [];
const REPO_ROOT = join(import.meta.dir, "..", "..");
const STATE_TOOL = join(
  import.meta.dir,
  "../../dist/claude/.claude/tools/aidlc-state.ts",
);
const PACKAGED_HARNESSES = [
  { name: "claude", engineDir: ".claude" },
  { name: "codex", engineDir: ".codex" },
  { name: "copilot", engineDir: ".aidlc" },
  { name: "cursor", engineDir: ".cursor" },
  { name: "kiro", engineDir: ".kiro" },
  { name: "kiro-ide", engineDir: ".kiro" },
  { name: "opencode", engineDir: ".aidlc" },
] as const;

afterEach(() => {
  while (projects.length > 0) {
    const project = projects.pop()!;
    if (project.includes("aidlc-test-")) cleanupTestProject(project);
    else rmSync(project, { recursive: true, force: true });
  }
});

function state(marker: " " | "-" | "?" | "R" | "x" | "S"): string {
  return [
    "# AI-DLC State",
    "- **Scope**: feature",
    "- **Construction Iteration**: unit-major",
    `- [${marker}] functional-design — EXECUTE`,
    "",
  ].join("\n");
}

function event(
  eventName: string,
  timestamp: string,
  fields: Record<string, string> = {},
  shard = "main.md",
  shardIndex = 0,
  pos = 0,
): AuditShardEvent {
  const block = [
    `**Event**: ${eventName}`,
    `**Timestamp**: ${timestamp}`,
    ...Object.entries(fields).map(([key, value]) => `**${key}**: ${value}`),
  ].join("\n");
  return {
    block,
    event: eventName,
    timestamp,
    shard,
    shardIndex,
    pos,
  };
}

function installPackagedEngine(
  project: string,
  harness: (typeof PACKAGED_HARNESSES)[number],
): void {
  cpSync(
    join(REPO_ROOT, "dist", harness.name, harness.engineDir),
    join(project, harness.engineDir),
    { recursive: true },
  );
}

function runExactCommand(
  project: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof spawnSync> {
  const argv = splitKiroCommandArgs(command);
  if (argv.length === 0) throw new Error("empty command");
  return spawnSync(argv[0], argv.slice(1), {
    cwd: project,
    encoding: "utf-8",
    env,
  });
}

describe("bounded guard-remedy liveness", () => {
  const checkboxStates = [
    [" ", "pending"],
    ["-", "in-progress"],
    ["?", "awaiting-approval"],
    ["R", "revising"],
    ["x", "completed"],
    ["S", "skipped"],
  ] as const;
  const coverage = ["current", "stale", "missing"] as const;
  const recovery = ["available", "pending", "spent"] as const;

  test("every bounded nonterminal refusal advertises an executable remedy", () => {
    let cases = 0;
    for (const [marker, lifecycle] of checkboxStates) {
      for (const summaryCoverage of coverage) {
        for (const reviewCoverage of coverage) {
          for (const recoveryState of recovery) {
            for (const freshTurn of [false, true]) {
              cases++;
              const refusal = evaluateGuardRefusal({
                code: "BOUNDED_TEST",
                blockedAction: "complete",
                stage: "functional-design",
                stateContent: state(marker),
                invariant: "At least one authority-preserving remedy is executable.",
                userMessage: "blocked",
                attempt: {
                  recovery: recoveryState,
                  ...(recoveryState === "pending"
                    ? {
                        pendingReview: {
                          iteration: 2,
                          retryable: true,
                        },
                      }
                    : {}),
                  summaryCoverage,
                  reviewCoverage,
                  sourceCoverage: "current",
                },
                humanAuthority: {
                  freshTurn,
                  unattended: false,
                },
              });
              expect(refusal.state).toBe(lifecycle);
              const executable = refusal.remedies.filter(
                (remedy) => remedy.executableNow,
              );
              expect(executable.length).toBeGreaterThan(0);
              if (summaryCoverage !== "current") {
                expect(
                  executable.filter(
                    (remedy) =>
                      remedy.action.startsWith(
                        "Start the one stale-receipt recovery review",
                      ) ||
                      remedy.action.startsWith(
                        "Request the next permitted review",
                      ),
                  ),
                ).toHaveLength(0);
                expect(
                  executable.filter((remedy) =>
                    remedy.action.includes("--retry-pending")
                  ),
                ).toHaveLength(0);
              }
              for (const remedy of executable) {
                if (remedy.command?.includes("--result rejected")) {
                  expect(["in-progress", "awaiting-approval"]).toContain(
                    lifecycle,
                  );
                  expect(remedy.command).not.toContain("--unit");
                }
                if (remedy.action.startsWith("Start the one stale-receipt")) {
                  expect(recoveryState).toBe("available");
                  expect(reviewCoverage).toBe("stale");
                  expect(summaryCoverage).toBe("current");
                  expect(["in-progress", "awaiting-approval"]).toContain(
                    lifecycle,
                  );
                }
                if (
                  remedy.action.startsWith(
                    "Present the current consolidated summary",
                  )
                ) {
                  expect(summaryCoverage).not.toBe("current");
                  expect(reviewCoverage).not.toBe("current");
                  expect(["in-progress", "awaiting-approval"]).toContain(
                    lifecycle,
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(324);
  });

  test("Request Changes recovery is action-only until exact human feedback exists", () => {
    const refusal = evaluateGuardRefusal({
      code: "SUMMARY_EVIDENCE_INVALID",
      blockedAction: "present-approval-gate",
      stage: "functional-design",
      unit: "alpha",
      stateContent: state("-"),
      invariant: "Rejection feedback comes from the human.",
      userMessage: "blocked",
      attempt: {
        recovery: "spent",
        summaryCoverage: "missing",
        reviewCoverage: "missing",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: true, unattended: false },
      teamGate: {
        resolved: true,
        scope: "per-stage",
        status: "pending",
        gateStage: "functional-design",
      },
    });
    const rejection = refusal.remedies.find((remedy) =>
      remedy.action.includes('Ask "What should change?"')
    );
    expect(rejection).toBeDefined();
    expect(rejection?.action).toContain('stage "functional-design" for Unit "alpha"');
    expect(rejection?.action).toContain("exact text unchanged");
    expect(rejection?.command).toBeUndefined();

    const ask = guardRecoveryAskForRefusal(refusal);
    expect(ask).not.toBeNull();
    expect(validateDirective(ask).valid).toBe(true);
    expect(
      ask?.remedies.some((remedy) =>
        remedy.command?.includes("<requested changes>")
      ),
    ).toBe(false);
  });

  test("guard-recovery validation rejects unresolved or non-packaged commands", () => {
    const base = {
      kind: "ask",
      ask_type: "guard-recovery",
      response_route: "execute-remedy",
      question: "Choose one.",
      stage: "functional-design",
      reason_codes: ["TEST"],
      remedies: [{
        op: "change-scope",
        action: "Change scope.",
        command: "bun .claude/tools/aidlc-orchestrate.ts next --scope <scope>",
        requiresHuman: true,
        executableNow: true,
      }],
    };
    const unresolved = validateDirective(base);
    expect(unresolved.valid).toBe(false);
    if (!unresolved.valid) {
      expect(unresolved.errors.join("\n")).toContain("unresolved placeholders");
    }

    const bare = validateDirective({
      ...base,
      remedies: [{
        ...base.remedies[0],
        command: "aidlc-orchestrate.ts next --stage functional-design",
      }],
    });
    expect(bare.valid).toBe(false);
    if (!bare.valid) {
      expect(bare.errors.join("\n")).toContain(
        "bun-qualified packaged AIDLC tool invocation",
      );
    }

    expect(validateDirective({
      ...base,
      remedies: [{
        ...base.remedies[0],
        command:
          "bun .ported.harness/tools/aidlc-orchestrate.ts next --stage functional-design",
      }],
    }).valid).toBe(true);
  });

  test("restart remedies execute through every packaged harness", () => {
    for (const harness of PACKAGED_HARNESSES) {
      const project = createTestProject();
      projects.push(project);
      seedAidlcMemory(project);
      seedStateFile(project, "state-mid-inception.md");
      installPackagedEngine(project, harness);

      const priorHarness = process.env.AIDLC_HARNESS_DIR;
      process.env.AIDLC_HARNESS_DIR = harness.engineDir;
      let command: string | undefined;
      try {
        const refusal = evaluateGuardRefusal({
          code: "RESTART_TEST",
          blockedAction: "complete",
          stage: "requirements-analysis",
          stateContent:
            "# State\n- [ ] requirements-analysis — EXECUTE\n",
          invariant: "Restart commands are directly executable.",
          userMessage: "blocked",
          attempt: {
            recovery: "spent",
            summaryCoverage: "current",
            reviewCoverage: "current",
            sourceCoverage: "current",
          },
          humanAuthority: { freshTurn: false, unattended: false },
        });
        command = refusal.remedies.find((remedy) => remedy.command)?.command;
        expect(validateDirective(guardRecoveryAskForRefusal(refusal)).valid)
          .toBe(true);
      } finally {
        if (priorHarness === undefined) delete process.env.AIDLC_HARNESS_DIR;
        else process.env.AIDLC_HARNESS_DIR = priorHarness;
      }

      expect(command, harness.name).toBe(
        `bun ${harness.engineDir}/tools/aidlc-orchestrate.ts next --stage requirements-analysis`,
      );
      expect(command).not.toContain("<");
      const run = runExactCommand(project, command!, {
        ...process.env,
        AIDLC_HARNESS_DIR: harness.engineDir,
      });
      expect(
        run.status,
        `${harness.name}\n${run.stdout ?? ""}\n${run.stderr ?? ""}`,
      ).toBe(0);
      const directive = JSON.parse(String(run.stdout ?? "").trim()) as {
        kind?: string;
      };
      expect(["print", "run-stage"]).toContain(directive.kind ?? "");
    }
  }, 60000);

  test("autonomous Bolt recovery executes the packaged abort-and-discard command", () => {
    const project = createTestProject();
    projects.push(project);
    seedAidlcMemory(project);
    seedStateFile(project, join(FIXTURES_DIR, "state-construction.md"));
    seedAuditFile(project);
    installPackagedEngine(project, {
      name: "claude",
      engineDir: ".claude",
    });
    // The worktree primitive binds the base commit's application source, so the
    // fixture needs at least one source file outside the framework trees.
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "base.ts"), "export const base = 1;\n");

    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "t@test"],
      ["config", "user.name", "t"],
      ["add", "-A"],
      ["commit", "-qm", "fixture"],
    ]) {
      const git = spawnSync("git", args, { cwd: project, encoding: "utf-8" });
      expect(
        git.status,
        `${args.join(" ")}\n${git.stdout ?? ""}\n${git.stderr ?? ""}`,
      ).toBe(0);
    }
    const create = spawnSync(
      process.execPath,
      [
        join(project, ".claude", "tools", "aidlc-worktree.ts"),
        "create",
        "--slug",
        "alpha",
        "--base",
        "main",
      ],
      { cwd: project, encoding: "utf-8" },
    );
    expect(
      create.status,
      `${create.stdout ?? ""}\n${create.stderr ?? ""}`,
    ).toBe(0);

    const priorHarness = process.env.AIDLC_HARNESS_DIR;
    process.env.AIDLC_HARNESS_DIR = ".claude";
    let command: string | undefined;
    try {
      const refusal = evaluateGuardRefusal({
        code: "AUTONOMOUS_RECOVERY_TEST",
        blockedAction: "review",
        stage: "code-generation",
        unit: "alpha",
        stateContent: state("-"),
        invariant: "Autonomous recovery aborts the old attempt.",
        userMessage: "blocked",
        attempt: {
          recovery: "spent",
          summaryCoverage: "current",
          reviewCoverage: "stale",
          sourceCoverage: "current",
        },
        humanAuthority: { freshTurn: true, unattended: false },
        autonomousBolt: { unit: "alpha", slug: "alpha", batch: "1" },
      });
      command = refusal.remedies[0]?.command;
      expect(validateDirective(guardRecoveryAskForRefusal(refusal)).valid)
        .toBe(true);
    } finally {
      if (priorHarness === undefined) delete process.env.AIDLC_HARNESS_DIR;
      else process.env.AIDLC_HARNESS_DIR = priorHarness;
    }
    expect(command).toContain("bun .claude/tools/aidlc-bolt.ts abort");
    expect(command).not.toContain("<");

    const aborted = runExactCommand(project, command!);
    expect(
      aborted.status,
      `${aborted.stdout ?? ""}\n${aborted.stderr ?? ""}`,
    ).toBe(0);
    expect(aborted.stdout).toContain('"emitted":"BOLT_FAILED"');
    expect(
      existsSync(join(project, ".aidlc", "worktrees", "bolt-alpha")),
    ).toBe(false);
    expect(readAllAuditShards(project)).toContain("**Reason**: aborted");
  }, 60000);

  test("team gates use unit lifecycle instead of the global checkbox", () => {
    const pending = evaluateGuardRefusal({
      code: "TEAM_TEST",
      blockedAction: "review",
      stage: "functional-design",
      unit: "alpha",
      stateContent: state("x"),
      invariant: "Team gate authority follows its unit ledger.",
      userMessage: "blocked",
      attempt: {
        recovery: "spent",
        summaryCoverage: "current",
        reviewCoverage: "stale",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: false, unattended: false },
      teamGate: {
        resolved: true,
        scope: "per-stage",
        status: "pending",
        gateStage: "functional-design",
      },
    });
    expect(pending.state).toBe("in-progress");
    const pendingRejection = pending.remedies.find((remedy) =>
      remedy.action.includes('Ask "What should change?"')
    );
    expect(pendingRejection?.action).toContain(
      'stage "functional-design" for Unit "alpha"',
    );
    expect(pendingRejection?.command).toBeUndefined();
    expect(guardRecoveryAskForRefusal(pending)).toMatchObject({
      kind: "ask",
      ask_type: "guard-recovery",
      reason_codes: ["TEAM_TEST"],
    });

    const revising = evaluateGuardRefusal({
      ...pending,
      stateContent: state("-"),
      teamGate: {
        resolved: true,
        scope: "per-stage",
        status: "revising",
        gateStage: "functional-design",
      },
      attempt: {
        recovery: "spent",
        summaryCoverage: "current",
        reviewCoverage: "stale",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: false, unattended: false },
    });
    expect(revising.state).toBe("revising");
    expect(
      revising.remedies.some((remedy) =>
        remedy.command?.includes("--result rejected")
      ),
    ).toBe(false);
  });

  test("repair-required progress exposes only the admission-gated next iteration remedy", () => {
    const cases = [
      { marker: "-" as const, summary: "current" as const, executable: true },
      { marker: "?" as const, summary: "current" as const, executable: true },
      { marker: "-" as const, summary: "stale" as const, executable: false },
      { marker: "-" as const, summary: "missing" as const, executable: false },
      { marker: "x" as const, summary: "current" as const, executable: false },
      { marker: " " as const, summary: "current" as const, executable: false },
    ];
    for (const fixture of cases) {
      const refusal = evaluateGuardRefusal({
        code: "REPAIR_REQUIRED_TEST",
        blockedAction: "present-approval-gate",
        stage: "functional-design",
        stateContent: state(fixture.marker),
        invariant: "Completed review findings are repaired before the next pass.",
        userMessage: "blocked",
        attempt: {
          recovery: "available",
          repairReview: { iteration: 1 },
          summaryCoverage: fixture.summary,
          reviewCoverage: "missing",
          sourceCoverage: "current",
        },
        humanAuthority: { freshTurn: false, unattended: false },
      });
      const repair = refusal.remedies.find((remedy) =>
        remedy.action.includes("Apply the reviewer's requested repairs")
      );
      expect(repair?.action).toContain("review iteration 2");
      expect(repair?.executableNow).toBe(fixture.executable);
      expect(
        refusal.remedies.some((remedy) =>
          remedy.action.includes("Record the verdict for pending review") ||
          remedy.action.includes("--retry-pending")
        ),
      ).toBe(false);
      expect(
        refusal.remedies.some((remedy) =>
          remedy.action === "Request the next permitted review for the current attempt."
        ),
      ).toBe(false);
    }
  });

  test("outstanding progress requests its stored next iteration and has a distinct signature", () => {
    const cases = [
      { marker: "-" as const, summary: "current" as const, executable: true },
      { marker: "?" as const, summary: "current" as const, executable: true },
      { marker: "-" as const, summary: "stale" as const, executable: false },
      { marker: "-" as const, summary: "missing" as const, executable: false },
      { marker: "x" as const, summary: "current" as const, executable: false },
      { marker: " " as const, summary: "current" as const, executable: false },
    ];
    for (const fixture of cases) {
      const refusal = evaluateGuardRefusal({
        code: "OUTSTANDING_TEST",
        blockedAction: "present-approval-gate",
        stage: "functional-design",
        stateContent: state(fixture.marker),
        invariant: "Changed post-verdict bytes receive the next review iteration.",
        userMessage: "blocked",
        attempt: {
          recovery: "available",
          nextReview: { iteration: 2 },
          summaryCoverage: fixture.summary,
          reviewCoverage: "missing",
          sourceCoverage: "current",
        },
        humanAuthority: { freshTurn: false, unattended: false },
      });
      const next = refusal.remedies.find((remedy) =>
        remedy.action.includes("Request review iteration 2")
      );
      expect(next?.action).toContain("current artifact and source bytes");
      expect(next?.executableNow).toBe(fixture.executable);
      expect(
        refusal.remedies.some((remedy) =>
          remedy.action.includes("Record the verdict for pending review") ||
          remedy.action.includes("--retry-pending")
        ),
      ).toBe(false);
      expect(
        refusal.remedies.some((remedy) =>
          remedy.action === "Request the next permitted review for the current attempt."
        ),
      ).toBe(false);
    }

    const project = mkdtempSync(join(tmpdir(), "aidlc-guard-liveness-"));
    projects.push(project);
    const base = {
      floor: "progress-floor",
      recovery: "available" as const,
      summaryCoverage: "current" as const,
      reviewCoverage: "missing" as const,
      sourceCoverage: "current" as const,
    };
    const input = {
      code: "PROGRESS_SIGNATURE_TEST",
      blockedAction: "present-approval-gate",
      stage: "functional-design",
      stateContent: state("-"),
      invariant: "Distinct review progress receives a distinct streak signature.",
      userMessage: "blocked",
      humanAuthority: { freshTurn: false, unattended: false },
    };
    const pendingAttempt = {
      ...base,
      pendingReview: { iteration: 1, retryable: true },
    };
    const repairAttempt = {
      ...base,
      repairReview: { iteration: 1 },
    };
    const nextAttempt = {
      ...base,
      nextReview: { iteration: 2 },
    };
    expect(
      recordGuardRefusal(
        project,
        evaluateGuardRefusal({ ...input, attempt: pendingAttempt }),
        pendingAttempt,
      ).count,
    ).toBe(1);
    expect(
      recordGuardRefusal(
        project,
        evaluateGuardRefusal({ ...input, attempt: repairAttempt }),
        repairAttempt,
      ).count,
    ).toBe(1);
    expect(
      recordGuardRefusal(
        project,
        evaluateGuardRefusal({ ...input, attempt: nextAttempt }),
        nextAttempt,
      ).count,
    ).toBe(1);
    expect(
      recordGuardRefusal(
        project,
        evaluateGuardRefusal({ ...input, attempt: nextAttempt }),
        nextAttempt,
      ).count,
    ).toBe(2);
  });

  test("unit-end remedies use the final gate anchor and unresolved anchors cannot reject", () => {
    const project = mkdtempSync(join(tmpdir(), "aidlc-guard-liveness-"));
    projects.push(project);
    const unitEndState = [
      state("-").trimEnd(),
      "- **Unit Ownership**: team",
      "- **Unit Gate Rhythm**: unit-end",
      "- [ ] nfr-requirements — EXECUTE",
      "- [ ] nfr-design — EXECUTE",
      "- [ ] infrastructure-design — EXECUTE",
      "- [ ] code-generation — EXECUTE",
      "",
    ].join("\n");
    const resolved = teamUnitGateStatus(
      project,
      unitEndState,
      "functional-design",
      "alpha",
    );
    expect(resolved).toEqual({
      resolved: true,
      scope: "unit-end",
      status: "pending",
      gateStage: "code-generation",
    });
    const refusal = evaluateGuardRefusal({
      code: "UNIT_END_TEST",
      blockedAction: "artifact-write",
      stage: "functional-design",
      unit: "alpha",
      stateContent: unitEndState,
      invariant: "Unit-end remedies target the chain gate.",
      userMessage: "blocked",
      attempt: {
        recovery: "spent",
        summaryCoverage: "current",
        reviewCoverage: "current",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: false, unattended: false },
      teamGate: resolved,
    });
    expect(refusal.stage).toBe("functional-design");
    const rejection = refusal.remedies.find((remedy) =>
      remedy.action.includes('Ask "What should change?"')
    );
    expect(rejection?.action).toContain(
      'stage "code-generation" for Unit "alpha"',
    );
    expect(rejection?.command).toBeUndefined();

    const unresolvedState = unitEndState.replace(
      /— EXECUTE/g,
      "— SKIP: fixture",
    );
    const unresolved = teamUnitGateStatus(
      project,
      unresolvedState,
      "functional-design",
      "alpha",
    );
    expect(unresolved).toEqual({
      resolved: false,
      scope: "unit-end",
      reason: "no-active-gate-stage",
    });
    const blocked = evaluateGuardRefusal({
      ...refusal,
      stateContent: unresolvedState,
      attempt: {
        recovery: "spent",
        summaryCoverage: "current",
        reviewCoverage: "current",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: false, unattended: false },
      teamGate: unresolved,
    });
    expect(
      blocked.remedies.some((remedy) =>
        remedy.command?.includes("--result rejected")
      ),
    ).toBe(false);
    const unresolvedAsk = guardRecoveryAskForRefusal(blocked);
    expect(
      unresolvedAsk?.remedies.some((remedy) =>
        remedy.command?.includes("--result rejected")
      ),
    ).toBe(false);
    expect(unresolvedAsk?.remedies.some((remedy) => remedy.command !== undefined))
      .toBe(false);
    const unresolvedText = unresolvedAsk?.remedies
      .map((remedy) => remedy.action)
      .join(" ") ?? "";
    expect(unresolvedText).toContain("no-active-gate-stage");
    expect(unresolvedText).toContain("valid Scope");
    expect(unresolvedText).not.toContain("Restart this stage");
    const guidance = recoveryGuidance(
      project,
      unresolvedState,
      "functional-design",
      { unit: "alpha", teamGate: unresolved },
    );
    expect(guidance).toContain("no-active-gate-stage");
    expect(guidance).toContain("valid Scope");
    expect(guidance).not.toContain("Restart this stage");

    const invalidScopeState = unitEndState.replace(
      "- **Scope**: feature",
      "- **Scope**: invalid-scope",
    );
    const invalidScope = teamUnitGateStatus(
      project,
      invalidScopeState,
      "functional-design",
      "alpha",
    );
    expect(invalidScope).toEqual({
      resolved: false,
      scope: "unit-end",
      reason: "no-active-gate-stage",
    });
    const invalidBlocked = evaluateGuardRefusal({
      ...refusal,
      stateContent: invalidScopeState,
      attempt: {
        recovery: "spent",
        summaryCoverage: "current",
        reviewCoverage: "current",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: false, unattended: false },
      teamGate: invalidScope,
    });
    const invalidAsk = guardRecoveryAskForRefusal(invalidBlocked);
    const invalidText = invalidAsk?.remedies
      .map((remedy) => remedy.action)
      .join(" ") ?? "";
    expect(invalidText).toContain("no-active-gate-stage");
    expect(invalidText).toContain("valid Scope");
    expect(
      invalidAsk?.remedies.some((remedy) =>
        remedy.command?.includes("--result rejected") ||
        remedy.command?.includes("next --stage functional-design")
      ),
    ).toBe(false);
    expect(
      recoveryGuidance(
        project,
        invalidScopeState,
        "functional-design",
        { unit: "alpha", teamGate: invalidScope },
      ),
    ).not.toContain("Restart this stage");
  });

  test("unbindable completed source names boundary repair, not source revert", () => {
    const refusal = evaluateGuardRefusal({
      code: "SOURCE_BOUNDARY_UNBINDABLE",
      blockedAction: "complete",
      stage: "functional-design",
      stateContent: state("x"),
      invariant: "Reviewed source has a bindable boundary.",
      userMessage: "blocked",
      attempt: {
        recovery: "spent",
        summaryCoverage: "current",
        reviewCoverage: "stale",
        sourceCoverage: "unbindable",
      },
      humanAuthority: { freshTurn: false, unattended: false },
    });
    const text = refusal.remedies.map((remedy) => remedy.action).join(" ");
    expect(text).toContain(".aidlc-source-paths.json");
    expect(text).not.toContain("restore the reviewed source state");
  });
});

describe("AttemptView projections and refusal streaks", () => {
  test("preflight and enforcement share refusal codes across blocked states without preflight writes", () => {
    const scenarios = [
      {
        name: "required artifacts missing",
        expectedCode: "REQUIRED_ARTIFACTS_MISSING",
        setup: (_project: string, _outputDir: string): void => {},
        setEnv: {
          AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
          AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
        },
        clearEnv: ["AIDLC_SKIP_ARTIFACT_GUARD"],
      },
      {
        name: "summary confirmation missing",
        expectedCode: "SUMMARY_EVIDENCE_INVALID",
        setup: (_project: string, outputDir: string): void => {
          writeFileSync(
            join(outputDir, "requirements-analysis-questions.md"),
            [
              "# Requirements Questions",
              "",
              "## Consolidated Summary Confirmation",
              "",
              "- Looks correct",
              "- Request changes",
              "",
              "[Answer]:",
              "",
            ].join("\n"),
            "utf-8",
          );
        },
        setEnv: {
          AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
        },
        clearEnv: [
          "AIDLC_SKIP_ARTIFACT_GUARD",
          "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
        ],
      },
      {
        name: "review evidence missing",
        expectedCode: "REVIEW_EVIDENCE_MISSING",
        setup: (_project: string, _outputDir: string): void => {},
        setEnv: {
          AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
        },
        clearEnv: [
          "AIDLC_SKIP_ARTIFACT_GUARD",
          "AIDLC_SKIP_REVIEWER_GATE_GUARD",
        ],
      },
    ] as const;

    for (const scenario of scenarios) {
      const project = createTestProject();
      projects.push(project);
      seedAidlcMemory(project);
      seedStateFile(project, "state-mid-inception.md");
      const stage = findStageBySlug("requirements-analysis")!;
      const outputDir = join(
        seededRecordDir(project),
        stage.phase,
        stage.slug,
      );
      mkdirSync(outputDir, { recursive: true });
      if (scenario.expectedCode !== "REQUIRED_ARTIFACTS_MISSING") {
        for (const name of stage.produces ?? []) {
          writeFileSync(
            join(outputDir, artifactFilename(name)),
            `# ${name}\n`,
            "utf-8",
          );
        }
      }
      scenario.setup(project, outputDir);

      const stateBefore = readFileSync(seededStateFile(project), "utf-8");
      const auditBefore = readAllAuditShards(project);
      const streakDir = join(
        seededRecordDir(project),
        ".aidlc-guard-refusals",
      );
      const previous = new Map<string, string | undefined>();
      for (const name of [
        ...Object.keys(scenario.setEnv),
        ...scenario.clearEnv,
      ]) {
        previous.set(name, process.env[name]);
      }
      for (const [name, value] of Object.entries(scenario.setEnv)) {
        process.env[name] = value;
      }
      for (const name of scenario.clearEnv) delete process.env[name];
      let preflight: ReturnType<typeof guardPreflight>;
      try {
        preflight = guardPreflight(project, stateBefore, stage, {
          action: "present-approval-gate",
        });
      } finally {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }

      expect(preflight.executable, scenario.name).toBe(false);
      if (preflight.executable) throw new Error("expected refusal");
      expect(preflight.refusal.code, scenario.name).toBe(
        scenario.expectedCode,
      );
      expect(readFileSync(seededStateFile(project), "utf-8")).toBe(
        stateBefore,
      );
      expect(readAllAuditShards(project)).toBe(auditBefore);
      expect(existsSync(streakDir)).toBe(false);

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...scenario.setEnv,
        AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      };
      for (const name of scenario.clearEnv) delete childEnv[name];
      const attempted = spawnSync(
        process.execPath,
        [
          STATE_TOOL,
          "gate-start",
          "requirements-analysis",
          "--project-dir",
          project,
        ],
        { encoding: "utf-8", env: childEnv },
      );
      expect(attempted.status, scenario.name).not.toBe(0);
      const records = readdirSync(streakDir).filter((name) =>
        name.endsWith(".json")
      );
      expect(records, scenario.name).toHaveLength(1);
      const recorded = JSON.parse(
        readFileSync(join(streakDir, records[0]), "utf-8"),
      ) as { refusal: { code: string } };
      expect(recorded.refusal.code, scenario.name).toBe(
        preflight.refusal.code,
      );
      expect(readFileSync(seededStateFile(project), "utf-8")).toBe(
        stateBefore,
      );
      expect(readAllAuditShards(project)).not.toContain(
        "**Event**: STAGE_AWAITING_APPROVAL",
      );
    }
  });

  test("team pipeline revise preflight and enforcement refuse the same plugin-shaped stage", () => {
    const project = createTestProject();
    projects.push(project);
    seedAidlcMemory(project);
    seedBoltDag(project, ["alpha"]);
    const slug = "test-pro-pipeline-unit";
    const stateContent = [
      "# AI-DLC State",
      "- **Scope**: feature",
      "- **State Version**: 8",
      "- **Unit Ownership**: team",
      "- **Unit Gate Rhythm**: per-stage",
      "- **Construction Iteration**: stage-major",
      "- **Lifecycle Phase**: CONSTRUCTION",
      `- **Current Stage**: ${slug}`,
      "- **Status**: Running",
      `- [R] ${slug} — EXECUTE`,
      "",
    ].join("\n");
    writeFileSync(seededStateFile(project), stateContent);
    appendAuditEntry(
      "GATE_REJECTED",
      {
        Stage: slug,
        Unit: "alpha",
        "Gate Scope": "per-stage",
        Feedback: "repair",
      },
      project,
    );

    const liveGraph = JSON.parse(
      readFileSync(join(AIDLC_SRC, "tools", "data", "stage-graph.json"), "utf-8"),
    ) as Array<Record<string, unknown>>;
    const template = liveGraph.find((entry) =>
      entry.slug === "functional-design"
    );
    if (!template) throw new Error("functional-design graph row missing");
    const typedTemplate = findStageBySlug("functional-design");
    if (!typedTemplate) throw new Error("typed functional-design row missing");
    const graphPath = join(project, "plugin-stage-graph.json");
    writeFileSync(
      graphPath,
      `${JSON.stringify([
        ...liveGraph,
        {
          ...template,
          slug,
          number: "3.7p",
          name: "Plugin Pipeline Unit",
          plugin: "test-pro",
          mode: "pipeline",
          support_agents: ["aidlc-quality-agent"],
          produces: [],
          optional_produces: [],
          reviewer: undefined,
          review_artifact: undefined,
        },
      ], null, 2)}\n`,
    );

    const priorDisable = process.env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
    delete process.env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
    let preflight: ReturnType<typeof guardPreflight>;
    try {
      const stage = {
        ...typedTemplate,
        slug,
        number: "3.7p",
        name: "Plugin Pipeline Unit",
        plugin: "test-pro",
        mode: "pipeline" as const,
        support_agents: ["aidlc-quality-agent"],
        produces: [],
        optional_produces: [],
        reviewer: undefined,
        review_artifact: undefined,
      };
      preflight = guardPreflight(project, stateContent, stage, {
        action: "revise",
        unit: "alpha",
      });
    } finally {
      if (priorDisable === undefined) {
        delete process.env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
      } else {
        process.env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE = priorDisable;
      }
    }
    expect(preflight.executable).toBe(false);
    if (preflight.executable) throw new Error("expected preflight refusal");
    expect(preflight.refusal.code).toBe("PIPELINE_EVIDENCE_MISSING");

    const attempted = spawnSync(
      process.execPath,
      [
        STATE_TOOL,
        "revise",
        slug,
        "--unit",
        "alpha",
        "--project-dir",
        project,
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
          AIDLC_STAGE_GRAPH: graphPath,
          AIDLC_DISABLE_ENSEMBLE_EVIDENCE: undefined,
        },
      },
    );
    expect(attempted.status).not.toBe(0);
    const guardDir = join(
      seededRecordDir(project),
      ".aidlc-guard-refusals",
    );
    const recordName = readdirSync(guardDir).find((name) =>
      name.endsWith(".json")
    );
    if (!recordName) throw new Error("guard refusal record missing");
    const recorded = JSON.parse(
      readFileSync(join(guardDir, recordName), "utf-8"),
    ) as { refusal: { code: string } };
    expect(recorded.refusal.code).toBe(preflight.refusal.code);
    expect(readAllAuditShards(project)).not.toContain(
      "**Event**: STAGE_AWAITING_APPROVAL",
    );
  });

  test("shared ordering and partial-order frontier helpers preserve shard causality", () => {
    const a = event("WORKFLOW_STARTED", "2026-08-28T00:00:00Z", {}, "a.md", 0);
    const b = event("STAGE_JUMPED", "2026-08-28T00:00:00Z", {}, "b.md", 1);
    const c = event(
      "REVIEW_REQUESTED",
      "2026-08-28T00:00:01Z",
      {},
      "a.md",
      0,
      1,
    );
    const ordered = sortAttemptEvents([c, b, a]);
    expect(ordered).toEqual([a, b, c]);
    expect(attemptEventIsCrossShardTied(ordered, 0)).toBe(true);
    expect(attemptEventDefinitelyBefore(a, c)).toBe(true);
    expect(attemptEventDefinitelyBefore(a, b)).toBe(false);
    expect(maximalAttemptEvents([a, b])).toEqual([a, b]);
    const invalidation = reviewInvalidationAttemptView(
      [c, b, a],
      "functional-design",
    );
    expect(invalidation.floor).toEqual([a, b]);
    expect(attemptEventAfterFrontier(invalidation.floor, c)).toBe(true);
  });

  test("review accounting uses the explicit Bolt floor projection", () => {
    const rows = [
      event("WORKFLOW_STARTED", "2026-08-28T00:00:00Z"),
      event(
        "BOLT_STARTED",
        "2026-08-28T00:00:01Z",
        {
          "Bolt names": "alpha",
          "Bolt slug": "alpha",
          "Batch number": "1",
        },
        "unit.md",
        1,
      ),
    ];
    const view: AttemptView = {
      allEvents: rows,
      events: rows,
      floorIdx: 0,
      mergedBoltUnits: new Set(),
      openBoltUnits: new Set(["alpha"]),
    };
    const accounting = reviewAttemptAccounting(
      view,
      state("-"),
      { slug: "functional-design", for_each: "unit-of-work" },
      "reviewer",
      "alpha",
      undefined,
    );
    expect(accounting.boltStarted).toBe(true);
    expect(accounting.floor).toContain("BOLT_STARTED");
  });

  test("worktree review projection owns the Bolt boundary event set", () => {
    const projection = worktreeReviewAttemptProjection(
      [
        event(
          "BOLT_STARTED",
          "2026-08-28T00:00:00Z",
          { "Bolt slug": "alpha", "Bolt names": "alpha" },
        ),
        event("ARTIFACT_UPDATED", "2026-08-28T00:00:01Z"),
      ],
      {
        boltSlug: "alpha",
        unit: "alpha",
        stage: "functional-design",
        reviewer: "reviewer",
        reviewClass: "adversarial",
        maxIterations: 2,
      },
    );
    expect(projection.boltStart?.event).toBe("BOLT_STARTED");
    expect(projection.events.map((row) => row.event)).toEqual([
      "BOLT_STARTED",
    ]);
    expect(projection.terminal).toBeNull();
  });

  test("team tie flooring permits a fresh later review attempt", () => {
    const rows = [
      event(
        "WORKFLOW_STARTED",
        "2026-08-28T00:00:00Z",
        {},
        "main.md",
        0,
      ),
      event(
        "REVIEW_REQUESTED",
        "2026-08-28T00:00:00Z",
        {
          Stage: "functional-design",
          Reviewer: "reviewer",
          Unit: "alpha",
          Iteration: "1",
          "Artifact Fingerprint": `sha256:${"a".repeat(64)}`,
        },
        "unit.md",
        1,
      ),
      event(
        "GATE_REJECTED",
        "2026-08-28T00:00:01Z",
        { Stage: "functional-design", Unit: "alpha" },
        "main.md",
        0,
        1,
      ),
      event(
        "REVIEW_REQUESTED",
        "2026-08-28T00:00:02Z",
        {
          Stage: "functional-design",
          Reviewer: "reviewer",
          Unit: "alpha",
          Iteration: "1",
          "Artifact Fingerprint": `sha256:${"b".repeat(64)}`,
        },
        "unit.md",
        1,
        1,
      ),
    ];
    const view: AttemptView = {
      allEvents: rows,
      events: rows,
      floorIdx: 2,
      mergedBoltUnits: new Set(),
      openBoltUnits: new Set(),
    };
    const teamState = `${state("-")}- **Unit Ownership**: team\n`;
    const accounting = reviewAttemptAccounting(
      view,
      teamState,
      { slug: "functional-design", for_each: "unit-of-work" },
      "reviewer",
      "alpha",
      undefined,
    );
    expect(accounting.ambiguity).toBeNull();
    expect(accounting.requestCount).toBe(1);
    expect(accounting.pendingIterations).toEqual(new Set([1]));
    const refusal = evaluateGuardRefusal({
      code: "REVIEW_VERDICT_PENDING",
      blockedAction: "review-request",
      stage: "functional-design",
      unit: "alpha",
      stateContent: teamState,
      invariant: "A later untied attempt remains reviewable.",
      userMessage: "blocked",
      attempt: {
        floor: accounting.floor,
        recovery: "available",
        pendingReview: { iteration: 1, retryable: true },
        summaryCoverage: "current",
        reviewCoverage: "missing",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: false, unattended: false },
      teamGate: {
        resolved: true,
        scope: "per-stage",
        status: "pending",
        gateStage: "functional-design",
      },
    });
    expect(
      refusal.remedies.some(
        (remedy) =>
          remedy.executableNow && remedy.action.includes("--retry-pending"),
      ),
    ).toBe(true);
  });

  test("candidate coverage fails closed on a cross-shard tie", () => {
    const request = event(
      "REVIEW_REQUESTED",
      "2026-08-28T00:00:01Z",
      {
        Stage: "functional-design",
        Unit: "alpha",
        "Attempt Generation": "1",
        Reviewer: "reviewer",
        Iteration: "1",
      },
      "a.md",
      0,
    );
    const completion = event(
      "REVIEW_COMPLETED",
      "2026-08-28T00:00:02Z",
      {
        Stage: "functional-design",
        Unit: "alpha",
        "Attempt Generation": "1",
        Reviewer: "reviewer",
        Iteration: "1",
        Verdict: "READY",
        "Artifact Fingerprint": "sha256:expected",
      },
      "a.md",
      0,
      1,
    );
    expect(
      candidateReviewCoverageProjection([request, completion], {
        unit: "alpha",
        generation: 1,
        stage: "functional-design",
        reviewer: "reviewer",
        artifactPrefix: "construction/alpha/functional-design/",
        expectedFingerprint: "sha256:expected",
      }),
    ).toBe(true);
    expect(
      candidateReviewCoverageProjection(
        [
          request,
          completion,
          event(
            "ARTIFACT_UPDATED",
            "2026-08-28T00:00:02Z",
            {
              File:
                "aidlc/construction/alpha/functional-design/functional-design.md",
            },
            "b.md",
            1,
          ),
        ],
        {
          unit: "alpha",
          generation: 1,
          stage: "functional-design",
          reviewer: "reviewer",
          artifactPrefix: "construction/alpha/functional-design/",
          expectedFingerprint: "sha256:expected",
        },
      ),
    ).toBe(false);
  });

  test("alternating refusal codes share one capped guard-state signature", () => {
    const project = mkdtempSync(join(tmpdir(), "aidlc-guard-liveness-"));
    projects.push(project);
    const attempt = {
      floor: "floor-1",
      recovery: "spent" as const,
      summaryCoverage: "stale" as const,
      reviewCoverage: "current" as const,
      sourceCoverage: "current" as const,
    };
    const refusalA = evaluateGuardRefusal({
      code: "SUMMARY_EVIDENCE_INVALID",
      blockedAction: "gate-start",
      stage: "functional-design",
      stateContent: state("-"),
      invariant: "Summary authorization is current.",
      userMessage: "summary blocked",
      attempt,
      humanAuthority: { freshTurn: false, unattended: false },
    });
    const refusalB = evaluateGuardRefusal({
      ...refusalA,
      code: "REVIEW_FREEZE_ACTIVE",
      blockedAction: "artifact-write",
      userMessage: "write blocked",
      stateContent: state("-"),
      attempt,
      humanAuthority: { freshTurn: false, unattended: false },
    });

    // A refusal is a question on its first occurrence at both sites; the streak
    // only changes the question's framing and the code list once it repeats.
    const first = recordGuardRefusal(project, refusalA, attempt);
    expect(first.count).toBe(1);
    expect(first.ask.reason_codes).toEqual(["SUMMARY_EVIDENCE_INVALID"]);
    expect(first.ask.question).toContain("would be refused");
    expect(recordGuardRefusal(project, refusalB, attempt).count).toBe(1);
    expect(recordGuardRefusal(project, refusalA, attempt).count).toBe(2);
    const capped = recordGuardRefusal(project, refusalB, attempt);
    expect(capped.count).toBe(3);
    expect(capped.ask.question).toContain("has refused artifact-write 3 times");
    expect(capped.ask.reason_codes).toEqual([
      "REVIEW_FREEZE_ACTIVE",
      "SUMMARY_EVIDENCE_INVALID",
    ]);
    expect(capped.ask.remedies.length).toBeGreaterThan(0);
    expect(capped.ask.state_signature).toBeUndefined();
    expect(validateDirective(capped.ask).valid).toBe(true);
    expect(requestChangesResetIsExecutable(state("-"), "functional-design"))
      .toBe(true);
    expect(requestChangesResetIsExecutable(state("x"), "functional-design"))
      .toBe(false);

    appendAuditEntry("SESSION_RESUMED", { Source: "test" }, project);
    const sessionReset = recordGuardRefusal(project, refusalA, attempt);
    expect(sessionReset.count).toBe(1);
    expect(sessionReset.signature).not.toBe(capped.signature);

    const changed = recordGuardRefusal(project, refusalA, {
      ...attempt,
      sourceCoverage: "stale",
    });
    expect(changed.count).toBe(1);

    // The enforcing tool prints the human sentence, then the same ask as its
    // last line, so the router can parse it back into the directive it would
    // have emitted itself. The observer's view of the streak is what the next
    // record would be, and reading it twice writes nothing.
    const output = guardRefusalOutput(project, refusalA, attempt);
    expect(output.startsWith("summary blocked\n")).toBe(true);
    const parsed = guardRecoveryAskFromRefusalText(output);
    expect(parsed?.ask_type).toBe("guard-recovery");
    expect(validateDirective(parsed).valid).toBe(true);
    const view = guardRefusalStreakView(project, refusalA, attempt);
    expect(view.count).toBe(2);
    expect(guardRefusalStreakView(project, refusalA, attempt).count).toBe(2);
  });

  test("a refusal with no executable remedy is a terminal ask, never an error and never a silent count", () => {
    const project = mkdtempSync(join(tmpdir(), "aidlc-guard-liveness-"));
    projects.push(project);
    // A completed stage under a team gate that cannot be resolved has no lifecycle
    // reset the evaluator can offer once the Scope remedy is excluded, so force
    // the zero-exit shape directly: every remedy filtered out as not executable.
    const attempt = {
      floor: "floor-terminal",
      recovery: "spent" as const,
      summaryCoverage: "current" as const,
      reviewCoverage: "stale" as const,
      sourceCoverage: "stale" as const,
    };
    const evaluated = evaluateGuardRefusal({
      code: "REVIEW_RECOVERY_SPENT",
      blockedAction: "review-request",
      stage: "functional-design",
      stateContent: state("-"),
      invariant: "The stale-receipt recovery slot is single-use within an attempt.",
      userMessage: "recovery spent",
      attempt,
      humanAuthority: { freshTurn: false, unattended: false },
    });
    const zeroExit = {
      ...evaluated,
      remedies: evaluated.remedies.map((remedy) => ({
        ...remedy,
        executableNow: false,
      })),
    };
    expect(guardRecoveryAskForRefusal(zeroExit)).toBeNull();

    const first = recordGuardRefusal(project, zeroExit, attempt);
    expect(first.ask.remedies).toEqual([]);
    expect(first.ask.state_signature).toBe(first.signature);
    expect(first.ask.question).toContain("no authority-preserving recovery action");
    expect(first.ask.question).toContain("recovery spent");
    expect(first.ask.question).not.toContain("state signature");
    expect(validateDirective(first.ask).valid).toBe(true);

    recordGuardRefusal(project, zeroExit, attempt);
    const atCap = recordGuardRefusal(project, zeroExit, attempt);
    expect(atCap.count).toBe(3);
    expect(atCap.ask.remedies).toEqual([]);
    expect(atCap.ask.question).toContain(`state signature ${atCap.signature}`);
    expect(atCap.ask.question).toContain("has refused 3 times");
    expect(validateDirective(atCap.ask).valid).toBe(true);

    // The terminal shape is enforced by the directive contract: an empty remedy
    // list without a signature is malformed, and a signature with remedies too.
    expect(
      validateDirective({ ...first.ask, state_signature: undefined }).valid,
    ).toBe(false);
    expect(
      validateDirective({ ...atCap.ask, remedies: evaluated.remedies }).valid,
    ).toBe(false);
    expect(
      validateDirective(
        guardTerminalAskForRefusal(zeroExit, {
          count: 1,
          codes: [zeroExit.code],
          signature: "f".repeat(64),
          atCap: false,
        }),
      ).valid,
    ).toBe(true);
  });

  test("every remedy carries a closed op and the contract rejects an unknown one", () => {
    const ops = new Set<string>(GUARD_REMEDY_OPS);
    const humanAuthority = { freshTurn: false, unattended: false };
    const attempts = [
      {
        recovery: "available" as const,
        pendingReview: { iteration: 1, retryable: true },
        summaryCoverage: "current" as const,
        reviewCoverage: "missing" as const,
        sourceCoverage: "current" as const,
      },
      {
        recovery: "spent" as const,
        summaryCoverage: "missing" as const,
        reviewCoverage: "stale" as const,
        sourceCoverage: "unbindable" as const,
      },
      {
        recovery: "available" as const,
        reviewBudget: { used: 2, limit: 2 },
        summaryCoverage: "current" as const,
        reviewCoverage: "current" as const,
        sourceCoverage: "current" as const,
      },
    ];
    for (const marker of [" ", "-", "?", "R", "x", "S"] as const) {
      for (const attempt of attempts) {
        const refusal = evaluateGuardRefusal({
          code: "PROBE",
          blockedAction: "probe",
          stage: "functional-design",
          stateContent: state(marker),
          invariant: "probe",
          userMessage: "probe",
          attempt,
          humanAuthority,
        });
        for (const remedy of refusal.remedies) {
          expect(ops.has(remedy.op), `${marker} ${remedy.action}`).toBe(true);
        }
      }
    }
    const ask = guardRecoveryAskForRefusal(
      evaluateGuardRefusal({
        code: "PROBE",
        blockedAction: "probe",
        stage: "functional-design",
        stateContent: state("-"),
        invariant: "probe",
        userMessage: "probe",
        attempt: attempts[0],
        humanAuthority,
      }),
    );
    expect(ask).not.toBeNull();
    const forged = {
      ...ask,
      remedies: (ask as NonNullable<typeof ask>).remedies.map((remedy) => ({
        ...remedy,
        op: "delete-evidence",
      })),
    };
    const verdict = validateDirective(forged);
    expect(verdict.valid).toBe(false);
    expect(verdict.valid ? [] : verdict.errors.join("\n")).toContain(
      "remedies[0].op must be one of",
    );
  });

  test("the gate's Request Changes choice tolerates case, prefix, and punctuation but not paraphrase", () => {
    for (const reply of [
      "Request Changes",
      "request changes",
      "REQUEST CHANGES",
      "B. Request Changes",
      "2) request changes",
      '"Request Changes"',
      "Request Changes.",
      "  Request   Changes  ",
    ]) {
      expect(isRequestChangesChoice(reply), reply).toBe(true);
    }
    for (const reply of [
      "Approve",
      "please change it",
      "Request Changes to the plan",
      "Changes",
      "",
      undefined,
    ]) {
      expect(isRequestChangesChoice(reply), String(reply)).toBe(false);
    }
    expect(normalizeGuardRecoveryText("  Split the\n  save-search   flow  ")).toBe(
      "Split the save-search flow",
    );
    expect(normalizeGuardRecoveryText("Split the save-search flow")).toBe(
      normalizeGuardRecoveryText("Split   the\tsave-search\nflow"),
    );
  });

  test("Request Changes binds to the guard-recovery ask by the gate the report path allows", () => {
    // Routing refuses a Unit, so the ask names that Unit. The reject names the
    // gate ownership permits: solo ownership refuses `--unit`, so its reject is
    // stage-level and must still bind to the Unit-scoped ask; team ownership
    // requires `--unit`, so the binding is exact on stage and Unit.
    for (const ownership of ["solo", "team"] as const) {
      const project = createTestProject();
      projects.push(project);
      seedStateFile(project, join(FIXTURES_DIR, "state-construction.md"));
      const statePath = seededStateFile(project);
      const state = `${readFileSync(statePath, "utf-8")}${
        ownership === "team" ? "- **Unit Ownership**: team\n" : ""
      }`;
      writeFileSync(statePath, state, "utf-8");
      expect(isTeamUnitOwnership(state)).toBe(ownership === "team");
      writeActiveDirectiveMarker(project, {
        kind: "ask",
        ask_type: GUARD_RECOVERY_ASK_TYPE,
        stage: "functional-design",
        unit: "alpha",
        state_sha256: stateDigest(state),
      });
      const status = (stage: string, unit: string | undefined, feedback = "anything") =>
        guardRecoveryFeedbackStatus(project, state, stage, unit, feedback);
      // No selection yet: nothing to bind to.
      expect(status("functional-design", undefined)).toBe("not-applicable");
      expect(consumeSharedDirectiveAsk(project, "Ask what should change")).toBe(true);

      const stageLevel = status("functional-design", undefined);
      const unitLevel = status("functional-design", "alpha");
      if (ownership === "solo") {
        expect(stageLevel).toBe("awaiting-feedback");
        expect(unitLevel).toBe("not-applicable");
      } else {
        expect(stageLevel).toBe("not-applicable");
        expect(unitLevel).toBe("awaiting-feedback");
      }
      expect(status("functional-design", "beta")).toBe("not-applicable");
      expect(status("nfr-requirements", undefined)).toBe("not-applicable");

      // The human's separate feedback, then the conductor's exact or altered copy.
      expect(consumeSharedDirectiveAsk(project, "Split the  save-search\nflow")).toBe(true);
      const bound = ownership === "solo" ? undefined : "alpha";
      expect(status("functional-design", bound, "Split the save-search flow")).toBe("match");
      expect(status("functional-design", bound, "Split the save search flow")).toBe("mismatch");
    }
  });

  test("ordinary pending and recovery-pending requests have distinct streak signatures", () => {
    const project = mkdtempSync(join(tmpdir(), "aidlc-guard-liveness-"));
    projects.push(project);
    const normalPending = {
      floor: "floor-pending",
      recovery: "available" as const,
      pendingReview: { iteration: 1, retryable: true },
      summaryCoverage: "current" as const,
      reviewCoverage: "missing" as const,
      sourceCoverage: "current" as const,
    };
    const recoveryPending = {
      ...normalPending,
      recovery: "pending" as const,
    };
    expect(recoveryPending).toEqual({
      ...normalPending,
      recovery: "pending",
    });
    const refusal = evaluateGuardRefusal({
      code: "REVIEW_VERDICT_PENDING",
      blockedAction: "review-request",
      stage: "functional-design",
      stateContent: state("-"),
      invariant: "A pending review receives its verdict.",
      userMessage: "pending",
      attempt: normalPending,
      humanAuthority: { freshTurn: false, unattended: false },
    });
    expect(
      refusal.remedies.some(
        (remedy) =>
          remedy.executableNow && remedy.action.includes("--retry-pending"),
      ),
    ).toBe(true);

    const guardDir = join(
      project,
      "aidlc",
      "spaces",
      "default",
      "intents",
      ".aidlc-guard-refusals",
    );
    const readSignature = (): string => {
      const file = readdirSync(guardDir).find((name) => name.endsWith(".json"));
      if (!file) throw new Error("guard refusal record missing");
      return (
        JSON.parse(readFileSync(join(guardDir, file), "utf-8")) as {
          stateSignature: string;
        }
      ).stateSignature;
    };

    expect(recordGuardRefusal(project, refusal, normalPending).count).toBe(1);
    expect(recordGuardRefusal(project, refusal, normalPending).count).toBe(2);
    const normalSignature = readSignature();
    expect(recordGuardRefusal(project, refusal, recoveryPending).count).toBe(1);
    const recoverySignature = readSignature();
    expect(recoverySignature).not.toBe(normalSignature);
    expect(recordGuardRefusal(project, refusal, normalPending).count).toBe(1);
  });

  test("the existing-worktree refusal names merge completion after a Bolt crash", () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        "../../dist/claude/.claude/tools/aidlc-worktree.ts",
      ),
      "utf-8",
    );
    expect(source).toContain("without AUDIT_MERGED");
    expect(source).toContain("finish the existing Bolt complete/merge");
  });
});
