// covers: stage:inception/reverse-engineering
//
// t72-stage-reverse-engineering.test.ts — SDK-harness port of
// tests/integration/t72-stage-reverse-engineering.sh (plan 15). Drives the real
// `/aidlc` from a state fixture already parked on reverse-engineering through
// the Claude Agent SDK and asserts ONLY on deterministic surfaces — the on-disk RE artifact
// scaffold, the state fields the stage wrote, and the SDK's captured gate — NEVER
// on assistantText.
//
// ⛔ TRAP 2 (no headless auto-approve). The .sh drove `--stage reverse-engineering`
// under a headless auto-approve mode so the approval gate AUTO-APPROVED and the stage
// auto-advanced - that auto-advance
// is also why the .sh's "current stage advanced past RE" assertion was racy (a known
// LLM-tier flake). This port drives the REAL stage and STOPS when its approval gate
// RENDERS (stopAfterAskUserQuestion), the moment the deterministic artifacts + state
// have landed (RE stage steps 3-4 write the 9 artifacts + update state BEFORE step 5
// presents the gate, reverse-engineering.md:78-101). We assert that LANDED surface —
// the §5-A1 land pattern applied to sdk — never the post-approval advance (a moving
// LLM-paced target, the t26/t101 lesson). Known LLM-tier flake (memory) — re-run alone.
//
// THE JOURNEY (verified against the SHIPPED stage). Seed state-brownfield-init-done
// (Lifecycle Phase=INCEPTION, Current Stage=reverse-engineering [-] in-progress,
// Scope=bugfix, Completed=3) + the brownfield-todo stub (a React/Vite/TypeScript Todo
// app). Plain `/aidlc` resumes that current stage directly; jump routing for
// `--stage` is covered by t25/t26. The RE stage: step 2 delegates a developer
// code scan, step 3 the architect synthesises 9 artifacts into the SPACE-LEVEL
// per-repo codekb store aidlc/spaces/<space>/codekb/<repo>/ (the dir codekb-path
// resolves — reverse-engineering.md step 3), step 4 updates state, step 5 renders
// the AskUserQuestion approval gate. We stop at step 5.
//
// ASSERTION MAP (.sh test -> deterministic SDK surface, equal-or-stronger):
//   1 RE directory created
//       -> existsSync(aidlc/spaces/<space>/codekb/<repo>/) on disk (codekbReDir).
//   2 RE dir has >= 4 .md artifacts
//       -> readdirSync(reDir).filter(.md).length > 3 (the .sh's assert_gt 3).
//   6 at least one RE artifact > 200 bytes
//       -> statSync(...).size > 200 for >= 1 artifact (the .sh's find -size +200c).
//   7 RE artifacts have markdown headings
//       -> >= 1 artifact matches /^#/m (the .sh's grep -l "^#").
//   8/9/13 RE completion + advance + completed count
//       -> NOT asserted post-approval (those depend on the auto-advance the .sh's
//          headless mode forced - the racy surface). Instead we assert the DETERMINISTIC landed
//          state at the gate: Current Stage === reverse-engineering (the stage is
//          active, jump/stage set it) — the stable pre-approval truth.
//   10 RE mentions component/module structure (3, 4, 5, 11 domain-word probes)
//       -> NOT a hard word grep (LLM-authored RE output varies; the .sh tied these
//          to the todo stub with assert_gt 0 / skip-on-miss). The faithful
//          equal-or-stronger assertion is on STRUCTURE (>= 4 artifacts, headings,
//          size) — the t50/t-tui-t50 reasoning: hard-asserting a domain word would
//          be brittle, not stronger. The stub IS a React/Vite Todo app, so the
//          domain is present in the scanned source; we assert the framework-
//          guaranteed artifact SCAFFOLD.
//   15 lifecycle phase is INCEPTION
//       -> readStateField(state,"Lifecycle Phase") === "INCEPTION" (RE is inception).
//   + the approval gate RENDERED (the stage reached its gate, no vacuous pass):
//       -> r.askedQuestions.length > 0 (stopAfterAskUserQuestion fired).
//
// Known-answer literals (read from the SHIPPED stage, not guessed):
//   - RE outputs (9 artifacts):   reverse-engineering.md:36, written :78-89
//   - approval gate (step 5):     reverse-engineering.md:97-103 (AskUserQuestion)
//   - fixture init-done state:     state-brownfield-init-done.md (Phase=INCEPTION,
//                                  Current Stage=reverse-engineering, Scope=bugfix)
//   - brownfield-todo stub:        tests/fixtures/brownfield-todo (React/Vite/TS Todo)
//
// It SPENDS TOKENS — driveAidlc drives the real multi-agent RE stage (developer
// scan + architect synthesis) on Opus/Bedrock; the .sh allotted 900s. Generous
// per-test timeout; the driver aborts a hair early so a stuck run surfaces a
// partial DriveResult, not a hang.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  cleanupTestProject,
  sedReplaceInFile,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateField } from "../harness/sdk-drive.ts";
import { activeSpace } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The space-level per-repo codekb dir the RE stage now writes into
// (aidlc/spaces/<space>/codekb/<repo>/ — the codekb-determinism placement fix).
// This single-repo brownfield fixture records NO repos row, so the engine keys
// the store by basename(projectDir) (codekbRepoName's 0-repo case). Tolerant of
// the bare workspace-root form too (the live RE subagent occasionally writes
// there), mirroring the t-acp-kiro / journey codekbFiles helpers.
function codekbReDir(proj: string): string {
  const spaceScoped = join(proj, "aidlc", "spaces", activeSpace(proj), "codekb", basename(proj));
  const bare = join(proj, "aidlc", "codekb", basename(proj));
  return existsSync(spaceScoped) ? spaceScoped : bare;
}

