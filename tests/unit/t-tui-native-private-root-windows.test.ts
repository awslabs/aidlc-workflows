import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePrivateRoot, privateDirectoryIdentity, publishTuiRecord, readPrivateRecord,
} from "../harness/tui-record-file.ts";

const scratch: string[] = [];
function fixture() {
  const outer = fs.mkdtempSync(join(tmpdir(), "aidlc-native-private-windows-"));
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

describe.skipIf(process.platform !== "win32")("native private namespace", () => {
  test("Windows blocks directory replacement while the publication handle is open", () => {
    const f = fixture();
    const open = fs.openSync;
    let attempted = false;
    let replacementError: unknown;
    const hook = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (String(args[0]).endsWith(".tmp") && !attempted) {
        attempted = true;
        try { fs.renameSync(f.directory, `${f.directory}-old`); }
        catch (error) { replacementError = error; }
      }
      return fd;
    }) as typeof fs.openSync);
    try {
      const next = { ...f.record, token: "new" };
      publishTuiRecord(f.file, next, f.identity);
      expect(replacementError).toMatchObject({ code: "EPERM" });
      expect(fs.existsSync(`${f.directory}-old`)).toBe(false);
      expect(readPrivateRecord(f.directory, f.file)).toEqual(next);
    } finally { hook.mockRestore(); }
  });

  test("Windows refuses public allow ACEs on an otherwise owned root", () => {
    const f = fixture();
    const result = spawnSync("icacls.exe", [f.root, "/grant", "*S-1-1-0:(R)"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(() => ensurePrivateRoot(f.root)).toThrow("public allow ACE");
  });

});
