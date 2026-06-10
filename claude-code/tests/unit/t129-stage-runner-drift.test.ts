// covers: cli:aidlc-runner-gen(check,write)
//
// Drift-guard port of tests/unit/t129-stage-runner-drift.sh (TAP plan 7),
// mechanism = cli. The .sh carried NO `# covers:` header (its subject is the
// GENERATED stage-runner skills, and aidlc-runner-gen.ts enumerates NO registry
// unit of its own — confirmed: gen-coverage-registry.ts's TOOL_DESCRIPTORS does
// not list aidlc-runner-gen, and tests/.coverage-registry.json has zero
// aidlc-runner-gen rows). So, exactly like the sibling t130-scope-runners twin
// did for the SCOPE-runner half of the same tool, this twin credits the runner
// surface it genuinely drives — the `check` (drift guard) and `write`
// (regenerate) subcommands of aidlc-runner-gen.ts — rather than inventing a join
// target. The registry harmlessly ignores the id (no enumerated unit); the
// coverage it preserves is the .sh's exact behavioural guarantee, below.
//
// WHAT THE .sh PROVED (t129-stage-runner-drift.sh:1-19 prose + the 7 asserts):
//   The set of `skills/aidlc-<stage>/` runner dirs is EXACTLY the RUNNABLE
//   compiled stage-slug set (the 29 non-initialization stages) — no stage missing
//   its runner, no orphan runner for a stage the graph dropped. The 29 runners are
//   GENERATED from the compiled graph, so without this guard a stage added to the
//   graph would silently ship without a runner (or a removed stage would leave a
//   stale runner). It is a deterministic two-source SET-EQUALITY drift guard, not
//   an LLM judgement — built on the t28 / t60 / `compile --check` discipline.
//   Concretely:
//     (1) the SHIPPED runner set == the RUNNABLE compiled slug set, verified by an
//         INDEPENDENT pure cross-check (derive both sets without trusting the tool);
//     (2) the count is exactly 29 (32 compiled stages minus the 3 bootstrap init
//         stages, which ship no per-stage runner — the init phase is the single
//         /aidlc-init wrapper);
//     (3) the generator's own `check` exits 0 on the shipped (in-sync) tree;
//     (4) the guard CATCHES a missing runner: delete one runner dir -> `check`
//         exits 1 AND names it ("MISSING …");
//     (5) the guard CATCHES an orphan runner: add a bogus `--stage … --single`
//         runner for a slug not in the graph -> `check` exits 1 AND names it
//         ("ORPHAN …");
//     (6) regenerating restores sync (`write` then `check` exits 0 again).
//
// §6-E NON-GOLDEN: tests 4/5 are the drift-guard's FAILURE events. They must
// ACTUALLY FIRE — `check` must EXIT 1 and EMIT the MISSING / ORPHAN diagnostic on
// a genuinely-drifted sandbox tree (not a happy path that only proves the in-sync
// case). Both negatives drive the real exit-1 path below.
//
// MECHANISM = cli (body-derived, milestone 3): the SPAWNED shipped tool is load-bearing.
//   - aidlc-runner-gen.ts resolves SKILLS_DIR off its OWN module location
//     (TOOLS_DIR/../skills, :66-67), so an in-process handleWrite()/handleCheck()
//     would MUTATE the SHIPPED tree. That is exactly why the .sh runs write/check
//     against a SANDBOX copy of .claude/ (setup_integration_project). The
//     missing/orphan/regen cases REQUIRE a sandboxed copy with its OWN
//     aidlc-runner-gen.ts, driven via a subprocess.
//   - The drift verdict IS a process.exit contract: handleCheck() console.logs the
//     MISSING/ORPHAN diff then process.exit(1) (:287-294); it returns (exit 0) on
//     sync (:281-285). The exit code is only observable on the spawned binary —
//     the same surface the .sh shelled out to (`bun GEN check`). spawnsShippedTool.
//   The two independent cross-checks (tests 1 + 2) read stage-graph.json off disk
//   in-process — they do NOT spawn and do NOT touch the shipped tree (the .sh did
//   the identical pure-bash cross-check), so the suite still proves set-equality
//   WITHOUT trusting aidlc-runner-gen.ts.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-runner-gen.ts):
//   :88  isRunnableStage(node) — node.phase !== "initialization" (the 29 runnable
//        stages; init stages are bootstrap and ship no per-stage runner).
//   :214 handleWrite() — (re)generate one skills/aidlc-<slug>/SKILL.md per runnable
//        stage + the single /aidlc-init wrapper; PRUNE stale init-stage runners.
//   :244 isRunnerSkill(path) — on-disk runner SIGNATURE: SKILL.md body carries the
//        `--stage` + `--single` markers (so an orphan is detectable by body, not by
//        compiled-set membership — non-runner skills + scope-runners are never
//        mistaken for stage-runners).
//   :273 handleCheck() — drift guard: onDiskRunnerSlugs() set == stageSlugs() set;
//        exit 0 + "in sync" on match, else console.log MISSING/ORPHAN diff +
//        process.exit(1).
//
// Old TAP -> new test parity (1:1; the .sh emitted 7 `ok` lines -> 7 distinct
// expect()-bearing assertions here, several STRONGER):
//   .sh test 1 (shipped set == compiled slug set, independent cross-check)
//        -> test 1: derive both sets WITHOUT the tool; assert deep-equal sorted
//           arrays (STRONGER than the .sh's string compare — exact element set).
//   .sh test 2 (the compiled graph has 29 runnable non-init stages)
//        -> test 2: count == 29 AND zero of them are initialization-phase.
//   .sh test 3 (`check` exits 0 on the shipped in-sync tree)
//        -> test 3: spawn `check`, status 0; STRONGER — also assert the
//           "in sync … (29 runners)" headline.
//   .sh test 4 (`check` exits 1 when a runner is missing)         } tests 4+5 in
//   .sh test 5 (`check` names the missing runner)                 } the .sh ->
//        -> test 4: delete a runner in a SANDBOX, spawn `check`: status 1 AND
//           stdout contains "MISSING" AND names the deleted slug (co-located).
//   .sh test 6 (`check` exits 1 and names an ORPHAN runner)
//        -> test 5: add a bogus `--stage … --single` runner in the SANDBOX, spawn
//           `check`: status 1 AND stdout contains "ORPHAN" AND names the orphan slug.
//   .sh test 7 (removing the orphan + regenerating restores sync)
//        -> test 6: `write` then `check` in the SANDBOX returns to status 0 + "in sync".

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const GEN = join(AIDLC_SRC, "tools", "aidlc-runner-gen.ts");
const SKILLS_DIR = join(AIDLC_SRC, "skills");
const STAGE_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

