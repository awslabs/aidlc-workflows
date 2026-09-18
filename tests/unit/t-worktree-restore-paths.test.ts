// Pure filesystem guards for raw restore: no CLI subprocesses or Git fixtures.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { assertNoSymlinkedAncestor, assertParentInsideCheckout, restoreDestination } from "../../core/tools/aidlc-worktree.ts";

let fixture: string;
let root: Buffer;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "aidlc-restore-paths-"));
  mkdirSync(join(fixture, "root"));
  root = realpathSync(join(fixture, "root"), { encoding: "buffer" });
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe("restore destination containment", () => {
  test("refuses traversal components even when normalization would stay inside", () => {
    expect(() => restoreDestination(root, Buffer.from("../outside/file"))).toThrow();
    expect(() => restoreDestination(root, Buffer.from("nested/../file"))).toThrow();
  });

  test("refuses absolute paths even when they name a child of the checkout", () => {
    expect(() => restoreDestination(root, Buffer.from(join(fixture, "outside")))).toThrow();
    expect(() => restoreDestination(root, Buffer.concat([root, Buffer.from(`${sep}file`)]))).toThrow();
  });

  test("preserves non-UTF-8 bytes in a nested destination and its parent", () => {
    const name = Buffer.concat([Buffer.from("nested-"), Buffer.from([0xff])]);
    const path = Buffer.concat([name, Buffer.from("/notes-"), Buffer.from([0xfe])]);
    const { destination, parent } = restoreDestination(root, path);
    expect(destination).toEqual(Buffer.concat([root, Buffer.from(sep), path]));
    expect(parent).toEqual(Buffer.concat([root, Buffer.from(sep), name]));
    assertNoSymlinkedAncestor(root, parent);
    mkdirSync(parent);
    assertParentInsideCheckout(root, parent);
    writeFileSync(destination, "recovered", { flag: "wx" });
    expect(readFileSync(destination, "utf-8")).toBe("recovered");
  });

  test.skipIf(process.platform === "win32")("refuses a parent resolving outside the checkout", () => {
    mkdirSync(join(fixture, "outside"));
    symlinkSync("../outside", join(fixture, "root", "link"));
    const { parent } = restoreDestination(root, Buffer.from("link/file"));
    expect(() => assertParentInsideCheckout(root, parent)).toThrow();
  });

  test.skipIf(process.platform === "win32")("refuses a symlinked ancestor before creating missing directories outside the checkout", () => {
    mkdirSync(join(fixture, "outside"));
    symlinkSync("../outside", join(fixture, "root", "link"));
    const { parent } = restoreDestination(root, Buffer.from("link/sub/file"));
    expect(() => {
      assertNoSymlinkedAncestor(root, parent);
      mkdirSync(parent, { recursive: true });
      assertParentInsideCheckout(root, parent);
    }).toThrow();
    expect(existsSync(join(fixture, "outside", "sub"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")("refuses an ancestor symlink even when its target stays inside the checkout", () => {
    mkdirSync(join(fixture, "root", "actual", "nested"), { recursive: true });
    symlinkSync("actual", join(fixture, "root", "link"));
    const { parent } = restoreDestination(root, Buffer.from("link/nested/file"));
    expect(() => assertParentInsideCheckout(root, parent)).toThrow();
  });

  test("allows root-level files and ordinary nested directories", () => {
    for (const path of ["top.txt", "nested/deep/file.txt"]) {
      const { destination, parent } = restoreDestination(root, Buffer.from(path));
      assertNoSymlinkedAncestor(root, parent);
      mkdirSync(parent, { recursive: true });
      assertParentInsideCheckout(root, parent);
      writeFileSync(destination, "recovered", { flag: "wx" });
      expect(readFileSync(destination, "utf-8")).toBe("recovered");
    }
  });
});
