// covers: function:handleReview, function:reviewFileSigner, hook:aidlc-log-subagent,
// audit:REVIEW_COMPLETED, audit:REVIEW_REQUESTED, subcommand:aidlc-state:gate-start
//
// A review requested from one reviewer and written by another (a live opencode
// run: the product lead was asked for, the architecture reviewer ran and
// signed the review as itself). `log review --verdict` refused it with "the
// reviewer appendix must contain exactly one Reviewer line matching the
// requested reviewer", which the agent read as "fix the line": it rewrote the
// Reviewer line and the product lead was recorded for a review it never did.
// The refusal now says who signed it and names the step the reviewer protocol
// already orders for an incomplete attempt: request it again with
// --retry-pending and dispatch the reviewer that request names. Once that retry
// is spent it names the NOT-READY fallback. It is the same refusal of the same
// file, said before anything marks or says something about a verdict that is
// not recorded.
//
// Mechanism: each harness tree's own log tool and log-subagent hook spawned
// over a real ledger (opencode's shape: no Claude Code variables in the shell),
// plus Claude Code's tree in its own shell.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAllAuditShards, reviewFileSigner } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
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
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const OTHER = "aidlc-architecture-reviewer-agent";

interface Tree {
  name: string;
  tools: string;
  hook: string;
  env: Record<string, string | undefined>;
}

