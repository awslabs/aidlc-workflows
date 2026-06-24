// covers: function:activeSpace, function:activeIntent, function:recordDir, function:relativeRecordDir, function:stateFilePath, function:auditFilePath, function:uuidv7, function:slugify, function:migrateFlatLayout, function:knowledgeDir
//
// t160 — P1 Step B re-root: the per-intent record-dir resolution + the flat
// legacy fallback + the one-time crash-safe migration. Mechanism: in-process
// (the resolvers + migration are pure-ish lib functions; no LLM, no process
// boundary needed). The path helpers re-root the whole record tree per intent —
// aidlc/spaces/<space>/intents/<slug>-<id8>/ — when a new-layout intent resolves,
// and fall back to the flat aidlc-docs/ root otherwise (so a pre-workspace
// project keeps working until migrated).
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/aidlc-lib.ts):
//   activeSpace/activeIntent/recordDir/relativeRecordDir — the selectors.
//   stateFilePath/auditFilePath/auditShards/readAllAuditShards — re-rooted paths.
//   uuidv7/slugify/idSuffix — intent identity.
//   needsFlatMigration/migrateFlatLayout/appendIntentToRegistry — the migration.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeIntent,
  activeSpace,
  auditFilePath,
  auditShardName,
  auditShards,
  idSuffix,
  intentsDir,
  knowledgeDir,
  listIntentDirs,
  migrateFlatLayout,
  migratedMarkerPath,
  needsFlatMigration,
  readAllAuditShards,
  recordDir,
  relativeRecordDir,
  slugify,
  stateFilePath,
  uuidv7,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, removeWorkspaceRecord } from "../harness/fixtures.ts";

let proj: string;

/** Seed a SEED-style workspace shell (aidlc/active-space + spaces/default/ but
 *  NO intents dir / record) — exactly what dist/<harness>/aidlc/ ships. */
function seedShell(p: string, space = "default"): void {
  mkdirSync(join(p, "aidlc", "spaces", space, "memory"), { recursive: true });
  writeFileSync(join(p, "aidlc", "active-space"), `${space}\n`, "utf-8");
}

/** Seed a per-intent record (aidlc/spaces/<space>/intents/<dir>/aidlc-state.md). */
function seedIntent(p: string, dir: string, space = "default"): void {
  const recDir = join(p, "aidlc", "spaces", space, "intents", dir);
  mkdirSync(recDir, { recursive: true });
  writeFileSync(join(recDir, "aidlc-state.md"), "- **Current Stage**: requirements-analysis\n", "utf-8");
}

/** Seed a flat legacy project (aidlc-docs/aidlc-state.md). createTestProject
 *  already makes aidlc-docs/; this writes the state file. */
function seedFlat(p: string): void {
  mkdirSync(join(p, "aidlc-docs"), { recursive: true });
  writeFileSync(join(p, "aidlc-docs", "aidlc-state.md"), "- **Current Stage**: requirements-analysis\n- **Workflow**: Build Auth Service\n", "utf-8");
}

beforeEach(() => {
  proj = createTestProject();
  // t160 drives resolution from a controlled blank slate via seedShell/seedIntent
  // below, so strip the default record createTestProject now seeds (P9) — these
  // tests assert the resolver's behaviour with NO intent, a lone intent, etc.
  removeWorkspaceRecord(proj);
});
afterEach(() => {
  cleanupTestProject(proj);
});

describe("t160 intent identity — uuidv7 + slugify", () => {
  test("uuidv7 is a valid, time-ordered v7 uuid", async () => {
    const a = uuidv7();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Time-ordered ACROSS milliseconds: the 48-bit timestamp prefix of a later
    // mint sorts >= an earlier one. (Within one ms the random tail is unordered —
    // UUIDv7 only guarantees ordering across distinct ms, so sleep past a ms.)
    await new Promise((r) => setTimeout(r, 3));
    const b = uuidv7();
    expect(b > a).toBe(true); // strictly later ms → strictly greater
  });

  test("uuidv7s are unique across a tight loop", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(uuidv7());
    expect(seen.size).toBe(200);
  });

  test("idSuffix takes the trailing hex (dashes stripped)", () => {
    const u = "019ed236-1bf2-7598-9d74-95a1a16eff89";
    expect(idSuffix(u)).toBe("a16eff89");
    expect(idSuffix(u, 10)).toBe("a1a16eff89");
  });

  test("slugify → SLUG_RE-valid kebab, deterministic + idempotent", () => {
    const SLUG_RE = /^[a-z][a-z0-9-]*$/;
    for (const input of ["Build the Auth Service!", "  EXPORT bug #42 ", "123 start", "...", "café münchen"]) {
      const s = slugify(input);
      expect(s).toMatch(SLUG_RE);
      expect(slugify(s)).toBe(s); // idempotent
    }
    expect(slugify("Build the Auth Service!")).toBe(slugify("Build the Auth Service!")); // deterministic
    expect(slugify("...")).toBe("intent"); // empty reduction → fallback
    expect(slugify("123 start")).toMatch(/^intent-/); // leading non-letter → prefixed
  });
});

