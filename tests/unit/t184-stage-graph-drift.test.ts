// covers: function:stageGraphDrift, hook:aidlc-session-start, subcommand:aidlc-utility:doctor
//
// t184 -- stage-graph <-> disk drift detection (issue #364). The runtime resolves
// stages from the compiled stage-graph.json only (loadGraph), never by scanning
// the stage `.md` files. So a stage `.md` added to disk WITHOUT recompiling is
// silently never executed. This suite proves the guardrail that surfaces that:
//
//   1. function:stageGraphDrift (aidlc-graph.ts) -- the deterministic two-source
//      set-difference, in-process, driven through the AIDLC_STAGE_GRAPH +
//      AIDLC_STAGES_DIR seams so both sources point at a temp tree. Proves BOTH
//      directions (graph->disk missingFiles, disk->graph uncompiledStages) AND the
//      in-sync zero case.
//   2. subcommand:aidlc-utility:doctor -- the disk->graph drift surfaces as an
//      ADVISORY row (pass:true, does NOT fail the doctor exit code, mirroring
//      the rule-drift / MERGE_DISPATCH advisory rows). Driven by SPAWNING the
//      sandbox doctor against a setupIntegrationProject copy with an extra stage
//      file injected (the doctor pins stages off its own module dir, so a
//      sandbox copy is required, same discipline as t129).
//   3. hook:aidlc-session-start -- the same drift injects a non-blocking NOTE into
//      the SessionStart additionalContext, fail-open. Driven by SPAWNING the
//      sandbox hook (CLAUDE_PROJECT_DIR=<sandbox>), mirroring t10.
//
// The negative (drift) cases MUST actually fire: a stage file present on disk
// but absent from the compiled graph must be NAMED in both the doctor advisory
// and the hook NOTE, not a happy path that only proves the in-sync case.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  seedStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test

// In-process helper under test, plus the shipped sources for the seam runs.
import { compileStageGraph, stageGraphDrift } from "../../core/tools/aidlc-graph.ts";
const STAGE_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");
const MID_IDEATION = join(REPO_ROOT, "tests", "fixtures", "state-mid-ideation.md");

// A realistic custom stage file: valid-enough frontmatter, dropped into a phase
// directory the way a harness engineer extending the workflow would (issue #364
// repro step 1). The slug is what both surfaces must NAME.
const CUSTOM_SLUG = "my-custom-stage";
const CUSTOM_STAGE_MD = [
  "---",
  `slug: ${CUSTOM_SLUG}`,
  "phase: construction",
  "execution: ALWAYS",
  "lead_agent: aidlc-developer-agent",
  "mode: inline",
  "---",
  "# My custom stage",
  "",
  "A stage added to disk but never compiled into the graph.",
  "",
].join("\n");

const sandboxes: string[] = [];
afterAll(() => {
  for (const p of sandboxes) cleanupTestProject(p);
});

function newSandbox(): string {
  const proj = setupIntegrationProject({});
  sandboxes.push(proj);
  return proj;
}

function sandboxStagesDir(proj: string): string {
  return join(proj, ".claude", "aidlc-common", "stages", "construction");
}

interface SpawnResult {
  status: number;
  out: string; // combined stdout+stderr
}

