// covers: function:syncUploadLinks, function:acceptsSyncUploadLinks, function:singleOrSyncUploadLinked, function:linksSteadyWhileReading, function:hardLinkRefusal, function:readRegularFileNoFollowOrThrow
//
// Google Drive's Folder backup hard-links a file it is uploading into a hidden
// `.tmp.driveupload` folder. A record file whose every other link is there is
// read, with nothing printed; any other second link is still refused, and the
// refusal says what AI-DLC found. The reader, the plan-approval guard's
// predicate and the knowledge list-time check agree.

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  acceptsSyncUploadLinks,
  HARDLINK_REMEDY,
  hardLinkRefusal,
  linksSteadyWhileReading,
  resetSyncUploadCacheForTests,
  singleOrSyncUploadLinked,
  syncUploadLinks,
  syncUploadWalkCount,
} from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { readRegularFileNoFollowOrThrow } from "../../dist/claude/.claude/tools/aidlc-locks.ts";
import { documentsDir, listDocuments, onboard } from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const LOCKS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "aidlc-locks.ts");
const SERVICE = "Google Drive Folder backup";
const SPACE = "default";

const roots: string[] = [];
afterEach(() => {
  resetSyncUploadCacheForTests();
  for (const root of roots.splice(0)) cleanupTestProject(root);
});

