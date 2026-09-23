import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunSessionPaths, createBunBackend } from "../harness/tui-bun-backend.ts";
import * as identities from "../harness/tui-process-identity.ts";
import { ensurePrivateRoot, privateDirectoryIdentity, publishTuiRecord } from "../harness/tui-record-file.ts";
import { publishSupervisorStop } from "../harness/tui-bun-process.ts";
import {
  NATIVE_OUTPUT_DRAIN_TIMEOUT_MS, NATIVE_PROCESS_CLEANUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS,
  NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS, NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";

async function withRecord(run: (fixture: ReturnType<typeof makeRecord>) => Promise<void>) {
  const scratch = mkdtempSync(join(tmpdir(), "bun-cleanup-budget-"));
  const previous = process.env.AIDLC_TUI_BUN_ROOT;
  try {
    const fixture = makeRecord(scratch);
    process.env.AIDLC_TUI_BUN_ROOT = fixture.root;
    await run(fixture);
  }
  finally {
    if (previous === undefined) delete process.env.AIDLC_TUI_BUN_ROOT;
    else process.env.AIDLC_TUI_BUN_ROOT = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
}

function makeRecord(scratch: string) {
  const root = join(scratch, "private");
  ensurePrivateRoot(root);
  const session = randomUUID();
  const paths = bunSessionPaths(session, { AIDLC_TUI_BUN_ROOT: root });
  ensurePrivateRoot(paths.directory);
  const record = {
    schema: 1, backend: "bun", session, token: randomUUID(), generation: randomUUID(),
    endpoint: paths.endpoint, rootIdentity: privateDirectoryIdentity(root),
    directoryIdentity: privateDirectoryIdentity(paths.directory),
    phase: "running", daemonPid: 123, daemonIdentity: "modeled-owned-generation",
    cwd: root, command: [process.execPath], fixtureCwd: null, width: 80, height: 24,
    cleanupComplete: false,
  };
  publishTuiRecord(paths.record, record, record.directoryIdentity);
  return { root, session, paths, record };
}

test("kill RPC and daemon retirement share one absolute cleanup deadline", async () => {
  await withRecord(async ({ session, record }) => {
    let now = 1000;
    const deadline = now + NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    let probes = 0;
    const identity = spyOn(identities, "getNativeProcessIdentity").mockImplementation(async (pid) => {
      expect(pid).toBe(record.daemonPid);
      if (++probes > 1) throw new Error("retirement received a fresh budget");
      now = deadline;
      return record.daemonIdentity;
    });
    try {
      const backend = createBunBackend({ fixtureCwd: () => null }, async (_record, method, _args, until) => {
        expect(method).toBe("kill");
        expect(until).toBe(deadline);
        now += NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS;
      });
      await expect(backend.kill(session)).rejects.toThrow("daemon did not retire");
      expect(probes).toBe(1);
    } finally { identity.mockRestore(); clock.mockRestore(); }
  });
});

test("quick kill completes without spending the unused cleanup allowance", async () => {
  await withRecord(async ({ session }) => {
    let now = 1000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const identity = spyOn(identities, "getNativeProcessIdentity").mockResolvedValue(null);
    try {
      const backend = createBunBackend({ fixtureCwd: () => null }, async (_record, method, _args, deadline) => {
        expect(method).toBe("kill");
        expect(deadline).toBe(1000 + NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS);
        now += 25;
      });
      await backend.kill(session);
      expect(now).toBe(1025);
      expect(identity).toHaveBeenCalledTimes(1);
    } finally { identity.mockRestore(); clock.mockRestore(); }
  });
});

test("kill rejects absence observed after RPC and identity discovery exhaust the shared deadline", async () => {
  await withRecord(async ({ session }) => {
    let now = 1000;
    let deadline = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const identity = spyOn(identities, "getNativeProcessIdentity").mockImplementation(async () => {
      now += 2000; // Identity finishes after the last second left by the RPC.
      return null;
    });
    try {
      const backend = createBunBackend({ fixtureCwd: () => null }, async (_record, _method, _args, until) => {
        deadline = until!;
        now = deadline - 1000;
      });
      await expect(backend.kill(session)).rejects.toThrow("daemon did not retire");
      expect(now).toBe(deadline + 1000);
      expect(identity).toHaveBeenCalledTimes(1);
    } finally { identity.mockRestore(); clock.mockRestore(); }
  });
});

test("pending identity discovery cannot keep kill waiting beyond its remaining allowance", async () => {
  await withRecord(async ({ session }) => {
    let now = 1000;
    let release!: (value: null) => void;
    let settled = false;
    const pending = new Promise<null>((accept) => { release = accept; });
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const identity = spyOn(identities, "getNativeProcessIdentity").mockImplementation(async () => {
      const value = await pending;
      settled = true;
      return value;
    });
    try {
      const backend = createBunBackend({ fixtureCwd: () => null }, async (_record, _method, _args, until) => {
        now = until! - 10;
      });
      await expect(backend.kill(session)).rejects.toThrow("daemon did not retire");
      expect(settled).toBe(false);
      expect(identity).toHaveBeenCalledTimes(1);
    } finally {
      release(null);
      await pending;
      identity.mockRestore();
      clock.mockRestore();
    }
  });
}, 5000);

test("same-name replacement shares cleanup time and refuses to replace a live old daemon", async () => {
  await withRecord(async ({ session, root, paths, record }) => {
    let now = 1000;
    let deadline = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const identity = spyOn(identities, "getNativeProcessIdentity").mockImplementation(async () => {
      now = deadline;
      return record.daemonIdentity;
    });
    try {
      const backend = createBunBackend({ fixtureCwd: () => { throw new Error("replacement was launched"); } },
        async (_record, method, _args, until) => {
          expect(method).toBe("kill");
          deadline = until!;
          expect(deadline).toBe(now + NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS);
          now += NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS;
          publishTuiRecord(paths.record, { ...record, cleanupComplete: true }, record.directoryIdentity);
        });
      await expect(backend.start(session, root, 80, 24, [process.execPath])).rejects.toThrow("daemon did not retire");
      expect(JSON.parse(readFileSync(paths.record, "utf8")).generation).toBe(record.generation);
      expect(existsSync(paths.release)).toBe(false);
    } finally { identity.mockRestore(); clock.mockRestore(); }
  });
});

test("replacement endpoint verification cannot obtain another cleanup allowance", async () => {
  await withRecord(async ({ session, root, paths, record }) => {
    let now = 1000;
    let deadline = 0;
    let absent = false;
    let clockReadsAfterAbsence = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => {
      // Retirement is timely; the next phase starts when its last millisecond
      // has elapsed and must not allocate a new endpoint-probe budget.
      if (absent && ++clockReadsAfterAbsence > 1) now = deadline;
      return now;
    });
    const identity = spyOn(identities, "getNativeProcessIdentity").mockImplementation(async () => {
      now = deadline - 1;
      absent = true;
      return null;
    });
    try {
      const backend = createBunBackend({ fixtureCwd: () => { throw new Error("replacement was launched"); } },
        async (_record, _method, _args, until) => {
          deadline = until!;
          publishTuiRecord(paths.record, { ...record, cleanupComplete: true }, record.directoryIdentity);
        });
      await expect(backend.start(session, root, 80, 24, [process.execPath])).rejects.toThrow("endpoint is still active");
      expect(JSON.parse(readFileSync(paths.record, "utf8")).generation).toBe(record.generation);
    } finally { identity.mockRestore(); clock.mockRestore(); }
  });
});

test("supervisor cleanup can progress beyond seven seconds and still finish early within its shared budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "bun-supervisor-budget-"));
  const config = {
    token: randomUUID(), parentPid: process.pid, cwd: root,
    command: [process.execPath, "-e", "process.exit(99)"],
    statusPath: join(root, "status.json"), releasePath: join(root, "release"), stopPath: join(root, "stop"),
  };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  publishSupervisorStop(config.stopPath, { token: config.token, requestId: randomUUID() });
  const script = join(root, "supervisor-model.ts");
  writeFileSync(script, `
import { writeSync } from "node:fs";
import { runSupervisor } from ${JSON.stringify(new URL("../harness/tui-bun-process.ts", import.meta.url).href)};
let now = 0, probes = 0;
const observed = [];
Object.defineProperty(performance, "now", { configurable: true, value: () => now });
await runSupervisor(${JSON.stringify(configPath)}, async () => ({
  parentAlive: () => true, env: {},
  sweep(force, _targetPid, deadline) {
    if (probes++ === 0) return true;
    observed.push({ force, deadline, now });
    now += 8000;
    if (observed.length === 2) {
      writeSync(1, JSON.stringify({ observed, completedAt: now }) + "\\n");
      return true;
    }
    return false;
  },
}));
`);
  const child = Bun.spawn([process.execPath, script], {
    stdout: "pipe", stderr: "pipe", timeout: NATIVE_STARTUP_TIMEOUT_MS,
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    const proof = JSON.parse(stdout);
    expect(proof.observed).toEqual([
      { force: false, deadline: NATIVE_PROCESS_CLEANUP_TIMEOUT_MS, now: 0 },
      { force: true, deadline: NATIVE_PROCESS_CLEANUP_TIMEOUT_MS, now: 8000 },
    ]);
    expect(proof.completedAt).toBe(16_000);
    expect(proof.completedAt).toBeLessThan(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS);
    expect(JSON.parse(readFileSync(config.statusPath, "utf8"))).toMatchObject({ phase: "stopped", cleanupComplete: true });
    expect(NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS).toBeGreaterThan(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS);
    expect(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS).toBeGreaterThan(
      NATIVE_SUPERVISOR_EXIT_TIMEOUT_MS + NATIVE_OUTPUT_DRAIN_TIMEOUT_MS,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, NATIVE_STARTUP_TIMEOUT_MS + 5_000);
