// covers: file:aidlc-common/protocols/stage-protocol.md §3 §5,
// file:skills/aidlc/SKILL.md per-unit wave paragraph
//
// t244 - batch-parallel per-unit waves (#610, floor version). The conductor
// MAY widen a gate:false per-unit design directive into a Bolt-DAG batch wave
// (one concurrent stage-body dispatch per uncovered batch unit) with §12a
// reviewers dispatched at wave end as parallel FOREGROUND tasks where no
// reviewer-scope dispatch record is active. Conductor-prose only - the engine
// is untouched (its per-unit coverage is a stateless disk scan). This test
// pins the load-bearing sentences on every surface that carries them - the
// five authored harness SKILL.md files, their dist copies, and the shared
// stage-protocol §3 wave paragraph + §5 topology carve-out (authored core +
// per-harness dist copies) - so a prose sweep cannot silently drop:
//   (a) the MAY-not-MUST framing (harnesses without parallel dispatch fall
//       back to the serial loop, which stays fully correct),
//   (b) the unit-major exclusion (waves apply to the stage-major walk only),
//   (c) the builder write confinement to construction/<unit>/<stage>/ (the
//       sentence that keeps a wave from racing shared files) + the
//       no-stage-level-diary rule (conductor consolidates per wave),
//   (d) the never-present-the-gate-with-an-outstanding-reviewer rule (the
//       wait is deferred, not skipped),
//   (e) the enforcement constraint: parallel foreground reviewers only where
//       no reviewer-scope dispatch record is active - the record is a single
//       file, so enforcement harnesses serialize per-unit reviews.
//
// Mechanism: none (readFileSync over authored + dist prose; zero spawn, zero
// LLM). Style follows t217: iterate HARNESS_MATRIX so a new harness cannot
// ship without the wave paragraph, and read dist through each harness's
// matrix roots so byte-parity drift in a generated copy also reds here.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const SKILL = "skills/aidlc/SKILL.md";
const PROTOCOL = join("aidlc-common", "protocols", "stage-protocol.md");

