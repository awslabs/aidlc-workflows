#!/usr/bin/env bun
// copy-era-files.ts: writes scripts/copy-era-files.json, the files the copy-era
// releases put in a project, per harness: each path and the sha256 of every
// version a release shipped there. Those releases (2.1.1 to 2.7.0) were
// installed by copying their trees and wrote no install record, so without
// this `aidlc config` cannot tell their unchanged files from the person's own.
// scripts/package.ts adds them to each harness's legacy managed-file hashes.
//
// Usage: bun scripts/copy-era-files.ts [--check]
// Reads the repository's history. The copy channel was the v2 branch: a person
// checked it out and copied its dist/, so every state dist/ took from 2.1.1 up
// to the native distribution (NATIVE_DISTRIBUTION, which dropped dist/ from the
// tree) is a version a project may hold, tagged or not. 2.7.0 committed no
// dist/ and published no assets, so its tree is packaged from the tag in a new
// temporary folder (bun install, then its own scripts/package.ts), left in
// place for the caller. --check compares with the committed file instead of
// writing it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const OUT = join(REPO_ROOT, "scripts", "copy-era-files.json");
const FIRST_COPY_RELEASE = "v2.1.1";
const NATIVE_DISTRIBUTION = "12b8d6e049200692ea431e6344bdb796ed31187b";
const PACKAGED_FROM_TAG = ["v2.7.0"];

function run(cmd: string, args: string[], cwd: string, input?: Buffer): Buffer {
  const r = spawnSync(cmd, args, { cwd, input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}: ${r.stderr?.toString() ?? ""}`);
  return r.stdout;
}

const table: Record<string, Record<string, Set<string>>> = {};
// The form the projection descriptor's file signatures take (aidlc-distribution.ts validateHashes).
const sha256 = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function add(harness: string, rel: string, hash: string): void {
  const files = table[harness] ?? {};
  table[harness] = files;
  const hashes = files[rel] ?? new Set<string>();
  files[rel] = hashes;
  hashes.add(hash);
}

// Each committed state of dist/: every blob under dist/<harness>/, read through
// git, each blob hashed once.
const states = [
  FIRST_COPY_RELEASE,
  ...run("git", ["log", "--format=%H", `${FIRST_COPY_RELEASE}..${NATIVE_DISTRIBUTION}^`, "--", "dist/"], REPO_ROOT)
    .toString().split("\n").filter(Boolean),
];
const blobHashes = new Map<string, string>();
for (const commit of states) {
  const listing = run("git", ["ls-tree", "-r", commit, "dist/"], REPO_ROOT).toString().split("\n").filter(Boolean);
  for (const line of listing) {
    const [meta, path] = line.split("\t");
    const [, type, blob] = meta.split(" ");
    const parts = path.split("/");
    if (type !== "blob" || parts.length < 3 || parts[1] === "plugins") continue;
    let hash = blobHashes.get(blob);
    if (hash === undefined) {
      hash = sha256(run("git", ["cat-file", "blob", blob], REPO_ROOT));
      blobHashes.set(blob, hash);
    }
    add(parts[1], parts.slice(2).join("/"), hash);
  }
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

for (const tag of PACKAGED_FROM_TAG) {
  const tree = mkdtempSync(join(tmpdir(), `copy-era-${tag}-`));
  run("tar", ["-x", "-C", tree], REPO_ROOT, run("git", ["archive", "--format=tar", tag], REPO_ROOT));
  run("bun", ["install", "--frozen-lockfile"], tree);
  run("bun", ["scripts/package.ts"], tree);
  const dist = join(tree, "dist");
  for (const harness of readdirSync(dist)) {
    if (harness === "plugins" || !statSync(join(dist, harness)).isDirectory()) continue;
    for (const file of walk(join(dist, harness))) {
      add(harness, relative(join(dist, harness), file).split(sep).join("/"), sha256(readFileSync(file)));
    }
  }
  console.error(`packaged ${tag} in ${tree} (left in place)`);
}

const sorted = Object.fromEntries(Object.keys(table).sort().map((harness) => [
  harness,
  Object.fromEntries(Object.keys(table[harness]).sort().map((rel) => [rel, [...table[harness][rel]].sort()])),
]));
const text = `${JSON.stringify(sorted, null, 1)}\n`;
if (process.argv.includes("--check")) {
  const same = existsSync(OUT) && readFileSync(OUT, "utf-8") === text;
  console.log(same ? "copy-era-files.json is current" : "copy-era-files.json differs from the history");
  process.exit(same ? 0 : 1);
}
writeFileSync(OUT, text);
console.log(`wrote ${relative(REPO_ROOT, OUT)}: ${Object.values(sorted).reduce((n, files) => n + Object.keys(files).length, 0)} paths, ${text.length} bytes`);
