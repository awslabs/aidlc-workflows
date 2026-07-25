// covers: subcommand:aidlc-orchestrate:next, function:validateDirective
//
// Steering-content delivery - the deterministic anchor for rules_in_context
// and inline_context_paths. The engine bakes rule/persona/knowledge CONTENT
// into the run-stage directive (rules_content / inline_context_content) so
// per-stage steering no longer depends on the conductor choosing to read the
// paths. Process-boundary tests against the shipped dist engine: fixture
// workspace, spawn `next`, assert on the emitted directive.
//
// Contract under test:
//   1. rules_content carries each SUBSTANTIVE rule file's text; the
//      comment-only team.md/project.md placeholders are dropped.
//   2. inline_context_content delivers persona + knowledge once per agent per
//      workflow (deliver-once): agents already on a completed stage's inline
//      roster are not re-delivered, and the aidlc-shared tree ships only with
//      the first inline stage.
//   3. The whole emitted line respects the AIDLC_DIRECTIVE_MAX_BYTES budget;
//      overflow files land in *_omitted (visible, never silent).
//   4. Missing rule files are skipped without breaking the directive.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  DEFAULT_RECORD_DIR,
  REPO_ROOT,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const TOOLS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const ORCH_TOOL = join(TOOLS_DIR, "aidlc-orchestrate.ts");

type PathText = { path: string; text: string };
type RunStage = {
  kind: string;
  stage?: string;
  rules_in_context?: string[];
  rules_content?: PathText[];
  rules_content_omitted?: string[];
  inline_context_paths?: string[];
  inline_context_content?: PathText[];
  inline_context_omitted?: string[];
  conductor_persona?: string;
};

const projects: string[] = [];

function project(): string {
  const proj = setupIntegrationProject();
  projects.push(proj);
  return proj;
}

afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

function next(
  proj: string,
  args: string[],
  env: Record<string, string> = {},
): { directive: RunStage; rawBytes: number } {
  const res = spawnSync(
    BUN,
    [ORCH_TOOL, "next", ...args, "--project-dir", proj],
    { encoding: "utf-8", env: { ...process.env, ...env } },
  );
  expect(res.status).toBe(0);
  const line = (res.stdout ?? "").trim();
  return {
    directive: JSON.parse(line) as RunStage,
    rawBytes: Buffer.byteLength(line, "utf-8"),
  };
}

