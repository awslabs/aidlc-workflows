// covers: subcommand:aidlc-learnings:persist, subcommand:aidlc-learnings:surface
//
// t306 - aidlc-learnings.ts persist's cid marker + provenance binding.
// Regression test for the defect reported in #735 AND the follow-up
// findings from PR #747's four review rounds (leandrodamascena,
// apackeer x3). Supersedes t278-learnings-cid-intent-scope.test.ts (that
// slot is now owned by merged PR #617's t278-per-unit-wave suite) and was
// itself renumbered from t300/t284/t278 as upstream v2's own test-slot
// registry advanced out from under this branch each re-slot.
//
// Mechanism: cli. Internals (cidMarker/contentHash/handlePersist/
// resolveSurfaceIntent/practiceFilePath/priorSensorProposedRow/
// legacyLineMatchesText) are not exported, so the contract is exercised
// behaviourally through the process boundary exactly as t112/t199 do.
//
// TWELVE findings fixed here, one test group each:
//   1. Same-intent repeat-stage collision (P1) — candidate ids restart at
//      c1 on every surface() call, so two DIFFERENT learnings landing on
//      the same positional c1 within the SAME intent must both persist,
//      not collide.
//   2. Selections not bound to their originating intent (P1) — persist
//      must use the space/intent PINNED in the selections-json (surface
//      time), never the live active-intent cursor at execution time.
//   3. Existing markers duplicated after upgrade (P1) — a retry of an
//      already-persisted candidate-id or truncated-hash learning must not
//      duplicate it under the new full-hash marker.
//   4. Ambiguous intent resolution must fail closed (P2) — multiple intent
//      records with no valid cursor must fail, not silently degrade to a
//      shared "unscoped" identity.
//   5. Practice file not pinned to the surfaced space (P1, round 2) —
//      practiceFilePath must resolve under the space PINNED at surface
//      time, not whatever space happens to be active when persist runs.
//   6. Sensor dedup keyed on the unstable (stage, candidate_id) pair (P2,
//      round 2) — a re-proposal of the SAME sensor id under a different
//      (restarts-at-c1) candidate id must not re-emit SENSOR_PROPOSED.
//   7. Legacy-marker match not gated on text equality (P2, round 2) — a
//      legacy-format marker sharing a candidate id with a DIFFERENT
//      learning's text must not be mistaken for a retry of that learning.
//   8. An unscoped selections replay must fail closed if an intent is born
//      after surface time — `intent: null` must never resolve to that later
//      live/lone intent for the audit write.
//   9. A truncated 32-bit content hash can collide for different learning
//      texts and silently discard the second write.
//  10. Repeated content in one selections batch must emit one audit row, not
//      one row per duplicate candidate from the stale audit snapshot.
//  11. Pinned space/intent provenance must still name existing records when
//      persist runs; syntactically valid ghost records must fail closed.
//  12. The optional CLI slug must not override the stage bound into the
//      selections file at surface time.
//
// Source under test (dist/claude/.claude/tools/aidlc-learnings.ts):
//   cidMarker(intentSlug, slug, hash) => `<!-- cid:${intentSlug}:${slug}:${hash} -->`
//   contentHash(text) => full sha256(text) hex digest.
//   SelectionsFile now REQUIRES { space, intent } — bound at surface() time,
//   read (never re-resolved) by handlePersist.
//   resolveSurfaceIntent() fails closed on genuine multi-intent ambiguity.
//   practiceFilePath(projectDir, scope, space) threads the pinned space into
//   memoryDirFor(projectDir, space).
//   priorSensorProposedRow(auditContent, stage, sensorId) dedups SENSOR_PROPOSED by
//   the sensor's own stable id, not (stage, candidate_id).
//   legacyLineMatchesText(content, marker, text) gates a legacy-marker match
//   on the marked line's own text equalling the current selection's text.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededStateFile,
} from "../harness/fixtures.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
const LEARNINGS_TS = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");
const STAGE_SLUG = "user-stories";
const CANDIDATE_ID = "c1";
const SECOND_RECORD_DIR = "fixture-b2222222";
const THIRD_RECORD_DIR = "fixture-c3333333";
const HASH_RE = /[0-9a-f]{64}/;

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

