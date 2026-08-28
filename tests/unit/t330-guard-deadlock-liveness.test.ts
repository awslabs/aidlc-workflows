// covers: function:sortAttemptEvents, function:attemptEventIsCrossShardTied,
// function:attemptEventDefinitelyBefore, function:maximalAttemptEvents,
// function:reviewInvalidationAttemptView, function:attemptEventAfterFrontier,
// function:reviewAttemptAccounting, function:worktreeReviewAttemptProjection,
// function:candidateReviewCoverageProjection, function:evaluateGuardRefusal,
// function:requestChangesResetIsExecutable, function:resetGuardRefusalStreak,
// function:recordGuardRefusal, function:guardRefusalOutput,
// directive:guard-recovery

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { validateDirective } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import {
  type AttemptView,
  type AuditShardEvent,
  attemptEventAfterFrontier,
  attemptEventDefinitelyBefore,
  attemptEventIsCrossShardTied,
  candidateReviewCoverageProjection,
  evaluateGuardRefusal,
  guardRefusalOutput,
  maximalAttemptEvents,
  recordGuardRefusal,
  requestChangesResetIsExecutable,
  resetGuardRefusalStreak,
  reviewInvalidationAttemptView,
  reviewAttemptAccounting,
  sortAttemptEvents,
  worktreeReviewAttemptProjection,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const projects: string[] = [];

afterEach(() => {
  while (projects.length > 0) {
    rmSync(projects.pop()!, { recursive: true, force: true });
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
              for (const remedy of executable) {
                if (remedy.command?.includes("--result rejected")) {
                  expect(["in-progress", "awaiting-approval"]).toContain(
                    lifecycle,
                  );
                }
                if (remedy.action.startsWith("Start the one stale-receipt")) {
                  expect(recoveryState).toBe("available");
                  expect(reviewCoverage).toBe("stale");
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
      teamGateStatus: "pending",
    });
    expect(pending.state).toBe("in-progress");
    expect(
      pending.remedies.some((remedy) =>
        remedy.command?.includes("--result rejected")
      ),
    ).toBe(true);

    const revising = evaluateGuardRefusal({
      ...pending,
      stateContent: state("-"),
      teamGateStatus: "revising",
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
        recovery: "pending",
        pendingReview: { iteration: 1, retryable: true },
        summaryCoverage: "current",
        reviewCoverage: "missing",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: false, unattended: false },
      teamGateStatus: "pending",
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

    expect(recordGuardRefusal(project, refusalA, attempt).count).toBe(1);
    expect(recordGuardRefusal(project, refusalB, attempt).count).toBe(1);
    expect(recordGuardRefusal(project, refusalA, attempt).count).toBe(2);
    const capped = recordGuardRefusal(project, refusalB, attempt);
    expect(capped.count).toBe(3);
    expect(capped.halt).toBe(true);
    expect(capped.ask?.reason_codes).toEqual([
      "REVIEW_FREEZE_ACTIVE",
      "SUMMARY_EVIDENCE_INVALID",
    ]);
    expect(validateDirective(capped.ask).valid).toBe(true);
    expect(requestChangesResetIsExecutable(state("-"), "functional-design"))
      .toBe(true);
    expect(requestChangesResetIsExecutable(state("x"), "functional-design"))
      .toBe(false);

    appendAuditEntry("SESSION_RESUMED", { Source: "test" }, project);
    const sessionReset = recordGuardRefusal(project, refusalA, attempt);
    expect(sessionReset.count).toBe(1);
    expect(sessionReset.halt).toBe(false);

    const changed = recordGuardRefusal(project, refusalA, {
      ...attempt,
      sourceCoverage: "stale",
    });
    expect(changed.count).toBe(1);
    expect(changed.halt).toBe(false);

    resetGuardRefusalStreak(project, "functional-design");
    expect(guardRefusalOutput(project, refusalA, attempt)).toBe(
      "summary blocked",
    );
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
