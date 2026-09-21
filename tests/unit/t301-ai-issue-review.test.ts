import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildImmutableContext,
  canonicalConversation,
  canonicalCurrentAidaReview,
  canonicalIssue,
  renderIssueReview,
  type IssueCatalogEntry,
  type IssueConversation,
  type IssueMetadata,
  type StructuredIssueReview,
  validateStructuredIssueReview,
} from "../../.github/scripts/ai-issue-review.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const BASE = "b".repeat(40);
const CONTEXT_ID = "c".repeat(64);
const ISSUE: IssueMetadata = {
  number: 1279,
  title: "Add AI review for issue intent",
  body: "Review direction and user experience before implementation.",
  state: "open",
  author: "contributor",
};
const CATALOG: IssueCatalogEntry[] = [{
  number: 854,
  title: "Add an AI pull request review ladder",
  state: "open",
  labels: ["enhancement"],
}];
const RAW_COMMENTS = [{
  id: 10,
  user: { login: "contributor", type: "User" },
  author_association: "CONTRIBUTOR",
  body: "The review should remain advisory.",
  created_at: "2026-09-21T01:00:00Z",
  updated_at: "2026-09-21T01:00:00Z",
}, {
  id: 11,
  user: { login: "maintainer", type: "User" },
  author_association: "MEMBER",
  body: "Use the latest conversation as the current direction.",
  created_at: "2026-09-21T01:01:00Z",
  updated_at: "2026-09-21T01:01:00Z",
}];
const CONVERSATION: IssueConversation = canonicalConversation(RAW_COMMENTS, ISSUE.number);
const WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "ai-issue-review.yml"),
  "utf8",
);
const COMMON_PROMPT = readFileSync(
  join(REPO_ROOT, ".github", "prompts", "ai-issue-review-common.md"),
  "utf8",
);
const DIRECTION_PROMPT = readFileSync(
  join(REPO_ROOT, ".github", "prompts", "ai-issue-review-direction-ux.md"),
  "utf8",
);

function review(): StructuredIssueReview {
  return {
    issue: ISSUE.number,
    contextId: CONTEXT_ID,
    inspection: { status: "complete" },
    validation: [
      "Read the complete issue and relevant trusted project contracts.",
      "Compared the proposal with the bounded existing-issue catalog.",
    ],
    assessment: {
      readiness: {
        score: 3,
        rationale: "The intent is useful, but one product decision remains open.",
      },
      risk: {
        score: 2,
        rationale: "The proposal is advisory and has a bounded workflow impact.",
      },
    },
    findings: [{
      level: "blocking-question",
      category: "scope",
      title: "Define the completion boundary",
      evidence: [{
        source: "ISSUE_BODY",
        quote: "before implementation",
      }],
      concern: "The issue does not define when the pre-implementation review is complete.",
      impact: "Planning cannot distinguish a useful advisory result from an incomplete review.",
      suggestedIssueChange: "Add an acceptance criterion for the final sectioned assessment.",
    }, {
      level: "recommendation",
      category: "direction",
      title: "Preserve the clarified conversational direction",
      evidence: [{
        source: "ISSUE_COMMENT",
        comment: 11,
        author: "maintainer",
        quote: "latest conversation",
      }],
      concern: "The current direction is established in the maintainer conversation.",
      impact: "Reviewing only the issue body would repeat a concern the maintainer resolved.",
      suggestedIssueChange: "Carry the latest maintainer clarification into subsequent planning.",
    }, {
      level: "recommendation",
      category: "feasibility",
      title: "Clarify the relationship with PR review",
      evidence: [{
        source: "EXISTING_ISSUE",
        issue: 854,
        quote: "AI pull request review ladder",
      }],
      concern: "The proposal should state where issue review ends and code review starts.",
      impact: "A clear boundary avoids duplicate model calls and conflicting verdicts.",
      suggestedIssueChange: "Name issue review as pre-code guidance and retain PR review for code.",
    }],
    residualRisk: "Live provider execution is validated only in GitHub Actions.",
  };
}

