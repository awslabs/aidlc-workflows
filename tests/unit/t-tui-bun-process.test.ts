// Portable identity and Windows API-model controls. Real Linux process tests
// are independently selectable in t-tui-bun-process-linux.test.ts.
import { describe, expect, test } from "bun:test";
import {
  isLinuxDescendant, type LinuxProcessIdentity, parseLinuxProcStat, sameLinuxProcess,
  terminateWindowsJobMember, type WindowsJobTerminationApi,
  type WindowsJobTerminationObservation, windowsJobLimits,
} from "../harness/tui-bun-process.ts";

function identity(pid: number, ppid: number, ticks: bigint): LinuxProcessIdentity {
  return { pid, ppid, startTicks: ticks, state: "S" };
}

describe("native supervisor identity checks", () => {
  test("proc stat parses comm containing parentheses/newlines and preserves 64-bit ticks", () => {
    const fields = ["S", "10", ...Array(17).fill("0"), "9007199254740993", "0"];
    expect(parseLinuxProcStat(`42 (a ) process\n(with spaces)) ${fields.join(" ")}\n`)).toEqual(
      identity(42, 10, 9007199254740993n),
    );
    for (const invalid of ["", "42 broken", "42 (comm) S 10", "0 (comm) S 10"]) {
      expect(() => parseLinuxProcStat(invalid)).toThrow("stat identity");
    }
  });

  test("PID equality alone does not establish process identity", () => {
    expect(sameLinuxProcess(identity(42, 1, 10n), identity(42, 2, 10n))).toBe(true);
    expect(sameLinuxProcess(identity(42, 1, 10n), identity(42, 1, 11n))).toBe(false);
  });

  test("owns descendants and reparented orphans, excludes unrelated processes and self", () => {
    const owner = identity(10, 1, 10n);
    const child = identity(20, 10, 20n);
    const detached = identity(30, 20, 30n);
    const orphan = identity(40, 10, 40n);
    const unrelated = identity(50, 1, 50n);
    const snapshot = new Map([owner, child, detached, orphan, unrelated].map((p) => [p.pid, p]));
    for (const owned of [child, detached, orphan]) {
      expect(isLinuxDescendant(owned, owner, snapshot)).toBe(true);
    }
    expect(isLinuxDescendant(owner, owner, snapshot)).toBe(false);
    expect(isLinuxDescendant(unrelated, owner, snapshot)).toBe(false);
  });

  test("refuses incomplete, cyclic and reused ancestry", () => {
    const owner = identity(10, 1, 10n);
    const child = identity(20, 10, 20n);
    const leaf = identity(30, 20, 30n);
    expect(isLinuxDescendant(leaf, owner, new Map([[10, owner], [30, leaf]]))).toBe(false);
    expect(isLinuxDescendant(leaf, owner, new Map([
      [10, owner], [20, identity(20, 10, 31n)], [30, leaf],
    ]))).toBe(false);
    expect(isLinuxDescendant(child, owner, new Map([
      [10, identity(10, 1, 11n)], [20, child],
    ]))).toBe(false);
    expect(isLinuxDescendant(leaf, owner, new Map([
      [10, owner], [20, identity(20, 30, 30n)], [30, leaf],
    ]))).toBe(false);
  });

  test("Win64 extended job limit buffer matches the Windows ABI, without breakaway flags", () => {
    const bytes = windowsJobLimits();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(bytes.byteLength).toBe(64 + 48 + 4 * 8);
    expect(view.getUint32(16, true)).toBe(0x2000);
    expect(view.getBigUint64(24, true)).toBe(0n); // SIZE_T MinimumWorkingSetSize, after padding
    expect(view.getUint32(40, true)).toBe(0); // ActiveProcessLimit
    expect(view.getBigUint64(112, true)).toBe(0n); // ProcessMemoryLimit
    expect([...bytes].filter((byte) => byte !== 0)).toEqual([0x20]);
  });
});