/** Spawn the sandbox's own doctor (resolves stages off its module dir). */
function doctor(proj: string): SpawnResult {
  const util = join(proj, ".claude", "tools", "aidlc-utility.ts");
  const r = spawnSync(BUN, [util, "doctor", "--project-dir", proj], {
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Fire the sandbox's session-start hook, returning the decoded additionalContext. */
function sessionStartContext(proj: string): string {
  const hook = join(proj, ".claude", "hooks", "aidlc-session-start.ts");
  const r = Bun.spawnSync({
    cmd: [BUN, hook],
    stdin: new TextEncoder().encode('{"source":"startup"}'),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  const stdout = new TextDecoder().decode(r.stdout);
  return JSON.parse(stdout.trim()).additionalContext as string;
}

describe("t184 stage-graph drift detection (issue #364)", () => {
  // ===========================================================================
  // 1. stageGraphDrift() -- the deterministic two-source set-difference.
  // ===========================================================================
  describe("function:stageGraphDrift (in-process, via env seams)", () => {
    test("the shipped tree is in sync: no drift in either direction", () => {
      const prevG = process.env.AIDLC_STAGE_GRAPH;
      const prevS = process.env.AIDLC_STAGES_DIR;
      try {
        process.env.AIDLC_STAGE_GRAPH = STAGE_GRAPH;
        process.env.AIDLC_STAGES_DIR = STAGES_DIR;
        const d = stageGraphDrift();
        expect(d.missingFiles).toEqual([]);
        expect(d.uncompiledStages).toEqual([]);
      } finally {
        if (prevG === undefined) delete process.env.AIDLC_STAGE_GRAPH;
        else process.env.AIDLC_STAGE_GRAPH = prevG;
        if (prevS === undefined) delete process.env.AIDLC_STAGES_DIR;
        else process.env.AIDLC_STAGES_DIR = prevS;
      }
    });

    test("disk->graph: a stage file not in the graph appears in uncompiledStages", () => {
      // Copy the shipped stages into a temp tree, add one uncompiled stage, and
      // point AIDLC_STAGES_DIR at the copy while the graph stays the shipped one.
      const tmp = join(
        REPO_ROOT,
        "tests",
        "fixtures",
        `.t184-stages-${process.pid}`,
      );
      const prevG = process.env.AIDLC_STAGE_GRAPH;
      const prevS = process.env.AIDLC_STAGES_DIR;
      try {
        rmSync(tmp, { recursive: true, force: true });
        // Cheap copy: only the construction phase dir (the helper globs all
        // PHASES; an absent phase dir is skipped, so a single phase is enough to
        // prove the diff without copying the whole tree).
        mkdirSync(join(tmp, "construction"), { recursive: true });
        writeFileSync(
          join(tmp, "construction", `${CUSTOM_SLUG}.md`),
          CUSTOM_STAGE_MD,
          "utf-8",
        );
        process.env.AIDLC_STAGE_GRAPH = STAGE_GRAPH;
        process.env.AIDLC_STAGES_DIR = tmp;
        const d = stageGraphDrift();
        expect(d.uncompiledStages).toContain(CUSTOM_SLUG);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        if (prevG === undefined) delete process.env.AIDLC_STAGE_GRAPH;
        else process.env.AIDLC_STAGE_GRAPH = prevG;
        if (prevS === undefined) delete process.env.AIDLC_STAGES_DIR;
        else process.env.AIDLC_STAGES_DIR = prevS;
      }
    });

    test("graph->disk: a graph slug with no file on disk appears in missingFiles", () => {
      // Empty stages dir + the full shipped graph -> every graph slug is missing.
      const tmp = join(
        REPO_ROOT,
        "tests",
        "fixtures",
        `.t184-empty-${process.pid}`,
      );
      const prevG = process.env.AIDLC_STAGE_GRAPH;
      const prevS = process.env.AIDLC_STAGES_DIR;
      try {
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(tmp, { recursive: true });
        process.env.AIDLC_STAGE_GRAPH = STAGE_GRAPH;
        process.env.AIDLC_STAGES_DIR = tmp;
        const d = stageGraphDrift();
        expect(d.missingFiles.length).toBeGreaterThan(0);
        // Result is sorted, deterministic.
        expect(d.missingFiles).toEqual([...d.missingFiles].sort());
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        if (prevG === undefined) delete process.env.AIDLC_STAGE_GRAPH;
        else process.env.AIDLC_STAGE_GRAPH = prevG;
        if (prevS === undefined) delete process.env.AIDLC_STAGES_DIR;
        else process.env.AIDLC_STAGES_DIR = prevS;
      }
    });

    test("compile fails loudly when a stage .md sits in a non-canonical phase directory", () => {
      // A stage .md dropped into a phase dir whose name is not one of the five
      // canonical PHASES cannot be placed on the numeric spine. compile must
      // throw (fail loud), naming the offending phase directory, rather than
      // invent a prefix. The throw keys on the DIRECTORY name, not the
      // frontmatter `phase:` field — so this stage carries fully valid, schema-
      // passing frontmatter (a canonical `phase: construction`) and the only
      // anomaly is the bogus directory it lives in. Driven through the
      // AIDLC_STAGES_DIR seam at a temp tree.
      const validStageMd = [
        "---",
        "slug: bogus-phase-stage",
        "phase: construction",
        "execution: ALWAYS",
        "condition: Always.",
        "lead_agent: aidlc-developer-agent",
        "support_agents: []",
        "mode: inline",
        "produces: []",
        "consumes: []",
        "requires_stage: []",
        "inputs: none",
        "outputs: none",
        "---",
        "# Bogus phase stage",
        "",
        "Valid frontmatter, but in a non-canonical phase directory.",
        "",
      ].join("\n");
      const tmp = join(
        REPO_ROOT,
        "tests",
        "fixtures",
        `.t184-bogusphase-${process.pid}`,
      );
      const prevG = process.env.AIDLC_STAGE_GRAPH;
      const prevS = process.env.AIDLC_STAGES_DIR;
      try {
        rmSync(tmp, { recursive: true, force: true });
        // A bogus (non-canonical) phase directory with one new stage .md. The
        // slug is absent from the shipped graph, so compile hits the auto-seed
        // branch, where PHASES.indexOf("bogusphase") === -1 fails loud.
        mkdirSync(join(tmp, "bogusphase"), { recursive: true });
        writeFileSync(
          join(tmp, "bogusphase", "bogus-phase-stage.md"),
          validStageMd,
          "utf-8",
        );
        process.env.AIDLC_STAGE_GRAPH = STAGE_GRAPH;
        process.env.AIDLC_STAGES_DIR = tmp;
        expect(() => compileStageGraph()).toThrow(/unknown phase directory/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
        if (prevG === undefined) delete process.env.AIDLC_STAGE_GRAPH;
        else process.env.AIDLC_STAGE_GRAPH = prevG;
        if (prevS === undefined) delete process.env.AIDLC_STAGES_DIR;
        else process.env.AIDLC_STAGES_DIR = prevS;
      }
    });
  });

  // ===========================================================================
  // 2. doctor -- disk->graph drift is an ADVISORY (pass:true, does not fail exit).
  // ===========================================================================
  describe("subcommand:aidlc-utility:doctor -- uncompiled-stage advisory", () => {
    test("clean sandbox: doctor reports 0 uncompiled stage files", () => {
      const proj = newSandbox();
      const r = doctor(proj);
      expect(r.out).toContain(
        "Uncompiled stage files: 0 stage files missing from the compiled graph",
      );
    }, 30000);

    test("drifted sandbox: doctor NAMES the uncompiled stage as an advisory, exit stays 0", () => {
      const proj = newSandbox();
      mkdirSync(sandboxStagesDir(proj), { recursive: true });
      writeFileSync(
        join(sandboxStagesDir(proj), `${CUSTOM_SLUG}.md`),
        CUSTOM_STAGE_MD,
        "utf-8",
      );
      const r = doctor(proj);
      // The advisory fired and NAMED the slug (drift surfaced, not silent).
      expect(r.out).toContain("not in the compiled graph");
      expect(r.out).toContain(CUSTOM_SLUG);
      expect(r.out).toContain("aidlc-graph.ts compile");
      // ADVISORY: an uncompiled stage alone must NOT fail the health check.
      // (A clean sandbox doctor exits 0; injecting only this drift keeps it 0.)
      expect(r.status).toBe(0);
    }, 30000);
  });

  // ===========================================================================
  // 3. session-start hook -- non-blocking drift NOTE in additionalContext.
  // ===========================================================================
  describe("hook:aidlc-session-start -- drift advisory in additionalContext", () => {
    test("clean sandbox: no drift NOTE injected", () => {
      const proj = newSandbox();
      seedStateFile(proj, MID_IDEATION);
      const ctx = sessionStartContext(proj);
      expect(ctx).toContain("AIDLC WORKFLOW ACTIVE");
      expect(ctx).not.toContain("not in the compiled stage graph");
    }, 30000);

    test("drifted sandbox: NOTE names the uncompiled stage and the compile command", () => {
      const proj = newSandbox();
      seedStateFile(proj, MID_IDEATION);
      mkdirSync(sandboxStagesDir(proj), { recursive: true });
      writeFileSync(
        join(sandboxStagesDir(proj), `${CUSTOM_SLUG}.md`),
        CUSTOM_STAGE_MD,
        "utf-8",
      );
      const ctx = sessionStartContext(proj);
      expect(ctx).toContain("not in the compiled stage graph");
      expect(ctx).toContain(CUSTOM_SLUG);
      expect(ctx).toContain("aidlc-graph.ts compile");
      // Hook still emits its normal workflow context (advisory is additive).
      expect(ctx).toContain("AIDLC WORKFLOW ACTIVE");
    }, 30000);
  });
});
