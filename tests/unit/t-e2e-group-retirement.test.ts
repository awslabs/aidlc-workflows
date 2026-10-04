// The runner retires each test file's process group, then waits until the group
// is gone. A probe answer that only means "members remain" must keep it
// waiting, never fail the file at once: that dropped a passing file and stopped
// the rest of its leg (macOS Full Suite, t197). The real-group case runs the OS
// probe on a group that holds only an unreaped zombie.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { groupRetired, type GroupProbe } from "../lib/e2e-process.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });
const failing = (code: string): GroupProbe["signal"] => () => { throw errno(code); };
const NO_STAT: GroupProbe["stat"] = () => { throw new Error("stat not expected"); };

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
      const child = spawn("true", [], { detached: true, stdio: "ignore" });
      const exited = new Promise((done) => child.once("exit", done));
      const group = child.pid!;
      // Never yield while the child exits, so the runtime cannot reap it yet.
      const until = Date.now() + 500;
      while (Date.now() < until) { /* spin */ }
      let answer = "ok";
      try { process.kill(-group, 0); }
      catch (error) { answer = (error as NodeJS.ErrnoException).code ?? String(error); }
      // The OS answer the probe must survive: Linux counts the zombie, Darwin
      // refuses the probe with EPERM.
      expect(answer).toBe(process.platform === "darwin" ? "EPERM" : "ok");
      expect(() => groupRetired(group)).not.toThrow();
      await exited;
      expect(groupRetired(group)).toBe(true);
    },
  );
});
