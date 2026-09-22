import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSessionPaths } from "../harness/tui-bun-backend.ts";
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
    `], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 15_000 });
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
  }, 20_000);

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
      env, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code === 0) {
      const cleanup = Bun.spawn([process.execPath, driver, "kill", "--session", session], {
        env, stdout: "ignore", stderr: "ignore", timeout: 15_000,
      });
      await cleanup.exited;
    }
    expect(stderr).toContain("unsafe native terminal private path");
    expect(stderr).toContain("ancestor");
    expect(code).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(bunSessionPaths(session, env).record)).toBe(false);
  }, 30_000);

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