describe("Windows job member termination races", () => {
  const processHandle = { kind: "process" };
  const jobHandle = { kind: "job" };
  function apiFor(waits: number[], terminateError = 5, membership = 1) {
    const calls: Array<{ method: string; handle: object; value?: number }> = [];
    let error = terminateError;
    const api: WindowsJobTerminationApi<object> = {
      IsProcessInJob(handle, job, member) {
        expect(job).toBe(jobHandle);
        calls.push({ method: "membership", handle });
        member[0] = membership;
        return 1;
      },
      TerminateProcess(handle, code) {
        calls.push({ method: "terminate", handle, value: code });
        error = terminateError;
        return terminateError === 0 ? 1 : 0;
      },
      WaitForSingleObject(handle, milliseconds) {
        calls.push({ method: "wait", handle, value: milliseconds });
        if (!waits.length) throw new Error("unexpected extra wait");
        const state = waits.shift()!;
        if (state === 0xffffffff) error = 6;
        return state;
      },
      GetLastError() { return error; },
    };
    return { api, calls };
  }

  test("access denied during concurrent termination waits on the same handle within the remaining budget", () => {
    const { api, calls } = apiFor([258, 258, 0]);
    const observations: WindowsJobTerminationObservation[] = [];
    let clock = 1000;
    terminateWindowsJobMember(api, processHandle, jobHandle, 42, 1500,
      () => { const now = clock; clock += 75; return now; }, (event) => observations.push(event));
    expect(calls.map(({ method, value }) => [method, value])).toEqual([
      ["membership", undefined], ["wait", 0], ["terminate", 1], ["wait", 0], ["wait", 425],
    ]);
    expect(calls.every((call) => call.handle === processHandle)).toBe(true);
    expect(observations).toEqual([{
      pid: 42, terminateError: 5, initialWait: 258, waitBudgetMs: 425, finalWait: 0, waitError: undefined,
    }]);
  });

  test("an already signaled member needs no termination, and an accepted termination needs no error retry", () => {
    const gone = apiFor([0]);
    terminateWindowsJobMember(gone.api, processHandle, jobHandle, 42, 1000, () => 0);
    expect(gone.calls.some((call) => call.method === "terminate")).toBe(false);
    const accepted = apiFor([258], 0);
    terminateWindowsJobMember(accepted.api, processHandle, jobHandle, 42, 1000, () => 0);
    expect(accepted.calls.filter((call) => call.method === "wait")).toHaveLength(1);
  });

  test("a process signaled immediately after access denied does not spend the cleanup budget", () => {
    const { api, calls } = apiFor([258, 0]);
    terminateWindowsJobMember(api, processHandle, jobHandle, 42, 1000, () => 0);
    expect(calls.filter((call) => call.method === "wait").map((call) => call.value)).toEqual([0, 0]);
  });

  test("persistent denial remains an error after one finite wait, with PID and wait evidence", () => {
    const { api, calls } = apiFor([258, 258, 258]);
    const observations: WindowsJobTerminationObservation[] = [];
    expect(() => terminateWindowsJobMember(api, processHandle, jobHandle, 42, 400,
      () => 100, (event) => observations.push(event))).toThrow(
      "TerminateProcess(job member 42) failed: Windows error 5; initial wait=258; final wait=258; waited at most 300ms",
    );
    expect(calls.filter((call) => call.method === "wait").map((call) => call.value)).toEqual([0, 0, 300]);
    expect(observations[0].finalWait).toBe(258);
  });

  test("a wait failure and an unexpected termination error cannot become successful cleanup", () => {
    const failedWait = apiFor([258, 258, 0xffffffff]);
    expect(() => terminateWindowsJobMember(failedWait.api, processHandle, jobHandle, 42, 500, () => 0))
      .toThrow("wait error=6");
    const unexpected = apiFor([258, 258], 87);
    expect(() => terminateWindowsJobMember(unexpected.api, processHandle, jobHandle, 42, 500, () => 0))
      .toThrow("Windows error 87");
    expect(unexpected.calls.filter((call) => call.method === "wait").every((call) => call.value === 0)).toBe(true);
  });

  test("ownership changes and expired deadlines refuse termination", () => {
    const otherJob = apiFor([], 5, 0);
    expect(() => terminateWindowsJobMember(otherJob.api, processHandle, jobHandle, 42, 500, () => 0))
      .toThrow("ownership changed");
    expect(otherJob.calls.map((call) => call.method)).toEqual(["membership"]);
    const expired = apiFor([]);
    expect(() => terminateWindowsJobMember(expired.api, processHandle, jobHandle, 42, 500, () => 500))
      .toThrow("deadline");
    expect(expired.calls).toEqual([]);
  });

  test("a deadline consumed by earlier operations cannot be restarted after access denied", () => {
    const { api, calls } = apiFor([258, 258]);
    let read = 0;
    expect(() => terminateWindowsJobMember(api, processHandle, jobHandle, 42, 500,
      () => read++ === 0 ? 0 : 500)).toThrow("waited at most 0ms");
    expect(calls.filter((call) => call.method === "wait").map((call) => call.value)).toEqual([0, 0]);
  });
});