describe("t160 selectors — space + intent resolution", () => {
  test("activeSpace defaults to 'default' with no cursor; reads the cursor when present", () => {
    expect(activeSpace(proj)).toBe("default");
    seedShell(proj, "team-b");
    expect(activeSpace(proj)).toBe("team-b");
  });

  test("knowledgeDir resolves the SPACE-level knowledge dir for the active (or explicit) space", () => {
    // Space domain knowledge is a sibling of intents under spaces/<space>/, NOT
    // per-intent. Default with no cursor:
    expect(knowledgeDir(proj)).toBe(join(proj, "aidlc", "spaces", "default", "knowledge"));
    // Explicit space arg overrides:
    expect(knowledgeDir(proj, "team-b")).toBe(join(proj, "aidlc", "spaces", "team-b", "knowledge"));
    // And it follows the active-space cursor (must NOT hardcode default):
    seedShell(proj, "team-b");
    expect(knowledgeDir(proj)).toBe(join(proj, "aidlc", "spaces", "team-b", "knowledge"));
  });

  test("activeIntent: explicit > cursor > lone-intent > null", () => {
    seedShell(proj);
    // 0 records → null (flat fallback)
    expect(activeIntent(proj, "default")).toBeNull();
    // lone intent → that record
    seedIntent(proj, "auth-aaaaaaaa");
    expect(activeIntent(proj, "default")).toBe("auth-aaaaaaaa");
    // a second record with no cursor → ambiguous → null (handler layer prompts)
    seedIntent(proj, "export-bbbbbbbb");
    expect(activeIntent(proj, "default")).toBeNull();
    // cursor names one → that one
    writeFileSync(join(intentsDir(proj, "default"), "active-intent"), "export-bbbbbbbb\n", "utf-8");
    expect(activeIntent(proj, "default")).toBe("export-bbbbbbbb");
    // explicit arg overrides the cursor
    expect(activeIntent(proj, "default", "auth-aaaaaaaa")).toBe("auth-aaaaaaaa");
  });

  test("listIntentDirs returns only dirs holding aidlc-state.md, sorted", () => {
    seedShell(proj);
    seedIntent(proj, "zeta-22222222");
    seedIntent(proj, "alpha-11111111");
    // a stray dir with no state file is NOT a record
    mkdirSync(join(intentsDir(proj, "default"), "not-a-record"), { recursive: true });
    expect(listIntentDirs(proj, "default")).toEqual(["alpha-11111111", "zeta-22222222"]);
  });
});

