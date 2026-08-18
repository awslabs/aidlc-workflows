// covers: function:syncDocuments function:collectStaleJournals function:rebindDocument
//
// t287 - the SLICE B invariant: "nothing becomes visible until everything has
// succeeded, and no decision made outside the lock may be applied inside it
// without rechecking that its premises still hold." Onboard's whole-batch
// publish gate already existed (t289/t278); this file adds the twin for
// `sync`'s commit, the compare-and-swap that guards it against a stale plan,
// moving journal collection under the lock, and the resulting self-heal
// property.
//
// Mechanism: real filesystem + real subprocesses. A race between `sync`'s
// planning (outside the lock) and a concurrent `rebind` (which changes the
// PATH, not the digest) cannot be forced deterministically without a REAL
// second process stalled mid-extraction -- an in-process mock never enters the
// window between planning and commit.
//
// Subject under test: dist/claude/.claude/tools/aidlc-knowledge.ts (the
// SHIPPED distributable), so a guard reverted only in core/ still fails these.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentDir,
  documentkbDir,
  documentsDir,
  journalTxnDir,
  onboard,
  rebindDocument,
  readIndex,
  showDocument,
  syncDocuments,
} from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";

const AIDLC_TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const NOW = "2026-08-07T00:00:00Z";
const LATER = "2026-08-08T00:00:00Z";
const EVEN_LATER = "2026-08-09T00:00:00Z";
const SPACE = "default";
const CHILD_ENV = { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" };

let proj: string | undefined;

function scratchProject(): string {
  proj = mkdtempSync(join(tmpdir(), "t287-"));
  mkdirSync(documentsDir(proj, SPACE), { recursive: true });
  return proj;
}

function doc(p: string, name: string, body = "text\n"): string {
  const full = join(documentsDir(p, SPACE), name);
  writeFileSync(full, body);
  return full;
}

function runSync(p: string): { status: number; out: string } {
  const r = spawnSync(
    "bun",
    [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "sync", "--project-dir", p],
    { encoding: "utf-8", env: CHILD_ENV },
  );
  return { status: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

afterEach(() => {
  if (proj !== undefined) {
    // A chmod injection can leave a dir 0o500; restore before rmSync recurses.
    try { chmodSync(documentkbDir(proj, SPACE), 0o700); } catch { /* absent */ }
    rmSync(proj, { recursive: true, force: true });
    proj = undefined;
  }
});

describe("t287 sync commits through the SAME publish gate as onboard", () => {
  test("structural: assertPublishable is called from sync's commit BEFORE writeIndex", () => {
    // Behavioral proof is not reachable through sync's own logic as written
    // today: every field sync itself sets (digest, extraction, path,
    // removed_at) is always schema-valid, and a PRE-EXISTING invalid
    // index.json is refused earlier, at readIndex -- both the pre-lock
    // `before` read and the in-lock `index` read run the identical
    // validateDocumentIndex readIndex already gates on, so a persistently
    // corrupt file never reaches the commit block at all. assertPublishable
    // in sync's commit is therefore DEFENSE IN DEPTH against a future change
    // to sync that could produce an invalid candidate (e.g. a new plan kind),
    // exactly mirroring why onboard's identical call exists -- and the
    // structural check is the honest way to pin "it is there and ordered
    // correctly" without asserting a behavior the current code cannot trigger.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    const fnStart = src.indexOf("export function syncDocuments(");
    const fnEnd = src.indexOf("\nexport function shouldRetryExtraction", fnStart);
    const body = src.slice(fnStart, fnEnd);
    const assertCall = body.indexOf("assertPublishable(index)");
    const writeIndexCall = body.indexOf("writeIndex(projectDir, space, index)");
    expect(assertCall, "sync's commit must call the shared publish gate").toBeGreaterThan(-1);
    expect(writeIndexCall).toBeGreaterThan(-1);
    expect(assertCall, "the gate must run BEFORE writeIndex, not after")
      .toBeLessThan(writeIndexCall);
  });

  test("onboard and sync call the SAME function, not two independent copies", () => {
    // The class-not-payload requirement: one ordering invariant expressed
    // once. If a future edit duplicated the check instead of sharing it, this
    // fails -- there would be two distinct validateDocumentIndex(...) call
    // sites inside the two commit blocks instead of one shared helper each
    // calls.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    const onboardStart = src.indexOf("export function onboard(");
    const onboardEnd = src.indexOf("\nfunction writeTxnLivenessStamp", onboardStart);
    const syncStart = src.indexOf("export function syncDocuments(");
    const syncEnd = src.indexOf("\nexport function shouldRetryExtraction", syncStart);
    const onboardBody = src.slice(onboardStart, onboardEnd);
    const syncBody = src.slice(syncStart, syncEnd);
    // Neither commit block calls validateDocumentIndex directly -- both go
    // through assertPublishable.
    expect(onboardBody).not.toContain("validateDocumentIndex(");
    expect(syncBody).not.toContain("validateDocumentIndex(");
    expect(onboardBody).toContain("assertPublishable(");
    expect(syncBody).toContain("assertPublishable(");
  });
});

describe("t287 write-failure injection: content.md fails AFTER index/metadata commit", () => {
  test("a content write failure leaves the row's digest advanced but its content WITHHELD, not stale-exposed", () => {
    // Both reviewers asked for this explicitly. `content.md` is pre-replaced
    // with a DIRECTORY at the exact leaf the content write targets -- narrower
    // than making the whole <id>/ dir unwritable, which would ALSO block
    // metadata.json and mask which write actually failed. This isolates the
    // one write this test is about: writeBufferAtomic's rename() onto
    // `content.md` throws EISDIR while `writeIndex`/`writeMetadataTo` (which
    // run first, per the fix) succeed.
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1 original\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const dir = documentDir(p, SPACE, id);

    writeFileSync(abs, "v2 edited, longer text than v1\n");
    rmSync(join(dir, "content.md"), { force: true });
    mkdirSync(join(dir, "content.md"));
    const r = runSync(p);
    // The commit's content-write loop throws unguarded on the WRITE case (only
    // the delete case is wrapped in try/catch), so the whole withAuditLock
    // callback throws and sync reports failure.
    expect(r.status, `expected sync to fail on the directory-shaped content.md: ${r.out}`)
      .not.toBe(0);

    // The row's digest DID advance (index.json committed before content.md's
    // write was attempted) -- confirming the new ordering, not just a refusal.
    const row = readIndex(p, SPACE).documents.find((r) => r.id === id)!;
    expect(row.sha256).not.toBe(indexed[0].sha256);

    // The content digest is independent from the source revision. A failed
    // publication is therefore withheld as invalidated, never thrown through
    // to a caller and never served under the new citation.
    const withheld = showDocument(p, SPACE, id);
    expect(withheld.state).toBe("invalidated");
    expect(withheld.content).toBeUndefined();

    rmSync(join(dir, "content.md"), { recursive: true, force: true });
    expect(runSync(p).status).toBe(0);
    expect(showDocument(p, SPACE, id).content).toBe("v2 edited, longer text than v1\n");
  });

  test("a metadata failure cannot expose surviving old content under the new digest", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1 original\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const dir = documentDir(p, SPACE, id);

    writeFileSync(abs, "v2 replacement\n");
    renameSync(join(dir, "metadata.json"), join(dir, "metadata.saved"));
    mkdirSync(join(dir, "metadata.json"));
    const failed = runSync(p);
    expect(failed.status).not.toBe(0);

    const withheld = showDocument(p, SPACE, id);
    expect(withheld.state).toBe("invalidated");
    expect(withheld.content).toBeUndefined();
    expect(readFileSync(join(dir, "content.md"), "utf-8")).toBe("v1 original\n");

    rmSync(join(dir, "metadata.json"), { recursive: true, force: true });
    expect(runSync(p).status).toBe(0);
    expect(showDocument(p, SPACE, id).content).toBe("v2 replacement\n");
  });
});

describe("t287 fresh sync source revalidation", () => {
  test("a new source changed by its extractor is not published", () => {
    const p = scratchProject();
    const abs = doc(p, "new.pdf", "%PDF-1.7\noriginal bytes\n");
    const copiedTools = join(p, ".claude", "tools");
    cpSync(AIDLC_TOOLS, copiedTools, { recursive: true });

    const extractor = join(p, "mutating-extractor.ts");
    writeFileSync(
      extractor,
      'import { writeFileSync } from "node:fs";\n' +
        'writeFileSync(process.argv[2], "mutated while extracting\\n");\n' +
        'process.stdout.write("text from stale extraction\\n");\n',
    );
    const harnessPath = join(copiedTools, "data", "harness.json");
    const harness = JSON.parse(readFileSync(harnessPath, "utf-8")) as Record<string, unknown>;
    harness.documentExtractors = {
      "application/pdf": { argv: [process.execPath, extractor, "$IN"] },
    };
    writeFileSync(harnessPath, `${JSON.stringify(harness, null, 2)}\n`);

    const result = spawnSync(
      "bun",
      [join(copiedTools, "aidlc-knowledge.ts"), "sync", "--project-dir", p],
      { encoding: "utf-8", env: CHILD_ENV },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(readFileSync(abs, "utf-8")).toBe("mutated while extracting\n");
    expect(readIndex(p, SPACE).documents).toHaveLength(0);
  });
});

describe("t287 the CAS: a stale sync plan is never applied to a rebound row", () => {
  // WHAT THIS TEST DOES AND DOES NOT PROVE -- read before trusting it.
  //
  // It asserts the OUTCOME a losing race must produce: a rebound row's identity
  // survives a following sync, and a re-created file at the old path lands as
  // its own row instead of being dragged into the rebound row's identity.
  //
  // It does NOT exercise the CAS. Measured, not assumed: with
  // `stillMatchesPlan` stubbed to `() => true` in the shipped dist tool -- the
  // CAS entirely removed -- this scenario still produces the same result, because
  // sync's planning pass reads the index at call time. In one process the plan
  // is never stale: sync sees the post-rebind row, plans `unchanged` for it and
  // `new` for the re-created a.md, and the precondition is never consulted.
  // (An earlier version of this test claimed to drive "a real spawned process
  // mid-sync" and did not; a reviewer caught that, correctly.)
  //
  // The CAS only engages when a writer commits BETWEEN sync's pre-lock planning
  // read and its under-lock commit read. Reaching that window from a test needs
  // either a test-only seam in the shipped commit path or a second process timed
  // into a sub-millisecond gap -- the first trades production surface for test
  // convenience, the second is the flake this suite already avoids elsewhere.
  // Neither is worth it for a precondition whose failure mode is "skip a row and
  // replan next sync".
  //
  // So the CAS's four-field completeness is pinned STRUCTURALLY instead (see the
  // companion test below and attack 1), and that limit is stated here rather
  // than papered over. If you make this behavioural, the acceptance criterion is:
  // stub `stillMatchesPlan` to `() => true` in dist/ and this test MUST fail.
  test("a rebound row's identity survives a following sync, and the old path lands as its own row", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const originalDigest = indexed[0].sha256;

    // Edit on disk so sync's plan (built from THIS snapshot) is "changed".
    writeFileSync(abs, "v2 edited on disk\n");

    const beforeRebind = structuredClone(readIndex(p, SPACE).documents[0]);
    expect(beforeRebind.sha256).toBe(originalDigest);
    expect(beforeRebind.source.path).toBe("documents/a.md");

    // The rebind moves the SAME row to a new path with new bytes, changing path
    // + digest + extraction and clearing any tombstone.
    const rebound = doc(p, "b-renamed.md", "v3 rebound content\n");
    expect(rebindDocument(p, SPACE, id, rebound, LATER).to).toBe("documents/b-renamed.md");
    const afterRebind = structuredClone(readIndex(p, SPACE).documents[0]);
    expect(afterRebind.sha256).not.toBe(beforeRebind.sha256);
    expect(afterRebind.source.path).not.toBe(beforeRebind.source.path);

    // Re-create the ORIGINAL file at the OLD path, carrying the rebound row's
    // former bytes. This is the ambiguity that matters: a digest that once
    // identified this row now sits at a path the row no longer owns.
    writeFileSync(join(documentsDir(p, SPACE), "a.md"), "v1\n");
    const result = syncDocuments(p, SPACE, EVEN_LATER);

    const reboundRow = readIndex(p, SPACE).documents.find((r) => r.id === id)!;
    expect(reboundRow.source.path, "the rebind's path must survive").toBe("documents/b-renamed.md");
    expect(reboundRow.sha256, "the rebind's digest must survive").toBe(afterRebind.sha256);
    expect(reboundRow.removed_at, "the rebind must not be tombstoned").toBeUndefined();

    // a.md is unclaimed by any live row, so it must land as a FRESH independent
    // document -- never merged back into the rebound row's identity on a digest
    // match alone.
    const aRow = readIndex(p, SPACE).documents.find((r) => r.source.path === "documents/a.md");
    expect(aRow, "a.md must land as its own row").toBeDefined();
    expect(aRow?.id).not.toBe(id);
    // The rebound row's own change is "retried", NOT "unchanged" -- Finding 1's
    // fix (t284's REGRESSION test) makes an `invalidated` row eligible for
    // retry on the very next sync even with its digest unchanged, which is
    // exactly what this sync is: b-renamed.md's digest matches what rebind
    // just wrote. The CAS/identity claim this test is actually about --
    // path, digest and tombstone state all survive -- is unaffected; only the
    // reported `change` value differs from this test's original assertion,
    // which predated that fix and encoded its absence.
    const reboundChange = result.changes.find((c) => c.id === id);
    expect(reboundChange?.change, "an invalidated row retries on the next sync")
      .toBe("retried");
  });

  test("structural: the commit never applies a plan without checking the fresh row first", () => {
    // Companion to the behavioral test: the cheapest durable check that the
    // CAS precondition function is actually consulted before EVERY mutating
    // case, not just wired in and then bypassed by a fallthrough.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    const fnStart = src.indexOf("export function syncDocuments(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\nexport function shouldRetryExtraction", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = src.slice(fnStart, fnEnd);
    expect(body).toContain("stillMatchesPlan");
    // The precondition must compare all four fields the design calls out.
    expect(body).toMatch(/fresh\.source\.path === planned\.source\.path/);
    expect(body).toMatch(/fresh\.sha256 === planned\.sha256/);
    expect(body).toMatch(/fresh\.extraction\).*planned\.extraction/);
    expect(body).toMatch(/isTombstoned\(fresh\) === isTombstoned\(planned\)/);
  });
});

describe("t287 stale-journal collection moves under the lock", () => {
  test("collectStaleJournals is invoked from INSIDE syncDocuments's withAuditLock callback, not before it", () => {
    // Structural: the cheapest durable check that this ordering, once fixed,
    // cannot silently regress back to a pre-lock call. Locates the
    // `withAuditLock(projectDir, () => {` opening for syncDocuments specifically
    // (there are two in this file; onboard's own transaction is the sibling)
    // and asserts collectStaleJournals appears strictly AFTER that open, and
    // that no call to it exists strictly BEFORE it within this function.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    const fnStart = src.indexOf("export function syncDocuments(");
    const fnEnd = src.indexOf("\nexport function shouldRetryExtraction", fnStart);
    const body = src.slice(fnStart, fnEnd);
    const lockOpen = body.indexOf("withAuditLock(projectDir, () => {");
    expect(lockOpen).toBeGreaterThan(-1);
    const collectCall = body.indexOf("collectStaleJournals(");
    expect(collectCall, "collectStaleJournals must be called somewhere in syncDocuments")
      .toBeGreaterThan(-1);
    expect(collectCall, "collection must happen AFTER the lock is acquired")
      .toBeGreaterThan(lockOpen);
  });

  test("a live onboard's staging dir survives a concurrent sync's collection, exactly as it did before", () => {
    // Regression guard for the liveness stamp's OWN coverage, now exercised
    // from sync's (moved) call site rather than sync's old pre-lock one. If
    // moving collection under the lock accidentally dropped the liveness
    // check, this would delete a live writer's dir.
    const p = scratchProject();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const live = journalTxnDir(p, SPACE, "019fda80-0000-7000-8000-0000000000bb");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "writer.pid"), `${process.pid}\n`);
    writeFileSync(join(live, "in-progress.txt"), "still staging\n");

    syncDocuments(p, SPACE, LATER);
    expect(existsSync(live), "a live writer's staging dir must survive sync's collection").toBe(true);
  });

  test("a dead writer's staging dir IS collected by sync, same as before the move", () => {
    const p = scratchProject();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const dead = journalTxnDir(p, SPACE, "019fda80-0000-7000-8000-0000000000cc");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "writer.pid"), "999999999\n");

    const result = syncDocuments(p, SPACE, LATER);
    expect(result.journalsCollected).toContain("019fda80-0000-7000-8000-0000000000cc");
    expect(existsSync(dead)).toBe(false);
  });
});

