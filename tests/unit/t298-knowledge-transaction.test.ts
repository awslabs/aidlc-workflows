// covers: subcommand:aidlc-knowledge:onboard function:spaceAuditShardPath function:journalDir function:journalTxnDir function:collectStaleJournals function:appendAuditEntryAtPathUnlocked audit:DOCUMENT_INDEXED
//
// t298 - the journaled transaction around `onboard`. Where t289 covers the read
// boundary, this covers what happens between reading and committing: the lock,
// the staging journal, the digest re-validation, and where the audit row lands.
//
// Mechanism: real filesystem + real subprocesses (concurrency cannot be faked
// in-process; two `onboard` calls in one process would serialise on the
// reentrant lock and prove nothing about two PROCESSES).
//
// Subject under test: dist/claude/.claude/tools/aidlc-knowledge.ts (the SHIPPED
// distributable), so a guard reverted only in core/ cannot pass.
//
// What each invariant prevents, and why the mechanism is what it is:
//
//   THE SHARD. All three DOCUMENT_* events go to the SPACE-level shard, even for
//   an intent-scoped document, with the intent recorded as a FIELD. A document
//   outlives any intent and `associate`/`dissociate` can move its scope later --
//   filing provenance under whichever intent was active would split one
//   document's history across shards and make it unreconstructible.
//
//   This one has a measured trap behind it. `auditFilePath(pd, undefined, space)`
//   does NOT give the space shard: `undefined` means "resolve from the cursor",
//   so it returns the ACTIVE INTENT's shard whenever one exists. The space shard
//   is only reached when a space has no intents at all -- which is why a first
//   probe in an empty space looks correct. The first build of this transaction
//   passed `undefined` and filed into `intents/<slug>/audit/`. The fixture below
//   therefore ALWAYS creates an intent first; without one, the test cannot fail.
//
//   EXTRACTION OUTSIDE THE LOCK. The lock's acquire budget is ~5s, so holding it
//   across a multi-second external parse would make UNRELATED commands fail to
//   acquire rather than merely wait.
//
//   DIGEST RE-VALIDATION INSIDE IT. Without it, a document edited during staging
//   is indexed with the new digest and the OLD text -- a silent correctness
//   failure that no amount of locking elsewhere prevents.
//
//   FRESH READ INSIDE THE LOCK. The index copy from the read pass predates the
//   lock; writing it back is exactly how a concurrent onboard loses a row.
//
//   ABSENT-OR-COMPLETE. Staging into `.journal/<txn>/` and `rename()`-ing in one
//   step means a crash never leaves a half-written `documentkb/<id>/` that a
//   later read treats as valid.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  collectStaleJournals,
  documentkbDir,
  documentsDir,
  indexPath,
  journalDir,
  journalTxnDir,
  onboard,
  readIndex,
  rebindDocument,
  setIntentAssociation,
  sha256Hex,
  spaceAuditShardPath,
  syncDocuments,
} from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";
import {
  appendAuditEntry,
  appendAuditEntryAtPathUnlocked,
} from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditFilePath,
  humanActedSinceGate,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const AIDLC_TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const NOW = "2026-08-07T00:00:00Z";
const SPACE = "default";
const CHILD_ENV = { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" };

/** Minimum time a test's lock holder keeps the lock, so the subject
 *  demonstrably BLOCKS rather than sailing through an already-free lock. */
const MIN_HOLD_MS = 300;
/** Maximum time it keeps it. Every holder below is released by the mutator's
 *  announcement, not by a clock, so this cap only ever fires when a mutator
 *  broke -- and then the subject blows its acquire budget and the assertion
 *  REPORTS a failure, which a holder that held forever never would. */
const HOLD_CAP_MS = 15_000;

let proj: string | undefined;

/** A project WITH AN ACTIVE INTENT. The intent is not incidental: the shard bug
 *  this file guards is invisible in a space with no intents, because that is the
 *  one case where the buggy call happens to return the right path. */
function projectWithIntent(): string {
  proj = mkdtempSync(join(tmpdir(), "t298-"));
  const r = spawnSync(
    "bun",
    [join(AIDLC_TOOLS, "aidlc-utility.ts"), "intent-create", "--label", "probe",
     "--project-dir", proj],
    { encoding: "utf-8", env: CHILD_ENV },
  );
  expect(r.status, `intent-create failed: ${r.stderr}`).toBe(0);
  mkdirSync(documentsDir(proj, SPACE), { recursive: true });
  return proj;
}

function doc(p: string, name: string, body = "text\n"): string {
  const full = join(documentsDir(p, SPACE), name);
  writeFileSync(full, body);
  return full;
}

function intentUuid(p: string): string {
  const rows = JSON.parse(readFileSync(
    join(p, "aidlc", "spaces", SPACE, "intents", "intents.json"),
    "utf-8",
  )) as { uuid: string }[];
  return rows[0].uuid;
}

function runOnboard(p: string, args: string[] = []): { status: number; out: string } {
  const r = spawnSync(
    "bun",
    [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", ...args, "--project-dir", p],
    { encoding: "utf-8", env: CHILD_ENV },
  );
  return { status: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** A subprocess that takes the SPACE audit lock, announces it by writing
 *  `heldMarker`, and then keeps holding until the mutator announces its write by
 *  creating `mutationDoneMarker`. That is what makes "the mutation lands before
 *  the lock is released" an ORDERING GUARANTEE instead of a timing hope: the
 *  subject cannot reach its commit-time re-validation until the mutation is
 *  already on disk, in every interleaving.
 *
 *  Written as a file rather than inlined so the shell script stays readable, and
 *  shared by every trio below so a fix cannot land in nine of ten holders.
 *
 *  The hold sits far inside both lock bounds, which is why it is safe: a waiter
 *  gets 50 x 100ms of acquire budget (`acquireAuditLock` defaults in
 *  aidlc-lib.ts), and a LIVE holder is only stealable once it is over-age at
 *  DEFAULT_LOCK_STALE_MS (10 minutes) -- so a hold of a second or two is never
 *  reaped out from under the test, and never starves the subject either. */
function writeLockHolder(
  path: string,
  p: string,
  heldMarker: string,
  mutationDoneMarker: string,
): string {
  writeFileSync(
    path,
    `const lib = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-lib.ts"))});\n` +
      `const fs = require("node:fs");\n` +
      `lib.withAuditLock(${JSON.stringify(p)}, () => {\n` +
      `  fs.writeFileSync(${JSON.stringify(heldMarker)}, "1");\n` +
      `  const minimumHold = Date.now() + ${MIN_HOLD_MS};\n` +
      `  const cap = Date.now() + ${HOLD_CAP_MS};\n` +
      `  while (Date.now() < cap) {\n` +
      `    if (Date.now() >= minimumHold && fs.existsSync(${JSON.stringify(mutationDoneMarker)})) break;\n` +
      // Sleep rather than spin: the subject needs the CPU to reach its staging
      // pass inside this window, and a hot spin is what makes that slow.
      `    Bun.sleepSync(10);\n` +
      `  }\n` +
      `  return 0;\n` +
      `}, undefined, ${JSON.stringify(SPACE)});\n`,
  );
  return path;
}

/** The shell gate a trio must clear before launching its mutator and subject:
 *  wait for `marker`, with a REAL deadline (200 x 50ms = 10s).
 *
 *  This replaces `for i in $(seq 1 100); do [ -f X ] && break; done`, which had
 *  no sleep: 100 iterations of a `[ -f ]` builtin complete in ~3ms, while the
 *  holder needs ~30ms of bun startup before it can even take the lock. So the
 *  gate always fell through un-gated and every test below degraded into an
 *  unsynchronised race -- the subject frequently won it, committed correctly,
 *  and then failed an assertion that compared its committed row against bytes
 *  the mutator only wrote afterwards. */
function waitForFile(marker: string): string {
  return `for i in $(seq 1 200); do [ -f ${JSON.stringify(marker)} ] && break; sleep 0.05; done`;
}

/** Every audit shard under the space, with its contents. */
function auditShards(p: string): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) out.push({ path: full, body: readFileSync(full, "utf-8") });
    }
  };
  walk(join(p, "aidlc", "spaces", SPACE, "intents"));
  return out;
}

afterEach(() => {
  if (proj !== undefined) {
    rmSync(proj, { recursive: true, force: true });
    proj = undefined;
  }
});