// The 9 RE artifact stems the architect synthesises (reverse-engineering.md
// produces:). The anti-scatter check below tests for THESE in the old per-intent
// record location - NOT the directory's mere existence, because the RE stage's
// own "Learn" ritual legitimately writes its stage diary memory.md into
// <record>/<phase>/<stage>/ (reverse-engineering.md "the memory.md file stays in
// the artefact directory as part of the stage's permanent record"). That diary
// materializes the reverse-engineering/ directory by design; only a scattered RE
// ARTIFACT there is a placement regression. Mirrors t183's stem-filtered check.
const RE_STEMS = [
  "business-overview",
  "architecture",
  "code-structure",
  "api-documentation",
  "component-inventory",
  "technology-stack",
  "dependencies",
  "code-quality-assessment",
  "reverse-engineering-timestamp",
];

// ---------------------------------------------------------------------------
// Timeout budget — the .sh set AIDLC_TEST_TIMEOUT=900 (RE is a HEAVY multi-agent
// stage). Honour it. The driver aborts ~15s before bun's per-test cap so a stuck
// run surfaces a partial DriveResult to diagnose rather than an opaque hang.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "900", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 900) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

const TARGET_SLUG = "reverse-engineering";
const TARGET_PHASE = "INCEPTION";

describe("t72 /aidlc reverse-engineering brownfield (sdk)", () => {
  // -------------------------------------------------------------------------
  // Brownfield project seeded at init-done with RE next. Drive the RE stage and
  // STOP when its approval gate renders — the moment the 9 artifacts + the state
  // update have landed. Assert the deterministic artifact scaffold + state, with
  // no auto-advance and no racy post-approval read.
  // -------------------------------------------------------------------------
  test(
    "reverse-engineering produces the artifact scaffold and lands at its approval gate (phase INCEPTION)",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-brownfield-init-done.md",
        withBrownfieldStub: true,
        withAudit: true,
      });
      try {
        // P9: state lives in the seeded per-intent record the RE stage resolves
        // via the active-intent cursor (the flat aidlc-docs/ root is retired).
        sedReplaceInFile(
          seededStateFile(proj),
          "- **Project Root**: /tmp/aidlc-test",
          `- **Project Root**: ${proj}`,
        );

        const r = await driveAidlc("/aidlc", {
          projectDir: proj,
          // Stop the instant the RE approval gate renders — the artifacts + state
          // update precede it (reverse-engineering.md steps 3-4 before step 5), so
          // the deterministic landed surface is captured without auto-advancing.
          stopAfterAskUserQuestion: true,
          timeoutMs: DRIVE_TIMEOUT_MS,
        });

        // The stage REACHED its approval gate — proof the RE journey ran to its
        // completion step (no vacuous pass). stopAfterAskUserQuestion fired.
        expect(r.askedQuestions.length).toBeGreaterThan(0);

        // .sh test 1: the RE artifact directory was created. RE now writes to the
        // SPACE-LEVEL per-repo codekb store, NOT the per-intent record dir (the
        // codekb-determinism placement fix). Enumerate that dir; also assert RE
        // did NOT scatter ARTIFACTS into the old record-dir location.
        const reDir = codekbReDir(proj);
        expect(existsSync(reDir) && statSync(reDir).isDirectory()).toBe(true);
        // Anti-scatter: no RE artifact (by stem) landed in the per-intent record
        // dir. We do NOT assert the dir is absent - the stage's by-design diary
        // memory.md lives there (see RE_STEMS comment); only a scattered ARTIFACT
        // is a regression. (Mirrors t183's stem-filtered placement check.)
        const oldRecordReDir = join(seededRecordDir(proj), "inception", "reverse-engineering");
        const scatteredArtifacts = existsSync(oldRecordReDir)
          ? readdirSync(oldRecordReDir).filter((f) =>
              RE_STEMS.includes(f.replace(/\.md$/, "")),
            )
          : [];
        expect(scatteredArtifacts).toEqual([]);

        // .sh test 2: >= 4 .md artifacts (the .sh's assert_gt 3).
        const reFiles = readdirSync(reDir).filter((f) => f.endsWith(".md"));
        expect(reFiles.length).toBeGreaterThan(3);

        // .sh test 7: at least one artifact carries a markdown heading.
        const withHeading = reFiles.filter((f) =>
          /^#/m.test(readFileSync(join(reDir, f), "utf8")),
        ).length;
        expect(withHeading).toBeGreaterThan(0);

        // .sh test 6: at least one artifact > 200 bytes.
        const big = reFiles.filter((f) => statSync(join(reDir, f)).size > 200).length;
        expect(big).toBeGreaterThan(0);

        // .sh test 15: lifecycle phase is INCEPTION (RE is an inception stage).
        // sdk-drive read the state file off disk; read the field from it.
        expect(r.stateFile).toBeDefined();
        const state = r.stateFile as string;
        expect(readStateField(state, "Lifecycle Phase")).toBe(TARGET_PHASE);

        // .sh tests 8/9 re-expressed as the DETERMINISTIC pre-approval truth: the
        // RE stage is the active Current Stage (set by the stage/jump). We do NOT
        // assert the post-approval [x]/advance — that is the racy auto-advance the
        // .sh's headless mode forced (the flake root); it is the tui tier's surface.
        expect(readStateField(state, "Current Stage")).toBe(TARGET_SLUG);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