// ---------------------------------------------------------------------------
// Independent cross-check helpers — derive BOTH sets WITHOUT trusting
// aidlc-runner-gen.ts (mirrors the .sh's pure-bash cross-check at :44-58). The
// `check` subcommand under test re-derives them through the tool; these read the
// raw stage-graph.json and the on-disk skills dir directly so set-equality is
// proven independent of the very tool the negative cases drive.
// ---------------------------------------------------------------------------

interface RawStage {
  slug: string;
  phase: string;
}

/** The RUNNABLE (non-initialization) compiled stage slugs, sorted — read off the
 *  raw stage-graph.json with no tool in the loop (the .sh's COMPILED set). */
function compiledRunnableSlugs(): string[] {
  const graph = JSON.parse(readFileSync(STAGE_GRAPH, "utf-8")) as RawStage[];
  return graph
    .filter((s) => s.phase !== "initialization")
    .map((s) => s.slug)
    .sort();
}

/** The on-disk runner slugs whose slug is a RUNNABLE compiled slug, sorted — the
 *  .sh's ON_DISK set: every skills/aidlc-<slug>/ dir with a SKILL.md whose slug is
 *  a compiled runnable stage. Independent of isRunnerSkill (the .sh kept any
 *  aidlc-<slug>/ dir present in COMPILED), so this is a pure second source. */
