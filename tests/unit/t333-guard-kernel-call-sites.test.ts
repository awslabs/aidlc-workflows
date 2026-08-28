// covers: subcommand:aidlc-log:review
// covers: subcommand:aidlc-worktree:create
//
// t333 - migrated call sites preserve their principal and evidence properties
// through the real Cursor adapter and CLI process boundaries.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  readAuditShardEvents,
  sourceBaselineAuditFields,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  cleanupWorktreeFixture,
  seedAuditFile,
  seedBoltDag,
  seededRecordDir,
  seedStateFile,
  seededStateFile,
  setupWorktreeFixture,
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
const SWARM = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-swarm.ts");
const worktreeProjects: string[] = [];
const projects: string[] = [];

afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
  while (worktreeProjects.length > 0) cleanupWorktreeFixture(worktreeProjects.pop()!);
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
      AIDLC_SKIP_SOURCE_FRESHNESS: "",
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

function runSwarm(project: string, args: string[]): { code: number; output: string } {
  const result = spawnSync(process.execPath, [SWARM, "--project-dir", project, ...args], {
    cwd: project,
    encoding: "utf-8",
    env: { ...process.env, AIDLC_SKIP_SOURCE_FRESHNESS: "" },
  });
  return {
    code: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function sourceBoundFixture(unit: string): {
  project: string;
  worktree: string;
  sourceCommit: string;
  reviewed: string;
} {
  // Use the same real prepare -> review -> finalize lifecycle as t314, so
  // merge exercises current-attempt provenance rather than a fabricated row.
  const project = setupWorktreeFixture();
  worktreeProjects.push(project);
  seedStateFile(project, "state-construction-with-worktree.md");
  const statePath = seededStateFile(project);
  writeFileSync(statePath, readFileSync(statePath, "utf-8")
    .replace(/^(- \*\*Bolt Refs\*\*: ).*$/m, "$1"));
  writeFileSync(join(project, ".gitignore"), [
    "aidlc/active-space",
    "aidlc/.aidlc-clone-id",
    "aidlc/spaces/*/intents/active-intent",
    "aidlc/spaces/*/intents/*/runtime-graph.json",
    "aidlc/spaces/*/intents/*/.aidlc-*",
    "aidlc/spaces/*/intents/*/audit/",
    "",
  ].join("\n"));
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "source review fixture"]);
  const baseline = sourceBaselineAuditFields(project, "code-generation");
  // The next CLI process uses the real clock. Backdate only this synchronous
  // boundary emission so its second-precision timestamp is strictly earlier.
  setSystemTime(new Date(Date.now() - 2_000));
  try {
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", ...baseline }, project);
  } finally {
    setSystemTime();
  }
  seedBoltDag(project, [unit]);
  const prepared = runSwarm(project, [
    "prepare", "--batch", "1", "--units", unit, "--base", "main",
  ]);
  expect(prepared.code, prepared.output).toBe(0);
  const worktree = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
  const reviewed = "export const reviewed = 'A';\n";
  writeFileSync(join(worktree, "reviewed.ts"), reviewed);
  const artifactDir = join(seededRecordDir(worktree), "construction", unit, "code-generation");
  mkdirSync(artifactDir, { recursive: true });
  for (const artifact of [
    "code-generation-plan.md", "unit-test-instructions.md", "code-summary.md", "traceability.json",
  ]) {
    writeFileSync(join(artifactDir, artifact), `# ${artifact}\n`);
  }
  writeFileSync(join(artifactDir, "source-manifest.json"), `${JSON.stringify({
    stage: "code-generation", unit, version: 1, writes: [{ path: "reviewed.ts" }],
  })}\n`);
  const reviewArgs = [
    "--stage", "code-generation", "--reviewer", "aidlc-architecture-reviewer-agent",
    "--unit", unit, "--iteration", "1", "--project-dir", worktree,
  ];
  const requested = runReview(worktree, reviewArgs);
  expect(requested.code, requested.stderr).toBe(0);
  appendFileSync(join(artifactDir, "code-generation-plan.md"),
    "\n## Review\n\n**Verdict:** READY\n**Reviewer:** aidlc-architecture-reviewer-agent\n**Iteration:** 1\n\n### Findings\n\nFixture review.\n");
  const completed = runReview(worktree, [...reviewArgs, "--verdict", "READY"]);
  expect(completed.code, completed.stderr).toBe(0);
  const finalized = runSwarm(project, [
    "finalize", "--batch", "1", "--units", unit, "--claimed", unit,
    "--check-cmd", `"${process.execPath}" -e "require('fs').accessSync('reviewed.ts')"`,
  ]);
  expect(finalized.code, finalized.output).toBe(0);
  const convergence = readAuditShardEvents(project).find((row) =>
    row.event === "SWARM_UNIT_CONVERGED" && auditBlockField(row.block, "Unit name") === unit);
  if (!convergence) throw new Error(`Missing convergence for ${unit}`);
  const sourceCommit = auditBlockField(convergence.block, "Source Commit");
  if (!sourceCommit) throw new Error(`Missing bound Source Commit for ${unit}`);
  return { project, worktree, sourceCommit, reviewed };
}

