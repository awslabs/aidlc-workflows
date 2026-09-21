import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePrivateRoot, privateDirectoryIdentity, publishTuiRecord, readPrivateRecord,
} from "../harness/tui-record-file.ts";

const scratch: string[] = [];
function fixture() {
  const outer = fs.mkdtempSync(join(tmpdir(), "aidlc-native-private-posix-"));
  scratch.push(outer);
  const root = join(outer, "root");
  ensurePrivateRoot(root);
  const directory = join(root, "session");
  ensurePrivateRoot(directory);
  const identity = privateDirectoryIdentity(directory);
  const file = join(directory, "session.json");
  const record = { directoryIdentity: identity, command: ["must-not-execute"], token: "private-token" };
  publishTuiRecord(file, record, identity);
  return { root, directory, identity, file, record };
}

afterEach(() => {
  for (const path of scratch.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("native private namespace", () => {
  test("publication refuses a directory replaced after opening its temporary record", () => {
    const f = fixture();
    const open = fs.openSync;
    let swapped = false;
    const hook = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (String(args[0]).endsWith(".tmp") && !swapped) {
        swapped = true;
        fs.renameSync(f.directory, `${f.directory}-old`);
        ensurePrivateRoot(f.directory);
      }
      return fd;
    }) as typeof fs.openSync);
    try {
      expect(() => publishTuiRecord(f.file, { ...f.record, token: "new" }, f.identity)).toThrow("directory identity mismatch");
      expect(fs.existsSync(f.file)).toBe(false);
      expect(JSON.parse(fs.readFileSync(join(`${f.directory}-old`, "session.json"), "utf8"))).toEqual(f.record);
    } finally { hook.mockRestore(); }
  });

  test("unsafe roots and records are rejected, never chmod-repaired", () => {
    const f = fixture();
    fs.chmodSync(f.root, 0o777);
    expect(() => ensurePrivateRoot(f.root)).toThrow("group/other permission bits");
    expect(fs.statSync(f.root).mode & 0o777).toBe(0o777);
    fs.chmodSync(f.root, 0o700);
    fs.chmodSync(f.file, 0o644);
    expect(() => readPrivateRecord(f.directory, f.file)).toThrow("group/other permission bits");
    fs.chmodSync(f.file, 0o600);
    fs.renameSync(f.file, `${f.file}-original`);
    fs.symlinkSync(`${f.file}-original`, f.file);
    expect(() => readPrivateRecord(f.directory, f.file)).toThrow("symlink/reparse");
  });

});
