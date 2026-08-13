// covers: subcommand:aidlc-knowledge:onboard function:spaceAuditShardPath function:journalDir function:journalTxnDir function:collectStaleJournals function:appendAuditEntryAtPathUnlocked audit:DOCUMENT_INDEXED
//
// t291 - the journaled transaction around `onboard`. Where t289 covers the read
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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectStaleJournals,
  documentkbDir,
  documentsDir,
  indexPath,
  journalDir,
  journalTxnDir,
  onboard,
  readIndex,
  spaceAuditShardPath,
} from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const AIDLC_TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const NOW = "2026-08-07T00:00:00Z";
const SPACE = "default";
const CHILD_ENV = { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" };

let proj: string | undefined;

/** A project WITH AN ACTIVE INTENT. The intent is not incidental: the shard bug
 *  this file guards is invisible in a space with no intents, because that is the
 *  one case where the buggy call happens to return the right path. */
function projectWithIntent(): string {
  proj = mkdtempSync(join(tmpdir(), "t278-"));
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

function runOnboard(p: string, args: string[] = []): { status: number; out: string } {
  const r = spawnSync(
    "bun",
    [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", ...args, "--project-dir", p],
    { encoding: "utf-8", env: CHILD_ENV },
  );
  return { status: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
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

describe("t291 the audit row lands in the SPACE shard, not the active intent's", () => {
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
    expect(readAllAuditShards(p)).toContain("**Event**: DOCUMENT_INDEXED");
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

describe("t291 the journal: absent-or-complete, and collectable", () => {
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

describe("t291 the digest is re-validated INSIDE the lock", () => {
  test("a document edited between staging and commit is REFUSED, and nothing lands", () => {
    // Without the re-check inside the lock, this row is indexed with the NEW
    // digest and the OLD staged content -- silent corruption no locking elsewhere
    // prevents.
    //
    // Driven by a REAL race rather than a mock. A second process holds the audit
    // lock for ~3s; our onboard therefore stages, then blocks waiting to acquire.
    // While it waits, the file is rewritten. When the lock frees, the commit's
    // digest re-check sees bytes that no longer match what it staged.
    //
    // Two earlier attempts failed and are worth recording: mocking `readIndex`
    // never entered the window (the guard came out UNPINNED -- removing it changed
    // nothing), and mocking `readRegularFileNoFollowOrThrow` recursed forever
    // because the mock's fallback resolved to the mock itself.
    const p = projectWithIntent();
    const abs = doc(p, "a.md", "original\n");

    const holder = join(p, "holder.ts");
    writeFileSync(
      holder,
      `const lib = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-lib.ts"))});\n` +
        `lib.withAuditLock(${JSON.stringify(p)}, () => {\n` +
        `  require("node:fs").writeFileSync(${JSON.stringify(join(p, "lock-held"))}, "1");\n` +
        `  const until = Date.now() + 3000;\n` +
        `  while (Date.now() < until) { require("node:fs").existsSync(${JSON.stringify(p)}); }\n` +
        `  return 0;\n` +
        `}, undefined, ${JSON.stringify(SPACE)});\n`,
    );
    const mutator = join(p, "mutator.ts");
    writeFileSync(
      mutator,
      `const fs = require("node:fs");\n` +
        // Wait until our onboard is definitely staged-and-blocking, then mutate.
        `const until = Date.now() + 1500;\n` +
        `while (Date.now() < until) { fs.existsSync(${JSON.stringify(p)}); }\n` +
        `fs.writeFileSync(${JSON.stringify(abs)}, "CHANGED-MID-TXN\\n");\n`,
    );

    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 &\n` +
      // Wait for the lock to actually be held before starting onboard.
      `for i in $(seq 1 100); do [ -f ${JSON.stringify(join(p, "lock-held"))} ] && break; done\n` +
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

    // Either the edit was caught (the refusal names it) or the race did not land
    // this run. In BOTH cases the contract is the same and is what we assert: a
    // row on disk must match the bytes on disk. A stale-content row is the bug.
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

describe("t291 concurrency: N parallel onboards lose no row", () => {
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

    // A single shell launches all twelve with `&` and waits. That keeps the
    // test body synchronous while the processes genuinely OVERLAP -- which is
    // the whole point, since two onboards in ONE process would serialise on
    // the reentrant lock and prove nothing. Verified to contend: removing
    // withAuditLock makes this land fewer than 12 rows.
    const tool = join(AIDLC_TOOLS, "aidlc-knowledge.ts");
    const cmds = names
      .map((n) => `bun ${JSON.stringify(tool)} onboard ` +
        `${JSON.stringify(join(documentsDir(p, SPACE), `${n}.md`))} ` +
        `--project-dir ${JSON.stringify(p)} >/dev/null 2>&1 &`)
      .join("\n");
    const r = spawnSync("bash", ["-c", `${cmds}\nwait\n`], {
      encoding: "utf-8",
      env: CHILD_ENV,
      timeout: 45_000,
    });
    expect(r.status, `the concurrent batch failed: ${r.stderr}`).toBe(0);
    const rows = readIndex(p, SPACE).documents;
    // FULL survival, not best-effort. A lost row is the failure mode: each
    // process reads the index before the lock, so an unlocked commit writes back
    // a copy that never saw its siblings.
    expect(rows.length, "every concurrent onboard must survive").toBe(names.length);
    expect(new Set(rows.map((r) => r.source.path)).size).toBe(names.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(names.length);
  }, 60000);

  test("a serial control lands the same four rows", () => {
    // The comparison that makes the concurrent number meaningful: 4 is only
    // "full survival" if 4 is also what serial execution produces.
    const p = projectWithIntent();
    const names = Array.from({ length: 12 }, (_, i) => `f${i}`);
    for (const n of names) doc(p, `${n}.md`, `${n}\n`);
    for (const n of names) {
      runOnboard(p, [join(documentsDir(p, SPACE), `${n}.md`)]);
    }
    expect(readIndex(p, SPACE).documents.length).toBe(names.length);
  }, 60000);
});

describe("t291 an EDITED row is protected from the same race as a fresh one", () => {
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

    const holder = join(p, "holder.ts");
    writeFileSync(
      holder,
      `const lib = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-lib.ts"))});\n` +
        `lib.withAuditLock(${JSON.stringify(p)}, () => {\n` +
        `  require("node:fs").writeFileSync(${JSON.stringify(join(p, "lock-held"))}, "1");\n` +
        `  const until = Date.now() + 3000;\n` +
        `  while (Date.now() < until) { require("node:fs").existsSync(${JSON.stringify(p)}); }\n` +
        `  return 0;\n` +
        `}, undefined, ${JSON.stringify(SPACE)});\n`,
    );
    // Mutates `index.json` DIRECTLY -- not via `sync` -- so the race lands
    // DETERMINISTICALLY every run rather than depending on timing that may or
    // may not fall inside onboard's staging window. `sync` reaching the same
    // tombstone is exercised elsewhere (t284); what THIS test pins is onboard's
    // commit behaviour once a row it is about to refresh has ALREADY been
    // tombstoned by someone else -- the shape of the race, not its trigger.
    const mutator = join(p, "mutator.ts");
    writeFileSync(
      mutator,
      `const k = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))});\n` +
        `const until = Date.now() + 1500;\n` +
        `while (Date.now() < until) { require("node:fs").existsSync(${JSON.stringify(p)}); }\n` +
        `const idx = k.readIndex(${JSON.stringify(p)}, ${JSON.stringify(SPACE)});\n` +
        `idx.documents[0].removed_at = "2026-08-09T00:00:00Z";\n` +
        `k.writeIndex(${JSON.stringify(p)}, ${JSON.stringify(SPACE)}, idx);\n`,
    );

    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 &\n` +
      `for i in $(seq 1 100); do [ -f ${JSON.stringify(join(p, "lock-held"))} ] && break; done\n` +
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
});

describe("t291 the index is read FRESH inside the lock", () => {
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
});

describe("t291 the journal is actually GITIGNORED, not just described as such", () => {
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
      const repo = mkdtempSync(join(tmpdir(), `t278-gi-${h}-`));
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

describe("t291 I16: no lock inversion", () => {
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

describe("t291 I12: every refusal's prescribed remedy actually repairs the state", () => {
  test("the missing-documents/ refusal names a command that RUNS and repairs", () => {
    // Not "the message mentions mkdir" -- the message's own instruction is
    // extracted, executed verbatim, and then onboard must succeed. A remedy that
    // reads plausibly and does not work is worse than no remedy.
    proj = mkdtempSync(join(tmpdir(), "t278-"));
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