describe("t160 path re-root — per-intent layout vs bare space root (P9 end state)", () => {
  test("no intent resolves → bare space record root (no flat aidlc-docs/ fallback)", () => {
    seedShell(proj); // a SEED shell, no intent born yet
    expect(recordDir(proj)).toBeNull();
    expect(relativeRecordDir(proj)).toBeNull();
    // End state: resolves under the bare space record root, NEVER the flat root.
    const intentsRoot = join(proj, "aidlc", "spaces", "default", "intents");
    expect(stateFilePath(proj)).toBe(join(intentsRoot, "aidlc-state.md"));
    expect(stateFilePath(proj)).not.toBe(join(proj, "aidlc-docs", "aidlc-state.md"));
    expect(auditFilePath(proj)).toBe(join(intentsRoot, "audit", auditShardName(proj)));
  });

  test("new-layout intent (lone) → per-intent record dir", () => {
    seedShell(proj);
    seedIntent(proj, "auth-deadbeef");
    expect(recordDir(proj)).toBe(join(proj, "aidlc", "spaces", "default", "intents", "auth-deadbeef"));
    expect(relativeRecordDir(proj)).toBe("aidlc/spaces/default/intents/auth-deadbeef");
    expect(stateFilePath(proj)).toBe(join(proj, "aidlc", "spaces", "default", "intents", "auth-deadbeef", "aidlc-state.md"));
    // audit is a per-clone shard under audit/
    expect(auditFilePath(proj)).toBe(join(proj, "aidlc", "spaces", "default", "intents", "auth-deadbeef", "audit", auditShardName(proj)));
  });

  test("explicit intent + space arg overrides resolution", () => {
    seedShell(proj, "team-b");
    seedIntent(proj, "x-11111111", "team-b");
    seedIntent(proj, "y-22222222", "team-b");
    expect(stateFilePath(proj, "y-22222222", "team-b")).toBe(
      join(proj, "aidlc", "spaces", "team-b", "intents", "y-22222222", "aidlc-state.md"),
    );
  });
});

describe("t160 two-intent isolation", () => {
  test("driving one intent never touches another's state/audit path", () => {
    seedShell(proj);
    seedIntent(proj, "auth-aaaaaaaa");
    seedIntent(proj, "export-bbbbbbbb");
    const authState = stateFilePath(proj, "auth-aaaaaaaa");
    const exportState = stateFilePath(proj, "export-bbbbbbbb");
    expect(authState).not.toBe(exportState);
    const authAuditDir = join(recordDir(proj, "auth-aaaaaaaa") as string, "audit");
    const exportAuditDir = join(recordDir(proj, "export-bbbbbbbb") as string, "audit");
    expect(authAuditDir).not.toBe(exportAuditDir);
    // Writing into one intent's record leaves the other's tree untouched.
    mkdirSync(authAuditDir, { recursive: true });
    writeFileSync(join(authAuditDir, auditShardName(proj)), "## X\n**Timestamp**: 2026-01-01T00:00:00Z\n**Event**: STAGE_STARTED\n\n---\n", "utf-8");
    expect(readAllAuditShards(proj, "auth-aaaaaaaa")).toContain("STAGE_STARTED");
    expect(readAllAuditShards(proj, "export-bbbbbbbb")).toBe(""); // untouched
  });
});

describe("t160 audit shards — per-clone, glob-merge read", () => {
  test("two clones' shards both survive and merge in the read", () => {
    seedShell(proj);
    seedIntent(proj, "auth-aaaaaaaa");
    const auditDir = join(recordDir(proj, "auth-aaaaaaaa") as string, "audit");
    mkdirSync(auditDir, { recursive: true });
    // Two distinct clone shards.
    writeFileSync(join(auditDir, "hostA-1001.md"), "## A\n**Timestamp**: 2026-01-01T00:00:01Z\n**Event**: STAGE_STARTED\n\n---\n", "utf-8");
    writeFileSync(join(auditDir, "hostB-2002.md"), "## B\n**Timestamp**: 2026-01-01T00:00:02Z\n**Event**: STAGE_COMPLETED\n\n---\n", "utf-8");
    const shards = auditShards(proj, "auth-aaaaaaaa");
    expect(shards.length).toBe(2);
    const merged = readAllAuditShards(proj, "auth-aaaaaaaa");
    expect(merged).toContain("STAGE_STARTED");
    expect(merged).toContain("STAGE_COMPLETED");
    // Both blocks parse (separator preserved across the concat join).
    expect(merged.split("\n---\n").filter((b) => b.includes("**Event**")).length).toBe(2);
  });
});

