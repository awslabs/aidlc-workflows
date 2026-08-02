// covers: hook:aidlc-review-freeze, function:freshReviewReceipts, function:producesArtifactFile, function:producesArtifactUnit, audit:REVIEW_FREEZE_BLOCKED
//
// t264 - the deterministic PreToolUse enforcement of the §12a terminal-receipt
// ordering (the receipt-invalidation loop's hook half; the prose half is
// pinned by t263).
//
// The engine's completion precondition invalidates a REVIEW_COMPLETED receipt
// when a declared produces[] artifact is written after it. The freeze hook
// refuses that write BEFORE the invalidation happens, using the SAME receipt
// scan (freshReviewReceipts, shared in aidlc-lib.ts) - so the freeze window
// and the completion-refusal window cannot diverge. This test exercises:
//
//   (a) the pure decision layer (judgeFreeze + writeTargets, imported from the
//       DIST tree) - stage-level and per-unit freeze/no-freeze cases;
//   (b) the SHIPPED hook as a subprocess over a REAL audit ledger written by
//       the real aidlc-log/audit tools: allow before receipt, block after
//       READY, allow after NOT-READY, release on GATE_REJECTED, allow for
//       non-produces paths, fail-open with no ledger, off-switch, and the
//       REVIEW_FREEZE_BLOCKED audit row on a genuine block;
//   (c) registration pins per harness: Claude settings.json (third entry in
//       the shared PreToolUse group), Codex emit wiring + adapter target,
//       Kiro CLI conductor fs_write registration, opencode plugin call, and
//       the deliberate Kiro IDE absence.
//
// Mechanism = mixed: (a) is in-process import; (b) spawns the real hook and
// real CLI tools at the process boundary; (c) is text/JSON invariants.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockReason,
  judgeFreeze,
  writeTargets,
} from "../../dist/claude/.claude/hooks/aidlc-review-freeze.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedAidlcMemory,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const DIST_CLAUDE = join(REPO_ROOT, "dist", "claude", ".claude");
const HOOK = join(DIST_CLAUDE, "hooks", "aidlc-review-freeze.ts");
const LOG_TOOL = join(DIST_CLAUDE, "tools", "aidlc-log.ts");
const STATE_TOOL = join(DIST_CLAUDE, "tools", "aidlc-state.ts");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// ---------------------------------------------------------------------------
// (a) Pure decision layer
// ---------------------------------------------------------------------------

const RA = {
  slug: "requirements-analysis",
  reviewer: "aidlc-product-lead-agent",
  produces: ["requirements", "requirements-analysis-questions"],
};
const NFR = {
  slug: "nfr-requirements",
  for_each: "unit-of-work",
  reviewer: "aidlc-architecture-reviewer-agent",
  produces: ["nfr-requirements"],
};
const NONE: ReadonlySet<string> = new Set();
const ready = { stageVerdict: "READY", unitVerdicts: new Map<string, string>() };
const notReady = { stageVerdict: "NOT-READY", unitVerdicts: new Map<string, string>() };
const noReceipt = { stageVerdict: null, unitVerdicts: new Map<string, string>() };

