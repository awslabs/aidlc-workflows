// covers: stage:inception/reverse-engineering
//
// t183 — codekb placement re-verify (live SDK). The shipped end-to-end proof of
// the codekb-determinism effort: drive the REAL reverse-engineering stage through
// the Claude Agent SDK and ASSERT (not merely observe — the spike probe was
// observational) that the RE subagent wrote its 9 artifacts to the
// ENGINE-RESOLVED space-level codekb dir, `aidlc/spaces/<space>/codekb/<repo>/`,
// the directory the read-only `codekb-path` tool prints — and NOT into the
// per-intent record dir / intent-slug tree.
//
// WHY a live test in addition to t182's deterministic guard: t182 pins the
// resolver + the verb + the helpers (the determinism half — what the engine
// EMITS). This pins the OTHER half — that the LLM subagent, told "resolve the dir
// with `codekb-path` and write where it prints", actually LANDS its files there.
// The spike's two t50 drift runs showed the prose-only approach was unreliable;
// this is the regression guard that the codekb-path defer fixed it.
//
// HARNESS NOTE: `next` resumes the seeded in-flight Reverse Engineering stage
// directly. Capture placement at the first post-artifact human boundary: RE
// steps 3-4 write the 9 artifacts before the learnings ritual and approval gate,
// so the on-disk surface is complete at that moment (before finally-block
// cleanup wipes the fixture). The driver stops intentionally after that menu's
// tool_result.
// Continuing beyond the boundary would enter Code Generation, which is
// unrelated to this placement test.
//
// The fixture (mirrors t72): a brownfield React/Vite/TS Todo stub seeded at
// init-done with reverse-engineering in-flight, single-repo (NO repos row), so
// the engine keys the codekb store by basename(projectDir) (codekbRepoName's
// 0-repo case). The expected dir is computed from the SAME lib helper the engine
// uses (relativeCodekbDir / codekbRepoName), never a hand-composed literal.
//
// It SPENDS TOKENS — driveAidlc drives the real multi-agent RE stage on
// Opus/Bedrock; the .sh allotted 900s for RE. Gated PURELY on the claude CLI (the
// file calls driveAidlc → claude-gate.ts marks it SDK-dependent; the runner
// skips-with-reason when claude is absent, never a hard fail). LIVE-SDK tier:
// runs on the integration tier behind the claude gate, NOT the fast deterministic
// tier.

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
import { driveAidlc } from "../harness/sdk-drive.ts";
import { compileFixtureRuntimeGraph } from "../harness/tui-fixtures.ts";
import {
  activeSpace,
  codekbRepoName,
  relativeCodekbDir,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "1200", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 1200) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

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
      const proj = setupIntegrationProject({
        withState: "state-brownfield-init-done.md",
        withBrownfieldStub: true,
        withAudit: true,
      });
      // Captured at the first post-artifact human boundary. The 9 artifacts are
      // on disk by then, before any advance/cleanup.
      let capturedMarkdown: string[] | null = null;
      let gateCount = 0;
      try {
        sedReplaceInFile(
          seededStateFile(proj),
          "- **Project Root**: /tmp/aidlc-test",
          `- **Project Root**: ${proj}`,
        );
        compileFixtureRuntimeGraph(proj);

        const r = await driveAidlc("/aidlc", {
          projectDir: proj,
          // Answer the first post-artifact menu. The 9 artifacts have landed.
          answerScript: {
            kind: "byHeader",
            map: {},
            fallback: { optionIndex: 0 },
          },
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterAskUserQuestionAt: 1,
          onAskUserQuestion: () => {
            gateCount++;
            if (gateCount >= 1 && capturedMarkdown === null) {
              capturedMarkdown = allAidlcMarkdown(proj);
            }
          },
        });

        // The test intentionally aborts after the second menu's tool_result,
        // before the SDK emits a terminal result. Distinguish that boundary
        // from the timeout that previously false-failed after RE had completed.
        expect(r.timedOut).toBe(false);
        expect(r.stoppedAfterAskUserQuestion).toBe(true);
        expect(r.stoppedAfterToolResult).toBe(false);

        // Fallback capture if the run ended without a distinct human boundary,
        // so placement is always asserted.
        if (capturedMarkdown === null) capturedMarkdown = allAidlcMarkdown(proj);

        // The stage reached a post-artifact menu — proof RE ran (no vacuous pass).
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);

        // The engine-resolved space-level codekb dir, computed from the SAME lib
        // helpers the engine uses (single-repo fixture → repo == basename(proj)).
        const repo = codekbRepoName(proj, activeSpace(proj));
        const codekbRel = relativeCodekbDir(proj, repo, activeSpace(proj)); // posix
        const recordRel = relative(proj, seededRecordDir(proj)).split("\\").join("/");
        const oldReRel = `${recordRel}/inception/reverse-engineering`;

        const mds = capturedMarkdown as string[];

        // RE artifacts (by stem) that landed UNDER the engine-resolved codekb dir.
        const inCodekb = mds.filter((p) => {
          if (!p.startsWith(`${codekbRel}/`)) return false;
          const stem = p.split("/").pop()?.replace(/\.md$/, "") ?? "";
          return RE_STEMS.includes(stem);
        });
        // RE artifacts that (wrongly) landed in the per-intent record dir.
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
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
