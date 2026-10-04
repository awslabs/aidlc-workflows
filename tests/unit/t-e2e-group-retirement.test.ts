// The runner retires each test file's process group, then waits until the group
// is gone. A probe answer that only means "members remain" must keep it
// waiting, never fail the file at once: that dropped a passing file and stopped
// the rest of its leg (macOS Full Suite, t197). The real-group case runs the OS
// probe on a group that holds only an unreaped zombie.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { NATIVE_PROCESS_QUERY_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { groupRetired, type GroupProbe } from "../lib/e2e-process.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });
const failing = (code: string): GroupProbe["signal"] => () => { throw errno(code); };
const NO_STAT: GroupProbe["stat"] = () => { throw new Error("stat not expected"); };

// Starts a child in its own process group, prints its pid, then blocks without
// running an event loop, so it never reaps the child: the group holds only
// that zombie for as long as the holder lives.
const ZOMBIE_HOLDER = [
  'const child = require("node:child_process").spawn("true", [], { detached: true, stdio: "ignore" });',
  'require("node:fs").writeSync(1, child.pid + "\\n");',
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
].join("\n");

function isZombie(pid: number): boolean {
  if (process.platform === "linux") {
    let stat: string;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return false; }
    return stat.slice(stat.lastIndexOf(")") + 1).trim().startsWith("Z");
  }
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)],
    { encoding: "utf8", timeout: remainingOperationTimeoutMs(NATIVE_PROCESS_QUERY_TIMEOUT_MS) });
  return (ps.stdout ?? "").trim().startsWith("Z");
}

async function until(done: () => boolean, what: string, deadline: number): Promise<void> {
  while (!done()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

describe("process group retirement probe", () => {
  test("ESRCH means the group is gone", () => {
    expect(groupRetired(4242, { signal: failing("ESRCH"), stat: NO_STAT })).toBe(true);
  });

  test("EPERM means members remain, so retirement keeps waiting", () => {
    expect(groupRetired(4242, { signal: failing("EPERM"), stat: NO_STAT })).toBe(false);
  });

  test("any other probe error still fails retirement", () => {
    expect(() => groupRetired(4242, { signal: failing("EINVAL"), stat: NO_STAT })).toThrow("EINVAL");
  });

  test.skipIf(process.platform !== "linux")(
    "a process reaped while its stat file is read is skipped, not an error",
    () => {
      // This process's own group is live, so the scan must go on past the
      // reaped entry and find this process running.
      const stat = (pid: string) => readFileSync(`/proc/${pid}/stat`, "utf8");
      const own = stat("self");
      const group = Number(own.slice(own.lastIndexOf(")") + 1).trim().split(/\s+/)[2]);
      let reaped = 0;
      const retired = groupRetired(group, {
        signal: () => {},
        stat: (pid) => {
          if (reaped === 0) { reaped++; throw errno("ESRCH"); }
          return stat(pid);
        },
      });
      expect(reaped).toBe(1);
      expect(retired).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a group holding only an unreaped zombie is not an error, and is gone once reaped",
    async () => {
      const deadline = Date.now() + (remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) ?? NATIVE_STARTUP_TIMEOUT_MS);
      const holder = spawn(process.execPath, ["-e", ZOMBIE_HOLDER], { stdio: ["ignore", "pipe", "inherit"] });
      try {
        let printed = "";
        holder.stdout.on("data", (chunk) => { printed += chunk; });
        await until(() => printed.includes("\n"), "the holder's child pid", deadline);
        const group = Number(printed.trim());
        await until(() => isZombie(group), "the child to exit unreaped", deadline);
        let answer = "ok";
        try { process.kill(-group, 0); }
        catch (error) { answer = (error as NodeJS.ErrnoException).code ?? String(error); }
        // The OS answer the probe must survive: Linux counts the zombie, Darwin
        // refuses the probe with EPERM.
        expect(answer).toBe(process.platform === "darwin" ? "EPERM" : "ok");
        expect(() => groupRetired(group)).not.toThrow();
        // The orphaned zombie goes to init or launchd, which reaps it.
        holder.kill("SIGKILL");
        await until(() => groupRetired(group), "the orphaned zombie to be reaped", deadline);
      } finally {
        if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      }
    },
  );
});
