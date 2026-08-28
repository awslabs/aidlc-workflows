// covers: tool:aidlc-pr, function:evaluatePullSnapshot,
// function:foldReviewHistory, function:evaluateDetection,
// function:stackingEligibility, function:readIntegrationMode

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  approvedPublicationBody,
  composePrBody,
  evaluateCoordinatedPulls,
  evaluateDetection,
  evaluatePullSnapshot,
  foldReviewHistory,
  inferBranchPattern,
  reviewersFromPractices,
  stackingEligibility,
  type PullSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-pr.ts";
import { CLI_PROTECTED_EVENT_TYPES } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readIntegrationMode } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seedStateFile,
} from "../harness/fixtures.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

const open = (overrides: Partial<PullSnapshot> = {}): PullSnapshot => ({
  repo: "example/service",
  number: 42,
  url: "https://github.com/example/service/pull/42",
  state: "OPEN",
  reviewDecision: "REVIEW_REQUIRED",
  reviewRequests: [],
  isDraft: false,
  mergeStateStatus: "BLOCKED",
  mergeable: "MERGEABLE",
  headRefOid: "head-2",
  reviews: [],
  timeline: [],
  ...overrides,
});

describe("t330-pr-integration-policy", () => {
  test("terminal state wins over a post-merge CHANGES_REQUESTED review", () => {
    const result = evaluatePullSnapshot(open({
      state: "MERGED",
      mergedAt: "2026-08-25T08:20:20Z",
      reviewDecision: "CHANGES_REQUESTED",
      reviews: [{
        id: 2,
        user: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-08-25T08:21:38Z",
        commit_id: "head-2",
      }],
    }));
    expect(result.verdict).toBe("MERGED");
  });

  test("full history ignores COMMENTED and later approval supersedes own CR", () => {
    const folded = foldReviewHistory([
      { id: 1, user: { login: "reviewer" }, state: "CHANGES_REQUESTED", submitted_at: "2026-08-25T01:00:00Z", commit_id: "head-1" },
      { id: 2, user: { login: "reviewer" }, state: "COMMENTED", submitted_at: "2026-08-25T02:00:00Z", commit_id: "head-1" },
      { id: 3, user: { login: "reviewer" }, state: "APPROVED", submitted_at: "2026-08-25T03:00:00Z", commit_id: "head-2" },
    ], [], "head-2");
    expect(folded).toEqual([expect.objectContaining({
      reviewer: "reviewer",
      state: "APPROVED",
      stale: false,
    })]);
  });

  test("dismissed approval neutralizes the same actor's earlier CR", () => {
    const result = evaluatePullSnapshot(open({
      reviews: [
        { id: 1, user: { login: "bot" }, state: "CHANGES_REQUESTED", submitted_at: "2026-08-25T01:00:00Z", commit_id: "head-1" },
        { id: 2, user: { login: "bot" }, state: "DISMISSED", submitted_at: "2026-08-25T02:00:00Z", commit_id: "head-1" },
      ],
      timeline: [{
        event: "review_dismissed",
        dismissed_review: { review_id: 2, state: "approved" },
      }],
    }));
    expect(result.verdict).toBe("REVIEW_REQUIRED");
    expect(result.reviewers[0].dismissedOriginalState).toBe("APPROVED");
  });

  test("approval commit mismatch is stale and UNKNOWN is only mergeability", () => {
    const result = evaluatePullSnapshot(open({
      mergeStateStatus: "UNKNOWN",
      mergeable: null,
      reviewDecision: "APPROVED",
      reviews: [{
        id: 1,
        user: { login: "reviewer" },
        state: "APPROVED",
        submitted_at: "2026-08-25T01:00:00Z",
        commit_id: "head-1",
      }],
    }));
    expect(result.verdict).toBe("STALE_APPROVAL");
    expect(result.mergeability).toBe("unknown");
  });

  test("REST closed and merged shapes stay distinct", () => {
    expect(evaluatePullSnapshot(open({ state: "CLOSED", merged: true })).verdict)
      .toBe("MERGED");
    expect(evaluatePullSnapshot(open({ state: "CLOSED", merged: false })).verdict)
      .toBe("CLOSED");
  });

  test("coordinated merged plus rejected sibling is halt-and-ask", () => {
    const merged = evaluatePullSnapshot(open({ state: "MERGED" }));
    const rejected = evaluatePullSnapshot(open({
      repo: "example/sibling",
      number: 7,
      url: "https://github.com/example/sibling/pull/7",
      reviews: [{
        id: 9,
        user: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-08-25T04:00:00Z",
        commit_id: "head-2",
      }],
    }));
    const group = evaluateCoordinatedPulls([merged, rejected]);
    expect(group.state).toBe("halt-and-ask");
    expect(group.message).toContain(merged.url);
  });

  test("closed-unmerged groups halt instead of waiting forever", () => {
    const closed = evaluatePullSnapshot(open({
      state: "CLOSED",
      merged: false,
    }));
    const group = evaluateCoordinatedPulls([closed]);
    expect(group.state).toBe("halt-and-ask");
    expect(group.message).toContain("replacement PR");
  });

  test("detection unions classic and ruleset policy", () => {
    const result = evaluateDetection({
      repo: "example/service",
      repository: {
        defaultBranchRef: { name: "develop" },
        viewerPermission: "ADMIN",
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        autoMergeAllowed: true,
        deleteBranchOnMerge: false,
        pullRequestTemplates: [{ filename: "pull_request_template.md", body: "## Summary" }],
      },
      branchInfo: {
        protected: true,
        protection: { required_status_checks: { contexts: ["classic-ci"] } },
      },
      classicProtection: {
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          dismiss_stale_reviews: false,
          require_code_owner_reviews: false,
        },
      },
      rules: [
        { type: "pull_request", parameters: {
          required_approving_review_count: 2,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          allowed_merge_methods: ["merge"],
        } },
        { type: "required_status_checks", parameters: {
          required_status_checks: [{ context: "ruleset-ci" }],
        } },
      ],
    }) as any;
    expect(result.protection.effective).toEqual({
      requiredApprovals: 2,
      dismissStaleReviews: true,
      requireCodeOwnerReview: true,
      requiredChecks: ["classic-ci", "ruleset-ci"],
    });
    expect(result.merge.methods).toEqual(["merge"]);
  });

  test("protected silent classic detail stays unknown and absent tier is explicit", () => {
    const hidden = evaluateDetection({
      repo: "cli/cli",
      repository: { viewerPermission: "READ" },
      branchInfo: { protected: true },
      rules: [],
    }) as any;
    expect(hidden.protection.tier).toBe("protected-details-unknown");
    expect(hidden.protection.classicDetail).toBe("unknown-below-admin");

    const absent = evaluateDetection({
      repo: "example/private",
      repository: { viewerPermission: "ADMIN" },
      branchInfo: { protected: false },
      protectionUnavailable: true,
    }) as any;
    expect(absent.protection.tier).toBe("absent-protection");
  });

  test("non-admin classic detail stays unknown even with visible rulesets", () => {
    const hidden = evaluateDetection({
      repo: "example/service",
      repository: { viewerPermission: "WRITE" },
      branchInfo: { protected: true },
      rules: [{
        type: "pull_request",
        parameters: { required_approving_review_count: 0 },
      }],
      classicProtection: null,
    }) as any;
    expect(hidden.protection.tier).toBe("protected-details-unknown");
    expect(hidden.protection.classicDetail).toBe("unknown-below-admin");
    expect(hidden.protection.rulesetLayers).toBe(1);
  });

  test("stacking requires preserved ancestry and no automatic branch deletion", () => {
    expect(stackingEligibility({ strategy: "merge", deleteBranchOnMerge: false }).allowed)
      .toBe(true);
    expect(stackingEligibility({ strategy: "squash", deleteBranchOnMerge: false }).allowed)
      .toBe(false);
    expect(stackingEligibility({ strategy: "rebase", deleteBranchOnMerge: true }).allowed)
      .toBe(false);
    expect(stackingEligibility({ strategy: "merge", deleteBranchOnMerge: null }))
      .toMatchObject({ allowed: false, reason: expect.stringContaining("unknown") });
  });

  test("observed branch names seed ticketed and simple patterns", () => {
    expect(inferBranchPattern(["develop", "feature/PAY-231-retry-fix"]))
      .toBe("feature/{ticket}-{slug}");
    expect(inferBranchPattern(["main", "fix/retry-timeout", "fix/null-user"]))
      .toBe("fix/{slug}");
    expect(inferBranchPattern([])).toBe("bolt-{slug}");
  });

  test("dossier preserves supplied consumes order and coordination marker", () => {
    const body = composePrBody({
      template: "## Summary\n\n## Testing\n",
      title: "Retry fix",
      unit: "payments",
      marker: "AIDLC-Coordinated: bolt=payments repos=service,worker",
      evidence: [
        { artifact: "requirements", logicalPath: "inception/requirements.md", content: "R" },
        { artifact: "plugin-attestation", logicalPath: "construction/attestation.md", content: "A" },
      ],
    });
    expect(body.indexOf("### requirements")).toBeLessThan(
      body.indexOf("### plugin-attestation"),
    );
    expect(body).toContain("AIDLC-Coordinated:");
  });

  test("execute publishes the exact persisted dry-run body", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    const path = join(proj, "approved-body.md");
    writeFileSync(path, "approved bytes\n", "utf-8");
    expect(approvedPublicationBody(path, "late recomposition\n", true))
      .toBe("approved bytes\n");
    expect(approvedPublicationBody(path, "preview bytes\n", false))
      .toBe("preview bytes\n");
  });

  test("Standing reviewers none and blank parse as empty", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, "state-construction.md");
    const projectMemory = join(
      proj,
      "aidlc",
      "spaces",
      "default",
      "memory",
      "project.md",
    );
    writeFileSync(
      projectMemory,
      "# Project\n\n## Way of Working\n\n- **Standing reviewers**: NoNe\n",
      "utf-8",
    );
    expect(reviewersFromPractices(proj)).toEqual([]);
    writeFileSync(
      projectMemory,
      "# Project\n\n## Way of Working\n\n- **Standing reviewers**:\n",
      "utf-8",
    );
    expect(reviewersFromPractices(proj)).toEqual([]);
    writeFileSync(
      projectMemory,
      "# Project\n\n## Way of Working\n\n- **Standing reviewers**: alice, @bob\n",
      "utf-8",
    );
    expect(reviewersFromPractices(proj)).toEqual(["alice", "bob"]);
  });

  test("Integration Mode reader activates only exact pr", () => {
    expect(readIntegrationMode("- **Integration Mode**: pr\n")).toBe("pr");
    for (const value of ["PR", "direct", "absent", "pr-extra", ""]) {
      expect(readIntegrationMode(`- **Integration Mode**: ${value}\n`)).toBeNull();
    }
    expect(readIntegrationMode("")).toBeNull();
  });

  test("PR receipts are protected in both audit ownership sets and CLI append refuses", () => {
    const source = readFileSync(join(AIDLC_SRC, "tools", "aidlc-audit.ts"), "utf-8");
    const mergeBlock = source.match(
      /const MERGE_PROTECTED_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\);/,
    )?.[1] ?? "";
    for (const event of ["PR_OPENED", "PR_FEEDBACK", "PR_MERGED", "UNIT_INTEGRATING"]) {
      expect(CLI_PROTECTED_EVENT_TYPES.has(event)).toBe(true);
      expect(mergeBlock).toContain(`"${event}"`);
      const proj = createTestProject();
      tempDirs.push(proj);
      const env = { ...process.env };
      delete env.AIDLC_ALLOW_DIRECT_AUDIT_EVENTS;
      const result = spawnSync(
        process.execPath,
        [join(AIDLC_SRC, "tools", "aidlc-audit.ts"), "append", event, "--project-dir", proj],
        { encoding: "utf-8", env },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("authority-bearing receipt");
    }
  });

  test("receipt-emitting finalize refuses fixtures outside the test seam", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    const fixturePath = join(proj, "merged.json");
    writeFileSync(fixturePath, JSON.stringify([open({ state: "MERGED" })]));
    const env = { ...process.env };
    delete env.AIDLC_TEST_PR_FIXTURES;
    const result = spawnSync(
      process.execPath,
      [
        join(AIDLC_SRC, "tools", "aidlc-pr.ts"),
        "finalize",
        "--unit",
        "alpha",
        "--fixture",
        fixturePath,
        "--project-dir",
        proj,
      ],
      { encoding: "utf-8", env },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--fixture is test-only for receipt-emitting finalize",
    );
  });

  test("source bans latestReviews and verifies every outward write by read-back", () => {
    const source = readFileSync(join(AIDLC_SRC, "tools", "aidlc-pr.ts"), "utf-8");
    expect(source).not.toContain("latestReviews");
    expect(source).toContain("verifyPush(plan)");
    expect(source).toContain("verifyOpen(plan, snapshot, plan.body)");
    expect(source).toContain("Review request read-back verification failed");
    expect(source).toContain("Child retarget read-back failed");
    expect(source).not.toContain("branchProtectionRules(first:100)");
    const utility = readFileSync(
      join(AIDLC_SRC, "tools", "aidlc-utility.ts"),
      "utf-8",
    );
    expect(utility).toContain("timeout: PR_STATUS_REFRESH_TIMEOUT_MS");
  });
});