/** The load-bearing wave sentences every conductor SKILL must carry. */
function expectWaveParagraph(labelled: string): void {
  // The paragraph exists and is anchored to the per-unit loop.
  expect(labelled).toContain("**Per-unit batch waves (optional).**");
  // (a) MAY, never MUST - with the serial loop staying fully correct.
  expect(labelled).toMatch(/you MAY process a `gate: false` per-unit directive/);
  expect(labelled).toMatch(
    /The wave is a MAY, never a MUST: the serial loop above remains fully correct\./,
  );
  // (b) unit-major exclusion: waves ride the default stage-major walk only.
  expect(labelled).toMatch(
    /On the default stage-major walk only — when `Construction Iteration: unit-major` is recorded the walk stays serial/,
  );
  // The wave source: bolt_dag.batches from the intent's runtime-graph.json,
  // filtered to units whose artifacts for THIS stage are not yet on disk.
  expect(labelled).toMatch(/read `bolt_dag\.batches` from the intent's `runtime-graph\.json`/);
  expect(labelled).toMatch(
    /the wave = that batch's units whose artifacts for THIS stage are not yet on disk/,
  );
  // (c) builder write confinement + no stage-level diary + questions surface
  // in the return message (never a mid-dispatch stop).
  expect(labelled).toMatch(
    /Each builder is confined to its own `construction\/<unit>\/<stage>\/`/,
  );
  expect(labelled).toMatch(
    /builders must NOT write any stage-level diary \(the conductor appends one consolidated diary entry per wave\)/,
  );
  expect(labelled).toMatch(
    /human-blocking question surfaces in the builder's return message/,
  );
  // (d) the gate is never presented with a reviewer outstanding.
  expect(labelled).toMatch(
    /never present the gate with a reviewer outstanding or a NOT-READY unresolved within its iteration budget — the wait is deferred, not skipped\./,
  );
  // The loop re-entry stays engine-owned: re-run next, never report-approve.
  expect(labelled).toMatch(/re-run `next` exactly as above \(do NOT report-approve/);
  // Crash recovery rides the same stateless disk scan.
  expect(labelled).toMatch(/`next` re-hands whatever is still uncovered/);
}

describe("t244 per-unit wave paragraph on every conductor SKILL surface", () => {
  test("authored harness SKILL.md files carry the wave paragraph", () => {
    for (const harness of HARNESS_MATRIX) {
      const path = join(harness.authoredRoot, SKILL);
      expectWaveParagraph(`harness ${harness.name}: ${path}\n${readFileSync(path, "utf-8")}`);
    }
  });

  test("dist SKILL.md copies carry the wave paragraph", () => {
    for (const harness of HARNESS_MATRIX) {
      const path = join(harness.skillsRoot, "aidlc", "SKILL.md");
      expectWaveParagraph(`harness ${harness.name}: ${path}\n${readFileSync(path, "utf-8")}`);
    }
  });

  test("the enforcement constraint is stated per harness capability", () => {
    for (const harness of HARNESS_MATRIX) {
      const path = join(harness.authoredRoot, SKILL);
      const body = `harness ${harness.name}: ${path}\n${readFileSync(path, "utf-8")}`;
      if (harness.capabilities.reviewerScopeRegistration === "unsupported") {
        // Kiro IDE: no reviewer-scope hook, so the wave's reviewers may run as
        // parallel foreground dispatches (prose bound rides in each brief).
        expect(body).toMatch(
          /this harness has no reviewer-scope enforcement hook, so the wave's reviewers MAY be dispatched as parallel FOREGROUND/,
        );
      } else {
        // (e) enforcement harnesses: the single-file dispatch record
        // serializes per-unit reviews - write record, review, delete, next.
        expect(body).toMatch(
          /allowed ONLY where no reviewer-scope dispatch record is active/,
        );
        expect(body).toMatch(
          /the dispatch record is a single file, so per-unit reviews here serialize: write the record, review, delete, then the next unit\./,
        );
      }
    }
  });
});

/** The protocol-level (§3) wave paragraph, harness-neutral wording. */
function expectProtocolWave(labelled: string): void {
  expect(labelled).toContain("**Per-unit batch waves (optional, stage-major only).**");
  // MAY not MUST, harness capability decides.
  expect(labelled).toMatch(/the orchestrator MAY parallelize the loop above/);
  expect(labelled).toMatch(
    /the wave is a MAY, never a MUST, and the serial loop remains fully correct/,
  );
  // Unit-major exclusion.
  expect(labelled).toMatch(
    /When `Construction Iteration: unit-major` is recorded, the walk stays serial — waves apply to the default stage-major walk only\./,
  );
  // Confinement + consolidated diary.
  expect(labelled).toMatch(
    /Each builder is confined to its own `construction\/<unit>\/<stage>\/`/,
  );
  expect(labelled).toMatch(
    /no builder writes a stage-level diary \(the orchestrator appends one consolidated diary entry per wave\)/,
  );
  // Gate discipline.
  expect(labelled).toMatch(
    /the gate is never presented with a reviewer outstanding or a NOT-READY unresolved within its iteration budget — the wait is deferred, not skipped\./,
  );
  // Enforcement constraint at protocol level: foreground-parallel reviewers
  // only with no active dispatch record; the single-file record serializes.
  expect(labelled).toMatch(
    /parallel FOREGROUND dispatches in one turn only on a harness\/path with no active reviewer-scope dispatch record/,
  );
  expect(labelled).toMatch(
    /the single-file record serializes per-Unit reviews \(write record → review → delete → next\)/,
  );
}

/** The §5 topology carve-out: a wave is loop parallelization, not a mode. */
function expectTopologyCarveOut(labelled: string): void {
  expect(labelled).toContain("**Per-unit-wave carve-out.**");
  expect(labelled).toMatch(
    /a parallelization of the engine's per-Unit loop, NOT a communication topology/,
  );
  // The lead persona runs per unit.
  expect(labelled).toMatch(
    /Each wave dispatch runs the stage's LEAD persona for exactly ONE Unit/,
  );
  // mode: inline's "supports are voices" folds into each builder's brief.
  expect(labelled).toMatch(
    /the "supports are voices" rule folds into each builder's brief/,
  );
}

describe("t244 stage-protocol §3 wave paragraph + §5 carve-out", () => {
  test("authored core stage-protocol.md carries the §3 wave paragraph and §5 carve-out", () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    const path = join(repoRoot, "core", PROTOCOL);
    const body = `core: ${path}\n${readFileSync(path, "utf-8")}`;
    expectProtocolWave(body);
    expectTopologyCarveOut(body);
  });

  test("dist stage-protocol.md copies carry the §3 wave paragraph and §5 carve-out", () => {
    for (const harness of HARNESS_MATRIX) {
      const path = join(harness.engineRoot, PROTOCOL);
      const body = `harness ${harness.name}: ${path}\n${readFileSync(path, "utf-8")}`;
      expectProtocolWave(body);
      expectTopologyCarveOut(body);
    }
  });

  test("§5 carve-out sits inside the Multi-agent stages section, and the §3 paragraph follows the engine-driven per-unit prose", () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    const body = readFileSync(join(repoRoot, "core", PROTOCOL), "utf-8");
    // §3 ordering: engine-driven per-unit prose first, wave paragraph second,
    // unit-major opt-in after (the wave paragraph parallelizes the loop the
    // preceding paragraph defines).
    const engineDriven = body.indexOf("**Engine-driven per-unit iteration.**");
    const wave = body.indexOf("**Per-unit batch waves (optional, stage-major only).**");
    const unitMajor = body.indexOf("**Unit-major iteration (opt-in).**");
    expect(engineDriven).toBeGreaterThan(-1);
    expect(wave).toBeGreaterThan(engineDriven);
    expect(unitMajor).toBeGreaterThan(wave);
    // §5 placement: the carve-out lives in the Multi-agent stages section,
    // before §11 (the next numbered heading after §5's content).
    const multiAgent = body.indexOf("### Multi-agent stages");
    const carveOut = body.indexOf("**Per-unit-wave carve-out.**");
    const section11 = body.indexOf("## 11. Subagent Return Summary");
    expect(multiAgent).toBeGreaterThan(-1);
    expect(carveOut).toBeGreaterThan(multiAgent);
    expect(carveOut).toBeLessThan(section11);
  });
});
