import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { setDefaultTimeout, afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSessionPaths } from "../harness/tui-bun-backend.ts";
import { ensurePrivateRoot, privateDirectoryIdentity, publishTuiRecord } from "../harness/tui-record-file.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const root = mkdtempSync(join(tmpdir(), "aidlc-native-namespace-posix-"));
const driver = join(import.meta.dir, "../harness/tui-drive.ts");
const env = { ...process.env, AIDLC_TUI_BACKEND: "bun", AIDLC_TUI_BUN_ROOT: root };

async function drive(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, driver, ...args], {
    env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("native launch namespace security", () => {
  test.each(["default", "explicit"])(
    "%s world-writable root is refused before any lock/session publication", async (selection) => {
      const temp = mkdtempSync(join(root, "unsafe-root-"));
      const unsafeRoot = join(temp, "aidlc-bun-tui");
      mkdirSync(unsafeRoot, { mode: 0o777 });
      chmodSync(unsafeRoot, 0o777);
      const result = await drive(["start", "--session", "refuse-public-root", "--cwd", root,
        "--", process.execPath, "-e", "process.exit(0)"], {
        TMPDIR: temp, TMP: temp, TEMP: temp,
        AIDLC_TUI_BUN_ROOT: selection === "default" ? "" : unsafeRoot,
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("group/other permission bits");
      expect(result.stderr).toContain(unsafeRoot);
      expect(readdirSync(unsafeRoot)).toEqual([]);
    },
  );

  test("untrusted daemon directories receive no error record or supervisor", async () => {
    const privateRoot = join(root, `untrusted-${randomUUID()}`);
    ensurePrivateRoot(privateRoot);
    const childEnv = { ...env, AIDLC_TUI_BUN_ROOT: privateRoot };
    const paths = bunSessionPaths("untrusted-directory", childEnv);
    mkdirSync(paths.directory, { mode: 0o700 });
    writeFileSync(paths.record, "untrusted bytes", { mode: 0o600 });
    chmodSync(paths.directory, 0o777);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../harness/tui-bun-backend.ts"), "--daemon", paths.directory, randomUUID()], {
      env: childEnv, stdout: "pipe", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("group/other permission bits");
    expect(readFileSync(paths.record, "utf8")).toBe("untrusted bytes");
    expect(readdirSync(paths.directory)).toEqual(["session.json"]);
  });

  test("client commands refuse unsafe records instead of using their RPC credentials", async () => {
    const privateRoot = join(root, `unsafe-record-${randomUUID()}`);
    ensurePrivateRoot(privateRoot);
    const childEnv = { AIDLC_TUI_BUN_ROOT: privateRoot };
    const session = "unsafe-record";
    const paths = bunSessionPaths(session, { ...env, ...childEnv });
    mkdirSync(paths.directory, { mode: 0o700 });
    publishTuiRecord(paths.record, {
      schema: 1, backend: "bun", session, token: randomUUID(), generation: randomUUID(), endpoint: paths.endpoint,
      rootIdentity: privateDirectoryIdentity(privateRoot), directoryIdentity: privateDirectoryIdentity(paths.directory), phase: "running",
    });
    chmodSync(paths.record, 0o666);
    for (const args of [
      ["kill"], ["capture"], ["send", "--keys", "hello"], ["paste", "--text", "hello"],
      ["wait", "--pattern", "hello"], ["wait-dead", "--timeout-ms", "100"],
    ]) {
      const result = await drive([...args, "--session", session], childEnv);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("group/other permission bits");
    }
  });
});