function runPersist(
  pd: string,
  selJson: string,
  opts: { slug?: string; env?: Record<string, string> } = {},
): { status: number; out: string } {
  const r = spawnSync(
    BUN,
    [LEARNINGS_TS, "persist", "--slug", opts.slug ?? STAGE_SLUG, "--selections-json", selJson, "--project-dir", pd],
    { encoding: "utf-8", env: opts.env ? { ...process.env, ...opts.env } : process.env },
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Seed a minimal stage .md file with a `sensors:` frontmatter list, at the
 *  path bindSensorToStage/findStageFile resolve under AIDLC_STAGES_DIR. */
function seedStageFile(stagesDir: string, phase: string, slug: string): void {
  const dir = join(stagesDir, phase);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    `---\nslug: ${slug}\nphase: ${phase}\nexecution: ALWAYS\nlead_agent: aidlc-product-agent\nsupport_agents: []\nsensors: []\ninputs: foo\noutputs: bar\n---\n\n# ${slug}\n\n## Steps\n1. do the thing\n`,
    "utf-8",
  );
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

/** Switch the workspace-wide active-SPACE cursor (aidlc/active-space) — the
 *  cursor practiceFilePath's pre-fix bug read live instead of using the
 *  space PINNED in the selections-json at surface() time. */
function switchActiveSpaceTo(pd: string, space: string): void {
  writeFileSync(join(pd, "aidlc", "active-space"), `${space}\n`, "utf-8");
}

function otherSpaceProjectMd(pd: string, space: string): string {
  return join(pd, "aidlc", "spaces", space, "memory", "project.md");
}

/** Write a `type: "sensor"` selections file for one candidate. */
function sensorSelectionsFile(
  pd: string,
  name: string,
  sensorId: string,
  opts: { originStage?: string; stageSlug?: string; candidateId?: string; intent?: string | null; space?: string } = {},
): string {
  const p = join(pd, `${name}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      stage_slug: opts.stageSlug ?? STAGE_SLUG,
      space: opts.space ?? DEFAULT_SPACE,
      intent: opts.intent === undefined ? DEFAULT_RECORD_DIR : opts.intent,
      selections: [
        {
          candidate_id: opts.candidateId ?? CANDIDATE_ID,
          type: "sensor",
          origin_stage: opts.originStage ?? STAGE_SLUG,
          manifest_fields: {
            id: sensorId,
            kind: "deterministic",
            command: `bun .claude/tools/aidlc-sensor.ts fire ${sensorId}`,
            default_severity: "advisory",
            description: "Test sensor",
            matches: "**/*",
          },
        },
      ],
    }),
    "utf-8",
  );
  return p;
}

describe("t306 aidlc-learnings persist/surface — #735 follow-up (PR #747 review)", () => {
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

    test("the earlier truncated content-hash marker is recognized; retry upgrades without duplicating", () => {
      const pd = mkProject();
      const text = "Learning persisted by an earlier PR revision";
      const fullHash = createHash("sha256").update(text, "utf-8").digest("hex");
      const shortHash = fullHash.slice(0, 8);
      const priorMarker = `<!-- cid:${DEFAULT_RECORD_DIR}:${STAGE_SLUG}:${shortHash} -->`;
      writeFileSync(
        join(pd, "aidlc", "spaces", DEFAULT_SPACE, "memory", "project.md"),
        `# Project-Level Rules\n\n## Corrections\n\n- ${text} (learned 2026-08-20) ${priorMarker}\n`,
        "utf-8",
      );
      const auditDir = join(intentsDirOf(pd, DEFAULT_SPACE), DEFAULT_RECORD_DIR, "audit");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(
        join(auditDir, "short-hash-host.md"),
        `**Timestamp**: 2026-08-20T00:00:00Z\n**Event**: RULE_LEARNED\n**Stage**: ${STAGE_SLUG}\n**Candidate-ID**: ${CANDIDATE_ID}\n**Content-Hash**: ${shortHash}\n**Destination**: project.md\n**Heading**: ## Corrections\n**Source**: orchestrator\n---\n`,
        "utf-8",
      );

      const result = runPersist(pd, selectionsFile(pd, "short-hash-retry", text));
      expect(result.status).toBe(0);
      expect(JSON.parse(result.out).rule_learned).toBe(0);
      expect(projectMd(pd).split(text).length - 1).toBe(1);
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

    test("path-traversing space fails before writing outside aidlc/spaces", () => {
      const pd = mkProject();
      const escaped = join(pd, "escaped-space");
      const sel = selectionsFile(pd, "malformed-space-traversal", "must not escape", {
        space: "../../escaped-space",
      });

      const res = runPersist(pd, sel);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("lowercase slug");
      expect(existsSync(escaped)).toBe(false);
    }, 30000);

    test("non-conforming space name fails loudly", () => {
      const pd = mkProject();
      const sel = selectionsFile(pd, "malformed-space-shape", "must not write", {
        space: "Bad Space",
      });

      const res = runPersist(pd, sel);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("lowercase slug");
    }, 30000);

    test("path-traversing intent fails before audit-path resolution", () => {
      const pd = mkProject();
      const sel = selectionsFile(pd, "malformed-intent-traversal", "must not escape", {
        intent: "../../escaped-intent",
      });

      const res = runPersist(pd, sel);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("record-directory name");
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

  describe("finding #5 (P1, round 2) — the practice file must land in the SURFACED space, not the live active space", () => {
    test("surface-under-default then switch active space to 'other' then persist still writes into default's project.md", () => {
      const pd = mkProject(); // active space is DEFAULT_SPACE
      const sel = selectionsFile(pd, "sel-space", "Bound to default at surface time", {
        intent: DEFAULT_RECORD_DIR,
        space: DEFAULT_SPACE,
      });

      // Switch the LIVE active-space cursor away from the space the
      // selection was pinned to at surface() time — the reviewer's exact
      // repro: seed in space default, switch active space to other, persist.
      switchActiveSpaceTo(pd, "other");

      const res = runPersist(pd, sel);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.out).rule_learned).toBe(1);

      // Pre-fix, practiceFilePath called memoryDirFor(projectDir) with no
      // space argument, which reads the LIVE active-space cursor — landing
      // the line in "other"'s project.md instead of the pinned "default"'s.
      const content = projectMd(pd);
      expect(content).toContain("Bound to default at surface time");

      const otherPath = otherSpaceProjectMd(pd, "other");
      const otherContent = existsSync(otherPath) ? readFileSync(otherPath, "utf-8") : "";
      expect(otherContent).not.toContain("Bound to default at surface time");
    }, 30000);
  });

  describe("finding #6 (P2, round 2) — sensor dedup must key on the sensor's own stable id, not (stage, candidate_id)", () => {
    test("the same sensor id proposed under a DIFFERENT candidate id (a later surface() run) is not re-proposed", () => {
      const pd = mkProject();
      const sel1 = sensorSelectionsFile(pd, "sensor-run1", "acceptance-format", { candidateId: "c1" });
      const res1 = runPersist(pd, sel1);
      expect(res1.status).toBe(0);
      expect(JSON.parse(res1.out).sensor_proposed).toBe(1);

      // Candidate ids restart at c1 on every surface() run, so a LATER run
      // proposing the identical sensor id lands on a different candidate id
      // (c7 here). Pre-fix, the dedup keyed on (stage, candidate_id) would
      // miss the prior row under the new id and emit a duplicate
      // SENSOR_PROPOSED for a sensor that was already proposed.
      const sel2 = sensorSelectionsFile(pd, "sensor-run2", "acceptance-format", { candidateId: "c7" });
      const res2 = runPersist(pd, sel2);
      expect(res2.status).toBe(0);
      expect(JSON.parse(res2.out).sensor_proposed).toBe(0);

      const audit = readAllAuditShards(pd);
      const rows = audit.split("\n").filter((l) => /Event.*: SENSOR_PROPOSED/.test(l)).length;
      expect(rows).toBe(1);
    }, 30000);

    test("dedup must stay SCOPED to the proposing stage — a second, DIFFERENT stage independently proposing the same sensor id must still get bound", () => {
      // Self-check on the fix above: dropping (stage, candidate_id) down to
      // sensorId ALONE (not (origin_stage, sensorId)) would make the no-op
      // branch global — once ANY stage has proposed a sensor, no OTHER
      // stage could ever bind that same sensor to its own frontmatter again,
      // since hasRow would stay true forever regardless of which stage is
      // asking. A sensor manifest is a singleton, but binding is legitimately
      // per-stage (Destinations is an array for exactly this reason).
      const pd = mkProject();
      const stagesDir = join(pd, ".claude", "skills", "aidlc", "stages");
      seedStageFile(stagesDir, "inception", "user-stories");
      seedStageFile(stagesDir, "construction", "requirements-analysis");
      const env = { AIDLC_STAGES_DIR: stagesDir };

      const sel1 = sensorSelectionsFile(pd, "sensor-stage-a", "acceptance-format", {
        originStage: "user-stories",
      });
      const res1 = runPersist(pd, sel1, { slug: "user-stories", env });
      expect(res1.status).toBe(0);
      expect(JSON.parse(res1.out).sensor_proposed).toBe(1);
      const stageAMd = readFileSync(join(stagesDir, "inception", "user-stories.md"), "utf-8");
      expect(/^\s*-\s*acceptance-format\s*$/m.test(stageAMd)).toBe(true);

      // A SEPARATE, unrelated stage later independently proposes the SAME
      // sensor id. The manifest already exists and the sensor was already
      // proposed once (by a different stage) — but THIS stage has never
      // been bound, and must still end up with the id in its own frontmatter.
      const sel2 = sensorSelectionsFile(pd, "sensor-stage-b", "acceptance-format", {
        originStage: "requirements-analysis",
        stageSlug: "requirements-analysis",
      });
      const res2 = runPersist(pd, sel2, { slug: "requirements-analysis", env });
      expect(res2.status).toBe(0);

      const stageBMd = readFileSync(join(stagesDir, "construction", "requirements-analysis.md"), "utf-8");
      expect(/^\s*-\s*acceptance-format\s*$/m.test(stageBMd)).toBe(true);
    }, 30000);
  });

  describe("finding #7 (P2, round 2) — a legacy-marker match must be gated on the marked line's own text, not candidate_id alone", () => {
    test("a DIFFERENT learning reusing a legacy marker's candidate_id is NOT treated as a retry — it persists as a fresh, second learning", () => {
      const pd = mkProject();
      const originalText = "Original learning already persisted under the legacy marker";
      const legacyMarker = `<!-- cid:${STAGE_SLUG}:${CANDIDATE_ID} -->`; // pre-#735 flat format
      writeFileSync(
        join(pd, "aidlc", "spaces", DEFAULT_SPACE, "memory", "project.md"),
        `# Project-Level Rules\n\n## Corrections\n\n- ${originalText} (learned 2026-07-01) ${legacyMarker}\n`,
        "utf-8",
      );
      const auditDir = join(intentsDirOf(pd, DEFAULT_SPACE), DEFAULT_RECORD_DIR, "audit");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(
        join(auditDir, "legacy-host-clone.md"),
        `**Timestamp**: 2026-07-01T00:00:00Z\n**Event**: RULE_LEARNED\n**Stage**: ${STAGE_SLUG}\n**Candidate-ID**: ${CANDIDATE_ID}\n**Destination**: project.md\n**Heading**: ## Corrections\n**Source**: orchestrator\n---\n`,
        "utf-8",
      );

      // A GENUINELY DIFFERENT learning happens to land on the SAME positional
      // candidate_id post-upgrade. Pre-fix, the legacy match keyed purely on
      // (stage, candidate_id) treated this as a retry of the ORIGINAL
      // learning and silently dropped it — "two different learnings landing
      // on the same positional candidate id never collide" does not hold
      // across the upgrade boundary.
      const differentText = "A completely different learning, same candidate_id by coincidence";
      const sel = selectionsFile(pd, "different-learning", differentText, {
        intent: DEFAULT_RECORD_DIR,
        candidateId: CANDIDATE_ID,
      });
      const res = runPersist(pd, sel);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.out).rule_learned).toBe(1);

      const content = projectMd(pd);
      expect(content).toContain(originalText);
      expect(content).toContain(differentText);
    }, 30000);
  });

  describe("finding #8 (P1, round 4) — an unscoped replay must not resolve to an intent born after surface", () => {
    test("intent:null fails closed after a new intent record appears", () => {
      const pd = createTestProject();
      projects.push(pd);
      const text = "Surfaced before any intent existed";
      const sel = selectionsFile(pd, "unscoped-before-birth", text, { intent: null });

      seedIntent(pd, SECOND_RECORD_DIR);
      switchActiveIntentTo(pd, SECOND_RECORD_DIR);

      const res = runPersist(pd, sel);
      expect(res.status).not.toBe(0);
      expect(res.out).toContain("Re-run the stage's surface step");
      expect(readAllAuditShards(pd, SECOND_RECORD_DIR, DEFAULT_SPACE)).not.toContain(
        "RULE_LEARNED",
      );

      const projectFiles: string[] = [];
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.isFile() && entry.name === "project.md") projectFiles.push(path);
        }
      };
      walk(pd);
      for (const path of projectFiles) {
        expect(readFileSync(path, "utf-8")).not.toContain(text);
      }
    }, 30000);
  });

  describe("finding #9 (P1, round 5) — content identity must not truncate SHA-256", () => {
    test("different texts sharing the same first 8 SHA-256 hex characters both persist", () => {
      const pd = mkProject();
      const firstText = "learning-70806";
      const secondText = "learning-102811";

      const first = runPersist(pd, selectionsFile(pd, "hash-collision-a", firstText));
      const second = runPersist(pd, selectionsFile(pd, "hash-collision-b", secondText));

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(JSON.parse(first.out).rule_learned).toBe(1);
      expect(JSON.parse(second.out).rule_learned).toBe(1);
      const content = projectMd(pd);
      expect(content).toContain(firstText);
      expect(content).toContain(secondText);
    }, 30000);
  });

  describe("finding #10 (P1, round 5) — dedup must include rows emitted earlier in the same batch", () => {
    test("duplicate content in one selections file emits one line and one RULE_LEARNED row", () => {
      const pd = mkProject();
      const path = join(pd, "duplicate-content.json");
      writeFileSync(
        path,
        JSON.stringify({
          stage_slug: STAGE_SLUG,
          space: DEFAULT_SPACE,
          intent: DEFAULT_RECORD_DIR,
          selections: [
            { candidate_id: "c1", type: "learning", scope: "project", heading: "Corrections", text: "Same learning" },
            { candidate_id: "c2", type: "learning", scope: "project", heading: "Corrections", text: "Same learning" },
            { candidate_id: "c3", type: "learning", scope: "team", heading: "Corrections", text: "Same learning" },
          ],
        }),
        "utf-8",
      );

      const result = runPersist(pd, path);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.out).rule_learned).toBe(1);
      expect(projectMd(pd).split("Same learning").length - 1).toBe(1);
      const teamPath = join(pd, "aidlc", "spaces", DEFAULT_SPACE, "memory", "team.md");
      const teamContent = existsSync(teamPath) ? readFileSync(teamPath, "utf-8") : "";
      expect(teamContent).not.toContain("Same learning");
      const audit = readAllAuditShards(pd, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
      expect(audit.split("**Event**: RULE_LEARNED").length - 1).toBe(1);

      const replay = runPersist(pd, path);
      expect(replay.status).toBe(0);
      expect(JSON.parse(replay.out).rule_learned).toBe(0);
      expect(projectMd(pd).split("Same learning").length - 1).toBe(1);
      const replayAudit = readAllAuditShards(pd, DEFAULT_RECORD_DIR, DEFAULT_SPACE);
      expect(replayAudit.split("**Event**: RULE_LEARNED").length - 1).toBe(1);
    }, 30000);
  });

  describe("finding #11 (P1, round 5) — pinned provenance must still exist at persist time", () => {
    test("a syntactically valid but nonexistent intent record fails without writing", () => {
      const pd = mkProject();
      const text = "Must not land under a ghost intent";
      const selection = selectionsFile(pd, "ghost-intent", text, { intent: "ghost-a1234567" });

      const result = runPersist(pd, selection);
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("missing intent record");
      const practicePath = join(pd, "aidlc", "spaces", DEFAULT_SPACE, "memory", "project.md");
      const practice = existsSync(practicePath) ? readFileSync(practicePath, "utf-8") : "";
      expect(practice).not.toContain(text);
      expect(existsSync(join(intentsDirOf(pd, DEFAULT_SPACE), "ghost-a1234567"))).toBe(false);
    }, 30000);

    test("a syntactically valid but nonexistent non-default space fails without creating it", () => {
      const pd = mkProject();
      const text = "Must not land under a ghost space";
      const selection = selectionsFile(pd, "ghost-space", text, { space: "ghost", intent: null });

      const result = runPersist(pd, selection);
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("missing space");
      expect(existsSync(join(pd, "aidlc", "spaces", "ghost"))).toBe(false);
    }, 30000);

    test("a deleted default space fails instead of being synthesized and partially recreated", () => {
      const pd = mkProject();
      const selection = selectionsFile(pd, "deleted-default", "Must not recreate default");
      const defaultDir = join(pd, "aidlc", "spaces", DEFAULT_SPACE);
      rmSync(defaultDir, { recursive: true, force: true });

      const result = runPersist(pd, selection);
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("missing space");
      expect(existsSync(defaultDir)).toBe(false);
    }, 30000);

    test("a symlinked space fails without writing through the link", () => {
      const pd = mkProject();
      const external = join(pd, "external-space");
      mkdirSync(external, { recursive: true });
      symlinkSync(external, join(pd, "aidlc", "spaces", "redirect"));
      const selection = selectionsFile(pd, "symlink-space", "Must not follow space links", {
        space: "redirect",
        intent: null,
      });

      const result = runPersist(pd, selection);
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("missing space");
      expect(existsSync(join(external, "memory", "project.md"))).toBe(false);
    }, 30000);
  });

  describe("finding #12 (P2, round 5) — CLI slug must match surface-time stage provenance", () => {
    test("persist rejects a CLI slug different from selections.stage_slug", () => {
      const pd = mkProject();
      const text = "Must retain stage provenance";
      const selection = selectionsFile(pd, "wrong-stage", text);

      const result = runPersist(pd, selection, { slug: "requirements-analysis" });
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("slug mismatch");
      const practicePath = join(pd, "aidlc", "spaces", DEFAULT_SPACE, "memory", "project.md");
      const practice = existsSync(practicePath) ? readFileSync(practicePath, "utf-8") : "";
      expect(practice).not.toContain(text);
    }, 30000);
  });
});