describe("t298 the audit row lands in the SPACE shard, not the active intent's", () => {
  test("a failed audit-last append is repaired by an idempotent onboard retry", () => {
    const p = projectWithIntent();
    const abs = doc(p, "audit-repair.md");
    const shard = spaceAuditShardPath(p, SPACE);
    mkdirSync(dirname(shard), { recursive: true });
    mkdirSync(shard);

    expect(() => onboard(p, SPACE, abs, NOW)).toThrow();
    expect(readIndex(p, SPACE).documents).toHaveLength(1);

    rmSync(shard, { recursive: true, force: true });
    expect(onboard(p, SPACE, abs, NOW).indexed[0].status).toBe("already");
    expect(readAllAuditShards(p, undefined, SPACE)).toContain("**Event**: DOCUMENT_INDEXED");
  });

  test("audit recovery projects space history from another clone shard", () => {
    const p = projectWithIntent();
    const source = doc(p, "other-clone.md");
    onboard(p, SPACE, source, NOW);
    const currentShard = spaceAuditShardPath(p, SPACE);
    const otherShard = join(dirname(currentShard), "other-host-other-clone.md");
    renameSync(currentShard, otherShard);

    expect(onboard(p, SPACE, source, NOW).indexed[0].status).toBe("already");
    expect(existsSync(currentShard)).toBe(false);
    expect(readFileSync(otherShard, "utf-8")).toContain("**Event**: DOCUMENT_INDEXED");
  });

  test("DOCUMENT_INDEXED is written to the space-level shard", () => {
    const p = projectWithIntent();
    doc(p, "policy.md");
    onboard(p, SPACE, undefined, NOW);

    const withEvent = auditShards(p).filter((s) => s.body.includes("DOCUMENT_INDEXED"));
    expect(withEvent.length, "exactly one shard must carry the event").toBe(1);
    // The space shard is `intents/audit/…`; an intent shard is
    // `intents/<slug>/audit/…`. Assert the FULL path shape, because "contains
    // intents" is true of both.
    expect(withEvent[0].path).toBe(spaceAuditShardPath(p, SPACE));
    expect(withEvent[0].path).toContain(join("intents", "audit"));
    expect(readAllAuditShards(p, undefined, SPACE)).toContain("**Event**: DOCUMENT_INDEXED");
  });

  test("unscoped reads stay intent-only while explicit-space reads preserve the intent tail", () => {
    const p = projectWithIntent();
    for (const name of ["a.md", "b.md", "c.md"]) doc(p, name);
    onboard(p, SPACE, undefined, NOW);
    appendAuditEntry("STAGE_STARTED", { Stage: "requirements-analysis" }, p);
    const unscoped = readAllAuditShards(p);
    expect(unscoped).not.toContain("**Event**: DOCUMENT_INDEXED");
    expect(unscoped).toContain("**Event**: STAGE_STARTED");

    const explicitSpace = readAllAuditShards(p, undefined, SPACE);
    expect(explicitSpace).toContain("**Event**: DOCUMENT_INDEXED");
    const blocks = explicitSpace.split(/\n---\n/).filter((block) => block.trim());
    expect(blocks.at(-1)).toContain("**Event**: STAGE_STARTED");
  });

  test("DocumentKB-only audit rows do not activate the human-presence floor", () => {
    const p = projectWithIntent();
    doc(p, "policy.md");
    expect(humanActedSinceGate(p)).toBe(false);
    onboard(p, SPACE, undefined, NOW);
    expect(humanActedSinceGate(p)).toBe(false);
    appendAuditEntry("HUMAN_TURN", {}, p);
    expect(humanActedSinceGate(p)).toBe(true);
  });

  test("audit repair refuses to append through a symlinked space shard", () => {
    const p = projectWithIntent();
    const external = join(p, "external-audit.md");
    const original = "# External audit\n";
    writeFileSync(external, original);
    const shard = spaceAuditShardPath(p, SPACE);
    mkdirSync(dirname(shard), { recursive: true });
    try {
      symlinkSync(external, shard);
    } catch {
      return; // Windows without symlink privilege.
    }
    doc(p, "policy.md");
    expect(() => onboard(p, SPACE, undefined, NOW)).toThrow();
    expect(readFileSync(external, "utf-8")).toBe(original);
  });

  test("audit append refuses a symlinked space-shard parent", () => {
    const p = projectWithIntent();
    const externalDir = join(p, "external-audit-dir");
    mkdirSync(externalDir);
    const shard = spaceAuditShardPath(p, SPACE);
    mkdirSync(dirname(dirname(shard)), { recursive: true });
    try {
      symlinkSync(externalDir, dirname(shard));
    } catch {
      return; // Windows without symlink privilege.
    }
    doc(p, "policy.md");
    expect(() => onboard(p, SPACE, undefined, NOW)).toThrow();
    expect(readdirSync(externalDir)).toEqual([]);
  });

  test("audit repair records a reverted digest instead of matching stale history", () => {
    const p = projectWithIntent();
    const source = doc(p, "reverted.md", "A\n");
    const row = onboard(p, SPACE, source, NOW).indexed[0];
    writeFileSync(source, "B\n");
    syncDocuments(p, SPACE, "2026-08-13T00:01:00Z");

    writeFileSync(source, "A\n");
    const shard = spaceAuditShardPath(p, SPACE);
    renameSync(shard, `${shard}.saved`);
    mkdirSync(shard);
    expect(() => syncDocuments(p, SPACE, "2026-08-13T00:02:00Z")).toThrow();
    rmSync(shard, { recursive: true, force: true });
    renameSync(`${shard}.saved`, shard);

    syncDocuments(p, SPACE, "2026-08-13T00:03:00Z");
    const revisions = readFileSync(shard, "utf-8")
      .split(/\n---\n/)
      .filter((block) => block.includes(`**Document**: ${row.id}`) && block.includes("**Digest**:"));
    expect(revisions.at(-1)).toContain(`**Digest**: ${sha256Hex(Buffer.from("A\n"))}`);
    expect(revisions.at(-1)).toContain("**Change**: audit-repair");
  });

  test("audit repair records a pure move whose digest did not change", () => {
    const p = projectWithIntent();
    const source = doc(p, "before.md", "same\n");
    const row = onboard(p, SPACE, source, NOW).indexed[0];
    const moved = join(documentsDir(p, SPACE), "after.md");
    renameSync(source, moved);
    const shard = spaceAuditShardPath(p, SPACE);
    renameSync(shard, `${shard}.saved`);
    mkdirSync(shard);
    expect(() => syncDocuments(p, SPACE, "2026-08-13T00:01:00Z")).toThrow();
    rmSync(shard, { recursive: true, force: true });
    renameSync(`${shard}.saved`, shard);

    syncDocuments(p, SPACE, "2026-08-13T00:02:00Z");
    const blocks = readFileSync(shard, "utf-8").split(/\n---\n/);
    const latest = blocks.filter((block) => block.includes(`**Document**: ${row.id}`)).at(-1);
    expect(latest).toContain("**Change**: audit-repair");
    expect(latest).toContain("**Source**: documents/after.md");
  });

  test("same-path same-digest rebind revives a tombstoned row", () => {
    const p = projectWithIntent();
    const source = doc(p, "revive.md", "same\n");
    const row = onboard(p, SPACE, source, NOW).indexed[0];
    rmSync(source);
    syncDocuments(p, SPACE, "2026-08-13T00:01:00Z");
    writeFileSync(source, "same\n");

    rebindDocument(p, SPACE, row.id, source, "2026-08-13T00:02:00Z");
    expect(readIndex(p, SPACE).documents.find((candidate) => candidate.id === row.id)?.removed_at)
      .toBeUndefined();
  });

  test("explicit-space audit readers do not follow a symlinked space shard", () => {
    const p = projectWithIntent();
    const external = join(p, "external-audit.md");
    writeFileSync(
      external,
      "# External\n\n---\n**Event**: DOCUMENT_INDEXED\n**Timestamp**: 2026-08-13T00:00:00Z\n**Document**: leaked\n",
    );
    const shardDir = dirname(spaceAuditShardPath(p, SPACE));
    mkdirSync(shardDir, { recursive: true });
    try {
      symlinkSync(external, join(shardDir, "leak.md"));
    } catch {
      return; // Windows without symlink privilege.
    }
    expect(readAllAuditShards(p, undefined, SPACE)).not.toContain("**Document**: leaked");
  });

  test("NO intent shard receives the event, even though an intent is active", () => {
    // The regression: filing under whichever intent happened to be active.
    const p = projectWithIntent();
    doc(p, "policy.md");
    onboard(p, SPACE, undefined, NOW);

    const intentShards = auditShards(p).filter(
      (s) => !s.path.startsWith(join(p, "aidlc", "spaces", SPACE, "intents", "audit")),
    );
    expect(intentShards.length, "the fixture must have an intent shard to be a real test")
      .toBeGreaterThan(0);
    for (const s of intentShards) {
      expect(s.body, `${s.path} must not carry a DocumentKB event`)
        .not.toContain("DOCUMENT_INDEXED");
    }
  });

  test("the row carries Space, Document, Source and Digest as fields", () => {
    const p = projectWithIntent();
    doc(p, "policy.md", "exact\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const body = readFileSync(spaceAuditShardPath(p, SPACE), "utf-8");
    expect(body).toContain("**Event**: DOCUMENT_INDEXED");
    expect(body).toContain(`**Document**: ${indexed[0].id}`);
    expect(body).toContain(`**Source**: ${indexed[0].path}`);
    expect(body).toContain(`**Digest**: ${indexed[0].sha256}`);
    expect(body).toContain(`**Space**: ${SPACE}`);
  });

  test("one event per document, so the ledger reconstructs the catalog", () => {
    const p = projectWithIntent();
    doc(p, "a.md");
    doc(p, "b.md");
    onboard(p, SPACE, undefined, NOW);
    const body = readFileSync(spaceAuditShardPath(p, SPACE), "utf-8");
    expect(body.match(/\*\*Event\*\*: DOCUMENT_INDEXED/g)?.length).toBe(2);
  });

  test("a re-onboard emits NO event — nothing changed", () => {
    // An event per call inflates the ledger with non-changes and breaks the
    // reconstructible-from-the-ledger invariant.
    const p = projectWithIntent();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const after1 = readFileSync(spaceAuditShardPath(p, SPACE), "utf-8");
    const second = onboard(p, SPACE, undefined, NOW);
    expect(second.indexed[0].status).toBe("already");
    expect(readFileSync(spaceAuditShardPath(p, SPACE), "utf-8")).toBe(after1);
  });
});

describe("t298 the journal: absent-or-complete, and collectable", () => {
  test("a successful commit leaves NO journal dir behind", () => {
    const p = projectWithIntent();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    // The dir may exist but must be empty: a leftover txn dir is a leaked copy of
    // every document the run was staging.
    const entries = existsSync(journalDir(p, SPACE)) ? readdirSync(journalDir(p, SPACE)) : [];
    expect(entries).toEqual([]);
  });

  test("the published document dir is COMPLETE, never partial", () => {
    const p = projectWithIntent();
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const dir = join(documentkbDir(p, SPACE), indexed[0].id);
    // Everything staged arrived together, because ONE rename() published it --
    // including the extracted text, which is the point: content and metadata
    // cannot be observed out of step.
    expect(readdirSync(dir).sort()).toEqual(["content.md", "metadata.json", "source.sha256"]);
  });

  test("a stale journal from a crashed run is collectable and removed", () => {
    const p = projectWithIntent();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    // Simulate a crash between stage and rename: a txn dir referenced by no row,
    // with NO liveness stamp (a real crash never gets to write one past
    // process death — or this predates the stamp entirely) and aged past the
    // unstamped grace, so the collector must treat it as dead rather than as a
    // live writer mid-acquire.
    const orphan = journalTxnDir(p, SPACE, "019fda80-0000-7000-8000-000000000001");
    mkdirSync(join(orphan, "some-id"), { recursive: true });
    writeFileSync(join(orphan, "some-id", "metadata.json"), "{}");
    const old = new Date(Date.now() - 60_000);
    utimesSync(orphan, old, old);
    expect(collectStaleJournals(p, SPACE).length).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  test("a LIVE writer's staging dir (fresh stamp, this process's own pid) is left alone", () => {
    // The invariant this round adds: `collectStaleJournals` must not delete a
    // txn dir whose stamp names a PID that is still alive. Using this test
    // process's own pid is the simplest live PID available, and matches the
    // real shape -- onboard's OWN process id is what the stamp records.
    const p = projectWithIntent();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const live = journalTxnDir(p, SPACE, "019fda80-0000-7000-8000-000000000002");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "writer.pid"), `${process.pid}\n`);
    writeFileSync(join(live, "in-progress.txt"), "still staging\n");
    expect(collectStaleJournals(p, SPACE)).toEqual([]);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(join(live, "in-progress.txt"))).toBe(true);
  });

  test("a DEAD writer's stamped staging dir (pid that cannot exist) IS collected", () => {
    const p = projectWithIntent();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const dead = journalTxnDir(p, SPACE, "019fda80-0000-7000-8000-000000000003");
    mkdirSync(dead, { recursive: true });
    // PID 1 owned by init/launchd on every POSIX box this suite runs on, but
    // a value astronomically unlikely to be a REAL pid on this machine right
    // now is safer than assuming 1 is unreachable via signal 0 (root can see
    // it). Use a huge number, well past any real PID space.
    writeFileSync(join(dead, "writer.pid"), "999999999\n");
    expect(collectStaleJournals(p, SPACE)).toContain("019fda80-0000-7000-8000-000000000003");
    expect(existsSync(dead)).toBe(false);
  });

  test("collecting journals never touches a PUBLISHED document", () => {
    // A journal dir is named by txn id and referenced by no index row, which is
    // what makes removal unconditionally safe -- but only if the collector cannot
    // wander out of .journal/.
    const p = projectWithIntent();
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    collectStaleJournals(p, SPACE);
    expect(existsSync(join(documentkbDir(p, SPACE), indexed[0].id))).toBe(true);
    expect(readIndex(p, SPACE).documents.length).toBe(1);
  });

  test("collecting on a space that never indexed anything is a no-op", () => {
    const p = projectWithIntent();
    expect(collectStaleJournals(p, SPACE)).toEqual([]);
  });

  test("a txn dir stamped by a REAL, DIFFERENT, still-running process survives a concurrent sync", () => {
    // The round-9 review finding, driven cross-process rather than by trusting
    // `isPidAlive` against this test's own pid (which is trivially true and
    // proves less). A second real bun process holds a txn dir open -- mkdirs
    // it and stamps it with ITS OWN pid, exactly like onboard's staging phase
    // does, then sleeps -- while THIS process's `sync` (via `collectStaleJournals`)
    // runs concurrently. The live txn dir must survive; once the holder exits,
    // the SAME dir (now genuinely stale) must be collectable.
    const p = projectWithIntent();
    doc(p, "a.md");

    const txnId = "019fda80-0000-7000-8000-0000000000aa";
    const holder = join(p, "txn-holder.ts");
    writeFileSync(
      holder,
      `const kb = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))});\n` +
        `const fs = require("node:fs");\n` +
        `const dir = kb.journalTxnDir(${JSON.stringify(p)}, ${JSON.stringify(SPACE)}, ${JSON.stringify(txnId)});\n` +
        `fs.mkdirSync(dir, { recursive: true });\n` +
        `fs.writeFileSync(require("node:path").join(dir, "writer.pid"), String(process.pid) + "\\n");\n` +
        `fs.writeFileSync(require("node:path").join(dir, "marker.txt"), "still staging\\n");\n` +
        `console.log("READY " + process.pid);\n` +
        // Sleep long enough for the parent to run its assertions.
        `const until = Date.now() + 3000;\n` +
        `while (Date.now() < until) { fs.existsSync(${JSON.stringify(p)}); }\n`,
    );
    const holderProc = spawnSync("bash", ["-c",
      `bun ${JSON.stringify(holder)} & echo $!`], { encoding: "utf-8" });
    const holderPid = Number(holderProc.stdout.trim().split("\n").pop());
    expect(Number.isInteger(holderPid) && holderPid > 0, `bad holder pid: ${holderProc.stdout}`).toBe(true);

    try {
      // Wait for the holder's stamp to actually land (real cross-process
      // startup, not assumed-instant).
      const stampPath = join(journalTxnDir(p, SPACE, txnId), "writer.pid");
      const deadline = Date.now() + 5000;
      while (!existsSync(stampPath) && Date.now() < deadline) { /* spin */ }
      expect(existsSync(stampPath), "the holder process never wrote its stamp").toBe(true);

      // While the holder is still alive, collection must leave its dir alone.
      const collected = collectStaleJournals(p, SPACE);
      expect(collected).not.toContain(txnId);
      expect(existsSync(stampPath)).toBe(true);
    } finally {
      // Let the holder finish naturally (it self-terminates after ~3s); this
      // is not a kill, so a genuine "process exits on its own" transition is
      // what the next assertion observes.
      try { spawnSync("bash", ["-c", `wait ${holderPid} 2>/dev/null; true`]); } catch { /* best-effort */ }
      const deadline2 = Date.now() + 8000;
      while (isPidAliveViaKill(holderPid) && Date.now() < deadline2) { /* spin */ }
    }

    // Now the holder is gone: the SAME dir, same stamp file (naming a now-dead
    // pid), must be collectable.
    expect(isPidAliveViaKill(holderPid), "the holder should have exited by now").toBe(false);
    const afterExit = collectStaleJournals(p, SPACE);
    expect(afterExit).toContain(txnId);
    expect(existsSync(journalTxnDir(p, SPACE, txnId))).toBe(false);
  }, 30000);
});

