// covers: stage:inception/reverse-engineering
//
// t183 — codekb placement re-verify (live SDK). The shipped end-to-end proof of
// the codekb-determinism effort: drive the REAL reverse-engineering stage through
// the Claude Agent SDK and ASSERT that the RE subagent wrote its 9 artifacts to
// the ENGINE-RESOLVED space-level codekb dir `aidlc/spaces/<space>/codekb/<repo>/`
// (the directory the read-only `codekb-path` tool prints) - and NOT into the
// per-intent record dir / intent-slug tree.
//
// WHY a live test in addition to t182's deterministic guard: t182 pins the
// resolver + the verb + the helpers (the determinism half — what the engine
// EMITS). This pins the OTHER half — that the LLM subagent, told "resolve the dir
// with `codekb-path` and write where it prints", actually LANDS its files there.
// Prose-only placement was unreliable; this is the regression guard for the
// codekb-path defer.
//
// HARNESS NOTE: `next` resumes the seeded in-flight Reverse Engineering stage
// directly. A bare `/aidlc` on work in progress may first show the resume menu;
// the drive answers Resume and goes on, so the boundary below is the first
// question after that menu, whether or not it appears. Capture placement at
// the first post-artifact human boundary: RE
// steps 3-4 write the 9 artifacts before the learnings ritual and approval gate,
// so the on-disk surface is complete at that moment (before finally-block
// cleanup wipes the fixture). That boundary is the learnings question or, when
// the learnings step asks nothing, the gate itself, so the drive leaves the box
// open and stops there; the test also accepts a turn that ends on an unanswered
// engine-recorded question after the stage's final pipeline link
// (tests/harness/post-artifact-wait.ts). Continuing beyond the boundary would
// advance into downstream stages, which are unrelated to this placement test.
//
// The fixture (mirrors t72): a brownfield React/Vite/TS Todo stub seeded at
// init-done with reverse-engineering in-flight, single-repo (NO repos row), so
// the engine keys the codekb store by basename(projectDir) (codekbRepoName's
// 0-repo case). The expected dir is computed from the SAME lib helper the engine
// uses (relativeCodekbDir / codekbRepoName), never a hand-composed literal.
//
// It SPENDS TOKENS — driveAidlc drives the real multi-agent RE stage on
// Opus/Bedrock. Gated PURELY on the claude CLI (the file calls driveAidlc ->
// claude-gate.ts marks it SDK-dependent; the runner skips-with-reason when
// claude is absent, never a hard fail). LIVE-SDK tier: runs on the integration
// tier behind the claude gate, NOT the fast deterministic tier.

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  cleanupTestProject,
  sedReplaceInFile,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { retainFailedFixture } from "../harness/failed-fixture.ts";
import { leavesOpen, postArtifactWaitProblems } from "../harness/post-artifact-wait.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";
import { compileFixtureRuntimeGraph } from "../harness/tui-fixtures.ts";
import {
  activeSpace,
  codekbRepoName,
  relativeCodekbDir,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// The 9 RE artifact stems the architect synthesises (reverse-engineering.md
// produces: + Step 3). The landing assertion checks these by stem under the
// engine-resolved codekb dir.
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

/** Every markdown path under <proj>/aidlc, relative to proj (posix slashes),
 *  excluding the copied .claude/ distributable. Used to scan WHERE the RE
 *  subagent wrote, so the negative (nothing in the record dir) is observable. */
function allAidlcMarkdown(proj: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git" || name.startsWith(".claude")) continue;
      const p = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".md")) out.push(relative(proj, p).split("\\").join("/"));
    }
  };
  walk(join(proj, "aidlc"));
  return out;
}

