// covers: hook:aidlc-audit-logger, function:appendAuditEntry
//
// t07 — aidlc-audit-logger.ts PostToolUse hook behaviour. Migrated from
// tests/unit/t07-hook-audit-logger.sh (TAP plan 16). Mechanism: cli.
//
// WHY CLI (process-boundary, not in-process): the SUBJECT is a hook, not a
// pure function. aidlc-audit-logger.ts reads PostToolUse JSON from STDIN
// (`await Bun.stdin.text()`), resolves its projectDir from the
// CLAUDE_PROJECT_DIR env var OR by stripping `.claude/hooks` off its own
// script path (resolveProjectDirFromHook), and self-gates with
// `process.exit(0)` on every skip branch (TTY, bad JSON, write-not-under-record,
// audit-shard self-write, no audit shard). None of those seams — stdin, the
// env/script-path projectDir derivation, the exit codes — is reachable by
// importing a function; the module's top level RUNS on import and terminates
// the process. So this twin SPAWNS the real shipped hook the same way Claude
// Code's PostToolUse(Write|Edit) drives it from settings.json:
// `Bun.spawnSync({ cmd: [BUN, HOOK], stdin: <json bytes>, env: {…CLAUDE_PROJECT_DIR} })`.
//
// WORKSPACE LAYOUT (P9): the flat aidlc-docs/ root is retired. The record
// re-roots per intent at aidlc/spaces/<space>/intents/<slug>-<id8>/, and the
// audit trail is a DIR of per-clone shards (audit/<host>-<clone>.md), not a
// single audit.md. The hook now logs a write iff its file_path is UNDER the
// active intent's record root (docsRoot()), and self-gates on its own resolved
// shard (auditFilePath()) existing. So this twin:
//   - seeds aidlc-state.md into the default record so the active-intent cursor
//     resolves (docsRoot() == seededRecordDir(); a bare createTestProject leaves
//     an empty record whose cursor does NOT resolve), and
//   - PINS the clone-id token on disk + creates exactly the shard the spawned
//     hook will resolve (auditShardName embeds that token), so the hook's
//     "shard exists" gate passes and it appends to a shard we can read back.
// Assertions glob-read every shard in audit/ (clone-id-name-agnostic, mirroring
// readAllAuditShards) — the settled per-intent read pattern (see t170).
//
// appendAuditEntry's on-disk block format (aidlc-audit.ts, asserted via real
// bytes): "\n## <heading>\n**Timestamp**: <ts>\n**Event**: <type>\n<fields>\n---\n".
//
// FIXTURE DISCIPLINE (one fresh project per case):
//   - createTestProject() -> a fresh temp dir with the per-intent workspace shell.
//   - seedIntentShard() -> seeds state (so the record resolves) + pins the
//     clone-id + creates the resolved shard (the precondition for the emit).
//   - cleanupTestProject() rm -rf's each temp project.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1  (skips non-record writes)                  -> "skips writes outside the record dir (audit unchanged)"
//   .sh test 2  (skips audit-shard self-writes)            -> "skips audit-shard self-writes (anti-recursion)"
//   .sh test 3  (logs record artifact as CREATED)          -> "logs record artifact writes as ARTIFACT_CREATED"
//   .sh test 4  (context breadcrumb)                       -> "extracts the ideation breadcrumb"
//   .sh test 5  (Edit -> ARTIFACT_UPDATED)                 -> "Edit tool emits ARTIFACT_UPDATED"
//   .sh test 6  (exits silently when no audit shard)       -> "exits silently when no audit shard (shard not created)"
//   .sh test 7  (writes heartbeat)                         -> "writes the audit-logger.last heartbeat"
//   .sh test 8  (empty stdin graceful, rc 0, no write)     -> "handles empty stdin gracefully (exit 0, audit unchanged)"
//   .sh test 9  (malformed JSON graceful, rc 0, no write)  -> "handles malformed JSON stdin (exit 0, audit unchanged)"
//   .sh test 10 (CLAUDE_PROJECT_DIR script-path fallback)  -> "CLAUDE_PROJECT_DIR fallback from script path"
//   .sh test 11 (construction breadcrumb)                  -> "construction phase context breadcrumb"
//   .sh test 12 (operation breadcrumb)                     -> "operation phase context breadcrumb"
//   .sh test 13 (logging path < 500ms)                     -> "logging path completes within 500ms"
//   .sh test 14 (skip path < 300ms)                        -> "skip path completes within 300ms"
//   .sh test 15 (canonical **Event**: ARTIFACT_* field)    -> "emits canonical **Event**: ARTIFACT_* field"
//   .sh test 16 (Write->CREATED, Edit->UPDATED same file)  -> "Write→CREATED, Edit→UPDATED on same file"

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { docsRoot } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedStateFile,
  seededAuditDir,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-audit-logger.ts");

let proj: string;

// The shard filename the hook subprocess will resolve, computed from a
// DETERMINISTIC clone-id we pin on disk. Mirrors auditShardName()'s
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