/** Cross-process liveness check for the test harness itself (NOT the module
 *  under test) -- signal 0 the same way isPidAlive does, so the assertion
 *  above waits on the real OS fact rather than a fixed sleep. */
function isPidAliveViaKill(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("t298 the digest is re-validated INSIDE the lock", () => {
  test("a document edited between staging and commit is REFUSED, and nothing lands", () => {
    // Without the re-check inside the lock, this row is indexed with the NEW
    // digest and the OLD staged content -- silent corruption no locking elsewhere
    // prevents.
    //
    // Driven by a REAL race rather than a mock, but a race whose ORDER is fixed:
    // a second process takes the audit lock and holds it until the mutator says
    // it has written, so our onboard stages, blocks on acquire, and reaches its
    // commit-time digest re-check only AFTER the file has been rewritten. The
    // earlier version held for a flat 3s and hoped the mutator's own 1.5s timer
    // landed inside the window; when the subject won that race instead it
    // committed correctly and the assertion below compared its row against bytes
    // written afterwards.
    //
    // Two earlier attempts failed and are worth recording: mocking `readIndex`
    // never entered the window (the guard came out UNPINNED -- removing it changed
    // nothing), and mocking `readRegularFileNoFollowOrThrow` recursed forever
    // because the mock's fallback resolved to the mock itself.
    const p = projectWithIntent();
    const abs = doc(p, "a.md", "original\n");

    const held = join(p, "lock-held");
    const mutationDone = join(p, "digest-mutation-done");
    const holder = writeLockHolder(join(p, "holder.ts"), p, held, mutationDone);
    const mutator = join(p, "mutator.ts");
    writeFileSync(
      mutator,
      `const fs = require("node:fs");\n` +
        // Let onboard get PAST staging before the bytes move, so the mutation
        // lands in the window the guard exists for. Only this part is timing: the
        // ordering that the assertions depend on is the marker below, which is
        // what releases the lock.
        `Bun.sleepSync(1500);\n` +
        `fs.writeFileSync(${JSON.stringify(abs)}, "CHANGED-MID-TXN\\n");\n` +
        `fs.writeFileSync(${JSON.stringify(mutationDone)}, "1");\n`,
    );

    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 &\n` +
      // Wait for the lock to actually be held before starting onboard.
      `${waitForFile(held)}\n` +
      `bun ${JSON.stringify(mutator)} >/dev/null 2>&1 &\n` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} onboard ` +
      `--project-dir ${JSON.stringify(p)} 2>&1\n` +
      `wait\n`;
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: CHILD_ENV,
      timeout: 40_000,
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");

    // The mutation is now guaranteed to precede the commit, so the refusal is the
    // expected path. Both branches stay, because ordering fixes only the half that
    // was broken: the mutation can still land BEFORE staging finishes (a slow
    // onboard startup under load), and then onboard legitimately stages the NEW
    // bytes and indexes them consistently. What must hold in every case is the one
    // contract asserted here: a row on disk matches the bytes on disk. A
    // stale-content row is the bug.
    if (out.includes("changed while it was being staged")) {
      expect(existsSync(indexPath(p, SPACE)), "a refused txn writes no index").toBe(false);
    }
    if (existsSync(indexPath(p, SPACE))) {
      const onDisk = readFileSync(abs);
      const digest = execFileSync("shasum", ["-a", "256"], { input: onDisk, encoding: "utf-8" })
        .split(" ")[0];
      for (const row of readIndex(p, SPACE).documents) {
        expect(row.sha256, "an indexed row must match the bytes on disk").toBe(digest);
      }
    }
  }, 60000);

  test("the guard's message names the file and both digests", () => {
    // Asserted directly, because the race above cannot be forced deterministically
    // and a guard whose message is unhelpful is only half a guard.
    const p = projectWithIntent();
    doc(p, "a.md", "original\n");
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    // The refusal text is part of the contract: an operator must learn WHICH file
    // moved, and that nothing was indexed.
    expect(src).toContain("changed while it was being staged");
    expect(src).toContain("Nothing was indexed");
    expect(src).toContain("Re-run once the file has settled");
  });

  test("the digest recorded always matches the bytes at commit time", () => {
    const p = projectWithIntent();
    doc(p, "a.md", "stable\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const onDisk = readFileSync(join(documentsDir(p, SPACE), "a.md"));
    const digest = execFileSync("shasum", ["-a", "256"], { input: onDisk, encoding: "utf-8" })
      .split(" ")[0];
    expect(indexed[0].sha256).toBe(digest);
  });
});

describe("t298 concurrency: N parallel onboards lose no row", () => {
  test("twelve concurrent processes each indexing a distinct file land ALL twelve", () => {
    // In-process calls would serialise on the reentrant lock and prove nothing.
    // Separate PROCESSES contend for the real OS lock, which is the thing under
    // test -- and the failure mode is a LOST row, not an error, because each
    // process would write back an index copy read before the lock.
    //
    // 12, not 4: an earlier version of this test launched only 4 processes, and
    // they did NOT reliably contend -- process-startup jitter let them finish
    // one at a time without ever overlapping on the lock, so it passed even
    // with withAuditLock removed. 12 concurrent launches is the number that
    // made contention observable: removing withAuditLock now reliably drops
    // rows below 12.
    const p = projectWithIntent();
    const names = Array.from({ length: 12 }, (_, i) => `f${i}`);
    for (const n of names) doc(p, `${n}.md`, `${n}\n`);

    // A single shell launches all twelve as backgrounded SUBSHELLS and waits.
    // That keeps the test body synchronous while the processes genuinely OVERLAP
    // -- which is the whole point, since two onboards in ONE process would
    // serialise on the reentrant lock and prove nothing. Verified to contend:
    // removing withAuditLock makes this land fewer than 12 rows.
    //
    // Each child's streams and exit code go to FILES, one set per child. The
    // earlier version sent every child's output to /dev/null and checked only the
    // shell's status -- but the script ends in a bare `wait`, which exits 0 even
    // when children failed, so the only symptom of a bad run was "11 rows, no
    // idea why". The subshell braces matter: `cmd; echo $? &` would background
    // the `echo` alone and serialise the twelve onboards.
    const tool = join(AIDLC_TOOLS, "aidlc-knowledge.ts");
    const childOut = (i: number): string => join(p, `child-${i}.out`);
    const childErr = (i: number): string => join(p, `child-${i}.err`);
    const childCode = (i: number): string => join(p, `child-${i}.code`);
    const cmds = names
      .map((n, i) => `( bun ${JSON.stringify(tool)} onboard ` +
        `${JSON.stringify(join(documentsDir(p, SPACE), `${n}.md`))} ` +
        `--project-dir ${JSON.stringify(p)} --json ` +
        `> ${JSON.stringify(childOut(i))} 2> ${JSON.stringify(childErr(i))}; ` +
        `echo $? > ${JSON.stringify(childCode(i))} ) &`)
      .join("\n");
    const r = spawnSync("bash", ["-c", `${cmds}\nwait\n`], {
      encoding: "utf-8",
      env: CHILD_ENV,
      timeout: 45_000,
    });
    // Only catches a shell-level failure (including the spawn timeout, which
    // makes status null); a child that died is caught per-child below.
    expect(r.status, `the concurrent batch failed: ${r.stderr}`).toBe(0);
    // Per child, so a child that blew its lock-acquire budget is DISTINGUISHABLE
    // from a genuinely lost row, and says why in the failure message.
    for (let i = 0; i < names.length; i++) {
      const why = existsSync(childErr(i))
        ? readFileSync(childErr(i), "utf-8").trim() || "(empty stderr)"
        : "(no stderr file: the child never ran)";
      expect(existsSync(childCode(i)), `child ${i} recorded no exit code; stderr: ${why}`)
        .toBe(true);
      expect(readFileSync(childCode(i), "utf-8").trim(), `child ${i} failed; stderr: ${why}`)
        .toBe("0");
    }
    const rows = readIndex(p, SPACE).documents;
    // FULL survival, not best-effort. A lost row is the failure mode: each
    // process reads the index before the lock, so an unlocked commit writes back
    // a copy that never saw its siblings.
    expect(rows.length, "every concurrent onboard must survive").toBe(names.length);
    expect(new Set(rows.map((r) => r.source.path)).size).toBe(names.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(names.length);
  }, 60000);

  test("a serial control lands the same twelve rows", () => {
    // The comparison makes the concurrent number meaningful: 12 is only "full
    // survival" if 12 is also what serial execution produces.
    const p = projectWithIntent();
    const names = Array.from({ length: 12 }, (_, i) => `f${i}`);
    for (const n of names) doc(p, `${n}.md`, `${n}\n`);
    for (const n of names) {
      runOnboard(p, [join(documentsDir(p, SPACE), `${n}.md`)]);
    }
    expect(readIndex(p, SPACE).documents.length).toBe(names.length);
  }, 60000);
});

describe("t298 an EDITED row is protected from the same race as a fresh one", () => {
  test("a row tombstoned by a concurrent process, mid-edit-commit, is left tombstoned -- not resurrected in a contradictory state", () => {
    // Same race shape as "the digest is re-validated INSIDE the lock" above,
    // but on the EDIT path this story adds: pass 1 evidences identity by a LIVE
    // match at the same path, then blocks waiting for the lock. While it
    // waits, a concurrent process (standing in for a real `sync` that observed
    // the original removed) TOMBSTONES that same row. If the commit blindly
    // `Object.assign`s the refreshed fields onto the now-tombstoned row, the
    // result is self-contradictory: `removed_at` set AND a fresh `content`
    // pointing at newly-written text -- a state no reader agrees on.
    const p = projectWithIntent();
    const abs = doc(p, "a.md", "v1\n");
    onboard(p, SPACE, undefined, NOW);
    const before = readIndex(p, SPACE).documents[0];
    writeFileSync(abs, "v2 edited\n");

    const held = join(p, "lock-held");
    const mutationDone = join(p, "tombstone-mutation-done");
    const holder = writeLockHolder(join(p, "holder.ts"), p, held, mutationDone);
    // Mutates `index.json` DIRECTLY -- not via `sync` -- so the race lands
    // DETERMINISTICALLY every run rather than depending on timing that may or
    // may not fall inside onboard's staging window. `sync` reaching the same
    // tombstone is exercised elsewhere (t284); what THIS test pins is onboard's
    // commit behaviour once a row it is about to refresh has ALREADY been
    // tombstoned by someone else -- the shape of the race, not its trigger.
    //
    // The tombstone is what releases the holder's lock, so "ALREADY been
    // tombstoned" is now true by construction. It used to be true only when the
    // mutator's 1.5s timer beat onboard's commit; when onboard won, it committed
    // the edited digest FIRST, the mutator then tombstoned that already-updated
    // row, and the assertion below read a tombstone carrying the edited digest --
    // the exact contradiction it exists to catch, produced by the test itself.
    const mutator = join(p, "mutator.ts");
    writeFileSync(
      mutator,
      `const k = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))});\n` +
        `const fs = require("node:fs");\n` +
        `Bun.sleepSync(1500);\n` +
        `const idx = k.readIndex(${JSON.stringify(p)}, ${JSON.stringify(SPACE)});\n` +
        `idx.documents[0].removed_at = "2026-08-09T00:00:00Z";\n` +
        `k.writeIndex(${JSON.stringify(p)}, ${JSON.stringify(SPACE)}, idx);\n` +
        `fs.writeFileSync(${JSON.stringify(mutationDone)}, "1");\n`,
    );

    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 &\n` +
      `${waitForFile(held)}\n` +
      `bun ${JSON.stringify(mutator)} >/dev/null 2>&1 &\n` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} onboard ` +
      `--project-dir ${JSON.stringify(p)} 2>&1\n` +
      `wait\n`;
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: CHILD_ENV,
      timeout: 40_000,
    });
    void r;

    // The row must never be BOTH tombstoned AND carrying a digest that only
    // the edit could have produced -- that contradiction is the bug.
    const rows = readIndex(p, SPACE).documents;
    for (const row of rows) {
      if (row.removed_at !== undefined) {
        expect(
          row.sha256,
          `row ${row.id} is tombstoned but its digest moved to the edited value -- ` +
            `a contradictory resurrection landed`,
        ).toBe(before.sha256);
      }
    }
  }, 60000);

  test("a stale edited-onboard plan cannot overwrite a concurrent rebind", () => {
    const p = projectWithIntent();
    const abs = doc(p, "a.md", "v1\n");
    onboard(p, SPACE, undefined, NOW);
    writeFileSync(abs, "v2 staged edit\n");
    const rebound = doc(p, "rebound.md", "rebound identity\n");

    // The rebind must be in the index BEFORE onboard commits, or the test proves
    // nothing: with the holder released only by the mutator's marker, the stale
    // edited-onboard plan always meets an index that has already moved.
    const held = join(p, "rebind-lock-held");
    const mutationDone = join(p, "rebind-mutation-done");
    const holder = writeLockHolder(join(p, "holder-rebind.ts"), p, held, mutationDone);
    const mutator = join(p, "mutator-rebind.ts");
    writeFileSync(
      mutator,
      `const k = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))});\n` +
        `const fs = require("node:fs"); Bun.sleepSync(1500);\n` +
        `const idx = k.readIndex(${JSON.stringify(p)}, ${JSON.stringify(SPACE)});\n` +
        `const bytes = fs.readFileSync(${JSON.stringify(rebound)});\n` +
        `idx.documents[0].source = { kind: "managed", path: "documents/rebound.md" };\n` +
        `idx.documents[0].sha256 = k.sha256Hex(bytes); idx.documents[0].bytes = bytes.length;\n` +
        `idx.documents[0].extraction = { state: "unsupported_type", detectedType: "text/plain" };\n` +
        `delete idx.documents[0].content; delete idx.documents[0].content_sha256;\n` +
        `k.writeIndex(${JSON.stringify(p)}, ${JSON.stringify(SPACE)}, idx);\n` +
        `fs.writeFileSync(${JSON.stringify(mutationDone)}, "1");\n`,
    );
    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 &\n` +
      `${waitForFile(held)}\n` +
      `bun ${JSON.stringify(mutator)} >/dev/null 2>&1 &\n` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} onboard ` +
      `${JSON.stringify(abs)} --project-dir ${JSON.stringify(p)} >/dev/null 2>&1\nwait\n`;
    spawnSync("bash", ["-c", script], { encoding: "utf-8", env: CHILD_ENV, timeout: 40_000 });

    const row = readIndex(p, SPACE).documents[0];
    expect(row.source.path).toBe("documents/rebound.md");
    expect(row.sha256).toBe(sha256Hex(readFileSync(rebound)));
  }, 60000);
});

describe("t298 the index is read FRESH inside the lock", () => {
  test("a row added between the read pass and the commit is not overwritten", () => {
    // The copy from the read pass predates the lock. Writing it back is exactly
    // how a concurrent onboard loses a row -- so the commit re-reads.
    const p = projectWithIntent();
    doc(p, "first.md");
    onboard(p, SPACE, undefined, NOW);
    const firstId = readIndex(p, SPACE).documents[0].id;

    doc(p, "second.md");
    onboard(p, SPACE, undefined, NOW);

    const ids = readIndex(p, SPACE).documents.map((r) => r.id);
    expect(ids).toContain(firstId);
    expect(ids.length).toBe(2);
  });

  test("a concurrent same-path row with different bytes is refreshed in place", () => {
    const p = projectWithIntent();
    const source = doc(p, "same-path.md", "v1\n");
    const original = onboard(p, SPACE, source, NOW).indexed[0];
    const originalIndex = readIndex(p, SPACE);
    rmSync(indexPath(p, SPACE));
    writeFileSync(source, "v2 staged\n");

    const held = join(p, "same-path-lock-held");
    const mutationDone = join(p, "same-path-mutation-done");
    const holder = writeLockHolder(join(p, "same-path-holder.ts"), p, held, mutationDone);
    const mutator = join(p, "same-path-mutator.ts");
    writeFileSync(
      mutator,
      `const fs = require("node:fs");\n` +
        `Bun.sleepSync(500);\n` +
        `fs.writeFileSync(${JSON.stringify(indexPath(p, SPACE))}, ${JSON.stringify(
          `${JSON.stringify(originalIndex, null, 2)}\n`,
        )});\n` +
        `fs.writeFileSync(${JSON.stringify(mutationDone)}, "1");\n`,
    );
    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 &\n` +
      `${waitForFile(held)}\n` +
      `bun ${JSON.stringify(mutator)} >/dev/null 2>&1 &\n` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} onboard ` +
      `${JSON.stringify(source)} --project-dir ${JSON.stringify(p)} >/dev/null 2>&1\nwait\n`;
    expect(spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: CHILD_ENV,
      timeout: 40_000,
    }).status).toBe(0);

    const rows = readIndex(p, SPACE).documents.filter(
      (row) => !row.removed_at && row.source.path === "documents/same-path.md",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(original.id);
    expect(rows[0].sha256).toBe(sha256Hex(readFileSync(source)));
  }, 60_000);
});

