// covers: harness-instrument:windows-portability
// Clock-controlled API transport tests; no remote command is dispatched.
import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { runAws, waitForInvocation } from "../harness/windows/ssm-run.ts";

describe("Windows SSM observation budget", () => {
  for (const late of [false, true]) {
    test(late ? "a terminal reply after expiry remains unconfirmed" : "successive API queries share the original remaining allowance", async () => {
      let now = Date.now();
      const requested: number[] = [];
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      const transport = spyOn(childProcess, "spawnSync").mockImplementation(((
        command: string,
        args: readonly string[],
        options: childProcess.SpawnSyncOptions,
      ) => {
        expect(command).toBe("aws");
        expect(args.slice(0, 2)).toEqual(["ssm", "get-command-invocation"]);
        requested.push(options.timeout!);
        const first = requested.length === 1;
        now += late ? 101 : first ? 40 : 20;
        const stdout = JSON.stringify({
          status: late || !first ? "Success" : "Pending",
          stdout: "", stderr: "", responseCode: late || !first ? 0 : -1,
        });
        return { pid: 123, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
      }) as typeof childProcess.spawnSync);
      try {
        const observed = waitForInvocation("fixture-instance", "fixture-region", "fixture-command", 0, 100);
        if (late) {
          await expect(observed).rejects.toThrow("remote exit remains unconfirmed");
          expect(requested).toEqual([100]);
        } else {
          expect((await observed).status).toBe("Success");
          expect(requested).toEqual([100, 60]);
        }
        expect(() => runAws(["ssm", "get-command-invocation"], undefined, now - 1))
          .toThrow("budget exhausted");
        expect(transport).toHaveBeenCalledTimes(late ? 1 : 2);
      } finally {
        transport.mockRestore();
        clock.mockRestore();
      }
    });
  }
});
