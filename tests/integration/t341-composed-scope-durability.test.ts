// covers: subcommand:aidlc-graph:compile, subcommand:aidlc-utility:doctor, function:materializeComposedScopeIdentities, function:backfillComposedScopeRecords
//
// t341 - composed-scope durability across an engine reinstall (issue #963).
//
// #875/#910 hardened PLUGIN composition against a reinstall. An ad-hoc
// `/aidlc compose` scope is a different artifact and was covered by none of it:
// its only copy was the harness pair (`scopes/aidlc-<name>.md` + a
// `scope-grid.json` column), so a copy-channel reinstall overwrote the grid, the
// column vanished, and the scope kept resolving - as an all-SKIP phantom, with no
// restore path and no doctor row. `plugin sync` has no source for it (not a
// plugin) and #910's "Composed plugin surface" check does not see it (not a
// plugin surface).
//
// The fix makes `aidlc/scopes/<name>.md` the durable source of record and the
// harness pair its projection. This test walks the whole journey end to end,
// against the shipped tools in a real temp project:
//
//   1. BACK-FILL - a scope composed the old way (harness pair only) gains a
//      durable record on the next compile. One-way migration, so an existing
//      composed scope is never lost on upgrade.
//   2. REINSTALL - the harness pair is destroyed exactly as a copy-channel
//      reinstall destroys it (stock grid copied over, identity file removed).
//   3. DETECTION - doctor FAILS with the durability row naming the scope, so the
//      loss is no longer silent even before anything is repaired.
//   4. RECOVERY - the next compile restores both halves of the projection from
//      the record, with the AUTHORED cells intact (not a stock grid, not
//      all-SKIP), and the durability row goes green.
//   5. RESOLUTION - a new intent on the recovered scope carries the authored plan,
//      which is the property that actually broke for users.
//
// The composed scope this test starts from is NOT hand-written: it is the
// verbatim output of a live composer run, captured into
// tests/fixtures/composed-scope-live/ (`/aidlc compose "harden the deployment
// pipeline and add observability for our existing service - no new features,
// compose a custom plan for exactly this"`, approved at the gate, on the same
// task t192 drives). A hand-written imitation would have missed what the real
// composer actually emits - `skeleton:` and `change_control:` frontmatter this
// test's author did not know to include, and a 40-line body carrying its own
// `##` headings next to which the record's `## Stage Grid` section has to be
// unambiguous. Using the real bytes is what proves the projection round-trips
// the artifact users actually have. Refresh it by re-driving t192 and copying
// out the composed `.md` + its grid column.
//
// Mechanism = cli: compile and doctor both terminate through their process
// shells, so the real tools are spawned via bun and the assertions read their
// on-disk effects and rendered report - the same discipline as t314 (the plugin
// reinstall twin) and t204. No live model runs here; the fixture is the seam.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";

const BUN = process.execPath;

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "composed-scope-live",
);
/** The composer-authored identity file, verbatim. */
const LIVE_SCOPE_MD = readFileSync(join(FIXTURE_DIR, "scope.md"), "utf-8");
/** Its approved EXECUTE/SKIP grid column, verbatim. */
const LIVE_STAGES = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "stages.json"), "utf-8"),
) as Record<string, "EXECUTE" | "SKIP">;
/** The scope name the live composer chose, read from the fixture's frontmatter
 *  rather than restated, so the fixture stays the single source of truth. */
const SCOPE = (/^name:\s*(.+)$/m.exec(LIVE_SCOPE_MD)?.[1] ?? "").trim();

// Two cells from the approved grid that make "the authored plan survived"
// falsifiable. This shape belongs to no stock scope: it SKIPs product shaping
// while EXECUTing the operation set, so recovering it as a stock grid or as an
// all-SKIP phantom fails on one of the two.
const AUTHORED_SKIP = "units-generation";
const AUTHORED_EXECUTE = "observability-setup";

// Frontmatter keys the live composer emitted that a hand-written imitation would
// not have carried. Asserting they survive is the point of using real bytes.
const LIVE_FRONTMATTER_KEYS = ["skeleton:", "change_control:"] as const;

const gridPath = (proj: string): string =>
  join(proj, ".claude", "tools", "data", "scope-grid.json");
const identityPath = (proj: string): string =>
  join(proj, ".claude", "scopes", `aidlc-${SCOPE}.md`);
const recordPath = (proj: string): string => join(proj, "aidlc", "scopes", `${SCOPE}.md`);

type Grid = Record<string, { stages: Record<string, string> }>;

const readGrid = (proj: string): Grid => JSON.parse(readFileSync(gridPath(proj), "utf-8")) as Grid;