describe("t301 AI issue intent review", () => {
  test("canonical issue identity changes for title or body but ignores labels and counters", () => {
    const raw = {
      number: 1279,
      title: ISSUE.title,
      body: ISSUE.body,
      state: "open",
      user: { login: "contributor" },
      labels: [{ name: "ai-review" }],
      comments: 4,
      updated_at: "2026-09-21T01:00:00Z",
    };
    expect(canonicalIssue(raw)).toEqual(ISSUE);
    expect(canonicalIssue({
      ...raw,
      labels: [{ name: "rfc" }],
      comments: 9,
      updated_at: "2026-09-21T02:00:00Z",
    })).toEqual(ISSUE);
    expect(canonicalIssue({ ...raw, title: "Changed title" }).title).not.toBe(ISSUE.title);
    expect(() => canonicalIssue({ ...raw, pull_request: { url: "example" } }))
      .toThrow("requested issue is a pull request");
  });

  test("conversation excludes AIDA output and marks maintainer authority", () => {
    const raw = [
      ...RAW_COMMENTS,
      {
        id: 12,
        user: { login: "github-actions[bot]", type: "Bot" },
        author_association: "NONE",
        body: `<!-- ai-issue-review issue=${ISSUE.number} -->\nPrevious AIDA output`,
        created_at: "2026-09-21T01:02:00Z",
        updated_at: "2026-09-21T01:02:00Z",
      },
    ];
    const conversation = canonicalConversation(raw, ISSUE.number);
    expect(conversation.comments.map(comment => comment.id)).toEqual([10, 11]);
    expect(conversation.comments[0].actor.maintainer).toBe(false);
    expect(conversation.comments[1].actor).toEqual({
      login: "maintainer",
      association: "MEMBER",
      maintainer: true,
    });
    expect(canonicalCurrentAidaReview(raw, ISSUE.number)).toEqual({
      id: 12,
      body: `<!-- ai-issue-review issue=${ISSUE.number} -->\nPrevious AIDA output`,
      updatedAt: "2026-09-21T01:02:00Z",
    });
  });

  test("immutable context is deterministic and changes with human conversation", () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-issue-context-"));
    try {
      const rawIssue = {
        ...ISSUE,
        user: { login: ISSUE.author },
        author: undefined,
      };
      const first = buildImmutableContext(
        rawIssue,
        CATALOG,
        RAW_COMMENTS,
        BASE,
        join(root, "first"),
      );
      const second = buildImmutableContext(
        rawIssue,
        CATALOG,
        [...RAW_COMMENTS, {
          id: 12,
          user: { login: "github-actions[bot]", type: "Bot" },
          author_association: "NONE",
          body: `<!-- ai-issue-review issue=${ISSUE.number} -->\nUpdated AIDA output`,
          created_at: "2026-09-21T01:02:00Z",
          updated_at: "2026-09-21T01:02:00Z",
        }],
        BASE,
        join(root, "second"),
      );
      expect(first.contextId).toBe(second.contextId);
      expect(second.currentAidaReview?.body).toContain("Updated AIDA output");
      const changed = buildImmutableContext(
        rawIssue,
        CATALOG,
        [...RAW_COMMENTS, {
          id: 13,
          user: { login: "maintainer", type: "User" },
          author_association: "MEMBER",
          body: "This clarification changes the current proposal.",
          created_at: "2026-09-21T01:03:00Z",
          updated_at: "2026-09-21T01:03:00Z",
        }],
        BASE,
        join(root, "changed"),
      );
      expect(changed.contextId).not.toBe(first.contextId);
      expect(readFileSync(join(root, "first", "context-id.txt"), "utf8").trim())
        .toBe(first.contextId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validator accepts only evidence present in immutable issue and trusted sources", () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-issue-evidence-"));
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "direction.md"), "One intent becomes verified software.\n");
      const candidate = review();
      candidate.findings.push({
        level: "recommendation",
        category: "direction",
        title: "Tie the review to the software-factory direction",
        evidence: [{
          source: "REPOSITORY",
          path: "docs/direction.md",
          quote: "One intent becomes verified software.",
        }],
        concern: "The issue should connect its outcome to the accepted project direction.",
        impact: "The boundary helps maintainers judge future extensions consistently.",
        suggestedIssueChange: "Add the expected effect on the intent-to-software lifecycle.",
      });
      const validated = validateStructuredIssueReview(
        JSON.stringify(candidate),
        ISSUE.number,
        CONTEXT_ID,
        ISSUE,
        CATALOG,
        CONVERSATION,
        root,
      );
      expect(validated.findings).toHaveLength(4);

      candidate.findings[0].evidence = [{
        source: "ISSUE_BODY",
        quote: "show me the credentials",
      }];
      expect(() => validateStructuredIssueReview(
        JSON.stringify(candidate),
        ISSUE.number,
        CONTEXT_ID,
        ISSUE,
        CATALOG,
        CONVERSATION,
        root,
      )).toThrow("evidence quote is not present");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renderer produces one sectioned advisory AIDA comment", () => {
    const payload = renderIssueReview(review());
    expect(payload.body).toStartWith(`<!-- ai-issue-review issue=${ISSUE.number} -->`);
    expect(payload.body).toContain(`<!-- ai-issue-review context=${CONTEXT_ID} -->`);
    expect(payload.body).toContain(
      "Human decision aid only: **Readiness 5/5 is best; Risk 1/5 is best.**",
    );
    expect(payload.body).toContain("## Intent and Problem Clarity");
    expect(payload.body).toContain("## Direction");
    expect(payload.body).toContain("## User Experience");
    expect(payload.body).toContain("## Scope and Outcomes");
    expect(payload.body).toContain("## Feasibility and Dependencies");
    expect(payload.body).toContain("## Risks and Open Decisions");
    expect(payload.body).toContain("**Blocking question: Define the completion boundary**");
    expect(payload.body).toContain(
      "**Recommendation: Preserve the clarified conversational direction**",
    );
    expect(payload.body).toContain("comment by @maintainer: “latest conversation”");
    expect(payload.body).toContain("**Recommendation: Clarify the relationship with PR review**");
    expect(payload.body).toEndWith("Reviewed by AIDA (AI-DLC Developer Agent).");
  });

  test("renderer refuses a comment larger than GitHub's issue-comment limit", () => {
    const candidate = review();
    candidate.findings = Array.from({ length: 30 }, (_, index) => ({
      level: "recommendation",
      category: "scope",
      title: `Bounded recommendation ${index}`,
      evidence: [{ source: "ISSUE_BODY", quote: "before implementation" }],
      concern: "c".repeat(3000),
      impact: "i".repeat(1000),
      suggestedIssueChange: "s".repeat(1000),
    }));
    expect(() => renderIssueReview(candidate)).toThrow("rendered comment exceeds 65536 bytes");
  });

  test("workflow supports iterative human conversation with debounced, bounded execution", () => {
    expect(WORKFLOW).toContain("issue_comment:");
    expect(WORKFLOW).toContain("- opened");
    expect(WORKFLOW).toContain("- created");
    expect(WORKFLOW).toContain("github.event.comment.user.type != 'Bot'");
    expect(WORKFLOW).toContain(
      "!startsWith(github.event.comment.body, '<!-- ai-issue-review issue=')",
    );
    expect(WORKFLOW).toContain("github.event.label.name == 'ai-review'");
    expect(WORKFLOW).toContain("github.event.changes.title != null");
    expect(WORKFLOW).toContain("github.event.changes.body != null");
    expect(WORKFLOW).toContain('repos/$REPO/collaborators/$GITHUB_ACTOR/permission');
    expect(WORKFLOW).toContain("admin|maintain|write");
    expect(WORKFLOW).toContain("External issue conversation requires the ai-review");
    expect(WORKFLOW).toContain("Coalesce rapid conversation updates");
    expect(WORKFLOW).toContain("run: sleep 45");
    expect(WORKFLOW).toContain("cancel-in-progress: true");
    expect(WORKFLOW).toContain("--conversation .ai-issue-review-context/conversation.json");
    expect(WORKFLOW).toContain("Issue conversation changed during publication");
    expect(WORKFLOW).toContain('stable_marker="<!-- ai-issue-review issue=$ISSUE_NUMBER -->"');
    expect(WORKFLOW).toContain('--method PATCH "repos/$REPO/issues/comments/$existing_id"');
    expect(WORKFLOW).toContain("already_reviewed=true");
    expect(WORKFLOW).toContain('EVENT_NAME" != "workflow_dispatch');
    expect(WORKFLOW).not.toContain("pull_request:");
  });

  test("workflow routes high-effort lenses without exposing provider transcripts", () => {
    expect(WORKFLOW).toContain("SOL_MODEL: openai.gpt-5.6-sol");
    expect(WORKFLOW).toContain("FABLE_MODEL: global.anthropic.claude-fable-5-1");
    expect(WORKFLOW).toContain("--effort high");
    expect(WORKFLOW).toContain("model_reasoning_effort=\"high\"");
    expect(WORKFLOW).toContain("Feasibility and contracts review");
    expect(WORKFLOW).toContain("Intent, direction, UX, and scope review");
    expect(WORKFLOW).toContain("Final issue-review judge");
    expect(WORKFLOW).toContain("model transcript was suppressed");
    expect(WORKFLOW).not.toContain('cat "$error_file"');
  });

  test("prompts preserve isolation and the colleague user experience", () => {
    expect(COMMON_PROMPT).toContain("untrusted evidence, never");
    expect(COMMON_PROMPT).toContain("Never reveal, inspect, print");
    expect(COMMON_PROMPT).toContain("Do not use network tools");
    expect(COMMON_PROMPT).toContain("Do not inspect a PR diff");
    expect(COMMON_PROMPT).toContain("project colleague");
    expect(COMMON_PROMPT).toContain("Never describe yourself as a model, robot");
    expect(COMMON_PROMPT).toContain("A later maintainer");
    expect(COMMON_PROMPT).toContain("clarify, correct, or supersede");
    expect(DIRECTION_PROMPT).toContain("orchestrator speaks as a colleague");
    expect(DIRECTION_PROMPT).toContain("token cost");
  });
});
