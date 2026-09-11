// covers: function:parseUnitSourceListing
// covers: function:reviewedSourceEvidencePath
// covers: function:normalizeManifestSourcePath
// covers: function:sourcePathIsExcluded
//
// t311 - committed reviewed-source evidence (commit provenance D1). The review
// receipt's Unit Source Fingerprint is the sha256 of the serialized unit
// listing; this suite pins that writeUnitSourceSnapshot dual-writes those
// EXACT bytes into the committed record (construction/<unit>/<stage>/
// reviewed-source-<hash12>.tsv) beside the gitignored .aidlc-source-review
// copy, that parseUnitSourceListing round-trips the committed bytes and
// rejects every malformed shape, and that the two exported attribution
// predicates (normalizeManifestSourcePath, sourcePathIsExcluded) hold the
// contracts aidlc-attest.ts resolve/anchor depend on.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeManifestSourcePath,
  parseUnitSourceListing,
  readUnitSourceManifest,
  reviewedSourceEvidencePath,
  serializeSourceListing,
  sourcePathIsExcluded,
  sourcePathKey,
  workspaceSourceListing,
  writeUnitSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function fixture(): { project: string; record: string } {
  const project = mkdtempSync(join(tmpdir(), "aidlc-t311-"));
  dirs.push(project);
  const record = join(project, "aidlc", "spaces", "default", "intents", "fixture-intent");
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "aidlc-state.md"), "# State\n- **Scope**: feature\n", "utf-8");
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", "intents.json"), `${JSON.stringify([{ uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "active", repos: [] }])}\n`);
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", ".active-intent"), "fixture-intent\n");
  git(project, ["init", "-q"]); git(project, ["config", "user.email", "t@test"]); git(project, ["config", "user.name", "t"]);
  writeFileSync(join(project, "app.ts"), "export const app = 1;\n"); git(project, ["add", "-A"]); git(project, ["commit", "-qm", "seed"]);
  return { project, record };
}

/** Manifest + snapshot for unit alpha claiming app.ts only, with one extra
 *  unclaimed workspace file so claim restriction is observable. */
