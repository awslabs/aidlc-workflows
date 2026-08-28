// covers: subcommand:aidlc-log:review
// covers: subcommand:aidlc-worktree:create
//
// t333 - migrated call sites preserve their principal and evidence properties
// through the real Cursor adapter and CLI process boundaries.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  auditBlockField,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CURSOR_DIST = join(REPO_ROOT, "dist", "cursor", ".cursor");
const LOG = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-log.ts",
);
const WORKTREE = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-worktree.ts",
);
const projects: string[] = [];

afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

function installedProject(stateFixture = "state-construction.md"): string {
  const project = createTestProject();
  projects.push(project);
  cpSync(CURSOR_DIST, join(project, ".cursor"), { recursive: true });
  seedStateFile(project, stateFixture);
  seedAuditFile(project);
  return project;
}

function runAdapter(
  project: string,
  target: string,
  payload: Record<string, unknown>,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [join(project, ".cursor", "hooks", "aidlc-cursor-adapter.ts"), target],
    {
      cwd: project,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_PROJECT_DIR: project,
        AIDLC_HARNESS_DIR: ".cursor",
        AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
      },
    },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function spawnAttributedAgent(
  project: string,
  agent: string,
  identity: string,
): void {
  const parent = `${identity}-parent`;
  runAdapter(project, "session-start", {
    hook_event_name: "sessionStart",
    conversation_id: parent,
    session_id: parent,
  });
  const result = runAdapter(project, "guards", {
    hook_event_name: "preToolUse",
    conversation_id: parent,
    session_id: parent,
    generation_id: `${identity}-generation`,
    tool_use_id: `${identity}-tool`,
    tool_name: "Task",
    tool_input: {
      description: "Delegated task",
      prompt: "Perform the assigned task.",
      subagent_type: agent,
    },
  });
  expect(JSON.parse(result.stdout)).toEqual({ permission: "allow" });
}

function attributedPayload(
  identity: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    hook_event_name: "preToolUse",
    conversation_id: `${identity}-delegate`,
    session_id: `${identity}-delegate`,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

function dispatchPath(project: string): string {
  return join(seededRecordDir(project), ".aidlc-reviewer-dispatch.json");
}

function seedReviewerDispatch(project: string): string {
  const path = dispatchPath(project);
  writeFileSync(
    path,
    JSON.stringify({
      reviewer: "aidlc-architecture-reviewer-agent",
      stage: "functional-design",
      unit: "unit-a",
      exempt: [],
    }),
  );
  return path;
}

function deny(
  project: string,
  identity: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): void {
  const result = runAdapter(
    project,
    "guards",
    attributedPayload(identity, toolName, toolInput),
  );
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout) as {
    permission?: string;
    agent_message?: string;
  };
  expect(parsed.permission).toBe("deny");
  expect(parsed.agent_message?.length ?? 0).toBeGreaterThan(0);
}

