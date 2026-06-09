// covers:
//
// t-custom-harness-compile — the Phase-5 Harness-Engineer DETERMINISTIC tier.
//
// The companion to the live {sdk,tui} journey (t-tui-custom-harness): this file
// proves a harness engineer's DATA-ONLY reshaping resolves correctly at COMPILE
// time, with NO driver and NO Bedrock tokens (the registry derives the `—`
// floor mechanism from the absence of any driveAidlc / tui-drive spawn). It runs
// always, on every platform, with the same verdict — the OS-invariant floor the
// live tier builds on.
//
// WHAT A HARNESS ENGINEER DOES (docs/harness/00-overview.md): reshape the
// framework WITHOUT code by editing DATA — a custom scope, custom stages, how
// stages join up (requires_stage + a produce->consume artefact chain), bound
// sensors, and rules. The customHarness fixture (tests/harness/custom-harness.ts)
// seeds exactly that: a `data-migration` scope routing a two-stage chain
// (schema-snapshot -> migration-plan), a custom `schema-validator` sensor, and a
// unique project-rule marker.
//
// THE GAP IT FILLS — error paths. The golden "the edit resolves" path had some
// coverage; the harness engineer's ERROR modes (a typo'd sensor id, a dangling
// requires_stage edge, a forgotten stage-graph row, an orphan consume) were
// COMPLETELY UNTESTED. A harness engineer hits these constantly — they are the
// framework's contract with its reshaper. Each error test below seeds a VALID
// customHarness project, then mutates ONE thing to trip ONE guard, and asserts
// the compiler (or validate-scope) FAILS LOUD with the SPECIFIC guard message —
// not just any failure. The exact strings were captured from the live guards
// before coding (verify-never-guess), each cited to its throw site.
//
// IRON RULE: every assertion checks a real, on-disk, deterministic signal (exit
// code + the specific stderr substring). A guard that stops throwing — or starts
// throwing the wrong message — is a real regression in the framework's contract
// with harness engineers, surfaced here, never softened.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CUSTOM_RULE_MARKER,
  CUSTOM_SCOPE,
  CUSTOM_SENSOR_ID,
  PLAN_ARTIFACT,
  PLAN_OUTPUT_REL,
  PLAN_STAGE_NUMBER,
  PLAN_STAGE_SLUG,
  SNAPSHOT_ARTIFACT,
  SNAPSHOT_OUTPUT_REL,
  SNAPSHOT_STAGE_NUMBER,
  SNAPSHOT_STAGE_PHASE,
  SNAPSHOT_STAGE_SLUG,
} from "../harness/custom-harness.ts";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";

