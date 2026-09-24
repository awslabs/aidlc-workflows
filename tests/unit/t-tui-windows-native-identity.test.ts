// Native API contracts run everywhere through injected APIs. The final Windows
// case proves the real DLL calls and Node -> Bun bridge without a live model.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getNativeProcessIdentity,
  getWindowsProcessChildren,
  getWindowsProcessDetailsWithBun,
  parseWindowsProcessDetailsReply,
  readWindowsProcessDetails,
  windowsFileTimeToISOString,
  type WindowsProcessDetailsApi,
} from "../harness/tui-process-identity.ts";

const CREATION = 134029728000000123n;
const COMMAND = '"C:\\Program Files\\node.exe" --session native-proof --owner-token fixture-only "☃ 日本語 & %LITERAL%"';

function fakeApi(options: {
  openError?: number; ntError?: number; badPid?: boolean; badPointer?: boolean;
  badLength?: boolean; exitAfterRead?: boolean; closeError?: boolean; creation?: bigint;
} = {}) {
  const handle = {};
  const calls: string[] = [];
  let waits = 0;
  const address = 0x100000n;
  const api: WindowsProcessDetailsApi<object> = {
    OpenProcess(access, inherit, pid) {
      expect(access).toBe(0x100400); // QUERY_INFORMATION | SYNCHRONIZE only.
      expect(access & (0x1 | 0x10 | 0x20 | 0x8 | 0x40)).toBe(0);
      expect(inherit).toBe(0);
      expect(pid).toBe(42);
      calls.push("open");
      return options.openError ? null : handle;
    },
    WaitForSingleObject(actual, timeout) {
      expect(actual).toBe(handle);
      expect(timeout).toBe(0);
      calls.push("wait");
      return options.exitAfterRead && waits++ > 0 ? 0 : 258;
    },
    GetProcessTimes(actual, creation) {
      expect(actual).toBe(handle);
      calls.push("times");
      const ticks = options.creation ?? CREATION;
      creation[0] = Number(ticks & 0xffffffffn);
      creation[1] = Number(ticks >> 32n);
      return 1;
    },
    NtQueryInformationProcess(actual, informationClass, buffer, bytes, returned) {
      expect(actual).toBe(handle);
      expect(bytes).toBe(buffer.byteLength);
      calls.push(`nt:${informationClass}`);
      if (options.ntError) return options.ntError;
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      if (informationClass === 0) {
        expect(bytes).toBe(48);
        view.setBigUint64(32, options.badPid ? 43n : 42n, true);
        view.setBigUint64(40, 10n, true);
        returned[0] = 48;
      } else {
        expect(informationClass).toBe(60);
        const command = Buffer.from(COMMAND, "utf16le");
        view.setUint16(0, command.length + (options.badLength ? 1 : 0), true);
        view.setUint16(2, command.length + 2, true);
        view.setBigUint64(8, options.badPointer ? address - 8n : address + 16n, true);
        buffer.set(command, 16);
        returned[0] = 16 + command.length + 2;
      }
      return 0;
    },
    bufferAddress() { return address; },
    CloseHandle(actual) {
      expect(actual).toBe(handle);
      calls.push("close");
      return options.closeError ? 0 : 1;
    },
    GetLastError() { return options.openError ?? 6; },
  };
  return { api, calls };
}