function mergeSource(
  project: string,
  unit: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { code: number; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_SOURCE_FRESHNESS: "", ...extraEnv };
  delete env.GIT_NO_REPLACE_OBJECTS;
  const result = spawnSync(process.execPath, [
    WORKTREE, "merge", "--slug", unit, "--target", "main", "--strategy", "squash",
    "--project-dir", project,
  ], {
    cwd: project,
    encoding: "utf-8",
    env,
  });
  return { code: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
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

  test("cursor adapter: attached of= operands deny through the kernel without the legacy parser", () => {
    const project = installedProject("state-mid-inception.md");
    spawnAttributedAgent(project, "aidlc-developer-agent", "attached-corpus");
    const protectedPath = join(project, "aidlc", ".aidlc-cursor-subagents", "attached.json");
    const protectedBytes = '{"delegation":"preserve"}\n';
    writeFileSync(protectedPath, protectedBytes);
    const protectedCommand = `dd if=/dev/null of=${JSON.stringify(protectedPath)}`;
    // Pin the preexisting corpus deny before isolating the kernel. A developer
    // without reviewer dispatch avoids a separate reviewer read-only refusal.
    deny(project, "attached-corpus", "Shell", { command: protectedCommand });

    const adapterPath = join(project, ".cursor", "hooks", "aidlc-cursor-adapter.ts");
    let adapter = readFileSync(adapterPath, "utf-8");
    for (const [original, replacement] of [
      ["? await touchesProtectedReviewerState()", "? false"],
      ["          preclassifiedVerdict,", "          preclassifiedVerdict: undefined,"],
    ]) {
      if (!adapter.includes(original)) throw new Error(`Missing isolated adapter seam: ${original}`);
      adapter = adapter.replace(original, replacement);
    }
    // Only the disposable installed fixture is patched; production and dist
    // adapters retain their full defense-in-depth parser.
    writeFileSync(adapterPath, adapter);
    const allowed = runAdapter(project, "guards", attributedPayload("attached-corpus", "Shell", {
      command: `dd if=/dev/null of=${JSON.stringify(join(project, "outside.txt"))}`,
    }));
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({ permission: "allow" });
    const denied = runAdapter(project, "guards", attributedPayload("attached-corpus", "Shell", {
      command: protectedCommand,
    }));
    expect(denied.code).toBe(0);
    const verdict = JSON.parse(denied.stdout) as { permission: string; agent_message: string };
    expect(verdict.permission).toBe("deny");
    expect(verdict.agent_message).toMatch(/cannot read, modify, or remove reviewer attribution state/);
    expect(readFileSync(protectedPath, "utf-8")).toBe(protectedBytes);
  }, 30_000);

  test("source-bound merge ignores replacement refs and lands reviewed A bytes, never replacement B", () => {
    const unit = "replacement";
    const { project, worktree, sourceCommit, reviewed } = sourceBoundFixture(unit);
    const beforeHead = git(project, ["rev-parse", "HEAD"]);
    const replacementBytes = "export const reviewed = 'UNREVIEWED B';\n";
    // Make B from A's tree and parent, changing only the reviewed source file.
    // The reviewed checkout remains A throughout the replacement attack.
    const indexPath = join(project, ".git", "replacement-index");
    const objectGit = (args: string[], input?: string): string => {
      const result = spawnSync("git", ["--no-replace-objects", "-C", project, ...args], {
        encoding: "utf-8", input,
        env: { ...process.env, GIT_INDEX_FILE: indexPath, GIT_NO_REPLACE_OBJECTS: "1" },
      });
      if (result.status !== 0) throw new Error(`${result.stdout}${result.stderr}`);
      return result.stdout.trim();
    };
    let replacementCommit: string;
    try {
      objectGit(["read-tree", sourceCommit]);
      const blob = objectGit(["hash-object", "-w", "--stdin"], replacementBytes);
      objectGit(["update-index", "--cacheinfo", `100644,${blob},reviewed.ts`]);
      replacementCommit = objectGit([
        "commit-tree", objectGit(["write-tree"]), "-p", objectGit(["rev-parse", `${sourceCommit}^`]),
        "-m", "Unreviewed replacement B",
      ]);
    } finally {
      rmSync(indexPath, { force: true });
    }
    git(project, ["replace", sourceCommit, replacementCommit]);
    const replacementEnv = { ...process.env };
    delete replacementEnv.GIT_NO_REPLACE_OBJECTS;
    const replaced = spawnSync("git", ["-C", project, "show", `${sourceCommit}:reviewed.ts`], {
      encoding: "utf-8", env: replacementEnv,
    });
    expect(replaced.status).toBe(0);
    expect(replaced.stdout).toBe(replacementBytes);
    expect(readFileSync(join(worktree, "reviewed.ts"), "utf-8")).toBe(reviewed);

    const merged = mergeSource(project, unit);
    expect(merged.code, merged.output).toBe(0);
    const landedHead = git(project, ["--no-replace-objects", "rev-parse", "HEAD"]);
    expect(landedHead).not.toBe(beforeHead);
    expect(readFileSync(join(project, "reviewed.ts"), "utf-8")).toBe(reviewed);
    expect(git(project, ["--no-replace-objects", "show", `${landedHead}:reviewed.ts`])).toBe(reviewed.trim());
    const authority = readAuditShardEvents(project).find((row) => row.event === "SWARM_SOURCE_MERGED");
    expect(authority).toBeDefined();
    expect(auditBlockField(authority!.block, "Source Commit")).toBe(sourceCommit);
    expect(auditBlockField(authority!.block, "Merge commit")).toBe(landedHead);
  }, 120_000);

  test("source-bound merge refuses an unprovable combined tree before changing target HEAD or bytes", () => {
    const unit = "combined-tree";
    const { project, worktree, reviewed } = sourceBoundFixture(unit);
    const beforeHead = git(project, ["rev-parse", "HEAD"]);
    const beforeStatus = git(project, ["status", "--porcelain=v1"]);
    const beforeBytes = readFileSync(join(project, "README.md"));
    // Fault only merge-tree, not git merge: the former fail-open null path can
    // still merge successfully, so the refusal is not a real merge conflict.
    const shimDir = join(project, ".git", "combined-tree-bin");
    mkdirSync(shimDir);
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();
    if (!realGit) throw new Error("Cannot locate Git for combined-tree fault injection");
    writeFileSync(join(shimDir, "git"), [
      "#!/bin/sh",
      'for arg in "$@"; do',
      '  if [ "$arg" = "merge-tree" ]; then',
      '    echo "forced merge-tree unavailable" >&2',
      '    exit 129',
      '  fi',
      'done',
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    const merged = mergeSource(project, unit, { PATH: `${shimDir}:${process.env.PATH ?? ""}` });
    expect(merged.code).not.toBe(0);
    expect(merged.output).toMatch(/cannot prove (?:the )?combined merge tree/i);
    expect(merged.output).toMatch(/upgrade Git/i);
    expect(merged.output).toMatch(/resolve (?:the )?merge conflicts/i);
    expect(merged.output).toContain("AIDLC_SKIP_SOURCE_FRESHNESS=1");
    expect(merged.output).toContain("only with human approval");
    expect(merged.output).not.toContain("[merge-succeeded:");
    expect(git(project, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(project, ["status", "--porcelain=v1"])).toBe(beforeStatus);
    expect(readFileSync(join(project, "README.md"))).toEqual(beforeBytes);
    expect(existsSync(join(project, "reviewed.ts"))).toBe(false);
    expect(readFileSync(join(worktree, "reviewed.ts"), "utf-8")).toBe(reviewed);
    expect(readAuditShardEvents(project).some((row) => row.event === "SWARM_SOURCE_MERGED")).toBe(false);
  }, 120_000);
});
