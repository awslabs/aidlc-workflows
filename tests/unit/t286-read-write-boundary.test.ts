// covers: function:readRegularFileNoFollowOrThrow function:writeBufferAtomic function:validSpaceFlag function:assertNoSymlinkInChainOrThrow function:SPACE_NAME_REGEX
//
// t286 - the shared read/write boundary primitives DocumentKB indexing is built
// on. All four arrive in this slice: three ported from the unmerged #660 line
// (which was reviewed only internally and never landed on upstream/v2, so
// nothing here inherits a "covered" status) and one generalised from a
// tool-local helper into a throwing library function.
//
// Mechanism: none for the pure functions; real filesystem for the boundary
// checks. No spawn, no LLM, no tokens. The fixtures build actual FIFOs, symlink
// loops, and device files under a temp dir, because the whole point of these
// primitives is what the OS does when you open the wrong KIND of thing -- a
// mocked stat cannot fail the way a real FIFO fails.
//
// Subject under test: dist/claude/.claude/tools/aidlc-lib.ts (the SHIPPED
// distributable, not core/ -- a guard reverted only in core/ still passes when
// the test imports dist, which would fake the "the test observes the defect"
// conclusion).
//
// The contract each block pins:
//
//   readRegularFileNoFollowOrThrow(path, what)
//     TYPE: only a regular file is read. Rejecting symlinks alone is a denylist
//     that admits every other kind -- a FIFO with no writer blocks forever (and
//     with a lock held, blocks the whole workspace), a character device never
//     reaches EOF so the read grows until ENOMEM.
//     TIME: opening ONCE with O_NOFOLLOW and fstat-ing THAT descriptor means the
//     identity checked is the identity read; lstat-then-readFileSync validates
//     one file and reads another if the name is swapped in between.
//
//   writeBufferAtomic(path, data)
//     Byte-exact twin of writeFileAtomic: exclusive-create sibling temp, then
//     rename. No utf-8 coercion, so bytes round-trip sha256-identical. Leaves no
//     temp behind on success, and cleans up its own temp on failure.
//
//   validSpaceFlag(raw)
//     A --space value is a path SEGMENT. Traversal, absolute paths, and any
//     non-slug shape return null so the caller can refuse before a join().
//
//   assertNoSymlinkInChainOrThrow(anchorReal, rel)
//     Refuses if ANY component of rel is a symlink, not just the leaf. A walk
//     that validates the container and then trusts its contents will read a
//     symlinked file inside an already-trusted dir -- that was #660's actual
//     regression.

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoSymlinkInChainOrThrow,
  readRegularFileNoFollowOrThrow,
  SPACE_NAME_REGEX,
  validSpaceFlag,
  writeBufferAtomic,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

let dir: string | undefined;

function scratch(): string {
  dir = mkdtempSync(join(tmpdir(), "t286-"));
  return dir;
}

