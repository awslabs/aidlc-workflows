// All process queries, clocks and termination effects are injected. These
// state-machine controls run on every OS without a Claude CLI or a live TUI.
import { describe, expect, test } from "bun:test";
import { nativeSnapshotReply, withNativeGeneration } from "../harness/windows-identity-fixture.ts";
import { NATIVE_PROCESS_CLEANUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  createWindowsCleanupIdentityReader,
  forceKillWindowsProcessesWithinDeadline,
  liveOwnedWindowsProcesses,
  liveWindowsCleanupProcesses,
  queryWindowsProcessIdentities,
  validateWindowsSpawnIdentity,
  WIN_KILL_TIMEOUT_MS,
  type WindowsProcessIdentity,
} from "../harness/tui-drive.ts";

describe("Windows cleanup identity state", () => {
  const identity = (pid: number, parentPid = 100, creationDate = "2026-09-22T00:00:01.000Z"): WindowsProcessIdentity => ({
    pid, parentPid, creationDate, commandLine: `owned process ${pid}`,
  });
  const snapshotReply = (rows: WindowsProcessIdentity[], args: string[]) =>
    nativeSnapshotReply(args.slice(2).map(Number), rows);

  test("cleanup retries discover a target after absence and still verify absent recorded descendants", () => {
    const daemon = identity(101);
    const wrapper = identity(202, daemon.pid);
    const target = identity(303, wrapper.pid);
    const descendant = identity(404, target.pid);
    let now = 0;
    let queries = 0;
    const rows = [
      [daemon, wrapper],
      [daemon, wrapper],
      [daemon, wrapper, target],
      [daemon, wrapper, target],
    ];
    const read = createWindowsCleanupIdentityReader([101, 202, 303, 404], WIN_KILL_TIMEOUT_MS, {
      now: () => now,
      query: (_pids, budget) => {
        expect(budget).toBeLessThanOrEqual(WIN_KILL_TIMEOUT_MS - now);
        now += 1_000;
        return { status: "ok", value: rows[queries++] };
      },
    });
    expect(read(daemon.pid, "kill-daemon")).toEqual({ status: "ok", value: daemon });
    expect(read(wrapper.pid, "kill-owned-process")).toEqual({ status: "ok", value: wrapper });
    expect(queries).toBe(1); // First positive reads still share the initial batch.
    expect(read(target.pid, "kill-target-live", 2_500)).toEqual({ status: "absent" });
    expect(queries).toBe(2); // Absence in the initial batch was not reused.
    now += 100; // The production target-discovery loop waits before retrying.
    const visible = read(target.pid, "kill-target-live", 1_400);
    expect(visible).toEqual({ status: "ok", value: target });
    expect(queries).toBe(3);
    if (visible.status !== "ok") throw new Error("target never became visible");
    expect(validateWindowsSpawnIdentity({
      pid: target.pid, parentPid: wrapper.pid, startedAfter: "2026-09-22T00:00:00.000Z",
    }, visible.value)).toEqual({ status: "ok", value: target });
    expect(read(descendant.pid, "kill-owned-process")).toEqual({ status: "absent" });

    // The final probe must include the registered descendant even though the
    // initial ownership read did not see it. Only its fresh creation identity
    // can authorize termination; it must not disappear from the verification set.
    const live = liveWindowsCleanupProcesses(
      [daemon, wrapper, visible.value],
      [descendant],
      WIN_KILL_TIMEOUT_MS - now,
      "kill-liveness",
      (_file, args) => {
        expect(args.slice(2)).toContain("404");
        return snapshotReply([descendant], args);
      },
    );
    expect(live).toEqual({ status: "ok", value: [descendant] });
    const killed: number[] = [];
    if (live.status === "ok") {
      forceKillWindowsProcessesWithinDeadline(live.value, WIN_KILL_TIMEOUT_MS, {
        now: () => now,
        terminate: (pid) => { killed.push(pid); },
      });
    }
    expect(killed).toEqual([descendant.pid]);
  });

  test("cleanup rechecks invalidate prior positives and never retain a recycled PID", () => {
    const daemon = identity(101);
    const wrapper = identity(202);
    const recorded = identity(303);
    const reused = identity(303, 999, "2026-09-22T00:01:00.000Z");
    let queries = 0;
    const read = createWindowsCleanupIdentityReader([101, 202, 303], WIN_KILL_TIMEOUT_MS, {
      now: () => 0,
      query: () => {
        queries++;
        if (queries === 1) return { status: "ok", value: [daemon, wrapper, recorded] };
        if (queries === 2) return { status: "error", message: "temporary query failure" };
        return { status: "ok", value: queries === 3 ? [reused] : [] };
      },
    });
    expect(read(daemon.pid, "kill-daemon").status).toBe("ok");
    // Explicit recheck is fresh even for a PID not read individually before.
    expect(read(wrapper.pid, "kill-daemon-recheck", WIN_KILL_TIMEOUT_MS, true).status).toBe("error");
    expect(read(recorded.pid, "kill-owned-process")).toEqual({ status: "ok", value: reused });
    expect(queries).toBe(3); // The error invalidated the still-unread positive.
    const live = liveWindowsCleanupProcesses([], [recorded], WIN_KILL_TIMEOUT_MS, "kill-liveness",
      (_file, args) => snapshotReply([reused], args));
    expect(live).toEqual({ status: "ok", value: [] });
    const killed: number[] = [];
    if (live.status === "ok") {
      forceKillWindowsProcessesWithinDeadline(live.value, WIN_KILL_TIMEOUT_MS, {
        now: () => 0,
        terminate: (pid) => { killed.push(pid); },
      });
    }
    expect(killed).toEqual([]);
    expect(read(recorded.pid, "kill-owned-process")).toEqual({ status: "absent" });
    expect(queries).toBe(4); // A repeated positive read is also fresh.
  });

  test("cleanup never uses cached or late observations beyond the original deadline", () => {
    const daemon = identity(101);
    const wrapper = identity(202);
    let now = 0;
    let queries = 0;
    const read = createWindowsCleanupIdentityReader([101, 202], WIN_KILL_TIMEOUT_MS, {
      now: () => now,
      query: () => { queries++; return { status: "ok", value: [daemon, wrapper] }; },
    });
    expect(read(daemon.pid, "kill-daemon").status).toBe("ok");
    now = WIN_KILL_TIMEOUT_MS;
    expect(read(wrapper.pid, "kill-owned-process").status).toBe("error");
    expect(queries).toBe(1); // Even a positive cache hit cannot outlive the budget.
    let finalQueries = 0;
    expect(liveWindowsCleanupProcesses([], [wrapper], 0, "kill-liveness", (_file, args) => {
      finalQueries++;
      return snapshotReply([wrapper], args);
    }).status).toBe("error");
    expect(finalQueries).toBe(0);

    now = WIN_KILL_TIMEOUT_MS - 100;
    const late = createWindowsCleanupIdentityReader([101], WIN_KILL_TIMEOUT_MS, {
      now: () => now,
      query: (_pids, budget) => {
        expect(budget).toBe(100); // Caller allowance is capped by the shared deadline.
        now += 101;
        return { status: "ok", value: [daemon] };
      },
    });
    expect(late(daemon.pid, "kill-daemon", 2_000).status).toBe("error");
  });

  test("identity snapshots share the existing deadline and retain fresh command lines", () => {
    const identities: WindowsProcessIdentity[] = [101, 202, 303].map((pid) => ({
      pid,
      parentPid: 100,
      creationDate: "2026-09-22T00:00:00.000Z",
      commandLine: `owned process ${pid}`,
    }));
    let queries = 0;
    const snapshot = queryWindowsProcessIdentities([101, 202, 303], 2_000, "settings-startup-control",
      (file, args, budget) => {
        queries++;
        expect(file).toBe(process.env.AIDLC_BUN_BIN ?? process.execPath);
        expect(args.slice(1)).toEqual(["--windows-process-details", "101", "202", "303"]);
        // A 1100ms cold start cannot finish under the former 750ms cap.
        return budget < 1100
          ? { status: null, stdout: "", stderr: "", timedOut: true }
          : snapshotReply(identities, args);
      });
    expect(snapshot).toEqual({ status: "ok", value: identities.map(withNativeGeneration) });
    expect(queries).toBe(1);
    expect(WIN_KILL_TIMEOUT_MS).toBe(NATIVE_PROCESS_CLEANUP_TIMEOUT_MS);
    expect(liveOwnedWindowsProcesses(identities, 2_000, "settings-reuse-control", (_file, args) =>
      snapshotReply(identities.map(row => ({
        ...row, creationDate: "2026-09-22T00:01:00.000Z",
      })), args))).toEqual({ status: "ok", value: [] });
  });

  test("native creation generations remain distinct within the same millisecond", () => {
    const recorded = withNativeGeneration(identity(303));
    const nextTicks = BigInt(recorded.nativeIdentity!.split(":")[2]) + 1n;
    const reused = { ...recorded, nativeIdentity: `win32:303:${nextTicks}` };
    expect(liveOwnedWindowsProcesses([recorded], 2_000, "settings-submillisecond-reuse", (_file, args) =>
      snapshotReply([reused], args))).toEqual({ status: "ok", value: [] });
  });

  test("timed-out or malformed identity snapshots cannot establish absence", () => {
    for (const reply of [
      { status: 0, stdout: Buffer.from("[]").toString("base64"), stderr: "", timedOut: true },
      { status: 0, stdout: Buffer.from('[{"pid":101}]').toString("base64"), stderr: "", timedOut: false },
    ]) {
      expect(queryWindowsProcessIdentities([101], 2_000, "settings-query-error-control", () => reply).status)
        .toBe("error");
    }
  });
});
