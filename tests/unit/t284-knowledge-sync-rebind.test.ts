// covers: function:syncDocuments function:shouldRetryExtraction function:rebuildIndex function:rebindDocument audit:DOCUMENT_UPDATED audit:DOCUMENT_REMOVED
//
// t284 - `sync` (reconcile with the folder), the index REBUILD, and `rebind` (the
// remedy that makes failing closed defensible).
//
// Mechanism: real filesystem + real spawns. `sync`'s hardest case is a re-extract
// triggered by a change in the ENVIRONMENT rather than the document, which cannot
// be observed without really invoking an extractor.
//
// Subject under test: dist/claude/.claude/tools/aidlc-knowledge.ts.
//
// The three things worth stating up front:
//
//   THE RETRY INVERSION. Digest-unchanged normally means "nothing to do". But a
//   row saying `extractor_unavailable` recorded a fact about the MACHINE, so a
//   later sync on a machine that has the extractor must retry -- otherwise every
//   PDF stays permanently unextracted and the user's only recourse is to edit
//   every file to move its digest. `extraction_failed` retries only on a VERSION
//   change, because a genuinely malformed document is a property of the document
//   and would otherwise be re-parsed forever.
//
//   THE REBUILD IS THE MECHANISM THE IDENTITY DESIGN RESTS ON. Identity lives in
//   index.json, and the answer to "what if you lose it" is "sync rebuilds it from
//   the per-document metadata.json files". A rebuild that silently
//   MIS-CLASSIFIES is worse than no rebuild, because it looks successful -- so a
//   tombstone must come back as a tombstone, never dropped and never conflated
//   with an unavailable source.
//
//   REBIND IS NOT A CONVENIENCE. With only {path, sha256} there is no information
//   distinguishing "moved and edited policy.pdf" from "deleted policy.pdf and
//   added an unrelated standards.pdf". Failing closed is defensible ONLY because
//   a human can resolve what the tool refused; without rebind, an edited-and-moved
//   document is permanently stranded and re-onboarding destroys the citation
//   stability the narrowing exists to protect.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentDir,
  documentkbDir,
  documentsDir,
  indexPath,
  onboard,
  readIndex,
  rebindDocument,
  rebuildIndex,
  shouldRetryExtraction,
  spaceAuditShardPath,
  syncDocuments,
  writeIndex,
} from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";

