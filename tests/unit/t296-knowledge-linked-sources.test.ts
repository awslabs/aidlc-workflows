// covers: function:resolveLinkedSource function:readSourcesLocal function:sourcesLocalPath
//
// t296 - `linked` sources: referencing a corpus that lives outside the repo
// without committing one developer's directory layout.
//
// Mechanism: real filesystem. The subject is what a committed row resolves to on
// a particular machine, so the alias map, the external root and the file all have
// to be real.
//
// Subject under test: dist/claude/.claude/tools/aidlc-knowledge.ts.
//
// The split, and why each half is where it is:
//
//   COMMITTED metadata holds an ALIAS plus a RELATIVE path. Never an absolute
//   path, in either source kind -- an absolute path in a committed file leaks a
//   machine's layout to every clone, and is the traversal primitive besides.
//
//   The GITIGNORED map holds the ABSOLUTE root. It is the one file allowed to
//   know this machine's layout, and the one that never ships. A relative root
//   there would resolve differently per working directory, so it is refused.
//
//   An UNMAPPED alias is source_unavailable, NOT a tombstone. That distinction is
//   the whole point: a teammate who clones without the corpus must see "you don't
//   have this source mapped", not the silent deletion of rows they never owned.
//   The document still exists; this clone cannot reach it.
//
//   CONTAINMENT still applies, against the alias ROOT. Otherwise a committed row
//   could walk up out of a teammate's corpus and reach any file on their disk --
//   the committed side is untrusted input even when the root is local.

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentsDir,
  listDocuments,
  onboard,
  readIndex,
  readSourcesLocal,
  resolveLinkedSource,
  showDocument,
  sourcesLocalPath,
  writeIndex,
} from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";

const NOW = "2026-08-07T00:00:00Z";
const SPACE = "default";
const DIGEST = "a".repeat(64);

let proj: string | undefined;
let corpus: string | undefined;

function scratchProject(): string {
  proj = mkdtempSync(join(tmpdir(), "t296-"));
  mkdirSync(documentsDir(proj, SPACE), { recursive: true });
  return proj;
}

/** An external corpus, deliberately OUTSIDE the project dir. */
function externalCorpus(): string {
  corpus = mkdtempSync(join(tmpdir(), "t296-corpus-"));
  mkdirSync(join(corpus, "security"), { recursive: true });
  writeFileSync(join(corpus, "security", "policy.pdf"), "%PDF-1.4 corp policy\n");
  return corpus;
}

function writeAliasMap(p: string, sources: Record<string, string>): void {
  writeFileSync(
    sourcesLocalPath(p, SPACE),
    `${JSON.stringify({ schema_version: 1, sources }, null, 2)}\n`,
  );
}

/** A linked row, hand-written the way a teammate's commit would carry it. */
function linkedRow(alias: string, path: string): Record<string, unknown> {
  return {
    id: "019fda80-8f8d-7bfa-b56c-983cf0353faa",
    source: { kind: "linked", alias, path },
    sha256: DIGEST,
    bytes: 21,
    indexed_at: NOW,
    extraction: {
      state: "extractor_unavailable",
      extractor: { name: "pdftotext" },
      detectedType: "application/pdf",
    },
    summary: { state: "absent" },
  };
}