afterEach(() => {
  if (dir !== undefined) {
    // chmod back so rm can descend into any dir a test made unreadable.
    try { chmodSync(dir, 0o700); } catch { /* already fine */ }
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("t286 readRegularFileNoFollowOrThrow - TYPE: only a regular file", () => {
  test("reads a regular file byte-for-byte, including NUL bytes", () => {
    const d = scratch();
    const p = join(d, "doc.bin");
    // Deliberately not valid utf-8: the primitive returns a Buffer, and a
    // utf-8 round trip through this path would corrupt captured PDF bytes.
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x0a]);
    writeFileSync(p, bytes);
    const got = readRegularFileNoFollowOrThrow(p, "source");
    expect(Buffer.compare(got, bytes)).toBe(0);
  });

  test("refuses a multiply-linked regular file", () => {
    const d = scratch();
    const original = join(d, "original.txt");
    const linked = join(d, "linked.txt");
    writeFileSync(original, "secret\n");
    linkSync(original, linked);
    expect(() => readRegularFileNoFollowOrThrow(linked, "doctor input"))
      .toThrow(/multiply linked/);
  });

  test("refuses a symlink WITHOUT following it, naming it as a symlink", () => {
    const d = scratch();
    const real = join(d, "real.txt");
    const link = join(d, "link.txt");
    writeFileSync(real, "secret-payload");
    symlinkSync(real, link);
    expect(() => readRegularFileNoFollowOrThrow(link, "source")).toThrow(/is a symlink/);
    // And the refusal must not leak the target's bytes in the message.
    try {
      readRegularFileNoFollowOrThrow(link, "source");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-payload");
    }
  });

  test("refuses a FIFO instead of hanging in open()", () => {
    const d = scratch();
    const fifo = join(d, "pipe");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // mkfifo unavailable on this platform; the other kinds still cover TYPE
    }
    // THE regression this pins: without O_NONBLOCK, open() on a writer-less
    // FIFO blocks before fstat can report the kind, so the process hangs rather
    // than refusing. A hang is not catchable -- if this test times out instead
    // of throwing, O_NONBLOCK was dropped.
    expect(() => readRegularFileNoFollowOrThrow(fifo, "source")).toThrow(
      /not a regular file \(a FIFO \/ named pipe\)/,
    );
  }, 5000);

  test("refuses a directory", () => {
    const d = scratch();
    const sub = join(d, "adir");
    mkdirSync(sub);
    expect(() => readRegularFileNoFollowOrThrow(sub, "source")).toThrow(
      /not a regular file \(a directory\)/,
    );
  });

  test("refuses a character device rather than reading to a never-arriving EOF", () => {
    if (!existsSync("/dev/zero")) return; // platform without it
    // /dev/zero never reaches EOF: a readFileSync grows a buffer until ENOMEM.
    expect(() => readRegularFileNoFollowOrThrow("/dev/zero", "source")).toThrow(
      /not a regular file \(a character device\)/,
    );
  });

  test("a missing file throws a clean message, not an ELOOP trace", () => {
    const d = scratch();
    const err = (() => {
      try {
        readRegularFileNoFollowOrThrow(join(d, "nope.txt"), "--text-file");
        return null;
      } catch (e) { return e as Error; }
    })();
    expect(err).not.toBeNull();
    // The `what` label must reach the user, and the raw errno must not be the
    // whole message -- callers attach their own exit code to this text.
    expect(err?.message).toContain("--text-file");
    expect(err?.message).toContain("could not be opened");
    expect(err?.message).not.toMatch(/ELOOP/);
  });

  test("a broken symlink is refused as a symlink, with no ELOOP trace", () => {
    const d = scratch();
    const link = join(d, "dangling");
    symlinkSync(join(d, "does-not-exist"), link);
    const err = (() => {
      try { readRegularFileNoFollowOrThrow(link, "source"); return null; }
      catch (e) { return e as Error; }
    })();
    expect(err?.message).toContain("source");
    expect(err?.message).not.toMatch(/ELOOP/);
  });

  test("a symlink LOOP is refused cleanly, with no ELOOP trace", () => {
    const d = scratch();
    const a = join(d, "a");
    const b = join(d, "b");
    symlinkSync(b, a);
    symlinkSync(a, b);
    const err = (() => {
      try { readRegularFileNoFollowOrThrow(a, "source"); return null; }
      catch (e) { return e as Error; }
    })();
    expect(err).not.toBeNull();
    // O_NOFOLLOW makes this an ELOOP from open(), which the primitive maps to
    // the plain "is a symlink" refusal -- the user gets a boundary message, not
    // a kernel errno.
    expect(err?.message).toMatch(/is a symlink/);
    expect(err?.message).not.toMatch(/ELOOP/);
  });
});

