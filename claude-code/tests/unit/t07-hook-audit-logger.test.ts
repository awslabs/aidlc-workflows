// covers: hook:aidlc-audit-logger, function:appendAuditEntry
//
// t07 — aidlc-audit-logger.ts PostToolUse hook behaviour. Migrated from
// tests/unit/t07-hook-audit-logger.sh (TAP plan 16). Mechanism: cli.
//
// WHY CLI (process-boundary, not in-process): the SUBJECT is a hook, not a
// pure function. aidlc-audit-logger.ts reads PostToolUse JSON from STDIN
// (`await Bun.stdin.text()`, :33), resolves its projectDir from the
// CLAUDE_PROJECT_DIR env var OR by stripping `.claude/hooks` off its own
// script path (resolveProjectDirFromHook, aidlc-lib.ts:114), and self-gates
// with `process.exit(0)` on every skip branch (TTY :31, bad JSON :37-40,
// non-aidlc-docs :47, audit.md self-write :50, no audit.md :55). None of those
// seams — stdin, the env/script-path projectDir derivation, the exit codes —
// is reachable by importing a function; the module's top level RUNS on import
// and terminates the process. So this twin SPAWNS the real shipped hook the
// same way Claude Code's PostToolUse(Write|Edit) drives it from settings.json:
// `Bun.spawnSync({ cmd: [BUN, HOOK], stdin: <json bytes>, env: {…CLAUDE_PROJECT_DIR} })`.
//
// SOURCE UNDER TEST (dist/claude/.claude/hooks/aidlc-audit-logger.ts):
//   :21  projectDir = resolveProjectDirFromHook(import.meta.url)
//   :24-26 writes a heartbeat to aidlc-docs/.aidlc-hooks-health/audit-logger.last
//          (unconditional, before any gate)
//   :31  if (process.stdin.isTTY) process.exit(0)
//   :33-41 reads stdin, JSON.parse; bad shape / parse error -> exit(0) (no write)
//   :47  only logs file_paths containing "aidlc-docs/" (else exit 0)
//   :50  skips file_paths ending "/audit.md" (anti-recursion) (else exit 0)
//   :55  skips when audit.md does NOT already exist (no auto-create) (exit 0)
//   :58-63 context breadcrumb = path after "aidlc-docs/" with / -> " > "
//   :74-92 Edit -> ARTIFACT_UPDATED; Write -> CREATED if net-new (mtime≈birthtime)
//          else UPDATED
//   :94-99 appendAuditEntry(eventType, {Tool, File, Context}, projectDir)
//          — writes a "**Event**: ARTIFACT_*" block to audit.md
//
// appendAuditEntry's on-disk block format (aidlc-audit.ts, asserted via real
// bytes): "\n## <heading>\n**Timestamp**: <ts>\n**Event**: <type>\n<fields>\n---\n".
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file +
// cleanup_test_project, one fresh project per case):
//   - createTestProject() -> a fresh temp dir with aidlc-docs/.
//   - seedAuditFile() -> copies tests/fixtures/audit-sample.md to
//     aidlc-docs/audit.md (the precondition for the emit; the hook self-gates
//     on audit.md existing, :55).
//   - state fixtures (tests 11/12) seeded via seedStateFile() — same bytes the
//     .sh's seed_state_file copied. The hook derives the breadcrumb purely from
//     the file path, so the state fixture is incidental; preserved for parity.
//   - cleanupTestProject() rm -rf's each temp project. Nothing written under
//     tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1  (skips non-aidlc-docs writes)              -> "skips non-aidlc-docs writes (audit unchanged)"
//   .sh test 2  (skips audit.md self-writes)               -> "skips audit.md self-writes (anti-recursion)"
//   .sh test 3  (logs aidlc-docs artifact as CREATED)      -> "logs aidlc-docs artifact writes as ARTIFACT_CREATED"
//   .sh test 4  (context breadcrumb)                       -> "extracts the ideation breadcrumb"
//   .sh test 5  (Edit -> ARTIFACT_UPDATED)                 -> "Edit tool emits ARTIFACT_UPDATED"
//   .sh test 6  (exits silently when no audit.md)          -> "exits silently when no audit.md (file not created)"
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
//
// 16 .sh asserts -> 16 expect()-bearing test() cases (several STRONGER: test 3
// also pins the exact Context breadcrumb; test 8/9 pin BOTH exit 0 AND byte-
// equality; test 15 anchors the line to start-of-line; test 16 pins exactly
// one of each event).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-audit-logger.ts");

