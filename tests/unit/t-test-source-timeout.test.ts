// covers: harness-instrument:test-source-deadline
import { describe, expect, test } from "bun:test";
import type { spawnSync, SpawnSyncReturns } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { runTestSourceGit } from "../lib/test-source.ts";

const ROOT = resolve(import.meta.dir, "../..");
function result(code?: string): SpawnSyncReturns<Buffer> {
  const stdout = Buffer.from("captured\n");
  const stderr = Buffer.alloc(0);
  return {
    pid: 1, stdout, stderr, output: [null, stdout, stderr],
    status: code ? null : 0, signal: code === "ETIMEDOUT" ? "SIGTERM" : null,
    ...(code ? { error: Object.assign(new Error("controlled transport failure"), { code }) } : {}),
  };
}
const fakeSpawn = (fn: (timeout: number) => SpawnSyncReturns<Buffer>) =>
  ((_command: string, _args: string[], options: {timeout: number}) => fn(options.timeout)) as unknown as typeof spawnSync;

describe("source Git transport deadlines", () => {
  test("a premature Windows timeout gets one read with only the remaining budget", () => {
    let clock = 0;
    const budgets: number[] = [];
    const output = runTestSourceGit(ROOT, ["ls-files"], {
      platform: "win32", timeoutMs: 1000, now: () => clock,
      spawn: fakeSpawn((timeout) => {
        budgets.push(timeout);
        clock += 250;
        return result(budgets.length === 1 ? "ETIMEDOUT" : undefined);
      }),
    });
    expect(output).toBe("captured\n");
    expect(budgets).toEqual([1000, 750]);
  });

  test("an exhausted timeout cannot start another process", () => {
    let clock = 0;
    let calls = 0;
    expect(() => runTestSourceGit(ROOT, ["ls-files"], {
      platform: "win32", timeoutMs: 1000, now: () => clock,
      spawn: fakeSpawn(() => { calls++; clock = 1000; return result("ETIMEDOUT"); }),
    })).toThrow("ETIMEDOUT");
    expect(calls).toBe(1);
  });

  test("repeated early timeouts still fail after the single recovery attempt", () => {
    let clock = 0;
    let calls = 0;
    expect(() => runTestSourceGit(ROOT, ["ls-files"], {
      platform: "win32", timeoutMs: 1000, now: () => clock,
      spawn: fakeSpawn(() => { calls++; clock += 1; return result("ETIMEDOUT"); }),
    })).toThrow("attempts=2");
    expect(calls).toBe(2);
  });

  test("other transport errors and POSIX timeouts are never retried", () => {
    for (const [platform, code] of [["win32", "EACCES"], ["linux", "ETIMEDOUT"]] as const) {
      let calls = 0;
      expect(() => runTestSourceGit(ROOT, ["ls-files"], {
        platform, spawn: fakeSpawn(() => { calls++; return result(code); }),
      })).toThrow(code);
      expect(calls).toBe(1);
    }
  });

  test("the recovery surface refuses non-read-only Git commands", () => {
    let calls = 0;
    expect(() => runTestSourceGit(ROOT, ["push"], {
      spawn: fakeSpawn(() => { calls++; return result(); }),
    })).toThrow("read-only");
    expect(calls).toBe(0);
  });

  test("real Git remains usable after an asynchronous gap longer than its timeout", async () => {
    expect(realpathSync(runTestSourceGit(ROOT, ["rev-parse", "--show-toplevel"], { timeoutMs: 1000 }).trim()))
      .toBe(realpathSync(ROOT));
    await Bun.sleep(1500);
    expect(realpathSync(runTestSourceGit(ROOT, ["rev-parse", "--show-toplevel"], { timeoutMs: 1000 }).trim()))
      .toBe(realpathSync(ROOT));
  }, 10_000);
});