describe("t286 writeBufferAtomic", () => {
  test("round-trips arbitrary bytes sha256-identically", () => {
    const d = scratch();
    const p = join(d, "content.bin");
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x0a, 0x25, 0x50, 0x44, 0x46]);
    writeBufferAtomic(p, bytes);
    const back = readFileSync(p);
    expect(createHash("sha256").update(back).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });

  test("leaves no temp file behind on success", () => {
    const d = scratch();
    writeBufferAtomic(join(d, "a.bin"), Buffer.from("x"));
    expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("overwrites an existing file without a half-written window", () => {
    const d = scratch();
    const p = join(d, "a.bin");
    writeBufferAtomic(p, Buffer.from("first-version"));
    writeBufferAtomic(p, Buffer.from("second"));
    expect(readFileSync(p).toString()).toBe("second");
    expect(readdirSync(d)).toEqual(["a.bin"]);
  });

  test("throws and cleans up its own temp when the destination dir is unwritable", () => {
    const d = scratch();
    const sub = join(d, "ro");
    mkdirSync(sub);
    chmodSync(sub, 0o500); // r-x: cannot create the sibling temp
    expect(() => writeBufferAtomic(join(sub, "a.bin"), Buffer.from("x"))).toThrow();
    chmodSync(sub, 0o700);
    expect(readdirSync(sub)).toEqual([]);
  });
});

describe("t286 validSpaceFlag - a --space value is a path SEGMENT", () => {
  test("accepts the shapes `space create` can produce", () => {
    for (const ok of ["default", "a", "my-space", "team-b2", "x9-y8-z7"]) {
      expect(validSpaceFlag(ok), ok).toBe(ok);
    }
  });

  test("refuses traversal, absolutes, and separators", () => {
    // Each of these would escape the workspace if it reached a join() raw.
    for (const bad of [
      "..",
      "../..",
      "../../../etc",
      "/etc/passwd",
      "a/b",
      "a\\b",
      ".hidden",
      "-leading",
      "9leading",
      "Upper",
      "has space",
      "trailing/",
      "",
      "a$(whoami)",
      "a;rm -rf /",
      "a b",
    ]) {
      expect(validSpaceFlag(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("the regex is anchored at BOTH ends", () => {
    // An unanchored pattern would accept "ok/../../etc" because a valid prefix
    // matches somewhere. Assert the property, not the literal source.
    expect(SPACE_NAME_REGEX.source.startsWith("^")).toBe(true);
    expect(SPACE_NAME_REGEX.source.endsWith("$")).toBe(true);
    expect(validSpaceFlag("ok/../../etc")).toBeNull();
    expect(validSpaceFlag("ok\nevil")).toBeNull();
  });
});

describe("t286 assertNoSymlinkInChainOrThrow - EVERY component, not just the leaf", () => {
  test("returns the joined path when the whole chain is clean", () => {
    const d = scratch();
    mkdirSync(join(d, "a", "b"), { recursive: true });
    writeFileSync(join(d, "a", "b", "c.txt"), "ok");
    expect(assertNoSymlinkInChainOrThrow(d, join("a", "b", "c.txt")))
      .toBe(join(d, "a", "b", "c.txt"));
  });

  test("an empty relative path is the anchor itself", () => {
    const d = scratch();
    expect(assertNoSymlinkInChainOrThrow(d, "")).toBe(d);
  });

  test("refuses a symlinked INTERMEDIATE directory, not only a symlinked leaf", () => {
    // This is #660's actual regression: the container was validated and its
    // contents then trusted, so a redirected middle component was followed.
    const d = scratch();
    const outside = join(d, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "c.txt"), "foreign");
    mkdirSync(join(d, "root"), { recursive: true });
    symlinkSync(outside, join(d, "root", "b"));
    expect(() => assertNoSymlinkInChainOrThrow(join(d, "root"), join("b", "c.txt")))
      .toThrow(/is a symlink/);
  });

  test("refuses a symlinked leaf", () => {
    const d = scratch();
    mkdirSync(join(d, "root"), { recursive: true });
    writeFileSync(join(d, "target.txt"), "foreign");
    symlinkSync(join(d, "target.txt"), join(d, "root", "leaf.txt"));
    expect(() => assertNoSymlinkInChainOrThrow(join(d, "root"), "leaf.txt"))
      .toThrow(/is a symlink/);
  });

  test("a component that does not exist yet cannot redirect, so it is allowed", () => {
    // Write paths are resolved before their parents exist; a missing component
    // is not a redirect risk, and failing it would break first-write.
    const d = scratch();
    expect(assertNoSymlinkInChainOrThrow(d, join("not", "yet", "there.txt")))
      .toBe(join(d, "not", "yet", "there.txt"));
  });

  test("refuses lexical escape and absolute rel before touching the disk", () => {
    const d = scratch();
    expect(() => assertNoSymlinkInChainOrThrow(d, "../escape")).toThrow(/escapes its anchor/);
    expect(() => assertNoSymlinkInChainOrThrow(d, "/etc/passwd")).toThrow(/escapes its anchor/);
  });

  test("one poisoned sibling does not strand its healthy siblings", () => {
    // The check is per-path, so a caller walking many leaves can refuse the bad
    // one and still index the rest -- #660 stranded healthy rows in the same walk.
    const d = scratch();
    const root = join(d, "root");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "good1.txt"), "a");
    writeFileSync(join(root, "good2.txt"), "b");
    writeFileSync(join(d, "target.txt"), "foreign");
    symlinkSync(join(d, "target.txt"), join(root, "bad.txt"));
    const results = ["good1.txt", "bad.txt", "good2.txt"].map((leaf) => {
      try { assertNoSymlinkInChainOrThrow(root, leaf); return "ok"; }
      catch { return "refused"; }
    });
    expect(results).toEqual(["ok", "refused", "ok"]);
  });
});
