// covers: subcommand:aidlc-learnings:persist, subcommand:aidlc-learnings:surface
//
// t300 - aidlc-learnings.ts persist's cid marker + provenance binding.
// Regression test for the defect reported in #735 AND the follow-up
// findings from PR #747's two review rounds (leandrodamascena,
// apackeer). Supersedes t278-learnings-cid-intent-scope.test.ts (that slot
// is now owned by merged PR #617's t278-per-unit-wave suite).
//
// Mechanism: cli. Internals (cidMarker/contentHash/handlePersist/
// resolveSurfaceIntent) are not exported, so the contract is exercised
// behaviourally through the process boundary exactly as t112/t199 do.
//
// FOUR findings fixed here, one test group each:
//   1. Same-intent repeat-stage collision (P1) — candidate ids restart at
//      c1 on every surface() call, so two DIFFERENT learnings landing on
//      the same positional c1 within the SAME intent must both persist,
//      not collide.
//   2. Selections not bound to their originating intent (P1) — persist
//      must use the space/intent PINNED in the selections-json (surface
//      time), never the live active-intent cursor at execution time.
//   3. Existing markers duplicated after upgrade (P1) — a retry of an
//      already-persisted (pre-fix-format) learning must not duplicate it
//      under the new marker.
//   4. Ambiguous intent resolution must fail closed (P2) — multiple intent
//      records with no valid cursor must fail, not silently degrade to a
//      shared "unscoped" identity.
//
// Source under test (dist/claude/.claude/tools/aidlc-learnings.ts):
//   cidMarker(intentSlug, slug, hash) => `<!-- cid:${intentSlug}:${slug}:${hash} -->`
//   contentHash(text) => sha256(text) truncated to 8 hex chars.
//   SelectionsFile now REQUIRES { space, intent } — bound at surface() time,
//   read (never re-resolved) by handlePersist.
//   resolveSurfaceIntent() fails closed on genuine multi-intent ambiguity.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const LEARNINGS_TS = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");
const STAGE_SLUG = "user-stories";
const CANDIDATE_ID = "c1";
const SECOND_RECORD_DIR = "fixture-b2222222";
const THIRD_RECORD_DIR = "fixture-c3333333";
const HASH_RE = /[0-9a-f]{8}/;

const projects: string[] = [];
afterEach(() => {
  for (const p of projects) rmSync(p, { recursive: true, force: true });
  projects.length = 0;
});

// createTestProject() seeds the record DIRECTORY but deliberately leaves
// aidlc-state.md absent (other tests rely on that "no active intent yet"
// shape) - activeIntent() requires the file to exist before it will resolve
// the cursor's named record, so this helper writes it explicitly.
function mkProject(): string {
  const pd = createTestProject();
  projects.push(pd);
  writeFileSync(
    seededStateFile(pd),
    "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Scope**: feature\n",
    "utf-8",
  );
  return pd;
}

/** Write a `type: "learning"` selections file for one candidate, with
 *  provenance pinned exactly as surface() would bind it. */
