// covers: function:claimPlaces, function:isClaimTreeFile, function:unitResultRootOf, function:readClaimAt, function:claimBlobAt
//
// Where a claim commit's tree holds its claim file and a Unit's result folder
// has one owner, aidlc-unit-holders.ts. For a project at the repository's top
// the project's aidlc/ folder is read first, then the tree's top, where this
// release and 2.11 write; in a folder of a bigger repository (apps/web) only
// apps/web/aidlc/, since no earlier release could claim there. Each read is one
// local-only git call whatever the tree holds. Built with real git: commits
// holding the file at either place, both, or none, a payload with non-ASCII
// text, and a blobless partial clone.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  claimBlobAt,
  claimPlaces,
  isClaimTreeFile,
  readClaimAt,
  unitResultRootOf,
} from "../../dist/claude/.claude/tools/aidlc-unit-holders.ts";

const TOP = ".aidlc-unit-claim.json";
const NEW = "aidlc/.aidlc-unit-claim.json";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-claim-places-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "user.email", "t@example.test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

// A commit holding exactly `files` (path from the repository's top: text).
function commitHolding(dir: string, files: Record<string, string>): string {
  git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", "."]);
  writeFileSync(join(dir, "keep.txt"), `${Object.keys(files).join(",")}\n`);
  git(dir, ["add", "keep.txt"]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...path.split("/")), text);
    git(dir, ["add", "-f", "--", path]);
  }
  git(dir, ["commit", "-q", "-m", Object.keys(files).join(" ") || "none"]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// The git processes `read` starts, from git's own trace.
function gitCallsOf(read: () => void): number {
  const trace = join(mkdtempSync(join(tmpdir(), "aidlc-claim-trace-")), "trace.json");
  dirs.push(join(trace, ".."));
  const before = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    read();
  } finally {
    if (before === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = before;
  }
  return readFileSync(trace, "utf-8").split("\n").filter((line) => line.includes('"event":"start"')).length;
}

describe("the places", () => {
  test("at the repository's top: the project's aidlc/ folder, then the top", () => {
    expect(claimPlaces("")).toEqual([NEW, TOP]);
  });

  test("in apps/web of a bigger repository: only apps/web/aidlc/", () => {
    expect(claimPlaces("apps/web/")).toEqual(["apps/web/aidlc/.aidlc-unit-claim.json"]);
  });

  test("what a landing leaves off main, at the top", () => {
    for (const path of [TOP, NEW, ".aidlc-unit-result/amendments/x.md", "aidlc/.aidlc-unit-result/x/y.md"]) {
      expect(isClaimTreeFile("", path), path).toBe(true);
    }
    for (const path of ["src/.aidlc-unit-claim.json", "aidlc/.aidlc-unit-results/x.md", ".aidlc-unit-result", "README.md"]) {
      expect(isClaimTreeFile("", path), path).toBe(false);
    }
    expect(unitResultRootOf("", "aidlc/.aidlc-unit-result/a/b.md")).toBe("aidlc/.aidlc-unit-result/");
    expect(unitResultRootOf("", ".aidlc-unit-result/a.md")).toBe(".aidlc-unit-result/");
  });

  test("what a landing leaves off main, in apps/web", () => {
    const prefix = "apps/web/";
    expect(isClaimTreeFile(prefix, "apps/web/aidlc/.aidlc-unit-claim.json")).toBe(true);
    expect(isClaimTreeFile(prefix, "apps/web/aidlc/.aidlc-unit-result/a.md")).toBe(true);
    for (const path of [TOP, NEW, ".aidlc-unit-result/a.md", "apps/web/.aidlc-unit-result/a.md", "apps/web/.aidlc-unit-claim.json"]) {
      expect(isClaimTreeFile(prefix, path), path).toBe(false);
    }
    expect(unitResultRootOf(prefix, "apps/web/aidlc/.aidlc-unit-result/a.md")).toBe("apps/web/aidlc/.aidlc-unit-result/");
  });
});

describe("reading a claim commit's file", () => {
  const dir = repo();
  const top = commitHolding(dir, { [TOP]: '{"at":"top"}\n' });
  const inAidlc = commitHolding(dir, { [NEW]: '{"at":"aidlc"}\n' });
  const both = commitHolding(dir, { [TOP]: '{"at":"top"}\n', [NEW]: '{"at":"aidlc"}\n' });
  const none = commitHolding(dir, {});
  const nonAscii = commitHolding(dir, { [TOP]: '{"owner":"\u00e9quipe caf\u00e9"}\n' });

  test("each place, the aidlc/ folder first, and none", () => {
    expect(readClaimAt(dir, top, "")).toEqual({ place: TOP, text: '{"at":"top"}\n' });
    expect(readClaimAt(dir, inAidlc, "")).toEqual({ place: NEW, text: '{"at":"aidlc"}\n' });
    expect(readClaimAt(dir, both, "")).toEqual({ place: NEW, text: '{"at":"aidlc"}\n' });
    expect(readClaimAt(dir, none, "")).toBeNull();
    expect(readClaimAt(dir, "0".repeat(40), "")).toBeNull();
  });

  test("a payload's non-ASCII text whole", () => {
    expect(readClaimAt(dir, nonAscii, "")?.text).toBe('{"owner":"\u00e9quipe caf\u00e9"}\n');
  });

  test("the blob and its place", () => {
    expect(claimBlobAt(dir, top, "")).toEqual({ place: TOP, blob: git(dir, ["rev-parse", `${top}:${TOP}`]) });
    expect(claimBlobAt(dir, both, "")).toEqual({ place: NEW, blob: git(dir, ["rev-parse", `${both}:${NEW}`]) });
    expect(claimBlobAt(dir, none, "")).toBeNull();
  });

  test("one git call for every place", () => {
    expect(gitCallsOf(() => readClaimAt(dir, top, ""))).toBe(1);
    expect(gitCallsOf(() => claimBlobAt(dir, top, ""))).toBe(1);
  });

  test("in apps/web: only apps/web/aidlc/, read from the folder", () => {
    const mono = repo();
    const held = commitHolding(mono, { [TOP]: '{"at":"top"}\n', "apps/web/aidlc/.aidlc-unit-claim.json": '{"at":"web"}\n' });
    const topOnly = commitHolding(mono, { [TOP]: '{"at":"top"}\n' });
    const web = join(mono, "apps", "web");
    mkdirSync(web, { recursive: true });
    expect(readClaimAt(web, held, "apps/web/")).toEqual({ place: "apps/web/aidlc/.aidlc-unit-claim.json", text: '{"at":"web"}\n' });
    expect(claimBlobAt(web, held, "apps/web/")?.place).toBe("apps/web/aidlc/.aidlc-unit-claim.json");
    expect(readClaimAt(web, topOnly, "apps/web/")).toBeNull();
    expect(claimBlobAt(web, topOnly, "apps/web/")).toBeNull();
  });

  test("in a blobless partial clone: the blob is named, and its text is not read until fetched", () => {
    git(dir, ["config", "uploadpack.allowFilter", "true"]);
    const partial = join(mkdtempSync(join(tmpdir(), "aidlc-claim-partial-")), "c");
    dirs.push(join(partial, ".."));
    git(tmpdir(), ["clone", "-q", "--no-checkout", "--filter=blob:none", pathToFileURL(dir).href, partial]);
    expect(claimBlobAt(partial, inAidlc, "")).toEqual({ place: NEW, blob: git(dir, ["rev-parse", `${inAidlc}:${NEW}`]) });
    expect(readClaimAt(partial, inAidlc, "")).toBeNull();
  });
});