function runReview(
  project: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [LOG, "review", ...args], {
    cwd: project,
    encoding: "utf-8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: project,
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
    },
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(project: string, args: string[]): string {
  const result = spawnSync("git", ["-C", project, ...args], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function runWorktree(
  project: string,
  slug: string,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [WORKTREE, "create", "--slug", slug, "--base", "main"],
    {
      cwd: project,
      encoding: "utf-8",
      env: { ...process.env, AIDLC_PROJECT_DIR: project },
    },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("guard kernel migrated call sites", () => {
  test("cursor adapter: every protected-store deny of the current corpus remains a deny after migration", () => {
    const project = installedProject();
    const dispatch = seedReviewerDispatch(project);
    spawnAttributedAgent(
      project,
      "aidlc-architecture-reviewer-agent",
      "reviewer-corpus",
    );
    const ledger = join(project, "aidlc", ".aidlc-cursor-subagents");
    for (const [toolName, toolInput] of [
      ["Read", { file_path: join(ledger, "spawn.json") }],
      ["Shell", { command: `rm -f ${JSON.stringify(dispatch)}` }],
      ["Shell", { command: `rm -f ${JSON.stringify(dispatch.slice(0, -1))}*` }],
      ["Shell", { command: "node -e 'console.log(1)'" }],
      ["Shell", { command: 'target="$HOME/state"; printf "%s\\n" "$target"' }],
      ["Shell", { command: "timeout 5 node -e 'x'" }],
      ["Shell", { command: "nice node -e 'x'" }],
      ["Shell", { command: "ionice node -e 'x'" }],
      ["Shell", { command: "stdbuf -o0 node -e 'x'" }],
      ["Shell", { command: "setsid node -e 'x'" }],
      ["Shell", { command: "sudo node -e 'x'" }],
      ["Shell", { command: "doas node -e 'x'" }],
      ["Shell", { command: "xargs node -e 'x'" }],
      ["Shell", { command: "time node -e 'x'" }],
      ["Shell", { command: "unbuffer node -e 'x'" }],
      ["Shell", { command: "env -S 'node -e x'" }],
      ["Shell", { command: "{ node -e 'x'; }" }],
      ["Shell", { command: "( node -e 'x' )" }],
      ["Shell", { command: "if true; then node -e 'x'; fi" }],
      ["Shell", { command: "for i in 1; do node -e 'x'; done" }],
    ] as Array<[string, Record<string, unknown>]>) {
      deny(project, "reviewer-corpus", toolName, toolInput);
    }
  }, 30_000);

  test("cursor adapter: non-canonical and link-indirect spellings of the attribution store deny", () => {
    const project = installedProject();
    seedReviewerDispatch(project);
    spawnAttributedAgent(
      project,
      "aidlc-architecture-reviewer-agent",
      "reviewer-canonical",
    );
    const ledger = join(project, "aidlc", ".aidlc-cursor-subagents");
    const alias = join(project, "ledger-alias");
    symlinkSync(ledger, alias, "dir");
    const spellings = [
      join(project, "aidlc", "unused", "..", ".aidlc-cursor-subagents", "x"),
      relative(project, join(ledger, "x")).replaceAll("/", "\\"),
      join(alias, "x"),
    ];
    for (const filePath of spellings) {
      deny(project, "reviewer-canonical", "Read", {
        file_path: filePath,
        cwd: project,
      });
    }
  });

  test("cursor adapter: unprovable shell under live reviewer dispatch denies; proven-disjoint shell for a non-reviewer delegate still allows", () => {
    const reviewerProject = installedProject();
    seedReviewerDispatch(reviewerProject);
    spawnAttributedAgent(
      reviewerProject,
      "aidlc-architecture-reviewer-agent",
      "reviewer-policy",
    );
    deny(reviewerProject, "reviewer-policy", "Shell", {
      command: 'printf "%s\\n" "$HOME"',
    });

    const developerProject = installedProject("state-mid-inception.md");
    spawnAttributedAgent(
      developerProject,
      "aidlc-developer-agent",
      "developer-policy",
    );
    const outside = join(developerProject, "outside.txt");
    writeFileSync(outside, "outside\n");
    const allowed = runAdapter(
      developerProject,
      "guards",
      attributedPayload("developer-policy", "Shell", {
        command: `printf '%s\\n' ${outside}`,
      }),
    );
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({ permission: "allow" });

    deny(developerProject, "developer-policy", "Shell", {
      command: "rm *",
      cwd: join(
        developerProject,
        "aidlc",
        ".aidlc-cursor-subagents",
      ),
    });
  });

  test("reviewer retry binds to sealed evidence: a retry after the reviewed bytes changed is refused, never rebound", () => {
    const project = installedProject("state-mid-inception.md");
    const artifactDir = join(
      seededRecordDir(project),
      "inception",
      "requirements-analysis",
    );
    mkdirSync(artifactDir, { recursive: true });
    const artifact = join(artifactDir, "requirements.md");
    writeFileSync(artifact, "reviewed requirements\n");
    writeFileSync(
      join(artifactDir, "requirements-analysis-questions.md"),
      "# Questions\n",
    );
    const args = [
      "--stage",
      "requirements-analysis",
      "--reviewer",
      "aidlc-product-lead-agent",
      "--iteration",
      "1",
    ];
    expect(runReview(project, args).code).toBe(0);
    const original = readAuditShardEvents(project).filter(
      (row) => row.event === "REVIEW_REQUESTED",
    );
    expect(original).toHaveLength(1);

    writeFileSync(artifact, "changed requirements\n");
    const refused = runReview(project, [...args, "--retry-pending"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(
      /declared artifact set could not be captured as one stable snapshot|declared artifacts no longer match the bytes from REVIEW_REQUESTED/,
    );
    expect(
      readAuditShardEvents(project).filter(
        (row) => row.event === "REVIEW_REQUESTED",
      ),
    ).toHaveLength(1);

    writeFileSync(artifact, "reviewed requirements\n");
    expect(runReview(project, [...args, "--retry-pending"]).code).toBe(0);
    const requests = readAuditShardEvents(project).filter(
      (row) => row.event === "REVIEW_REQUESTED",
    );
    expect(requests).toHaveLength(2);
    for (const field of [
      "Artifact Fingerprint",
      "Source Fingerprint",
      "Unit Source Fingerprint",
    ]) {
      expect(auditBlockField(requests[1].block, field)).toBe(
        auditBlockField(requests[0].block, field),
      );
    }
    expect(auditBlockField(requests[1].block, "Retry")).toBe(
      "pending-request",
    );
  });

  test("committed-source evidence is checkout-independent at the worktree call sites", () => {
    const project = installedProject("state-construction.md");
    rmSync(join(project, ".git"), { recursive: true, force: true });
    git(project, ["init", "-q", "-b", "main"]);
    git(project, ["config", "user.email", "evidence@example.invalid"]);
    git(project, ["config", "user.name", "Evidence Test"]);
    writeFileSync(
      join(project, ".gitignore"),
      "aidlc/\n.aidlc/\n.cursor/\n",
    );
    writeFileSync(join(project, "app.ts"), "export const value = 1;\n");
    git(project, ["add", "-A"]);
    git(project, ["commit", "-qm", "base"]);

    const clean = runWorktree(project, "clean-source");
    expect(clean.code, clean.stderr).toBe(0);
    const cleanListing = (
      JSON.parse(clean.stdout) as { base_source_listing: string }
    ).base_source_listing;

    writeFileSync(join(project, "app.ts"), "export const dirty = 2;\n");
    const dirty = runWorktree(project, "dirty-source");
    expect(dirty.code, dirty.stderr).toBe(0);
    const dirtyListing = (
      JSON.parse(dirty.stdout) as { base_source_listing: string }
    ).base_source_listing;
    expect(dirtyListing).toBe(cleanListing);

    writeFileSync(join(project, "app.ts"), "export const value = 1;\n");
    writeFileSync(join(project, ".gitattributes"), "app.ts text\n");
    git(project, ["add", "-A"]);
    git(project, ["commit", "-qm", "declare content transformation"]);
    const transformed = runWorktree(project, "transformed-source");
    expect(transformed.code).not.toBe(0);
    expect(`${transformed.stdout}${transformed.stderr}`).toContain(
      "Base source listing could not be computed",
    );
  }, 30_000);
});
