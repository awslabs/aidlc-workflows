// covers: function:migrateFlatLayout, function:auditShards, function:readAllAuditShards, function:auditShardDir, function:auditShardName, subcommand:aidlc-utility:intent-birth
//
// Mechanism: cli (spawned dist intent-birth) + in-process pure-function asserts
// against the dist lib audit readers.
//
// Blocker B2 regression — migration must PRESERVE the pre-migration audit trail.
// The flat→per-intent migration (migrateFlatLayout) used to blind-copy the flat
// `aidlc-docs/audit.md` FILE to `<record>/audit.md`, where it sat ORPHANED: the
// audit readers (auditShards/readAllAuditShards) glob the `<record>/audit/` DIR,
// and the flat-fallback only fires when the record dir is absent (never, post-
// migration). So the WORKFLOW_STARTED/STAGE history was on disk but invisible to
// runtime-graph compile, summary/replay, and every hook — contradicting the
// in-code claim that "the migrated record carries its prior state + audit
// history". The fix RELOCATES the flat audit.md into the shard layout
// `<record>/audit/<host>-<clone>.md` during migration (honours decision #1:
// a per-clone shard, NOT a single audit.md + merge=union).
//
// WHY a populated audit.md: t165's migration-wiring block seeds a HEADER-ONLY
// audit.md (no events), which is exactly why the orphaning escaped there. This
// test seeds REAL `\n---\n`-separated event blocks (mirroring what
// appendAuditEntryUnlocked writes) and asserts they survive the migration AND are
// reachable through the shard readers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";
import {
  activeIntent,
  auditShards,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTIL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

let proj: string;
beforeEach(() => {
  proj = createTestProject();
});
afterEach(() => {
  cleanupTestProject(proj);
});

interface Run {
  status: number;
  out: string;
}
function util(args: string[], p = proj): Run {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = Bun.spawnSync({
    cmd: [BUN, UTIL, ...args, "--project-dir", p],
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return { status: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

const intentsDir = (p: string, space = "default"): string =>
  join(p, "aidlc", "spaces", space, "intents");

// A populated flat audit.md with two REAL event blocks in the exact on-disk
// shape appendAuditEntryUnlocked writes: `\n## <heading>\n**Timestamp**: ...\n
// **Event**: <type>\n<fields>\n\n---\n`. Blocks are `\n---\n`-separated.
const FLAT_AUDIT = [
  "# AI-DLC Audit Log\n",
  "## Workflow Start",
  "**Timestamp**: 2025-06-15T10:30:00Z",
  "**Event**: WORKFLOW_STARTED",
  "**Source**: startup",
  "",
  "---",
  "## Stage Transition",
  "**Timestamp**: 2025-06-15T10:45:00Z",
  "**Event**: STAGE_TRANSITION",
  "**Stage**: 1.1",
  "",
  "---",
  "",
].join("\n");

describe("t172 migration preserves the pre-migration audit trail (B2)", () => {
  test("intent-birth relocates the flat audit.md into the shard layout so its events stay readable", () => {
    // Seed a flat (pre-workspace) project: aidlc-docs/aidlc-state.md (with a
    // Project field) + a POPULATED aidlc-docs/audit.md (real event blocks).
    const flat = join(proj, "aidlc-docs");
    mkdirSync(flat, { recursive: true });
    writeFileSync(
      join(flat, "aidlc-state.md"),
      "# AI-DLC State Tracking\n## Project Information\n- **Scope**: feature\n- **Project**: Legacy App\n",
      "utf-8",
    );
    writeFileSync(join(flat, "audit.md"), FLAT_AUDIT, "utf-8");

    // Migrate via the real handler (under the real workspace lock).
    const r = util(["intent-birth", "--scope", "feature"]);
    expect(r.status).toBe(0);

    // One migrated record carrying the flat state.
    const records = readdirSync(intentsDir(proj)).filter((d) =>
      existsSync(join(intentsDir(proj), d, "aidlc-state.md")),
    );
    expect(records.length).toBe(1);
    const recordDirName = records[0];
    const record = join(intentsDir(proj), recordDirName);

    // --- B2 core: the pre-migration events are reachable through the readers ---
    // readAllAuditShards over the migrated intent returns the WORKFLOW_STARTED
    // (and STAGE_TRANSITION) events from the flat audit.md.
    const intent = activeIntent(proj);
    expect(intent).toBe(recordDirName);
    const buf = readAllAuditShards(proj, intent ?? undefined);
    expect(buf).toContain("WORKFLOW_STARTED");
    expect(buf).toContain("STAGE_TRANSITION");

    // The events are exposed as a NON-EMPTY shard list pointing INSIDE the
    // `<record>/audit/` shard dir (not a top-level file).
    const shards = auditShards(proj, intent ?? undefined);
    expect(shards.length).toBeGreaterThan(0);
    for (const s of shards) {
      expect(s.startsWith(`${join(record, "audit")}/`)).toBe(true);
      expect(s.endsWith(".md")).toBe(true);
    }
    // The relocated shard actually holds the migrated content.
    expect(readFileSync(shards[0], "utf-8")).toContain("WORKFLOW_STARTED");

    // No stray top-level `<record>/audit.md` FILE remains (it was relocated).
    const strayFile = join(record, "audit.md");
    expect(existsSync(strayFile) && statSync(strayFile).isFile()).toBe(false);
    // And `<record>/audit` is the shard DIR.
    expect(statSync(join(record, "audit")).isDirectory()).toBe(true);

    // --- migration still works end-to-end ---
    // Migrated state carries the flat Project field.
    expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toContain("Legacy App");
    // .migrated marker exists (idempotency key).
    expect(existsSync(join(proj, "aidlc", ".migrated"))).toBe(true);
    // The flat tree was git-rm'd from the working tree post-move.
    expect(existsSync(join(flat, "aidlc-state.md"))).toBe(false);
    expect(existsSync(join(flat, "audit.md"))).toBe(false);
  });
});