/**
 * Seed the default record so its active-intent cursor resolves (docsRoot() ==
 * seededRecordDir()), pin the clone-id token on disk so the spawned hook
 * resolves a predictable shard name, and create exactly that shard so the
 * hook's "shard exists" gate passes. Returns the audit DIR + record root.
 */
function seedIntentShard(p: string): { auditDir: string; recordRoot: string } {
  // Any state fixture makes the record carry aidlc-state.md → the cursor (and
  // thus docsRoot()) resolves to the seeded record. The breadcrumb is purely
  // path-derived, so the fixture choice is incidental.
  seedStateFile(p, join(FIXTURES_DIR, "state-construction.md"));
  // Pin the clone-id BEFORE the hook runs (the hook reads it from disk).
  writeFileSync(join(p, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
  const auditDir = seededAuditDir(p);
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, pinnedShardName()), "", "utf-8");
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

interface FireResult {
  exitCode: number;
  durationMs: number;
}

/**
 * Fire the real audit-logger hook once with the given PostToolUse JSON on
 * stdin, mirroring the .sh's `echo '<json>' | CLAUDE_PROJECT_DIR=$PROJ bun
 * $HOOK`. When `setEnv` is false the env var is omitted so the hook exercises
 * its script-path projectDir fallback (test 10). Returns exit code + wall time.
 */
function fire(json: string, p: string, hookPath = HOOK, setEnv = true): FireResult {
  const env = { ...process.env };
  if (setEnv) env.CLAUDE_PROJECT_DIR = p;
  else delete env.CLAUDE_PROJECT_DIR;
  const t0 = performance.now();
  const r = Bun.spawnSync({
    cmd: [BUN, hookPath],
    stdin: new TextEncoder().encode(json),
    stdout: "ignore",
    stderr: "ignore",
    env,
  });
  const durationMs = performance.now() - t0;
  return { exitCode: r.exitCode, durationMs };
}

function writeJson(p: string): string {
  return JSON.stringify({ tool_name: "Write", tool_input: { file_path: p } });
}

function editJson(p: string): string {
  return JSON.stringify({ tool_name: "Edit", tool_input: { file_path: p } });
}

describe("t07 audit-logger PostToolUse hook (mechanism cli — spawned hook + stdin seam)", () => {
  beforeEach(() => {
    proj = createTestProject();
  });

  afterEach(() => {
    cleanupTestProject(proj);
  });

  test("skips writes outside the record dir (audit unchanged) [.sh test 1]", () => {
    const { auditDir } = seedIntentShard(proj);
    const before = readShards(auditDir);
    fire(writeJson("/tmp/other/file.txt"), proj);
    expect(readShards(auditDir)).toBe(before);
  });

  test("skips audit-shard self-writes (anti-recursion) [.sh test 2]", () => {
    const { auditDir, recordRoot } = seedIntentShard(proj);
    const before = readShards(auditDir);
    fire(writeJson(join(recordRoot, "audit", pinnedShardName())), proj);
    expect(readShards(auditDir)).toBe(before);
  });

  test("logs record artifact writes as ARTIFACT_CREATED [.sh test 3]", () => {
    const { auditDir, recordRoot } = seedIntentShard(proj);
    // Any markdown artifact written UNDER the per-intent record fires the event;
    // use a real per-intent stage artifact (domain knowledge is space-level now,
    // not a record subdir, so it is not a record-artifact example).
    fire(writeJson(join(recordRoot, "inception", "requirements-analysis", "requirements.md")), proj);
    expect(readShards(auditDir)).toContain("ARTIFACT_CREATED");
  });

  test("extracts the ideation breadcrumb [.sh test 4]", () => {
    const { auditDir, recordRoot } = seedIntentShard(proj);
    fire(writeJson(join(recordRoot, "ideation", "intent-capture", "intent.md")), proj);
    // STRONGER than the .sh grep: the breadcrumb is on a **Context**: line.
    expect(readShards(auditDir)).toContain("ideation > intent-capture > intent.md");
  });

  test("Edit tool emits ARTIFACT_UPDATED [.sh test 5]", () => {
    const { auditDir, recordRoot } = seedIntentShard(proj);
    fire(editJson(join(recordRoot, "state.md")), proj);
    expect(readShards(auditDir)).toContain("ARTIFACT_UPDATED");
  });

  test("exits silently when no audit shard (shard not created) [.sh test 6]", () => {
    // Seed state so the record resolves, but do NOT create the shard — the hook
    // must not auto-create the audit trail.
    seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
    const auditDir = seededAuditDir(proj);
    expect(existsSync(auditDir)).toBe(false);
    fire(writeJson(join(docsRoot(proj), "knowledge", "aidlc-shared", "test.md")), proj);
    expect(existsSync(auditDir)).toBe(false);
  });

  test("writes the audit-logger.last heartbeat [.sh test 7]", () => {
    const { recordRoot } = seedIntentShard(proj);
    fire(writeJson(join(recordRoot, "test.md")), proj);
    const heartbeat = join(recordRoot, ".aidlc-hooks-health", "audit-logger.last");
    expect(existsSync(heartbeat)).toBe(true);
  });

  test("handles empty stdin gracefully (exit 0, audit unchanged) [.sh test 8]", () => {
    const { auditDir } = seedIntentShard(proj);
    const before = readShards(auditDir);
    const r = fire("", proj);
    expect(r.exitCode).toBe(0);
    expect(readShards(auditDir)).toBe(before);
  });

  test("handles malformed JSON stdin (exit 0, audit unchanged) [.sh test 9]", () => {
    const { auditDir } = seedIntentShard(proj);
    const before = readShards(auditDir);
    const r = fire("not-json", proj);
    expect(r.exitCode).toBe(0);
    expect(readShards(auditDir)).toBe(before);
  });

  test("CLAUDE_PROJECT_DIR fallback from script path [.sh test 10]", () => {
    const { recordRoot } = seedIntentShard(proj);
    // Copy the hook + its relative tool deps into the project's .claude/ so the
    // hook's import.meta.url ends in .claude/hooks; resolveProjectDirFromHook
    // then derives projectDir by stripping that suffix when CLAUDE_PROJECT_DIR
    // is UNSET. Mirrors the .sh's cp of the hook + lib + audit.
    mkdirSync(join(proj, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(proj, ".claude", "tools"), { recursive: true });
    const localHook = join(proj, ".claude", "hooks", "aidlc-audit-logger.ts");
    copyFileSync(HOOK, localHook);
    copyFileSync(
      join(AIDLC_SRC, "tools", "aidlc-lib.ts"),
      join(proj, ".claude", "tools", "aidlc-lib.ts"),
    );
    copyFileSync(
      join(AIDLC_SRC, "tools", "aidlc-audit.ts"),
      join(proj, ".claude", "tools", "aidlc-audit.ts"),
    );
    fire(writeJson(join(recordRoot, "test.md")), proj, localHook, /* setEnv */ false);
    const heartbeat = join(recordRoot, ".aidlc-hooks-health", "audit-logger.last");
    expect(existsSync(heartbeat)).toBe(true);
  });

  test("construction phase context breadcrumb [.sh test 11]", () => {
    const { auditDir, recordRoot } = seedIntentShard(proj);
    seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
    fire(
      writeJson(join(recordRoot, "construction", "functional-design", "design.md")),
      proj,
    );
    expect(readShards(auditDir)).toContain("construction > functional-design > design.md");
  });

  test("operation phase context breadcrumb [.sh test 12]", () => {
    const { auditDir, recordRoot } = seedIntentShard(proj);
    seedStateFile(proj, join(FIXTURES_DIR, "state-operation.md"));
    fire(
      writeJson(join(recordRoot, "operation", "deployment-pipeline", "config.md")),
      proj,
    );
    expect(readShards(auditDir)).toContain("operation > deployment-pipeline > config.md");
  });

  test("logging path completes within 500ms [.sh test 13]", () => {
    const { recordRoot } = seedIntentShard(proj);
    const r = fire(writeJson(join(recordRoot, "test.md")), proj);
    // The .sh measured bun cold-start + the logging path with `assert_lt 500`.
    // Same wall-clock budget here against the same spawned process.
    expect(r.durationMs).toBeLessThan(500);
  });

  test("skip path completes within 300ms [.sh test 14]", () => {
    seedIntentShard(proj);
    const r = fire(writeJson("/tmp/other/file.txt"), proj);
    // .sh: skip path (outside the record) under `assert_lt 300`.
    expect(r.durationMs).toBeLessThan(300);
  });

  test("emits canonical **Event**: ARTIFACT_* field [.sh test 15]", () => {
    const { auditDir, recordRoot } = seedIntentShard(proj);
    // The pinned shard starts empty (only this write's block lands in it),
    // matching the .sh's `: > audit.md`.
    fire(writeJson(join(recordRoot, "test.md")), proj);
    const body = readShards(auditDir);
    // .sh grepped `^\*\*Event\*\*: ARTIFACT_`: a start-of-line **Event**:
    // ARTIFACT_* field, the canonical form (not free-form markdown).
    const hasCanonical = body
      .split("\n")
      .some((l) => /^\*\*Event\*\*: ARTIFACT_/.test(l));
    expect(hasCanonical).toBe(true);
  });

  test("Write→CREATED, Edit→UPDATED on same file [.sh test 16]", () => {
    // Pinned shard starts empty (passes the gate) so we count only this test's events.
    const { auditDir, recordRoot } = seedIntentShard(proj);
    const file = join(recordRoot, "x.md");
    fire(writeJson(file), proj);
    fire(editJson(file), proj);
    const body = readShards(auditDir);
    const created = body.split("\n").filter((l) => l.trim() === "**Event**: ARTIFACT_CREATED").length;
    const updated = body.split("\n").filter((l) => l.trim() === "**Event**: ARTIFACT_UPDATED").length;
    // .sh: CREATED == 1 && UPDATED == 1 — Write on a net-new file creates,
    // Edit on the now-existing file updates.
    expect(created).toBe(1);
    expect(updated).toBe(1);
  });
});