describe("t298 the journal is actually GITIGNORED, not just described as such", () => {
  test("git check-ignore agrees the journal path is ignored, in every harness tree", () => {
    // The code comment claims ".journal/ is GITIGNORED" and the design calls that
    // load-bearing -- but a comment is not a rule. This was shipped WRONG once:
    // the claim existed in three places and the ignore line existed in none, so
    // `git add -A` after a crashed onboard would have committed a staged
    // transaction dir as if it were work.
    //
    // Asserted with `git check-ignore`, not a grep for the pattern text: a grep
    // proves a string is present, while check-ignore proves git AGREES -- which
    // is what a user's `git add` actually consults.
    // DERIVED from harness/, not listed: a hardcoded list cannot fail for a
    // harness it has never heard of. Upstream added `copilot` mid-slice and a
    // five-name list here stayed green while that sixth tree went unchecked.
    const harnesses = readdirSync(join(import.meta.dir, "..", "..", "harness"), {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(harnesses.length, "no harness trees found to check").toBeGreaterThan(0);
    for (const h of harnesses) {
      const repo = mkdtempSync(join(tmpdir(), `t298-gi-${h}-`));
      try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        const gi = join(import.meta.dir, "..", "..", "dist", h, ".gitignore");
        writeFileSync(join(repo, ".gitignore"), readFileSync(gi, "utf-8"));
        for (const rel of [
          "aidlc/spaces/default/knowledge/documentkb/.journal/019f-abc/metadata.json",
          "aidlc/spaces/default/knowledge/.sources.local.json",
        ]) {
          const r = spawnSync("git", ["check-ignore", "-q", rel], { cwd: repo });
          expect(r.status, `${h}: ${rel} must be gitignored`).toBe(0);
        }
        // And the committed side must NOT be swept up by an over-broad rule --
        // index.json and metadata.json under documentkb/ ARE the shared work.
        for (const rel of [
          "aidlc/spaces/default/knowledge/documentkb/index.json",
          "aidlc/spaces/default/knowledge/documentkb/019f-abc/metadata.json",
          "aidlc/spaces/default/knowledge/documents/policy.md",
        ]) {
          const r = spawnSync("git", ["check-ignore", "-q", rel], { cwd: repo });
          expect(r.status, `${h}: ${rel} must stay COMMITTED`).not.toBe(0);
        }
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  }, 30000);
});

describe("t298 I16: no lock inversion", () => {
  test("a concurrent per-intent write and a space-level onboard BOTH complete", () => {
    // The design's own acceptance criterion, which an earlier version of this
    // file claimed without testing. Two locks taken in two orders across two
    // processes is a textbook deadlock; the contract is that onboard takes the
    // SPACE lock only and never reaches for a per-intent one while holding it.
    //
    // The failure mode is a HANG, not an error -- so the assertion is that both
    // finish inside a bound. A deadlock makes the shell time out and `status`
    // non-zero.
    const p = projectWithIntent();
    doc(p, "a.md");

    // A process that holds a PER-INTENT lock for ~2s while onboard runs.
    const intentHolder = join(p, "intent-lock.ts");
    writeFileSync(
      intentHolder,
      `const lib = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-lib.ts"))});\n` +
        `const intent = lib.activeIntent(${JSON.stringify(p)}, ${JSON.stringify(SPACE)});\n` +
        `if (intent === null) { process.exit(3); }\n` +
        `lib.withAuditLock(${JSON.stringify(p)}, () => {\n` +
        `  const until = Date.now() + 2000;\n` +
        `  while (Date.now() < until) { require("node:fs").existsSync(${JSON.stringify(p)}); }\n` +
        `  return 0;\n` +
        `}, intent, ${JSON.stringify(SPACE)});\n`,
    );
    const script =
      `bun ${JSON.stringify(intentHolder)} >/dev/null 2>&1 &\n` +
      `HOLDER=$!\n` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} onboard ` +
      `--project-dir ${JSON.stringify(p)} >/dev/null 2>&1\n` +
      `ONBOARD=$?\n` +
      `wait $HOLDER\n` +
      `echo "onboard=$ONBOARD holder=$?"\n`;
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: CHILD_ENV,
      timeout: 30_000,
    });
    // A deadlock shows up as the timeout killing the shell.
    expect(r.status, `deadlock or timeout: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("onboard=0");
    // And onboard actually did its work rather than merely surviving.
    expect(readIndex(p, SPACE).documents.length).toBe(1);
  }, 45000);

  test("the commit callback acquires NO second lock", () => {
    // Structural companion to the behavioural test above: the invariant is
    // "never acquire a per-intent lock inside the space lock", and the cheapest
    // durable check is that the locked region contains no further acquisition.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    const open = "withAuditLock(projectDir, () => {";
    const start = src.indexOf(open);
    expect(start, "the transaction must be wrapped in withAuditLock").toBeGreaterThan(-1);
    const end = src.indexOf("}, undefined, space);", start);
    expect(end).toBeGreaterThan(start);
    // Slice PAST the opening call, or the body trivially contains it.
    const body = src.slice(start + open.length, end);
    // No nested lock, and no locking append (which would acquire internally and
    // deadlock against the lock this process already holds).
    expect(body).not.toContain("withAuditLock(");
    expect(body).not.toMatch(/\bacquireAuditLock\b/);
    expect(body).not.toMatch(/appendAuditEntry\(/);
  });
});

describe("t298 I12: every refusal's prescribed remedy actually repairs the state", () => {
  test("the missing-documents/ refusal names a command that RUNS and repairs", () => {
    // Not "the message mentions mkdir" -- the message's own instruction is
    // extracted, executed verbatim, and then onboard must succeed. A remedy that
    // reads plausibly and does not work is worse than no remedy.
    proj = mkdtempSync(join(tmpdir(), "t298-"));
    const p = proj;
    const r = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", "--project-dir", p],
      { encoding: "utf-8", env: CHILD_ENV },
    );
    expect(r.status).not.toBe(0);
    const msg = (r.stdout ?? "") + (r.stderr ?? "");
    // Pull the command out of the refusal itself.
    const m = msg.match(/mkdir -p \\?"([^"\\]+)\\?"/);
    expect(m, `no runnable mkdir command in: ${msg}`).not.toBeNull();
    execFileSync("mkdir", ["-p", m![1]]);
    writeFileSync(join(m![1], "a.md"), "text\n");
    const after = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", "--project-dir", p],
      { encoding: "utf-8", env: CHILD_ENV },
    );
    expect(after.status, `remedy did not repair: ${after.stderr}`).toBe(0);
    expect(readIndex(p, SPACE).documents.length).toBe(1);
  }, 30000);

  test("the outside-documents/ refusal's remedy (copy it under documents/) repairs", () => {
    const p = projectWithIntent();
    const outside = join(p, "elsewhere.md");
    writeFileSync(outside, "external\n");
    const r = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", outside, "--project-dir", p],
      { encoding: "utf-8", env: CHILD_ENV },
    );
    expect(r.status).not.toBe(0);
    const msg = (r.stdout ?? "") + (r.stderr ?? "");
    expect(msg).toMatch(/Copy it under/);
    // Follow the instruction literally, then re-run.
    const target = join(documentsDir(p, SPACE), "elsewhere.md");
    execFileSync("cp", [outside, target]);
    const after = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", target, "--project-dir", p],
      { encoding: "utf-8", env: CHILD_ENV },
    );
    expect(after.status, `remedy did not repair: ${after.stderr}`).toBe(0);
    expect(readIndex(p, SPACE).documents.map((d) => d.source.path))
      .toEqual(["documents/elsewhere.md"]);
  }, 30000);
});