describe("native Windows process details", () => {
  test("parent, exact Unicode command line and full creation time come from one read-only handle", () => {
    const { api, calls } = fakeApi();
    expect(readWindowsProcessDetails(42, api)).toEqual({
      pid: 42, parentPid: 10, commandLine: COMMAND,
      creationDate: windowsFileTimeToISOString(CREATION), nativeIdentity: `win32:42:${CREATION}`,
    });
    expect(calls).toEqual(["open", "wait", "times", "nt:0", "nt:60", "wait", "close"]);
    const next = readWindowsProcessDetails(42, fakeApi({ creation: CREATION + 1n }).api)!;
    expect(next.nativeIdentity).not.toBe(`win32:42:${CREATION}`);
    expect(Date.parse(next.creationDate)).toBe(Date.parse(windowsFileTimeToISOString(CREATION)));
  });

  test("only observed exit or a nonexistent PID establishes absence", () => {
    expect(readWindowsProcessDetails(42, fakeApi({ openError: 87 }).api)).toBeNull();
    expect(() => readWindowsProcessDetails(42, fakeApi({ openError: 5 }).api)).toThrow("Windows error 5");
    const exiting = fakeApi({ exitAfterRead: true });
    expect(readWindowsProcessDetails(42, exiting.api)).toBeNull();
    expect(exiting.calls.at(-1)).toBe("close");
    expect(() => readWindowsProcessDetails(42, fakeApi({ exitAfterRead: true, closeError: true }).api))
      .toThrow("CloseHandle");
  });

  test("NT failures and malformed local buffers fail closed and close the handle", () => {
    for (const options of [
      { ntError: -1073741790 }, // STATUS_ACCESS_DENIED.
      { badPid: true }, { badPointer: true }, { badLength: true }, { creation: 0n },
    ]) {
      const { api, calls } = fakeApi(options);
      expect(() => readWindowsProcessDetails(42, api)).toThrow();
      expect(calls.filter(value => value === "close")).toHaveLength(1);
    }
  });

  test("transport requires an explicit, valid result for every requested PID", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
    const details = readWindowsProcessDetails(42, fakeApi().api)!;
    expect(parseWindowsProcessDetailsReply(encode([{ pid: 42, identity: details }, { pid: 43, identity: null }]), [42, 43]))
      .toEqual([details]);
    for (const rows of [
      [], [{ pid: 42 }], [{ pid: 43, identity: null }],
      [{ pid: 42, identity: null }, { pid: 42, identity: null }],
      [{ pid: 42, identity: { ...details, nativeIdentity: "win32:43:123" } }],
    ]) expect(() => parseWindowsProcessDetailsReply(encode(rows), [42])).toThrow();
  });

  test.skipIf(process.platform !== "win32")("real Windows native handles and Node-to-Bun bridge preserve parent, generation and actual argv", async () => {
    const root = mkdtempSync(join(tmpdir(), "native-identity-proof-"));
    const script = join(root, "child with spaces.js");
    writeFileSync(script, 'process.stdout.write("ready\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); setTimeout(() => process.exit(91), 10000);\n');
    const child = spawn(process.execPath, [script, "--session", "native-proof", "--owner-token", "fixture-only", "☃ 日本語 & %LITERAL%"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    try {
      await once(child.stdout!, "data");
      const started = performance.now();
      const rows = getWindowsProcessDetailsWithBun([child.pid!], 2_000);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(rows).toHaveLength(1);
      const details = rows[0];
      expect(details.pid).toBe(child.pid!);
      expect(details.parentPid).toBe(process.pid);
      const nativeIdentity = await getNativeProcessIdentity(child.pid!);
      expect(nativeIdentity).not.toBeNull();
      expect(details.nativeIdentity).toBe(nativeIdentity!);
      expect(details.commandLine).toContain(script);
      expect(details.commandLine).toContain("--session native-proof");
      expect(details.commandLine).toContain("--owner-token fixture-only");
      expect(details.commandLine).toContain("☃ 日本語 & %LITERAL%");
      const family = await getWindowsProcessChildren(process.pid);
      const selfIdentity = await getNativeProcessIdentity(process.pid);
      expect(selfIdentity).not.toBeNull();
      expect(family.currentRoot?.nativeIdentity).toBe(selfIdentity!);
      expect(family.children.find(row => row.pid === child.pid)).toEqual(details);
      const node = Bun.which("node");
      expect(node, "Node is required for the legacy driver bridge proof").not.toBeNull();
      const helper = pathToFileURL(join(import.meta.dir, "../harness/tui-process-identity.ts")).href;
      const reply = execFileSync(node!, ["--experimental-strip-types", "--input-type=module", "-e",
        `import { getWindowsProcessDetailsWithBun } from ${JSON.stringify(helper)}; console.log(JSON.stringify(getWindowsProcessDetailsWithBun([${child.pid}], 2000)));`,
      ], { env: { ...process.env, AIDLC_BUN_BIN: process.execPath }, encoding: "utf8", timeout: 3_000 });
      expect(JSON.parse(reply)).toEqual(rows);
      console.log(`native identity proof: direct bridge ${Math.round(performance.now() - started)}ms including Node bridge; parent/generation/Unicode argv verified`);
    } finally {
      child.stdin!.end();
      if (child.exitCode === null) child.kill();
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
    expect(getWindowsProcessDetailsWithBun([child.pid!], 2_000)).toEqual([]);
  });
});