// ---------------------------------------------------------------------------
// Helpers — run the project's OWN copied tools (resolveProjectDir derives the
// temp project from the script path, exactly as a real install does).
// ---------------------------------------------------------------------------
interface Run {
  status: number;
  stdout: string;
  stderr: string;
}
function runTool(proj: string, tool: string, args: string[]): Run {
  const res = spawnSync("bun", [join(proj, ".claude", "tools", tool), ...args], {
    cwd: proj,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
const graph = (proj: string, args: string[]) => runTool(proj, "aidlc-graph.ts", args);

function stagePath(proj: string, phase: string, slug: string): string {
  return join(proj, ".claude", "aidlc-common", "stages", phase, `${slug}.md`);
}
function editFile(p: string, fn: (s: string) => string): void {
  writeFileSync(p, fn(readFileSync(p, "utf8")));
}

describe("t-custom-harness-compile (deterministic — harness-engineer edits resolve, errors fail loud)", () => {
  // =========================================================================
  // GOLDEN PATH — a well-formed custom harness compiles, routes, validates,
  // and shows up in both the compiled stage graph and the runtime graph.
  // =========================================================================

  // G1 — compile succeeds at seed time + `compile --check` is clean (the
  // emitted graph matches a fresh recompile; no drift from the seeding edits).
  test("G1: the seeded custom harness compiles and `compile --check` is clean", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      // The fixture already ran `compile` at seed time (it throws on failure),
      // so reaching here means compile succeeded. --check proves no drift.
      const check = graph(proj, ["compile", "--check"]);
      expect(check.status).toBe(0);
    } finally {
      cleanupTestProject(proj);
    }
  });

  // G2 — the custom scope routes EXACTLY the init trio + the two custom stages,
  // in numeric order. This is the "define a custom workflow (which stages run)"
  // dimension of harness engineering.
  test("G2: `aidlc-graph scope data-migration` routes the init trio + both custom stages", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      const r = graph(proj, ["scope", CUSTOM_SCOPE]);
      expect(r.status).toBe(0);
      const routed = r.stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean);
      expect(routed).toEqual([
        "workspace-scaffold",
        "workspace-detection",
        "state-init",
        SNAPSHOT_STAGE_SLUG,
        PLAN_STAGE_SLUG,
      ]);
    } finally {
      cleanupTestProject(proj);
    }
  });

  // G3 — the compiled stage-graph nodes carry the harness engineer's wiring:
  // the custom sensor in sensors_applicable, the project-rule path in
  // rules_in_context, the produced artefact, and the produce->consume chain
  // edge. This is the "how stages join up + what artefacts get produced + bind
  // sensors + teach rules" dimension, proven as compiled DATA on disk.
  test("G3: compiled nodes carry the sensor, rule path, produces, and the produce->consume chain", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      const graphJson = JSON.parse(
        readFileSync(join(proj, ".claude", "tools", "data", "stage-graph.json"), "utf8"),
      ) as Array<{
        slug: string;
        produces?: string[];
        consumes?: Array<{ artifact: string; required: boolean }>;
        requires_stage?: string[];
        rules_in_context?: Array<{ path: string }>;
        sensors_applicable?: Array<{ id: string; matches?: string }>;
      }>;

      const head = graphJson.find((s) => s.slug === SNAPSHOT_STAGE_SLUG);
      const tail = graphJson.find((s) => s.slug === PLAN_STAGE_SLUG);
      // VACUOUS-PASS GUARD: both custom stages compiled into the graph.
      expect(head).toBeDefined();
      expect(tail).toBeDefined();

      // sensor wired (compile RESOLVED the `sensors:` import on both stages).
      // The fixture pre-seeds sensors_applicable: [] — only compile can fill it
      // (resolveSensorsForStage), and it copies the manifest's `matches` glob in.
      // Asserting the resolved glob proves compile ran the resolver, not that a
      // pre-seeded value persisted.
      for (const node of [head, tail]) {
        const entry = (node?.sensors_applicable ?? []).find((s) => s.id === CUSTOM_SENSOR_ID);
        expect(entry).toBeDefined();
        expect(entry?.matches).toBe("**/aidlc-docs/**");
      }

      // rule chain attached to BOTH stages by compile (resolveRulesForStage).
      // The fixture pre-seeds rules_in_context: [] — compile fills it. The
      // PHASE rule (aidlc-phase-inception.md) attaches because the stage's
      // `phase: inception` matches the rule filename — a value NO pre-seed
      // carries, so its presence is airtight proof compile resolved the chain.
      for (const node of [head, tail]) {
        const paths = (node?.rules_in_context ?? []).map((r) => r.path);
        expect(paths).toContain(".claude/rules/aidlc-project.md");
        expect(paths).toContain(".claude/rules/aidlc-phase-inception.md");
      }

      // what each stage produces (compile recomputes produces[] from the YAML
      // via buildGraphStage, then writeFileAtomic overwrites the whole file).
      expect(head?.produces).toContain(SNAPSHOT_ARTIFACT);
      expect(tail?.produces).toContain(PLAN_ARTIFACT);

      // THE CHAIN: migration-plan consumes schema-snapshot's artefact AND
      // declares the requires_stage edge — "how stages join up".
      expect((tail?.consumes ?? []).map((c) => c.artifact)).toContain(SNAPSHOT_ARTIFACT);
      expect(tail?.requires_stage).toContain(SNAPSHOT_STAGE_SLUG);
    } finally {
      cleanupTestProject(proj);
    }
  });

  // G4 — validate-scope is clean: migration-plan's required consume is satisfied
  // by an ON-PATH producer (schema-snapshot), so there is no orphan consume and
  // no off-path advisory. This is the "be accurate — seed artefacts that match
  // the scope" requirement, proven by the validator the framework ships.
  test("G4: `validate-scope data-migration` is clean (the consume is satisfied on-path)", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      const r = graph(proj, ["validate-scope", CUSTOM_SCOPE]);
      expect(r.status).toBe(0);
      // no [error] lines (validate-scope prints them to stderr before exit 1)
      expect(r.stderr).not.toContain("[error]");
    } finally {
      cleanupTestProject(proj);
    }
  });

  // G5 — the RUNTIME graph (built from audit/state, not compiled topology)
  // records the custom scope + the in-progress custom stage after a real init.
  // A harness engineer's custom scope/stage shows up in the runtime execution
  // record, not just the compile-time topology. (migration-plan only appears
  // once it actually starts in a live journey — the runtime graph is an
  // execution log, so init records the head stage as pending; asserting the
  // head + scope is the honest deterministic claim.)
  test("G5: a real init + runtime compile records the custom scope + routed stages in runtime-graph.json", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      const init = runTool(proj, "aidlc-utility.ts", ["init", "--scope", CUSTOM_SCOPE]);
      expect(init.status).toBe(0);

      // init routed to the custom head stage (the scope's stage map drove this,
      // not a builtin) — proven in state before the runtime graph is even built.
      const state = readFileSync(join(proj, "aidlc-docs", "aidlc-state.md"), "utf8");
      const current = state.match(/Current Stage\*\*:\s*(.+)/)?.[1]?.trim();
      expect(current).toBe(SNAPSHOT_STAGE_SLUG);

      const rt = runTool(proj, "aidlc-runtime.ts", ["compile"]);
      expect(rt.status).toBe(0);

      const runtime = JSON.parse(
        readFileSync(join(proj, "aidlc-docs", "runtime-graph.json"), "utf8"),
      ) as { scope?: string; stages?: Array<{ stage_slug: string }> };
      expect(runtime.scope).toBe(CUSTOM_SCOPE);

      // EXACT routed set after init: the init trio + the custom HEAD stage, in
      // order. migration-plan (the tail) does NOT appear yet — the runtime graph
      // is an EXECUTION log built from audit/state (not the compiled topology),
      // and the tail only starts once schema-snapshot's gate is answered in a
      // live journey. Asserting the precise 4-stage prefix (verified empirically)
      // proves the custom scope drove routing, not "any init produces a passing
      // shape". The tail's runtime appearance is covered by the live journey
      // (t-tui-custom-harness), which answers both gates.
      const slugs = (runtime.stages ?? []).map((s) => s.stage_slug);
      expect(slugs).toEqual([
        "workspace-scaffold",
        "workspace-detection",
        "state-init",
        SNAPSHOT_STAGE_SLUG,
      ]);
    } finally {
      cleanupTestProject(proj);
    }
  });

  // =========================================================================
  // ERROR PATHS — the BIG GAP. Each test seeds a VALID custom harness, mutates
  // ONE thing to trip ONE guard, and asserts compile (or validate-scope) fails
  // loud with the SPECIFIC message. Strings captured from the live guards;
  // each cite is the throw site in aidlc-graph.ts (or aidlc-stage-schema.ts).
  // =========================================================================

  // E1 — a stage imports a sensor id that has no manifest.
  // Guard: resolveSensorsForStage in aidlc-graph.ts.
  test("E1: unknown sensor id in a stage's `sensors:` fails compile", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      editFile(stagePath(proj, SNAPSHOT_STAGE_PHASE, SNAPSHOT_STAGE_SLUG), (s) =>
        s.replace(`- ${CUSTOM_SENSOR_ID}`, "- no-such-sensor"),
      );
      const r = graph(proj, ["compile"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('imports unknown sensor id "no-such-sensor"');
    } finally {
      cleanupTestProject(proj);
    }
  });

  // E2 — a requires_stage edge points at a slug no stage declares.
  // Guard: edge-local resolution in aidlc-graph.ts.
  test("E2: unknown requires_stage slug fails compile", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      editFile(stagePath(proj, SNAPSHOT_STAGE_PHASE, SNAPSHOT_STAGE_SLUG), (s) =>
        s.replace("- state-init", "- no-such-stage"),
      );
      const r = graph(proj, ["compile"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('Unknown requires_stage: "no-such-stage"');
    } finally {
      cleanupTestProject(proj);
    }
  });

  // E3 — a stage requires a HIGHER-numbered stage (the edge-local invariant:
  // every requires_stage dep must be lower-numbered). schema-snapshot (2.0)
  // requiring migration-plan (2.9) violates it.
  // Guard: edge-local invariant in aidlc-graph.ts.
  test("E3: a requires_stage edge to a higher-numbered stage fails compile (edge-local invariant)", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      editFile(stagePath(proj, SNAPSHOT_STAGE_PHASE, SNAPSHOT_STAGE_SLUG), (s) =>
        s.replace("- state-init", `- ${PLAN_STAGE_SLUG}`),
      );
      const r = graph(proj, ["compile"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("dependency must be lower-numbered");
      // names both stages + their numbers (so the message is actionable)
      expect(r.stderr).toContain(`"${SNAPSHOT_STAGE_SLUG}" (${SNAPSHOT_STAGE_NUMBER})`);
      expect(r.stderr).toContain(`"${PLAN_STAGE_SLUG}" (${PLAN_STAGE_NUMBER})`);
    } finally {
      cleanupTestProject(proj);
    }
  });

  // E4 — a stage .md exists but has no {slug,number,name} row pre-seeded in
  // stage-graph.json (the pre-seed contract for adding a new stage).
  // Guard: compileStageGraph in aidlc-graph.ts.
  test("E4: a stage .md with no stage-graph.json row fails compile (pre-seed contract)", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      // Write a new stage file WITHOUT pre-seeding its graph row.
      writeFileSync(
        stagePath(proj, SNAPSHOT_STAGE_PHASE, "unseeded-stage"),
        `---
slug: unseeded-stage
phase: ${SNAPSHOT_STAGE_PHASE}
execution: ALWAYS
condition: never seeded into stage-graph.json
lead_agent: orchestrator
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage: []
inputs: none
outputs: none
---
# Unseeded
`,
      );
      const r = graph(proj, ["compile"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("not found in stage-graph.json");
      expect(r.stderr).toContain("unseeded-stage");
    } finally {
      cleanupTestProject(proj);
    }
  });

  // E5 — two stage .md files declare the same slug.
  // Guard: duplicate-slug in aidlc-graph.ts.
  test("E5: two stage files with the same slug fail compile", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      const src = stagePath(proj, SNAPSHOT_STAGE_PHASE, SNAPSHOT_STAGE_SLUG);
      writeFileSync(stagePath(proj, SNAPSHOT_STAGE_PHASE, "dupe-snapshot"), readFileSync(src, "utf8"));
      const r = graph(proj, ["compile"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`Duplicate stage slug "${SNAPSHOT_STAGE_SLUG}"`);
    } finally {
      cleanupTestProject(proj);
    }
  });

  // E6 — a required frontmatter field is missing (drop `condition:`).
  // Guard: schema validation (Rule 4), surfaced by compileStageGraph.
  test("E6: a stage missing a required frontmatter field fails compile (schema)", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      editFile(stagePath(proj, SNAPSHOT_STAGE_PHASE, SNAPSHOT_STAGE_SLUG), (s) =>
        s.replace(/^condition:.*$/m, "# condition removed"),
      );
      const r = graph(proj, ["compile"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("schema validation failed");
      expect(r.stderr).toContain("missing required field: condition");
    } finally {
      cleanupTestProject(proj);
    }
  });

  // E7 — two sensor manifests claim the same id. The dup-id guard fires on the
  // SECOND file in sort order, so the dupe must sort AFTER the canonical
  // aidlc-schema-validator.md (aidlc-zdupe-validator.md does). A dupe sorting
  // BEFORE would trip the filename-stem-mismatch guard instead — both are valid
  // guards, but this asserts the duplicate-id one specifically.
  // Guard: loadSensors duplicate-id in aidlc-graph.ts.
  test("E7: two sensor manifests with the same id fail compile", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      const src = join(proj, ".claude", "sensors", `aidlc-${CUSTOM_SENSOR_ID}.md`);
      writeFileSync(
        join(proj, ".claude", "sensors", "aidlc-zdupe-validator.md"),
        readFileSync(src, "utf8"),
      );
      const r = graph(proj, ["compile"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`duplicate sensor id "${CUSTOM_SENSOR_ID}"`);
    } finally {
      cleanupTestProject(proj);
    }
  });

  // E8 — a stage requires an artefact NO stage on the path produces (orphan
  // consume). Caught by validate-scope, not compile (compile accepts a dangling
  // consume; validate-scope is the scope-dependency check). Mutate
  // migration-plan to consume a phantom artefact, recompile (compile rewrites
  // the graph from the .md), then validate-scope.
  // Guard: validateScope orphan-consume in aidlc-graph.ts.
  test("E8: an orphan consume (no producer) fails validate-scope", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      editFile(stagePath(proj, SNAPSHOT_STAGE_PHASE, PLAN_STAGE_SLUG), (s) =>
        s.replace(`- artifact: ${SNAPSHOT_ARTIFACT}`, "- artifact: phantom-artefact"),
      );
      // recompile so stage-graph.json reflects the broken consume...
      const recompile = graph(proj, ["compile"]);
      expect(recompile.status).toBe(0); // compile itself accepts a dangling consume
      // ...then validate-scope catches the orphan.
      const r = graph(proj, ["validate-scope", CUSTOM_SCOPE]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("no stage in the graph produces it");
      expect(r.stderr).toContain("phantom-artefact");
    } finally {
      cleanupTestProject(proj);
    }
  });

  // E9 (the live-error mode, proven DETERMINISTICALLY) — a harness engineer's
  // custom sensor whose `command:` points at a missing script. This is the
  // RUNTIME error mode (not a compile guard): compile accepts the manifest (a
  // command string is opaque to the compiler), but at fire time the PostToolUse
  // sensor-fire hook spawns the dispatcher, the dispatcher exits non-zero, and
  // the hook records a hook-drop AND STILL exits 0 — the advisory exit-0
  // contract (aidlc-sensor-fire.ts G5 :268; recordHookDrop :250-256). A broken
  // sensor must never block the workflow; it must surface as an advisory drop.
  //
  // Proven by invoking the REAL hook with a real PostToolUse payload over a
  // broken-sensor project at the custom stage — no driver, no Bedrock tokens,
  // same mechanism a live run hits, asserted on the deterministic drop file.
  // (The plan's "live error journey L3" — the verified mechanism is
  // deterministic, which is stronger than a token-spending live drive and routes
  // correctly per three-concerns: determinism is a tool's job.)
  test("E9: a sensor whose command is missing records a hook-drop and the hook still exits 0 (advisory contract)", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      // 1. BREAK the sensor — point its command at a script that doesn't exist.
      const manifest = join(proj, ".claude", "sensors", `aidlc-${CUSTOM_SENSOR_ID}.md`);
      editFile(manifest, (s) =>
        s.replace(
          "bun .claude/tools/aidlc-sensor-required-sections.ts",
          "bun .claude/tools/aidlc-DOES-NOT-EXIST.ts",
        ),
      );
      // compile still SUCCEEDS — a command string is opaque to the compiler.
      expect(graph(proj, ["compile"]).status).toBe(0);

      // 2. init to the custom stage (Current Stage = schema-snapshot) so the
      //    hook's active-stage lookup resolves the broken sensor.
      expect(runTool(proj, "aidlc-utility.ts", ["init", "--scope", CUSTOM_SCOPE]).status).toBe(0);

      // 3. write the artefact (the trigger) and invoke the REAL sensor-fire hook
      //    with the PostToolUse payload Claude Code would send for that Write.
      const artifact = join(proj, SNAPSHOT_OUTPUT_REL);
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, "## Summary\nseed\n## Origin\nschema-snapshot\n");
      const payload = JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: artifact },
      });
      const hook = spawnSync(
        "bun",
        [join(proj, ".claude", "hooks", "aidlc-sensor-fire.ts")],
        { cwd: proj, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, input: payload },
      );

      // THE CONTRACT: the hook exits 0 (never blocks) even though the sensor broke.
      expect(hook.status).toBe(0);

      // THE EVIDENCE: a hook-drop was recorded naming the broken sensor + the
      // dispatcher's missing-script reason (advisory surface, not silent).
      const dropFile = join(proj, "aidlc-docs", ".aidlc-hooks-health", "sensor-fire.drops");
      expect(existsSync(dropFile)).toBe(true);
      const drops = readFileSync(dropFile, "utf8");
      expect(drops).toContain(CUSTOM_SENSOR_ID);
      expect(drops).toContain("script missing on disk");
    } finally {
      cleanupTestProject(proj);
    }
  });

  // The custom rule marker reaches the agent's RESOLVED context — not just the
  // seeded file, but the file the COMPILED head-stage node points at. This is
  // the deterministic "the rule is in the agent's context" proof (surface 3a):
  // follow the rules_in_context path off the compiled node to the file on disk
  // and confirm the unique marker is there. (The live journey complements this
  // with surface 3b — the agent's written artefact CITES the marker.)
  test("the custom rule marker is reachable via the compiled head-stage's rules_in_context path", () => {
    const proj = setupIntegrationProject({ customHarness: true });
    try {
      const graphJson = JSON.parse(
        readFileSync(join(proj, ".claude", "tools", "data", "stage-graph.json"), "utf8"),
      ) as Array<{ slug: string; rules_in_context?: Array<{ path: string }> }>;
      const head = graphJson.find((s) => s.slug === SNAPSHOT_STAGE_SLUG);
      const projectRulePath = (head?.rules_in_context ?? [])
        .map((r) => r.path)
        .find((p) => p.endsWith("aidlc-project.md"));
      // VACUOUS-PASS GUARD: the compiled node really points at a project rule.
      expect(projectRulePath).toBeDefined();
      // follow that resolved path to the file the agent would read at runtime
      const ruleFile = join(proj, projectRulePath as string);
      expect(readFileSync(ruleFile, "utf8")).toContain(CUSTOM_RULE_MARKER);

      // the two artefact output paths are distinct + under aidlc-docs/ (the
      // chain writes two different files, both in the sensor's glob territory)
      expect(SNAPSHOT_OUTPUT_REL).not.toBe(PLAN_OUTPUT_REL);
      expect(SNAPSHOT_OUTPUT_REL.startsWith("aidlc-docs")).toBe(true);
      expect(PLAN_OUTPUT_REL.startsWith("aidlc-docs")).toBe(true);
    } finally {
      cleanupTestProject(proj);
    }
  });
});
