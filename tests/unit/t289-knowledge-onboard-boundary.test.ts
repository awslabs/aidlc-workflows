// covers: function:walkDocuments function:resolveContainedPath function:portableSourcePath function:readDocumentMetadata function:onboard function:looksBinary function:hasPdfMagicInWindow function:decodesAsUtf8 function:hasNulByte function:describeFileKind function:readIndex function:writeIndex function:resolveSpaceFlag function:sha256Hex
//
// t289 - `aidlc-knowledge onboard` and the read boundary it enforces. This is
// the first story that touches the filesystem, so it owns the invariants a pure
// module could not: the recursive walk, per-leaf containment, and all-or-nothing
// batch behaviour.
//
// Mechanism: real filesystem. The fixtures build actual symlink cycles, broken
// symlinks, escaping subtrees, FIFOs, and sibling-impersonating paths, because
// the whole point is what the OS does when a path is not what it claims - a
// mocked stat cannot cycle, and a mocked readdir cannot dangle.
//
// Subject under test: dist/claude/.claude/tools/aidlc-knowledge.ts (the SHIPPED
// distributable). A guard reverted only in core/ still passes when the test
// imports dist, which would fake the "the test observes the defect" conclusion.
//
// The invariants, and the specific failure each one prevents:
//
//   THE WALK. Symlinks are skipped, not followed. Three distinct failures
//   collapse into that one rule: a directory CYCLE would recurse until the stack
//   dies with a raw ELOOP; a BROKEN symlink would throw ENOENT mid-walk so one
//   bad entry aborts an otherwise-fine batch; a subtree symlinked ABOVE
//   documents/ would be walked, silently indexing files from outside the space.
//
//   EVERY LEAF, not just the dir. A walk that validates a container and then
//   trusts its contents will read a symlinked file inside an already-trusted
//   directory. Worse, the earlier line of this work had one poisoned row strand
//   its healthy siblings in the same pass - so a sibling must still index.
//
//   CONTAINMENT AFTER REALPATH. A check on the unresolved path answers "does
//   this look inside?"; only a post-resolution check answers "does it land
//   inside?". The two differ whenever a component can be repointed.
//
//   ALL-OR-NOTHING BATCHES. A pathless onboard scans everything, so it IS a
//   batch. Two collisions reach the same bad end and closing only the first
//   leaves a hole: (a) two entries in one batch, (b) an entry vs a row already
//   in index.json.
//
//   WRITER/READER AGREEMENT. onboard must never emit a row its own reader
//   rejects. This is not hypothetical: the first build wrote
//   `../../../private/tmp/...` into a committed path field because the anchor was
//   unresolved while the file path was resolved, and the index was unreadable the
//   moment it landed.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import * as ts from "typescript";
import {
  decodesAsUtf8,
  describeFileKind,
  documentDir,
  documentkbDir,
  documentsDir,
  hasNulByte,
  hasPdfMagicInWindow,
  indexPath,
  journalDir,
  journalTxnDir,
  looksBinary,
  collectStaleJournals,
  listDocuments,
  onboard,
  rebuildIndex,
  showDocument,
  syncDocuments,
  portableSourcePath,
  readDocumentMetadata,
  readIndex,
  readSourcesLocal,
  resolveLinkedSource,
  rebindDocument,
  setIntentAssociation,
  resolveContainedPath,
  resolveSpaceFlag,
  sha256Hex,
  spaceAuditShardPath,
  walkDocuments,
  writeIndex,
} from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";
import { validateDocumentIndex } from "../../dist/claude/.claude/tools/aidlc-documentkb-schema.ts";

const AIDLC_TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");

const NOW = "2026-08-07T00:00:00Z";
const SPACE = "default";

let proj: string | undefined;

/** A project with a real space tree and a documents/ dir. Returns the project
 *  dir. Deliberately NOT a full workspace fixture: onboard needs only the
 *  knowledge tree, and a narrower fixture makes a failure easier to localise. */
function scratchProject(): string {
  proj = mkdtempSync(join(tmpdir(), "t289-"));
  mkdirSync(documentsDir(proj, SPACE), { recursive: true });
  return proj;
}

function doc(p: string, name: string, body = "text\n"): string {
  const full = join(documentsDir(p, SPACE), name);
  mkdirSync(join(full, "..").replace(/[/\\][^/\\]*$/, "") || ".", { recursive: true });
  mkdirSync(full.slice(0, full.lastIndexOf(sep)), { recursive: true });
  writeFileSync(full, body);
  return full;
}

afterEach(() => {
  if (proj !== undefined) {
    rmSync(proj, { recursive: true, force: true });
    proj = undefined;
  }
});

describe("t289 the walk skips symlinks, which is what makes three failures impossible", () => {
  test("collects regular files recursively, sorted, skipping dotfiles", () => {
    const p = scratchProject();
    doc(p, "b.md");
    doc(p, "a.md");
    doc(p, join("nested", "c.md"));
    doc(p, ".hidden.md");
    const found = walkDocuments(documentsDir(p, SPACE)).map((f) => f.split(sep).pop());
    expect(found).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("a directory symlink CYCLE terminates instead of recursing to death", () => {
    const p = scratchProject();
    doc(p, "real.md");
    const loop = join(documentsDir(p, SPACE), "loop");
    mkdirSync(loop, { recursive: true });
    symlinkSync(loop, join(loop, "self")); // self-referential
    // Without the skip this recurses until the stack dies with a raw ELOOP.
    // Reaching the assertion at all is most of the proof.
    const found = walkDocuments(documentsDir(p, SPACE));
    expect(found.map((f) => f.split(sep).pop())).toEqual(["real.md"]);
  }, 5000);

  test("a two-hop directory cycle also terminates", () => {
    const p = scratchProject();
    doc(p, "real.md");
    const a = join(documentsDir(p, SPACE), "a");
    const b = join(documentsDir(p, SPACE), "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    symlinkSync(b, join(a, "to-b"));
    symlinkSync(a, join(b, "to-a"));
    expect(walkDocuments(documentsDir(p, SPACE)).map((f) => f.split(sep).pop()))
      .toEqual(["real.md"]);
  }, 5000);

  test("a BROKEN symlink is skipped, not fatal — one bad entry must not abort a batch", () => {
    const p = scratchProject();
    doc(p, "good.md");
    symlinkSync(join(p, "nowhere-at-all"), join(documentsDir(p, SPACE), "dangling.md"));
    // lstat succeeds on a dangling link, so this only works because the walk
    // checks isSymbolicLink BEFORE stat-ing the target.
    expect(walkDocuments(documentsDir(p, SPACE)).map((f) => f.split(sep).pop()))
      .toEqual(["good.md"]);
  });

  test("a subtree symlinked ABOVE documents/ is not walked", () => {
    const p = scratchProject();
    doc(p, "inside.md");
    // Something outside the space that must never be indexed.
    const outside = join(p, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), "SECRET-OUTSIDE\n");
    symlinkSync(outside, join(documentsDir(p, SPACE), "escape"));
    const found = walkDocuments(documentsDir(p, SPACE));
    expect(found.map((f) => f.split(sep).pop())).toEqual(["inside.md"]);
    expect(found.join("|")).not.toContain("secret");
  });

  test("aidlc/ and node_modules/ are pruned even as real directories", () => {
    const p = scratchProject();
    doc(p, "keep.md");
    for (const pruned of ["aidlc", "node_modules"]) {
      const d = join(documentsDir(p, SPACE), pruned);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "x.md"), "no\n");
    }
    expect(walkDocuments(documentsDir(p, SPACE)).map((f) => f.split(sep).pop()))
      .toEqual(["keep.md"]);
  });

  test("a missing documents/ dir walks to empty rather than throwing", () => {
    const p = scratchProject();
    expect(walkDocuments(join(p, "no-such-dir"))).toEqual([]);
  });

  test("a named file whose literal name starts with two dots onboards normally", () => {
    const p = scratchProject();
    const abs = doc(p, "..foo", "ordinary file\n");
    const result = onboard(p, SPACE, abs, NOW);
    expect(result.refused).toBeUndefined();
    expect(result.indexed).toHaveLength(1);
    expect(result.indexed[0].path).toBe("documents/..foo");
  });
});

describe("t289 containment is re-checked AFTER realpath", () => {
  test("a clean relative path resolves inside the anchor", () => {
    const p = scratchProject();
    doc(p, join("nested", "c.md"));
    const anchor = documentsDir(p, SPACE);
    expect(resolveContainedPath(anchor, "nested/c.md")).toContain(`nested${sep}c.md`);
  });

  test("lexical escapes are refused before touching the disk", () => {
    const p = scratchProject();
    const anchor = documentsDir(p, SPACE);
    for (const bad of ["../escape", "../../etc/passwd", "a/../../b", "/etc/passwd"]) {
      expect(() => resolveContainedPath(anchor, bad), bad).toThrow(/escapes its anchor/);
    }
  });

  test("SIBLING IMPERSONATION is refused — one row must not read another's bytes", () => {
    // The shape that matters: `<other-id>/../<my-id>/metadata.json` is lexically
    // inside the anchor and resolves inside it too, but it is not the path the
    // row claims. A row reading a sibling's bytes under its own id is the
    // arbitrary-read this boundary exists to prevent.
    const p = scratchProject();
    const kb = documentkbDir(p, SPACE);
    mkdirSync(join(kb, "id-a"), { recursive: true });
    mkdirSync(join(kb, "id-b"), { recursive: true });
    expect(() => resolveContainedPath(kb, "id-b/../id-a/metadata.json"))
      .toThrow(/escapes its anchor/);
  });

  test("a symlink that resolves OUTSIDE the anchor is refused, naming the remedy", () => {
    const p = scratchProject();
    const anchor = documentsDir(p, SPACE);
    const outside = join(p, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "s.md"), "SECRET\n");
    symlinkSync(join(outside, "s.md"), join(anchor, "link.md"));
    const err = (() => {
      try { resolveContainedPath(anchor, "link.md"); return null; } catch (e) { return e as Error; }
    })();
    expect(err).not.toBeNull();
    // A refusal must not leak the target's bytes, and should point at the
    // supported way to reference external material.
    expect(err?.message).not.toContain("SECRET");
  });

  test("a symlinked INTERMEDIATE directory is refused, not just a symlinked leaf", () => {
    const p = scratchProject();
    const anchor = documentsDir(p, SPACE);
    const outside = join(p, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "c.md"), "foreign\n");
    symlinkSync(outside, join(anchor, "mid"));
    expect(() => resolveContainedPath(anchor, "mid/c.md")).toThrow();
  });

  test("a not-yet-existing path is allowed — first write must work", () => {
    const p = scratchProject();
    const anchor = documentsDir(p, SPACE);
    expect(resolveContainedPath(anchor, "brand/new/file.md")).toContain("file.md");
  });
});

describe("t289 portableSourcePath never escapes, even when /tmp is a symlink", () => {
  test("a document under documents/ records a clean relative POSIX path", () => {
    const p = scratchProject();
    const abs = doc(p, join("security", "policy.md"));
    const rel = portableSourcePath(p, SPACE, abs);
    expect(rel).toBe("documents/security/policy.md");
  });

  test("the recorded path has no `..`, no backslash, and is not absolute", () => {
    // THE regression: on macOS /tmp is a symlink to /private/tmp, so subtracting
    // an UNRESOLVED anchor from a RESOLVED file path produced
    // `../../../../../../private/tmp/...` — relative in form, absolute in
    // effect, and rejected by the schema on the very next read.
    const p = scratchProject();
    const abs = doc(p, "a.md");
    const rel = portableSourcePath(p, SPACE, abs);
    expect(rel).not.toContain("..");
    expect(rel).not.toContain("\\");
    expect(rel.startsWith("/")).toBe(false);
    expect(rel).toBe("documents/a.md");
  });

  test("a path OUTSIDE knowledge/ is REFUSED rather than recorded as an escape", () => {
    // The guard, asserted directly: without it this returns
    // `../../outside.md`, which the schema then refuses on read -- so the
    // failure surfaces far from its cause. Refusing at the point of
    // construction names the actual problem.
    const p = scratchProject();
    const outside = join(p, "outside.md");
    writeFileSync(outside, "SECRET\n");
    const err = (() => {
      try { portableSourcePath(p, SPACE, outside); return null; } catch (e) { return e as Error; }
    })();
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/refusing to record a source path outside/);
    expect(err?.message).not.toContain("SECRET");
  });

  test("the space's own knowledge/ root subtracts to an empty path, not an escape", () => {
    // Boundary case: the anchor itself. `relative(x, x)` is "", which must not
    // be mistaken for an escape by a naive startsWith("..") check.
    const p = scratchProject();
    expect(portableSourcePath(p, SPACE, join(documentsDir(p, SPACE), ".."))).toBe("");
  });
});