function runTool(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  // The fixture seams must not leak in: this test asserts on the REAL resolution
  // ladder (project aidlc/scopes/ + the project harness tree).
  delete env.AIDLC_SCOPE_MAPPING;
  delete env.AIDLC_SCOPE_GRID;
  delete env.AIDLC_SCOPES_DIR;
  delete env.AIDLC_COMPOSED_SCOPES_DIR;
  const res = spawnSync(BUN, [join(proj, ".claude", "tools", tool), ...args], {
    encoding: "utf-8",
    env: env as Record<string, string>,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const compile = (proj: string): { status: number; out: string } =>
  runTool(proj, "aidlc-graph.ts", ["compile"]);

// --verbose because healthy rows collapse by section without it; failures and
// warnings render either way, so this keeps the pass-state assertions honest.
const doctor = (proj: string): { status: number; out: string } =>
  runTool(proj, "aidlc-utility.ts", ["doctor", "--verbose", "--project-dir", proj]);

/** The durability row, whatever its pass/fail decoration. */
function durabilityRow(report: string): string {
  const line = report
    .split("\n")
    .find((l) => l.includes("Composed scope durability"));
  return line ?? "";
}

/** Install the captured live-composer scope the OLD way: the harness pair only,
 *  no durable record - the exact on-disk shape every pre-record install has.
 *  Returns the authored grid so later assertions can prove the APPROVED cells
 *  survived, never a stock grid and never an emptied one. */
function authorLegacyComposedScope(proj: string): Record<string, string> {
  writeFileSync(identityPath(proj), LIVE_SCOPE_MD, "utf-8");
  const grid = readGrid(proj);
  grid[SCOPE] = { stages: { ...LIVE_STAGES } };
  writeFileSync(gridPath(proj), JSON.stringify(grid, null, 2), "utf-8");
  return { ...LIVE_STAGES };
}

/** Destroy the harness projection exactly as a copy-channel reinstall does: the
 *  shipped stock grid is copied over the project's grid (dropping the composed
 *  column) and the shipped scopes/ tree replaces the project's (dropping the
 *  identity file). The shared aidlc/ tree is untouched - it is the user's
 *  committed work, not part of the install. */
function simulateReinstall(proj: string): void {
  const grid = readGrid(proj);
  delete grid[SCOPE];
  writeFileSync(gridPath(proj), JSON.stringify(grid, null, 2), "utf-8");
  rmSync(identityPath(proj), { force: true });
}

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

function freshProject(): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  projects.push(proj);
  return proj;
}

describe("t341 composed scope survives an engine reinstall (#963)", () => {
  // Guard the fixture's premise. If a refreshed capture no longer has this
  // shape, the journey assertions below would silently stop proving anything.
  test("the fixture is a real composed grid with the deviation the journey asserts on", () => {
    expect(SCOPE.length).toBeGreaterThan(0);
    expect(Object.keys(LIVE_STAGES).length).toBeGreaterThan(30);
    expect(LIVE_STAGES[AUTHORED_SKIP]).toBe("SKIP");
    expect(LIVE_STAGES[AUTHORED_EXECUTE]).toBe("EXECUTE");
    for (const key of LIVE_FRONTMATTER_KEYS) expect(LIVE_SCOPE_MD).toContain(key);
    // The body carries its own `##` headings, so the record's Stage Grid
    // heading must not already appear in the composer's prose.
    expect(LIVE_SCOPE_MD).not.toContain("## Stage Grid");
    expect(LIVE_SCOPE_MD).toMatch(/^## /m);
  });

  test("the full journey: back-fill -> reinstall -> detect -> recover", () => {
    const proj = freshProject();
    const authored = authorLegacyComposedScope(proj);

    // 1. BACK-FILL. A scope composed before records existed gains one on the
    //    next compile, so upgrading never strands an existing composed scope.
    expect(existsSync(recordPath(proj))).toBe(false);
    const first = compile(proj);
    expect(first.status).toBe(0);
    expect(existsSync(recordPath(proj))).toBe(true);
    const record = readFileSync(recordPath(proj), "utf-8");
    // The record carries BOTH halves: the authored identity (frontmatter AND
    // prose) and the grid. That single-file shape is what makes the phantom
    // impossible - there is no second file to lose.
    expect(record).toContain(`name: ${SCOPE}`);
    for (const key of LIVE_FRONTMATTER_KEYS) expect(record).toContain(key);
    // The composer's whole prose body survives verbatim, headings and all.
    expect(record).toContain(LIVE_SCOPE_MD.trimEnd());
    expect(record).toContain("## Stage Grid");
    expect(
      (JSON.parse(/```json\n([\s\S]*?)```/.exec(record)?.[1] ?? "{}") as {
        stages: Record<string, string>;
      }).stages,
    ).toEqual(authored);
    // The compile itself is non-destructive: the column is still there.
    expect(readGrid(proj)[SCOPE].stages).toEqual(authored);

    // 2. REINSTALL. Both halves of the harness projection are gone.
    simulateReinstall(proj);
    expect(readGrid(proj)[SCOPE]).toBeUndefined();
    expect(existsSync(identityPath(proj))).toBe(false);

    // 3. DETECTION. Before the fix nothing said a word here. Doctor now fails
    //    with the record named as unprojected and the remedy spelled out.
    const broken = doctor(proj);
    const brokenRow = durabilityRow(broken.out);
    expect(brokenRow).toContain("Composed scope durability");
    expect(brokenRow).toContain(SCOPE);
    expect(brokenRow).toContain("not projected");
    expect(broken.out).toContain("compile");

    // 4. RECOVERY. One compile restores the identity file and the grid column,
    //    with the AUTHORED cells - not a stock grid, and not all-SKIP.
    const healed = compile(proj);
    expect(healed.status).toBe(0);
    expect(existsSync(identityPath(proj))).toBe(true);
    expect(readGrid(proj)[SCOPE].stages).toEqual(authored);
    // The restored identity file is the composer's original bytes, not a
    // re-rendered approximation: frontmatter and prose both come back whole.
    expect(readFileSync(identityPath(proj), "utf-8").trimEnd()).toBe(
      LIVE_SCOPE_MD.trimEnd(),
    );

    // ...and the health row goes green, so recovery is verifiable.
    const after = doctor(proj);
    const healedRow = durabilityRow(after.out);
    expect(healedRow).toContain("recorded and projected");
    expect(healedRow).not.toContain("problem(s)");
  });

  test("a phantom (identity file, no grid column) fails doctor and self-heals", () => {
    const proj = freshProject();
    const authored = authorLegacyComposedScope(proj);
    expect(compile(proj).status).toBe(0);

    // The merge-copy shape of a reinstall: scope-grid.json is a generated file so
    // the copy replaces it, while the `.md` survives. The scope stays "valid" and
    // resolves as an empty all-SKIP plan - a silently emptied workflow. Scope
    // validation cannot see it (an all-SKIP grid walks no consumes).
    const grid = readGrid(proj);
    delete grid[SCOPE];
    writeFileSync(gridPath(proj), JSON.stringify(grid, null, 2), "utf-8");

    const broken = durabilityRow(doctor(proj).out);
    expect(broken).toContain(SCOPE);
    expect(broken).toContain("no grid column");

    expect(compile(proj).status).toBe(0);
    expect(readGrid(proj)[SCOPE].stages).toEqual(authored);
    expect(durabilityRow(doctor(proj).out)).toContain("recorded and projected");
  });

  test("a recovered scope resolves with its AUTHORED plan, not all-SKIP", () => {
    const proj = freshProject();
    authorLegacyComposedScope(proj);
    expect(compile(proj).status).toBe(0);
    simulateReinstall(proj);
    expect(compile(proj).status).toBe(0);

    // The property that actually broke for users: starting a NEW intent on the
    // composed scope after a reinstall. It must carry the composer's approved
    // EXECUTE/SKIP plan - the product-shaping stage it chose to SKIP stays
    // SKIPped and the operation stage it chose to run stays EXECUTE, a pairing
    // no stock scope and no all-SKIP phantom can produce.
    const created = runTool(proj, "aidlc-utility.ts", [
      "intent-create",
      "--scope",
      SCOPE,
      "--project-dir",
      proj,
    ]);
    expect(created.status).toBe(0);

    const space = existsSync(join(proj, "aidlc", "active-space"))
      ? readFileSync(join(proj, "aidlc", "active-space"), "utf-8").trim() || "default"
      : "default";
    const intents = join(proj, "aidlc", "spaces", space, "intents");
    const rec = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const state = readFileSync(join(intents, rec, "aidlc-state.md"), "utf-8");

    expect(state.split("\n")).toContain(`- **Scope**: ${SCOPE}`);
    expect(state).toContain(`${AUTHORED_SKIP} — SKIP`);
    expect(state).toContain(`${AUTHORED_EXECUTE} — EXECUTE`);
  });

  test("a project with no composed scope reports the clean row and gains no aidlc/scopes/", () => {
    const proj = freshProject();
    expect(compile(proj).status).toBe(0);
    // No record dir is created speculatively — the overwhelmingly common case
    // must leave no trace in the user's committed tree.
    expect(existsSync(join(proj, "aidlc", "scopes"))).toBe(false);
    expect(durabilityRow(doctor(proj).out)).toContain("no composed scopes");
  });
});