afterEach(() => {
  for (const d of [proj, corpus]) {
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
  proj = undefined;
  corpus = undefined;
});

describe("t296 the alias map is machine-local and may be absent", () => {
  test("a MISSING map is null, not an error", () => {
    // The normal state for a teammate who cloned without the corpus. Erroring
    // here would make the repo unusable for them, which is the opposite of what
    // the alias indirection is for.
    const p = scratchProject();
    expect(readSourcesLocal(p, SPACE)).toBeNull();
  });

  test("a well-formed map reads back", () => {
    const p = scratchProject();
    const c = externalCorpus();
    writeAliasMap(p, { "corp-policies": c });
    const map = readSourcesLocal(p, SPACE);
    expect(map?.sources["corp-policies"]).toBe(c);
  });

  test("a RELATIVE root is refused, and the message says why", () => {
    // This file is gitignored precisely so it can name a machine path; a relative
    // root would resolve differently depending on the working directory the tool
    // happened to run from.
    const p = scratchProject();
    writeAliasMap(p, { "corp-policies": "../some/relative/root" });
    const err = (() => {
      try { readSourcesLocal(p, SPACE); return null; } catch (e) { return e as Error; }
    })();
    expect(err?.message).toMatch(/must map to an ABSOLUTE path/);
    expect(err?.message).toMatch(/gitignored/);
  });

  test("a malformed map fails CLOSED rather than being guessed at", () => {
    const p = scratchProject();
    for (const body of [
      "{not json",
      "[]",
      '{"schema_version":99,"sources":{}}',
      '{"schema_version":1,"sources":[]}',
      '{"schema_version":1,"sources":{"a":42}}',
      '{"schema_version":1,"sources":{"a":""}}',
    ]) {
      writeFileSync(sourcesLocalPath(p, SPACE), body);
      expect(() => readSourcesLocal(p, SPACE), body).toThrow();
    }
  });

  test("the map is read through the same no-follow boundary as everything else", () => {
    // It is machine-local, but it still resolves to filesystem roots -- so a
    // symlinked map is refused like any other symlinked read.
    const p = scratchProject();
    const c = externalCorpus();
    const real = join(c, "map.json");
    writeFileSync(real, JSON.stringify({ schema_version: 1, sources: {} }));
    symlinkSync(real, sourcesLocalPath(p, SPACE));
    expect(() => readSourcesLocal(p, SPACE)).toThrow(/symlink/);
  });
});

describe("t296 an unmapped alias is source_unavailable, NOT a tombstone", () => {
  test("with no map at all, a linked row resolves to null", () => {
    const p = scratchProject();
    const index = readIndex(p, SPACE);
    index.documents.push(linkedRow("corp-policies", "security/policy.pdf") as never);
    writeIndex(p, SPACE, index);
    expect(resolveLinkedSource(p, SPACE, readIndex(p, SPACE).documents[0])).toBeNull();
  });

  test("`list` reports source_unavailable and NOT tombstoned", () => {
    // The two must never be conflated: a tombstone is a deliberate removal, an
    // unmapped alias is a missing checkout. Different remedies entirely.
    const p = scratchProject();
    const index = readIndex(p, SPACE);
    index.documents.push(linkedRow("corp-policies", "security/policy.pdf") as never);
    writeIndex(p, SPACE, index);

    const rows = listDocuments(p, SPACE);
    expect(rows.length, "the row must still be LISTED").toBe(1);
    expect(rows[0].status).toBe("source_unavailable");
    expect(rows[0].status).not.toBe("tombstoned");
  });

  test("REMOVING the map turns a resolvable row unavailable — and back again", () => {
    // The round trip is the point: availability is a property of THIS clone, not
    // of the document, so it must be recoverable by restoring the map rather than
    // by re-onboarding.
    const p = scratchProject();
    const c = externalCorpus();
    const index = readIndex(p, SPACE);
    index.documents.push(linkedRow("corp-policies", "security/policy.pdf") as never);
    writeIndex(p, SPACE, index);

    writeAliasMap(p, { "corp-policies": c });
    expect(listDocuments(p, SPACE)[0].status).toBe("indexed");

    rmSync(sourcesLocalPath(p, SPACE));
    expect(listDocuments(p, SPACE)[0].status).toBe("source_unavailable");

    writeAliasMap(p, { "corp-policies": c });
    expect(listDocuments(p, SPACE)[0].status).toBe("indexed");
  });

  test("a MAPPED alias whose file is missing is also unavailable", () => {
    // The alias resolved; the document did not. Same user-visible answer, because
    // the remedy is the same: fix your local corpus.
    const p = scratchProject();
    const c = externalCorpus();
    writeAliasMap(p, { "corp-policies": c });
    const index = readIndex(p, SPACE);
    index.documents.push(linkedRow("corp-policies", "security/absent.pdf") as never);
    writeIndex(p, SPACE, index);
    expect(listDocuments(p, SPACE)[0].status).toBe("source_unavailable");
  });

  test("a mapped root that does not EXIST is unavailable, not a crash", () => {
    const p = scratchProject();
    writeAliasMap(p, { "corp-policies": join(tmpdir(), "t296-definitely-not-here") });
    const index = readIndex(p, SPACE);
    index.documents.push(linkedRow("corp-policies", "security/policy.pdf") as never);
    writeIndex(p, SPACE, index);
    expect(() => listDocuments(p, SPACE)).not.toThrow();
    expect(listDocuments(p, SPACE)[0].status).toBe("source_unavailable");
  });
});

describe("t296 committed metadata never carries an absolute path", () => {
  test("the schema refuses an absolute path in a linked row", () => {
    // Enforced by the shared validator, so it holds on every read path rather
    // than only where someone remembered to check.
    const p = scratchProject();
    const index = readIndex(p, SPACE);
    index.documents.push(linkedRow("corp-policies", "/Users/alice/corp/policy.pdf") as never);
    expect(() => writeIndex(p, SPACE, index)).toThrow();
  });

  test("no committed file mentions the external root, even when resolvable", () => {
    // The grep that proves the indirection works: a teammate reading the commit
    // must find the alias and never the path it maps to.
    const p = scratchProject();
    const c = externalCorpus();
    writeAliasMap(p, { "corp-policies": c });
    const index = readIndex(p, SPACE);
    index.documents.push(linkedRow("corp-policies", "security/policy.pdf") as never);
    writeIndex(p, SPACE, index);

    // Resolution works...
    expect(resolveLinkedSource(p, SPACE, readIndex(p, SPACE).documents[0])).not.toBeNull();
    // ...and the COMMITTED side still names only the alias.
    const committed = JSON.stringify(readIndex(p, SPACE));
    expect(committed).toContain("corp-policies");
    expect(committed, "the external root must not appear in committed metadata")
      .not.toContain(c);
  });

  test("`show` on a linked row exposes the alias, not the local root", () => {
    const p = scratchProject();
    const c = externalCorpus();
    writeAliasMap(p, { "corp-policies": c });
    const index = readIndex(p, SPACE);
    index.documents.push(linkedRow("corp-policies", "security/policy.pdf") as never);
    writeIndex(p, SPACE, index);

    const shown = showDocument(p, SPACE, readIndex(p, SPACE).documents[0].id);
    expect(JSON.stringify(shown)).not.toContain(c);
    expect(shown.source).toEqual({
      kind: "linked", alias: "corp-policies", path: "security/policy.pdf",
    });
  });
});

describe("t296 containment applies against the ALIAS ROOT", () => {
  test("a committed relative path cannot climb OUT of the mapped root", () => {
    // Without this, a committed row could reach any file on a teammate's disk by
    // walking up from wherever their corpus happens to live -- so the committed
    // side stays untrusted input even though the root is local.
    const p = scratchProject();
    const c = externalCorpus();
    writeFileSync(join(c, "..", "t296-outside-secret.txt"), "SECRET\n");
    writeAliasMap(p, { "corp-policies": c });
    // Bypass the schema (which also refuses `..`) to test the RESOLVER directly:
    // both layers must hold, since either could be reached first.
    const row = {
      ...linkedRow("corp-policies", "../t296-outside-secret.txt"),
    } as never;
    expect(() => resolveLinkedSource(p, SPACE, row)).toThrow(/escapes its anchor/);
  });

  test("a symlink inside the corpus that escapes it is refused", () => {
    const p = scratchProject();
    const c = externalCorpus();
    const outside = join(tmpdir(), `t296-out-${Date.now()}.txt`);
    writeFileSync(outside, "SECRET\n");
    symlinkSync(outside, join(c, "escape.pdf"));
    writeAliasMap(p, { "corp-policies": c });
    const row = { ...linkedRow("corp-policies", "escape.pdf") } as never;
    const err = (() => {
      try { resolveLinkedSource(p, SPACE, row); return null; } catch (e) { return e as Error; }
    })();
    expect(err, "an escaping symlink must be refused").not.toBeNull();
    expect(err?.message).not.toContain("SECRET");
    rmSync(outside, { force: true });
  });

  test("a path fully inside the corpus resolves", () => {
    // The positive case, so the guards above are not merely refusing everything.
    const p = scratchProject();
    const c = externalCorpus();
    writeAliasMap(p, { "corp-policies": c });
    const row = { ...linkedRow("corp-policies", "security/policy.pdf") } as never;
    const resolved = resolveLinkedSource(p, SPACE, row);
    expect(resolved).not.toBeNull();
    expect(resolved).toContain("policy.pdf");
  });
});

describe("t296 an incidental symlink is never an implicit linked source", () => {
  test("an external symlink under documents/ is SKIPPED by the walk", () => {
    // Reaching outside the repo must be a deliberate, committed act -- the
    // explicit `linked` kind with an alias. A symlink that silently escapes
    // containment is the arbitrary-file-read the boundary exists to prevent.
    const p = scratchProject();
    const c = externalCorpus();
    writeFileSync(join(documentsDir(p, SPACE), "inside.md"), "text\n");
    symlinkSync(join(c, "security", "policy.pdf"), join(documentsDir(p, SPACE), "sneaky.pdf"));

    const result = onboard(p, SPACE, undefined, NOW);
    expect(result.refused).toBeUndefined();
    // Only the real file was indexed, and nothing claims the external path.
    expect(result.indexed.map((r) => r.path)).toEqual(["documents/inside.md"]);
    expect(JSON.stringify(readIndex(p, SPACE))).not.toContain(c);
  });

  test("every indexed row is `managed` — nothing becomes linked by accident", () => {
    // A `linked` row can only arrive through a deliberate, committed act; onboard
    // never mints one from a symlink it happened to find.
    const p = scratchProject();
    const c = externalCorpus();
    writeFileSync(join(documentsDir(p, SPACE), "a.md"), "text\n");
    symlinkSync(c, join(documentsDir(p, SPACE), "corpus"));
    onboard(p, SPACE, undefined, NOW);
    for (const row of readIndex(p, SPACE).documents) {
      expect(row.source.kind, row.source.path).toBe("managed");
    }
  });
});