describe("t289 onboard writes rows its own reader accepts", () => {
  test("a fresh onboard indexes every file and reports `fresh`", () => {
    const p = scratchProject();
    doc(p, "a.md");
    doc(p, join("security", "policy.md"));
    const result = onboard(p, SPACE, undefined, NOW);
    expect(result.refused).toBeUndefined();
    expect(result.indexed.map((r) => r.path).sort())
      .toEqual(["documents/a.md", "documents/security/policy.md"]);
    expect(new Set(result.indexed.map((r) => r.status))).toEqual(new Set(["fresh"]));
  });

  test("the written index VALIDATES — writer and reader agree", () => {
    // The bug this pins: onboard wrote a row that validateDocumentIndex refused,
    // so the index was unreadable immediately after being written. Assert on the
    // BYTES on disk, not on the in-memory value.
    const p = scratchProject();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const raw = JSON.parse(readFileSync(indexPath(p, SPACE), "utf-8"));
    const check = validateDocumentIndex(raw);
    expect(check.ok, check.ok ? "" : check.errors.join("; ")).toBe(true);
    expect(readIndex(p, SPACE).documents.length).toBe(1);
  });

  test("writeIndex REFUSES a row this release cannot read back", () => {
    // The guard that turns a silent corruption into a located failure.
    const p = scratchProject();
    const bad = {
      schema_version: 1,
      documents: [{
        id: "019fda80-8f8d-7bfa-b56c-983cf0353faa",
        source: { kind: "managed", path: "../../../../escape" },
        sha256: "a".repeat(64),
        bytes: 1,
        indexed_at: NOW,
        extraction: { state: "extractor_unavailable", extractor: { name: "pdftotext" } },
        summary: { state: "absent" },
      }],
    };
    expect(() => writeIndex(p, SPACE, bad as never))
      .toThrow(/refusing to write an index this release cannot read back/);
    expect(existsSync(indexPath(p, SPACE))).toBe(false);
  });

  test("a re-onboard reports `already`, and does not duplicate the row", () => {
    // A silent no-op that looks like success is a data-loss bug: the operator
    // cannot tell "already indexed" from "freshly written".
    const p = scratchProject();
    doc(p, "a.md");
    const first = onboard(p, SPACE, undefined, NOW);
    const second = onboard(p, SPACE, undefined, NOW);
    expect(first.indexed[0].status).toBe("fresh");
    expect(second.indexed[0].status).toBe("already");
    expect(second.indexed[0].id).toBe(first.indexed[0].id); // identity survives
    expect(readIndex(p, SPACE).documents.length).toBe(1);
  });

  test("every indexed document gets a metadata.json carrying the untrusted framing", () => {
    const p = scratchProject();
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const meta = readDocumentMetadata(p, SPACE, indexed[0].id);
    expect(meta.content_trust).toBe("untrusted");
    expect(meta.content_handling).toBe("data-not-instructions");
    expect(meta.source.path).toBe("documents/a.md");
  });

  test("the digest recorded is the digest of the bytes on disk", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "exact-bytes\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    expect(indexed[0].sha256).toBe(sha256Hex(readFileSync(abs)));
    expect(indexed[0].bytes).toBe(readFileSync(abs).length);
  });

  test("a single-path onboard indexes only that file", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md");
    doc(p, "b.md");
    const result = onboard(p, SPACE, abs, NOW);
    expect(result.indexed.map((r) => r.path)).toEqual(["documents/a.md"]);
  });

  test("a path OUTSIDE documents/ is refused with the remedy named", () => {
    const p = scratchProject();
    const outside = join(p, "elsewhere.md");
    writeFileSync(outside, "x\n");
    expect(() => onboard(p, SPACE, outside, NOW)).toThrow(/outside|Copy it under/);
  });

  test("a missing documents/ dir refuses with a runnable remedy", () => {
    proj = mkdtempSync(join(tmpdir(), "t289-"));
    const err = (() => {
      try { onboard(proj!, SPACE, undefined, NOW); return null; } catch (e) { return e as Error; }
    })();
    // The message must contain the command that fixes it, not just the problem.
    expect(err?.message).toMatch(/mkdir -p/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE IDENTITY MECHANISM this closes: onboard's identity for a re-onboarded
// document is evidenced by `source.path` MATCHING a LIVE (non-tombstoned) row
// -- never by content, never by minting a fresh id whenever the digest moved.
// `sync` already had this rule right for its own "changed" case; onboard's
// unchanged-digest shortcut checked the digest FIRST and fell through to
// `buildRow` (a fresh uuid) the instant it differed, so a same-path EDIT
// created a SECOND, independent row instead of refreshing the first.
//
// Reproduced on the shipped tool before this fix: onboard `documents/a.md`,
// edit it, onboard `documents/a.md` again -> index.json held TWO rows, BOTH
// with `source.path: "documents/a.md"`, NEITHER tombstoned -- exactly the
// state `rebindDocument`'s own doc comment calls invalid.
// ─────────────────────────────────────────────────────────────────────────────
describe("t289 a same-path EDIT refreshes the existing row -- it never mints a second one", () => {
  test("editing the file and re-onboarding the SAME path keeps ONE row, same id, new digest", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1\n");
    const first = onboard(p, SPACE, undefined, NOW);
    expect(first.indexed[0].status).toBe("fresh");
    const id = first.indexed[0].id;
    const firstDigest = first.indexed[0].sha256;

    writeFileSync(abs, "v2 edited\n");
    const second = onboard(p, SPACE, abs, "2026-08-08T00:00:00Z");

    expect(second.refused).toBeUndefined();
    expect(second.indexed[0].status).toBe("edited");
    expect(second.indexed[0].id).toBe(id);
    expect(second.indexed[0].sha256).not.toBe(firstDigest);

    // The invariant this defends: ONE row for this path, never two.
    const rows = readIndex(p, SPACE).documents.filter((r) => r.source.path === "documents/a.md");
    expect(rows.length, "an edited-then-reonboarded path must never produce a second row").toBe(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].sha256).toBe(second.indexed[0].sha256);
  });

  test("a pathless (batch) re-onboard after an edit also refreshes in place", () => {
    // The bug reproduced specifically through a PATHLESS onboard -- the sweep a
    // user actually runs -- not just a single-path re-onboard.
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1\n");
    const first = onboard(p, SPACE, undefined, NOW);
    const id = first.indexed[0].id;

    writeFileSync(abs, "v2\n");
    const second = onboard(p, SPACE, undefined, "2026-08-08T00:00:00Z");
    expect(second.indexed.map((o) => o.status)).toEqual(["edited"]);
    expect(second.indexed[0].id).toBe(id);
    expect(readIndex(p, SPACE).documents.length).toBe(1);
  });

  test("the row's metadata.json and content.md are refreshed, not left stale, and no second directory is created", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1 original text\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;

    writeFileSync(abs, "v2 replaced text\n");
    onboard(p, SPACE, abs, "2026-08-08T00:00:00Z");

    const meta = readDocumentMetadata(p, SPACE, id);
    expect(meta.sha256).toBe(sha256Hex(readFileSync(abs)));
    const contentPath = join(documentDir(p, SPACE, id), "content.md");
    expect(existsSync(contentPath)).toBe(true);
    expect(readFileSync(contentPath, "utf-8")).toContain("v2 replaced text");
    // No sibling directory was created for a phantom second id.
    expect(readdirSync(documentkbDir(p, SPACE)).filter((e) => e !== "index.json" && !e.startsWith(".")))
      .toEqual([id]);
  });

  test("a tombstoned row at the path does NOT absorb a new file dropped into its place", () => {
    // The path match is scoped to a LIVE row. A file removed and then replaced
    // by an unrelated document at the same name must mint its OWN identity,
    // exactly like `sync` already does for that case -- reusing the tombstone's
    // id would attach the wrong citation history to the new content.
    const p = scratchProject();
    const abs = doc(p, "a.md", "original\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const oldId = indexed[0].id;
    rmSync(abs);
    syncDocuments(p, SPACE, "2026-08-08T00:00:00Z");
    expect(readIndex(p, SPACE).documents[0].removed_at).toBeTruthy();

    doc(p, "a.md", "unrelated new content\n");
    const result = onboard(p, SPACE, undefined, "2026-08-09T00:00:00Z");
    expect(result.indexed[0].status).toBe("fresh");
    expect(result.indexed[0].id).not.toBe(oldId);
    const rows = readIndex(p, SPACE).documents;
    expect(rows.length).toBe(2); // the tombstone AND the new row, both present
  });

  test("editing while intent-scoped keeps the scope: --intent on an edit does not drop related_intent_ids", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1\n");
    const first = onboard(p, SPACE, undefined, NOW, "019fda80-0000-7000-8000-000000000001");
    expect(first.indexed[0].id).toBeTruthy();

    writeFileSync(abs, "v2\n");
    onboard(p, SPACE, abs, "2026-08-08T00:00:00Z");
    const row = readIndex(p, SPACE).documents[0];
    expect(row.related_intent_ids).toEqual(["019fda80-0000-7000-8000-000000000001"]);
  });

  test("DOCUMENT_UPDATED, not DOCUMENT_INDEXED, is emitted for an onboard-driven edit", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1\n");
    onboard(p, SPACE, undefined, NOW);
    writeFileSync(abs, "v2\n");
    onboard(p, SPACE, abs, "2026-08-08T00:00:00Z");
    const body = readFileSync(spaceAuditShardPath(p, SPACE), "utf-8");
    expect(body).toContain("**Event**: DOCUMENT_UPDATED");
    expect(body).toContain("**Change**: edited");
  });

  // Finding 6: onboard's edited-row publish order. `sync`'s commit writes
  // index.json (and every row's metadata.json) BEFORE any content.md -- its
  // own comment explains why: `show` reads sha256/extraction/content from
  // index.json ALONE and gates the text on `derivativeIsCurrent`
  // (extraction.source_revision === sha256). `onboard`'s edited-row branch
  // had the OPPOSITE order. Proved here the same way the report proved it:
  // make content.md's WRITE fail (a directory pre-placed at that exact leaf,
  // same technique as t287's write-failure-injection test) and confirm the
  // row's digest already advanced in index.json while its content is
  // WITHHELD, not served stale-but-labelled-current.
  test("a content.md write failure leaves the row's digest advanced but its content WITHHELD, never stale-exposed", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "v1 original\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const dir = documentDir(p, SPACE, id);
    const originalDigest = indexed[0].sha256;

    writeFileSync(abs, "v2 edited, longer text than v1\n");
    rmSync(join(dir, "content.md"), { force: true });
    mkdirSync(join(dir, "content.md"));

    // The content write throws (EISDIR); onboard's own outer catch surfaces
    // it as a thrown error, not a silent partial success.
    expect(() => onboard(p, SPACE, abs, "2026-08-08T00:00:00Z")).toThrow();

    // THE FIX: index.json's digest already advanced -- proving metadata was
    // published BEFORE the content write was even attempted, not after.
    const row = readIndex(p, SPACE).documents.find((r) => r.id === id)!;
    expect(row.sha256, "index.json must have committed the new digest").not.toBe(originalDigest);

    const withheld = showDocument(p, SPACE, id);
    expect(withheld.state).toBe("invalidated");
    expect(withheld.content).toBeUndefined();

    rmSync(join(dir, "content.md"), { recursive: true, force: true });
    const repaired = onboard(p, SPACE, abs, "2026-08-08T00:00:00Z");
    expect(repaired.indexed[0].status).toBe("edited");
    expect(showDocument(p, SPACE, id).content).toBe("v2 edited, longer text than v1\n");
  });
});