describe("t160 flat-layout migration — crash-safe, idempotent", () => {
  test("migrates a flat project into a per-intent record + writes the marker LAST", () => {
    seedShell(proj); // SEED ships aidlc/spaces/default/ — migration must still fire
    seedFlat(proj);
    expect(needsFlatMigration(proj)).toBe(true);
    const res = migrateFlatLayout(proj);
    expect(res).not.toBeNull();
    const r = res as NonNullable<typeof res>;
    // `<YYMMDD>-<label>`; the label is the slugified flat-state Workflow field
    // ("build auth service" → "build-auth-service", ≤24 chars so it survives whole).
    expect(r.intentDirName).toMatch(/^\d{6}-build-auth-service$/);
    // The state moved into the per-intent record.
    const newState = join(intentsDir(proj, "default"), r.intentDirName, "aidlc-state.md");
    expect(existsSync(newState)).toBe(true);
    expect(readFileSync(newState, "utf-8")).toContain("Current Stage");
    // The registry got the entry — and stores the dirName verbatim (the readers
    // join the row to its dir by this field, not by reconstructing it).
    const registry = JSON.parse(readFileSync(join(intentsDir(proj, "default"), "intents.json"), "utf-8"));
    expect(registry.length).toBe(1);
    expect(registry[0].uuid).toBe(r.uuid);
    expect(registry[0].dirName).toBe(r.intentDirName);
    expect(registry[0].status).toBe("in-flight");
    // The marker is written.
    expect(existsSync(migratedMarkerPath(proj))).toBe(true);
    // The source flat tree is NOT deleted (the caller git-rm's it; lib never rmSync's it).
    expect(existsSync(join(proj, "aidlc-docs", "aidlc-state.md"))).toBe(true);
    expect(r.movedFrom).toBe(join(proj, "aidlc-docs"));
  });

  test("relocates the flat aidlc-docs/knowledge/ tree to SPACE-level knowledge/, not into the record", () => {
    seedShell(proj);
    seedFlat(proj);
    // A migrating team's accumulated domain knowledge lived flat under
    // aidlc-docs/knowledge/. Seed both the shared overlay and a per-agent dir.
    mkdirSync(join(proj, "aidlc-docs", "knowledge", "aidlc-shared"), { recursive: true });
    writeFileSync(join(proj, "aidlc-docs", "knowledge", "aidlc-shared", "company-standards.md"), "# Standards\n", "utf-8");
    mkdirSync(join(proj, "aidlc-docs", "knowledge", "aidlc-architect-agent"), { recursive: true });
    writeFileSync(join(proj, "aidlc-docs", "knowledge", "aidlc-architect-agent", "patterns.md"), "# Patterns\n", "utf-8");

    const res = migrateFlatLayout(proj);
    expect(res).not.toBeNull();
    const r = res as NonNullable<typeof res>;

    // Knowledge landed at the SPACE level (a sibling of intents), with content intact.
    const spaceKnowledge = join(proj, "aidlc", "spaces", "default", "knowledge");
    expect(existsSync(join(spaceKnowledge, "aidlc-shared", "company-standards.md"))).toBe(true);
    expect(existsSync(join(spaceKnowledge, "aidlc-architect-agent", "patterns.md"))).toBe(true);
    // It is NOT trapped inside the per-intent record.
    const record = join(intentsDir(proj, "default"), r.intentDirName);
    expect(existsSync(join(record, "knowledge"))).toBe(false);
  });

  test("knowledge relocation MERGES into a pre-existing space knowledge dir (no data loss either side)", () => {
    seedShell(proj);
    seedFlat(proj);
    // A space that already has its own knowledge (e.g. seeded by a prior intent).
    const spaceKnowledge = join(proj, "aidlc", "spaces", "default", "knowledge");
    mkdirSync(join(spaceKnowledge, "aidlc-shared"), { recursive: true });
    writeFileSync(join(spaceKnowledge, "aidlc-shared", "existing.md"), "# Existing\n", "utf-8");
    // The flat tree brings a NEW per-agent dir AND a same-named aidlc-shared/ with a new file.
    mkdirSync(join(proj, "aidlc-docs", "knowledge", "aidlc-shared"), { recursive: true });
    writeFileSync(join(proj, "aidlc-docs", "knowledge", "aidlc-shared", "incoming.md"), "# Incoming\n", "utf-8");
    mkdirSync(join(proj, "aidlc-docs", "knowledge", "aidlc-developer-agent"), { recursive: true });
    writeFileSync(join(proj, "aidlc-docs", "knowledge", "aidlc-developer-agent", "conv.md"), "# Conv\n", "utf-8");

    expect(migrateFlatLayout(proj)).not.toBeNull();
    // Pre-existing content survives (merge, not clobber)...
    expect(existsSync(join(spaceKnowledge, "aidlc-shared", "existing.md"))).toBe(true);
    // ...AND the incoming content merged into the same aidlc-shared/ dir...
    expect(existsSync(join(spaceKnowledge, "aidlc-shared", "incoming.md"))).toBe(true);
    // ...AND the new per-agent dir landed.
    expect(existsSync(join(spaceKnowledge, "aidlc-developer-agent", "conv.md"))).toBe(true);
  });

  test("knowledge relocation is committed by the SAME atomic rename — a crash before the marker re-fires cleanly (no stranded knowledge)", () => {
    // Crash-safety: knowledge is relocated off the STAGING tree before the atomic
    // rename + before the .migrated marker, so the migration is re-runnable until
    // the marker lands. Simulate a crash AFTER a parent mkdir but with no record /
    // no marker, with flat knowledge present; the re-run must still relocate it.
    seedShell(proj);
    seedFlat(proj);
    mkdirSync(join(proj, "aidlc-docs", "knowledge", "aidlc-shared"), { recursive: true });
    writeFileSync(join(proj, "aidlc-docs", "knowledge", "aidlc-shared", "k.md"), "# K\n", "utf-8");
    mkdirSync(intentsDir(proj, "default"), { recursive: true }); // crashed-parent artifact
    expect(needsFlatMigration(proj)).toBe(true);

    expect(migrateFlatLayout(proj)).not.toBeNull();
    const spaceKnowledge = join(proj, "aidlc", "spaces", "default", "knowledge");
    expect(existsSync(join(spaceKnowledge, "aidlc-shared", "k.md"))).toBe(true);
    expect(existsSync(migratedMarkerPath(proj))).toBe(true);
    // The flat source is untouched (the caller git-rm's it).
    expect(existsSync(join(proj, "aidlc-docs", "knowledge", "aidlc-shared", "k.md"))).toBe(true);
  });

  test("idempotency keys on the .migrated marker ALONE — re-run is a no-op", () => {
    seedShell(proj);
    seedFlat(proj);
    const first = migrateFlatLayout(proj);
    expect(first).not.toBeNull();
    const beforeDirs = readdirSync(intentsDir(proj, "default"));
    // Second run: marker present → no-op, no second intent dir.
    expect(needsFlatMigration(proj)).toBe(false);
    const second = migrateFlatLayout(proj);
    expect(second).toBeNull();
    expect(readdirSync(intentsDir(proj, "default")).filter((d) => d.endsWith(".md") === false).sort())
      .toEqual(beforeDirs.filter((d) => d.endsWith(".md") === false).sort());
  });

  test("crash after a partial stage → re-run completes, source intact", () => {
    seedShell(proj);
    seedFlat(proj);
    // Simulate a crash AFTER the parent mkdir but BEFORE the move/marker: create
    // the intents parent dir + a stray staging dir, NO record, NO marker.
    mkdirSync(intentsDir(proj, "default"), { recursive: true });
    mkdirSync(join(proj, "aidlc", ".migrate-staging-99999-stale"), { recursive: true });
    // Detection still fires (no record, no marker) despite the parent dir existing.
    expect(needsFlatMigration(proj)).toBe(true);
    const res = migrateFlatLayout(proj);
    expect(res).not.toBeNull();
    // The source survived the crashed-then-completed run.
    expect(existsSync(join(proj, "aidlc-docs", "aidlc-state.md"))).toBe(true);
    expect(existsSync(migratedMarkerPath(proj))).toBe(true);
  });

  test("a SEED-shipped aidlc/spaces/default/ does NOT defeat detection", () => {
    // The blocker: detecting "no aidlc/spaces/ dir" would never fire because SEED
    // ships it. Detection keys on flat-state-present + no-record + no-marker.
    seedShell(proj); // ships aidlc/spaces/default/
    seedFlat(proj);
    expect(needsFlatMigration(proj)).toBe(true);
  });

  test("a fresh SEED shell with no flat state needs no migration", () => {
    seedShell(proj);
    rmSync(join(proj, "aidlc-docs"), { recursive: true, force: true });
    expect(needsFlatMigration(proj)).toBe(false);
    expect(migrateFlatLayout(proj)).toBeNull();
  });

  test("an already-born intent (record present) blocks re-migration even without a marker", () => {
    seedShell(proj);
    seedFlat(proj);
    seedIntent(proj, "born-cccccccc"); // a record already exists
    expect(needsFlatMigration(proj)).toBe(false);
  });
});
