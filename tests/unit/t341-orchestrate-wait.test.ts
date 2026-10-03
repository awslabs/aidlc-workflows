// covers: subcommand:aidlc-orchestrate:wait

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  resetAidlcEnv,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// `aidlc engine orchestrate wait` is the sanctioned wait for dispatched work on
// a harness whose Agent/Task call returns before the worker finishes. It polls
// the same on-disk evidence the engine checks and always returns within its
// bound, so the conductor re-runs one pre-approved command instead of minting
// a shell loop. Every case spawns the CLI: the verb's contract is its argv and
// its JSON, not an importable function.

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const USAGE = "Usage: wait --stage <slug> --for collaborators|artifacts|review";

let project = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  if (project) cleanupTestProject(project);
  project = "";
});

/** A project whose seeded intent carries a state file, so the active intent resolves. */
function activeIntentProject(
  fixture = "state-mid-inception.md",
): string {
  const proj = createOrchestrationTestProject();
  seedStateFile(proj, fixture);
  return proj;
}

function wait(args: string[]) {
  const res = spawnSync(
    process.execPath,
    [ORCHESTRATE, "wait", ...args, "--project-dir", project],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" },
  );
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(res.stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, json };
}

describe("t341 orchestrate wait", () => {
  test("refuses a missing target, an unknown stage, and a review wait without a file", () => {
    project = createOrchestrationTestProject();
    const noTarget = wait(["--stage", "practices-discovery"]);
    expect(noTarget.status).toBe(1);
    expect(noTarget.stderr).toContain(USAGE);

    const unknown = wait(["--stage", "no-such-stage", "--for", "artifacts"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Unknown stage "no-such-stage"');

    const reviewWithoutFile = wait(["--stage", "requirements-analysis", "--for", "review"]);
    expect(reviewWithoutFile.status).toBe(1);
    expect(reviewWithoutFile.stderr).toContain("--for review needs --review-file <path>");

    // No state file means no active intent: an artifacts wait must refuse rather
    // than settle against a record that does not exist.
    const noIntent = wait(["--stage", "requirements-analysis", "--for", "artifacts", "--timeout", "1"]);
    expect(noIntent.status).toBe(1);
    expect(noIntent.stderr).toContain("No active intent record resolves");
  });

  test("collaborators: names every missing contribution, then settles once the identity markers exist", () => {
    project = activeIntentProject();
    const waiting = wait([
      "--stage", "practices-discovery", "--for", "collaborators", "--timeout", "1",
    ]);
    expect(waiting.status, waiting.stderr).toBe(0);
    expect(waiting.json?.status).toBe("waiting");
    expect(waiting.json?.for).toBe("collaborators");
    expect(waiting.json?.missing).toEqual([
      "aidlc-quality-agent (no contribution file)",
      "aidlc-developer-agent (no contribution file)",
      "aidlc-devsecops-agent (no contribution file)",
    ]);
    // The bound is honoured: a one-second wait really waits about one second.
    expect(Number(waiting.json?.waited_ms)).toBeGreaterThanOrEqual(900);
    expect(String(waiting.json?.next)).toContain("Never replace it with a shell loop");

    const dir = join(seededRecordDir(project), "inception", "practices-discovery", "contributions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "aidlc-quality-agent.md"), "**Collaborator:** aidlc-quality-agent\n\nnotes\n");
    writeFileSync(join(dir, "aidlc-developer-agent.md"), "# not the identity marker\n");
    writeFileSync(join(dir, "aidlc-devsecops-agent.md"), "**Collaborator:** aidlc-devsecops-agent\n");
    const partial = wait([
      "--stage", "practices-discovery", "--for", "collaborators", "--timeout", "1",
    ]);
    expect(partial.json?.status).toBe("waiting");
    expect(partial.json?.missing).toEqual([
      "aidlc-developer-agent (missing identity-marker first line)",
    ]);

    writeFileSync(join(dir, "aidlc-developer-agent.md"), "**Collaborator:** aidlc-developer-agent\n");
    const settled = wait([
      "--stage", "practices-discovery", "--for", "collaborators", "--timeout", "1",
    ]);
    expect(settled.json?.status).toBe("settled");
    expect(settled.json?.missing).toEqual([]);
    expect(Number(settled.json?.waited_ms)).toBeLessThan(900);
    expect(String(settled.json?.next)).toContain("continue the stage body");
  });

  test("artifacts: waits until every required declared artifact of the stage carries bytes", () => {
    project = activeIntentProject();
    const waiting = wait([
      "--stage", "requirements-analysis", "--for", "artifacts", "--timeout", "1",
    ]);
    expect(waiting.status, waiting.stderr).toBe(0);
    expect(waiting.json?.status).toBe("waiting");
    expect(waiting.json?.missing).toEqual([
      "inception/requirements-analysis/requirements.md (absent or empty)",
      "inception/requirements-analysis/requirements-analysis-questions.md (absent or empty)",
    ]);

    const dir = join(seededRecordDir(project), "inception", "requirements-analysis");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "requirements.md"), "# Requirements\n");
    writeFileSync(join(dir, "requirements-analysis-questions.md"), "");
    const emptyFile = wait([
      "--stage", "requirements-analysis", "--for", "artifacts", "--timeout", "1",
    ]);
    expect(emptyFile.json?.status).toBe("waiting");
    expect(emptyFile.json?.missing).toEqual([
      "inception/requirements-analysis/requirements-analysis-questions.md (absent or empty)",
    ]);

    writeFileSync(join(dir, "requirements-analysis-questions.md"), "# Questions\n");
    const settled = wait([
      "--stage", "requirements-analysis", "--for", "artifacts", "--timeout", "1",
    ]);
    expect(settled.json?.status).toBe("settled");
    expect(settled.json?.missing).toEqual([]);
  });

  test("artifacts: unresolved CodeKB and per-unit locations never settle", () => {
    project = activeIntentProject("state-brownfield-feature.md");
    const codekb = wait([
      "--stage", "reverse-engineering", "--for", "artifacts", "--timeout", "1",
    ]);
    expect(codekb.status, codekb.stderr).toBe(0);
    expect(codekb.json?.status).toBe("waiting");
    expect(codekb.json?.missing).toEqual([
      "codekb/*/business-overview.md (location unresolved)",
      "codekb/*/architecture.md (location unresolved)",
      "codekb/*/code-structure.md (location unresolved)",
      "codekb/*/api-documentation.md (location unresolved)",
      "codekb/*/component-inventory.md (location unresolved)",
      "codekb/*/technology-stack.md (location unresolved)",
      "codekb/*/dependencies.md (location unresolved)",
      "codekb/*/code-quality-assessment.md (location unresolved)",
      "codekb/*/reverse-engineering-timestamp.md (location unresolved)",
    ]);

    const perUnit = wait([
      "--stage", "functional-design", "--for", "artifacts", "--timeout", "1",
    ]);
    expect(perUnit.status, perUnit.stderr).toBe(0);
    expect(perUnit.json?.status).toBe("waiting");
    expect(perUnit.json?.missing).toEqual([
      "construction/*/functional-design/entities.md (location unresolved)",
      "construction/*/functional-design/rules.md (location unresolved)",
      "construction/*/functional-design/functional-spec.md (location unresolved)",
      "construction/*/functional-design/traceability.json (location unresolved)",
    ]);
  });

  test("review: settles when the named review file has bytes, resolved against the project", () => {
    project = activeIntentProject();
    const relative = "pending-review.review.md";
    const waiting = wait([
      "--stage", "requirements-analysis", "--for", "review",
      "--review-file", relative, "--timeout", "1",
    ]);
    expect(waiting.status, waiting.stderr).toBe(0);
    expect(waiting.json?.status).toBe("waiting");
    expect(waiting.json?.review_file).toBe(relative);
    expect(waiting.json?.missing).toEqual([`review file ${relative} (absent or empty)`]);

    writeFileSync(join(project, relative), "**Verdict:** READY\n");
    const settled = wait([
      "--stage", "requirements-analysis", "--for", "review",
      "--review-file", relative, "--timeout", "1",
    ]);
    expect(settled.json?.status).toBe("settled");
    expect(settled.json?.missing).toEqual([]);
  });
});