function selectionsFile(
  pd: string,
  name: string,
  text: string,
  opts: { intent?: string | null; space?: string; candidateId?: string } = {},
): string {
  const p = join(pd, `${name}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      stage_slug: STAGE_SLUG,
      space: opts.space ?? DEFAULT_SPACE,
      intent: opts.intent === undefined ? DEFAULT_RECORD_DIR : opts.intent,
      selections: [
        {
          candidate_id: opts.candidateId ?? CANDIDATE_ID,
          type: "learning",
          scope: "project",
          heading: "Corrections",
          text,
        },
      ],
    }),
    "utf-8",
  );
  return p;
}

function runPersist(pd: string, selJson: string): { status: number; out: string } {
  const r = spawnSync(
    BUN,
    [LEARNINGS_TS, "persist", "--slug", STAGE_SLUG, "--selections-json", selJson, "--project-dir", pd],
    { encoding: "utf-8" },
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function runSurface(pd: string): { status: number; out: string } {
  const r = spawnSync(
    BUN,
    [LEARNINGS_TS, "surface", "--slug", STAGE_SLUG, "--project-dir", pd],
    { encoding: "utf-8" },
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function projectMd(pd: string): string {
  return readFileSync(join(pd, "aidlc", "spaces", DEFAULT_SPACE, "memory", "project.md"), "utf-8");
}

/** Seed a second, unrelated intent record dir. Does NOT switch the cursor —
 *  callers that need it active call switchActiveIntentTo() separately. */
function seedIntent(pd: string, recordDir: string): void {
  const intentsDir = intentsDirOf(pd, DEFAULT_SPACE);
  mkdirSync(join(intentsDir, recordDir), { recursive: true });
  writeFileSync(
    join(intentsDir, recordDir, "aidlc-state.md"),
    "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Scope**: feature\n",
    "utf-8",
  );
}

function switchActiveIntentTo(pd: string, recordDir: string): void {
  const intentsDir = intentsDirOf(pd, DEFAULT_SPACE);
  writeFileSync(join(intentsDir, "active-intent"), `${recordDir}\n`, "utf-8");
}

function clearActiveIntentCursor(pd: string): void {
  const intentsDir = intentsDirOf(pd, DEFAULT_SPACE);
  rmSync(join(intentsDir, "active-intent"), { force: true });
}

describe("t300 aidlc-learnings persist/surface — #735 follow-up (PR #747 review)", () => {
  describe("cross-intent scoping (original #735 fix, re-verified under the new marker)", () => {
    test("two intents' identically-numbered candidates for the same stage both persist, not collide", () => {
      const pd = mkProject();

      const selA = selectionsFile(pd, "sel-a", "Learning from intent A", { intent: DEFAULT_RECORD_DIR });
      const resA = runPersist(pd, selA);
      expect(resA.status).toBe(0);
      expect(JSON.parse(resA.out).rule_learned).toBe(1);

      const afterA = projectMd(pd);
      expect(afterA).toContain("Learning from intent A");
      expect(afterA).toMatch(new RegExp(`cid:${DEFAULT_RECORD_DIR}:${STAGE_SLUG}:${HASH_RE.source}`));

      seedIntent(pd, SECOND_RECORD_DIR);
      const selB = selectionsFile(pd, "sel-b", "Learning from intent B", { intent: SECOND_RECORD_DIR });
      const resB = runPersist(pd, selB);
      expect(resB.status).toBe(0);
      expect(JSON.parse(resB.out).rule_learned).toBe(1);

      const afterB = projectMd(pd);
      expect(afterB).toContain("Learning from intent A");
      expect(afterB).toContain("Learning from intent B");
      expect(afterB).toMatch(new RegExp(`cid:${DEFAULT_RECORD_DIR}:${STAGE_SLUG}:${HASH_RE.source}`));
      expect(afterB).toMatch(new RegExp(`cid:${SECOND_RECORD_DIR}:${STAGE_SLUG}:${HASH_RE.source}`));
    }, 30000);

    test("a same-intent, same-day re-run of the identical selection remains a no-op (crash-recovery idempotency preserved)", () => {
      const pd = mkProject();
      const selA = selectionsFile(pd, "sel-a", "Learning from intent A", { intent: DEFAULT_RECORD_DIR });

      const first = runPersist(pd, selA);
      expect(first.status).toBe(0);
      expect(JSON.parse(first.out).rule_learned).toBe(1);

      const second = runPersist(pd, selA);
      expect(second.status).toBe(0);
      expect(JSON.parse(second.out).rule_learned).toBe(0);

      const content = projectMd(pd);
      const occurrences = content.split("Learning from intent A").length - 1;
      expect(occurrences).toBe(1);
    }, 30000);
  });

  describe("finding #1 (P1) — same-intent repeat-stage collision", () => {
    test("two DIFFERENT learnings on the same positional candidate_id, same intent, separate persist calls, both land", () => {
      const pd = mkProject();

      // Simulates two separate surface()+persist() runs of the SAME stage in
      // the SAME intent — candidate ids restart at c1 each time, but the
      // text differs, so they must be treated as distinct learnings.
      const run1 = selectionsFile(pd, "run1", "First run's c1: use structured logging", {
        intent: DEFAULT_RECORD_DIR,
        candidateId: "c1",
      });
      const res1 = runPersist(pd, run1);
      expect(res1.status).toBe(0);
      expect(JSON.parse(res1.out).rule_learned).toBe(1);

      const run2 = selectionsFile(pd, "run2", "Second run's c1: prefer composition over inheritance", {
        intent: DEFAULT_RECORD_DIR,
        candidateId: "c1",
      });
      const res2 = runPersist(pd, run2);
      expect(res2.status).toBe(0);
      // Pre-fix, this would have been silently dropped: hasLine/hasRow would
      // have matched run1's marker (same intent:stage:candidate-id), so the
      // write is skipped while RULE_LEARNED still fires and rule_learned
      // still reports 1 or 0 depending on emit path — the exact defect the
      // reviewer reproduced. Asserting rule_learned AND file content (not
      // just the reported count) is the point of this test.
      expect(JSON.parse(res2.out).rule_learned).toBe(1);

      const content = projectMd(pd);
      expect(content).toContain("First run's c1: use structured logging");
      expect(content).toContain("Second run's c1: prefer composition over inheritance");
    }, 30000);
  });

  describe("finding #2 (P1) — selections must bind to their originating intent, not the live cursor", () => {
    test("surface-under-A then switch-to-B then persist still writes under A's marker", () => {
      const pd = mkProject(); // DEFAULT_RECORD_DIR is active
      seedIntent(pd, SECOND_RECORD_DIR);

      // Selection was surfaced while A was active — pinned intent: A.
      const selUnderA = selectionsFile(pd, "sel-under-a", "Bound to A at surface time", {
        intent: DEFAULT_RECORD_DIR,
      });

      // Now switch the LIVE cursor to B before persisting.
      switchActiveIntentTo(pd, SECOND_RECORD_DIR);

      const res = runPersist(pd, selUnderA);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.out).rule_learned).toBe(1);

      const content = projectMd(pd);
      // Pre-fix, persist re-resolved activeIntent() live and would have
      // written under B's marker despite the selection being surfaced under
      // A — the reviewer's exact reproduction.
      expect(content).toMatch(new RegExp(`cid:${DEFAULT_RECORD_DIR}:${STAGE_SLUG}:${HASH_RE.source}`));
      expect(content).not.toMatch(new RegExp(`cid:${SECOND_RECORD_DIR}:${STAGE_SLUG}:${HASH_RE.source}`));
    }, 30000);
  });

  describe("finding #3 (P1) — legacy marker/audit-row compatibility on upgrade", () => {
    test("the ORIGINAL pre-#735 marker (<!-- cid:<stage>:<id> -->, no intent component at all) is recognized; retry does not duplicate", () => {
      // This is the literal scenario the reviewer named: "retrying a learning
      // previously persisted as `<!-- cid:<stage>:<candidate> -->`" — the
      // upstream format from BEFORE #735's own fix ever shipped, distinct
      // from #735's own (intent, stage, candidate-id) 3-part format covered
      // by the next test below. Both must independently work.
      const pd = mkProject();
      const text = "Original pre-#735 learning, already persisted once";

      const legacyMarker = `<!-- cid:${STAGE_SLUG}:${CANDIDATE_ID} -->`;
      writeFileSync(
        join(pd, "aidlc", "spaces", DEFAULT_SPACE, "memory", "project.md"),
        `# Project-Level Rules\n\n## Corrections\n\n- ${text} (learned 2026-07-01) ${legacyMarker}\n`,
        "utf-8",
      );
      const auditDir = join(intentsDirOf(pd, DEFAULT_SPACE), DEFAULT_RECORD_DIR, "audit");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(
        join(auditDir, "legacy-host-clone.md"),
        `**Timestamp**: 2026-07-01T00:00:00Z\n**Event**: RULE_LEARNED\n**Stage**: ${STAGE_SLUG}\n**Candidate-ID**: ${CANDIDATE_ID}\n**Destination**: project.md\n**Heading**: ## Corrections\n**Source**: orchestrator\n---\n`,
        "utf-8",
      );

      const sel = selectionsFile(pd, "retry-original", text, { intent: DEFAULT_RECORD_DIR, candidateId: CANDIDATE_ID });
      const res = runPersist(pd, sel);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.out).rule_learned).toBe(0);

      const content = projectMd(pd);
      const occurrences = content.split(text).length - 1;
      expect(occurrences).toBe(1);
    }, 30000);

    test("#735's OWN first-fix marker (candidate-id-scoped, 3-part) is recognized; retry does not duplicate", () => {
      const pd = mkProject();
      const text = "Pre-upgrade learning, already persisted once";

      // Hand-seed exactly what the PRE-#747-fix tool would have left behind:
      // an audit row keyed by (Stage, Candidate-ID) with no Content-Hash, and
      // a practice line under the OLD (intent, stage, candidate-id) marker.
      const legacyMarker = `<!-- cid:${DEFAULT_RECORD_DIR}:${STAGE_SLUG}:${CANDIDATE_ID} -->`;
      writeFileSync(
        join(pd, "aidlc", "spaces", DEFAULT_SPACE, "memory", "project.md"),
        `# Project-Level Rules\n\n## Corrections\n\n- ${text} (learned 2026-08-01) ${legacyMarker}\n`,
        "utf-8",
      );
      const auditDir = join(intentsDirOf(pd, DEFAULT_SPACE), DEFAULT_RECORD_DIR, "audit");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(
        join(auditDir, "legacy-host-clone.md"),
        `**Timestamp**: 2026-08-01T00:00:00Z\n**Event**: RULE_LEARNED\n**Stage**: ${STAGE_SLUG}\n**Candidate-ID**: ${CANDIDATE_ID}\n**Destination**: project.md\n**Heading**: ## Corrections\n**Source**: orchestrator\n---\n`,
        "utf-8",
      );

      // Retry the SAME learning post-upgrade (identical text, same intent,
      // same candidate_id — as if the orchestrator replayed the same
      // selections-json after the tool was upgraded).
      const sel = selectionsFile(pd, "retry", text, { intent: DEFAULT_RECORD_DIR, candidateId: CANDIDATE_ID });
      const res = runPersist(pd, sel);
      expect(res.status).toBe(0);
      // Pre-fix (finding #3): the new marker format wouldn't match the old
      // line, and the new Content-Hash audit check wouldn't match the old
      // row — so this would append a SECOND, duplicate line.
      expect(JSON.parse(res.out).rule_learned).toBe(0);

      const content = projectMd(pd);
      const occurrences = content.split(text).length - 1;
      expect(occurrences).toBe(1);
    }, 30000);
  });

  describe("selections-json schema validation — space/intent are required, not inferred", () => {
    test("missing space field fails loudly, not silently defaulting", () => {
      const pd = mkProject();
      const p = join(pd, "malformed-no-space.json");
      writeFileSync(
        p,
        JSON.stringify({
          stage_slug: STAGE_SLUG,
          intent: DEFAULT_RECORD_DIR,
          selections: [{ candidate_id: "c1", type: "learning", scope: "project", heading: "Corrections", text: "x" }],
        }),
        "utf-8",
      );
      const res = runPersist(pd, p);
      expect(res.status).toBe(1);
      expect(res.out).toContain("space");
    }, 30000);

    test("non-string, non-null intent field fails loudly", () => {
      const pd = mkProject();
      const p = join(pd, "malformed-bad-intent.json");
      writeFileSync(
        p,
        JSON.stringify({
          stage_slug: STAGE_SLUG,
          space: DEFAULT_SPACE,
          intent: 42,
          selections: [{ candidate_id: "c1", type: "learning", scope: "project", heading: "Corrections", text: "x" }],
        }),
        "utf-8",
      );
      const res = runPersist(pd, p);
      expect(res.status).toBe(1);
      expect(res.out).toContain("intent");
    }, 30000);
  });

  describe("finding #4 (P2) — ambiguous intent resolution fails closed", () => {
    test("zero intent records (bare flat/legacy workspace) is legitimately unscoped, not ambiguous", () => {
      // createTestProject() seeds DEFAULT_RECORD_DIR as an empty directory
      // (no aidlc-state.md inside it), so listIntentDirs sees ZERO records —
      // genuinely distinct from the "multiple records, no cursor" ambiguity
      // below. A bare/legacy workspace's state + runtime-graph resolve to
      // the space-root fallback (recordDir() -> null -> spaceRecordRoot()),
      // i.e. directly under intents/, not under any per-intent subdirectory
      // — confirmed by reading aidlc-lib.ts's own recordDir/docsRoot/
      // stateFilePath before writing this fixture, not guessed.
      const pd = createTestProject();
      projects.push(pd);
      const bareRoot = intentsDirOf(pd, DEFAULT_SPACE);
      mkdirSync(bareRoot, { recursive: true });
      writeFileSync(
        join(bareRoot, "aidlc-state.md"),
        "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Scope**: feature\n",
        "utf-8",
      );
      writeFileSync(
        join(bareRoot, "runtime-graph.json"),
        JSON.stringify({
          stages: [{ stage_slug: STAGE_SLUG, memory_path: `aidlc/spaces/${DEFAULT_SPACE}/intents/inception/${STAGE_SLUG}/memory.md` }],
        }),
        "utf-8",
      );

      const res = runSurface(pd);
      expect(res.status, res.out).toBe(0);
      const out = JSON.parse(res.out);
      expect(out.intent).toBeNull();
      expect(out.space).toBe(DEFAULT_SPACE);
    }, 30000);

    test("multiple intent records with no valid cursor fails closed, not silently unscoped", () => {
      const pd = mkProject(); // DEFAULT_RECORD_DIR seeded
      seedIntent(pd, SECOND_RECORD_DIR); // a second, real intent record
      seedIntent(pd, THIRD_RECORD_DIR); // a third — genuinely ambiguous
      clearActiveIntentCursor(pd);

      const res = runSurface(pd);
      // Pre-fix, this would have silently resolved intent: null and let
      // persist fall back to the shared "unscoped" identity — recreating
      // the exact collision class #735 exists to prevent.
      expect(res.status).toBe(1);
      expect(res.out).toContain("cannot resolve the active intent unambiguously");
    }, 30000);

    test("multiple intent records WITH a valid cursor still resolves normally (not treated as ambiguous)", () => {
      const pd = mkProject();
      seedIntent(pd, SECOND_RECORD_DIR);
      // seedIntent only writes aidlc-state.md (enough for listIntentDirs to
      // count it and for the ambiguity tests above); surface() also needs a
      // runtime-graph.json to read past assertActiveStage, so seed a minimal
      // one for the record this test actually activates.
      writeFileSync(
        join(intentsDirOf(pd, DEFAULT_SPACE), SECOND_RECORD_DIR, "runtime-graph.json"),
        JSON.stringify({
          stages: [{ stage_slug: STAGE_SLUG, memory_path: `aidlc/spaces/${DEFAULT_SPACE}/intents/${SECOND_RECORD_DIR}/inception/${STAGE_SLUG}/memory.md` }],
        }),
        "utf-8",
      );
      switchActiveIntentTo(pd, SECOND_RECORD_DIR);

      const res = runSurface(pd);
      expect(res.status, res.out).toBe(0);
      expect(JSON.parse(res.out).intent).toBe(SECOND_RECORD_DIR);
      expect(JSON.parse(res.out).space).toBe(DEFAULT_SPACE);
    }, 30000);
  });
});
