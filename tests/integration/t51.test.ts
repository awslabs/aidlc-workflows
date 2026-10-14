// covers: subcommand:aidlc-state:approve
//
// CLI-contract test, mechanism = cli. End-to-end event-parity walk of the bugfix
// scope on a greenfield project, driven entirely by SPAWNING the real binaries via
// node:child_process spawnSync — `aidlc-utility.ts init` to bootstrap, then
// `aidlc-state.ts gate-start` / `aidlc-state.ts approve` per gated stage. The
// covers id pins `subcommand:aidlc-state:approve` because `approve` is the
// load-bearing driver: it owns the end-to-end transition (GATE_APPROVED +
// STAGE_COMPLETED, then delegates to handleAdvance / handleCompleteWorkflow for
// the phase-boundary and workflow-completion events). Every count asserted here
// is produced by the approve auto-advance chain plus the init bootstrap.
//
// MECHANISM: spawn (the exact PROCESS boundary). The contract under test is the
// audit trail the tools write across the full walk plus the terminal
// aidlc-state.md, so it stays a spawn - an in-process twin would lose the
// cross-tool init->gate-start->approve sequencing the audit stream encodes.
//
// FIXTURE DISCIPLINE: the whole walk runs against ONE fresh temp project
// (createTestProject, which toPortablePath-converts on Windows so the audit
// shards the tools write via forward-slash helpers round-trip when read back).
// A single project runs through the entire walk in a beforeAll and the tests
// assert on the accumulated audit, so the expensive multi-process walk runs
// once. The temp dir is cleaned in afterAll. NOTHING is seeded - init
// bootstraps the audit from scratch, so post-walk counts are unambiguous.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { setDefaultTimeout, afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const UTIL = join(TOOLS, "aidlc-utility.ts");
const STATE = join(TOOLS, "aidlc-state.ts");
const LOG = join(TOOLS, "aidlc-log.ts");

