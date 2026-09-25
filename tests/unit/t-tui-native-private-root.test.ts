import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertDirectoryIdentity, ensurePrivateRoot, privateDirectoryIdentity, publishTuiRecord,
  readPrivateRecord, validatePrivateStat,
} from "../harness/tui-record-file.ts";

const scratch: string[] = [];
function fixture() {
  const outer = fs.mkdtempSync(join(tmpdir(), "aidlc-native-private-"));
  scratch.push(outer);
  const root = join(outer, "root");
  ensurePrivateRoot(root);
  const directory = join(root, "session");
  ensurePrivateRoot(directory);
  const identity = privateDirectoryIdentity(directory);
  const file = join(directory, "session.json");
  const record = { directoryIdentity: identity, command: ["must-not-execute"], token: "private-token" };
  publishTuiRecord(file, record, identity);
  return { outer, root, directory, identity, file, record };
}

afterEach(() => {
  for (const path of scratch.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

describe("native private namespace", () => {
  test("POSIX validator rejects foreign owners, public modes and links", () => {
    const stat = {
      uid: 501n, mode: 0o40700n,
      isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false,
    };
    expect(() => validatePrivateStat("/private", stat, "directory", 501)).not.toThrow();
    expect(() => validatePrivateStat("/private", { ...stat, uid: 502n }, "directory", 501)).toThrow("owner uid");
    expect(() => validatePrivateStat("/private", { ...stat, mode: 0o40750n }, "directory", 501)).toThrow("group/other");
    expect(() => validatePrivateStat("/private", { ...stat, mode: 0o40702n }, "directory", 501)).toThrow("group/other");
    expect(() => validatePrivateStat("/private", { ...stat, isSymbolicLink: () => true }, "directory", 501)).toThrow("symlink/reparse");
    expect(() => validatePrivateStat("/private", { ...stat, isDirectory: () => false }, "directory", 501)).toThrow("not a directory");
  });

  test("identity checks preserve 64-bit values and refuse unpinned records", () => {
    const identity = { dev: "7", ino: "9007199254740993" };
    expect(() => assertDirectoryIdentity("/private", identity, { ...identity })).not.toThrow();
    expect(() => assertDirectoryIdentity("/private", identity, { ...identity, ino: "9007199254740992" })).toThrow("identity mismatch");
    expect(() => assertDirectoryIdentity("/private", identity, undefined)).toThrow("identity mismatch");
  });

  test("private roots with missing parents work and private records round-trip", () => {
    const f = fixture();
    expect(readPrivateRecord(f.directory, f.file)).toEqual(f.record);
    const nested = join(f.outer, "missing", "parents", "private");
    ensurePrivateRoot(nested);
    if (process.platform !== "win32") expect(fs.statSync(nested).mode & 0o077).toBe(0);
    ensurePrivateRoot(nested); // Reusing our private directory must also work.
  });

  test("a junction/symlink root is rejected without modifying its target", () => {
    const f = fixture();
    const alias = join(f.outer, "alias");
    fs.symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => ensurePrivateRoot(alias)).toThrow("symlink/reparse");
    expect(readPrivateRecord(f.directory, f.file)).toEqual(f.record);
  });

  test("a copied record cannot authorize a replaced session or parent directory", () => {
    const f = fixture();
    fs.renameSync(f.root, `${f.root}-old`);
    ensurePrivateRoot(f.root);
    ensurePrivateRoot(f.directory);
    publishTuiRecord(f.file, f.record, privateDirectoryIdentity(f.directory));
    expect(() => readPrivateRecord(f.directory, f.file)).toThrow("directory identity mismatch");
    expect(() => publishTuiRecord(f.file, f.record, f.identity)).toThrow("directory identity mismatch");
  });

  test("publication refuses a directory replaced before opening its temporary record", () => {
    const f = fixture();
    const open = fs.openSync;
    let swapped = false;
    const hook = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      // No file handle pins the directory yet, so Windows also permits this race.
      if (String(args[0]).endsWith(".tmp") && !swapped) {
        swapped = true;
        fs.renameSync(f.directory, `${f.directory}-old`);
        ensurePrivateRoot(f.directory);
      }
      return open(...args);
    }) as typeof fs.openSync);
    try {
      expect(() => publishTuiRecord(f.file, { ...f.record, token: "new" }, f.identity)).toThrow("directory identity mismatch");
      expect(fs.existsSync(f.file)).toBe(false);
      expect(JSON.parse(fs.readFileSync(join(`${f.directory}-old`, "session.json"), "utf8"))).toEqual(f.record);
    } finally { hook.mockRestore(); }
  });

  test("Node can load the record helper and validate its private root without bun:ffi", () => {
    const f = fixture();
    const result = spawnSync(process.env.AIDLC_NODE_BIN || "node", [
      "--experimental-strip-types", "--input-type=module", "-e",
      `const {ensurePrivateRoot}=await import(${JSON.stringify(new URL("../harness/tui-record-file.ts", import.meta.url).href)}); ensurePrivateRoot(process.argv[1]);`,
      resolve(f.root),
    ], { encoding: "utf8", timeout: process.platform === "win32" ? 75_000 : 15_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, process.platform === "win32" ? 80_000 : 20_000);
});