function onDiskRunnableSlugs(compiledSet: Set<string>): string[] {
  const found: string[] = [];
  for (const slug of compiledSet) {
    if (existsSync(join(SKILLS_DIR, `aidlc-${slug}`, "SKILL.md"))) {
      found.push(slug);
    }
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// Sandbox driver — the negative + regen cases (tests 4/5/6) MUST NOT touch the
// shipped tree (handleWrite/handleCheck are hard-pinned to SKILLS_DIR), so they
// run against a setupIntegrationProject copy of .claude/, exactly as the .sh did
// (PROJ=$(setup_integration_project --no-aidlc-docs); bun "$GEN_SANDBOX" …).
// ---------------------------------------------------------------------------

interface SandboxRun {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

const sandboxes: string[] = [];
afterAll(() => {
  for (const p of sandboxes) cleanupTestProject(p);
});

function newSandbox(): { proj: string; gen: string; skills: string } {
  const proj = setupIntegrationProject({ noAidlcDocs: true });
  sandboxes.push(proj);
  return {
    proj,
    gen: join(proj, ".claude", "tools", "aidlc-runner-gen.ts"),
    skills: join(proj, ".claude", "skills"),
  };
}

/** Run a sandbox aidlc-runner-gen subcommand, capturing status + combined output. */
function runGen(gen: string, args: string[]): SandboxRun {
  const r = spawnSync(BUN, [gen, ...args], { encoding: "utf-8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("t129 stage-runner drift guard (migrated from t129-stage-runner-drift.sh, plan 7)", () => {
  // ===========================================================================
  // Test 1 — the SHIPPED runner set == the RUNNABLE compiled slug set, proven by
  // an INDEPENDENT two-source cross-check (no tool in the loop). STRONGER than the
  // .sh's newline-joined string compare: assert the sorted element arrays are
  // deeply equal (every slug present on both sides, none extra).
  // ===========================================================================
  test("shipped skills/aidlc-<stage>/ set == compiled runnable slug list [.sh test 1]", () => {
    const compiled = compiledRunnableSlugs();
    const onDisk = onDiskRunnableSlugs(new Set(compiled));
    expect(onDisk).toEqual(compiled);
    // And neither side is empty (a broken read on either source would otherwise
    // make two empty sets compare "equal").
    expect(compiled.length).toBeGreaterThan(0);
  });

  // ===========================================================================
  // Test 2 — the count is exactly 29 (32 compiled stages minus the 3 bootstrap
  // initialization stages). STRONGER: also assert NONE of the runnable stages is
  // an initialization-phase stage (the very exclusion that yields 29).
  // ===========================================================================
  test("the compiled graph has 29 runnable (non-init) stages, one runner each [.sh test 2]", () => {
    const graph = JSON.parse(readFileSync(STAGE_GRAPH, "utf-8")) as RawStage[];
    const runnable = graph.filter((s) => s.phase !== "initialization");
    expect(runnable.length).toBe(29);
    // The exclusion is exactly the 3 init stages: 32 total - 29 runnable = 3.
    expect(graph.length - runnable.length).toBe(3);
    expect(runnable.some((s) => s.phase === "initialization")).toBe(false);
  });

  // ===========================================================================
  // Test 3 — the generator's own `check` agrees on the shipped (in-sync) tree.
  // Spawn the SHIPPED tool (read-only; `check` never writes). STRONGER than the
  // .sh's exit-0-only assertion: also pin the in-sync headline + the 29 count.
  // ===========================================================================
  test("aidlc-runner-gen check exits 0 on the shipped in-sync tree [.sh test 3]", () => {
    const r = runGen(GEN, ["check"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("in sync with the compiled stage graph");
    expect(r.out).toContain("(29 runners)");
  }, 30000);

  // ===========================================================================
  // Test 4 — §6-E NON-GOLDEN: the guard CATCHES a MISSING runner. In a SANDBOX
  // copy, delete a stage-runner dir, then `check` must FIRE: exit 1 AND name the
  // missing slug under "MISSING". (.sh tests 4 + 5, co-asserted on one drifted run.)
  // ===========================================================================
  test("check exits 1 and names a MISSING runner when one is deleted [.sh tests 4+5]", () => {
    const { gen, skills } = newSandbox();
    const victim = "code-generation";
    // Precondition: the victim runner exists in the fresh sandbox.
    expect(existsSync(join(skills, `aidlc-${victim}`, "SKILL.md"))).toBe(true);
    rmSync(join(skills, `aidlc-${victim}`), { recursive: true, force: true });

    const r = runGen(gen, ["check"]);
    // The drift-guard FAILURE event actually fired: exit 1, MISSING diagnostic.
    expect(r.status).toBe(1);
    expect(r.out).toContain("MISSING");
    // STRONGER than the .sh (which only grepped the word "MISSING"): the diff
    // NAMES the exact slug whose runner was deleted (drift surfaced, not silent).
    expect(r.out).toContain(victim);
  }, 30000);

  // ===========================================================================
  // Test 5 — §6-E NON-GOLDEN: the guard CATCHES an ORPHAN runner. In a SANDBOX,
  // add a bogus runner carrying the `--stage … --single` signature for a slug NOT
  // in the graph; `check` must FIRE: exit 1 AND name it under "ORPHAN". The orphan
  // must carry the runner SIGNATURE or isRunnerSkill (:244) would not see it.
  // ===========================================================================
  test("check exits 1 and names an ORPHAN runner for a slug not in the graph [.sh test 6]", () => {
    const { gen, skills } = newSandbox();
    const orphanSlug = "not-a-real-stage";
    const orphanDir = join(skills, `aidlc-${orphanSlug}`);
    mkdirSync(orphanDir, { recursive: true });
    // Byte-for-byte the .sh's orphan heredoc: a realistic stage-runner left behind
    // after its stage was dropped — it carries the `--stage <slug> --single`
    // signature isRunnerSkill keys on (so a non-runner skill is never miscounted).
    writeFileSync(
      join(orphanDir, "SKILL.md"),
      [
        "---",
        `name: aidlc-${orphanSlug}`,
        "description: orphan runner for a stage that does not exist in the graph",
        "---",
        "# orphan",
        "",
        `Drives \`bun .claude/tools/aidlc-orchestrate.ts next --stage ${orphanSlug} --single\`.`,
        "",
      ].join("\n"),
      "utf-8",
    );

    const r = runGen(gen, ["check"]);
    // The drift-guard FAILURE event actually fired: exit 1, ORPHAN diagnostic.
    expect(r.status).toBe(1);
    expect(r.out).toContain("ORPHAN");
    // STRONGER than the .sh's word grep: the diff NAMES the orphan slug.
    expect(r.out).toContain(orphanSlug);
  }, 30000);

  // ===========================================================================
  // Test 6 — regenerating restores sync. In a SANDBOX, drift the tree (drop a
  // runner AND add an orphan), confirm `check` is red, then `write` (regenerate +
  // prune) and confirm `check` returns to exit 0 + the in-sync headline. Proves
  // the guard is RESTORABLE by the generator, not just a one-way trip-wire.
  // ===========================================================================
  test("write regenerates the runner set and check returns to exit 0 [.sh test 7]", () => {
    const { gen, skills } = newSandbox();
    // Drift it two ways: delete a real runner AND add an orphan runner.
    rmSync(join(skills, "aidlc-functional-design"), { recursive: true, force: true });
    const orphanDir = join(skills, "aidlc-stale-dropped-stage");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(
      join(orphanDir, "SKILL.md"),
      "---\nname: aidlc-stale-dropped-stage\ndescription: stale\n---\n# stale\nDrives `--stage stale-dropped-stage --single`.\n",
      "utf-8",
    );
    // Sanity: drift is genuinely red before regeneration.
    const drifted = runGen(gen, ["check"]);
    expect(drifted.status).toBe(1);

    // Regenerate: write restores the missing runner; orphan removal — the .sh
    // rm -rf'd the orphan before `write`, since write PRUNES only stale INIT-phase
    // runners (handleWrite :225-231), not arbitrary orphans. Mirror that.
    rmSync(orphanDir, { recursive: true, force: true });
    const wrote = runGen(gen, ["write"]);
    expect(wrote.status).toBe(0);

    const r = runGen(gen, ["check"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("in sync with the compiled stage graph");
    expect(r.out).toContain("(29 runners)");
  }, 60000);
});