const AIDLC_TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const NOW = "2026-08-07T00:00:00Z";
const LATER = "2026-08-08T00:00:00Z";
const EVEN_LATER = "2026-08-09T00:00:00Z";
const SPACE = "default";
const DIGEST = "a".repeat(64);
const CHILD_ENV = { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" };

let proj: string | undefined;
let fakeBin: string | undefined;

function scratchProject(): string {
  proj = mkdtempSync(join(tmpdir(), "t284-"));
  mkdirSync(documentsDir(proj, SPACE), { recursive: true });
  return proj;
}

function doc(p: string, name: string, body = "text\n"): string {
  const full = join(documentsDir(p, SPACE), name);
  writeFileSync(full, body);
  return full;
}

function auditBody(p: string): string {
  const path = spaceAuditShardPath(p, SPACE);
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

/** A row shaped like one the writer produces, for the pure decision table. */
function row(extraction: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "019fda80-8f8d-7bfa-b56c-983cf0353faa",
    source: { kind: "managed", path: "documents/p.pdf" },
    sha256: DIGEST,
    bytes: 9,
    indexed_at: NOW,
    extraction,
    summary: { state: "absent" },
  };
}

afterEach(() => {
  for (const d of [proj, fakeBin]) {
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
  proj = undefined;
  fakeBin = undefined;
});

describe("t284 sync detects each kind of change", () => {
  test("an EDITED document keeps its id and gets a new digest", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const firstDigest = indexed[0].sha256;

    writeFileSync(abs, "v2 edited\n");
    const result = syncDocuments(p, SPACE, LATER);
    expect(result.changes.find((c) => c.change === "changed")).toBeDefined();

    const rows = readIndex(p, SPACE).documents;
    expect(rows.length).toBe(1);
    // Identity SURVIVES a same-path edit -- that is the narrowed guarantee.
    expect(rows[0].id).toBe(id);
    expect(rows[0].sha256).not.toBe(firstDigest);
  });

  test("a MOVED document keeps its id and gets a new path", () => {
    // Pure move, digest unchanged, matching exactly one row: identity survives.
    const p = scratchProject();
    const abs = doc(p, "a.md", "stable\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    renameSync(abs, join(documentsDir(p, SPACE), "renamed.md"));

    const result = syncDocuments(p, SPACE, LATER);
    expect(result.changes.find((c) => c.change === "moved")).toBeDefined();
    const rows = readIndex(p, SPACE).documents;
    expect(rows[0].id).toBe(indexed[0].id);
    expect(rows[0].source.path).toBe("documents/renamed.md");
  });

  test("an AMBIGUOUS move (two identical files) does NOT guess", () => {
    // Two files share the digest, so nothing distinguishes which one the row
    // became. Guessing would re-point identity silently, and a rule's citation
    // hangs off that identity -- so the row is treated as removed and `rebind` is
    // the human resolution.
    const p = scratchProject();
    const abs = doc(p, "a.md", "identical\n");
    onboard(p, SPACE, undefined, NOW);
    rmSync(abs);
    doc(p, "x.md", "identical\n");
    doc(p, "y.md", "identical\n");

    const result = syncDocuments(p, SPACE, LATER);
    // The original row is NOT silently re-pointed at x or y.
    const moved = result.changes.filter((c) => c.change === "moved");
    expect(moved).toEqual([]);
  });

  test("a NEW file is indexed by sync, not only by onboard", () => {
    const p = scratchProject();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    doc(p, "b.md", "second\n");
    const result = syncDocuments(p, SPACE, LATER);
    expect(result.changes.filter((c) => c.change === "new").length).toBe(1);
    expect(readIndex(p, SPACE).documents.length).toBe(2);
  });

  test("nothing changed reports `unchanged` and does not rewrite the index", () => {
    const p = scratchProject();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const before = readFileSync(indexPath(p, SPACE), "utf-8");
    const result = syncDocuments(p, SPACE, LATER);
    expect(result.changes.every((c) => c.change === "unchanged")).toBe(true);
    // Byte-identical: a no-op sync must not churn a committed file.
    expect(readFileSync(indexPath(p, SPACE), "utf-8")).toBe(before);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE INVARIANT this closes: a digest is resolved GLOBALLY across every
  // missing row before any single row is allowed to claim a candidate. The
  // per-row version above (two CANDIDATE files, one row) already refused to
  // guess. This is the mirror case the per-row pass missed: two MISSING ROWS
  // sharing an identical digest, competing for ONE candidate. A row-at-a-time
  // pass hands the candidate to whichever row it iterates to FIRST -- an
  // artifact of array order, not evidence -- and silently attaches that row's
  // citation history to the wrong file.
  // ───────────────────────────────────────────────────────────────────────────
  test("two rows sharing a digest, BOTH missing, competing for ONE candidate: neither guesses", () => {
    const p = scratchProject();
    doc(p, "a.md", "identical\n");
    doc(p, "b.md", "identical\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    expect(indexed.length).toBe(2);
    rmSync(join(documentsDir(p, SPACE), "a.md"));
    rmSync(join(documentsDir(p, SPACE), "b.md"));
    doc(p, "c.md", "identical\n");

    const result = syncDocuments(p, SPACE, LATER);
    // NEITHER row is reported moved: competition fails closed for the whole
    // group, not just for the row that happens to run first.
    expect(result.changes.filter((c) => c.change === "moved")).toEqual([]);
    const rows = readIndex(p, SPACE).documents;
    const tombstoned = rows.filter((r) => r.removed_at !== undefined);
    expect(tombstoned.length, "both competing rows must tombstone, not one arbitrary winner").toBe(2);
    // c.md is unclaimed by EITHER old identity, so it lands as its OWN new
    // row (a fresh id) -- never silently attached to whichever old row's
    // array position happened to win.
    const cRow = rows.find((r) => r.source.path === "documents/c.md");
    expect(cRow, "c.md must still be indexed, just under its OWN identity").toBeDefined();
    expect(tombstoned.map((r) => r.id)).not.toContain(cRow?.id);
  });

  test("RED-verify: array order does not decide which row wins the competing candidate", () => {
    // Same scenario, but the fixture is built so a row-at-a-time pass (the
    // pre-fix shape) would deterministically favour the row it visits FIRST
    // -- proving the fix is order-independent, not merely order-lucky in the
    // test above.
    const p = scratchProject();
    doc(p, "z-first.md", "identical\n"); // sorts/iterates first in most orders
    doc(p, "a-second.md", "identical\n");
    const first = onboard(p, SPACE, undefined, NOW);
    const idOfZ = first.indexed.find((i) => i.path.endsWith("z-first.md"))?.id;
    const idOfA = first.indexed.find((i) => i.path.endsWith("a-second.md"))?.id;
    rmSync(join(documentsDir(p, SPACE), "z-first.md"));
    rmSync(join(documentsDir(p, SPACE), "a-second.md"));
    doc(p, "the-winner.md", "identical\n");

    syncDocuments(p, SPACE, LATER);
    const rows = readIndex(p, SPACE).documents;
    const zRow = rows.find((r) => r.id === idOfZ);
    const aRow = rows.find((r) => r.id === idOfA);
    // Neither survives as "moved" to the-winner.md -- both tombstone, and
    // the-winner.md lands under its OWN fresh identity, not either old one.
    expect(zRow?.removed_at).toBeTruthy();
    expect(aRow?.removed_at).toBeTruthy();
    const winnerRow = rows.find((r) => r.source.path === "documents/the-winner.md");
    expect(winnerRow).toBeDefined();
    expect(winnerRow?.id).not.toBe(idOfZ);
    expect(winnerRow?.id).not.toBe(idOfA);
  });

  test("stale journal dirs are collected", () => {
    const p = scratchProject();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const orphan = join(documentkbDir(p, SPACE), ".journal", "019f-crashed");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "metadata.json"), "{}");
    // No liveness stamp, aged past the unstamped grace: reads as a crash's
    // leftovers, not a live writer mid-acquire.
    const old = new Date(Date.now() - 60_000);
    utimesSync(orphan, old, old);
    const result = syncDocuments(p, SPACE, LATER);
    expect(result.journalsCollected).toContain("019f-crashed");
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("t284 removal: tombstone the RECORD, delete the TEXT", () => {
  test("a removed original leaves a tombstone and DELETES content.md", () => {
    // The readable derivative must not outlive the original: for a document
    // deleted BECAUSE it was sensitive, leaving the full text behind is a leak.
    const p = scratchProject();
    const abs = doc(p, "a.md", "sensitive content\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const contentPath = join(documentDir(p, SPACE, indexed[0].id), "content.md");
    expect(existsSync(contentPath)).toBe(true);

    rmSync(abs);
    syncDocuments(p, SPACE, LATER);

    const rows = readIndex(p, SPACE).documents;
    expect(rows.length, "the row is tombstoned, NOT deleted").toBe(1);
    expect(rows[0].removed_at).toBe(LATER);
    // Last path and last digest survive, because a citation must not dangle.
    expect(rows[0].source.path).toBe("documents/a.md");
    expect(rows[0].sha256).toBeTruthy();
    expect(existsSync(contentPath), "the extracted text must be gone").toBe(false);
  });

  test("metadata.json SURVIVES a removal, so the tombstone is rebuildable", () => {
    // Got wrong once: deleting the whole <id>/ dir seemed right, but metadata.json
    // is what a rebuild reads -- removing it made the tombstone unrecoverable, and
    // a later rebuild silently dropped the row (measured 2 -> 1).
    const p = scratchProject();
    const abs = doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    rmSync(abs);
    syncDocuments(p, SPACE, LATER);
    expect(existsSync(join(documentDir(p, SPACE, indexed[0].id), "metadata.json"))).toBe(true);
  });

  test("DOCUMENT_REMOVED records the LAST path and digest", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    rmSync(abs);
    syncDocuments(p, SPACE, LATER);
    const body = auditBody(p);
    expect(body).toContain("**Event**: DOCUMENT_REMOVED");
    expect(body).toContain("**Last Path**: documents/a.md");
    expect(body).toMatch(/\*\*Last Digest\*\*: [0-9a-f]{64}/);
  });

  test("an already-tombstoned row is not re-tombstoned on the next sync", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    rmSync(abs);
    syncDocuments(p, SPACE, LATER);
    const after = auditBody(p);
    syncDocuments(p, SPACE, LATER);
    // No second DOCUMENT_REMOVED: the ledger records changes, not states.
    expect(auditBody(p)).toBe(after);
  });
});

describe("t284 the retry INVERSION: the environment changed, not the document", () => {
  test("extractor_unavailable retries when the extractor appears", () => {
    // Without this, every PDF stays permanently unextracted on a machine where
    // the extractor was installed after the first sync, and the only recourse is
    // editing every file to move its digest.
    expect(shouldRetryExtraction(
      row({ state: "extractor_unavailable", extractor: { name: "pdftotext" } }) as never,
    )).toBe(probeAvailable());
  });

  test("a healthy `extracted` row is NOT retried", () => {
    expect(shouldRetryExtraction(row({
      state: "extracted", source_revision: DIGEST, chars: 5, truncated: false,
      extractor: { name: "pdftotext", version: "v1" },
    }) as never)).toBe(false);
  });

  test("extraction_failed is NOT retried on the SAME extractor version", () => {
    // A genuinely malformed document is a property of the DOCUMENT. Retrying it
    // every sync forever would spawn a parse per sync and never succeed.
    if (!probeAvailable()) return;
    const version = currentPdftotextVersion();
    expect(shouldRetryExtraction(row({
      state: "extraction_failed", reason: "malformed",
      extractor: { name: "pdftotext", version },
    }) as never)).toBe(false);
  });

  test("extraction_failed IS retried when the version CHANGED", () => {
    // A new extractor may well parse what the old one could not.
    if (!probeAvailable()) return;
    expect(shouldRetryExtraction(row({
      state: "extraction_failed", reason: "malformed",
      extractor: { name: "pdftotext", version: "pdftotext version 0.0.1-ancient" },
    }) as never)).toBe(true);
  });

  test("unsupported_type is not retried while no extractor is configured", () => {
    expect(shouldRetryExtraction(
      row({ state: "unsupported_type", detectedType: "image/png" }) as never,
    )).toBe(false);
  });

  test("end to end: a version change re-extracts with the digest UNCHANGED", () => {
    if (!probeAvailable()) return;
    // A fake extractor that fails, so the row records a failure with a version
    // that will not match the real tool on the next sync.
    fakeBin = mkdtempSync(join(tmpdir(), "t284-bin-"));
    writeFileSync(join(fakeBin, "pdftotext"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(fakeBin, "pdftotext"), 0o755);

    const p = scratchProject();
    doc(p, "p.pdf", "%PDF-1.4\nfake\n");
    const first = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", "--project-dir", p],
      { encoding: "utf-8", env: { ...CHILD_ENV, PATH: `${fakeBin}:${process.env.PATH}` } },
    );
    expect(first.status, first.stderr).toBe(0);
    const before = readIndex(p, SPACE).documents[0];
    expect(before.extraction.state).toBe("extraction_failed");
    const digestBefore = before.sha256;

    // Now sync with the REAL extractor on PATH. The document has not changed.
    const result = syncDocuments(p, SPACE, LATER);
    expect(result.changes.find((c) => c.change === "retried"),
      "a version change must trigger a retry on an unchanged digest").toBeDefined();
    // The digest is the SAME -- the retry was not triggered by an edit.
    expect(readIndex(p, SPACE).documents[0].sha256).toBe(digestBefore);
  }, 60000);
});

describe("t284 the index REBUILD is a real mechanism, not a claim", () => {
  test("deleting index.json and syncing restores every row", () => {
    const p = scratchProject();
    doc(p, "a.md", "one\n");
    doc(p, "b.md", "two\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const ids = indexed.map((i) => i.id).sort();

    rmSync(indexPath(p, SPACE));
    syncDocuments(p, SPACE, LATER);

    const rows = readIndex(p, SPACE).documents;
    expect(rows.map((r) => r.id).sort()).toEqual(ids);
    // Identity is preserved through the rebuild, which is the whole point: the
    // narrowed guarantee depends on it.
    for (const r of rows) expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a TOMBSTONE comes back as a tombstone — never dropped, never conflated", () => {
    // A rebuild that silently mis-classifies is worse than no rebuild, because it
    // looks successful. Measured failure before the fix: rows went 2 -> 1.
    const p = scratchProject();
    const abs = doc(p, "a.md");
    doc(p, "b.md", "live\n");
    onboard(p, SPACE, undefined, NOW);
    rmSync(abs);
    syncDocuments(p, SPACE, LATER);
    expect(readIndex(p, SPACE).documents.length).toBe(2);

    rmSync(indexPath(p, SPACE));
    syncDocuments(p, SPACE, LATER);

    const rows = readIndex(p, SPACE).documents;
    expect(rows.length, "the tombstone must survive the rebuild").toBe(2);
    const tomb = rows.find((r) => r.source.path === "documents/a.md");
    expect(tomb?.removed_at, "and come back as a TOMBSTONE").toBeTruthy();
  });

  test("rebuildIndex REFUSES a metadata.json whose id disagrees with its dir", () => {
    // Lookups are by id, so a mismatch would make one of the two unreachable.
    const p = scratchProject();
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const metaPath = join(documentDir(p, SPACE, indexed[0].id), "metadata.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    meta.id = "019fda80-0000-7000-8000-000000000099";
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    expect(() => rebuildIndex(p, SPACE)).toThrow(/does not match its|content must be/);
  });

  test("the rebuild's input is UNTRUSTED: a hostile metadata.json is refused", () => {
    // A rebuild that trusts its input is an arbitrary-file-read with extra steps.
    const p = scratchProject();
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const metaPath = join(documentDir(p, SPACE, indexed[0].id), "metadata.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    meta.source = { kind: "managed", path: "../../../../etc/passwd" };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    expect(() => rebuildIndex(p, SPACE)).toThrow();
  });

  test("an empty documentkb/ rebuilds to an empty index, not an error", () => {
    const p = scratchProject();
    expect(rebuildIndex(p, SPACE).documents).toEqual([]);
  });
});

describe("t284 rebind is the remedy failing closed requires", () => {
  test("rebind preserves the id and the intents", () => {
    // The point of the whole narrowing: citation history stays attached.
    const p = scratchProject();
    const abs = doc(p, "policy.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const index = readIndex(p, SPACE);
    index.documents[0].related_intent_ids = ["019fda80-0000-7000-8000-000000000001"];
    writeIndex(p, SPACE, index);

    // Move AND edit: the case the tool refuses to guess at.
    rmSync(abs);
    const moved = doc(p, "standards.md", "v2 different\n");

    const out = rebindDocument(p, SPACE, id, moved, LATER);
    expect(out.id).toBe(id);
    expect(out.to).toBe("documents/standards.md");

    const rows = readIndex(p, SPACE).documents;
    expect(rows.length).toBe(1);
    expect(rows[0].id, "identity must survive the rebind").toBe(id);
    expect(rows[0].related_intent_ids).toEqual(["019fda80-0000-7000-8000-000000000001"]);
  });

  test("rebind INVALIDATES the old extraction rather than keeping stale text", () => {
    // The old text described the old bytes. A fresh digest beside stale text is
    // exactly the corruption revision-binding exists to prevent.
    const p = scratchProject();
    const abs = doc(p, "policy.md", "v1 original\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const contentPath = join(documentDir(p, SPACE, indexed[0].id), "content.md");
    expect(existsSync(contentPath)).toBe(true);

    rmSync(abs);
    const moved = doc(p, "standards.md", "v2 different\n");
    rebindDocument(p, SPACE, indexed[0].id, moved, LATER);

    const rows = readIndex(p, SPACE).documents;
    expect(rows[0].extraction.state).toBe("invalidated");
    expect(rows[0].content).toBeUndefined();
    expect(existsSync(contentPath), "stale text must be removed").toBe(false);
  });

  test("REGRESSION: rebind then sync re-extracts, closing the documented recovery path", () => {
    // `rebindDocument`'s own message promises "the next sync re-extracts" for a
    // row it just set to `invalidated`. That promise was broken: `sync`'s
    // digest-unchanged branch only ever consulted shouldRetryExtraction, which
    // handled `extractor_unavailable` and a version-changed `extraction_failed`
    // -- never `invalidated`. Reproduced exactly as the reviewer measured it: a
    // moved-and-edited TEXT document (so extraction needs no external tool and
    // this test has no PATH dependency), rebind, then a plain sync with the
    // digest unchanged from the rebind. Before the fix, sync reported
    // "unchanged", the row stayed `invalidated` forever, and content.md was
    // never regenerated.
    const p = scratchProject();
    const abs = doc(p, "policy.md", "v1 original\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;

    rmSync(abs);
    const moved = doc(p, "standards.md", "v2 moved and edited\n");
    rebindDocument(p, SPACE, id, moved, LATER);
    const bound = readIndex(p, SPACE).documents.find((r) => r.id === id)!;
    expect(bound.extraction.state).toBe("invalidated");

    // The digest is UNCHANGED between rebind and this sync -- no edit happens
    // in between -- so this exercises the digest-unchanged retry branch, not
    // the "changed" branch that already worked.
    const result = syncDocuments(p, SPACE, EVEN_LATER);
    const after = readIndex(p, SPACE).documents.find((r) => r.id === id)!;
    expect(after.extraction.state, "the row must leave invalidated").toBe("extracted");
    expect(result.changes.some((c) => c.id === id && c.change === "retried")).toBe(true);

    const contentPath = join(documentDir(p, SPACE, id), "content.md");
    expect(existsSync(contentPath), "content.md must be regenerated").toBe(true);
    expect(readFileSync(contentPath, "utf-8")).toBe("v2 moved and edited\n");
  });

  test("rebind UN-TOMBSTONES a row: the document is back", () => {
    const p = scratchProject();
    const abs = doc(p, "policy.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    rmSync(abs);
    syncDocuments(p, SPACE, LATER);
    expect(readIndex(p, SPACE).documents[0].removed_at).toBeTruthy();

    const moved = doc(p, "standards.md", "v2\n");
    rebindDocument(p, SPACE, indexed[0].id, moved, LATER);
    expect(readIndex(p, SPACE).documents[0].removed_at).toBeUndefined();
  });

  test("rebind REFUSES to give two rows one file", () => {
    // That would make the second row unreachable by path -- the same collision the
    // write path already refuses.
    const p = scratchProject();
    doc(p, "a.md", "one\n");
    doc(p, "b.md", "two\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const target = join(documentsDir(p, SPACE), "b.md");
    const err = (() => {
      try { rebindDocument(p, SPACE, indexed[0].id, target, LATER); return null; }
      catch (e) { return e as Error; }
    })();
    expect(err?.message).toMatch(/already the source of document/);
    expect(err?.message).toMatch(/nothing was changed/);
  });

  test("rebind refuses a target OUTSIDE documents/", () => {
    const p = scratchProject();
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const outside = join(p, "elsewhere.md");
    writeFileSync(outside, "x\n");
    expect(() => rebindDocument(p, SPACE, indexed[0].id, outside, LATER))
      .toThrow(/outside knowledge\/documents/);
  });

  test("rebind on an unknown id is refused with the remedy named", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md");
    const err = (() => {
      try {
        rebindDocument(p, SPACE, "019fda80-0000-7000-8000-000000000099", abs, LATER);
        return null;
      } catch (e) { return e as Error; }
    })();
    expect(err?.message).toMatch(/No document with id/);
    expect(err?.message).toMatch(/knowledge list/);
  });

  test("rebind emits DOCUMENT_UPDATED naming the change", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    rmSync(abs);
    const moved = doc(p, "b.md", "v2\n");
    rebindDocument(p, SPACE, indexed[0].id, moved, LATER);
    const body = auditBody(p);
    expect(body).toContain("**Change**: rebound");
    expect(body).toContain("**Source**: documents/b.md");
  });
});

/** Is a real pdftotext on PATH? CI has none, so version-sensitive cases branch. */
function probeAvailable(): boolean {
  const r = spawnSync("pdftotext", ["-v"], { encoding: "utf-8" });
  return r.error === undefined;
}

function currentPdftotextVersion(): string {
  const r = spawnSync("pdftotext", ["-v"], { encoding: "utf-8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0] ?? "";
}
