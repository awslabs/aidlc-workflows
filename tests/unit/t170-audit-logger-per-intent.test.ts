// covers: hook:aidlc-audit-logger
//
// t170 — the P8 fix to the audit-logger GATE. Pre-workspace-move the hook gated
// artifact logging on `file.includes("aidlc-docs/")` (aidlc-audit-logger.ts:49).
// After the record re-roots per intent
// (aidlc/spaces/<space>/intents/<slug>-<id8>/<phase>/<stage>/…), that path no
// longer contains "aidlc-docs/", so the old gate DROPPED every ARTIFACT_CREATED/
// UPDATED on the new layout (the review minor this fixes). The gate now resolves
// the active intent's record root via docsRoot() and logs writes under it. P9
// RETIRED the transitional flat "aidlc-docs/" substring fallback — a write under
// a flat aidlc-docs/ tree is no longer logged (last test pins that end state).
//
// WHY CLI: the SUBJECT is a hook (top-level run + process.exit gates + stdin),
// spawned exactly as PostToolUse drives it — the same twin pattern as t07.
//
// SEEDING: birthIntent() mints a real per-intent record + sets the active-intent
// cursor; auditFilePath() then resolves the per-clone shard under that record's
// audit/ dir (the precondition for the emit — the hook self-gates on the shard
// existing, :57). We touch the shard, fire a Write under the record's stage dir,
// and assert the ARTIFACT event + the record-relative breadcrumb landed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  birthIntent,
  docsRoot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-audit-logger.ts");

let proj: string;
beforeEach(() => {
  proj = createTestProject();
});
afterEach(() => {
  cleanupTestProject(proj);
});

function fire(p: string, tool: string, filePath: string): number {
  const r = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(
      JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath } }),
    ),
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
  });
  return r.exitCode;
}

// The shard filename the hook subprocess will resolve, computed from a
// DETERMINISTIC clone-id we pin on disk (see below). Mirrors auditShardName()'s
// `<host>-<clone>.md` shape, including its hostname slug normalisation.
const PINNED_CLONE_ID = "testcloneid01";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}

/** Birth an intent and create the audit shard the HOOK will resolve, returning
 *  the audit DIR + record root. The clone-id token (aidlc/.aidlc-clone-id) is
 *  PINNED on disk so the freshly-spawned hook subprocess (which reads the token
 *  from disk, not the test process's memoized one) resolves a predictable shard
 *  name — we create exactly that shard so the hook's "shard exists" gate (:57)
 *  passes. Assertions glob-read every shard in the dir (clone-id-name-agnostic,
 *  mirroring readAllAuditShards) to tolerate any extra shard. */
function seedIntentWithShard(p: string, slug: string): { auditDir: string; recordRoot: string } {
  const born = birthIntent(p, slug, "default", "feature");
  // Pin the clone-id BEFORE the hook runs (the hook reads it from disk).
  writeFileSync(join(p, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
  const auditDir = join(docsRoot(p), "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, pinnedShardName()), "", "utf-8");
  void born;
  return { auditDir, recordRoot: docsRoot(p) };
}

/** Concatenate every shard in an audit dir (clone-id-name-agnostic read). */
function readShards(auditDir: string): string {
  let names: string[];
  try {
    names = readdirSync(auditDir);
  } catch {
    return "";
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => readFileSync(join(auditDir, n), "utf-8"))
    .join("\n");
}

describe("t170 audit-logger per-intent gate (mechanism cli — spawned hook)", () => {
  test("logs an ARTIFACT_CREATED for a write under the per-intent record dir", () => {
    const { auditDir, recordRoot } = seedIntentWithShard(proj, "auth-service");
    // A stage artifact under the re-rooted record dir — NOT containing
    // "aidlc-docs/". The old gate dropped this; the new gate logs it.
    const artifact = join(recordRoot, "construction", "functional-design", "design.md");
    const rc = fire(proj, "Write", artifact);
    expect(rc).toBe(0);
    const body = readShards(auditDir);
    expect(body).toContain("ARTIFACT_CREATED");
    // The breadcrumb is the path RELATIVE to the record root.
    expect(body).toContain("construction > functional-design > design.md");
  });

  test("Edit under the per-intent record dir emits ARTIFACT_UPDATED", () => {
    const { auditDir, recordRoot } = seedIntentWithShard(proj, "export-bug");
    fire(proj, "Edit", join(recordRoot, "ideation", "intent-capture", "intent.md"));
    expect(readShards(auditDir)).toContain("ARTIFACT_UPDATED");
  });

  test("does NOT log a write outside the record dir (no false positive)", () => {
    const { auditDir } = seedIntentWithShard(proj, "search");
    const before = readShards(auditDir);
    fire(proj, "Write", "/tmp/elsewhere/file.md");
    expect(readShards(auditDir)).toBe(before);
  });

  test("does NOT log a write to an audit shard itself (anti-recursion)", () => {
    const { auditDir, recordRoot } = seedIntentWithShard(proj, "perf");
    const before = readShards(auditDir);
    // A write to any shard under the record's audit/ dir must be skipped.
    fire(proj, "Write", join(recordRoot, "audit", "some-host-clone.md"));
    expect(readShards(auditDir)).toBe(before);
  });

  test("a write under the flat aidlc-docs/ tree is NOT logged (P9 — no flat-legacy fallback)", () => {
    // P9 retired the transitional `file.includes("aidlc-docs/")` gate. The
    // logger now fires ONLY for writes under the per-intent record root. A write
    // under a flat aidlc-docs/ tree no longer matches, so nothing is logged.
    const { auditDir } = seedIntentWithShard(proj, "legacy");
    const before = readShards(auditDir);
    const rc = fire(proj, "Write", join(proj, "aidlc-docs", "ideation", "feasibility", "f.md"));
    expect(rc).toBe(0); // advisory: the hook still exits clean
    // No flat audit.md is created, and the per-intent shard is unchanged.
    expect(existsSync(join(proj, "aidlc-docs", "audit.md"))).toBe(false);
    expect(readShards(auditDir)).toBe(before);
  });
});
