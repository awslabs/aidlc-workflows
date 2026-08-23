// covers: aidlc-stage-schema.ts:validateStageFrontmatter (the pipeline/mob
//   topology values + the ensemble-requires-support_agents coupling, plus the
//   ENSEMBLE_MODES export), aidlc-directive.ts:validateDirective (mode enum
//   carry-through for the new values), and the aidlc-graph compile advisory
//   for the swarm-trigger trap (a per-unit Construction build stage whose
//   mode is not subagent silently leaves the autonomous swarm path).
//
// t235 — three-role ensemble mode enum (2.5.0). The mode field is the stage's
// communication topology: inline (voices) | subagent (hub-and-spoke) |
// pipeline (chain) | mob (mesh) | agent-team (reserved). pipeline and mob
// collaborate by construction, so the schema rejects them without a
// non-empty support_agents (mirroring the reviewer_max_iterations-requires-
// reviewer coupling). The shipped-graph census (no agent-team declared,
// user-stories carries mob) is guarded by t65.
//
// Mechanism: pure function calls for the schema/directive halves; one bun
// subprocess per compile-advisory case (the advisory prints from
// compileStageGraph via the CLI, stderr-only, exit 0).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ENSEMBLE_MODES,
  VALID_MODES,
  validateStageFrontmatter,
} from "../../dist/claude/.claude/tools/aidlc-stage-schema.ts";
import { validateDirective } from "../../dist/claude/.claude/tools/aidlc-directive.ts";

const REPO = join(import.meta.dir, "..", "..");
const GRAPH_TOOL = join(REPO, "dist", "claude", ".claude", "tools", "aidlc-graph.ts");

// Minimal valid frontmatter (t62 fixture shape) with an overridable mode +
// support set.
function stage(mode: string, support: string[]): Record<string, unknown> {
  return {
    slug: "fixture-stage",
    phase: "construction",
    execution: "ALWAYS",
    condition: "Always executes",
    lead_agent: "aidlc-architect-agent",
    support_agents: support,
    mode,
    produces: ["fixture-artifact"],
    consumes: [],
    requires_stage: [],
    inputs: "prose",
    outputs: "prose",
  };
}

function errs(obj: unknown): string {
  const r = validateStageFrontmatter(obj);
  return r.valid ? "VALID" : r.errors.join("|");
}

describe("t235 ensemble modes — schema", () => {
  test("VALID_MODES is the five-value topology enum, agent-team last", () => {
    expect([...VALID_MODES]).toEqual([
      "inline",
      "subagent",
      "pipeline",
      "mob",
      "agent-team",
    ]);
    expect([...ENSEMBLE_MODES]).toEqual(["pipeline", "mob"]);
  });

  for (const m of ENSEMBLE_MODES) {
    test(`mode=${m} with support agents -> VALID`, () => {
      expect(errs(stage(m, ["aidlc-developer-agent"]))).toBe("VALID");
    });

    test(`mode=${m} with empty support_agents rejected`, () => {
      expect(errs(stage(m, []))).toContain(
        `mode "${m}" requires a non-empty support_agents`,
      );
    });
  }

  test("mode=inline with empty support_agents stays VALID (no coupling)", () => {
    expect(errs(stage("inline", []))).toBe("VALID");
  });

  test("mode=subagent with empty support_agents stays VALID (hub with no spokes = today's single worker)", () => {
    expect(errs(stage("subagent", []))).toBe("VALID");
  });

  test("unknown mode still rejected with the full enum in the message", () => {
    const e = errs(stage("swarm", ["aidlc-developer-agent"]));
    expect(e).toContain("mode must be one of");
    expect(e).toContain("pipeline | mob | agent-team");
  });
});