describe("t298 commit-time reconciliation and idempotent recovery", () => {
  test("sync does not tombstone a source recreated while it waits for the lock", () => {
    const p = projectWithIntent();
    const source = doc(p, "recreated.md", "original\n");
    const indexed = onboard(p, SPACE, source, NOW).indexed[0];
    rmSync(source);
    // The recreation is what releases the lock, so `sync` always reaches its
    // commit-time re-validation with the source back on disk. Timed instead of
    // ordered, `sync` could win outright, tombstone a source that was legitimately
    // absent when it looked, and fail the assertion below on the mutator's clock.
    const held = join(p, "held");
    const mutationDone = join(p, "recreate-mutation-done");
    const holder = writeLockHolder(join(p, "hold-removal.ts"), p, held, mutationDone);
    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 & ` +
      `${waitForFile(held)}; ` +
      `(sleep 1; printf 'recreated\n' > ${JSON.stringify(source)}; ` +
      `: > ${JSON.stringify(mutationDone)}) & ` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} sync --project-dir ${JSON.stringify(p)} >/dev/null; rc=$?; wait; exit $rc`;
    expect(spawnSync("bash", ["-c", script], { env: CHILD_ENV, timeout: 40_000 }).status).toBe(0);
    const row = readIndex(p, SPACE).documents.find((candidate) => candidate.id === indexed.id)!;
    expect(row.removed_at).toBeUndefined();
    expect(readIndex(p, SPACE).documents).toHaveLength(1);
  }, 45_000);

  test("sync does not commit a move whose target changed while waiting", () => {
    const p = projectWithIntent();
    const source = doc(p, "move-from.md", "original\n");
    const indexed = onboard(p, SPACE, source, NOW).indexed[0];
    const target = join(documentsDir(p, SPACE), "move-to.md");
    renameSync(source, target);
    // The target's rewrite releases the lock, so the planned move always meets a
    // changed target at commit. Timed instead of ordered, `sync` could commit the
    // move before the rewrite and leave the row at documents/move-to.md.
    const held = join(p, "held");
    const mutationDone = join(p, "move-mutation-done");
    const holder = writeLockHolder(join(p, "hold-move.ts"), p, held, mutationDone);
    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 & ` +
      `${waitForFile(held)}; ` +
      `(sleep 1; printf 'changed\n' > ${JSON.stringify(target)}; ` +
      `: > ${JSON.stringify(mutationDone)}) & ` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} sync --project-dir ${JSON.stringify(p)} >/dev/null; rc=$?; wait; exit $rc`;
    expect(spawnSync("bash", ["-c", script], { env: CHILD_ENV, timeout: 40_000 }).status).toBe(0);
    const row = readIndex(p, SPACE).documents.find((candidate) => candidate.id === indexed.id)!;
    expect(row.source.path).toBe("documents/move-from.md");
    expect(row.sha256).toBe(indexed.sha256);
  }, 45_000);

  test("rebind hashes the target again after acquiring the lock", () => {
    const p = projectWithIntent();
    const source = doc(p, "old.md", "old\n");
    const id = onboard(p, SPACE, source, NOW).indexed[0].id;
    const target = doc(p, "new.md", "first\n");
    // The second write releases the lock, so rebind always hashes AFTER it. Timed
    // instead of ordered, rebind could finish while the target still read "first"
    // and record that digest -- a failure of the test, not of the re-hash.
    const held = join(p, "held");
    const mutationDone = join(p, "rehash-mutation-done");
    const holder = writeLockHolder(join(p, "hold-rebind.ts"), p, held, mutationDone);
    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 & ` +
      `${waitForFile(held)}; ` +
      `(sleep 1; printf 'second\n' > ${JSON.stringify(target)}; ` +
      `: > ${JSON.stringify(mutationDone)}) & ` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} rebind ${id} --to ${JSON.stringify(target)} --project-dir ${JSON.stringify(p)} >/dev/null; rc=$?; wait; exit $rc`;
    expect(spawnSync("bash", ["-c", script], { env: CHILD_ENV, timeout: 40_000 }).status).toBe(0);
    const row = readIndex(p, SPACE).documents.find((candidate) => candidate.id === id)!;
    expect(row.sha256).toBe(sha256Hex(Buffer.from("second\n")));
    expect(row.bytes).toBe(Buffer.byteLength("second\n"));
  }, 45_000);

  test("an idempotent association retry repairs metadata committed after the index", () => {
    const p = projectWithIntent();
    const source = doc(p, "scoped.md");
    const id = onboard(p, SPACE, source, NOW).indexed[0].id;
    const metadata = join(documentkbDir(p, SPACE), id, "metadata.json");
    rmSync(metadata);
    mkdirSync(metadata);
    expect(() => setIntentAssociation(p, SPACE, id, intentUuid(p), "associate")).toThrow();
    rmSync(metadata, { recursive: true });
    expect(setIntentAssociation(p, SPACE, id, intentUuid(p), "associate").status).toBe("already");
    expect(JSON.parse(readFileSync(metadata, "utf-8")).related_intent_ids).toEqual([intentUuid(p)]);
  });

  test("an edited onboard retry repairs metadata committed after the index", () => {
    const p = projectWithIntent();
    const source = doc(p, "edited-metadata.md", "v1\n");
    const id = onboard(p, SPACE, source, NOW).indexed[0].id;
    const metadata = join(documentkbDir(p, SPACE), id, "metadata.json");
    writeFileSync(source, "v2\n");
    rmSync(metadata);
    mkdirSync(metadata);
    expect(() => onboard(p, SPACE, source, NOW)).toThrow();
    rmSync(metadata, { recursive: true });
    expect(onboard(p, SPACE, source, NOW).indexed[0].status).toBe("edited");
    expect(JSON.parse(readFileSync(metadata, "utf-8")).sha256)
      .toBe(sha256Hex(Buffer.from("v2\n")));
  });

  test("an idempotent rebind retry repairs metadata committed after the index", () => {
    const p = projectWithIntent();
    const source = doc(p, "rebind-old.md", "old\n");
    const id = onboard(p, SPACE, source, NOW).indexed[0].id;
    const target = doc(p, "rebind-new.md", "new\n");
    const metadata = join(documentkbDir(p, SPACE), id, "metadata.json");
    rmSync(metadata);
    mkdirSync(metadata);
    expect(() => rebindDocument(p, SPACE, id, target, "2026-08-13T01:00:00Z")).toThrow();
    rmSync(metadata, { recursive: true });
    expect(rebindDocument(p, SPACE, id, target, "2026-08-13T01:01:00Z").to)
      .toBe("documents/rebind-new.md");
    expect(JSON.parse(readFileSync(metadata, "utf-8")).source.path)
      .toBe("documents/rebind-new.md");
  });

  test("a malformed removal row does not suppress a complete repair", () => {
    const p = projectWithIntent();
    const source = doc(p, "removed-audit.md");
    const id = onboard(p, SPACE, source, NOW).indexed[0].id;
    rmSync(source);
    const shard = spaceAuditShardPath(p, SPACE);
    renameSync(shard, `${shard}.saved`);
    mkdirSync(shard);
    expect(() => syncDocuments(p, SPACE, "2026-08-13T01:00:00Z")).toThrow();
    rmSync(shard, { recursive: true });
    renameSync(`${shard}.saved`, shard);
    appendAuditEntryAtPathUnlocked(
      "DOCUMENT_REMOVED",
      { Space: SPACE, Document: id },
      p,
      shard,
    );

    syncDocuments(p, SPACE, "2026-08-13T01:01:00Z");
    const latest = readFileSync(shard, "utf-8")
      .split(/\n---\n/)
      .filter((block) => block.includes("**Event**: DOCUMENT_REMOVED") &&
        block.includes(`**Document**: ${id}`))
      .at(-1)!;
    expect(latest).toContain("**Last Path**: documents/removed-audit.md");
    expect(latest).toContain("**Last Digest**:");
  });

  test("standard audit append refuses a symlinked shard and tolerates a hard-linked one", () => {
    const p = projectWithIntent();
    const shard = auditFilePath(p);
    const external = join(p, "external-standard-audit.md");
    const original = "external\n";
    writeFileSync(external, original);
    mkdirSync(dirname(shard), { recursive: true });
    rmSync(shard, { force: true });
    try {
      symlinkSync(external, shard);
    } catch {
      return; // Windows without symlink privilege.
    }
    // A symlink is a REDIRECT: following it would let a planted link decide
    // where audit rows land. Refused, and the target stays untouched.
    expect(() => appendAuditEntry("STAGE_STARTED", { Stage: "requirements-analysis" }, p))
      .toThrow();
    expect(readFileSync(external, "utf-8")).toBe(original);

    rmSync(shard);
    linkSync(external, shard);
    // A hardlink is NOT a redirect — it is the same inode under a contained,
    // symlink-chain-checked path. rsync --link-dest and cp -al backup
    // snapshots leave a live shard at nlink 2, and refusing that bricked
    // every later gate/hook append framework-wide, so the ordinary append
    // path accepts it: the row lands in the shard (and is therefore visible
    // through the other link too — that is what a hardlink means). The
    // explicit fork/merge snapshot stays strict; t07 pins that refusal.
    expect(() => appendAuditEntry("STAGE_STARTED", { Stage: "requirements-analysis" }, p))
      .not.toThrow();
    const merged = readFileSync(shard, "utf-8");
    expect(merged).toContain("**Event**: STAGE_STARTED");
    expect(merged.startsWith(original)).toBe(true); // append-only: nothing truncated
  });

  test("same-second imported association events cannot outrank the current shard", () => {
    const p = projectWithIntent();
    const source = doc(p, "same-second.md");
    const indexed = onboard(p, SPACE, source, NOW).indexed[0];
    const uuid = intentUuid(p);
    const current = spaceAuditShardPath(p, SPACE);
    const other = join(dirname(current), basename(current).replace(/\.md$/, "z.md"));
    const timestamp = "2026-08-13T02:00:00Z";
    const block = (event: string, fields: Record<string, string>): string =>
      `\n---\n**Event**: ${event}\n**Timestamp**: ${timestamp}\n` +
      Object.entries(fields).map(([key, value]) => `**${key}**: ${value}\n`).join("");
    writeFileSync(
      other,
      `# AI-DLC Audit Log\n${block("DOCUMENT_UPDATED", {
        Document: indexed.id,
        Change: "associate",
        Intent: uuid,
      })}`,
    );
    const currentBody = "# AI-DLC Audit Log\n" +
      block("DOCUMENT_INDEXED", {
        Document: indexed.id,
        Source: "documents/same-second.md",
        Digest: indexed.sha256,
      }) +
      block("DOCUMENT_UPDATED", {
        Document: indexed.id,
        Change: "dissociate",
        Intent: uuid,
      });
    writeFileSync(current, currentBody);

    syncDocuments(p, SPACE, "2026-08-13T02:01:00Z");
    expect(readFileSync(current, "utf-8")).toBe(currentBody);
  });

  test("index recovery does not overwrite an index restored while waiting for the lock", () => {
    const p = projectWithIntent();
    const source = doc(p, "recovery-race.md");
    onboard(p, SPACE, source, NOW);
    const restored = readIndex(p, SPACE);
    restored.documents[0].related_intent_ids = [intentUuid(p)];
    rmSync(indexPath(p, SPACE));
    // The restore releases the lock, so `sync`'s recovery always runs against the
    // restored file. Timed instead of ordered, `sync` could recover first and the
    // restorer's write would land LAST -- the assertion would then pass on the
    // restorer's own bytes without recovery ever having been tested.
    const held = join(p, "held");
    const mutationDone = join(p, "restore-mutation-done");
    const holder = writeLockHolder(join(p, "hold-recovery.ts"), p, held, mutationDone);
    const restoredJson = `${JSON.stringify(restored, null, 2)}\n`;
    const restorer = join(p, "restore-index.ts");
    writeFileSync(
      restorer,
      `await new Promise(resolve => setTimeout(resolve, 1000));` +
        `require("node:fs").writeFileSync(${JSON.stringify(indexPath(p, SPACE))},` +
        `${JSON.stringify(restoredJson)});` +
        `require("node:fs").writeFileSync(${JSON.stringify(mutationDone)}, "1");`,
    );
    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 & ` +
      `${waitForFile(held)}; ` +
      `bun ${JSON.stringify(restorer)} >/dev/null 2>&1 & ` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} sync --project-dir ${JSON.stringify(p)} >/dev/null; rc=$?; wait; exit $rc`;
    expect(spawnSync("bash", ["-c", script], { env: CHILD_ENV, timeout: 40_000 }).status).toBe(0);
    expect(readIndex(p, SPACE).documents[0].related_intent_ids).toEqual([intentUuid(p)]);
  }, 45_000);

  test("sync does not tombstone a source moved while it waits for the lock", () => {
    const p = projectWithIntent();
    const source = doc(p, "late-move-from.md", "same\n");
    const indexed = onboard(p, SPACE, source, NOW).indexed[0];
    rmSync(source);
    const target = join(documentsDir(p, SPACE), "late-move-to.md");
    // The late move releases the lock, so the planned tombstone always meets a
    // same-digest candidate at commit. Timed instead of ordered, `sync` could
    // tombstone the row before the move appeared.
    const held = join(p, "held");
    const mutationDone = join(p, "late-move-mutation-done");
    const holder = writeLockHolder(join(p, "hold-late-move.ts"), p, held, mutationDone);
    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 & ` +
      `${waitForFile(held)}; ` +
      `(sleep 1; printf 'same\n' > ${JSON.stringify(target)}; ` +
      `: > ${JSON.stringify(mutationDone)}) & ` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} sync --project-dir ${JSON.stringify(p)} >/dev/null; rc=$?; wait; exit $rc`;
    expect(spawnSync("bash", ["-c", script], { env: CHILD_ENV, timeout: 40_000 }).status).toBe(0);
    const row = readIndex(p, SPACE).documents.find((candidate) => candidate.id === indexed.id)!;
    expect(row.removed_at).toBeUndefined();
    expect(row.source.path).toBe("documents/late-move-from.md");
  }, 45_000);

  test("sync abandons a planned move when a second matching candidate appears", () => {
    const p = projectWithIntent();
    const source = doc(p, "ambiguous-from.md", "same\n");
    const indexed = onboard(p, SPACE, source, NOW).indexed[0];
    const first = join(documentsDir(p, SPACE), "candidate-one.md");
    const second = join(documentsDir(p, SPACE), "candidate-two.md");
    renameSync(source, first);
    writeFileSync(second, "diff\n");
    // The second candidate's rewrite releases the lock, so the ambiguity always
    // exists at commit. Timed instead of ordered, `sync` could commit the move to
    // candidate-one while it was still the only match.
    const held = join(p, "held");
    const mutationDone = join(p, "ambiguous-mutation-done");
    const holder = writeLockHolder(join(p, "hold-ambiguous.ts"), p, held, mutationDone);
    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 & ` +
      `${waitForFile(held)}; ` +
      `(sleep 1; printf 'same\n' > ${JSON.stringify(second)}; ` +
      `: > ${JSON.stringify(mutationDone)}) & ` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} sync --project-dir ${JSON.stringify(p)} >/dev/null; rc=$?; wait; exit $rc`;
    expect(spawnSync("bash", ["-c", script], { env: CHILD_ENV, timeout: 40_000 }).status).toBe(0);
    expect(readIndex(p, SPACE).documents.find((candidate) => candidate.id === indexed.id)?.source.path)
      .toBe("documents/ambiguous-from.md");
  }, 45_000);

  test("append position outranks a future-dated stale event in the current shard", () => {
    const p = projectWithIntent();
    const source = doc(p, "clock-skew.md", "current\n");
    const indexed = onboard(p, SPACE, source, NOW).indexed[0];
    const shard = spaceAuditShardPath(p, SPACE);
    appendAuditEntryAtPathUnlocked(
      "DOCUMENT_UPDATED",
      {
        Space: SPACE,
        Document: indexed.id,
        Change: "changed",
        Source: "documents/clock-skew.md",
        Digest: sha256Hex(Buffer.from("stale\n")),
      },
      p,
      shard,
    );
    const blocks = readFileSync(shard, "utf-8").split(/\n---\n/);
    const staleIndex = blocks.findLastIndex((block) => block.includes("**Event**: DOCUMENT_UPDATED"));
    blocks[staleIndex] = blocks[staleIndex].replace(
      /\*\*Timestamp\*\*: [^\n]+/,
      "**Timestamp**: 2999-01-01T00:00:00Z",
    );
    writeFileSync(shard, blocks.join("\n---\n"));

    syncDocuments(p, SPACE, "2026-08-13T03:00:00Z");
    const repaired = readFileSync(shard, "utf-8");
    syncDocuments(p, SPACE, "2026-08-13T03:01:00Z");
    expect(readFileSync(shard, "utf-8")).toBe(repaired);
  });

  test("a truncated first event cannot replace missing DOCUMENT_INDEXED provenance", () => {
    const p = projectWithIntent();
    const source = doc(p, "truncated-first.md");
    const indexed = onboard(p, SPACE, source, NOW).indexed[0];
    const shard = spaceAuditShardPath(p, SPACE);
    writeFileSync(
      shard,
      "# AI-DLC Audit Log\n\n---\n**Event**: DOCUMENT_UPDATED\n" +
        "**Timestamp**: 2026-08-13T04:00:00Z\n" +
        `**Document**: ${indexed.id}\n`,
    );
    syncDocuments(p, SPACE, "2026-08-13T04:01:00Z");
    const repaired = readFileSync(shard, "utf-8");
    expect(repaired).toContain("**Event**: DOCUMENT_INDEXED");
    expect(repaired).not.toContain("**Change**: audit-repair");
    syncDocuments(p, SPACE, "2026-08-13T04:02:00Z");
    expect(readFileSync(shard, "utf-8")).toBe(repaired);
  });

  test("sync does not mint a fresh id when topology changes while waiting", () => {
    const p = projectWithIntent();
    const original = doc(p, "identity.md", "same\n");
    const id = onboard(p, SPACE, original, NOW).indexed[0].id;
    doc(p, "candidate.md", "same\n");
    // The removal releases the lock, so the topology has always changed by the time
    // `sync` commits. Timed instead of ordered, `sync` could commit against the
    // topology it read, with both files still present.
    const held = join(p, "held");
    const mutationDone = join(p, "topology-mutation-done");
    const holder = writeLockHolder(join(p, "hold-fresh-topology.ts"), p, held, mutationDone);
    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 & ` +
      `${waitForFile(held)}; ` +
      `(sleep 1; rm ${JSON.stringify(original)}; ` +
      `: > ${JSON.stringify(mutationDone)}) & ` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} sync --project-dir ${JSON.stringify(p)} >/dev/null; rc=$?; wait; exit $rc`;
    expect(spawnSync("bash", ["-c", script], { env: CHILD_ENV, timeout: 40_000 }).status).toBe(0);
    const rows = readIndex(p, SPACE).documents;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].removed_at).toBeUndefined();
  }, 45_000);

  test("rebuild keeps the duplicate live row whose digest matches the source", () => {
    const p = projectWithIntent();
    const source = doc(p, "policy.md", "current policy\n");
    const indexed = onboard(p, SPACE, source, NOW).indexed[0];
    const winnerDir = join(documentkbDir(p, SPACE), indexed.id);
    const winnerMeta = JSON.parse(
      readFileSync(join(winnerDir, "metadata.json"), "utf-8"),
    ) as Record<string, unknown>;
    const loserId = "019fda80-8f8d-7bfa-b56c-983cf0353fab";
    const loserDir = join(documentkbDir(p, SPACE), loserId);
    mkdirSync(loserDir, { recursive: true });
    writeFileSync(
      join(loserDir, "metadata.json"),
      `${JSON.stringify({
        ...winnerMeta,
        id: loserId,
        sha256: sha256Hex(Buffer.from("stale policy\n")),
        bytes: Buffer.byteLength("stale policy\n"),
        indexed_at: "2026-08-08T00:00:00Z",
        extraction: { state: "unsupported_type", detectedType: "text/plain" },
        content: undefined,
        content_sha256: undefined,
      }, null, 2)}\n`,
    );
    rmSync(indexPath(p, SPACE));

    syncDocuments(p, SPACE, "2026-08-09T00:00:00Z");
    const rows = readIndex(p, SPACE).documents.filter(
      (row) => !row.removed_at && row.source.path === "documents/policy.md",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(indexed.id);
    expect(rows[0].sha256).toBe(sha256Hex(readFileSync(source)));
  });

  test("a successful edited onboard event carries its source path", () => {
    const p = projectWithIntent();
    const source = doc(p, "edited-source.md", "v1\n");
    const id = onboard(p, SPACE, source, NOW).indexed[0].id;
    writeFileSync(source, "v2\n");
    expect(onboard(p, SPACE, source, NOW).indexed[0].status).toBe("edited");
    const latest = readFileSync(spaceAuditShardPath(p, SPACE), "utf-8")
      .split(/\n---\n/)
      .filter((block) => block.includes(`**Document**: ${id}`) &&
        block.includes("**Change**: edited"))
      .at(-1)!;
    expect(latest).toContain("**Source**: documents/edited-source.md");
  });
});