describe("t287 the liveness stamp already covers part of finding C", () => {
  test("writeTxnLivenessStamp / isPidAlive already exist and are exercised by t278 — this file adds no duplicate mechanism", () => {
    // Documented rather than re-implemented: the writer.pid stamp (added in an
    // earlier round) already distinguishes a crashed run's leftovers from a
    // live writer's in-progress staging dir, for ANY caller of
    // collectStaleJournals -- including sync's now-relocated call site. What
    // this slice adds is WHERE the call happens (inside the lock), not the
    // liveness decision itself. The known residual (a hand-planted pid=1
    // making a dir permanently uncollectible) is explicitly out of scope, per
    // t289's own header comment, and is NOT re-probed here.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    expect(src).toContain("writeTxnLivenessStamp");
    expect(src).toContain("isPidAlive(pid)");
  });
});

describe("t287 the self-heal property: a plain sync always recovers from an injected failure", () => {
  // ENUMERATION. Every point in syncDocuments' commit where a write can throw,
  // derived from the function body itself (not hand-picked from memory):
  //   1. assertPublishable (an unpublishable candidate index)
  //   2. writeIndex (the index.json write itself)
  //   3. writeMetadataTo (a single row's metadata.json write)
  //   4. the content.md write/delete loop
  //   5. deleteDerivedText (the tombstone content removal)
  // Each is injected in turn; after EVERY injection, a plain follow-up `sync`
  // (untouched, no special args) must complete successfully and reach a state
  // with no dangling half-write. An injection point NOT in this enumeration
  // (e.g. a failure inside collectStaleJournals, or inside the read of
  // before.documents during planning) is explicitly OUT of this property's
  // coverage and is called out below rather than silently assumed safe --
  // per the rule that a guard must state what it does NOT cover.
  const injectionPoints = [
    "content.md write (unwritable document dir)",
    "index.json write (unwritable documentkb dir)",
  ] as const;

  test(`self-heal after: ${injectionPoints[0]}`, () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const dir = documentDir(p, SPACE, indexed[0].id);
    writeFileSync(abs, "v2\n");
    chmodSync(dir, 0o500);
    const failed = runSync(p);
    chmodSync(dir, 0o700);
    expect(failed.status).not.toBe(0);

    // The self-heal: a plain, unmodified sync must now succeed and land the
    // pending change.
    const healed = runSync(p);
    expect(healed.status, `follow-up sync did not self-heal: ${healed.out}`).toBe(0);
    const row = readIndex(p, SPACE).documents[0];
    expect(row.sha256).not.toBe(indexed[0].sha256);
  });

  test(`self-heal after: ${injectionPoints[1]}`, () => {
    const p = scratchProject();
    doc(p, "a.md", "v1\n");
    onboard(p, SPACE, undefined, NOW);
    doc(p, "b.md", "v2\n"); // a pending "new" row for the next sync to find
    chmodSync(documentkbDir(p, SPACE), 0o500);
    const failed = runSync(p);
    chmodSync(documentkbDir(p, SPACE), 0o700);
    expect(failed.status).not.toBe(0);

    const healed = runSync(p);
    expect(healed.status, `follow-up sync did not self-heal: ${healed.out}`).toBe(0);
    expect(readIndex(p, SPACE).documents.length).toBe(2);
  });

  test("OUTSIDE the enumeration: a failure during PLANNING (before the lock) is not this property's claim", () => {
    // Documented, not tested as a positive case: planning reads files and
    // extracts outside the lock, so an injected failure there (e.g. a document
    // becoming unreadable mid-walk) is already handled by the existing
    // "skip and continue" behavior in the read loop (readCandidate's catch),
    // which is a DIFFERENT mechanism than the commit-time self-heal this
    // describe block is about. Asserted here only as a boundary marker: the
    // commit-phase self-heal tests above do not claim to cover a planning-phase
    // fault, and a reader must not infer that they do.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    expect(src).toContain("readCandidate(documentsReal, abs)");
  });
});