// The runner's shell can be Claude Code's own; a tree other than Claude Code's
// runs with none of its variables.
const plainShell: Record<string, string | undefined> = { ...process.env };
for (const key of Object.keys(plainShell)) if (/^CLAUDE/.test(key)) delete plainShell[key];
const OPENCODE: Tree = {
  name: "opencode",
  tools: join(REPO_ROOT, "dist", "opencode", ".aidlc", "tools"),
  hook: join(REPO_ROOT, "dist", "opencode", ".aidlc", "hooks", "aidlc-log-subagent.ts"),
  env: { ...plainShell, OPENCODE: "1" },
};
const CLAUDE: Tree = {
  name: "claude",
  tools: join(REPO_ROOT, "dist", "claude", ".claude", "tools"),
  hook: join(REPO_ROOT, "dist", "claude", ".claude", "hooks", "aidlc-log-subagent.ts"),
  env: { ...plainShell, CLAUDE_CODE_SESSION_ID: "5b0c7f1e-9d2a-4c1b-8f3e-2a6d4e8b9c01" },
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function project(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-mid-inception.md"));
  const dir = join(seededRecordDir(p), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n");
  writeFileSync(join(dir, "requirements-analysis-questions.md"), "# Requirements Questions\n");
  return p;
}

function spawn(tree: Tree, args: string[], extra: Record<string, string> = {}, input?: string) {
  const r = spawnSync(BUN, args, {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...tree.env, AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1", ...extra } as Record<string, string>,
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function logReview(tree: Tree, p: string, extra: string[]) {
  return spawn(tree, [
    join(tree.tools, "aidlc-log.ts"), "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1",
    ...extra, "--project-dir", p,
  ]);
}

function json(out: string): Record<string, unknown> {
  return JSON.parse(out.slice(out.indexOf("{"))) as Record<string, unknown>;
}

/** The request (or its retry); returns the review file's absolute path. */
function request(tree: Tree, p: string, extra: string[] = []): string {
  const r = logReview(tree, p, extra);
  expect(r.out, r.out).toContain('"emitted":"REVIEW_REQUESTED"');
  return join(p, json(r.out).reviewFile as string);
}

function review(signer: string, verdict: "READY" | "NOT-READY" = "READY"): string {
  return (
    `**Verdict:** ${verdict}\n**Reviewer:** ${signer}\n**Iteration:** 1\n**Verdict Dictated:** no\n\n### Findings\n\n` +
    "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
    "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n" +
    (verdict === "NOT-READY" ? "| High | requirements.md | No acceptance criteria | Add them |\n" : "")
  );
}

function writes(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf-8");
}

/** The agent finishes: the tree's own SubagentStop hook, as each adapter forwards it. */
function finishes(tree: Tree, p: string, agent: string): void {
  const r = spawn(
    tree,
    [tree.hook],
    { AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p },
    JSON.stringify({ hook_event_name: "SubagentStop", agent_type: agent, agent_id: `${agent}-1` }),
  );
  expect(r.status, r.out).toBe(0);
}

function blocks(p: string, event: string): string[] {
  return readAllAuditShards(p).split("\n---\n").filter((b) => b.includes(`**Event**: ${event}`));
}

function gateStart(tree: Tree, p: string): string {
  const r = spawn(tree, [join(tree.tools, "aidlc-state.ts"), "gate-start", STAGE, "--project-dir", p], {
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  });
  expect(r.status, r.out).toBe(0);
  return r.out;
}

describe("the review file's signer", () => {
  test("one Reviewer value is the signer; none, or two different values, is no signer", () => {
    expect(reviewFileSigner(Buffer.from(review(OTHER)))).toBe(OTHER);
    expect(reviewFileSigner(Buffer.from(`## Review\n\n${review(REVIEWER)}`))).toBe(REVIEWER);
    expect(reviewFileSigner(Buffer.from(`${review(OTHER)}\n**Reviewer:** ${OTHER}\n`))).toBe(OTHER);
    expect(reviewFileSigner(Buffer.from(review(OTHER).replace(`**Reviewer:** ${OTHER}\n`, "")))).toBeNull();
    expect(reviewFileSigner(Buffer.from(`${review(OTHER)}\n**Reviewer:** ${REVIEWER}\n`))).toBeNull();
    expect(reviewFileSigner(Buffer.from(`\`\`\`\n**Reviewer:** ${OTHER}\n\`\`\`\n`))).toBeNull();
    // A value in code, emphasis or a link is not a plain name: the validator's
    // own words apply, never a name the renderer marked up.
    for (const marked of [`\`${REVIEWER}\``, `_${REVIEWER}_`, `**${REVIEWER}**`, `[${REVIEWER}](x)`]) {
      expect(reviewFileSigner(Buffer.from(review(marked)))).toBeNull();
    }
  });
});

for (const tree of [OPENCODE, CLAUDE]) {
  describe(`${tree.name}: a review signed by another agent`, () => {
    test("is refused with the step that gets the requested reviewer's review, and nothing is said about a verdict", () => {
      const p = project();
      const file = request(tree, p);
      writes(file, review(OTHER));
      finishes(tree, p, OTHER);
      const refused = logReview(tree, p, ["--verdict", "READY"]);
      expect(refused.status, refused.out).toBe(1);
      const error = String(json(refused.out).error);
      expect(error).toContain(`is signed by ${OTHER}`);
      expect(error).toContain(`requested from ${REVIEWER}`);
      expect(error).toContain("--retry-pending");
      expect(error).toContain("dispatch the reviewer");
      expect(error).not.toContain("Reviewer line matching");
      expect(json(refused.out).change_notices).toBeUndefined();
      expect(blocks(p, "REVIEW_COMPLETED")).toHaveLength(0);
      expect(blocks(p, "CHANGE_ACCEPTED")).toHaveLength(0);

      // The step: the retry reopens the slot, the requested reviewer writes it.
      const again = request(tree, p, ["--retry-pending"]);
      expect(again).toBe(file);
      expect(existsSync(file)).toBe(false);
      writes(file, review(REVIEWER));
      finishes(tree, p, REVIEWER);
      const recorded = logReview(tree, p, ["--verdict", "READY"]);
      expect(recorded.status, recorded.out).toBe(0);
      expect(recorded.out).toContain('"emitted":"REVIEW_COMPLETED"');
      expect(json(recorded.out).change_notices).toBeUndefined();
      const completion = blocks(p, "REVIEW_COMPLETED");
      expect(completion).toHaveLength(1);
      expect(completion[0]).not.toContain("Reviewer Finished Before Verdict");
      expect(completion[0]).not.toContain("Review Edited After Reviewer");
      expect(gateStart(tree, p)).not.toContain("change_notices");
    });

    test("once the retry is spent the refusal names the NOT-READY fallback, and that fallback records", () => {
      const p = project();
      const file = request(tree, p);
      writes(file, review(OTHER));
      finishes(tree, p, OTHER);
      expect(logReview(tree, p, ["--verdict", "READY"]).status).toBe(1);
      request(tree, p, ["--retry-pending"]);
      writes(file, review(OTHER));
      finishes(tree, p, OTHER);
      const refused = logReview(tree, p, ["--verdict", "READY"]);
      expect(refused.status, refused.out).toBe(1);
      const error = String(json(refused.out).error);
      expect(error).toContain(`is signed by ${OTHER}`);
      expect(error).toContain("record --verdict NOT-READY");
      expect(error).not.toContain("--retry-pending`");
      const fallback = logReview(tree, p, ["--verdict", "NOT-READY"]);
      expect(fallback.status, fallback.out).toBe(0);
      const completion = blocks(p, "REVIEW_COMPLETED");
      expect(completion).toHaveLength(1);
      expect(completion[0]).toContain("**Review Finished**: no");
    });
  });
}
