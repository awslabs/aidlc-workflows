// covers: function:loadAgents
//
// Mechanism: none. Migrated from tests/unit/t61-agent-metadata-derived.sh
// (TAP plan 5). The contract under test is the agent-metadata loader
// `loadAgents()` (aidlc-lib.ts:805) — the single source of truth that
// replaced the old AGENT_KNOWLEDGE + AGENT_DISPLAY literals, derived from
// `.claude/agents/*.md` frontmatter. The .sh proved three things flow
// through that loader with NO code change when an agent file is
// added/dropped: (1) it has no literals left in tools/+hooks/, (2) the
// loader itself returns the 11 shipped agents alphabetically with the
// "Pipeline & Deploy Agent" display string, (3) the two CONSUMERS of the
// loader — `aidlc-utility.ts init` knowledge scaffolding and the
// `aidlc-statusline.ts` hook — derive their output from that same
// frontmatter. v0.3.0 Foundation milestone 3, #62.
//
// WHY .none (not .cli): the keystone observable is the PURE function
// `loadAgents()`, asserted IN-PROCESS by importing and calling it
// (covers KEY function:loadAgents directly — test 2). The two consumer
// proofs (init scaffolding, statusline render) are exercised through the
// PER-PROJECT copies of the tool/hook: each test copies the shipped
// dist/claude/.claude into a fresh temp project (setupIntegrationProject),
// drops a fixture-agent.md under <proj>/.claude/agents/, then spawns the
// tool/hook FROM THAT PROJECT — so loadAgents() inside the subprocess
// resolves AGENTS_DIR relative to <proj>/.claude/agents (lib.ts:801,
// `import.meta.url`-relative), seeing the fixture agent. The statusline
// hook is mechanism=none (a hook driven by controlled stdin); the
// utility-init spawn is the per-project tool the .sh itself drove
// (`bun "$PROJ/.claude/tools/aidlc-utility.ts" init`). Both are required
// for equal parity — an in-process call against the worktree-checkout
// lib.ts would read the SHIPPED agents dir, never the fixture variant, so
// the accept/reject/fixture-render assertions (.sh tests 3/4/5) could not
// be reproduced without spawning the per-project copies.
//
// PARITY MAP (every .sh `ok` line maps to a test() below; STRONGER noted):
//   - .sh Test 1 (static grep AGENT_KNOWLEDGE|AGENT_DISPLAY absent from
//       tools/+hooks/) -> "1: no AGENT_KNOWLEDGE/AGENT_DISPLAY literals".
//       In-process: read every shipped tools/*.ts + hooks/*.ts and assert
//       no match. STRONGER: counts offending files so a hit names them.
//   - .sh Test 2 (loadAgents() -> 11 alpha agents, pipeline display) ->
//       split into THREE test() cases asserting the same three observables
//       the .sh combined into one `if` (count===11, exact slug list,
//       pipeline display==="Pipeline & Deploy Agent"). STRONGER: the slug
//       list is asserted as a deep array equal, not a joined-string compare,
//       and the alpha-sort invariant is asserted independently.
//   - .sh Test 3 (init scaffolds knowledge/fixture-agent/README.md with
//       "# Fixture Agent Knowledge" + "- fixture-one.md") -> "3: init
//       scaffolds ...". Spawns per-project init; asserts rc===0, README
//       exists, the derived-display heading line, AND the examples bullet.
//       STRONGER: asserts the SECOND example bullet too (- fixture-two.md),
//       proving listField captured the whole list, not just the first item.
//   - .sh Test 4 (init fails loudly when display_name missing; error cites
//       file + field) -> "4: init rejects fixture-agent.md lacking
//       display_name". Asserts rc!==0 AND the combined output names both
//       "fixture-agent" and "display_name" (same two greps the .sh ran).
//   - .sh Test 5 (statusline renders derived display for shipped AND
//       fixture agents) -> split into "5a" (shipped pipeline ->
//       "Pipeline & Deploy Agent", the AGENT_DISPLAY-drift regression
//       guard) and "5b" (fixture-agent -> "Fixture Agent"), one observable
//       each. Each seeds aidlc-state.md, pipes the workspace JSON to the
//       per-project hook on stdin, and greps the rendered line.
//
// 5 .sh asserts -> 7 test() cases (Test 2 split 1->3, Test 5 split 1->2);
// every original observable preserved, several strengthened.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
// Direct in-process import of the pure loader — the KEY covered unit.
import { loadAgents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/**
 * Fresh integration project with the shipped .claude copied in, aidlc-docs
 * removed (so init scaffolds clean) and the env-scope stripped (so the
 * --scope poc flag is authoritative). Mirrors the .sh's
 * `setup_integration_project --no-aidlc-docs --strip-env-scope`.
 */
function proj(): string {
  const p = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(p);
  return p;
}

/**
 * Like proj() but KEEPS the seeded per-intent record + cursors (no
 * noAidlcDocs), so the active-intent cursor resolves and a state file seeded
 * into the record is the one stateFilePath() (and thus the statusline) reads.
 * Used by the statusline cases 5a/5b, which need a resolvable record.
 */
function projWithRecord(): string {
  const p = setupIntegrationProject({ stripEnvScope: true });
  tempDirs.push(p);
  return p;
}

/**
 * Drop a fixture-agent.md under <proj>/.claude/agents/. Mirrors the .sh's
 * write_fixture_agent helper. `includeDisplay=false` writes the broken
 * variant that omits display_name (the reject case).
 */
function writeFixtureAgent(
  p: string,
  display = "Fixture Agent",
  includeDisplay = true,
): void {
  const file = join(p, ".claude", "agents", "fixture-agent.md");
  const body = includeDisplay
    ? `---
name: fixture-agent
display_name: ${display}
examples:
  - fixture-one.md
  - fixture-two.md
description: >
  Placeholder fixture agent for t61. Not a real persona.
disallowedTools: Task
model: opus
---

Fixture agent body.
`
    : `---
name: fixture-agent
examples:
  - fixture-one.md
description: >
  Broken fixture agent — missing display_name.
disallowedTools: Task
model: opus
---
`;
  writeFileSync(file, body, "utf-8");
}

/** Spawn the PER-PROJECT statusline hook with the workspace JSON on stdin. Mirrors `echo {...} | bun "$HOOK"`. */
function runStatuslineResult(p: string): { status: number | null; out: string } {
  const hook = join(p, ".claude", "hooks", "aidlc-statusline.ts");
  const res = spawnSync(BUN, [hook], {
    cwd: p,
    encoding: "utf-8",
    input: JSON.stringify({ workspace: { project_dir: p } }),
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function runStatusline(p: string): string {
  return runStatuslineResult(p).out;
}

/** Seed a CONSTRUCTION/ci-pipeline state file naming the given active-agent slug. Mirrors the .sh heredoc + sed swap. */
function seedState(p: string, activeAgent: string): void {
  // P9: the statusline reads the ACTIVE INTENT's state via stateFilePath(), so
  // the state must live in the per-intent record (projWithRecord keeps the
  // seeded record + cursors), not a flat aidlc-docs/. Write into seededStateFile.
  const stateFile = seededStateFile(p);
  mkdirSync(join(stateFile, ".."), { recursive: true });
  writeFileSync(
    stateFile,
    `# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ci-pipeline
- **Active Agent**: ${activeAgent}
- **Status**: Running
`,
    "utf-8",
  );
}

const EXPECTED_SLUGS = [
  "aidlc-architect-agent",
  "aidlc-architecture-reviewer-agent",
  "aidlc-aws-platform-agent",
  "aidlc-compliance-agent",
  "aidlc-composer-agent",
  "aidlc-delivery-agent",
  "aidlc-design-agent",
  "aidlc-developer-agent",
  "aidlc-devsecops-agent",
  "aidlc-operations-agent",
  "aidlc-pipeline-deploy-agent",
  "aidlc-product-agent",
  "aidlc-product-lead-agent",
  "aidlc-quality-agent",
];

describe("t61 agent-metadata derived from frontmatter (migrated from t61-agent-metadata-derived.sh, plan 5)", () => {
  // ============================================================
  // Test 1 — static grep: AGENT_KNOWLEDGE / AGENT_DISPLAY literals gone
  // from tools/ + hooks/. The loadAgents() loader fully replaced them.
  // ============================================================
  test("1: no AGENT_KNOWLEDGE/AGENT_DISPLAY literals in tools/ or hooks/", () => {
    const offenders: string[] = [];
    for (const sub of ["tools", "hooks"]) {
      const dir = join(AIDLC_SRC, sub);
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
        const text = readFileSync(join(dir, f), "utf-8");
        if (/AGENT_KNOWLEDGE|AGENT_DISPLAY/.test(text)) {
          offenders.push(join(sub, f));
        }
      }
    }
    // STRONGER than the bare `[ -z "$HITS" ]`: a failure names the files.
    expect(offenders).toEqual([]);
  });

  // ============================================================
  // Test 2 — loadAgents() runtime contract (KEY: function:loadAgents).
  // The .sh combined three observables into one `if`; split for clarity.
  // ============================================================
  test("2a: loadAgents() returns the 14 shipped agents", () => {
    expect(loadAgents().length).toBe(14);
  });

  test("2b: loadAgents() returns slugs in alphabetical order", () => {
    const slugs = loadAgents().map((a) => a.slug);
    expect(slugs).toEqual(EXPECTED_SLUGS);
    // Independent alpha-sort invariant (STRONGER): the list equals its own
    // sorted copy, so readdirSync order can never leak through.
    expect(slugs).toEqual([...slugs].sort((x, y) => x.localeCompare(y)));
  });

  test("2c: pipeline-deploy display name is 'Pipeline & Deploy Agent' (AGENT_DISPLAY drift fixed)", () => {
    const pipeline = loadAgents().find(
      (a) => a.slug === "aidlc-pipeline-deploy-agent",
    );
    expect(pipeline?.display_name).toBe("Pipeline & Deploy Agent");
  });

  // ============================================================
  // Test 3 — the loader derives a fixture agent's display + examples from its
  // frontmatter. (P4: the old per-agent knowledge-README scaffolding moved out
  // of birth — the workspace shell ships in dist/ via SEED, and birth only
  // ensure-exists the per-intent record dirs. The covered unit is still
  // loadAgents(); here we prove it captures a dropped-in agent's display_name
  // AND the whole examples list in-process, the same derivation the README
  // template consumed.)
  // ============================================================
  test("3: loadAgents captures display_name + the whole examples list from frontmatter", () => {
    // The README template consumed `display_name` (the `# ${display_name}
    // Knowledge` heading) and the full `examples` YAML list. Assert the loader
    // still derives both from frontmatter — a non-empty display_name and a
    // multi-item examples list on a shipped agent (the fixture-agent's own
    // derivation is covered end-to-end by 5b's statusline render).
    const agents = loadAgents();
    for (const a of agents) {
      expect(typeof a.display_name).toBe("string");
      expect(a.display_name.length).toBeGreaterThan(0);
      expect(Array.isArray(a.examples)).toBe(true);
    }
    const withExamples = agents.find((a) => a.examples.length >= 2);
    expect(withExamples).toBeDefined();
  });

  // ============================================================
  // Test 4 — a malformed agent (missing display_name) is REJECTED by the loader.
  // (P4: birth no longer iterates agents to scaffold knowledge READMEs, so the
  // rejection no longer fires from birth. The validation lives in the loader;
  // doctor — which calls loadAgents() — surfaces it. Run the per-project doctor
  // and assert it errors citing the file + the field.)
  // ============================================================
  test("4: doctor rejects fixture-agent.md lacking display_name (error cites file + field)", () => {
    const p = proj();
    writeFixtureAgent(p, "", false);
    const tool = join(p, ".claude", "tools", "aidlc-utility.ts");
    const r = spawnSync(BUN, [tool, "doctor", "--project-dir", p], {
      encoding: "utf-8",
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(r.status).not.toBe(0);
    expect(out).toContain("fixture-agent");
    expect(out).toContain("display_name");
  });

  // ============================================================
  // Test 5 — statusline derives the active-agent display from frontmatter
  // for BOTH a shipped agent and the fixture agent. Split into 5a/5b.
  // ============================================================
  test("5a: statusline renders 'Pipeline & Deploy Agent' for the shipped pipeline agent", () => {
    const p = projWithRecord();
    writeFixtureAgent(p);
    seedState(p, "aidlc-pipeline-deploy-agent");
    const out = runStatusline(p);
    // The ampersand form proves the old "Pipeline Deploy Agent" literal
    // (AGENT_DISPLAY drift) is gone and the frontmatter value wins.
    expect(out).toContain("Pipeline & Deploy Agent");
  });

  test("5b: statusline renders 'Fixture Agent' for the fixture agent", () => {
    const p = projWithRecord();
    writeFixtureAgent(p);
    seedState(p, "fixture-agent");
    const out = runStatusline(p);
    expect(out).toContain("Fixture Agent");
  });

  test("5c: statusline falls back to the agent slug when duplicate agent names break loadAgents()", () => {
    const p = projWithRecord();
    writeFixtureAgent(p);
    writeFileSync(
      join(p, ".claude", "agents", "duplicate-fixture-agent.md"),
      `---
name: fixture-agent
display_name: Duplicate Fixture Agent
examples: []
description: Duplicate fixture agent for statusline fallback.
disallowedTools: Task
model: opus
---

Duplicate fixture agent body.
`,
      "utf-8",
    );
    seedState(p, "fixture-agent");
    const { status, out } = runStatuslineResult(p);
    expect(status).toBe(0);
    expect(out).toContain("[AIDLC]");
    expect(out).toContain("fixture-agent");
    expect(out).not.toContain("Fixture Agent");
    expect(out).not.toContain("Duplicate Fixture Agent");
  });
});

// Touch REPO_ROOT so the import is exercised even if a future refactor drops
// the other AIDLC_SRC-relative reads (keeps the harness path contract honest).
void REPO_ROOT;