function written(path: string, body = "record\n"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function linked(file: string, link: string): string {
  mkdirSync(dirname(link), { recursive: true });
  linkSync(file, link);
  return link;
}

// The search returns a link as its real folder plus its name; a temp folder
// can be spelled otherwise (an 8.3 short name on GitHub's Windows runners). The
// folder is resolved, not the link: a file's realpath can name another link.
const realPath = (path: string): string => join(realpathSync.native(dirname(path)), basename(path));

/** A home holding a backed-up Documents folder with a project in it, as Drive lays it out. */
function driveLayout(): { home: string; uploads: string; file: string } {
  const home = createTestProject();
  roots.push(home);
  const documents = join(home, "Documents");
  return {
    home,
    uploads: join(documents, ".tmp.driveupload"),
    file: written(join(documents, "project", "aidlc", "record.md")),
  };
}

type Op = { read: string } | { link: [string, string] };
type Outcome = { ok?: string; error?: string };

// A child process: Bun reads the home folder once, at start.
function readInChild(home: string, ops: Op[]): { results: Outcome[]; stderr: string } {
  const script = `const { readRegularFileNoFollowOrThrow } = await import(${JSON.stringify(LOCKS)});
const { linkSync } = await import("node:fs");
const out = [];
for (const op of ${JSON.stringify(ops)}) {
  if (op.link) { linkSync(op.link[0], op.link[1]); continue; }
  try { out.push({ ok: readRegularFileNoFollowOrThrow(op.read, "record file").toString() }); }
  catch (error) { out.push({ error: String(error.message) }); }
}
console.log(JSON.stringify(out));`;
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(child.status, child.stderr).toBe(0);
  return {
    results: JSON.parse(child.stdout.trim().split("\n").pop() ?? "[]"),
    stderr: child.stderr,
  };
}

describe("t-sync-upload-hardlinks a record file linked only by Drive's upload folder", () => {
  // A read that worked leaves the person nothing to do, so it prints nothing.
  test("1. is read, and nothing is printed", () => {
    const { home, uploads, file } = driveLayout();
    linked(file, join(uploads, "record.md"));
    const { results, stderr } = readInChild(home, [{ read: file }]);
    expect(results).toEqual([{ ok: "record\n" }]);
    expect(stderr).toBe("");
  });

  test("2. is read every time, and nothing is printed", () => {
    const { home, uploads, file } = driveLayout();
    linked(file, join(uploads, "record.md"));
    const { results, stderr } = readInChild(home, [{ read: file }, { read: file }]);
    expect(results).toEqual([{ ok: "record\n" }, { ok: "record\n" }]);
    expect(stderr).toBe("");
  });

  test("3. finds a link folders deep inside the upload folder", () => {
    const { home, uploads, file } = driveLayout();
    const nested = linked(file, join(uploads, "a1", "b2", "record.md"));
    const stat = statSync(file);
    expect(syncUploadLinks(file, stat, { home })).toEqual({ service: SERVICE, paths: [realPath(nested)], complete: true });
    expect(acceptsSyncUploadLinks(file, stat, { home }).accepted).toBe(true);
  });

  test("4. refuses a file with links both in the upload folder and elsewhere, naming what it found", () => {
    const { home, uploads, file } = driveLayout();
    const upload = linked(file, join(uploads, "record.md"));
    linked(file, join(home, "elsewhere.md"));
    const { results } = readInChild(home, [{ read: file }]);
    expect(results).toHaveLength(1);
    const error = results[0]!.error ?? "";
    expect(error).toContain(`record file is multiply linked (a hardlink) and is not trusted: ${file}`);
    expect(error).toContain("It has 3 links.");
    expect(error).toContain(realPath(upload));
    expect(error).toContain("1 link unaccounted for");
  });

  test("5. refuses a second link when no upload folder holds it, and says AI-DLC cannot see where", () => {
    const { home, file } = driveLayout();
    linked(file, join(home, "elsewhere.md"));
    const stat = statSync(file);
    const { accepted, result } = acceptsSyncUploadLinks(file, stat, { home });
    expect(accepted).toBe(false);
    expect(result).toEqual({ service: null, paths: [], complete: true });
    const refusal = hardLinkRefusal("record file", file, stat.nlink, result);
    expect(refusal).toContain("It has 2 links, and AI-DLC cannot see where the other one is.");
    expect(refusal).toContain("backup and sync clients commonly make them");
    expect(refusal).toContain(HARDLINK_REMEDY);
    expect(refusal).not.toMatch(/&&|\bcp |\bmv /);
    // Several links: counted, in the plural.
    expect(hardLinkRefusal("record file", file, 3, result)).toContain(
      "It has 3 links, and AI-DLC cannot see where the other 2 are.",
    );
    const two = { service: SERVICE, paths: ["/u/a", "/u/b"], complete: true };
    expect(hardLinkRefusal("record file", file, 5, two)).toContain(`2 other links are in ${SERVICE}'s upload folder`);
    expect(hardLinkRefusal("record file", file, 5, two)).toContain("2 links unaccounted for");
  });

  test("6. refuses a link in an upload folder that is a symlink to a real folder", () => {
    const { home, uploads, file } = driveLayout();
    const real = join(home, "real-uploads");
    linked(file, join(real, "record.md"));
    symlinkSync(real, uploads, process.platform === "win32" ? "junction" : "dir");
    const stat = statSync(file);
    expect(syncUploadLinks(file, stat, { home }).paths).toEqual([]);
    expect(acceptsSyncUploadLinks(file, stat, { home }).accepted).toBe(false);
  });

  test("7. refuses a link in an upload folder another user owns; Windows has no owner to check", () => {
    const { home, uploads, file } = driveLayout();
    const upload = linked(file, join(uploads, "record.md"));
    const stat = statSync(file);
    const owner = statSync(uploads).uid;
    expect(syncUploadLinks(file, stat, { home, platform: "linux", uid: owner + 1 }).paths).toEqual([]);
    expect(syncUploadLinks(file, stat, { home, platform: "linux", uid: owner }).paths).toEqual([realPath(upload)]);
    expect(syncUploadLinks(file, stat, { home, platform: "win32", uid: owner + 1 }).paths).toEqual([realPath(upload)]);
    expect(acceptsSyncUploadLinks(file, stat, { home, platform: "linux", uid: owner + 1 }).accepted).toBe(false);
  });

  test("8. treats a search cut off at the entry cap as not found", () => {
    const { home, uploads, file } = driveLayout();
    for (let i = 0; i < 5; i++) written(join(uploads, `other-${i}.md`));
    linked(file, join(uploads, "record.md"));
    const stat = statSync(file);
    const { accepted, result } = acceptsSyncUploadLinks(file, stat, { home, maxEntries: 2 });
    expect(accepted).toBe(false);
    expect(result.complete).toBe(false);
    expect(hardLinkRefusal("record file", file, stat.nlink, result)).toContain(
      "AI-DLC could not search an upload folder to the end.",
    );
    // A file whose folder cannot be resolved has nothing that can be searched.
    expect(syncUploadLinks(join(home, "missing", "record.md"), stat, { home }).complete).toBe(false);
  });

  test("9. an accepted read does not cover a link added afterwards", () => {
    const { home, uploads, file } = driveLayout();
    linked(file, join(uploads, "record.md"));
    const { results } = readInChild(home, [
      { read: file },
      { link: [file, join(home, "elsewhere.md")] },
      { read: file },
    ]);
    expect(results[0]).toEqual({ ok: "record\n" });
    expect(results[1]!.error).toContain("1 link unaccounted for");
  });

  test("10. after the read, links may drop when Drive's link was accepted, and may never rise", () => {
    expect(linksSteadyWhileReading({ nlink: 2, ctimeMs: 1 }, { nlink: 1, ctimeMs: 2 }, true)).toBe(true);
    expect(linksSteadyWhileReading({ nlink: 2, ctimeMs: 1 }, { nlink: 2, ctimeMs: 1 }, true)).toBe(true);
    expect(linksSteadyWhileReading({ nlink: 2, ctimeMs: 1 }, { nlink: 3, ctimeMs: 2 }, true)).toBe(false);
    expect(linksSteadyWhileReading({ nlink: 2, ctimeMs: 1 }, { nlink: 2, ctimeMs: 2 }, true)).toBe(false);
    expect(linksSteadyWhileReading({ nlink: 2, ctimeMs: 1 }, { nlink: 1, ctimeMs: 2 }, false)).toBe(false);
    expect(linksSteadyWhileReading({ nlink: 1, ctimeMs: 1 }, { nlink: 0, ctimeMs: 2 }, true)).toBe(false);
  });

  test("11. a single-linked file is read without searching for upload folders", () => {
    const { file } = driveLayout();
    expect(readRegularFileNoFollowOrThrow(file, "record file").toString()).toBe("record\n");
    expect(singleOrSyncUploadLinked(file, statSync(file))).toBe(true);
    expect(syncUploadWalkCount()).toBe(0);
  });

  test("12. the guard's predicate and the knowledge list agree with the reader", () => {
    // The upload folder is an ancestor of the project, so the real home folder finds it too.
    const home = createTestProject();
    roots.push(home);
    const project = join(home, "Documents", "project");
    const doc = written(join(documentsDir(project, SPACE), "notes.md"), "notes\n");
    linked(doc, join(home, "Documents", ".tmp.driveupload", "notes.md"));
    expect(singleOrSyncUploadLinked(doc, statSync(doc))).toBe(true);
    expect(onboard(project, SPACE, doc, "2026-11-16T00:00:00Z").indexed).toHaveLength(1);
    expect(listDocuments(project, SPACE).map((row) => row.status)).toEqual(["indexed"]);

    linked(doc, join(home, "elsewhere.md"));
    expect(singleOrSyncUploadLinked(doc, statSync(doc))).toBe(false);
    expect(listDocuments(project, SPACE).map((row) => row.status)).toEqual(["present_but_refused"]);
  });

  test("13. counts a link once when one upload folder sits inside another", () => {
    const home = createTestProject();
    roots.push(home);
    const project = join(home, "Documents", ".tmp.driveupload", "project");
    const file = written(join(project, "aidlc", "record.md"));
    const inner = linked(file, join(project, ".tmp.driveupload", "record.md"));
    linked(file, join(home, "elsewhere.md"));
    const stat = statSync(file);
    expect(syncUploadLinks(file, stat, { home }).paths).toEqual([realPath(inner)]);
    expect(acceptsSyncUploadLinks(file, stat, { home }).accepted).toBe(false);
    const { results } = readInChild(home, [{ read: file }]);
    expect(results[0]!.error).toContain("1 link unaccounted for");
  });
});
