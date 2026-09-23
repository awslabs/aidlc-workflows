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
// `##` headings next to which the record's generated grid region has to be
// unambiguous - which is why that region is fenced by a sentinel pair a user will
// not type rather than by a heading they might. Using the real bytes is what
// proves the projection round-trips
// the artifact users actually have. Refresh it by re-driving t192 and copying
// out the composed `.md` + its grid column.
//
// Mechanism = cli: compile and doctor both terminate through their process
// shells, so the real tools are spawned via bun and the assertions read their
// on-disk effects and rendered report - the same discipline as t314 (the plugin
// reinstall twin) and t204. No live model runs here; the fixture is the seam.

import { deterministicCaseTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertComposedScopeFile } from "../harness/composed-scope.ts";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";

// Each case installs a project and makes several real CLI round trips.
setDefaultTimeout(Math.max(30_000, deterministicCaseTimeoutMs()));

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

/** Read the grid out of a record's generated region — from INSIDE the sentinels,
 *  the same way the parser does, so a decoy fence in authored prose cannot be
 *  mistaken for it here either. */
function gridInRecord(record: string): Record<string, string> {
  const region = /BEGIN aidlc composed-scope-grid[\s\S]*?-->([\s\S]*?)<!-- END aidlc composed-scope-grid -->/
    .exec(record)?.[1] ?? "";
  const fence = /```json\s*\n([\s\S]*?)```/.exec(region)?.[1] ?? "{}";
  return (JSON.parse(fence) as { stages?: Record<string, string> }).stages ?? {};
}

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
    // The composer writes a prose body with its own `##` headings — which is why
    // the record's grid region is fenced by a sentinel a user will not type rather
    // than by a heading they might.
    expect(LIVE_SCOPE_MD).toMatch(/^## /m);
    expect(LIVE_SCOPE_MD).not.toContain("aidlc composed-scope-grid");
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
    expect(record).toContain("BEGIN aidlc composed-scope-grid");
    expect(record).toContain("<!-- END aidlc composed-scope-grid -->");
    expect(gridInRecord(record)).toEqual(authored);
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

  test.each([
    `aidlc-${SCOPE}.md`,
    `aidlc-aidlc-${SCOPE}.md`,
  ])("record metadata refresh from %s requires deleting the actual projection", (filename) => {
    const proj = freshProject();
    const name = `aidlc-${SCOPE}`;
    const scopes = join(proj, ".claude", "scopes");
    const initialPath = join(scopes, filename);
    const canonicalPath = join(scopes, `aidlc-${name}.md`);
    const durablePath = join(proj, "aidlc", "scopes", `${name}.md`);
    const identity = LIVE_SCOPE_MD.replaceAll(SCOPE, name);

    // Both filenames are supported for this exact prefixed identity. Back-fill
    // through the packaged CLI, keeping the live fixture's approved plan intact.
    writeFileSync(initialPath, identity, "utf-8");
    const grid = readGrid(proj);
    grid[name] = { stages: { ...LIVE_STAGES } };
    writeFileSync(gridPath(proj), JSON.stringify(grid, null, 2), "utf-8");
    expect(existsSync(durablePath)).toBe(false);
    const backfilled = compile(proj);
    expect(backfilled.status, backfilled.out).toBe(0);
    expect(assertComposedScopeFile(scopes, name)).toBe(initialPath);
    expect(readFileSync(initialPath, "utf-8")).toBe(identity);
    const record = readFileSync(durablePath, "utf-8");
    expect(record).toContain(identity.trimEnd());
    expect(gridInRecord(record)).toEqual(LIVE_STAGES);

    const updatedIdentity = identity
      .replace(/^depth: Standard$/m, "depth: Minimal")
      .replace(/^description:.*$/m, "description: Refreshed durable scope metadata");
    expect(updatedIdentity).toContain("\ndepth: Minimal\n");
    expect(updatedIdentity).toContain("\ndescription: Refreshed durable scope metadata\n");
    const updatedRecord = record.replace(identity.trimEnd(), updatedIdentity.trimEnd());
    writeFileSync(durablePath, updatedRecord, "utf-8");
    const manualProjection = `${identity}\nLocal projection note: preserve until explicitly refreshed.\n`;
    writeFileSync(initialPath, manualProjection, "utf-8");

    // Grid authority and identity preservation are separate contracts: compile
    // repairs a divergent generated cell without erasing a projection hand edit.
    const divergentGrid = readGrid(proj);
    divergentGrid[name].stages[AUTHORED_EXECUTE] = "SKIP";
    writeFileSync(gridPath(proj), JSON.stringify(divergentGrid, null, 2), "utf-8");
    const preserved = compile(proj);
    expect(preserved.status, preserved.out).toBe(0);
    expect(assertComposedScopeFile(scopes, name)).toBe(initialPath);
    expect(readFileSync(initialPath, "utf-8")).toBe(manualProjection);
    expect(readFileSync(durablePath, "utf-8")).toBe(updatedRecord);
    expect(readGrid(proj)[name].stages).toEqual(LIVE_STAGES);

    if (initialPath !== canonicalPath) {
      // The old refresh instruction assumed aidlc-<name>.md. Removing that
      // absent path leaves <name>.md installed, so compile correctly preserves it.
      expect(existsSync(canonicalPath)).toBe(false);
      rmSync(canonicalPath, { force: true });
      const assumedDeletion = compile(proj);
      expect(assumedDeletion.status, assumedDeletion.out).toBe(0);
      expect(assertComposedScopeFile(scopes, name)).toBe(initialPath);
      expect(readFileSync(initialPath, "utf-8")).toBe(manualProjection);
      expect(existsSync(canonicalPath)).toBe(false);
      expect(readFileSync(durablePath, "utf-8")).toBe(updatedRecord);
      expect(readGrid(proj)[name].stages).toEqual(LIVE_STAGES);
    }

    // Resolve by declared name before deleting. Recovery always uses the
    // canonical filename, even when the previous projection used the alias.
    const actualPath = assertComposedScopeFile(scopes, name);
    expect(actualPath).toBe(initialPath);
    rmSync(actualPath);
    expect(existsSync(actualPath)).toBe(false);
    const refreshed = compile(proj);
    expect(refreshed.status, refreshed.out).toBe(0);
    // The helper requires exactly one declared identity: no stale duplicate.
    expect(assertComposedScopeFile(scopes, name)).toBe(canonicalPath);
    expect(readFileSync(canonicalPath, "utf-8").trimEnd()).toBe(updatedIdentity.trimEnd());
    expect(readFileSync(durablePath, "utf-8")).toBe(updatedRecord);
    expect(readGrid(proj)[name].stages).toEqual(LIVE_STAGES);
    if (initialPath !== canonicalPath) expect(existsSync(initialPath)).toBe(false);
    const row = durabilityRow(doctor(proj).out);
    expect(row).toContain("recorded and projected");
    expect(row).not.toContain("problem(s)");

    // A new intent resolves the same identity and approved plan, with the
    // refreshed default depth coming from the recovered projection.
    const created = runTool(proj, "aidlc-utility.ts", [
      "intent-create", "--scope", name, "--project-dir", proj,
    ]);
    expect(created.status, created.out).toBe(0);
    const space = existsSync(join(proj, "aidlc", "active-space"))
      ? readFileSync(join(proj, "aidlc", "active-space"), "utf-8").trim() || "default"
      : "default";
    const intents = join(proj, "aidlc", "spaces", space, "intents");
    const rec = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const state = readFileSync(join(intents, rec, "aidlc-state.md"), "utf-8");
    expect(state.split("\n")).toContain(`- **Scope**: ${name}`);
    expect(state.split("\n")).toContain("- **Depth**: Minimal");
    expect(state).toContain(`${AUTHORED_SKIP} — SKIP`);
    expect(state).toContain(`${AUTHORED_EXECUTE} — EXECUTE`);
  });

  test("refresh refuses a canonical path occupied by another scope until that scope is moved", () => {
    const proj = freshProject();
    const nameA = "aidlc-x";
    const nameB = "aidlc-aidlc-x";
    const scopes = join(proj, ".claude", "scopes");
    const aliasA = join(scopes, `${nameA}.md`);
    const occupiedPath = join(scopes, `${nameB}.md`);
    const canonicalB = join(scopes, `aidlc-${nameB}.md`);
    const recordA = join(proj, "aidlc", "scopes", `${nameA}.md`);
    const recordB = join(proj, "aidlc", "scopes", `${nameB}.md`);
    const graphPath = join(proj, ".claude", "tools", "data", "stage-graph.json");
    const identityA = LIVE_SCOPE_MD.replaceAll(SCOPE, nameA);
    const identityB = LIVE_SCOPE_MD.replaceAll(SCOPE, nameB);
    const stagesB = { ...LIVE_STAGES, "feedback-optimization": "EXECUTE" };

    // Both bare-name aliases are valid, but A's canonical restore path is B's
    // existing projection. Give the scopes distinct plans to catch any mix-up.
    expect(occupiedPath).toBe(join(scopes, `aidlc-${nameA}.md`));
    expect(stagesB).not.toEqual(LIVE_STAGES);
    writeFileSync(aliasA, identityA, "utf-8");
    writeFileSync(occupiedPath, identityB, "utf-8");
    const grid = readGrid(proj);
    grid[nameA] = { stages: { ...LIVE_STAGES } };
    grid[nameB] = { stages: stagesB };
    writeFileSync(gridPath(proj), JSON.stringify(grid, null, 2), "utf-8");
    const backfilled = compile(proj);
    expect(backfilled.status, backfilled.out).toBe(0);
    expect(assertComposedScopeFile(scopes, nameA)).toBe(aliasA);
    expect(assertComposedScopeFile(scopes, nameB)).toBe(occupiedPath);
    const originalRecordA = readFileSync(recordA, "utf-8");
    const originalRecordB = readFileSync(recordB, "utf-8");
    expect(originalRecordA).toContain(identityA.trimEnd());
    expect(originalRecordB).toContain(identityB.trimEnd());
    expect(gridInRecord(originalRecordA)).toEqual(LIVE_STAGES);
    expect(gridInRecord(originalRecordB)).toEqual(stagesB);

    const updatedIdentityA = identityA
      .replace(/^depth: Standard$/m, "depth: Minimal")
      .replace(/^description:.*$/m, "description: Refreshed scope A metadata");
    expect(updatedIdentityA).toContain("\ndepth: Minimal\n");
    expect(updatedIdentityA).toContain("\ndescription: Refreshed scope A metadata\n");
    const updatedRecordA = originalRecordA.replace(identityA.trimEnd(), updatedIdentityA.trimEnd());
    writeFileSync(recordA, updatedRecordA, "utf-8");
    const manualProjectionB = `${identityB}\nLocal scope B note: keep this hand edit.\n`;
    writeFileSync(occupiedPath, manualProjectionB, "utf-8");
    rmSync(assertComposedScopeFile(scopes, nameA));
    const graphBefore = readFileSync(graphPath);
    const gridBefore = readFileSync(gridPath(proj));

    // Refusal must happen before any projection, record, or compiled-artifact
    // replacement. In particular, B's hand edit cannot be recovered from its record.
    const refused = compile(proj);
    expect(readFileSync(occupiedPath, "utf-8"), refused.out).toBe(manualProjectionB);
    expect(refused.status, refused.out).not.toBe(0);
    expect(refused.out).toContain("Cannot restore composed scope");
    expect(refused.out).toContain(nameA);
    expect(refused.out).toContain(occupiedPath);
    expect(refused.out).toContain("already exists");
    expect(assertComposedScopeFile(scopes, nameB)).toBe(occupiedPath);
    expect(existsSync(aliasA)).toBe(false);
    expect(existsSync(canonicalB)).toBe(false);
    expect(readFileSync(recordA, "utf-8")).toBe(updatedRecordA);
    expect(readFileSync(recordB, "utf-8")).toBe(originalRecordB);
    expect(readFileSync(graphPath)).toEqual(graphBefore);
    expect(readFileSync(gridPath(proj))).toEqual(gridBefore);

    // Move B's actual projection to its own unused canonical path. The next
    // compile can restore A while preserving B's bytes and each scope's plan.
    renameSync(assertComposedScopeFile(scopes, nameB), canonicalB);
    expect(existsSync(occupiedPath)).toBe(false);
    const recovered = compile(proj);
    expect(recovered.status, recovered.out).toBe(0);
    expect(assertComposedScopeFile(scopes, nameA)).toBe(occupiedPath);
    expect(assertComposedScopeFile(scopes, nameB)).toBe(canonicalB);
    expect(readFileSync(occupiedPath, "utf-8").trimEnd()).toBe(updatedIdentityA.trimEnd());
    expect(readFileSync(canonicalB, "utf-8")).toBe(manualProjectionB);
    expect(existsSync(aliasA)).toBe(false);
    expect(readFileSync(recordA, "utf-8")).toBe(updatedRecordA);
    expect(readFileSync(recordB, "utf-8")).toBe(originalRecordB);
    expect(readGrid(proj)[nameA].stages).toEqual(LIVE_STAGES);
    expect(readGrid(proj)[nameB].stages).toEqual(stagesB);
    const row = durabilityRow(doctor(proj).out);
    expect(row).toContain("recorded and projected");
    expect(row).not.toContain("problem(s)");
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

  // The one error in this feature that used to carry no path. The way in is a
  // hand-restore that copies a RECORD into the harness scopes directory - where a
  // scope file must hold only the authored half - and then loses the record. The
  // throw lands after stage-graph.json and scope-grid.json are already written, so
  // every later compile fails identically and this message is the whole diagnosis.
  // Driven through the real compile CLI rather than by calling the writer directly,
  // because what P3 asked for is that the SHIPPED path name the file.
  test("a harness scope file carrying a generated region names itself when compile refuses", () => {
    const proj = freshProject();
    authorLegacyComposedScope(proj);
    expect(compile(proj).status).toBe(0);
    // A real record, so the region below is the emitter's own bytes, not a guess.
    const recordBytes = readFileSync(recordPath(proj), "utf-8");
    expect(recordBytes).toContain("BEGIN aidlc composed-scope-grid");

    const probe = "sentinel-probe";
    const probePath = join(proj, ".claude", "scopes", `aidlc-${probe}.md`);
    writeFileSync(probePath, recordBytes.replace(`name: ${SCOPE}`, `name: ${probe}`), "utf-8");
    // A grid column but no record, so back-fill reaches this file and refuses it.
    const grid = readGrid(proj);
    grid[probe] = { stages: { ...LIVE_STAGES } };
    writeFileSync(gridPath(proj), JSON.stringify(grid, null, 2), "utf-8");
    expect(existsSync(join(proj, "aidlc", "scopes", `${probe}.md`))).toBe(false);

    const refused = compile(proj);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("already contains an aidlc composed-scope-grid sentinel");
    // The point of the case: which file.
    expect(refused.out).toContain(`aidlc-${probe}.md`);
  });

  // The other way a scope file ends up with no grid column: nobody tagged a stage
  // with it. The transpose emits a column only for a name some stage declares, so
  // there is nothing for compile to build and no record to project — which is step
  // 1 of authoring a scope by hand, and step 4 of that workflow is running doctor.
  // Detecting it is right (an untagged scope really does resolve all-SKIP), but the
  // row used to name `graph compile` as the remedy, which exits 0 and leaves the
  // row red forever. So the two causes are reported apart and this one names what
  // actually reaches it.
  test("an untagged scope with no record is reported as unbuildable, not as compile's job", () => {
    const proj = freshProject();
    const probe = join(proj, ".claude", "scopes", "aidlc-untagged-probe.md");
    writeFileSync(
      probe,
      "---\nname: untagged-probe\ndepth: Minimal\nkeywords: []\ndescription: no stage declares this\n---\n\n# untagged-probe\n",
      "utf-8",
    );

    expect(compile(proj).status).toBe(0);
    expect(readGrid(proj)["untagged-probe"]).toBeUndefined();

    const report = doctor(proj).out;
    const row = durabilityRow(report);
    expect(row).toContain("untagged-probe");
    expect(row).toContain("no record to rebuild it from");

    // The remedy has to say compile will not reach this, and name a route that
    // does. Before this it said only "run graph compile".
    expect(report).toContain("cannot rebuild a column with no record behind it");
    expect(report).toContain("scopes:");

    // And the claim is true: compiling again changes nothing, which is exactly why
    // pointing the user at it would have been a dead end.
    expect(compile(proj).status).toBe(0);
    expect(readGrid(proj)["untagged-probe"]).toBeUndefined();
    expect(durabilityRow(doctor(proj).out)).toContain("no record to rebuild it from");
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

// The recovery above runs through the `graph compile` CLI. `aidlc config`
// reaches the same fold-back by a DIFFERENT route: it stages a fresh
// projection in a temp root, points the compile at the project's real records, and
// installs the result. That path called compileStageGraph() directly, and the
// fold-back only resurrects a grid column whose identity file exists — so a record
// whose projection was already gone got filtered out and its column silently
// dropped into the tree about to be installed. Which is exactly the reinstall this
// whole change exists to survive, so the two recovery paths have to agree.
describe("t341 config refresh recovers a composed scope too", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
  const CLAUDE_RELEASE = join(REPO_ROOT, "dist-release", "claude");

  const init = (proj: string, args: string[]): { status: number; out: string } => {
    const res = spawnSync(BUN, [INIT, ...args], {
      encoding: "utf-8",
      cwd: proj,
      env: { ...process.env } as Record<string, string>,
    });
    return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  };

  function recordedAliasPair() {
    const proj = mkdtempSync(join(tmpdir(), "aidlc-t341-update-collision-"));
    projects.push(proj);
    const installed = init(proj, [
      "config", "--project-dir", proj, "--from", CLAUDE_RELEASE, "--harness", "claude",
    ]);
    expect(installed.status, installed.out).toBe(0);
    const refresh = () => init(proj, ["config", "--project-dir", proj, "--from", CLAUDE_RELEASE]);
    const nameA = "aidlc-x";
    const nameB = "aidlc-aidlc-x";
    const scopes = join(proj, ".claude", "scopes");
    const aliasA = join(scopes, `${nameA}.md`);
    const occupiedPath = join(scopes, `${nameB}.md`);
    const canonicalB = join(scopes, `aidlc-${nameB}.md`);
    const recordA = join(proj, "aidlc", "scopes", `${nameA}.md`);
    const recordB = join(proj, "aidlc", "scopes", `${nameB}.md`);
    const graphPath = join(proj, ".claude", "tools", "data", "stage-graph.json");
    const baselinePath = join(proj, ".claude", "tools", "data", "aidlc-manifest.json");
    const baselineKeyB = `.claude/scopes/${nameB}.md`;
    const identityA = LIVE_SCOPE_MD.replaceAll(SCOPE, nameA);
    const identityB = LIVE_SCOPE_MD.replaceAll(SCOPE, nameB);
    const stagesB = { ...LIVE_STAGES, "feedback-optimization": "EXECUTE" };
    expect(stagesB).not.toEqual(LIVE_STAGES);
    expect(occupiedPath).toBe(join(scopes, `aidlc-${nameA}.md`));
    writeFileSync(aliasA, identityA, "utf-8");
    writeFileSync(occupiedPath, identityB, "utf-8");
    const grid = readGrid(proj);
    grid[nameA] = { stages: { ...LIVE_STAGES } };
    grid[nameB] = { stages: stagesB };
    writeFileSync(gridPath(proj), JSON.stringify(grid, null, 2), "utf-8");
    const backfilled = compile(proj);
    expect(backfilled.status, backfilled.out).toBe(0);
    const originalRecordA = readFileSync(recordA, "utf-8");
    const originalRecordB = readFileSync(recordB, "utf-8");
    expect(gridInRecord(originalRecordA)).toEqual(LIVE_STAGES);
    expect(gridInRecord(originalRecordB)).toEqual(stagesB);

    // The hand edit is deliberately newer than B's durable record. A successful
    // first refresh adopts the alias into its baseline without changing the note.
    const manualProjectionB = `${identityB}\nLocal scope B note: preserve across every update.\n`;
    writeFileSync(occupiedPath, manualProjectionB, "utf-8");
    expect(originalRecordB).not.toContain("Local scope B note:");
    expect(JSON.parse(readFileSync(baselinePath, "utf-8")).files[baselineKeyB]).toBeUndefined();
    const firstRefresh = refresh();
    expect(firstRefresh.status, firstRefresh.out).toBe(0);
    expect(assertComposedScopeFile(scopes, nameA)).toBe(aliasA);
    expect(assertComposedScopeFile(scopes, nameB)).toBe(occupiedPath);
    expect(readFileSync(aliasA, "utf-8")).toBe(identityA);
    expect(readFileSync(occupiedPath, "utf-8")).toBe(manualProjectionB);
    expect(existsSync(canonicalB)).toBe(false);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
    expect(baseline.files[baselineKeyB]).toBe(
      `sha256:${createHash("sha256").update(manualProjectionB).digest("hex")}`,
    );
    expect(readFileSync(recordA, "utf-8")).toBe(originalRecordA);
    expect(readFileSync(recordB, "utf-8")).toBe(originalRecordB);
    expect(readGrid(proj)[nameA].stages).toEqual(LIVE_STAGES);
    expect(readGrid(proj)[nameB].stages).toEqual(stagesB);
    return {
      proj, refresh, nameA, nameB, scopes, aliasA, occupiedPath, canonicalB,
      recordA, recordB, graphPath, baselinePath, baselineKeyB,
      identityA, originalRecordA, originalRecordB, manualProjectionB, stagesB,
    };
  }

  test("ordinary repeated refresh preserves a baselined scope alias and its hand edit", () => {
    const f = recordedAliasPair();
    const graphBefore = readFileSync(f.graphPath);
    const gridBefore = readFileSync(gridPath(f.proj));
    const repeated = f.refresh();
    expect(readFileSync(f.occupiedPath, "utf-8"), repeated.out).toBe(f.manualProjectionB);
    expect(repeated.status, repeated.out).toBe(0);
    expect(assertComposedScopeFile(f.scopes, f.nameA)).toBe(f.aliasA);
    expect(assertComposedScopeFile(f.scopes, f.nameB)).toBe(f.occupiedPath);
    expect(existsSync(f.canonicalB)).toBe(false);
    expect(readFileSync(f.aliasA, "utf-8")).toBe(f.identityA);
    expect(readFileSync(f.recordA, "utf-8")).toBe(f.originalRecordA);
    expect(readFileSync(f.recordB, "utf-8")).toBe(f.originalRecordB);
    expect(readFileSync(f.graphPath)).toEqual(graphBefore);
    expect(readFileSync(gridPath(f.proj))).toEqual(gridBefore);
    // Successful config rebuilds the manifest; its scope entries must still
    // describe the preserved files. Refusal below preserves the entire manifest.
    const baseline = JSON.parse(readFileSync(f.baselinePath, "utf-8"));
    expect(baseline.files[`.claude/scopes/${f.nameA}.md`]).toBe(
      `sha256:${createHash("sha256").update(f.identityA).digest("hex")}`,
    );
    expect(baseline.files[f.baselineKeyB]).toBe(
      `sha256:${createHash("sha256").update(f.manualProjectionB).digest("hex")}`,
    );
  }, 180_000);

  test("staged refresh refuses a baselined alias collision and recovers after moving that alias", () => {
    const f = recordedAliasPair();
    const updatedIdentityA = f.identityA
      .replace(/^depth: Standard$/m, "depth: Minimal")
      .replace(/^description:.*$/m, "description: Refreshed scope A metadata");
    expect(updatedIdentityA).toContain("\ndepth: Minimal\n");
    expect(updatedIdentityA).toContain("\ndescription: Refreshed scope A metadata\n");
    const updatedRecordA = f.originalRecordA.replace(f.identityA.trimEnd(), updatedIdentityA.trimEnd());
    writeFileSync(f.recordA, updatedRecordA, "utf-8");
    rmSync(assertComposedScopeFile(f.scopes, f.nameA));
    const protectedPaths = [
      f.occupiedPath, f.recordA, f.recordB, f.graphPath, gridPath(f.proj), f.baselinePath,
    ];
    const before = protectedPaths.map((path) => ({ path, bytes: readFileSync(path) }));

    // A private staging tree must retain the live identity even after an earlier
    // refresh recorded it as baseline-owned. Otherwise A silently replaces B.
    const refused = f.refresh();
    expect(readFileSync(f.occupiedPath, "utf-8"), refused.out).toBe(f.manualProjectionB);
    expect(refused.status, refused.out).not.toBe(0);
    for (const { path, bytes } of before) expect(readFileSync(path), path).toEqual(bytes);
    expect(assertComposedScopeFile(f.scopes, f.nameB)).toBe(f.occupiedPath);
    expect(existsSync(f.aliasA)).toBe(false);
    expect(existsSync(f.canonicalB)).toBe(false);

    // init has cleaned its private staging tree before this child returns.
    // The collision diagnostic must identify the surviving LIVE entry and tell
    // the user how to retry the operation that actually failed.
    const collision = refused.out.split("\n").find((line) => line.includes("Cannot restore composed scope"));
    expect(collision, refused.out).toBeDefined();
    expect(collision).toContain(f.nameA);
    expect(collision).toContain(f.occupiedPath);
    expect(refused.out).not.toContain("aidlc-init-refresh-");
    expect(collision).toMatch(/\b(?:retry(?:ing)?|rerun|re-run)\b/i);
    expect(collision).toContain("original aidlc config command");
    expect(collision).toContain("same harness and source arguments");

    // Preserve B by moving its real bytes, then recover A through config refresh.
    expect(existsSync(f.canonicalB)).toBe(false);
    renameSync(assertComposedScopeFile(f.scopes, f.nameB), f.canonicalB);
    expect(existsSync(f.occupiedPath)).toBe(false);
    const recovered = f.refresh();
    expect(recovered.status, recovered.out).toBe(0);
    expect(assertComposedScopeFile(f.scopes, f.nameA)).toBe(f.occupiedPath);
    expect(assertComposedScopeFile(f.scopes, f.nameB)).toBe(f.canonicalB);
    expect(readFileSync(f.occupiedPath, "utf-8").trimEnd()).toBe(updatedIdentityA.trimEnd());
    expect(readFileSync(f.canonicalB, "utf-8")).toBe(f.manualProjectionB);
    expect(existsSync(f.aliasA)).toBe(false);
    expect(readFileSync(f.recordA, "utf-8")).toBe(updatedRecordA);
    expect(readFileSync(f.recordB, "utf-8")).toBe(f.originalRecordB);
    expect(readGrid(f.proj)[f.nameA].stages).toEqual(LIVE_STAGES);
    expect(readGrid(f.proj)[f.nameB].stages).toEqual(f.stagesB);
    const baseline = JSON.parse(readFileSync(f.baselinePath, "utf-8"));
    expect(baseline.files[f.baselineKeyB]).toBe(
      `sha256:${createHash("sha256").update(readFileSync(f.occupiedPath)).digest("hex")}`,
    );
    expect(baseline.files[`.claude/scopes/aidlc-${f.nameB}.md`]).toBe(
      `sha256:${createHash("sha256").update(f.manualProjectionB).digest("hex")}`,
    );
    const row = durabilityRow(doctor(f.proj).out);
    expect(row).toContain("recorded and projected");
    expect(row).not.toContain("problem(s)");
  }, 180_000);

  test("a staged refresh restores a record whose projection is already gone", () => {
    const proj = mkdtempSync(join(tmpdir(), "aidlc-t341-update-"));
    projects.push(proj);

    // A real install, so the refresh has a baseline to work from.
    const installed = init(proj, [
      "config", "--project-dir", proj, "--from", CLAUDE_RELEASE, "--harness", "claude",
    ]);
    expect(installed.status, installed.out).toBe(0);

    // Compose the old way, then let compile mint the durable record.
    const authored = authorLegacyComposedScope(proj);
    expect(compile(proj).status).toBe(0);
    expect(existsSync(recordPath(proj))).toBe(true);

    // Now destroy the harness projection — the state a reinstall leaves.
    simulateReinstall(proj);
    expect(existsSync(identityPath(proj))).toBe(false);
    expect(readGrid(proj)[SCOPE]).toBeUndefined();

    // Refresh from the same release through project config. That path must
    // restore both halves without a separate compile CLI invocation.
    const refreshed = init(proj, ["config", "--project-dir", proj, "--from", CLAUDE_RELEASE]);
    expect(refreshed.status, refreshed.out).toBe(0);

    expect(existsSync(identityPath(proj))).toBe(true);
    expect(readFileSync(identityPath(proj), "utf-8").trimEnd()).toBe(LIVE_SCOPE_MD.trimEnd());
    expect(readGrid(proj)[SCOPE]?.stages).toEqual(authored);
    // And the installed tree is healthy by its own report.
    expect(durabilityRow(doctor(proj).out)).toContain("recorded and projected");
  }, 180_000);
});