describe("t289 non-regular files: SKIPPED by the walk, REFUSED when named", () => {
  // Two different answers for two different questions, and the asymmetry is
  // deliberate. A pathless run is a bulk scan of a directory the USER owns, so
  // one odd entry must not block the batch -- the walk takes regular files only.
  // But a path the user NAMED is an explicit request, and silently doing nothing
  // with it would be the data-loss-shaped no-op the design forbids.
  test("the walk SKIPS a FIFO, so one odd entry cannot block a batch", () => {
    const p = scratchProject();
    doc(p, "a.md");
    const fifo = join(documentsDir(p, SPACE), "pipe");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // mkfifo unavailable on this platform
    }
    expect(walkDocuments(documentsDir(p, SPACE)).map((f) => f.split(sep).pop())).toEqual(["a.md"]);
    const result = onboard(p, SPACE, undefined, NOW);
    expect(result.refused).toBeUndefined();
    expect(result.indexed.map((r) => r.path)).toEqual(["documents/a.md"]);
  }, 5000);

  test("a FIFO named DIRECTLY is refused, naming the kind and why", () => {
    const p = scratchProject();
    const fifo = join(documentsDir(p, SPACE), "pipe");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return;
    }
    const result = onboard(p, SPACE, fifo, NOW);
    expect(result.refused?.path).toBe("pipe");
    // The reason must say WHAT it is and WHY that is refused, or the operator
    // cannot tell a bug from a boundary.
    expect(result.refused?.reason).toMatch(/FIFO/);
    expect(result.refused?.reason).toMatch(/block forever|never reach EOF/);
    expect(result.indexed).toEqual([]);
    expect(existsSync(indexPath(p, SPACE))).toBe(false);
  }, 5000);
});

describe("t289 a batch is ALL-OR-NOTHING", () => {
  test("a mid-batch refusal lands NOTHING, not the rows that came first", () => {
    // The regression shape: an earlier valid row lands, a later entry is
    // rejected, and the index is left half-applied. Ordering matters -- `a.md`
    // sorts before the bad entry, so it would have been written first.
    //
    // The refusing candidate is an OVER-CAP file the walk genuinely visits (a
    // sparse truncate: st.size is over the 32 MiB per-document cap, no bytes
    // written or read). An earlier version of this test planted a symlink,
    // which the walk silently SKIPS -- the batch succeeded and the test named
    // a refusal it never produced.
    const p = scratchProject();
    doc(p, "a.md");
    const bad = join(documentsDir(p, SPACE), "zz-bad.md");
    writeFileSync(bad, "");
    truncateSync(bad, 33 * 1024 * 1024);

    const result = onboard(p, SPACE, undefined, NOW);
    expect(result.refused?.path).toBe("zz-bad.md");
    expect(result.refused?.reason).toMatch(/per-document cap/);
    // The whole batch is refused: a.md sorted first, was read first, and still
    // must NOT have landed.
    expect(result.indexed).toEqual([]);
    expect(existsSync(indexPath(p, SPACE))).toBe(false);
  });

  test("a pre-existing index survives a refused batch BYTE-IDENTICALLY", () => {
    const p = scratchProject();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    const before = readFileSync(indexPath(p, SPACE), "utf-8");
    // Name a FIFO directly: a refusal on an explicit path must not rewrite the
    // index, not even to reorder or reformat it.
    const fifo = join(documentsDir(p, SPACE), "pipe");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return;
    }
    const result = onboard(p, SPACE, fifo, NOW);
    expect(result.refused).toBeDefined();
    expect(readFileSync(indexPath(p, SPACE), "utf-8")).toBe(before);
  }, 5000);

  test("route (b): an id colliding with a PRE-EXISTING index row refuses the batch whole", () => {
    // The route an earlier line of this work MISSED: it shipped the in-batch
    // uniqueness check and still stranded a row through this one. Same fixed-id
    // subprocess as route (a), but run TWICE -- the first run populates the
    // index with the fixed id, so the second run collides against a row that is
    // already on disk rather than against a sibling in its own batch.
    const p = scratchProject();
    doc(p, "a.md");
    const driver = join(p, "collide-b.ts");
    writeFileSync(
      driver,
      `import { mock } from "bun:test";\n` +
        `const libPath = ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-lib.ts"))};\n` +
        `const lib = await import(libPath);\n` +
        `mock.module(libPath, () => ({ ...lib, uuidv7: () => "019fda80-8f8d-7bfa-b56c-983cf0353faa" }));\n` +
        `const kb = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))});\n` +
        // Run 1: lands one row carrying the fixed id.
        `const first = kb.onboard(${JSON.stringify(p)}, ${JSON.stringify(SPACE)}, undefined, ${JSON.stringify(NOW)});\n` +
        // Add a SECOND source, then re-run: it is unindexed, so a fresh row is
        // built -- and its id collides with the row run 1 already wrote.
        `require("node:fs").writeFileSync(${JSON.stringify(join("PLACEHOLDER"))}, "second\\n");\n` +
        `const second = kb.onboard(${JSON.stringify(p)}, ${JSON.stringify(SPACE)}, undefined, ${JSON.stringify(NOW)});\n` +
        `process.stdout.write(JSON.stringify({ first, second }));\n`,
    );
    // Patch the placeholder to a real second document path.
    const secondDoc = join(documentsDir(p, SPACE), "zz-second.md");
    writeFileSync(driver, readFileSync(driver, "utf-8").replace("PLACEHOLDER", secondDoc));
    const out = execFileSync("bun", ["test", driver], {
      encoding: "utf-8",
      env: { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" },
    });
    const { first, second } = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    // Run 1 succeeded, so there IS a pre-existing row to collide with.
    expect(first.refused).toBeUndefined();
    expect(first.indexed.length).toBe(1);
    // Run 2 collided against the on-disk row, not against a batch sibling.
    expect(second.refused, "a collision with a pre-existing row must refuse").toBeDefined();
    expect(second.refused.reason).toMatch(/already exists in index\.json/);
    expect(second.indexed).toEqual([]);
    // And the index still holds exactly run 1's single row -- no partial apply.
    expect(readIndex(p, SPACE).documents.length).toBe(1);
  }, 30000);

  test("route (a): two entries in ONE batch sharing an id refuse the batch whole", () => {
    // Ids come from a real UUID generator, so a natural collision cannot be
    // provoked -- the id source has to be replaced. Two approaches were tried
    // and rejected before this one: reassigning the exported `uuidv7` does not
    // reach the binding `onboard` captured at import, and `mock.module` DOES
    // reach it but leaks the mocked module into every sibling test in the file
    // (it broke two unrelated cases). So the collision runs in a SUBPROCESS,
    // where the patch cannot escape.
    const p = scratchProject();
    doc(p, "a.md");
    doc(p, "b.md");
    const driver = join(p, "collide.ts");
    writeFileSync(
      driver,
      `import { mock } from "bun:test";\n` +
        `const libPath = ${JSON.stringify(join(AIDLC_TOOLS, "aidlc-lib.ts"))};\n` +
        `const lib = await import(libPath);\n` +
        `mock.module(libPath, () => ({ ...lib, uuidv7: () => "019fda80-8f8d-7bfa-b56c-983cf0353faa" }));\n` +
        `const kb = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))});\n` +
        `const r = kb.onboard(${JSON.stringify(p)}, ${JSON.stringify(SPACE)}, undefined, ${JSON.stringify(NOW)});\n` +
        `process.stdout.write(JSON.stringify(r));\n`,
    );
    const out = execFileSync("bun", ["test", driver], {
      encoding: "utf-8",
      env: { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" },
    });
    const result = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    expect(result.refused, "a same-id batch must be refused whole").toBeDefined();
    expect(result.refused.reason).toMatch(/duplicate document id/);
    expect(result.indexed).toEqual([]);
    // The valid EARLIER candidate must not have landed: all-or-nothing means no
    // index file at all when the very first batch is refused.
    expect(existsSync(indexPath(p, SPACE))).toBe(false);
  }, 20000);

  test("a directory named directly onboards its contents, not itself", () => {
    const p = scratchProject();
    doc(p, join("security", "policy.md"));
    doc(p, join("security", "standards.md"));
    doc(p, "elsewhere.md");
    const result = onboard(p, SPACE, join(documentsDir(p, SPACE), "security"), NOW);
    expect(result.indexed.map((r) => r.path).sort())
      .toEqual(["documents/security/policy.md", "documents/security/standards.md"]);
  });

  test("21 already-indexed files are not counted as pathless onboard work", () => {
    const p = scratchProject();
    const indexedAt = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 21; i++) {
      const abs = doc(p, `existing-${i}.md`, `body ${i}\n`);
      onboard(p, SPACE, abs, indexedAt);
    }
    const result = onboard(p, SPACE, undefined, indexedAt);
    expect(result.refused).toBeUndefined();
    expect(result.indexed).toHaveLength(21);
    expect(result.indexed.every((row) => row.status === "already")).toBe(true);
  });

  test("21 new files are refused as 21 work items and nothing is indexed", () => {
    const p = scratchProject();
    for (let i = 0; i < 21; i++) doc(p, `new-${i}.md`, `body ${i}\n`);
    expect(() => onboard(p, SPACE, undefined, NOW))
      .toThrow(/would index 21 new or changed documents/);
    expect(existsSync(indexPath(p, SPACE))).toBe(false);
  });

  test("20 new files plus three already-indexed files stay within the work cap", () => {
    const p = scratchProject();
    const indexedAt = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 3; i++) {
      const abs = doc(p, `existing-${i}.md`, `existing ${i}\n`);
      onboard(p, SPACE, abs, indexedAt);
    }
    for (let i = 0; i < 20; i++) doc(p, `new-${i}.md`, `new ${i}\n`);
    const result = onboard(p, SPACE, undefined, indexedAt);
    expect(result.refused).toBeUndefined();
    expect(result.indexed.filter((row) => row.status === "fresh")).toHaveLength(20);
    expect(result.indexed.filter((row) => row.status === "already")).toHaveLength(3);
  });
});