let proj: string;

function auditPath(p: string): string {
  return join(p, "aidlc-docs", "audit.md");
}

function readAudit(p: string): string {
  return readFileSync(auditPath(p), "utf-8");
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

  test("skips non-aidlc-docs writes (audit unchanged) [.sh test 1]", () => {
    seedAuditFile(proj);
    const before = readAudit(proj);
    fire(writeJson("/tmp/other/file.txt"), proj);
    expect(readAudit(proj)).toBe(before);
  });

  test("skips audit.md self-writes (anti-recursion) [.sh test 2]", () => {
    seedAuditFile(proj);
    const before = readAudit(proj);
    fire(writeJson(join(proj, "aidlc-docs", "audit.md")), proj);
    expect(readAudit(proj)).toBe(before);
  });

  test("logs aidlc-docs artifact writes as ARTIFACT_CREATED [.sh test 3]", () => {
    seedAuditFile(proj);
    fire(writeJson(join(proj, "aidlc-docs", "knowledge", "aidlc-shared", "intent.md")), proj);
    expect(readAudit(proj)).toContain("ARTIFACT_CREATED");
  });

  test("extracts the ideation breadcrumb [.sh test 4]", () => {
    seedAuditFile(proj);
    fire(writeJson(join(proj, "aidlc-docs", "ideation", "intent-capture", "intent.md")), proj);
    // STRONGER than the .sh grep: the breadcrumb is on a **Context**: line.
    expect(readAudit(proj)).toContain("ideation > intent-capture > intent.md");
  });

  test("Edit tool emits ARTIFACT_UPDATED [.sh test 5]", () => {
    seedAuditFile(proj);
    fire(editJson(join(proj, "aidlc-docs", "state.md")), proj);
    expect(readAudit(proj)).toContain("ARTIFACT_UPDATED");
  });

  test("exits silently when no audit.md (file not created) [.sh test 6]", () => {
    // Intentionally do NOT seed audit.md — the hook must not auto-create it (:55).
    expect(existsSync(auditPath(proj))).toBe(false);
    fire(writeJson(join(proj, "aidlc-docs", "knowledge", "aidlc-shared", "test.md")), proj);
    expect(existsSync(auditPath(proj))).toBe(false);
  });

  test("writes the audit-logger.last heartbeat [.sh test 7]", () => {
    seedAuditFile(proj);
    fire(writeJson(join(proj, "aidlc-docs", "test.md")), proj);
    const heartbeat = join(proj, "aidlc-docs", ".aidlc-hooks-health", "audit-logger.last");
    expect(existsSync(heartbeat)).toBe(true);
  });

  test("handles empty stdin gracefully (exit 0, audit unchanged) [.sh test 8]", () => {
    seedAuditFile(proj);
    const before = readAudit(proj);
    const r = fire("", proj);
    expect(r.exitCode).toBe(0);
    expect(readAudit(proj)).toBe(before);
  });

  test("handles malformed JSON stdin (exit 0, audit unchanged) [.sh test 9]", () => {
    seedAuditFile(proj);
    const before = readAudit(proj);
    const r = fire("not-json", proj);
    expect(r.exitCode).toBe(0);
    expect(readAudit(proj)).toBe(before);
  });

  test("CLAUDE_PROJECT_DIR fallback from script path [.sh test 10]", () => {
    seedAuditFile(proj);
    // Copy the hook + its relative tool deps into the project's .claude/ so the
    // hook's import.meta.url ends in .claude/hooks; resolveProjectDirFromHook
    // (aidlc-lib.ts:114) then derives projectDir by stripping that suffix when
    // CLAUDE_PROJECT_DIR is UNSET. Mirrors the .sh's cp of the hook + lib + audit.
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
    fire(writeJson(join(proj, "aidlc-docs", "test.md")), proj, localHook, /* setEnv */ false);
    const heartbeat = join(proj, "aidlc-docs", ".aidlc-hooks-health", "audit-logger.last");
    expect(existsSync(heartbeat)).toBe(true);
  });

  test("construction phase context breadcrumb [.sh test 11]", () => {
    seedAuditFile(proj);
    seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
    fire(
      writeJson(join(proj, "aidlc-docs", "construction", "functional-design", "design.md")),
      proj,
    );
    expect(readAudit(proj)).toContain("construction > functional-design > design.md");
  });

  test("operation phase context breadcrumb [.sh test 12]", () => {
    seedAuditFile(proj);
    seedStateFile(proj, join(FIXTURES_DIR, "state-operation.md"));
    fire(
      writeJson(join(proj, "aidlc-docs", "operation", "deployment-pipeline", "config.md")),
      proj,
    );
    expect(readAudit(proj)).toContain("operation > deployment-pipeline > config.md");
  });

  test("logging path completes within 500ms [.sh test 13]", () => {
    seedAuditFile(proj);
    const r = fire(writeJson(join(proj, "aidlc-docs", "test.md")), proj);
    // The .sh measured bun cold-start + the logging path with `assert_lt 500`.
    // Same wall-clock budget here against the same spawned process.
    expect(r.durationMs).toBeLessThan(500);
  });

  test("skip path completes within 300ms [.sh test 14]", () => {
    seedAuditFile(proj);
    const r = fire(writeJson("/tmp/other/file.txt"), proj);
    // .sh: skip path (non-aidlc-docs) under `assert_lt 300`.
    expect(r.durationMs).toBeLessThan(300);
  });

  test("emits canonical **Event**: ARTIFACT_* field [.sh test 15]", () => {
    seedAuditFile(proj);
    // Start fresh so only this write's block is present, matching the .sh's
    // `: > audit.md`. seedAuditFile then truncate -> empty audit.md (still
    // exists, so the :55 gate passes).
    writeFileSync(auditPath(proj), "");
    fire(writeJson(join(proj, "aidlc-docs", "test.md")), proj);
    const body = readAudit(proj);
    // .sh grepped `^\*\*Event\*\*: ARTIFACT_`: a start-of-line **Event**:
    // ARTIFACT_* field, the canonical form (not free-form markdown).
    const hasCanonical = body
      .split("\n")
      .some((l) => /^\*\*Event\*\*: ARTIFACT_/.test(l));
    expect(hasCanonical).toBe(true);
  });

  test("Write→CREATED, Edit→UPDATED on same file [.sh test 16]", () => {
    // Empty audit.md (exists, passes :55) so we count only this test's events.
    mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
    writeFileSync(auditPath(proj), "");
    const file = join(proj, "aidlc-docs", "x.md");
    fire(writeJson(file), proj);
    fire(editJson(file), proj);
    const body = readAudit(proj);
    const created = body.split("\n").filter((l) => l.trim() === "**Event**: ARTIFACT_CREATED").length;
    const updated = body.split("\n").filter((l) => l.trim() === "**Event**: ARTIFACT_UPDATED").length;
    // .sh: CREATED == 1 && UPDATED == 1 — Write on a net-new file creates,
    // Edit on the now-existing file updates.
    expect(created).toBe(1);
    expect(updated).toBe(1);
  });
});
