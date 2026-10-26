// covers: function:workspaceSourceState, function:lastWorkspaceSourceFailure
// Git and jj choose different pack basenames. Exercise the source walk through
// real pack/index bytes, including a linked worktree's shared object store.

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { lastWorkspaceSourceFailure, workspaceSourceState } from "../../core/tools/aidlc-lib.ts";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});
const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest();

function packedCommit(version: 1 | 2) {
  const body = Buffer.from("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\nfixture\n");
  const oid = sha1(Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]));
  const objectHeader = [(1 << 4) | (body.length & 15)];
  let size = Math.floor(body.length / 16);
  while (size) {
    objectHeader[objectHeader.length - 1] |= 128;
    objectHeader.push(size & 127);
    size = Math.floor(size / 128);
  }
  const entry = Buffer.concat([Buffer.from(objectHeader), deflateSync(body)]);
  const header = Buffer.from("5041434b0000000200000001", "hex");
  const content = Buffer.concat([header, entry]);
  const packHash = sha1(content);
  const pack = Buffer.concat([content, packHash]);
  const fanout = Buffer.alloc(1024);
  for (let i = oid[0]; i < 256; i++) fanout.writeUInt32BE(1, i * 4);
  const offset = Buffer.alloc(4);
  offset.writeUInt32BE(12);
  let index: Buffer;
  if (version === 1) {
    index = Buffer.concat([fanout, offset, oid, packHash]);
  } else {
    let crc = 0xffffffff;
    for (const byte of entry) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const crcBytes = Buffer.alloc(4);
    crcBytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    index = Buffer.concat([Buffer.from("ff744f6300000002", "hex"), fanout, oid, crcBytes, offset, packHash]);
  }
  return { oid: oid.toString("hex"), pack, index: Buffer.concat([index, sha1(index)]) };
}

function fixture(name: string, version: 1 | 2 = 2, linked = false) {
  const root = mkdtempSync(join(tmpdir(), "aidlc-pack-boundary-"));
  scratch.push(root);
  const project = join(root, "project");
  const embedded = join(project, "embedded");
  const common = linked ? join(root, "store", ".git") : join(embedded, ".git");
  const gitdir = linked ? join(common, "worktrees", "evidence") : common;
  const packDir = join(common, "objects", "pack");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(join(common, "refs"), { recursive: true });
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(embedded, { recursive: true });
  writeFileSync(join(common, "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
  const data = packedCommit(version);
  writeFileSync(join(common, "HEAD"), `${data.oid}\n`);
  if (linked) {
    writeFileSync(join(embedded, ".git"), `gitdir: ${gitdir}\n`);
    writeFileSync(join(gitdir, "HEAD"), `${data.oid}\n`);
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    writeFileSync(join(gitdir, "gitdir"), `${join(embedded, ".git")}\n`);
  }
  writeFileSync(join(embedded, "app.ts"), "export const evidence = true;\n");
  const indexPath = join(packDir, `${name}.idx`);
  const packPath = join(packDir, `${name}.pack`);
  writeFileSync(indexPath, data.index);
  writeFileSync(packPath, data.pack);
  return { project, embedded, common, gitdir, packDir, indexPath, packPath, ...data };
}

function fingerprint(project: string) {
  const state = workspaceSourceState(project);
  expect(state, JSON.stringify(lastWorkspaceSourceFailure())).not.toBeNull();
  return state!.fingerprint;
}

for (const version of [1, 2] as const) {
  for (const linked of [false, true]) {
    test(`index v${version}, ${linked ? "linked" : "ordinary"} checkout: jj and custom pack names preserve the fingerprint`, () => {
      const f = fixture(`pack-${"a".repeat(40)}`, version, linked);
      const before = fingerprint(f.project);
      for (const name of [`loose-${"b".repeat(40)}`, "writer-chosen"] ) {
        const index = join(f.packDir, `${name}.idx`);
        const pack = join(f.packDir, `${name}.pack`);
        renameSync(f.indexPath, index);
        renameSync(f.packPath, pack);
        f.indexPath = index;
        f.packPath = pack;
        const git = spawnSync("git", ["-C", f.embedded, "cat-file", "-t", f.oid], { encoding: "utf8", timeout: 30_000 });
        expect(git.status, git.stderr).toBe(0);
        expect(git.stdout.trim()).toBe("commit");
        const verified = spawnSync("git", ["verify-pack", f.indexPath], { encoding: "utf8", timeout: 30_000 });
        expect(verified.status, verified.stderr).toBe(0);
        expect(fingerprint(f.project)).toBe(before);
      }
    });
  }
}

for (const failure of ["missing HEAD object", "missing pack", "malformed index", "unsupported index", "invalid pack", "index symlink", "pack symlink", "too many indexes", "oversized index"] as const) {
  test(`a jj-named pack still fails closed for ${failure}`, () => {
    const f = fixture(`loose-${"c".repeat(40)}`, 2, true);
    switch (failure) {
      case "missing HEAD object": writeFileSync(join(f.gitdir, "HEAD"), `${"d".repeat(40)}\n`); break;
      case "missing pack": rmSync(f.packPath); break;
      case "malformed index": writeFileSync(f.indexPath, "bad index"); break;
      case "unsupported index": {
        const index = readFileSync(f.indexPath);
        index.writeUInt32BE(3, 4);
        writeFileSync(f.indexPath, index);
        break;
      }
      case "invalid pack": writeFileSync(f.packPath, Buffer.alloc(128)); break;
      case "index symlink":
      case "pack symlink": {
        const path = failure === "index symlink" ? f.indexPath : f.packPath;
        renameSync(path, `${path}.target`);
        symlinkSync(`${path}.target`, path);
        break;
      }
      case "too many indexes":
        for (let i = 0; i < 256; i++) writeFileSync(join(f.packDir, `writer-${i}.idx`), f.index);
        break;
      case "oversized index": truncateSync(f.indexPath, 128 * 1024 * 1024 + 1); break;
    }
    expect(workspaceSourceState(f.project)).toBeNull();
    expect(lastWorkspaceSourceFailure()).toMatchObject({ code: "walk-failed", path: "embedded" });
    expect(lastWorkspaceSourceFailure()?.detail).toContain("no resolvable HEAD commit");
  });
}