describe("t235 ensemble modes — directive enum carry-through", () => {
  // The directive's mode enum mirrors the schema's (VALID_MODES in
  // aidlc-directive.ts). A run-stage directive carrying each new mode must
  // validate; the reserved value stays accepted at the directive layer (the
  // census guard that no stage declares it lives in t65).
  function directive(mode: string): Record<string, unknown> {
    return {
      kind: "run-stage",
      stage: "fixture-stage",
      phase: "construction",
      lead_agent: "aidlc-architect-agent",
      support_agents: ["aidlc-developer-agent"],
      mode,
      inline_context_paths: mode === "inline"
        ? ["agents/aidlc-architect-agent.md", "agents/aidlc-developer-agent.md"]
        : [],
      gate: true,
      memory_path: "aidlc-docs/construction/fixture-stage/memory.md",
      consumes: [],
      produces: ["aidlc-docs/construction/fixture-stage/fixture-artifact.md"],
      rules_in_context: [],
      sensors_applicable: [],
      stage_file: "stages/construction/fixture-stage.md",
    };
  }

  for (const m of ["pipeline", "mob", "agent-team"]) {
    test(`run-stage directive with mode=${m} validates`, () => {
      const r = validateDirective(directive(m));
      expect(r.valid).toBe(true);
    });
  }

  test("run-stage directive with an unknown mode is rejected", () => {
    const r = validateDirective(directive("mesh"));
    expect(r.valid).toBe(false);
  });
});

describe("t235 ensemble modes — compile advisory for the swarm-trigger trap", () => {
  // The autonomous Construction swarm fires on for_each: unit-of-work +
  // mode: subagent (SWARM_FOR_EACH / SWARM_MODE, aidlc-orchestrate.ts). A
  // per-unit BUILD stage (workspace_requires: true) carrying another mode is
  // legal but silently off the swarm path — compile warns on stderr and
  // still succeeds.
  function compileWith(mode: string, workspaceRequires: boolean): { status: number | null; stderr: string } {
    const root = mkdtempSync(join(tmpdir(), "t235-"));
    try {
      const installedTools = join(root, ".claude", "tools");
      mkdirSync(installedTools, { recursive: true });
      writeFileSync(join(installedTools, "aidlc-lib.ts"), "");
      const stagesRoot = join(root, "stages");
      mkdirSync(join(stagesRoot, "construction"), { recursive: true });
      const fm = [
        "---",
        "slug: build-stage",
        "phase: construction",
        "execution: ALWAYS",
        "condition: Always executes",
        "lead_agent: orchestrator",
        "support_agents:",
        "  - orchestrator",
        `mode: ${mode}`,
        "for_each: unit-of-work",
        ...(workspaceRequires ? ["workspace_requires: true"] : []),
        "produces: []",
        "consumes: []",
        "requires_stage: []",
        "inputs: prose",
        "outputs: prose",
        "---",
        "",
        "# Build Stage",
        "",
        "## Steps",
        "body",
        "",
      ].join("\n");
      writeFileSync(join(stagesRoot, "construction", "build-stage.md"), fm);
      const graphPath = join(root, "stage-graph.json");
      writeFileSync(graphPath, "[]");
      const r = spawnSync("bun", [GRAPH_TOOL, "compile"], {
        encoding: "utf-8",
        cwd: root,
        env: {
          ...process.env,
          AIDLC_STAGES_DIR: stagesRoot,
          AIDLC_STAGE_GRAPH: graphPath,
          AIDLC_SCOPE_GRID: join(root, "scope-grid.json"),
          AIDLC_RULES_DIR: join(root, "no-rules"),
          AIDLC_SENSORS_DIR: join(root, "no-sensors"),
          AIDLC_PROJECT_DIR: root,
        },
      });
      return { status: r.status, stderr: r.stderr };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("per-unit build stage with mode: mob compiles with the advisory", () => {
    const r = compileWith("mob", true);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("[advisory]");
    expect(r.stderr).toContain("swarm will NOT fire");
  });

  test("per-unit build stage with mode: subagent compiles silently", () => {
    const r = compileWith("subagent", true);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("[advisory]");
  });

  test("per-unit DESIGN stage (no workspace_requires) with mode: mob compiles silently", () => {
    const r = compileWith("mob", false);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("[advisory]");
  });
});