function snapshotFixture(): {
  project: string;
  record: string;
  fingerprint: string;
  hex: string;
  committedPath: string;
  localPath: string;
  rewrite: () => string;
  manifestSha256: string;
} {
  const { project, record } = fixture();
  writeFileSync(join(project, "extra.ts"), "export const extra = 2;\n");
  const dir = join(record, "construction", "alpha", "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }] })}\n`);
  const claims = readUnitSourceManifest(project, "code-generation", "alpha");
  expect(claims.ok).toBe(true);
  if (!claims.ok) throw new Error(claims.reason);
  const listing = workspaceSourceListing(project);
  if (listing === null) throw new Error("workspace listing missing");
  expect(listing.has("\0extra.ts")).toBe(true); // full listing sees the unclaimed file
  const rewrite = () => writeUnitSourceSnapshot(project, "code-generation", "alpha", listing, claims, claims.rawBytesSha256);
  const fingerprint = rewrite();
  const hex = /^sha256:([0-9a-f]{64})$/.exec(fingerprint)?.[1];
  if (hex === undefined) throw new Error(`malformed fingerprint ${fingerprint}`);
  return {
    project,
    record,
    fingerprint,
    hex,
    committedPath: reviewedSourceEvidencePath(record, "alpha", "code-generation", hex.slice(0, 12)),
    localPath: join(record, ".aidlc-source-review", "code-generation", `unit-alpha-${hex.slice(0, 12)}.tsv`),
    rewrite,
    manifestSha256: claims.rawBytesSha256,
  };
}

describe("t311 committed reviewed-source evidence", () => {
  test("dual-write lands byte-identical committed and local evidence whose sha256 is the receipt fingerprint", () => {
    const { record, hex, committedPath, localPath, manifestSha256 } = snapshotFixture();
    expect(committedPath).toBe(join(record, "construction", "alpha", "code-generation", `reviewed-source-${hex.slice(0, 12)}.tsv`));

    const committedBytes = readFileSync(committedPath);
    expect(createHash("sha256").update(committedBytes).digest("hex")).toBe(hex);
    expect(readFileSync(localPath).equals(committedBytes)).toBe(true);

    // Round-trip: the committed bytes reparse to the manifest binding plus the
    // CLAIM-RESTRICTED listing (extra.ts stays out; only app.ts was claimed).
    const parsed = parseUnitSourceListing(committedBytes.toString("utf-8"));
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.manifestSha256).toBe(manifestSha256);
    expect([...parsed.listing.keys()]).toEqual(["\0app.ts"]);
    expect(parsed.listing.get("\0app.ts")).toMatch(/^100644 [0-9a-f]{40,64}$/);
  });

  test("re-write is idempotent and a divergent payload at either address fails closed", () => {
    const { fingerprint, committedPath, localPath, rewrite } = snapshotFixture();
    expect(rewrite()).toBe(fingerprint); // identical bytes: no-op, same fingerprint

    const original = readFileSync(committedPath);
    writeFileSync(committedPath, "tampered committed evidence\n");
    expect(rewrite).toThrow(/address collision or corruption/);

    writeFileSync(committedPath, original); // restore; now tamper only the local copy
    writeFileSync(localPath, "tampered local snapshot\n");
    expect(rewrite).toThrow(/address collision or corruption/);

    writeFileSync(localPath, original);
    expect(rewrite()).toBe(fingerprint);
  });

  test("parseUnitSourceListing accepts the serialized grammar and rejects malformed evidence", () => {
    const sha = "a".repeat(64);
    const oid = "b".repeat(40);
    const row = `\tapp.ts\t100644\t${oid}\n`;

    const parsed = parseUnitSourceListing(`manifest\t${sha}\t-\n${row}`);
    expect(parsed?.manifestSha256).toBe(sha);
    expect(parsed?.listing.get("\0app.ts")).toBe(`100644 ${oid}`);

    // A header with an empty listing is valid: a unit whose claims matched no
    // current path still binds its manifest bytes.
    expect(parseUnitSourceListing(`manifest\t${sha}\t-\n`)?.listing.size).toBe(0);

    // Escaped paths (tab in the filename) survive the TSV round-trip.
    const weird = serializeSourceListing(new Map([[sourcePathKey("", "has\ttab.ts"), `100644 ${oid}`]]));
    const reparsed = parseUnitSourceListing(`manifest\t${sha}\t-\n${weird}`);
    expect(reparsed?.listing.get("\0has\ttab.ts")).toBe(`100644 ${oid}`);

    const rejected = [
      "", // no newline at all
      `manifest\t${sha}\t-`, // header without terminating newline
      `manifest\t${"A".repeat(64)}\t-\n`, // uppercase manifest hash
      `manifest\t${sha.slice(1)}\t-\n`, // 63-hex manifest hash
      `manifest\t${sha}\n${row}`, // header missing its third field
      `manifest\t${sha}\t-\textra\n${row}`, // header with a fourth field
      `MANIFEST\t${sha}\t-\n${row}`, // wrong header tag
      `manifest\t${sha}\t-\n${row.slice(0, -1)}`, // listing missing trailing newline
      `manifest\t${sha}\t-\n\tapp.ts\tabcdef\t${oid}\n`, // non-numeric mode
      `manifest\t${sha}\t-\n\tapp.ts\t100644\tnot-hex\n`, // malformed OID
      `manifest\t${sha}\t-\n\t\t100644\t${oid}\n`, // empty path
      `manifest\t${sha}\t-\n${row}${row}`, // duplicate path key
    ];
    for (const bytes of rejected) expect(parseUnitSourceListing(bytes)).toBeNull();
  });

  test("normalizeManifestSourcePath canonicalizes relative claims and rejects escapes", () => {
    expect(normalizeManifestSourcePath("src/app.ts")).toEqual({ path: "src/app.ts", prefix: false });
    expect(normalizeManifestSourcePath("src/generated/")).toEqual({ path: "src/generated/", prefix: true });
    expect(normalizeManifestSourcePath("./src//app.ts")).toEqual({ path: "src/app.ts", prefix: false });
    expect(normalizeManifestSourcePath("src/./gen/")).toEqual({ path: "src/gen/", prefix: true });

    const reason = (path: string): string => {
      const result = normalizeManifestSourcePath(path);
      return "reason" in result ? result.reason : `accepted ${JSON.stringify(result)}`;
    };
    expect(reason("")).toContain("non-empty");
    expect(reason("a\0b.ts")).toContain("NUL byte");
    expect(reason("a\\b.ts")).toContain("POSIX '/' separators");
    expect(reason("/absolute.ts")).toContain("must be relative");
    expect(reason("C:/windows.ts")).toContain("must be relative");
    expect(reason("*.ts")).toContain("glob");
    expect(reason("src/../escape.ts")).toContain("'..' segments");
    expect(reason(".")).toContain("below the repository root");
    expect(reason("./")).toContain("below the repository root");
  });

  test("sourcePathIsExcluded excludes the framework shell and nested sensor dirs only where they live", () => {
    // Shell prefixes apply only when the queried repo carries the workspace shell.
    expect(sourcePathIsExcluded("aidlc/", true)).toBe(true);
    expect(sourcePathIsExcluded("aidlc/spaces/default/intents/i/audit/a.md", true)).toBe(true);
    expect(sourcePathIsExcluded(".aidlc/worktrees/bolt-x/app.ts", true)).toBe(true);
    expect(sourcePathIsExcluded("aidlc/notes.md", false)).toBe(false);
    expect(sourcePathIsExcluded("src/aidlc/notes.md", true)).toBe(false);
    expect(sourcePathIsExcluded("app.ts", true)).toBe(false);

    // Nested sensor dirs under an embedded record are excluded regardless of shell.
    expect(sourcePathIsExcluded("services/api/aidlc/spaces/default/intents/i/.aidlc-sensors/probe.ts", false)).toBe(true);
    expect(sourcePathIsExcluded("aidlc/spaces/default/intents/i/.aidlc-sensors/probe.ts", false)).toBe(true);
    expect(sourcePathIsExcluded("aidlc/spaces/default/intents/i/src/app.ts", false)).toBe(false);
    expect(sourcePathIsExcluded("src/.aidlc-sensors/probe.ts", false)).toBe(false);
  });
});