describe("t183 codekb placement re-verify (sdk) — RE artifacts land at the engine-resolved space-level codekb", () => {
  test(
    "reverse-engineering writes its 9 artifacts to aidlc/spaces/<space>/codekb/<repo>/, NONE in the record dir",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({
        withState: "state-brownfield-init-done.md",
        withBrownfieldStub: true,
        withAudit: true,
      });
      // Captured at the first post-artifact human boundary. The 9 artifacts are
      // on disk by then, before any advance/cleanup.
      let capturedMarkdown: string[] | null = null;
      let boxesLeftOpen = 0;
      let passed = false;
      try {
        sedReplaceInFile(
          seededStateFile(proj),
          "- **Project Root**: /tmp/aidlc-test",
          `- **Project Root**: ${proj}`,
        );
        compileFixtureRuntimeGraph(proj);

        const r = await driveAidlc("/aidlc", {
          projectDir: proj,
          // Resume on the resume menu; every other box is left open.
          answerScript: { kind: "byHeader", map: {}, fallback: { labelContains: "Resume" } },
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          chatAboutQuestionWhen: (menu) => {
            if (!leavesOpen(menu)) return false;
            boxesLeftOpen++;
            return true;
          },
          // Stop at the first box left open, once its unanswered result is back.
          stopWhen: (results) => {
            const last = results.at(-1);
            return boxesLeftOpen > 0 && last?.toolName === "AskUserQuestion" && last.isError;
          },
          onAskUserQuestion: (menu) => {
            if (leavesOpen(menu)) capturedMarkdown ??= allAidlcMarkdown(proj);
          },
        });

        // Preserve the actual terminal outcome and on-disk state before any
        // boundary assertion can fail. A successful SDK result alone does not
        // establish that the native question was delivered.
        console.log(`t183 post-run evidence: ${JSON.stringify({
          timedOut: r.timedOut,
          stoppedAtOpenBox: r.stoppedWhen === true,
          stoppedAfterToolResult: r.stoppedAfterToolResult,
          askedQuestions: r.askedQuestions.slice(0, 4),
          result: r.resultEvent && {
            subtype: r.resultEvent.subtype,
            isError: r.resultEvent.is_error,
            turns: r.resultEvent.num_turns,
            permissionDenials: r.resultEvent.permissionDenialsCount,
            text: r.resultEvent.result?.slice(0, 16 * 1024),
            errors: r.resultEvent.errors?.slice(0, 8).map((error) => String(error).slice(0, 4096)),
          },
          assistantTail: r.assistantText.slice(-16 * 1024),
          stateFile: r.stateFile?.slice(0, 64 * 1024),
          auditEvents: r.auditEvents?.slice(-256),
          boundaryMarkdown: capturedMarkdown,
          finalMarkdown: allAidlcMarkdown(proj),
        })}`);

        // The test accepts the post-artifact human wait without requiring an SDK
        // terminal result. Distinguish that boundary from a timeout after RE has
        // completed.
        expect(r.timedOut).toBe(false);
        expect(r.stoppedAfterToolResult).toBe(false);
        // RE must reach its post-artifact human wait (no vacuous pass), and the
        // wait is RE's: nothing approved, the engine still holds RE.
        expect(postArtifactWaitProblems({
          events: r.auditEvents ?? [],
          stoppedAtOpenBox: r.stoppedWhen === true,
          resultSubtype: r.resultEvent?.subtype,
          stateFile: r.stateFile,
        })).toEqual([]);

        // Defensive fallback for a missing callback snapshot. The native
        // question assertions still apply independently of this file scan.
        if (capturedMarkdown === null) capturedMarkdown = allAidlcMarkdown(proj);


        // The engine-resolved space-level codekb dir, computed from the SAME lib
        // helpers the engine uses (single-repo fixture → repo == basename(proj)).
        const repo = codekbRepoName(proj, activeSpace(proj));
        const codekbRel = relativeCodekbDir(proj, repo, activeSpace(proj)); // posix
        const recordRel = relative(proj, seededRecordDir(proj)).split("\\").join("/");
        const oldReRel = `${recordRel}/inception/reverse-engineering`;

        const mds = capturedMarkdown as string[];

        const inCodekb = mds.filter((p) => {
          if (!p.startsWith(`${codekbRel}/`)) return false;
          const stem = p.split("/").pop()?.replace(/\.md$/, "") ?? "";
          return RE_STEMS.includes(stem);
        });
        const inRecordDir = mds.filter((p) => {
          if (!p.startsWith(`${oldReRel}/`)) return false;
          const stem = p.split("/").pop()?.replace(/\.md$/, "") ?? "";
          return RE_STEMS.includes(stem);
        });

        // ASSERTION 1: all 9 RE artifacts landed under the space-level codekb dir.
        // (Hard 9 — the stage produces exactly 9; a missing one is a real defect,
        // unlike t72's tolerant >=4 LLM-variance scaffold check, because HERE the
        // landing PLACE is the contract under test, not the artifact richness.)
        expect(
          inCodekb.length,
          `expected 9 RE artifacts under ${codekbRel}/, found ${inCodekb.length}: ${JSON.stringify(mds)}`,
        ).toBe(9);

        // ASSERTION 2: NONE landed in the per-intent record dir / intent-slug tree
        // — the regression the codekb-determinism fix prevents.
        expect(
          inRecordDir,
          `RE artifacts wrongly landed in the record dir ${oldReRel}/`,
        ).toEqual([]);
        passed = true;
      } finally {
        if (passed) cleanupTestProject(proj);
        else console.error(`t183 failed fixture kept at ${proj}; snapshot: ${retainFailedFixture(proj, "t183")?.path ?? "none (no AIDLC_TEST_LOG_DIR)"}`);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