describe("t289 one poisoned row does not strand its healthy siblings", () => {
  test("a symlinked metadata.json leaf is refused while a sibling still reads", () => {
    // #660's actual regression: the check exited on a symlinked leaf, so the
    // prescribed remedy failed AND one poisoned row stranded healthy siblings in
    // the same walk. Both halves are asserted here.
    const p = scratchProject();
    doc(p, "a.md");
    doc(p, "b.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    expect(indexed.length).toBe(2);
    const [first, second] = indexed;

    const secret = join(p, "secret.json");
    writeFileSync(secret, JSON.stringify({ schema_version: 1, stolen: "SECRET-BYTES" }));
    const metaPath = join(documentkbDir(p, SPACE), first.id, "metadata.json");
    rmSync(metaPath);
    symlinkSync(secret, metaPath);

    const err = (() => {
      try { readDocumentMetadata(p, SPACE, first.id); return null; } catch (e) { return e as Error; }
    })();
    expect(err).not.toBeNull();
    expect(err?.message).not.toContain("SECRET-BYTES");

    // THE SIBLING HALF: the healthy row must still be readable.
    expect(readDocumentMetadata(p, SPACE, second.id).id).toBe(second.id);
  });

  test("a hand-corrupted metadata.json fails closed WITHOUT being rewritten", () => {
    const p = scratchProject();
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const metaPath = join(documentkbDir(p, SPACE), indexed[0].id, "metadata.json");
    writeFileSync(metaPath, JSON.stringify({ schema_version: 99, id: "nope" }));
    const before = readFileSync(metaPath, "utf-8");
    expect(() => readDocumentMetadata(p, SPACE, indexed[0].id)).toThrow(/schema_version|NOT rewritten/);
    expect(readFileSync(metaPath, "utf-8")).toBe(before);
  });

  test("a non-JSON metadata.json names the file rather than dumping a parse trace", () => {
    const p = scratchProject();
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const metaPath = join(documentkbDir(p, SPACE), indexed[0].id, "metadata.json");
    writeFileSync(metaPath, "{not json");
    expect(() => readDocumentMetadata(p, SPACE, indexed[0].id))
      .toThrow(/metadata\.json is not valid JSON/);
  });

  test("a corrupted index.json fails closed and is NOT rewritten", () => {
    const p = scratchProject();
    doc(p, "a.md");
    onboard(p, SPACE, undefined, NOW);
    writeFileSync(indexPath(p, SPACE), JSON.stringify({ schema_version: 1, documents: "nope" }));
    const before = readFileSync(indexPath(p, SPACE), "utf-8");
    expect(() => readIndex(p, SPACE)).toThrow(/NOT rewritten|must be an array/);
    expect(readFileSync(indexPath(p, SPACE), "utf-8")).toBe(before);
  });

  test("a missing index.json reads as EMPTY, not as an error", () => {
    // A space that has never indexed anything is a normal state, and `sync` must
    // be able to rebuild from nothing.
    const p = scratchProject();
    expect(readIndex(p, SPACE).documents).toEqual([]);
  });
});

describe("t289 space resolution is pinned at entry", () => {
  test("an invalid --space is refused before any path is built", () => {
    const p = scratchProject();
    for (const bad of ["../../etc", "/abs", "Upper", "9lead", "has space"]) {
      expect(() => resolveSpaceFlag(bad, p), bad).toThrow(/Invalid --space/);
    }
  });

  test("an unknown but well-formed space is refused, and the tool never creates one", () => {
    const p = scratchProject();
    const err = (() => {
      try { resolveSpaceFlag("no-such-space", p); return null; } catch (e) { return e as Error; }
    })();
    expect(err?.message).toMatch(/Unknown space/);
    // The remedy must be explicit: this tool is not allowed to invent a space.
    expect(err?.message).toMatch(/never creates a space/);
  });
});

describe("t289 content sniffing reads the WHOLE buffer", () => {
  test("plain UTF-8 text is not binary", () => {
    expect(looksBinary(Buffer.from("hello\nworld\n"))).toBe(false);
    expect(looksBinary(Buffer.from("héllo — em dash and accents\n"))).toBe(false);
  });

  test("a NUL anywhere disqualifies text, including late in the buffer", () => {
    // A windowed check guarantees only the window. Late-buffer placement is the
    // case that escaped an 8-KiB probe.
    expect(hasNulByte(Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0])]))).toBe(true);
    expect(looksBinary(Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0])]))).toBe(true);
  });

  test("high bytes late in the buffer are caught, not just early ones", () => {
    // 9,000 ASCII bytes then 50,000 0xff bytes passed a window probe and came
    // back as text with 50,000 replacement characters.
    const buf = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.alloc(50000, 0xff)]);
    expect(decodesAsUtf8(buf)).toBe(false);
    expect(looksBinary(buf)).toBe(true);
  });

  test("a PDF is detected at offset 0 AND past it", () => {
    // ISO 32000 permits a header preceded by garbage, and real generators emit
    // it, so a fixed-offset check misses genuine PDFs.
    const magic = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(hasPdfMagicInWindow(magic)).toBe(true);
    expect(hasPdfMagicInWindow(Buffer.concat([Buffer.from("\n\n﻿"), magic]))).toBe(true);
    expect(looksBinary(Buffer.concat([Buffer.alloc(200, 0x20), magic]))).toBe(true);
    // Past the window it is no longer treated as a PDF header.
    expect(hasPdfMagicInWindow(Buffer.concat([Buffer.alloc(2000, 0x20), magic]))).toBe(false);
  });

  test("zip-family, JPEG, PNG and GZIP magics are detected at offset 0", () => {
    const cases: [string, number[]][] = [
      ["zip", [0x50, 0x4b, 0x03, 0x04]],
      ["empty zip", [0x50, 0x4b, 0x05, 0x06]],
      ["jpeg", [0xff, 0xd8, 0xff]],
      ["png", [0x89, 0x50, 0x4e, 0x47]],
      ["gzip", [0x1f, 0x8b]],
    ];
    for (const [name, magic] of cases) {
      expect(looksBinary(Buffer.from([...magic, 0x41, 0x41])), name).toBe(true);
    }
  });

  test("an empty buffer is not binary", () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });

  test("describeFileKind names each kind so a refusal is actionable", () => {
    const kinds = [
      ["isFIFO", "a FIFO / named pipe"],
      ["isSocket", "a socket"],
      ["isCharacterDevice", "a character device"],
      ["isBlockDevice", "a block device"],
      ["isDirectory", "a directory"],
    ] as const;
    for (const [flag, expected] of kinds) {
      const st = {
        isFIFO: () => flag === "isFIFO",
        isSocket: () => flag === "isSocket",
        isCharacterDevice: () => flag === "isCharacterDevice",
        isBlockDevice: () => flag === "isBlockDevice",
        isDirectory: () => flag === "isDirectory",
      };
      expect(describeFileKind(st), flag).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TRUST ANCHOR: the guarded directories THEMSELVES replaced by a symlink.
//
// Every other test in this file replaces something INSIDE `documents/` or INSIDE
// `documentkb/<id>/`. That left the CONTAINERS unguarded, and the whole-slice
// review on 2026-08-08 measured the consequence against the shipped tool:
//
//   documentkb -> /tmp/elsewhere   `onboard` wrote index.json, metadata.json,
//                                  content.md and source.sha256 OUTSIDE the
//                                  project. Exit 0, no warning.
//   documentkb -> documents        the derived catalog landed INSIDE the user's
//                                  own documents/ folder -- the one directory
//                                  this tool promises never to reorganise.
//
// So this is the CLASS, not one case: both containers (`knowledge/` and
// `documentkb/`), pointed inward and outward. Driven through the CLI because the
// anchor is checked per command handler -- an in-process `onboard()` call skips
// the very code under test.
//
// Each case asserts TWO things: a non-zero exit AND that nothing was written to
// the target. Exit code alone would pass a tool that refused loudly after it had
// already leaked the catalog.
// ─────────────────────────────────────────────────────────────────────────────
// How to CALL each disk-touching export. Only the arguments live here — which
// functions must appear is derived from the module source by the completeness test
// below, so forgetting an entry fails the suite instead of silently shrinking the
// guarded set.
const DISK_TOUCHING_CALLS: Record<string, (p: string) => unknown> = {
  onboard: (p) => onboard(p, SPACE, undefined, "2026-08-07T00:00:00Z"),
  syncDocuments: (p) => syncDocuments(p, SPACE, "2026-08-07T00:00:00Z"),
  listDocuments: (p) => listDocuments(p, SPACE),
  showDocument: (p) => showDocument(p, SPACE, "any-id"),
  rebuildIndex: (p) => rebuildIndex(p, SPACE),
  collectStaleJournals: (p) => collectStaleJournals(p, SPACE),
  readIndex: (p) => readIndex(p, SPACE),
  readDocumentMetadata: (p) => readDocumentMetadata(p, SPACE, "any-id"),
  // Both read `.sources.local.json`, a SIBLING of documentkb/ under the same
  // knowledge/ container. Reclassified out of PURE_PATH_BUILDERS after review
  // reproduced an attacker-authored alias map being returned, and a linked
  // document resolving into an attacker-controlled root.
  readSourcesLocal: (p) => readSourcesLocal(p, SPACE),
  resolveLinkedSource: (p) =>
    resolveLinkedSource(p, SPACE, {
      source: { kind: "linked", alias: "corp", path: "x.txt" },
    } as never),
  // Looks like a pure string function; its realpathOrSelf is existsSync +
  // realpathSync on a knowledge/-derived anchor. Classified pure for five rounds
  // on the strength of its own comment.
  portableSourcePath: (p) => portableSourcePath(p, SPACE, join(documentsDir(p, SPACE), "x.md")),
  writeIndex: (p) => writeIndex(p, SPACE, { schema_version: 1, documents: [] }),
  setIntentAssociation: (p) =>
    setIntentAssociation(p, SPACE, "any-id", "any-uuid", "associate"),
  rebindDocument: (p) =>
    rebindDocument(p, SPACE, "any-id", "documents/x.md", "2026-08-07T00:00:00Z"),
  journalDir: (p) => journalDir(p, SPACE),
  journalTxnDir: (p) => journalTxnDir(p, SPACE, "txn"),
  documentDir: (p) => documentDir(p, SPACE, "document-id"),
};

describe("t289 the trust anchor: a redirected CONTAINER is refused", () => {
  let target: string | undefined;

  afterEach(() => {
    if (target) rmSync(target, { recursive: true, force: true });
    target = undefined;
  });

  function knowledgeCli(p: string, ...args: string[]) {
    return spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), ...args, "--project-dir", p],
      { encoding: "utf-8", env: { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" } },
    );
  }

  function outsideTarget(): string {
    target = mkdtempSync(join(tmpdir(), "t289-outside-"));
    return target;
  }

  /** A project whose `knowledge/` or `knowledge/documentkb/` is a symlink to `dest`. */
  function withRedirectedContainer(name: "knowledge" | "documentkb", dest: string): string {
    const p = mkdtempSync(join(tmpdir(), "t289-anchor-"));
    proj = p;
    if (name === "documentkb") {
      mkdirSync(documentsDir(p, SPACE), { recursive: true });
      writeFileSync(join(documentsDir(p, SPACE), "mine.txt"), "the user's own file\n");
      symlinkSync(dest, documentkbDir(p, SPACE));
    } else {
      mkdirSync(join(p, "aidlc", "spaces", SPACE), { recursive: true });
      symlinkSync(dest, join(p, "aidlc", "spaces", SPACE, "knowledge"));
    }
    writeFileSync(join(p, "aidlc", "active-space"), `${SPACE}\n`);
    return p;
  }

  for (const container of ["documentkb", "knowledge"] as const) {
    test(`${container} symlinked OUTSIDE the project: refused, and nothing lands there`, () => {
      const dest = outsideTarget();
      const p = withRedirectedContainer(container, dest);
      const r = knowledgeCli(p, "onboard");
      expect(r.status, `expected a refusal, got stdout: ${r.stdout}`).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/symlink/i);
      // The decisive assertion: a tool that refused only AFTER writing would
      // satisfy the exit code and still have leaked the catalog off-project.
      expect(readdirSync(dest)).toEqual([]);
    });
  }

  test("documentkb symlinked INWARD at documents/: refused, user's folder untouched", () => {
    // The nastiest shape, because the target is the user's own data. Before the
    // anchor this wrote .journal/, <uuid>/ and index.json in among their files.
    const p = mkdtempSync(join(tmpdir(), "t289-anchor-"));
    proj = p;
    mkdirSync(documentsDir(p, SPACE), { recursive: true });
    writeFileSync(join(documentsDir(p, SPACE), "mine.txt"), "the user's own file\n");
    writeFileSync(join(p, "aidlc", "active-space"), `${SPACE}\n`);
    symlinkSync("documents", documentkbDir(p, SPACE));

    const r = knowledgeCli(p, "onboard");
    expect(r.status).not.toBe(0);
    // Exactly what the user put there, with nothing generated beside it.
    expect(readdirSync(documentsDir(p, SPACE)).sort()).toEqual(["mine.txt"]);
  });

  test("every verb is anchored, not just onboard", () => {
    // The guard lives per handler, so a verb added later can forget it. Pin the
    // whole surface rather than the one command that happened to be exploited.
    const dest = outsideTarget();
    const p = withRedirectedContainer("documentkb", dest);
    for (const verb of ["onboard", "sync", "list", "show"]) {
      const args = verb === "show" ? [verb, "some-id"] : [verb];
      const r = knowledgeCli(p, ...args);
      expect(r.status, `${verb} was NOT refused`).not.toBe(0);
      expect(r.stdout + r.stderr, `${verb} refused for the wrong reason`).toMatch(/symlink/i);
    }
    expect(readdirSync(dest)).toEqual([]);
  });

  // Every export taking `(projectDir, space)`, read from the module's own SOURCE
  // rather than typed out here. That is the whole point: this defect class has now
  // recurred FOUR times -- the CLI handlers, then the six entry points, then
  // rebuildIndex/collectStaleJournals/writeIndex, then readIndex/
  // readDocumentMetadata -- and every round fixed the names someone remembered and
  // left the next sibling open. A hand-written list cannot fail when a case is
  // ADDED, so a list was never going to end this, however long it grew.
  //
  // Deliberately reads core/, not dist/, here: this block CLASSIFIES exports
  // (which functions exist and what they're named), a source-shape question the
  // packager copies byte-for-byte, so core/ and dist/ agree on it by
  // construction. The BEHAVIOURAL assertions elsewhere in this file (the actual
  // walk/containment/write tests) still spawn dist/claude/.claude/tools/
  // aidlc-knowledge.ts per the file header -- a core/-only revert of the guard
  // itself would still be caught there, which is what makes this split safe.
  const KNOWLEDGE_SRC = readFileSync(
    join(import.meta.dir, "..", "..", "core", "tools", "aidlc-knowledge.ts"),
    "utf-8",
  );
  function exportsTakingProjectDirAndSpace(): string[] {
    const found: string[] = [];
    for (const m of KNOWLEDGE_SRC.matchAll(/^export function (\w+)\(([^)]*)\)/gms)) {
      const [, name, args] = m;
      if (/projectDir/.test(args) && /\bspace\b/.test(args)) found.push(name);
    }
    return found;
  }

  // The functions that only COMPOSE a path string: no lstat, no read, no write, so
  // nothing to redirect. Named individually because "it looked harmless" is the
  // reasoning that failed four times -- each entry here is a claim that the body
  // touches no disk, and the completeness test below forces a future export to be
  // classified deliberately rather than defaulting to unguarded.
  const PURE_PATH_BUILDERS = new Set([
    "assertKnowledgeRootTrusted", // the guard itself
    "documentsDir",
    "documentkbDir",
    "indexPath",
    "spaceAuditShardPath",
    "sourcesLocalPath",
    // resolveIntentFlag reads intents.json under spaces/<space>/intents/ — a
    // different container entirely, and pre-existing shared framework state that
    // this guard has no claim over. The test for "is it in scope" is NOT "does it
    // read a file"; it is "does a redirected knowledge/ change what it reads".
    "resolveIntentFlag",
  ]);

  test("every PURE_PATH_BUILDERS claim is TRUE: no fs primitive in its own body", () => {
    // The completeness test made "forgot to list a function" impossible. This makes
    // "classified it wrong" impossible, which is how instances four and five got
    // through: both times the entry carried a comment asserting it touched no disk,
    // and both times the body called realpathOrSelf/existsSync. A claim that is
    // never checked against the code is a wish.
    //
    // portableSourcePath is the case that forced this: classified pure for five
    // rounds because its own comment said so, while line 2 of its body resolved an
    // unverified knowledge/ anchor.
    // THIS FILE's actual I/O vocabulary, derived from its own call sites — not a
    // generic list of Node fs names. The first version of this array named
    // `readFileSync`/`writeFileSync`, which appear ZERO times here, while omitting
    // `writeFileAtomic`/`writeBufferAtomic`, which are how the module really
    // writes (5 call sites). It would have passed a future refactor that moved a
    // write into a pure-classified function: a plausible-looking list that does
    // not match the code is the same wish this test exists to eliminate, one level
    // up.
    const FS_PRIMITIVES = [
      "realpathOrSelf",
      "realpathSync",
      "existsSync",
      "lstatSync",
      "statSync",
      "readdirSync",
      "readRegularFileNoFollowOrThrow",
      "writeFileAtomic",
      "writeBufferAtomic",
      "rmSync",
      "renameSync",
      "mkdirSync",
      // A child process is I/O this module does not control — three call
      // sites (extractor probing + the extractor itself) run outside any
      // knowledge/-root check. If a future refactor moved one of these calls
      // into a function classified "pure", omitting spawnSync here would let
      // it pass the same way writeFileAtomic's absence once did.
      "spawnSync",
    ];
    const offenders: string[] = [];
    for (const name of PURE_PATH_BUILDERS) {
      if (name === "assertKnowledgeRootTrusted") continue; // the guard itself must lstat
      const start = KNOWLEDGE_SRC.indexOf(`export function ${name}(`);
      if (start === -1) continue; // a stale entry is the completeness test's problem
      // Body = from the signature to the next top-level `export`/`//` block, which
      // is the whole function and nothing after it.
      const rest = KNOWLEDGE_SRC.slice(start);
      const end = rest.indexOf("\n}\n");
      const body = end === -1 ? rest : rest.slice(0, end);
      const hits = FS_PRIMITIVES.filter((fn) => body.includes(`${fn}(`));
      if (hits.length > 0) offenders.push(`${name} calls ${hits.join(", ")}`);
    }
    expect(
      offenders,
      "these are classified as pure path builders but touch the filesystem — either " +
        "guard them and move them to DISK_TOUCHING_CALLS, or prove the call is not " +
        "against a knowledge/-derived path",
    ).toEqual([]);
  });

  test("pure-classified helpers resolve OUTSIDE knowledge/, checked not assumed", () => {
    // The purity check greps a function's OWN body, so a helper could hide an fs
    // call one level down. Two pure-classified functions have non-trivial chains
    // into aidlc-lib.ts: spaceAuditShardPath (-> auditShardName -> cloneId, which
    // reads and writes aidlc/.aidlc-clone-id) and resolveIntentFlag (-> listIntents
    // / activeIntent, which read spaces/<space>/intents/).
    //
    // Both are genuinely out of scope, but the reason is CONTAINMENT, not the
    // primitive list: they touch siblings of knowledge/, so a knowledge/ symlink
    // cannot influence them. Asserting the resolved paths turns that from an
    // observation someone made once into a property that fails if it stops holding.
    const p = scratchProject();
    const shard = spaceAuditShardPath(p, SPACE);
    expect(shard).toContain(join("spaces", SPACE, "intents"));
    expect(shard, "the audit shard must not live under knowledge/").not.toContain(
      `${sep}knowledge${sep}`,
    );
    // And the clone-id file the shard name derives from is a sibling of spaces/.
    expect(existsSync(join(p, "aidlc", "knowledge"))).toBe(false);
  });

  test("the guarded set is COMPLETE: no export taking (projectDir, space) is unaccounted for", () => {
    // Structural, and the one that actually closes the class: a new export is
    // either in the invocable set below or explicitly classified as touching no
    // disk. It cannot be silently neither, which is how all four rounds happened.
    const unaccounted = exportsTakingProjectDirAndSpace().filter(
      (n) => !PURE_PATH_BUILDERS.has(n) && !(n in DISK_TOUCHING_CALLS),
    );
    expect(
      unaccounted,
      `these exports take (projectDir, space) but are neither guarded-and-tested nor ` +
        `classified as pure path builders — classify them, do not leave them unguarded`,
    ).toEqual([]);
  });

  test("EVERY disk-touching export refuses a redirected anchor", () => {
    // collectStaleJournals is why this is non-negotiable: unguarded it rmSync'd a
    // file OUTSIDE the project — an arbitrary-file-DELETE primitive.
    const dest = outsideTarget();
    // Something worth losing at the target, so a "refusal" that still deletes is
    // caught rather than passing on the thrown exception alone.
    mkdirSync(join(dest, ".journal", "txn"), { recursive: true });
    writeFileSync(join(dest, ".journal", "txn", "victim.txt"), "must survive\n");
    const p = withRedirectedContainer("documentkb", dest);

    for (const [name, invoke] of Object.entries(DISK_TOUCHING_CALLS)) {
      expect(
        () => invoke(p),
        `${name} did NOT refuse a redirected documentkb`,
      ).toThrow(/symlink/i);
    }
    // Nothing read, nothing written, and above all nothing deleted.
    expect(existsSync(join(dest, ".journal", "txn", "victim.txt"))).toBe(true);
    expect(existsSync(join(dest, "index.json"))).toBe(false);
  });

  test("a DIRECT library call is anchored too, not just the CLI", () => {
    // Review demonstrated this bypass: with the guard only in the CLI handlers,
    // importing the module and calling onboard() wrote the catalog off-project.
    // No in-repo caller does that today, but these functions take a plain
    // (projectDir, space) and give a future importer -- a plugin, a batch script,
    // S2's retrieval seam -- no hint that anchoring is required. So the guard
    // lives in the functions as well, and this pins it there.
    const dest = outsideTarget();
    const p = withRedirectedContainer("documentkb", dest);
    expect(() => onboard(p, SPACE, undefined, NOW)).toThrow(/symlink/i);
    expect(readdirSync(dest)).toEqual([]);
  });

  test("a FIRST run with neither directory present is NOT refused", () => {
    // The guard must not read "absent" as "hostile". A fresh project has no
    // knowledge/ and no documentkb/ yet; refusing there would make the tool
    // unusable on day one, which is the case a lexical-only check gets wrong.
    const p = mkdtempSync(join(tmpdir(), "t289-anchor-"));
    proj = p;
    mkdirSync(documentsDir(p, SPACE), { recursive: true });
    writeFileSync(join(documentsDir(p, SPACE), "a.md"), "hello\n");
    writeFileSync(join(p, "aidlc", "active-space"), `${SPACE}\n`);

    const r = knowledgeCli(p, "onboard");
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).indexed[0].status).toBe("fresh");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 6: a DESCENDANT of an honestly-trusted `documentkb/` is ITSELF a
// symlink. `assertKnowledgeRootTrusted` anchors the chain down to `documentkb/`
// — but a container can be trusted while what is INSIDE it is not: `.journal`
// or one document's own `<id>/` directory can independently be a symlink,
// planted after `documentkb/` was created honestly. Measured against the
// shipped tool (2026-08-11), reproducing the review's two named vectors:
//
//   documentkb/.journal -> /outside          `collectStaleJournals` (reached
//                                             from plain `sync`) rmSync'd a
//                                             victim file through the link,
//                                             exit 0, "Up to date."
//   documentkb/<id> -> knowledge/documents   `sync` wrote content.md and
//                                             metadata.json into the user's OWN
//                                             documents/ folder.
//
// The fix is `containedKbDescendant` (aidlc-knowledge.ts), the funnel every
// mutable path under `documentkb/` is now built through — `journalDir`,
// `journalTxnDir` and `documentDir` all resolve through it, and every
// mkdirSync/rmSync/renameSync/writeFileAtomic/writeBufferAtomic target below
// `documentkb/` is join()'d off one of those three return values. There is no
// fourth path-builder to forget.
// ─────────────────────────────────────────────────────────────────────────────
describe("t289 a descendant of documentkb/ is ITSELF a symlink: refused, nothing lands or deletes through it", () => {
  test("documentkb/.journal -> outside: `sync` refuses, and the external victim survives", () => {
    // The exact reviewer-measured vector: collectStaleJournals (reached from
    // plain `sync`) must not rmSync through a redirected `.journal`.
    const p = mkdtempSync(join(tmpdir(), "t289-descendant-"));
    proj = p;
    mkdirSync(documentsDir(p, SPACE), { recursive: true });
    writeFileSync(join(documentsDir(p, SPACE), "a.md"), "hello\n");
    writeFileSync(join(p, "aidlc", "active-space"), `${SPACE}\n`);
    mkdirSync(documentkbDir(p, SPACE), { recursive: true });

    const outside = mkdtempSync(join(tmpdir(), "t289-victim-"));
    mkdirSync(join(outside, "txn1"), { recursive: true });
    writeFileSync(join(outside, "txn1", "victim.txt"), "must survive\n");
    symlinkSync(outside, join(documentkbDir(p, SPACE), ".journal"));

    try {
      const r = spawnSync(
        "bun",
        [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "sync", "--project-dir", p],
        { encoding: "utf-8", env: { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" } },
      );
      expect(r.status, `expected a refusal, got stdout: ${r.stdout}`).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/symlink/i);
      expect(readdirSync(join(outside, "txn1"))).toEqual(["victim.txt"]);
      expect(readFileSync(join(outside, "txn1", "victim.txt"), "utf-8")).toBe("must survive\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("collectStaleJournals directly: a symlinked .journal is refused, not walked", () => {
    const p = scratchProject();
    mkdirSync(documentkbDir(p, SPACE), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "t289-victim-"));
    writeFileSync(join(outside, "victim.txt"), "must survive\n");
    symlinkSync(outside, join(documentkbDir(p, SPACE), ".journal"));
    try {
      expect(() => collectStaleJournals(p, SPACE)).toThrow(/symlink/i);
      expect(existsSync(join(outside, "victim.txt"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("collectStaleJournals: one hostile ENTRY inside an honest .journal is skipped, not deleted through", () => {
    // The container is real; one entry inside it is a symlink pointing out. The
    // per-entry re-check in collectStaleJournals must catch this even though the
    // outer `.journal` dir itself passed containment.
    const p = scratchProject();
    mkdirSync(join(journalDir(p, SPACE)), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "t289-victim-"));
    writeFileSync(join(outside, "victim.txt"), "must survive\n");
    symlinkSync(outside, join(journalDir(p, SPACE), "hostile-txn"));
    // A genuine stale txn dir must still be collected in the same pass. No
    // liveness stamp and aged past the unstamped grace, so it reads as a real
    // crash's leftovers rather than a live writer mid-acquire.
    const realTxn = join(journalDir(p, SPACE), "real-txn");
    mkdirSync(realTxn, { recursive: true });
    writeFileSync(join(realTxn, "x"), "y");
    const old = new Date(Date.now() - 60_000);
    utimesSync(realTxn, old, old);
    try {
      const collected = collectStaleJournals(p, SPACE);
      expect(collected).toEqual(["real-txn"]);
      expect(existsSync(join(outside, "victim.txt"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("documentkb/<id> -> knowledge/documents: `sync` refuses, the user's originals are untouched", () => {
    // The second reviewer-named vector: a symlinked <id>/ dir pointed INWARD at
    // documents/ must not let sync overwrite the user's own files.
    const p = mkdtempSync(join(tmpdir(), "t289-descendant-"));
    proj = p;
    mkdirSync(documentsDir(p, SPACE), { recursive: true });
    writeFileSync(join(documentsDir(p, SPACE), "a.md"), "hello\n");
    writeFileSync(join(p, "aidlc", "active-space"), `${SPACE}\n`);

    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    rmSync(join(documentkbDir(p, SPACE), id), { recursive: true, force: true });
    symlinkSync(documentsDir(p, SPACE), join(documentkbDir(p, SPACE), id));
    const before = readdirSync(documentsDir(p, SPACE)).sort();

    const r = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "sync", "--project-dir", p],
      { encoding: "utf-8", env: { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" } },
    );
    expect(r.status, `expected a refusal, got stdout: ${r.stdout}`).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/symlink/i);
    expect(readdirSync(documentsDir(p, SPACE)).sort()).toEqual(before);
  });

  test("documentDir directly: a symlinked <id>/ is refused for read AND write alike", () => {
    const p = scratchProject();
    doc(p, "a.md");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    rmSync(join(documentkbDir(p, SPACE), id), { recursive: true, force: true });
    symlinkSync(documentsDir(p, SPACE), join(documentkbDir(p, SPACE), id));
    expect(() => documentDir(p, SPACE, id)).toThrow(/symlink/i);
  });

  test("documentDir refuses an interior parent-directory component", () => {
    const p = scratchProject();
    expect(() => documentDir(p, SPACE, ["safe", "..", "..", "escape"].join(sep)))
      .toThrow(/component "\.\." escapes its anchor/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The active-space CURSOR escape. `resolveSpaceFlag` validates an explicit
// `--space`, but the pathless fallback read straight from `activeSpace()`
// (aidlc-lib.ts) with no shape check of its own. Measured (2026-08-11): a
// hand-edited `aidlc/active-space` cursor holding `..` or `../../evil` made
// `knowledgeDir`/`documentkbDir` resolve ABOVE `aidlc/spaces/`, so `onboard`
// wrote the catalog outside the space tree entirely. A third `../` level is
// separately refused by `resolveContainedPath`'s existing lexical check, so the
// escape was bounded to within `projectDir` — still a real corruption of the
// project tree from a file the tool itself is supposed to own.
// ─────────────────────────────────────────────────────────────────────────────
describe("t289 the active-space cursor is validated at the SAME boundary as an explicit --space", () => {
  test("a cursor holding `..` is refused before any path is built", () => {
    const p = scratchProject();
    writeFileSync(join(p, "aidlc", "active-space"), "..\n");
    expect(() => resolveSpaceFlag(undefined, p)).toThrow(/active-space cursor/);
  });

  test("a cursor holding `../../evil` is refused, and nothing is written above spaces/", () => {
    const p = mkdtempSync(join(tmpdir(), "t289-cursor-"));
    proj = p;
    mkdirSync(documentsDir(p, SPACE), { recursive: true });
    writeFileSync(join(documentsDir(p, SPACE), "a.md"), "hello\n");
    writeFileSync(join(p, "aidlc", "active-space"), "../../evil\n");

    const r = spawnSync(
      "bun",
      [join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "onboard", "--project-dir", p],
      { encoding: "utf-8", env: { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" } },
    );
    expect(r.status, `expected a refusal, got stdout: ${r.stdout}`).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/active-space cursor/);
    expect(existsSync(join(p, "evil"))).toBe(false);
    expect(existsSync(join(p, "..", "evil"))).toBe(false);
  });

  test("a well-formed but unknown cursor value is refused, naming the remedy", () => {
    const p = scratchProject();
    writeFileSync(join(p, "aidlc", "active-space"), "no-such-space\n");
    expect(() => resolveSpaceFlag(undefined, p)).toThrow(/unknown space/i);
  });

  test("an explicit --space still overrides a poisoned cursor", () => {
    // resolveSpaceFlag must not fall back to the cursor once a caller supplied
    // a flag — the cursor's shape is irrelevant when it is never consulted.
    const p = scratchProject();
    writeFileSync(join(p, "aidlc", "active-space"), "../../evil\n");
    expect(resolveSpaceFlag(SPACE, p)).toBe(SPACE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 8: the completeness property was keyed to PARAMETER SPELLING, not to
// the dangerous primitive. An independent reviewer defeated it on the first
// attempt by adding a NEW export whose parameters are merely spelled
// differently from `(projectDir, space)`:
//
//   export function pruneContentReallyDangerously(pd: string, spaceName: string, id: string) {
//     assertKnowledgeRootTrusted(pd, spaceName);
//     const target = join(documentkbDir(pd, spaceName), id, "content.md");
//     rmSync(target, { force: true });
//   }
//
// `exportsTakingProjectDirAndSpace()` above matches `/projectDir/` and
// `/\bspace\b/` against raw signature TEXT, so this function is invisible to
// it — all 66 pre-existing t289 tests stayed green with it present and wired
// into the shipped dist, and it deleted an external content.md through a
// symlinked `documentkb/<id>` with no throw.
//
// The fix re-keys the property to what the reviewer's function actually DOES
// rather than how it is NAMED: every raw fs-MUTATION call in this file is
// enumerated by COUNTING CALLS — the `(`-suffixed token, not a mention in
// prose, so a doc comment cannot inflate the number — and each call's target
// expression is traced back, through `join()`, local `const`/reassignment,
// and cross-function parameter passing, to either the funnel
// (`documentDir`/`journalDir`/`journalTxnDir`) or the bare, unextended
// `documentkbDir()`/`indexPath()` anchor.
//
// ROUND 9: the mutator VOCABULARY itself was still a hand-picked list of
// primitive names, one level up from the round-8 parameter-name gap. An
// independent reviewer defeated it twice against the shipped dist tool: an
// `appendFileSync` imported under an alias, and an `openSync`+`writeSync`+
// `closeSync` fd-based write — neither name was on the old list, so neither
// call was ever counted or traced. The vocabulary was re-derived from this
// module's own `node:fs`/`node:fs/promises` import statements: every imported
// binding classified against a small set of Node's known-READ-ONLY calls, and
// anything not on that list treated as a mutator by default (fail-closed).
//
// ROUND 10 (this fix): the round-9 derivation parsed those import statements
// with a handful of REGEXES (`parseFsImports` matched a bare `{...}` clause;
// `findUnparseableFsImport` matched only a WHOLE-clause default or namespace
// form). An independent reviewer defeated it twice against the shipped dist
// tool by changing the import SYNTAX, not the primitive: a MIXED
// default+named clause (`import fs, { readFileSync as _r } from "node:fs";`
// then `fs.appendFileSync(...)`) matched neither regex, and a bare `"fs"`
// specifier with no `node:` prefix (`import { appendFileSync } from "fs";`)
// was invisible because both regexes hardcoded the `node:fs`/`node:fs/promises`
// alternation. A `matchAll` over a few regexes cannot enumerate every way ES
// modules let you bind a name — so this fix replaces the regex parser with a
// REAL PARSE of this module's source using the `typescript` compiler API
// (`ts.createSourceFile` + `ts.isImportDeclaration`), which reports every
// binding form structurally rather than by pattern-matching text: named,
// aliased, default, namespace, mixed default+named, type-only, and a dynamic
// `import("node:fs"/"fs")` call expression. The module specifier is compared
// by resolved identity (`fs`, `node:fs`, `fs/promises`, `node:fs/promises`),
// not by a hardcoded string alternation, so a bare specifier is recognised
// the same as its `node:`-prefixed twin. Fail-closed default is unchanged: an
// unrecognised BINDING is a mutator; an unrecognised or unparseable IMPORT
// SHAPE (default, namespace, dynamic, or a source that fails to parse at all)
// is an unconditional violation, never a silent miss.
//
// WHAT THIS DEFENDS AGAINST, AND WHAT IT DOES NOT. The threat is a hostile
// FILESYSTEM: a symlink or redirected directory committed to the repo, or
// planted by another process, that makes an ordinary verb write or delete
// outside the space. That is the class that shipped real data loss here (a
// `.journal` symlink let a plain `sync` empty an external directory while
// printing "Up to date."), and it is reachable by a user who never touches this
// source file.
//
// It is NOT a defence against hostile SOURCE CODE in this module. A reviewer
// demonstrated three routes that evade both this test and the biome import
// rule: `Bun.write(...)` (a global, never an fs import), `spawnSync("rm", ...)`
// (the mutation happens in a child process), and re-exporting `rmSync` from
// `aidlc-lib.ts` under an unrelated name (a specifier neither layer treats as
// fs-adjacent). All three require ADDING CODE to this module or its lib, and an
// author who can commit that can defeat any in-repo check — including this one.
// They are recorded here as known-uncovered rather than left implicit, so a
// reader does not mistake "the suite is green" for "no write can escape".
// Closing them needs a different mechanism (verifying the containment invariant
// by its EFFECT at verb start and before commit, rather than by call syntax),
// which is deliberately out of scope for this slice.
//
// One further pure-filesystem residual, of a different and narrower property:
// the txn liveness stamp trusts the pid it reads, so a hand-planted
// `.journal/<txn>/writer.pid` holding an always-alive pid (`1`) makes that
// staging dir permanently uncollectible. Measured: the dir survives `sync`.
// That is a disk-space LEAK, not an escape — nothing is written or deleted
// outside the space — so it is recorded rather than fixed here. It is the cost
// of choosing fail-safe (never reap a dir that might be live) over fail-clean,
// which is the right default given the alternative deleted a LIVE transaction's
// staging dir.
// ─────────────────────────────────────────────────────────────────────────────
describe("t289 the completeness property is keyed to the fs-mutation CALL, not to a parameter name", () => {
  const KNOWLEDGE_SRC = readFileSync(
    join(import.meta.dir, "..", "..", "core", "tools", "aidlc-knowledge.ts"),
    "utf-8",
  );

  // THIS FILE's fs-mutation vocabulary is DERIVED from its own import
  // statements, not hand-picked. A module can only touch the filesystem
  // through something it imports from `node:fs`/`fs`/`node:fs/promises`/
  // `fs/promises`, or through the two funnel-helper mutators it imports from
  // `aidlc-lib.ts` (`writeFileAtomic`/`writeBufferAtomic`). So every binding
  // this module imports from the fs modules — including an aliased (`X as Y`),
  // destructured, default, or namespace import — is classified against a
  // maintained set of Node's KNOWN READ-ONLY calls; anything imported that is
  // NOT on that read-only list is treated as a mutator by DEFAULT. That
  // default is fail-CLOSED: an fs import this file has never used before is
  // caught the moment it is imported, whether or not anyone remembers to add
  // its name to a list.
  //
  // A prior version of this vocabulary WAS a hand-picked list of primitive
  // NAMES. An independent reviewer falsified that against the shipped dist
  // tool twice: `appendFileSync` imported under an alias, and an
  // `openSync`+`writeSync`+`closeSync` fd-based write — neither name was on
  // the list, so neither call was even looked at.
  //
  // The version that replaced the hand-picked list still parsed the import
  // statements with REGEXES over raw text, and was defeated twice more by
  // changing the import SYNTAX rather than the primitive name: a mixed
  // `import fs, { readFileSync as _r } from "node:fs";` clause (neither the
  // named-import regex nor the whole-clause default/namespace regex matched a
  // COMBINATION of the two), and a bare `import { appendFileSync } from
  // "fs";` (the regexes hardcoded the `node:fs`/`node:fs/promises`
  // alternation and never recognised the un-prefixed specifier). All four
  // attacks are reproduced as RED-verify tests below, against the AST-based
  // parser that replaced the regexes.
  const KNOWN_READ_ONLY_FS_CALLS = new Set([
    "existsSync", "lstatSync", "statSync", "fstatSync", "readdirSync",
    "readFileSync", "realpathSync", "accessSync", "readlinkSync",
  ]);
  // fd-based writes cannot be traced by the path-based algorithm below at
  // all: `writeSync(fd, ...)`'s target is a file descriptor NUMBER, not a
  // path expression this module can resolve. Rather than pretend to trace
  // what it structurally cannot, importing ANY of these from node:fs is an
  // unconditional failure — the fix is to route the write through
  // writeFileAtomic/writeBufferAtomic instead, not to extend the tracer.
  const FD_WRITE_PRIMITIVES = new Set(["openSync", "writeSync", "writevSync", "ftruncateSync"]);
  // The funnel-helper mutators this module imports from `aidlc-lib.ts` rather
  // than from raw node:fs. Named explicitly, not derived, because they are not
  // fs imports at all — they ARE the trusted mkdir/rename/rm/atomic-write
  // primitives this whole mechanism exists to route every other call site
  // toward. `ensureDirSync`/`renameIntoPlace`/`removeTreeSync` were added in
  // round 10, alongside the biome `noRestrictedImports` override that now
  // physically forbids this module from binding the raw node:fs mkdir/rename/
  // rm names at all — every mkdirSync/renameSync/rmSync call site in this file
  // was rewritten to call these instead, closing the import boundary at the
  // linter as well as at this trace.
  const LIB_HELPER_MUTATORS = [
    "writeFileAtomic", "writeBufferAtomic", "ensureDirSync", "renameIntoPlace", "removeTreeSync",
  ];
  // Which argument index of a mutator call is the WRITE TARGET, for the few
  // primitives where it is not argument 0. `renameSync(from, to)` /
  // `renameIntoPlace(from, to)` write at BOTH; `symlinkSync(target, path)` and
  // `linkSync(existing, newPath)` write only at argument 1 — their argument 0
  // is unconstrained content the primitive does not write to, so tracing only
  // args[0] would leave the real write (args[1]) unchecked.
  const TARGET_ARG_INDEXES: Record<string, number[]> = {
    renameSync: [0, 1],
    renameIntoPlace: [0, 1],
    symlinkSync: [1],
    linkSync: [1],
  };

  interface FsImport { name: string; alias: string }
  const FS_MODULE_SPECIFIERS = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

  // Parses this module's OWN `fs`/`node:fs`/`fs/promises`/`node:fs/promises`
  // import statements with the real TypeScript compiler API, not a regex over
  // text -- a `matchAll` over a handful of patterns cannot enumerate every way
  // ES modules let you bind a name, and two prior regex versions of this
  // function were each defeated by a syntax the regex did not anticipate
  // (round 9: an alias; round 10: a mixed default+named clause and a bare
  // "fs" specifier). `ts.createSourceFile` reports every binding form
  // structurally: named (aliased or not), and -- via `unparseable` below --
  // default, namespace, and dynamic import() forms that this module has no
  // legitimate reason to use. The module specifier is compared by resolved
  // identity against FS_MODULE_SPECIFIERS, not by a hardcoded string
  // alternation, so a bare "fs" specifier is recognised the same as its
  // "node:"-prefixed twin.
  function parseFsImports(src: string): { imports: FsImport[]; unparseable: string[] } {
    const imports: FsImport[] = [];
    const unparseable: string[] = [];
    const sf = ts.createSourceFile("aidlc-knowledge.ts", src, ts.ScriptTarget.Latest, true);
    const parseDiagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
    if (parseDiagnostics !== undefined && parseDiagnostics.length > 0) {
      unparseable.push(
        "this module's source failed to parse as TypeScript -- the fs-mutation vocabulary " +
          "cannot be derived from an unparseable file, so every import is treated as suspect",
      );
      return { imports, unparseable };
    }
    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (FS_MODULE_SPECIFIERS.has(spec)) {
          const clause = node.importClause;
          if (clause === undefined) {
            // Side-effect-only `import "node:fs";` -- binds nothing, so it
            // cannot itself call a mutator, but it is an unrecognised shape
            // for this module regardless (it has no legitimate reason to
            // import fs purely for its side effects).
            unparseable.push(node.getText(sf));
          } else if (clause.name !== undefined) {
            // Default import (`import fs from "node:fs"`), whether or not it
            // also carries named bindings -- the default binding itself
            // hides every property access behind a namespace-shaped value
            // this parser cannot classify member-by-member.
            unparseable.push(node.getText(sf));
          } else if (
            clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)
          ) {
            // `import * as fs from "node:fs"` -- same problem, namespace form.
            unparseable.push(node.getText(sf));
          } else if (
            clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
          ) {
            for (const el of clause.namedBindings.elements) {
              if (el.isTypeOnly) continue; // a type-only binding cannot be called
              const name = (el.propertyName ?? el.name).text;
              const alias = el.name.text;
              imports.push({ name, alias });
            }
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0]) &&
        FS_MODULE_SPECIFIERS.has(node.arguments[0].text)
      ) {
        // `await import("node:fs")` -- a dynamic import defeats static
        // analysis of its bound name entirely; refuse the shape outright.
        unparseable.push(node.getText(sf));
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    return { imports, unparseable };
  }

  // Derives this call's mutator vocabulary from the source's OWN import
  // statements rather than a hand-picked list, per the header comment above.
  function deriveMutatorVocabulary(
    src: string,
  ): { tokens: string[]; targetArgIndexes: Record<string, number[]>; violations: string[] } {
    const violations: string[] = [];
    const { imports, unparseable } = parseFsImports(src);
    for (const shape of unparseable) {
      violations.push(
        `unrecognised fs import shape "${shape}" -- this module's fs-mutation vocabulary is ` +
          "derived from named imports; a default, namespace, dynamic, or side-effect-only import " +
          "hides every bound name and must be rewritten as a named import before this check can " +
          "classify it",
      );
    }
    const tokens = [...LIB_HELPER_MUTATORS];
    const targetArgIndexes: Record<string, number[]> = { ...TARGET_ARG_INDEXES };
    for (const { name, alias } of imports) {
      if (FD_WRITE_PRIMITIVES.has(name)) {
        violations.push(
          `${name}${alias !== name ? ` (imported as ${alias})` : ""} is a fd-based write primitive -- ` +
            "fd flow cannot be traced by path; route the write through writeFileAtomic/writeBufferAtomic",
        );
        continue;
      }
      if (KNOWN_READ_ONLY_FS_CALLS.has(name)) continue;
      // Unrecognised fs import: fail CLOSED -- treat as a mutator by default.
      tokens.push(alias);
      if (name !== alias && TARGET_ARG_INDEXES[name] !== undefined) {
        targetArgIndexes[alias] = TARGET_ARG_INDEXES[name];
      }
    }
    return { tokens, targetArgIndexes, violations };
  }

  // Every function `function NAME(params) { ... }` (export or not), with its
  // parameter NAMES (not types) and its [start, end) span in the source. Used
  // to find which function encloses a given call, and to trace a parameter
  // back through every call site that passes it in.
  interface FnInfo { name: string; params: string[]; start: number; end: number; bodyStart: number }
  function findFunctions(src: string): FnInfo[] {
    const out: FnInfo[] = [];
    const re = /(?:^|\n)(?:export )?function (\w+)\(([^)]*)\)[^{]*\{/g;
    for (const m of src.matchAll(re)) {
      const openBraceIdx = m.index + m[0].length - 1;
      let depth = 1;
      let i = openBraceIdx + 1;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      out.push({
        name: m[1],
        params: m[2].split(",").map((s) => s.trim().split(":")[0].trim()).filter(Boolean),
        start: m.index,
        end: i,
        bodyStart: openBraceIdx,
      });
    }
    return out;
  }

  // Balanced-paren arg text starting just after an opening `(`.
  function extractArgs(src: string, openParenIdx: number): { text: string; end: number } {
    let depth = 1;
    let i = openParenIdx + 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    return { text: src.slice(start, i - 1), end: i };
  }

  function splitTopLevel(argsText: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of argsText) {
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      if (ch === ")" || ch === "}" || ch === "]") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim().length > 0) parts.push(cur);
    return parts.map((s) => s.trim());
  }

  const IDENT_RE = /^[A-Za-z_]\w*$/;
  const FUNNEL_FNS = ["documentDir", "journalDir", "journalTxnDir"];

  test("every trusted funnel function calls the containment primitive in its own body", () => {
    const functions = findFunctions(KNOWLEDGE_SRC);
    for (const name of FUNNEL_FNS) {
      const fn = functions.find((candidate) => candidate.name === name);
      expect(fn, `${name} is listed as a trusted funnel but has no function body`).toBeDefined();
      const body = fn ? KNOWLEDGE_SRC.slice(fn.bodyStart, fn.end) : "";
      expect(
        /\bcontainedKbDescendant\s*\(/.test(body),
        `${name} is accepted as a trusted funnel, but its own body does not call ` +
          "containedKbDescendant; hollowing out a funnel must fail this suite",
      ).toBe(true);
    }
  });

  function startsWithFunnelCall(expr: string): boolean {
    return FUNNEL_FNS.some((fn) => expr.startsWith(`${fn}(`));
  }
  function isBareAnchorWhole(expr: string): boolean {
    const norm = expr.replace(/\s+/g, "");
    return /^documentkbDir\([^)]*\)$/.test(norm) || /^indexPath\([^)]*\)$/.test(norm);
  }

  function findLastAssignment(src: string, fn: FnInfo, ident: string): string | null {
    const body = src.slice(fn.bodyStart, fn.end);
    const re = new RegExp(`(?:const\\s+${ident}|(?<![\\w.])${ident})\\s*=(?!=)\\s*`, "g");
    let last: RegExpExecArray | null = null;
    for (const m of body.matchAll(re)) last = m;
    if (last === null) return null;
    const exprStart = last.index + last[0].length;
    let depth = 0;
    let i = exprStart;
    while (i < body.length) {
      const ch = body[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      if (ch === ")" || ch === "}" || ch === "]") depth--;
      if (ch === ";" && depth === 0) break;
      i++;
    }
    return body.slice(exprStart, i).trim();
  }

  function findCallSitesOf(src: string, fnName: string): { callIdx: number; argsText: string }[] {
    const results: { callIdx: number; argsText: string }[] = [];
    const re = new RegExp(`\\b${fnName}\\(`, "g");
    for (const m of src.matchAll(re)) {
      const preceding = src.slice(Math.max(0, m.index - 9), m.index);
      if (preceding.endsWith("function ")) continue; // the definition, not a call
      const openParen = m.index + fnName.length;
      const { text } = extractArgs(src, openParen);
      results.push({ callIdx: m.index, argsText: text });
    }
    return results;
  }

  // Trace `expr` (evaluated inside `fn`) back to a provably-safe path: either
  // a call that STARTS WITH one of the three funnels, or the bare,
  // NOT-FURTHER-EXTENDED documentkb anchor. `join(X, ...more)` is safe only
  // when X itself resolves through the funnel — never when X is the bare
  // anchor, since appending an unguarded segment onto it is exactly the
  // Round 6 vector this whole mechanism exists to close.
  function resolvesSafely(
    src: string, functions: FnInfo[], expr: string, fn: FnInfo, depth: number, requireFunnel: boolean,
  ): boolean {
    const trimmed = expr.trim();
    if (depth > 12) return false;
    if (startsWithFunnelCall(trimmed)) return true;
    const joinMatch = /^join\(/.exec(trimmed);
    if (joinMatch !== null) {
      const { text } = extractArgs(trimmed, joinMatch[0].length - 1);
      const args = splitTopLevel(text);
      if (args.length === 0) return false;
      if (args.length === 1) {
        return resolvesSafely(src, functions, args[0], fn, depth + 1, requireFunnel);
      }
      // Segments are being appended: the base MUST be funnel-derived, not the
      // bare anchor, regardless of the outer call's own requireFunnel mode.
      return resolvesSafely(src, functions, args[0], fn, depth + 1, true);
    }
    if (!requireFunnel && isBareAnchorWhole(trimmed)) return true;
    if (IDENT_RE.test(trimmed)) {
      if (fn.params.includes(trimmed)) {
        const paramIdx = fn.params.indexOf(trimmed);
        const sites = findCallSitesOf(src, fn.name);
        if (sites.length === 0) return false;
        return sites.every((s) => {
          const args = splitTopLevel(s.argsText);
          const argExpr = args[paramIdx];
          if (argExpr === undefined) return false;
          const callerFn = functions.find((f) => s.callIdx >= f.start && s.callIdx < f.end);
          if (callerFn === undefined) return false;
          return resolvesSafely(src, functions, argExpr, callerFn, depth + 1, requireFunnel);
        });
      }
      const rhs = findLastAssignment(src, fn, trimmed);
      if (rhs === null) return false;
      return resolvesSafely(src, functions, rhs, fn, depth + 1, requireFunnel);
    }
    return false;
  }

  function auditMutationCalls(src: string): { total: number; violations: string[] } {
    const { tokens, targetArgIndexes, violations: deriveViolations } = deriveMutatorVocabulary(src);
    const violations: string[] = [...deriveViolations];
    if (tokens.length === 0) return { total: 0, violations };
    const functions = findFunctions(src);
    const re = new RegExp(`\\b(${tokens.join("|")})\\(`, "g");
    const calls: { name: string; idx: number; argsText: string }[] = [];
    for (const m of src.matchAll(re)) {
      const name = m[1];
      const openParenIdx = m.index + name.length;
      const { text } = extractArgs(src, openParenIdx);
      calls.push({ name, idx: m.index, argsText: text });
    }
    for (const c of calls) {
      const fn = functions.find((f) => c.idx >= f.start && c.idx < f.end);
      if (fn === undefined) {
        violations.push(`${c.name}(...) at offset ${c.idx} is not inside any top-level function`);
        continue;
      }
      const args = splitTopLevel(c.argsText);
      const indexes = targetArgIndexes[c.name] ?? [0];
      const targets = indexes.map((i) => args[i]);
      for (const t of targets) {
        if (t === undefined) continue;
        const safe = resolvesSafely(src, functions, t, fn, 0, false);
        if (!safe) violations.push(`${fn.name}(): ${c.name}(${t}, ...) does not trace to the funnel or the bare anchor`);
      }
    }
    return { total: calls.length, violations };
  }

  test("the fs-mutation analyzer finds a plausible number of call sites", () => {
    // This floor detects a broken analyzer that suddenly sees little or nothing.
    // The violations-empty assertion below carries the security property; an
    // exact count would only create churn when safe call sites are refactored.
    const { total } = auditMutationCalls(KNOWLEDGE_SRC);
    expect(
      total,
      "the fs-mutation analyzer found implausibly few calls; its extraction likely broke",
    ).toBeGreaterThan(9);
  });

  test("EVERY fs-mutation call's target traces to the funnel or the bare anchor", () => {
    // This is the property the reviewer's `pruneContentReallyDangerously`
    // defeats when it is present: `rmSync(target, ...)` where `target` is
    // `join(documentkbDir(pd, spaceName), id, "content.md")` -- a JOIN that
    // appends an attacker-influenced `id` segment onto the BARE anchor, never
    // going through `documentDir`. RED-verified: with that function appended
    // to a copy of this module, this assertion fails naming exactly that call.
    const { violations } = auditMutationCalls(KNOWLEDGE_SRC);
    expect(
      violations,
      "these fs-mutation calls write/delete below documentkb/ without tracing to " +
        "documentDir/journalDir/journalTxnDir or the bare, unextended documentkb " +
        "anchor -- route the target through the funnel",
    ).toEqual([]);
  });

  test("RED-verify: the reviewer's exact defeat function is caught by the trace, not the name", () => {
    // Reproduces the round-8 review finding verbatim: a same-shaped function
    // with DIFFERENTLY-SPELLED parameters (`pd`, `spaceName` instead of
    // `projectDir`, `space`) that `join()`s an id segment straight onto the
    // bare `documentkbDir()` anchor and `rmSync`s it. The old completeness
    // test (which matched `/projectDir/` + `/\bspace\b/` in the SIGNATURE
    // TEXT) never saw this function at all. This one does, because it reads
    // what the function's BODY calls, not what its parameters are named.
    //
    // Round 10 removed `rmSync` from this module's OWN imports (it now routes
    // every remove through `removeTreeSync` in aidlc-lib.ts), so a defeat
    // function that calls a bare `rmSync` must import it itself, same as any
    // real attacker adding a brand-new import would have to.
    const defeat = `
import { rmSync } from "node:fs";

export function pruneContentReallyDangerously(pd: string, spaceName: string, id: string): void {
  assertKnowledgeRootTrusted(pd, spaceName);
  const target = join(documentkbDir(pd, spaceName), id, "content.md");
  rmSync(target, { force: true });
}
    `;
    const poisoned = `${KNOWLEDGE_SRC}\n${defeat}`;
    const { total, violations } = auditMutationCalls(poisoned);
    expect(total, "the analyzer must still find a plausible call-site floor").toBeGreaterThan(9);
    expect(
      violations.some((v) => v.includes("pruneContentReallyDangerously") && v.includes("rmSync")),
      `expected a violation naming pruneContentReallyDangerously's rmSync; got: ${violations.join("; ")}`,
    ).toBe(true);
  });

  test("a call funnelled through documentDir is NOT flagged (no false positive)", () => {
    // The trace must accept the legitimate shape too, or the mechanism would
    // be trivially "satisfied" by making every future export look violating.
    const legit = `
function legitimatelyPrunes(projectDir: string, space: string, id: string): void {
  const target = join(documentDir(projectDir, space, id), "content.md");
  rmSync(target, { force: true });
}
`;
    const { violations } = auditMutationCalls(`${KNOWLEDGE_SRC}\n${legit}`);
    expect(violations.some((v) => v.includes("legitimatelyPrunes"))).toBe(false);
  });

  test("a join() that APPENDS a segment onto the bare anchor is flagged, even inline", () => {
    // The Round 6 vector, restated as a direct call rather than through a
    // helper: appending straight onto documentkbDir()/indexPath() with no
    // funnel is unsafe regardless of how many segments are appended or
    // whether a local variable is interposed.
    const inline = `
function inlineUnsafeWrite(projectDir: string, space: string, id: string): void {
  writeFileAtomic(join(documentkbDir(projectDir, space), id, "metadata.json"), "{}");
}
`;
    const { violations } = auditMutationCalls(`${KNOWLEDGE_SRC}\n${inline}`);
    expect(violations.some((v) => v.includes("inlineUnsafeWrite"))).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ROUND 9: the reviewer's three attacks against the shipped dist tool, all
  // defeating the hand-picked MUTATORS list because none of these three
  // primitive names were on it. Reproduced here as RED-verify tests against
  // the DERIVED vocabulary that replaced it.
  // ───────────────────────────────────────────────────────────────────────────

  test("RED-verify attack (a): appendFileSync imported under an alias is caught", () => {
    const attack = `
import { appendFileSync as _appendFileSync } from "node:fs";

export function leakyAppend(pd: string, spaceName: string, id: string): void {
  assertKnowledgeRootTrusted(pd, spaceName);
  const target = join(documentkbDir(pd, spaceName), id, "content.md");
  _appendFileSync(target, "pwned\\n");
}
`;
    const { violations } = auditMutationCalls(`${KNOWLEDGE_SRC}\n${attack}`);
    expect(
      violations.some((v) => v.includes("leakyAppend") && v.includes("_appendFileSync")),
      `expected a violation naming leakyAppend's aliased _appendFileSync; got: ${violations.join("; ")}`,
    ).toBe(true);
  });

  test("RED-verify attack (b): an openSync+writeSync+closeSync fd-based write is caught", () => {
    const attack = `
import { openSync, writeSync, closeSync } from "node:fs";

export function fdOverwrite(pd: string, spaceName: string, id: string): void {
  assertKnowledgeRootTrusted(pd, spaceName);
  const target = join(documentkbDir(pd, spaceName), id, "content.md");
  const fd = openSync(target, "w");
  writeSync(fd, "pwned");
  closeSync(fd);
}
`;
    const { violations } = auditMutationCalls(`${KNOWLEDGE_SRC}\n${attack}`);
    expect(
      violations.some((v) => v.includes("openSync") && v.includes("fd-based")),
      `expected a fd-based-write violation naming openSync; got: ${violations.join("; ")}`,
    ).toBe(true);
    expect(
      violations.some((v) => v.includes("writeSync") && v.includes("fd-based")),
      `expected a fd-based-write violation naming writeSync; got: ${violations.join("; ")}`,
    ).toBe(true);
  });

  test("RED-verify attack (c): symlinkSync planting a link under documentkb/<id> is caught", () => {
    const attack = `
import { symlinkSync } from "node:fs";

export function plantLink(pd: string, spaceName: string, id: string): void {
  assertKnowledgeRootTrusted(pd, spaceName);
  const target = join(documentkbDir(pd, spaceName), id);
  symlinkSync("/etc/passwd", target);
}
`;
    const { violations } = auditMutationCalls(`${KNOWLEDGE_SRC}\n${attack}`);
    expect(
      violations.some((v) => v.includes("plantLink") && v.includes("symlinkSync")),
      `expected a violation naming plantLink's symlinkSync; got: ${violations.join("; ")}`,
    ).toBe(true);
  });

  test("RED-verify: a namespace fs import is refused rather than silently seeing nothing", () => {
    const attack = `
import * as fs from "node:fs";

export function nsWrite(pd: string, spaceName: string, id: string): void {
  fs.appendFileSync(join(documentkbDir(pd, spaceName), id, "content.md"), "pwned\\n");
}
`;
    const { violations } = auditMutationCalls(`${KNOWLEDGE_SRC}\n${attack}`);
    expect(
      violations.some((v) => v.includes("unrecognised fs import shape")),
      `expected a violation refusing the namespace import; got: ${violations.join("; ")}`,
    ).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ROUND 10: the reviewer's two attacks against the shipped dist tool, both
  // defeating the round-9 REGEX parser by changing import SYNTAX rather than
  // the primitive name. Reproduced here as RED-verify tests against the
  // AST-based parser that replaced the regexes.
  // ───────────────────────────────────────────────────────────────────────────

  test("RED-verify attack (d): a mixed default+named fs import is refused, not silently missed", () => {
    // `import fs, { readFileSync as _rfs } from "node:fs";` matched NEITHER
    // round-9 regex: the named-import regex required the clause to be a bare
    // `{...}` with nothing before it, and the default/namespace regex
    // required the whole clause to be JUST the default binding. A mixed
    // clause fell through both, so `fs.appendFileSync(...)` was never counted.
    const attack = `
import fs, { readFileSync as _rfs } from "node:fs";

export function mixedImportWrite(pd: string, spaceName: string, id: string): void {
  assertKnowledgeRootTrusted(pd, spaceName);
  fs.appendFileSync(join(documentkbDir(pd, spaceName), id, "content.md"), "pwned\\n");
}
`;
    const { violations } = auditMutationCalls(`${KNOWLEDGE_SRC}\n${attack}`);
    expect(
      violations.some((v) => v.includes("unrecognised fs import shape") && v.includes("import fs")),
      `expected a violation refusing the mixed default+named import; got: ${violations.join("; ")}`,
    ).toBe(true);
  });

  test("RED-verify attack (e): a bare \"fs\" specifier (no node: prefix) is caught the same as its node:fs twin", () => {
    // `import { appendFileSync } from "fs";` was invisible to both round-9
    // regexes, which hardcoded the `node:fs`/`node:fs/promises` alternation
    // and never matched the un-prefixed specifier -- valid and common Node
    // syntax that this tool must classify identically to "node:fs".
    const attack = `
import { appendFileSync as _bareAppend } from "fs";

export function barePrefixWrite(pd: string, spaceName: string, id: string): void {
  assertKnowledgeRootTrusted(pd, spaceName);
  _bareAppend(join(documentkbDir(pd, spaceName), id, "content.md"), "pwned\\n");
}
`;
    const { violations } = auditMutationCalls(`${KNOWLEDGE_SRC}\n${attack}`);
    expect(
      violations.some((v) => v.includes("barePrefixWrite") && v.includes("_bareAppend")),
      `expected a violation naming barePrefixWrite's aliased _bareAppend; got: ${violations.join("; ")}`,
    ).toBe(true);
  });

  test("a bare \"fs\" specifier importing only read-only calls is NOT flagged (no false positive)", () => {
    const legit = `
import { existsSync } from "fs";

function legitBareRead(pd: string, spaceName: string): boolean {
  return existsSync(documentkbDir(pd, spaceName));
}
`;
    const { violations } = auditMutationCalls(`${KNOWLEDGE_SRC}\n${legit}`);
    expect(violations.some((v) => v.includes("legitBareRead"))).toBe(false);
  });

  test("RED-verify: a dynamic import(\"node:fs\") is refused rather than silently seeing nothing", () => {
    const attack = `
export async function dynWrite(pd: string, spaceName: string, id: string): Promise<void> {
  const dynFs = await import("node:fs");
  dynFs.appendFileSync(join(documentkbDir(pd, spaceName), id, "content.md"), "pwned\\n");
}
`;
    const { violations } = auditMutationCalls(`${KNOWLEDGE_SRC}\n${attack}`);
    expect(
      violations.some((v) => v.includes("unrecognised fs import shape") && v.includes("import(")),
      `expected a violation refusing the dynamic import; got: ${violations.join("; ")}`,
    ).toBe(true);
  });
});
