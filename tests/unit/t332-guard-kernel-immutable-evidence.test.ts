// covers: function:immutableCommitSourceListing
// covers: function:immutableBlobBytes
// covers: function:immutableBlobSha256
// covers: function:commitCarriesContentTransformation
//
// t332 - immutable evidence is derived from proven Git objects.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  commitCarriesContentTransformation,
  immutableBlobBytes,
  immutableBlobSha256,
  immutableCommitSourceListing,
} from "../../core/tools/aidlc-guard-kernel.ts";

const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const FIXED_GIT_ENV = {
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
const ISOLATED_ENV_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
  pathBytes: Buffer;
}

let root = "";
let originalEnv: Map<string, string | undefined>;

function gitArgs(repoDir: string | null, args: readonly string[]): string[] {
  return repoDir === null ? [...args] : ["-C", repoDir, ...args];
}

function gitText(
  repoDir: string | null,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): string {
  const result = spawnSync("git", gitArgs(repoDir, args), {
    encoding: "utf-8",
    env: { ...process.env, ...FIXED_GIT_ENV, ...extraEnv },
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

function gitBytes(
  repoDir: string | null,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Buffer {
  const result = spawnSync("git", gitArgs(repoDir, args), {
    encoding: null,
    env: { ...process.env, ...FIXED_GIT_ENV, ...extraEnv },
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${String(result.stdout)}${String(result.stderr)}`,
    );
  }
  return result.stdout;
}

function nulRecords(output: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0) continue;
    if (index > start) records.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start < output.length) records.push(output.subarray(start));
  return records;
}

function initRepo(
  path: string,
  objectFormat?: "sha1" | "sha256",
): string {
  mkdirSync(path, { recursive: true });
  gitText(null, [
    "init",
    "-q",
    ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
    path,
  ]);
  gitText(path, ["config", "user.name", "Evidence Test"]);
  gitText(path, ["config", "user.email", "evidence@example.invalid"]);
  gitText(path, ["config", "core.filemode", "true"]);
  gitText(path, ["config", "core.symlinks", "true"]);
  return path;
}

function writePath(repoDir: string, path: string, contents: string): void {
  const absolute = join(repoDir, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf-8");
}

function commitAll(repoDir: string, message: string): string {
  gitText(repoDir, ["add", "-A"]);
  gitText(repoDir, ["commit", "-q", "-m", message]);
  return gitText(repoDir, ["rev-parse", "HEAD"]).trim();
}

function committedTree(repoDir: string, commit: string): TreeEntry[] {
  return nulRecords(
    gitBytes(repoDir, ["ls-tree", "-r", "-z", "--full-tree", commit]),
  ).map((record) => {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("tree record has no path separator");
    const [mode, type, oid] = record.subarray(0, tab).toString("ascii").split(" ");
    const pathBytes = record.subarray(tab + 1);
    return {
      mode,
      type,
      oid,
      path: pathBytes.toString("utf-8"),
      pathBytes,
    };
  });
}

function treeListing(entries: readonly TreeEntry[]): Map<string, string> {
  return new Map(
    entries.map((entry) => [
      `\0${entry.path}`,
      `${entry.mode} ${entry.oid}`,
    ]),
  );
}

function listingRows(listing: Map<string, string> | null): Array<[string, string]> {
  expect(listing).not.toBeNull();
  return [...listing!.entries()];
}

function materializedListing(
  repoDir: string,
  commit: string,
): Map<string, string> {
  const materializedRoot = mkdtempSync(join(root, "materialized-"));
  const checkoutDir = join(materializedRoot, "checkout");
  const indexFile = join(materializedRoot, "index");
  const env = { GIT_INDEX_FILE: indexFile };
  mkdirSync(checkoutDir);
  gitText(repoDir, ["read-tree", commit], env);
  gitText(
    repoDir,
    ["checkout-index", "-a", "-f", `--prefix=${checkoutDir}/`],
    env,
  );

  const listing = new Map<string, string>();
  for (const record of nulRecords(
    gitBytes(repoDir, ["ls-files", "-s", "-z"], env),
  )) {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("index record has no path separator");
    const match = /^(\d{6}) ([0-9a-f]{40,64}) \d+$/.exec(
      record.subarray(0, tab).toString("ascii"),
    );
    if (match === null) throw new Error("index record has no proven identity");
    const path = record.subarray(tab + 1).toString("utf-8");
    let oid = match[2];
    if (match[1] === "100644" || match[1] === "100755") {
      oid = gitText(
        repoDir,
        ["hash-object", "--no-filters", "--", join(checkoutDir, path)],
      ).trim();
    }
    listing.set(`\0${path}`, `${match[1]} ${oid}`);
  }
  return listing;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t332-guard-kernel-"));
  originalEnv = new Map(
    ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const globalConfig = join(root, "global.gitconfig");
  writeFileSync(globalConfig, "", "utf-8");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("guard kernel immutable evidence", () => {
  test("object-read equivalence: for a transformation-free repository the immutable listing equals the committed tree, entry for entry", () => {
    const repo = initRepo(join(root, "repo"));
    writePath(repo, "regular.txt", "regular bytes\n");
    writePath(repo, "bin/run.sh", "#!/bin/sh\nprintf '%s\\n' immutable\n");
    chmodSync(join(repo, "bin/run.sh"), 0o755);
    symlinkSync("regular.txt", join(repo, "regular.link"));
    const commit = commitAll(repo, "mode identities");

    const tree = committedTree(repo, commit);
    const expected = treeListing(tree);
    const actual = immutableCommitSourceListing(repo, commit, false);

    expect(listingRows(actual)).toEqual([...expected.entries()]);
    expect(listingRows(actual)).toEqual([
      ...materializedListing(repo, commit).entries(),
    ]);
    expect(tree.map((entry) => entry.mode).sort()).toEqual([
      "100644",
      "100755",
      "120000",
    ]);

    for (const entry of tree) {
      expect(entry.type).toBe("blob");
      const bytes = gitBytes(repo, ["cat-file", "blob", entry.oid]);
      expect(immutableBlobBytes(repo, entry.oid)).toEqual(bytes);
      expect(immutableBlobSha256(repo, entry.oid)).toBe(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      );
    }
  });

  test("materialization independence: evidence derivation reads no working-tree bytes", () => {
    const repo = initRepo(join(root, "repo"));
    writePath(repo, "source.txt", "commit A\n");
    const commitA = commitAll(repo, "commit A");
    const clean = immutableCommitSourceListing(repo, commitA, false);

    writePath(repo, "source.txt", "dirty working tree\n");
    writePath(repo, "untracked.txt", "untracked working tree\n");
    const dirty = immutableCommitSourceListing(repo, commitA, false);

    rmSync(join(repo, "untracked.txt"));
    writePath(repo, "source.txt", "commit B\n");
    commitAll(repo, "commit B");
    const differentCheckout = immutableCommitSourceListing(repo, commitA, false);

    const bare = join(root, "bare.git");
    gitText(null, ["clone", "-q", "--bare", repo, bare]);
    const noWorktree = immutableCommitSourceListing(bare, commitA, false);

    expect(listingRows(dirty)).toEqual(listingRows(clean));
    expect(listingRows(differentCheckout)).toEqual(listingRows(clean));
    expect(listingRows(noWorktree)).toEqual(listingRows(clean));
  });

  test("content-transformation exclusion: a transformation attribute on any listed path makes evidence underivable rather than transformed", () => {
    const repo = initRepo(join(root, "repo"));
    writePath(repo, "content.txt", "stable content\n");
    commitAll(repo, "content");

    const declarations = [
      "content.txt filter=proof-filter\n",
      "content.txt ident\n",
      "content.txt eol=lf\n",
      "content.txt text\n",
      "content.txt working-tree-encoding=UTF-8\n",
    ];
    for (const [index, declaration] of declarations.entries()) {
      writePath(repo, ".gitattributes", declaration);
      const transformed = commitAll(repo, `transformation ${index + 1}`);
      expect(
        commitCarriesContentTransformation(
          repo,
          transformed,
          ["content.txt"],
        ),
      ).toBe(true);
      expect(
        immutableCommitSourceListing(repo, transformed, false),
      ).toBeNull();
    }

    rmSync(join(repo, ".gitattributes"));
    const restored = commitAll(repo, "transformation removed");
    expect(
      commitCarriesContentTransformation(repo, restored, ["content.txt"]),
    ).toBe(false);
    expect(
      listingRows(immutableCommitSourceListing(repo, restored, false)),
    ).toEqual([...treeListing(committedTree(repo, restored)).entries()]);

    writePath(repo, ".git/info/attributes", "content.txt text\n");
    const globalAttributes = join(root, "global.attributes");
    writeFileSync(globalAttributes, "content.txt eol=crlf\n");
    gitText(repo, [
      "config",
      "--global",
      "core.attributesFile",
      globalAttributes,
    ]);
    expect(
      commitCarriesContentTransformation(repo, restored, ["content.txt"]),
    ).toBe(false);
    expect(
      immutableCommitSourceListing(repo, restored, false),
    ).not.toBeNull();
  });

  test("nested-repository boundary: a gitlink is recorded as its own identity and never expanded into nested working-tree content", () => {
    const nestedOrigin = initRepo(join(root, "nested-origin"));
    writePath(nestedOrigin, "nested.txt", "nested committed bytes\n");
    const nestedCommit = commitAll(nestedOrigin, "nested commit");

    const outer = initRepo(join(root, "outer"));
    writePath(outer, "outer.txt", "outer committed bytes\n");
    gitText(outer, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      nestedOrigin,
      "modules/nested",
    ]);
    const outerCommit = commitAll(outer, "outer gitlink");
    const nestedCheckout = join(outer, "modules/nested");
    writePath(nestedCheckout, "working-only.txt", "nested working bytes\n");

    const outerListing = immutableCommitSourceListing(
      outer,
      outerCommit,
      false,
    );
    expect(outerListing?.get("\0modules/nested")).toBe(
      `160000 ${nestedCommit}`,
    );
    expect(
      [...(outerListing?.keys() ?? [])].some((path) =>
        path.startsWith("\0modules/nested/")
      ),
    ).toBe(false);

    const nestedListing = immutableCommitSourceListing(
      nestedCheckout,
      nestedCommit,
      false,
    );
    expect(nestedListing?.has("\0nested.txt")).toBe(true);
    expect(nestedListing?.has("\0working-only.txt")).toBe(false);
  });

  test("commit provenance: evidence exists only for a proven commit object", () => {
    const repo = initRepo(join(root, "repo"));
    writePath(repo, "source.txt", "source\n");
    const commit = commitAll(repo, "proven commit");
    const tree = gitText(repo, ["rev-parse", `${commit}^{tree}`]).trim();
    gitText(repo, ["tag", "-a", "-m", "provenance tag", "provenance-tag"]);
    const tag = gitText(
      repo,
      ["rev-parse", "refs/tags/provenance-tag^{tag}"],
    ).trim();

    expect(immutableCommitSourceListing(repo, commit, false)).not.toBeNull();
    for (const malformed of [
      "",
      "HEAD",
      "not-an-object-id",
      "0".repeat(commit.length - 1),
      "0".repeat(commit.length + 1),
    ]) {
      expect(
        immutableCommitSourceListing(repo, malformed, false),
      ).toBeNull();
    }
    expect(
      immutableCommitSourceListing(
        repo,
        "0".repeat(commit.length),
        false,
      ),
    ).toBeNull();
    expect(immutableCommitSourceListing(repo, tag, false)).toBeNull();
    expect(immutableCommitSourceListing(repo, tree, false)).toBeNull();
    expect(
      commitCarriesContentTransformation(repo, tag, ["source.txt"]),
    ).toBeNull();
    expect(
      commitCarriesContentTransformation(repo, tree, ["source.txt"]),
    ).toBeNull();
    expect(immutableBlobBytes(repo, tree)).toBeNull();
    expect(immutableBlobSha256(repo, tag)).toBeNull();

    const sha256Repo = initRepo(join(root, "sha256-repo"), "sha256");
    writePath(sha256Repo, "source.txt", "sha256 source\n");
    const sha256Commit = commitAll(sha256Repo, "sha256 commit");
    expect(sha256Commit).toHaveLength(64);
    expect(
      immutableCommitSourceListing(
        sha256Repo,
        sha256Commit,
        false,
      ),
    ).not.toBeNull();
  });

  test("path fidelity: listing keys preserve exact path bytes", () => {
    const repo = initRepo(join(root, "repo"));
    const paths = [
      "space name.txt",
      "tab\tname.txt",
      "café-雪.txt",
      "line\nbreak.txt",
    ];
    for (const [index, path] of paths.entries()) {
      writePath(repo, path, `path ${index}\n`);
    }
    const commit = commitAll(repo, "path fidelity");

    const tree = committedTree(repo, commit);
    const listing = immutableCommitSourceListing(repo, commit, false);
    expect(listingRows(listing)).toEqual([...treeListing(tree).entries()]);
    expect(listing?.size).toBe(paths.length);

    for (const path of paths) {
      const entry = tree.find((candidate) => candidate.path === path);
      expect(entry).toBeDefined();
      expect(entry?.pathBytes).toEqual(Buffer.from(path, "utf-8"));
      expect(listing?.has(`\0${path}`)).toBe(true);
      expect(
        Buffer.from(
          [...(listing?.keys() ?? [])].find((key) => key === `\0${path}`)!
            .slice(1),
          "utf-8",
        ),
      ).toEqual(Buffer.from(path, "utf-8"));
    }
  });
});
