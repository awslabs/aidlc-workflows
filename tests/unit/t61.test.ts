// covers: function:loadAgents
//
// Mechanism: none. The contract under test is the agent-metadata loader
// `loadAgents()` (aidlc-lib.ts) - the single source of truth that
// every agent-metadata consumer reads, derived from `.claude/agents/*.md`
// frontmatter. Three things flow through that loader with NO code change
// when an agent file is added/dropped: (1) no AGENT_KNOWLEDGE / AGENT_DISPLAY
// literals are left in tools/+hooks/, (2) the loader itself returns the 14
// shipped agents alphabetically with the "Pipeline & Deploy Agent" display
// string, (3) two CONSUMERS of the loader - doctor's agent validation and the
// `aidlc-statusline.ts` hook - derive their output from that same frontmatter.
//
// WHY mechanism none (not cli): the keystone observable is the function
// `loadAgents()`, asserted IN-PROCESS by importing and calling it
// (covers KEY function:loadAgents directly — test 2). The two consumer
// proofs (doctor validation, statusline render) are exercised through the
// PER-PROJECT copies of the tool/hook: each test copies the shipped
// dist/claude/.claude into a fresh temp project (setupIntegrationProject),
// drops a fixture-agent.md under <proj>/.claude/agents/, then spawns the
// tool/hook FROM THAT PROJECT — so loadAgents() inside the subprocess
// resolves AGENTS_DIR relative to <proj>/.claude/agents (lib.ts,
// `import.meta.url`-relative), seeing the fixture agent. The statusline
// hook is mechanism=none (a hook driven by controlled stdin). An in-process
// call against the worktree-checkout lib.ts would read the SHIPPED agents
// dir, never the fixture variant, so the reject/fixture-render assertions
// could not be reproduced without spawning the per-project copies.

import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadAgents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/**
 * Fresh integration project with the shipped .claude copied in, the scaffolded
 * intent record removed (the no-workspace path) and the env-scope stripped from
 * its settings.json.
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
 * Drop a fixture-agent.md under <proj>/.claude/agents/. `includeDisplay=false`
 * writes the broken variant that omits display_name (the reject case).
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

function runStatuslineResult(p: string): { status: number | null; out: string } {
  const hook = join(p, ".claude", "hooks", "aidlc-statusline.ts");
  const res = spawnSync(BUN, [hook], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: p,
    encoding: "utf-8",
    input: JSON.stringify({ workspace: { project_dir: p } }),
  });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function runStatusline(p: string): string {
  return runStatuslineResult(p).out;
}

function seedState(p: string, activeAgent: string): void {
  // The statusline reads the ACTIVE INTENT's state (stateFilePathForSelection), so
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
  // Test 1 - static grep: no AGENT_KNOWLEDGE / AGENT_DISPLAY literals in
  // tools/ + hooks/; loadAgents() is the one source of agent metadata.
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
    expect(offenders).toEqual([]);
  });

  // ============================================================
  // Test 2 — loadAgents() runtime contract (KEY: function:loadAgents).
  // ============================================================
  test("2a: loadAgents() returns the 14 shipped agents", () => {
    expect(loadAgents().length).toBe(14);
  });

  test("2b: loadAgents() returns slugs in alphabetical order", () => {
    const slugs = loadAgents().map((a) => a.slug);
    expect(slugs).toEqual(EXPECTED_SLUGS);
    // Independent alpha-sort invariant: the list equals its own
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
  // Test 3 - the loader derives shipped agents' display + examples from their
  // frontmatter. The covered unit is loadAgents(); here we prove it captures
  // display_name AND a multi-item examples list in-process.
  // ============================================================
  test("3: loadAgents captures display_name + the whole examples list from frontmatter", () => {
    // Assert the loader derives both from frontmatter - a non-empty display_name
    // and a multi-item examples list on a shipped agent (the fixture-agent's own
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
  // The validation lives in the loader; doctor - which calls loadAgents() -
  // surfaces it. Run the per-project doctor and assert it errors citing the
  // file + the field.
  // ============================================================
  test("4: doctor rejects fixture-agent.md lacking display_name (error cites file + field)", () => {
    const p = proj();
    writeFixtureAgent(p, "", false);
    const tool = join(p, ".claude", "tools", "aidlc-utility.ts");
    const r = spawnSync(BUN, [tool, "doctor", "--project-dir", p], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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
