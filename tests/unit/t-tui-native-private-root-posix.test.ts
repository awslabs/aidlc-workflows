import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_PROCESS_CLEANUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingCleanupTimeoutMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bunSessionPaths } from "../harness/tui-bun-backend.ts";
import {
  ensurePrivateRoot, privateDirectoryIdentity, publishTuiRecord, readPrivateRecord, validateAncestorStat,
} from "../harness/tui-record-file.ts";
import { createE2eNativeRoot } from "../lib/e2e-workers.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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

  test.each(["exited", "starting"] as const)("a private root replay in phase %s cannot execute the prior command", async (phase) => {
    const outer = fs.mkdtempSync(join(tmpdir(), "aidlc-native-replay-"));
    scratch.push(outer);
    const root = join(outer, "root");
    const env = { ...process.env, AIDLC_TUI_BUN_ROOT: root };
    const session = `replay-${randomUUID()}`;
    const paths = bunSessionPaths(session, env);
    const marker = join(outer, "executed-prior-command");
    const prepare = (phase: "starting" | "exited") => {
      ensurePrivateRoot(paths.directory);
      const record = {
        schema: 1, backend: "bun", session, token: randomUUID(), generation: randomUUID(),
        endpoint: paths.endpoint, rootIdentity: privateDirectoryIdentity(root),
        directoryIdentity: privateDirectoryIdentity(paths.directory), phase,
        cleanupComplete: phase === "exited", cwd: outer, fixtureCwd: null, width: 80, height: 16,
        command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
      };
      publishTuiRecord(paths.record, record, record.directoryIdentity);
      return record;
    };
    prepare(phase);
    fs.renameSync(root, `${root}-prior`);
    const fresh = prepare("starting");
    // Gate the real daemon over pipes: the root is swapped after process spawn
    // but before record loading, without a production filesystem/test hook.
    const child = Bun.spawn([process.execPath, "-e", `
      import { runBunDaemon } from ${JSON.stringify(new URL("../harness/tui-bun-backend.ts", import.meta.url).href)};
      process.stdout.write("before-record-load\\n");
      const gate = Promise.withResolvers();
      process.stdin.once("data", gate.resolve);
      await gate.promise;
      process.stdin.pause();
      await runBunDaemon(${JSON.stringify(paths.directory)}, ${JSON.stringify(fresh.generation)});
    `], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    const ready = child.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await ready.read()).value)).toBe("before-record-load\n");
      fs.renameSync(root, `${root}-fresh`);
      fs.renameSync(`${root}-prior`, root);
      child.stdin.write("load\n");
      child.stdin.end();
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code, stderr).not.toBe(0);
      const rejected = JSON.parse(fs.readFileSync(paths.record, "utf8"));
      expect(rejected).toMatchObject({ phase: "error", cleanupComplete: true });
      expect(rejected.error).toContain(phase === "exited" ? "phase" : "generation");
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(join(paths.directory, "supervisor-config.json"))).toBe(false);
    } finally {
      ready.releaseLock();
      child.kill();
      await child.exited;
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("an explicit root below a group-writable non-sticky ancestor is rejected before spawn", async () => {
    const outer = fs.mkdtempSync(join(tmpdir(), "aidlc-native-ancestor-"));
    scratch.push(outer);
    fs.chmodSync(outer, 0o770);
    const root = join(outer, "private", "root");
    const marker = join(outer, "executed");
    const env = { ...process.env, AIDLC_TUI_BACKEND: "bun", AIDLC_TUI_BUN_ROOT: root };
    const session = `unsafe-ancestor-${randomUUID()}`;
    const driver = join(import.meta.dir, "../harness/tui-drive.ts");
    const child = Bun.spawn([process.execPath, driver, "start", "--session", session, "--cwd", outer,
      "--", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`], {
      env, stdout: "pipe", stderr: "pipe", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code === 0) {
      const cleanup = Bun.spawn([process.execPath, driver, "kill", "--session", session], {
        env, stdout: "ignore", stderr: "ignore", timeout: remainingCleanupTimeoutMs(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS),
      });
      await cleanup.exited;
    }
    expect(stderr).toContain("unsafe native terminal private path");
    expect(stderr).toContain("ancestor");
    expect(code).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(bunSessionPaths(session, env).record)).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the ancestor check relaxes only ownership, and only under the opt-in", () => {
    const stat = { uid: 0n, mode: 0o40755n, isDirectory: () => true };
    const sandbox = { ...stat, uid: 65534n };
    const optIn = { AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS: "1" };
    const refusal = (check: () => void) => {
      try { check(); } catch (error) { return String(error); }
      return "";
    };
    expect(() => validateAncestorStat("/", stat, 501, {})).not.toThrow();
    expect(() => validateAncestorStat("/home", { ...stat, uid: 501n }, 501, {})).not.toThrow();
    // Off by default: a sandbox-owned ancestor is refused, and the refusal names the way out.
    const ownership = refusal(() => validateAncestorStat("/", sandbox, 501, {}));
    expect(ownership).toContain("ancestor is not owned by current uid or uid 0 (owner uid 65534");
    expect(ownership).toContain("AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS=1");
    expect(() => validateAncestorStat("/", sandbox, 501, optIn)).not.toThrow();
    // The opt-in never relaxes the write axis or the directory check.
    const writable = refusal(() => validateAncestorStat("/", { ...sandbox, mode: 0o40777n }, 501, optIn));
    expect(writable).toContain("writable by other users without the sticky bit");
    expect(writable).not.toContain("AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS");
    expect(() => validateAncestorStat("/", { ...sandbox, mode: 0o40775n }, 501, optIn)).toThrow("writable by other users");
    expect(() => validateAncestorStat("/tmp", { ...sandbox, mode: 0o41777n }, 501, optIn)).not.toThrow();
    expect(() => validateAncestorStat("/", { ...sandbox, isDirectory: () => false }, 501, optIn)).toThrow("not a directory");
  });

  test("e2e setup names the ownership opt-in, which then admits a sandbox-owned /", () => {
    const outer = fs.mkdtempSync(join(tmpdir(), "aidlc-native-ancestors-"));
    scratch.push(outer);
    const realStat = fs.statSync;
    // Report / as owned by the overflow uid, as an overlay/sandbox filesystem does.
    const hook = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) => {
      const result = realStat(path, options as never);
      if (resolve(String(path)) !== "/" || !(options as { bigint?: boolean } | undefined)?.bigint || !result) return result;
      return new Proxy(result, {
        get: (target, key) => {
          if (key === "uid") return 65534n;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof fs.statSync);
    const previous = process.env.AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS;
    try {
      delete process.env.AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS;
      let message = "";
      try { createE2eNativeRoot(join(outer, "refused")); } catch (error) { message = (error as Error).message; }
      expect(message).toContain("e2e needs an OS temporary directory with trusted native root ancestors");
      expect(message).toContain("owner uid 65534");
      expect(message).toContain("AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS=1");
      process.env.AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS = "1";
      const root = createE2eNativeRoot(join(outer, "admitted"));
      scratch.push(dirname(root));
      expect(fs.statSync(root).isDirectory()).toBe(true);
    } finally {
      hook.mockRestore();
      if (previous === undefined) delete process.env.AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS;
      else process.env.AIDLC_TUI_ALLOW_UNTRUSTED_ANCESTORS = previous;
    }
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
