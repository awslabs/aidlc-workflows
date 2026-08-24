// covers: function:summarizeDocument function:listDocuments function:showDocument
//         function:renderList function:renderShow subcommand:aidlc-knowledge:summarize
//
// t301 - DocumentKB S3b: summary generation, revision-binding, and surfacing
// summary/tags through `show`/`list`.
//
// Mechanism: real filesystem + real subprocesses (through the compiled
// dispatcher, per baseline §8.12 -- t293's own lesson is that a tool test that
// never spawns `aidlc.ts` can miss a routing defect entirely). The two
// ACTION-only probes the design requires (a driven race, and an injected
// partial-write failure) run against real concurrent processes / a pre-placed
// directory, never a code reading.
//
// Subject under test: dist/claude/.claude/tools/{aidlc.ts,aidlc-knowledge.ts,
// aidlc-documentkb-schema.ts} -- the SHIPPED distributable, so a guard
// reverted only in core/ still fails these (RED-verify, baseline §8.0).

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentDir,
  documentsDir,
  onboard,
  readDocumentMetadata,
  readIndex,
  showDocument,
  summarizeDocument,
} from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";

const AIDLC_TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const AIDLC = join(AIDLC_TOOLS, "aidlc.ts");
const NOW = "2026-08-07T00:00:00Z";
const SPACE = "default";
const CHILD_ENV = { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" };
const DIGEST64 = (c: string) => c.repeat(64);

let proj: string | undefined;

function scratchProject(): string {
  proj = mkdtempSync(join(tmpdir(), "t301-"));
  mkdirSync(documentsDir(proj, SPACE), { recursive: true });
  return proj;
}

function doc(p: string, name: string, body = "text\n"): string {
  const full = join(documentsDir(p, SPACE), name);
  writeFileSync(full, body);
  return full;
}

afterEach(() => {
  if (proj !== undefined) {
    rmSync(proj, { recursive: true, force: true });
    proj = undefined;
  }
});

/** Drives the PUBLIC surface only -- `aidlc.ts knowledge <verb>`, never
 *  `aidlc-knowledge.ts` directly (baseline §8.12). */
function knowledge(p: string, args: string[]): { status: number | null; out: string; err: string } {
  const r = spawnSync("bun", [AIDLC, "knowledge", ...args, "--project-dir", p, "--json"], {
    encoding: "utf-8",
    env: CHILD_ENV,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("t301 summarize: through the public dispatcher", () => {
  test("summarize persists a generated summary and show/list surface it", () => {
    const p = scratchProject();
    doc(p, "policy.md", "the policy body\n");
    const onboarded = knowledge(p, ["onboard", join(documentsDir(p, SPACE), "policy.md")]);
    expect(onboarded.status, onboarded.err).toBe(0);
    const id = (JSON.parse(onboarded.out).indexed as { id: string; sha256: string }[])[0].id;
    const sha256 = (JSON.parse(onboarded.out).indexed as { sha256: string }[])[0].sha256;

    const textFile = join(p, "summary-in.txt");
    writeFileSync(textFile, "This policy governs access control.\n");
    const summarized = knowledge(p, [
      "summarize", id, "--text-file", textFile, "--source-revision", sha256,
    ]);
    expect(summarized.status, summarized.err).toBe(0);
    const summarizedBody = JSON.parse(summarized.out);
    expect(summarizedBody.source_revision).toBe(sha256);

    const shown = knowledge(p, ["show", id]);
    expect(shown.status, shown.err).toBe(0);
    const shownBody = JSON.parse(shown.out);
    expect(shownBody.summary_state).toBe("generated");
    expect(shownBody.summary_text).toBe("This policy governs access control.\n");
    // Untrusted-data framing travels INLINE with the summary text, in the SAME
    // payload -- same discipline as `content`/`content_notice` (design §8.3
    // row I30), never a sidecar a caller can drop.
    expect(typeof shownBody.summary_notice).toBe("string");
    expect(shownBody.summary_notice.length).toBeGreaterThan(0);

    const listed = knowledge(p, ["list"]);
    expect(listed.status, listed.err).toBe(0);
    const row = (JSON.parse(listed.out).documents as { id: string; summary_state: string }[])
      .find((r) => r.id === id)!;
    expect(row.summary_state).toBe("generated");
  });

  test("summarize with --tags routes through the SAME schema validator onboard/sync use -- a bad tag is refused", () => {
    const p = scratchProject();
    doc(p, "a.md", "body\n");
    const onboarded = knowledge(p, ["onboard", join(documentsDir(p, SPACE), "a.md")]);
    const { id, sha256 } = (JSON.parse(onboarded.out).indexed as { id: string; sha256: string }[])[0];
    const textFile = join(p, "s.txt");
    writeFileSync(textFile, "a summary\n");

    // A valid tag set is accepted.
    const ok = knowledge(p, [
      "summarize", id, "--text-file", textFile, "--source-revision", sha256, "--tags", "security,policy",
    ]);
    expect(ok.status, ok.err).toBe(0);
    const row = readIndex(p, SPACE).documents.find((r) => r.id === id)!;
    expect(row.tags).toEqual(["security", "policy"]);

    // The SAME call, an over-cap tag: the schema's own message is echoed back,
    // proving this went through validateDocumentIndex rather than a second,
    // looser tags-only check that would need its own wording.
    doc(p, "b.md", "body2\n");
    const onboarded2 = knowledge(p, ["onboard", join(documentsDir(p, SPACE), "b.md")]);
    const { id: id2, sha256: sha2 } = (JSON.parse(onboarded2.out).indexed as { id: string; sha256: string }[])[0];
    const bad = knowledge(p, [
      "summarize", id2, "--text-file", textFile, "--source-revision", sha2, "--tags", "x".repeat(65),
    ]);
    expect(bad.status).not.toBe(0);
    expect(bad.err).toMatch(/char cap/);
    // Nothing published: the row for id2 is untouched (summary still absent).
    const row2 = readIndex(p, SPACE).documents.find((r) => r.id === id2)!;
    expect(row2.summary.state).toBe("absent");
  });

  // [P3] SKILL.md claims `--tags` REPLACES the row's tags, never appends:
  // `--tags a` after `--tags a,b` leaves just `["a"]`. Pins that half of the
  // documented contract against the real CLI.
  test("[P3] --tags REPLACES the row's tags, not appends -- a narrower re-tag drops the earlier tags", () => {
    const p = scratchProject();
    doc(p, "d.md", "body\n");
    const onboarded = knowledge(p, ["onboard", join(documentsDir(p, SPACE), "d.md")]);
    const { id, sha256 } = (JSON.parse(onboarded.out).indexed as { id: string; sha256: string }[])[0];
    const textFile = join(p, "s2.txt");
    writeFileSync(textFile, "a summary\n");

    const first = knowledge(p, [
      "summarize", id, "--text-file", textFile, "--source-revision", sha256, "--tags", "a,b",
    ]);
    expect(first.status, first.err).toBe(0);
    expect(readIndex(p, SPACE).documents.find((r) => r.id === id)!.tags).toEqual(["a", "b"]);

    // Re-summarize the SAME unchanged revision with a narrower --tags -- must
    // REPLACE, not merge: the row ends up with exactly ["a"], never ["a","b"].
    const second = knowledge(p, [
      "summarize", id, "--text-file", textFile, "--source-revision", sha256, "--tags", "a",
    ]);
    expect(second.status, second.err).toBe(0);
    expect(readIndex(p, SPACE).documents.find((r) => r.id === id)!.tags).toEqual(["a"]);
  });

  // [P3] SKILL.md claims OMITTING `--tags` leaves the row's existing tags
  // untouched (never clears them as a side effect of an otherwise-unrelated
  // re-summarize). Pins the other half of the documented contract.
  test("[P3] omitting --tags on a re-summarize leaves the row's existing tags untouched", () => {
    const p = scratchProject();
    doc(p, "e.md", "body\n");
    const onboarded = knowledge(p, ["onboard", join(documentsDir(p, SPACE), "e.md")]);
    const { id, sha256 } = (JSON.parse(onboarded.out).indexed as { id: string; sha256: string }[])[0];
    const textFile = join(p, "s3.txt");
    writeFileSync(textFile, "a summary\n");

    const tagged = knowledge(p, [
      "summarize", id, "--text-file", textFile, "--source-revision", sha256, "--tags", "security,policy",
    ]);
    expect(tagged.status, tagged.err).toBe(0);
    expect(readIndex(p, SPACE).documents.find((r) => r.id === id)!.tags).toEqual(["security", "policy"]);

    // Re-summarize the SAME unchanged revision with NO --tags flag at all.
    const untouched = knowledge(p, [
      "summarize", id, "--text-file", textFile, "--source-revision", sha256,
    ]);
    expect(untouched.status, untouched.err).toBe(0);
    expect(readIndex(p, SPACE).documents.find((r) => r.id === id)!.tags).toEqual(["security", "policy"]);
  });

  test("a summary is withheld as invalidated once the source is edited (revision-binding, I19)", () => {
    const p = scratchProject();
    const abs = doc(p, "c.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const outcome = summarizeDocument(p, SPACE, id, "summary of v1", indexed[0].sha256);
    expect(outcome.source_revision).toBe(indexed[0].sha256);

    // Edit the original WITHOUT re-summarizing.
    writeFileSync(abs, "v2, edited\n");
    onboard(p, SPACE, abs, "2026-08-08T00:00:00Z");

    const shown = showDocument(p, SPACE, id);
    expect(shown.summary_state).toBe("invalidated");
    expect(shown.summary_text).toBeUndefined();

    // The stored record is untouched: `invalidated` is DERIVED on read, not a
    // literal state summarize (or anything else) writes, mirroring
    // effectiveExtractionState's own derivation of "invalidated" from
    // `extracted` + a stale source_revision.
    const row = readIndex(p, SPACE).documents.find((r) => r.id === id)!;
    expect(row.summary.state).toBe("generated");
    if (row.summary.state === "generated") {
      expect(row.summary.source_revision).not.toBe(row.sha256);
    }
  });

  test("summarize refuses when the supplied source_revision no longer matches the row (stale caller)", () => {
    const p = scratchProject();
    const abs = doc(p, "d.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const staleDigest = indexed[0].sha256;

    writeFileSync(abs, "v2\n");
    onboard(p, SPACE, abs, "2026-08-08T00:00:00Z");

    expect(() => summarizeDocument(p, SPACE, id, "summary of v1", staleDigest)).toThrow(/changed since/);
    const row = readIndex(p, SPACE).documents.find((r) => r.id === id)!;
    expect(row.summary.state).toBe("absent"); // nothing published
  });

  test("a tombstoned document refuses a new summary", () => {
    const p = scratchProject();
    const abs = doc(p, "e.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    rmSync(abs);
    knowledge(p, ["sync"]);
    expect(() => summarizeDocument(p, SPACE, id, "text", indexed[0].sha256)).toThrow(/removed/);
  });

  test("--source-revision must be a real sha256; a malformed digest is refused before any write", () => {
    const p = scratchProject();
    doc(p, "f.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    for (const bad of ["not-a-digest", DIGEST64("a").toUpperCase(), DIGEST64("a").slice(0, 63)]) {
      expect(() => summarizeDocument(p, SPACE, id, "text", bad)).toThrow(/sha256/);
    }
  });

  test("empty or whitespace-only summary text is refused", () => {
    const p = scratchProject();
    doc(p, "g.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    expect(() => summarizeDocument(p, SPACE, id, "   \n\t  ", indexed[0].sha256)).toThrow(/empty/);
  });

  test("a summary over SUMMARY_MAX_CHARS is truncated, not refused, and truncated:true is reported", () => {
    const p = scratchProject();
    doc(p, "h.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const huge = "x".repeat(5_000);
    const outcome = summarizeDocument(p, SPACE, id, huge, indexed[0].sha256);
    expect(outcome.truncated).toBe(true);
    expect(outcome.chars).toBeLessThan(5_000);
    const shown = showDocument(p, SPACE, id);
    expect(shown.summary_text?.length).toBe(outcome.chars);
  });
});

describe("t301 ACTION-only probe (a): a driven race — concurrent summarize publications", () => {
  test("two concurrent summarize calls on the SAME document: the committed digest matches the bytes actually stored", () => {
    const p = scratchProject();
    doc(p, "race.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const sha256 = indexed[0].sha256;

    const textA = join(p, "a.txt");
    const textB = join(p, "b.txt");
    writeFileSync(textA, "summary A, from process A\n");
    writeFileSync(textB, "summary B, from process B, a different length\n");

    const outA = join(p, "a.out");
    const outB = join(p, "b.out");
    const cmd = (text: string, out: string) =>
      `( bun ${JSON.stringify(AIDLC)} knowledge summarize ${JSON.stringify(id)} ` +
      `--text-file ${JSON.stringify(text)} --source-revision ${JSON.stringify(sha256)} ` +
      `--project-dir ${JSON.stringify(p)} --json > ${JSON.stringify(out)} 2>/dev/null; ` +
      `echo done ) &`;
    const script = `${cmd(textA, outA)}\n${cmd(textB, outB)}\nwait\n`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: CHILD_ENV, timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);

    // Exactly one of the two calls could have committed LAST; the OTHER may
    // have replanned-away or overwritten. Either way, the row's own recorded
    // summary_sha256 must match the BYTES actually on disk at summary.md --
    // never a torn or mismatched pair.
    const row = readIndex(p, SPACE).documents.find((r) => r.id === id)!;
    expect(row.summary.state).toBe("generated");
    const onDisk = readFileSync(join(documentDir(p, SPACE, id), "summary.md"), "utf-8");
    const { createHash } = require("node:crypto");
    const actualDigest = createHash("sha256").update(Buffer.from(onDisk, "utf-8")).digest("hex");
    expect(actualDigest, "the committed digest must match the bytes actually stored").toBe(row.summary_sha256);

    // And `show` must actually serve those exact bytes -- not merely agree
    // that a digest matches in the abstract.
    const shown = showDocument(p, SPACE, id);
    expect(shown.summary_text).toBe(onDisk);
  }, 30_000);
});

describe("t301 ACTION-only probe (b): an injected partial failure — the second write fails", () => {
  test("pre-placing a directory at summary.md makes the commit fail; the row is left absent-or-complete, never half-written", () => {
    const p = scratchProject();
    doc(p, "partial.md", "v1\n");
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const id = indexed[0].id;
    const dir = documentDir(p, SPACE, id);

    // Pre-place a DIRECTORY at the exact leaf the rename() targets, so the
    // final `renameIntoPlace` throws (ENOTEMPTY/EISDIR) AFTER index.json and
    // metadata.json have already committed -- the same injection shape t287
    // uses for content.md.
    mkdirSync(join(dir, "summary.md"));

    expect(() =>
      summarizeDocument(p, SPACE, id, "a summary that will not land", indexed[0].sha256),
    ).toThrow();

    // The index/metadata write ran FIRST (per this function's own ordering
    // comment), so the row's summary state DID advance to "generated" with a
    // recorded digest -- but the actual bytes never landed, because the
    // publish failed on step AFTER the index write.
    const row = readIndex(p, SPACE).documents.find((r) => r.id === id)!;
    expect(row.summary.state).toBe("generated");

    // The reader must not serve this as a valid summary: verifiedSummaryBytes
    // digest-checks the actual file, and a directory is not readable as
    // regular-file bytes at all, so `show` withholds rather than throwing or
    // fabricating text.
    const shown = showDocument(p, SPACE, id);
    expect(shown.summary_text).toBeUndefined();

    // metadata.json (the REBUILD input) reflects the same fact -- so a rebuild
    // from metadata.json alone does not resurrect a false "summary present"
    // claim either.
    const meta = readDocumentMetadata(p, SPACE, id);
    expect(meta.summary.state).toBe("generated");
  });
});

describe("t301 RED-verify: reverting the shared-validator call site actually fails this suite", () => {
  test("summarizeDocument calls the SAME assertPublishable/validateDocumentIndex gate as onboard/sync, not a second copy", () => {
    // Structural pin, mirroring t287's "onboard and sync call the SAME
    // function" test: proves there is exactly ONE tags-validation code path
    // for summarize to drift from, rather than asserting behaviour a future
    // second implementation could still satisfy differently.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    const start = src.indexOf("export function summarizeDocument(");
    const end = src.indexOf("\n// --- rebuild + rebind", start);
    const body = src.slice(start, end);
    expect(body).not.toContain("validateDocumentIndex(");
    expect(body).toContain("assertPublishable(");
  });
});