// A minimal in-flight state: intent-capture completed, feasibility active.
// intent-capture's inline roster (product + architect) counts as delivered;
// feasibility adds aws-platform + compliance.
function seedFeasibilityState(proj: string): void {
  const recDir = join(
    proj, "aidlc", "spaces", "default", "intents", DEFAULT_RECORD_DIR,
  );
  mkdirSync(recDir, { recursive: true });
  writeFileSync(
    join(recDir, "aidlc-state.md"),
    [
      "# AI-DLC State Tracking",
      "",
      "## Project Information",
      "- **Project**: steering fixture",
      "- **Project Type**: Greenfield",
      "- **Scope**: mvp",
      "- **Current Stage**: feasibility",
      "",
      "## Stage Checkboxes",
      // The checkbox delimiter is the state-file FORMAT's em dash
      // (parseCheckboxes requires it); written as a backslash-u escape
      // to keep the source ASCII.
      "- [x] workspace-scaffold \u2014 EXECUTE",
      "- [x] workspace-detection \u2014 EXECUTE",
      "- [x] state-init \u2014 EXECUTE",
      "- [x] intent-capture \u2014 EXECUTE",
      "- [-] feasibility \u2014 EXECUTE",
      "- [ ] scope-definition \u2014 EXECUTE",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(proj, "aidlc", "spaces", "default", "intents", "active-intent"),
    DEFAULT_RECORD_DIR,
    "utf-8",
  );
}

describe("t248 steering-content delivery", () => {
  test("rules_content carries substantive rules; placeholders dropped; paths stay", () => {
    const proj = project();
    const { directive } = next(proj, ["--scope", "mvp", "--stage", "intent-capture"]);
    expect(directive.kind).toBe("run-stage");
    // Paths roster unchanged (backward-compatible).
    expect(directive.rules_in_context).toEqual([
      "aidlc/spaces/default/memory/org.md",
      "aidlc/spaces/default/memory/team.md",
      "aidlc/spaces/default/memory/project.md",
      "aidlc/spaces/default/memory/phases/ideation.md",
    ]);
    const paths = (directive.rules_content ?? []).map((e) => e.path);
    // org.md + phases/ideation.md ship substantive; team/project are
    // comment-only placeholders and must be dropped, not delivered as noise.
    expect(paths).toContain("aidlc/spaces/default/memory/org.md");
    expect(paths).toContain("aidlc/spaces/default/memory/phases/ideation.md");
    expect(paths).not.toContain("aidlc/spaces/default/memory/team.md");
    expect(paths).not.toContain("aidlc/spaces/default/memory/project.md");
    // Text is the real file, not a stub.
    const org = (directive.rules_content ?? []).find((e) =>
      e.path.endsWith("org.md"),
    );
    expect(org?.text).toContain("## Walking Skeleton");
  });

  test("populated placeholder becomes substantive and is delivered", () => {
    const proj = project();
    appendFileSync(
      join(proj, "aidlc", "spaces", "default", "memory", "team.md"),
      "\n## Testing Posture\n\nWe use BDD. Specifications drive scenarios.\n",
      "utf-8",
    );
    const { directive } = next(proj, ["--scope", "mvp", "--stage", "intent-capture"]);
    const team = (directive.rules_content ?? []).find((e) =>
      e.path.endsWith("team.md"),
    );
    expect(team?.text).toContain("We use BDD.");
  });

  test("missing rule file is skipped; directive stays well-formed", () => {
    const proj = project();
    rmSync(join(proj, "aidlc", "spaces", "default", "memory", "org.md"));
    const { directive } = next(proj, ["--scope", "mvp", "--stage", "intent-capture"]);
    expect(directive.kind).toBe("run-stage");
    const paths = (directive.rules_content ?? []).map((e) => e.path);
    expect(paths).not.toContain("aidlc/spaces/default/memory/org.md");
    // The paths roster still lists it (compile-frozen); only content skips.
    expect(directive.rules_in_context).toContain(
      "aidlc/spaces/default/memory/org.md",
    );
  });

  test("first inline stage delivers roster content; emitted line respects the budget", () => {
    const proj = project();
    const budget = 120_000;
    const { directive, rawBytes } = next(
      proj,
      ["--scope", "mvp", "--stage", "intent-capture"],
      { AIDLC_DIRECTIVE_MAX_BYTES: String(budget) },
    );
    const contentPaths = (directive.inline_context_content ?? []).map((e) => e.path);
    // Persona + knowledge for the stage roster (product lead, architect
    // support) plus the shared tree - content, not just paths.
    expect(contentPaths.some((p) => p.endsWith("agents/aidlc-product-agent.md"))).toBe(true);
    expect(contentPaths.some((p) => p.includes("knowledge/aidlc-shared/"))).toBe(true);
    expect(rawBytes).toBeLessThanOrEqual(budget);
    // Everything not delivered is named, never silently dropped: content +
    // omitted partition the roster.
    const omitted = directive.inline_context_omitted ?? [];
    const roster = directive.inline_context_paths ?? [];
    for (const p of roster) {
      expect(contentPaths.includes(p) || omitted.includes(p)).toBe(true);
    }
  });

  test("tight budget moves overflow to *_omitted lists and the line still fits", () => {
    const proj = project();
    const budget = 22_000; // persona (~12KB) + base directive leave little room
    const { directive, rawBytes } = next(
      proj,
      ["--scope", "mvp", "--stage", "intent-capture"],
      { AIDLC_DIRECTIVE_MAX_BYTES: String(budget) },
    );
    expect(directive.kind).toBe("run-stage");
    expect(rawBytes).toBeLessThanOrEqual(budget);
    expect((directive.inline_context_omitted ?? []).length).toBeGreaterThan(0);
  });

  test("deliver-once: a later stage re-delivers rules but not prior agents' context", () => {
    const proj = project();
    seedFeasibilityState(proj);
    const { directive } = next(proj, [], {
      AIDLC_DIRECTIVE_MAX_BYTES: "120000",
    });
    expect(directive.stage).toBe("feasibility");
    // Rules re-deliver every stage (learnings can mutate them mid-workflow).
    const rulePaths = (directive.rules_content ?? []).map((e) => e.path);
    expect(rulePaths).toContain("aidlc/spaces/default/memory/org.md");
    // intent-capture's roster (product lead + architect support) and the
    // shared tree were delivered with that stage - not re-sent here.
    const all = [
      ...(directive.inline_context_content ?? []).map((e) => e.path),
      ...(directive.inline_context_omitted ?? []),
    ];
    expect(all.some((p) => p.includes("aidlc-architect-agent"))).toBe(false);
    expect(all.some((p) => p.includes("aidlc-product-agent"))).toBe(false);
    expect(all.some((p) => p.includes("knowledge/aidlc-shared/"))).toBe(false);
    // feasibility's NEW supports (aws-platform, compliance) do arrive.
    expect(all.some((p) => p.includes("aidlc-aws-platform-agent"))).toBe(true);
    expect(all.some((p) => p.includes("aidlc-compliance-agent"))).toBe(true);
    // No persona re-delivery mid-workflow (D-E unchanged).
    expect(directive.conductor_persona).toBeUndefined();
  });
});