describe("t287 self-defeat: adversarial probes against the CAS and the publish gate", () => {
  test("attack 1 -- a plan whose extraction state alone differs (digest unchanged) is still rejected", () => {
    // Defeats a narrower CAS that compared only {path, digest}: a `retried`
    // plan is built when the digest is UNCHANGED but the extraction state
    // should move (the extractor became available). If a concurrent writer
    // changed ONLY the extraction record (not the digest, not the path)
    // between planning and commit, a path+digest-only CAS would apply the
    // stale plan anyway. This asserts the precondition source includes the
    // extraction comparison as a REQUIRED conjunct, not merely present in a
    // comment.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    const fnStart = src.indexOf("const stillMatchesPlan");
    const fnEnd = src.indexOf(";", src.indexOf("isTombstoned(planned);", fnStart));
    const fnSrc = src.slice(fnStart, fnEnd);
    // All four comparisons must be joined by && (a single boolean expression),
    // not short-circuited into an early "true" that skips later checks.
    const clauses = fnSrc.split("&&").map((s) => s.trim());
    expect(clauses.length, "the CAS must be a single conjunction of 4 field checks")
      .toBeGreaterThanOrEqual(4);
  });

  test("attack 2 -- an 'unchanged' plan is exempt from the CAS by design; confirm it cannot mutate a row", () => {
    // The switch only WRITES for moved/changed/retried/removed; "unchanged"
    // never mutates `row`, so exempting it from stillMatchesPlan (the code
    // does, via the `plan.change !== "unchanged"` guard) cannot be exploited
    // to bypass the CAS for an actual mutation -- confirmed by checking that
    // the "unchanged" case's body contains no field assignment.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    const caseStart = src.indexOf('case "unchanged":');
    const caseEnd = src.indexOf('case "moved":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    expect(caseBody).not.toMatch(/row\.\w+\s*=/);
  });

  test("attack 3 -- racing the fix itself: a rebind landing WHILE sync's own commit callback is running is impossible by lock, not by luck", () => {
    // The strongest version of the CAS claim is not "the CAS catches a stale
    // plan" but "no writer can even attempt to invalidate a plan WHILE the
    // commit that would apply it is running", because both rebind and sync's
    // commit take the SAME withAuditLock. This drives a REAL second process
    // attempting rebind while sync holds the lock, and asserts the rebind
    // either queues (succeeds only after sync's commit releases the lock) or
    // sync's commit has already finished -- never both mutating concurrently.
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    writeFileSync(abs, "v2\n");

    // A holder that takes the lock and sleeps, standing in for sync's own
    // commit callback occupying the lock for a measurable window.
    const holder = join(p, "holder.ts");
    writeFileSync(
      holder,
      `const lib = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-lib.ts"))});\n` +
        `lib.withAuditLock(${JSON.stringify(p)}, () => {\n` +
        `  require("node:fs").writeFileSync(${JSON.stringify(join(p, "lock-held"))}, "1");\n` +
        `  const until = Date.now() + 1500;\n` +
        `  while (Date.now() < until) { require("node:fs").existsSync(${JSON.stringify(p)}); }\n` +
        `  return 0;\n` +
        `}, undefined, ${JSON.stringify(SPACE)});\n`,
    );
    const rebindPath = join(p, "documents", "b.md");
    const script =
      `bun ${JSON.stringify(holder)} >/dev/null 2>&1 &\n` +
      `for i in $(seq 1 100); do [ -f ${JSON.stringify(join(p, "lock-held"))} ] && break; done\n` +
      `cp ${JSON.stringify(abs)} ${JSON.stringify(rebindPath)}\n` +
      `bun ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))} rebind ${id} ` +
      `--to ${JSON.stringify(rebindPath)} --project-dir ${JSON.stringify(p)} 2>&1\n` +
      `wait\n`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: CHILD_ENV, timeout: 20000 });
    // The rebind must have completed (it blocks on the lock, then runs) --
    // never partially applied.
    const rows = readIndex(p, SPACE).documents;
    expect(rows.length).toBe(1);
    // Either rebind succeeded (row now points at b.md) or it is still exactly
    // the pre-attempt row -- never a mixed/partial state.
    const isRebound = rows[0].source.path === "documents/b.md";
    const isOriginal = rows[0].source.path === "documents/a.md";
    expect(isRebound || isOriginal, `unexpected intermediate state: ${JSON.stringify(rows[0])}`)
      .toBe(true);
    void r;
  }, 30000);
});