describe("t264 (a) judgeFreeze decision table", () => {
  const raFile = "/p/aidlc/spaces/default/intents/i1/inception/requirements-analysis/requirements.md";

  test("blocks a produces[] write under a fresh READY stage receipt", () => {
    const v = judgeFreeze(RA, raFile, NONE, ready);
    expect(v.block).toBe(true);
    expect(v.stage).toBe("requirements-analysis");
    // The reason redirects to the gate, not to a retry of the same write.
    expect(blockReason(v)).toContain("Present the gate instead");
    expect(blockReason(v)).toContain("terminal receipt ends artifact work");
  });

  test("never blocks under NOT-READY (the repair loop must edit)", () => {
    expect(judgeFreeze(RA, raFile, NONE, notReady).block).toBe(false);
  });

  test("never blocks with no receipt (normal stage work)", () => {
    expect(judgeFreeze(RA, raFile, NONE, noReceipt).block).toBe(false);
  });

  test("never blocks a non-produces path (diary, questions of another stage)", () => {
    const diary = "/p/aidlc/spaces/default/intents/i1/inception/requirements-analysis/memory.md";
    expect(judgeFreeze(RA, diary, NONE, ready).block).toBe(false);
  });

  test("per-unit: freezes only the reviewed unit", () => {
    const u3 = "/p/aidlc/spaces/default/intents/i1/construction/U03/nfr-requirements/nfr-requirements.md";
    const u4 = "/p/aidlc/spaces/default/intents/i1/construction/U04/nfr-requirements/nfr-requirements.md";
    const receipts = { stageVerdict: "READY", unitVerdicts: new Map([["U03", "READY"]]) };
    const v3 = judgeFreeze(NFR, u3, NONE, receipts);
    expect(v3.block).toBe(true);
    expect(v3.unit).toBe("U03");
    expect(blockReason(v3)).toContain('unit "U03"');
    expect(judgeFreeze(NFR, u4, NONE, receipts).block).toBe(false);
  });

  test("per-unit: a NOT-READY unit receipt does not freeze that unit", () => {
    const u3 = "/p/aidlc/spaces/default/intents/i1/construction/U03/nfr-requirements/nfr-requirements.md";
    const receipts = { stageVerdict: "NOT-READY", unitVerdicts: new Map([["U03", "NOT-READY"]]) };
    expect(judgeFreeze(NFR, u3, NONE, receipts).block).toBe(false);
  });

  test("writeTargets: write tools contribute paths, read tools contribute none", () => {
    expect(writeTargets("Write", { file_path: "/a/b.md" })).toEqual(["/a/b.md"]);
    expect(writeTargets("Edit", { file_path: "/a/b.md" })).toEqual(["/a/b.md"]);
    expect(writeTargets("Read", { file_path: "/a/b.md" })).toEqual([]);
    expect(writeTargets("Bash", { command: "echo x > /a/b.md" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) The shipped hook as a subprocess over a real ledger
// ---------------------------------------------------------------------------

function projWithGate(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-mid-inception.md"));
  const env = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
  const r = spawnSync(
    BUN,
    [STATE_TOOL, "gate-start", "requirements-analysis", "--project-dir", p],
    { encoding: "utf-8", env },
  );
  if ((r.status ?? -1) !== 0) throw new Error(`gate-start failed: ${r.stdout}${r.stderr}`);
  return p;
}

function recordReview(p: string, verdict: "READY" | "NOT-READY"): void {
  const r = spawnSync(
    BUN,
    [
      LOG_TOOL,
      "review",
      "--stage",
      "requirements-analysis",
      "--reviewer",
      "aidlc-product-lead-agent",
      "--verdict",
      verdict,
      "--project-dir",
      p,
    ],
    { encoding: "utf-8" },
  );
  if ((r.status ?? -1) !== 0) throw new Error(`review log failed: ${r.stdout}${r.stderr}`);
}

function reject(p: string): void {
  const env = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
  const r = spawnSync(
    BUN,
    [STATE_TOOL, "reject", "requirements-analysis", "--feedback", "change it", "--project-dir", p],
    { encoding: "utf-8", env },
  );
  if ((r.status ?? -1) !== 0) throw new Error(`reject failed: ${r.stdout}${r.stderr}`);
}

function runHook(
  p: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { code: number; stderr: string } {
  const r = spawnSync(BUN, [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: p, ...env },
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

function raArtifact(p: string): string {
  return join(seededRecordDir(p), "inception", "requirements-analysis", "requirements.md");
}

function writePayload(file: string): Record<string, unknown> {
  return { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file } };
}

describe("t264 (b) shipped-hook lifecycle over a real ledger", () => {
  test("allow before any receipt; block after READY; release on GATE_REJECTED; re-block after fresh READY", () => {
    const p = projWithGate();
    const file = raArtifact(p);

    // No receipt yet: normal stage work proceeds.
    expect(runHook(p, writePayload(file)).code).toBe(0);

    // Fresh READY receipt: the same write is refused with the gate redirect,
    // and the refusal is auditable.
    recordReview(p, "READY");
    const blocked = runHook(p, writePayload(file));
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain("review-freeze");
    expect(blocked.stderr).toContain("Present the gate instead");
    expect(readAllAuditShards(p)).toContain("**Event**: REVIEW_FREEZE_BLOCKED");

    // A recorded gate rejection resets the receipt floor: the freeze lifts
    // with no manual release (the revision path is never frozen).
    reject(p);
    expect(runHook(p, writePayload(file)).code).toBe(0);

    // The re-reviewed revision freezes again - same invariant, next attempt.
    recordReview(p, "READY");
    expect(runHook(p, writePayload(file)).code).toBe(2);
  });

  test("NOT-READY never freezes (the lead-alone repair loop must edit)", () => {
    const p = projWithGate();
    recordReview(p, "NOT-READY");
    expect(runHook(p, writePayload(raArtifact(p))).code).toBe(0);
  });

  test("a non-produces write under a READY receipt is untouched", () => {
    const p = projWithGate();
    recordReview(p, "READY");
    const diary = join(seededRecordDir(p), "inception", "requirements-analysis", "memory.md");
    expect(runHook(p, writePayload(diary)).code).toBe(0);
  });

  test("Edit and MultiEdit block like Write; Read never blocks", () => {
    const p = projWithGate();
    recordReview(p, "READY");
    const file = raArtifact(p);
    for (const tool of ["Edit", "MultiEdit"]) {
      expect(
        runHook(p, { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path: file } }).code,
      ).toBe(2);
    }
    expect(
      runHook(p, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: file } }).code,
    ).toBe(0);
  });

  test("fail-open: empty ledger, malformed stdin, and the off-switch all allow", () => {
    const empty = createTestProject();
    tempDirs.push(empty);
    expect(runHook(empty, writePayload("/x/requirements-analysis/requirements.md")).code).toBe(0);

    const p = projWithGate();
    recordReview(p, "READY");
    const r = spawnSync(BUN, [HOOK], {
      input: "not json",
      env: { ...process.env, CLAUDE_PROJECT_DIR: p },
      encoding: "utf-8",
    });
    expect(r.status ?? -1).toBe(0);
    expect(
      runHook(p, writePayload(raArtifact(p)), { AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "1" }).code,
    ).toBe(0);
  });

  test("a completed stage's artifacts are not frozen (state checkbox filter)", () => {
    // state-mid-inception has intent-capture SKIPPED and earlier ideation
    // stages completed - a write to a completed reviewer-bearing stage's
    // produces path must pass even if a stale receipt existed. Use user-stories
    // marked [x] via approve after review to prove the filter end-to-end.
    const p = projWithGate();
    recordReview(p, "READY");
    const env = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
    const approve = spawnSync(
      BUN,
      [STATE_TOOL, "approve", "requirements-analysis", "--user-input", "Approve", "--project-dir", p],
      { encoding: "utf-8", env },
    );
    expect(approve.status ?? -1).toBe(0);
    // Stage now [x]: its produces paths are permanent record, not frozen.
    expect(runHook(p, writePayload(raArtifact(p))).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) Registration pins per harness
// ---------------------------------------------------------------------------

describe("t264 (c) harness registration", () => {
  test("Claude settings.json wires the hook in the shared PreToolUse group", () => {
    for (const root of [
      join(REPO_ROOT, "harness", "claude"),
      join(REPO_ROOT, "dist", "claude", ".claude"),
    ]) {
      const s = JSON.parse(readFileSync(join(root, "settings.json"), "utf-8")) as {
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
      };
      const group = (s.hooks?.PreToolUse ?? []).find((g) =>
        (g.hooks ?? []).some((h) => (h.command ?? "").includes("aidlc-review-freeze.ts")),
      );
      expect(group, root).toBeDefined();
      // Shares the state-transition-guard/reviewer-scope matcher group, so the
      // hook self-filters to write tools.
      expect(group?.matcher).toContain("Write");
      expect(group?.matcher).toContain("Edit");
    }
  });

  test("Codex hooks.json carries the adapter target; the adapter has the case", () => {
    const hooksJson = readFileSync(join(REPO_ROOT, "dist", "codex", ".codex", "hooks.json"), "utf-8");
    expect(hooksJson).toContain("aidlc-codex-adapter.ts review-freeze");
    const adapter = readFileSync(
      join(REPO_ROOT, "harness", "codex", "hooks", "aidlc-codex-adapter.ts"),
      "utf-8",
    );
    expect(adapter).toContain('case "review-freeze"');
    // Delete File / Move to are sibling mutations of the receipt exactly like
    // an Update - the fan-out must include them.
    expect(adapter.split('case "review-freeze"')[1]).toContain("Delete File|Move to");
  });

  test("Kiro CLI registers review-freeze on the conductor's fs_write", () => {
    const conductor = JSON.parse(
      readFileSync(join(REPO_ROOT, "harness", "kiro", "agents", "aidlc.json"), "utf-8"),
    ) as { hooks?: { preToolUse?: Array<{ matcher?: string; command?: string }> } };
    const entry = (conductor.hooks?.preToolUse ?? []).find((h) =>
      (h.command ?? "").includes("review-freeze"),
    );
    expect(entry).toBeDefined();
    expect(entry?.matcher).toBe("fs_write");
    const adapter = readFileSync(
      join(REPO_ROOT, "harness", "kiro", "hooks", "aidlc-kiro-adapter.ts"),
      "utf-8",
    );
    expect(adapter).toContain('target === "review-freeze"');
  });

  test("opencode plugin calls the core hook for write/edit/apply_patch", () => {
    const plugin = readFileSync(
      join(REPO_ROOT, "harness", "opencode", "plugin", "aidlc-opencode-adapter.ts"),
      "utf-8",
    );
    expect(plugin).toContain("aidlc-review-freeze.ts");
    expect(plugin).toContain("review-freeze: this write would invalidate");
  });

  test("Kiro IDE ships the hook body but NO registration (prose-only harness)", () => {
    // The body lands via the whole-dir hooks copy; no .kiro.hook wiring file
    // consumes it (PreToolUse tool inputs are not uniformly available there).
    expect(existsSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "hooks", "aidlc-review-freeze.ts"))).toBe(true);
    expect(
      existsSync(join(REPO_ROOT, "harness", "kiro-ide", "hooks", "aidlc-review-freeze.kiro.hook")),
    ).toBe(false);
    const ideConductor = readFileSync(
      join(REPO_ROOT, "harness", "kiro-ide", "agents", "aidlc.json"),
      "utf-8",
    );
    expect(ideConductor).not.toContain("review-freeze");
  });
});