// init creates a per-intent record (aidlc/spaces/<space>/intents/<YYMMDD>-<slug>/);
// state lands at <record>/aidlc-state.md and audit in per-clone shards under
// <record>/audit/<host>-<clone>.md. The active-intent cursor follows the created
// record, so the whole gate-start/approve walk resolves to it. Fall back to flat
// for a not-yet-created project.
function recordDirOf(p: string): string {
  const spaceCursor = join(p, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(p, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf-8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(p, "aidlc-docs");
}
const statePath = (p: string): string => join(recordDirOf(p), "aidlc-state.md");
// Audit is sharded under <record>/audit/<host>-<clone>.md; concat every shard for
// a content read, falling back to the flat audit.md for a not-yet-created project.
function readAudit(p: string): string {
  const auditDir = join(recordDirOf(p), "audit");
  if (existsSync(auditDir)) {
    return readdirSync(auditDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(auditDir, f), "utf-8"))
      .join("\n");
  }
  const flat = join(p, "aidlc-docs", "audit.md");
  return existsSync(flat) ? readFileSync(flat, "utf-8") : "";
}

function runInit(proj: string): void {
  const res = spawnSync(BUN, [UTIL, "intent-create", "--scope", "bugfix", "--project-dir", proj], {
    encoding: "utf-8",
    env: { ...process.env, AIDLC_WORKFLOW_INTENT: "bugfix parity test" },
  });
  if ((res.status ?? -1) !== 0) {
    throw new Error(`init failed (status ${res.status}): ${res.stdout ?? ""}${res.stderr ?? ""}`);
  }
}

function walkStage(proj: string, slug: string): void {
  const env = {
    ...process.env,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_SOURCE_FRESHNESS: "1",
  };
  // Reviewer-bearing stages need a terminal REVIEW_COMPLETED before gate-start
  // (§12a), recorded by the stage's DECLARED reviewer.
  // Record one for the two reviewer-bearing stages this walk crosses; a
  // no-reviewer stage ignores the extra row. This walk drives transitions to
  // accumulate the audit trail, not to test the reviewer gate.
  const reviewerFor: Record<string, string> = {
    "requirements-analysis": "aidlc-product-lead-agent",
    "code-generation": "aidlc-architecture-reviewer-agent",
  };
  if (reviewerFor[slug]) {
    const artifactDir =
      slug === "requirements-analysis"
        ? join(recordDirOf(proj), "inception", slug)
        : join(recordDirOf(proj), "construction", "unit-alpha", slug);
    const artifacts =
      slug === "requirements-analysis"
        ? ["requirements.md", "requirements-analysis-questions.md"]
        : [
            "code-generation-plan.md",
            "unit-test-instructions.md",
            "code-summary.md",
            "traceability.json",
          ];
    mkdirSync(artifactDir, { recursive: true });
    for (const name of artifacts) {
      writeFileSync(join(artifactDir, name), `# ${name}\n`, "utf-8");
    }
    const artifact = join(
      artifactDir,
      slug === "requirements-analysis"
        ? "requirements.md"
        : "code-generation-plan.md",
    );
    const request = [
      LOG,
      "review",
      "--stage",
      slug,
      "--reviewer",
      reviewerFor[slug],
      "--iteration",
      "1",
      "--project-dir",
      proj,
    ];
    const reviewEnv = {
      ...env,
      AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
    };
    const requested = spawnSync(BUN, request, {
      encoding: "utf-8",
      env: reviewEnv,
    });
    if ((requested.status ?? -1) !== 0) {
      throw new Error(
        `review request ${slug} failed: ${requested.stdout ?? ""}${requested.stderr ?? ""}`,
      );
    }
    appendFileSync(
      artifact,
      `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewerFor[slug]}\n**Iteration:** 1\n\n### Findings\n\nFixture review.\n`,
      "utf-8",
    );
    const completed = spawnSync(
      BUN,
      [...request.slice(0, -2), "--verdict", "READY", ...request.slice(-2)],
      { encoding: "utf-8", env: reviewEnv },
    );
    if ((completed.status ?? -1) !== 0) {
      throw new Error(
        `review completion ${slug} failed: ${completed.stdout ?? ""}${completed.stderr ?? ""}`,
      );
    }
    // The verdict also leaves a readable copy for people beside the reviewed
    // artifact; the JSON record under .aidlc-engine/reviews stays the engine's review.
    const readableCopy = join(artifactDir, "reviews", "review-01.md");
    if (!existsSync(readableCopy)) {
      throw new Error(`readable review copy missing for ${slug}: ${readableCopy}`);
    }
    const copyText = readFileSync(readableCopy, "utf-8");
    if (!copyText.includes("**Verdict:** READY") || !copyText.includes(`**Reviewer:** ${reviewerFor[slug]}`)) {
      throw new Error(`readable review copy for ${slug} lacks the verdict block: ${copyText.slice(0, 200)}`);
    }
    const completedJson = JSON.parse(completed.stdout.trim().split("\n").pop() ?? "{}") as { reviewMarkdown?: string };
    if (!completedJson.reviewMarkdown?.endsWith("/reviews/review-01.md")) {
      throw new Error(`verdict JSON did not name the readable copy: ${completed.stdout}`);
    }
  }
  const gs = spawnSync(BUN, [STATE, "gate-start", slug, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  if ((gs.status ?? -1) !== 0) {
    throw new Error(`gate-start ${slug} failed (status ${gs.status}): ${gs.stdout ?? ""}${gs.stderr ?? ""}`);
  }
  const ap = spawnSync(BUN, [STATE, "approve", slug, "--user-input", "approve", "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  if ((ap.status ?? -1) !== 0) {
    throw new Error(`approve ${slug} failed (status ${ap.status}): ${ap.stdout ?? ""}${ap.stderr ?? ""}`);
  }
}

function countEvent(content: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return content.split("\n").filter((l) => re.test(l)).length;
}

function eventStream(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith("**Event**: ")) out.push(line.slice("**Event**: ".length));
  }
  return out;
}

// One project, walked once - the multi-process bugfix walk is expensive, so
// we share it.
let PROJ: string;

beforeAll(() => {
  PROJ = createTestProject();
  // Bootstrap via init (emits WORKFLOW_STARTED + init phase + PHASE_SKIPPED,
  // and init pre-completes the 3 init stages: workspace-scaffold,
  // workspace-detection, state-init). The first post-init EXECUTE stage for
  // bugfix-on-greenfield is requirements-analysis (reverse-engineering is
  // SKIP-greenfield). Walk the 5 gated EXECUTE stages; approve auto-advances /
  // auto-completes.
  runInit(PROJ);
  walkStage(PROJ, "requirements-analysis");
  walkStage(PROJ, "code-generation");
  walkStage(PROJ, "build-and-test");
  walkStage(PROJ, "deployment-pipeline");
  walkStage(PROJ, "deployment-execution");
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterAll(() => {
  cleanupTestProject(PROJ);
});

describe("t51 bugfix event parity — CLI contract (migrated from t51-bugfix-event-parity.sh, plan 15)", () => {
  // ============================================================
  // Event counts
  // ============================================================

  test("1: WORKFLOW_STARTED fires once", () => {
    expect(countEvent(readAudit(PROJ), "WORKFLOW_STARTED")).toBe(1);
  });

  test("2: WORKFLOW_COMPLETED fires once", () => {
    expect(countEvent(readAudit(PROJ), "WORKFLOW_COMPLETED")).toBe(1);
  });

  test("3: PHASE_STARTED fires 4x (initialization, inception, construction, operation)", () => {
    expect(countEvent(readAudit(PROJ), "PHASE_STARTED")).toBe(4);
  });

  test("4: PHASE_COMPLETED fires 4x", () => {
    expect(countEvent(readAudit(PROJ), "PHASE_COMPLETED")).toBe(4);
  });

  test("5: PHASE_VERIFIED fires 4x", () => {
    expect(countEvent(readAudit(PROJ), "PHASE_VERIFIED")).toBe(4);
  });

  test("6: PHASE_SKIPPED fires once (ideation)", () => {
    expect(countEvent(readAudit(PROJ), "PHASE_SKIPPED")).toBe(1);
  });

  test("7: STAGE_STARTED fires 8x (3 init + 5 gated)", () => {
    expect(countEvent(readAudit(PROJ), "STAGE_STARTED")).toBe(8);
  });

  test("8: STAGE_COMPLETED fires 8x", () => {
    // 3 init + 5 approve. On the final stage, approve delegates to
    // complete-workflow, whose alreadyMarkedCompleted guard suppresses the
    // duplicate STAGE_COMPLETED — so the count stays 8, not 9.
    expect(countEvent(readAudit(PROJ), "STAGE_COMPLETED")).toBe(8);
  });

  test("9: STAGE_AWAITING_APPROVAL fires 5x", () => {
    expect(countEvent(readAudit(PROJ), "STAGE_AWAITING_APPROVAL")).toBe(5);
  });

  test("10: GATE_APPROVED fires 5x", () => {
    expect(countEvent(readAudit(PROJ), "GATE_APPROVED")).toBe(5);
  });

  // ============================================================
  // Ordering
  // ============================================================

  test("11: WORKFLOW_STARTED is first event", () => {
    const stream = eventStream(readAudit(PROJ));
    expect(stream[0]).toBe("WORKFLOW_STARTED");
  });

  test("12: WORKFLOW_COMPLETED is last event", () => {
    const stream = eventStream(readAudit(PROJ));
    expect(stream[stream.length - 1]).toBe("WORKFLOW_COMPLETED");
  });

  test("13: GATE_APPROVED precedes STAGE_COMPLETED for final stage", () => {
    const stream = eventStream(readAudit(PROJ));
    const lastGate = stream.lastIndexOf("GATE_APPROVED");
    const lastCompleted = stream.lastIndexOf("STAGE_COMPLETED");
    expect(lastGate).toBeGreaterThanOrEqual(0);
    expect(lastCompleted).toBeGreaterThanOrEqual(0);
    expect(lastGate).toBeLessThan(lastCompleted);

    // Every GATE_APPROVED must be immediately followed by a STAGE_COMPLETED - the
    // approve invariant (GATE_APPROVED then STAGE_COMPLETED, audit-first) holds
    // for ALL 5 gated stages.
    for (let i = 0; i < stream.length; i++) {
      if (stream[i] === "GATE_APPROVED") {
        expect(stream[i + 1]).toBe("STAGE_COMPLETED");
      }
    }
  });

  // ============================================================
  // Terminal state
  // ============================================================

  test("14: Status=Completed", () => {
    const content = readFileSync(statePath(PROJ), "utf-8");
    expect(content.split("\n").some((l) => /^- \*\*Status\*\*: Completed/.test(l))).toBe(true);
  });

  test("15: 8 stages marked [x] in final state", () => {
    const content = readFileSync(statePath(PROJ), "utf-8");
    const completed = content.split("\n").filter((l) => /^- \[x\] [a-z-]+/.test(l)).length;
    expect(completed).toBe(8);
  });
});
