// covers: function:readSessionBinding function:writeSessionBinding function:resolveWorkflowSelection function:workflowParticipation function:readActiveIntentCursor function:SessionResolutionConflictError function:validSessionId function:writeSessionPidEntry function:writeSessionPidAncestry function:resolveSessionIdFromAncestry function:hookChildEnv function:windowsSessionProcessIdentity
//
// Deterministic coverage for the per-session binding store and PID ancestry
// resolver. All writes stay under a fresh project fixture.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, spyOn, test, setDefaultTimeout } from "bun:test";
import * as ffi from "bun:ffi";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  activeIntent,
  auditFilePath,
  createIntent,
  docsRoot,
  hookChildEnv,
  listIntents,
  readActiveIntentCursor,
  readSessionBinding,
  resolveSessionIdFromAncestry,
  resolveWorkflowSelection,
  SessionResolutionConflictError,
  sessionPidMapDir,
  sessionsDir,
  setActiveIntentCursor,
  setActiveSpaceCursor,
  stateFilePath,
  unitScopePath,
  validSessionId,
  writeSessionBinding,
  writeSessionIntentUuid,
  writeSessionPidAncestry,
  writeSessionPidEntry,
  windowsSessionProcessIdentity,
  workflowParticipation,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";
import { intentUsageKey } from "../../dist/claude/.claude/tools/aidlc-usage.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

let proj = "";
const originalSessionOverride = process.env.AIDLC_SESSION_OVERRIDE;
const originalSessionOverrideSource =
  process.env.AIDLC_SESSION_OVERRIDE_SOURCE;
const originalTestSessionPlatform = process.env.AIDLC_TEST_SESSION_PLATFORM;
const originalTestPsDenied = process.env.AIDLC_TEST_PS_DENIED;

function mockMacProcessTree(parents = new Map<number, number>()) {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const ps = spyOn(childProcess, "spawnSync").mockImplementation(((
    command: string,
    args: readonly string[],
  ) => {
    expect(command).toBe("ps");
    now += 5;
    const pid = Number(args.at(-1));
    const stdout = `${parents.get(pid) ?? 1} fixture-start-${pid}\n`;
    return { pid: 123, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
  }) as typeof childProcess.spawnSync);
  process.env.AIDLC_TEST_SESSION_PLATFORM = "darwin";
  return {
    ps,
    restore() {
      ps.mockRestore();
      clock.mockRestore();
    },
  };
}

beforeEach(() => {
  delete process.env.AIDLC_SESSION_OVERRIDE;
  delete process.env.AIDLC_SESSION_OVERRIDE_SOURCE;
  delete process.env.AIDLC_TEST_SESSION_PLATFORM;
  delete process.env.AIDLC_TEST_PS_DENIED;
  proj = createTestProject();
});

afterEach(() => {
  if (originalSessionOverride === undefined) {
    delete process.env.AIDLC_SESSION_OVERRIDE;
  } else {
    process.env.AIDLC_SESSION_OVERRIDE = originalSessionOverride;
  }
  if (originalSessionOverrideSource === undefined) {
    delete process.env.AIDLC_SESSION_OVERRIDE_SOURCE;
  } else {
    process.env.AIDLC_SESSION_OVERRIDE_SOURCE =
      originalSessionOverrideSource;
  }
  if (originalTestSessionPlatform === undefined) {
    delete process.env.AIDLC_TEST_SESSION_PLATFORM;
  } else {
    process.env.AIDLC_TEST_SESSION_PLATFORM = originalTestSessionPlatform;
  }
  if (originalTestPsDenied === undefined) {
    delete process.env.AIDLC_TEST_PS_DENIED;
  } else {
    process.env.AIDLC_TEST_PS_DENIED = originalTestPsDenied;
  }
  cleanupTestProject(proj);
  proj = "";
});

describe("t318 session binding helpers", () => {
  test("binding JSON round-trips a record and an explicit null intent", () => {
    const intent = createIntent(proj, "auth", "default", "feature");
    writeSessionBinding(proj, "session-a", "default", intent.dirName);
    expect(readSessionBinding(proj, "session-a")).toMatchObject({
      space: "default",
      intent: intent.dirName,
    });

    writeSessionBinding(proj, "session-a", "default", null);
    expect(readSessionBinding(proj, "session-a")).toMatchObject({
      space: "default",
      intent: null,
    });
  });

  test("explicit selectors beat a binding, which beats the shared cursor", () => {
    const first = createIntent(proj, "first", "default", "feature");
    const second = createIntent(proj, "second", "default", "feature");
    setActiveIntentCursor(proj, second.dirName, "default");
    writeSessionBinding(proj, "session-a", "default", first.dirName);

    expect(
      resolveWorkflowSelection(proj, { sessionId: "session-a" }).intent,
    ).toBe(first.dirName);
    writeSessionBinding(proj, "session-null", "default", null);
    expect(
      resolveWorkflowSelection(proj, { sessionId: "session-null" }).intent,
    ).toBeNull();
    expect(
      resolveWorkflowSelection(proj, {
        sessionId: "session-a",
        space: "default",
        intent: second.dirName,
      }).intent,
    ).toBe(second.dirName);
    expect(resolveWorkflowSelection(proj).intent).toBe(second.dirName);
  });

  test("a null-intent binding keeps its selected space in generic paths", () => {
    setActiveSpaceCursor(proj, "default");
    writeSessionBinding(proj, "session-null", "team-b", null);
    process.env.AIDLC_SESSION_OVERRIDE = "session-null";
    const teamBareRoot = join(
      proj,
      "aidlc",
      "spaces",
      "team-b",
      "intents",
    );

    expect(stateFilePath(proj)).toBe(join(teamBareRoot, "aidlc-state.md"));
    expect(auditFilePath(proj)).toStartWith(join(teamBareRoot, "audit"));
    expect(docsRoot(proj)).toBe(teamBareRoot);
  });

  test("session ids must already be canonical", () => {
    expect(validSessionId("session-a")).toBe("session-a");
    expect(validSessionId(" session-a")).toBeNull();
    expect(validSessionId("session-a ")).toBeNull();
    expect(validSessionId("session/a")).toBeNull();
    expect(validSessionId("")).toBeNull();
  });

  test("environment override conflicts with ancestry at the selection chokepoint", () => {
    const first = createIntent(proj, "first", "default", "feature");
    const second = createIntent(proj, "second", "default", "feature");
    writeSessionBinding(proj, "session-a", "default", first.dirName);
    writeSessionBinding(proj, "session-b", "default", second.dirName);
    // Ancestry is simulated so the conflict is reachable on hosts without native process lookup (Windows).
    const lookup = mockMacProcessTree();
    try {
      writeSessionPidEntry(proj, process.ppid, "session-a");
      process.env.AIDLC_SESSION_OVERRIDE = "session-b";

      expect(() => resolveWorkflowSelection(proj)).toThrow(
        SessionResolutionConflictError,
      );
      expect(
        resolveWorkflowSelection(proj, { sessionId: "session-b" }).intent,
      ).toBe(second.dirName);
    } finally {
      lookup.restore();
    }
  });

  test("hook child env preserves inherited identity and marks only divergent payloads", () => {
    process.env.AIDLC_SESSION_OVERRIDE = "inherited-session";
    rmSync(sessionPidMapDir(proj), { recursive: true, force: true });
    expect(hookChildEnv(proj, undefined).AIDLC_SESSION_OVERRIDE).toBe(
      "inherited-session",
    );
    expect(hookChildEnv(proj, " session").AIDLC_SESSION_OVERRIDE).toBe(
      "inherited-session",
    );
    expect(
      hookChildEnv(proj, "payload-session", { AIDLC_TEST_EXTRA: "kept" }),
    ).toMatchObject({
      AIDLC_SESSION_OVERRIDE: "payload-session",
      AIDLC_TEST_EXTRA: "kept",
    });
    expect(
      hookChildEnv(proj, "payload-session").AIDLC_SESSION_OVERRIDE_SOURCE,
    ).toBeUndefined();

    const lookup = mockMacProcessTree();
    try {
      writeSessionPidEntry(proj, process.ppid, "payload-session");
      const matching = hookChildEnv(proj, "payload-session");
      expect(matching.AIDLC_SESSION_OVERRIDE).toBe("payload-session");
      expect(matching.AIDLC_SESSION_OVERRIDE_SOURCE).toBeUndefined();

      const divergent = hookChildEnv(proj, "different-session");
      expect(divergent.AIDLC_SESSION_OVERRIDE).toBe("different-session");
      expect(divergent.AIDLC_SESSION_OVERRIDE_SOURCE).toBe("payload");
    } finally {
      lookup.restore();
    }
  });

  test("hostile session ids and invalid pids cannot escape the sessions dir", () => {
    const intent = createIntent(proj, "safe", "default", "feature");
    writeSessionBinding(proj, "..", "default", intent.dirName);
    expect(readSessionBinding(proj, "..")).toBeNull();

    writeSessionBinding(proj, "../../outside", "default", intent.dirName);
    const names = existsSync(sessionsDir(proj))
      ? readdirSync(sessionsDir(proj))
      : [];
    expect(names.some((name) => name.endsWith(".binding.json"))).toBe(false);
    expect(existsSync(join(proj, "aidlc", "outside.binding.json"))).toBe(false);

    writeSessionPidEntry(proj, -42, "session-a");
    expect(
      existsSync(join(sessionPidMapDir(proj), "-42")),
    ).toBe(false);
  });

  test("malformed and stale binding records degrade to no binding", () => {
    const dir = sessionsDir(proj);
    writeSessionBinding(proj, "bad", "default", null);
    writeFileSync(join(dir, "bad.binding.json"), "{not-json}\n", "utf-8");
    expect(readSessionBinding(proj, "bad")).toBeNull();

    writeFileSync(
      join(dir, "stale.binding.json"),
      `${JSON.stringify({
        space: "default",
        intent: "missing-record",
        boundAt: new Date().toISOString(),
      })}\n`,
      "utf-8",
    );
    expect(readSessionBinding(proj, "stale")).toBeNull();
  });

  test("nearest mapped ancestor wins and a start-time mismatch is rejected", () => {
    // Two simulated levels: the parent maps to this process, which maps to pid 1, so the far entry lands one level above the near one.
    const lookup = mockMacProcessTree(new Map([[process.ppid, process.pid]]));
    try {
      writeSessionPidAncestry(proj, "far-session");
      writeSessionPidEntry(proj, process.ppid, "near-session");
      expect(resolveSessionIdFromAncestry(proj)).toBe("near-session");

      const nearest = join(sessionPidMapDir(proj), String(process.ppid));
      const entry = JSON.parse(readFileSync(nearest, "utf-8")) as {
        sessionId: string;
        startTime: string | null;
      };
      writeFileSync(
        nearest,
        `${JSON.stringify({ ...entry, startTime: "definitely-not-the-real-start" })}\n`,
        "utf-8",
      );
      expect(resolveSessionIdFromAncestry(proj)).not.toBe("near-session");
    } finally {
      lookup.restore();
    }
  });

  test("GC keeps a live entry it cannot verify and still reaps dead ones without ps", () => {
    const pidDir = sessionPidMapDir(proj);
    mkdirSync(pidDir, { recursive: true });
    // This process is not an ancestor of itself, so GC must inspect this entry.
    const liveEntry = join(pidDir, String(process.pid));
    const deadEntry = join(pidDir, "999900123");
    writeFileSync(
      liveEntry,
      `${JSON.stringify({
        sessionId: "kept-session",
        startTime: "some-recorded-start",
      })}\n`,
      "utf-8",
    );
    writeFileSync(
      deadEntry,
      `${JSON.stringify({
        sessionId: "dead-session",
        startTime: "whatever",
      })}\n`,
      "utf-8",
    );

    const priorPlatform = process.env.AIDLC_TEST_SESSION_PLATFORM;
    const priorPsDenied = process.env.AIDLC_TEST_PS_DENIED;
    process.env.AIDLC_TEST_SESSION_PLATFORM = "darwin";
    process.env.AIDLC_TEST_PS_DENIED = "1";
    try {
      writeSessionPidAncestry(proj, "new-session");
      expect(existsSync(liveEntry)).toBe(true);
      expect(
        JSON.parse(readFileSync(liveEntry, "utf-8")).sessionId,
      ).toBe("kept-session");
      expect(existsSync(deadEntry)).toBe(false);
    } finally {
      if (priorPlatform === undefined) {
        delete process.env.AIDLC_TEST_SESSION_PLATFORM;
      } else {
        process.env.AIDLC_TEST_SESSION_PLATFORM = priorPlatform;
      }
      if (priorPsDenied === undefined) {
        delete process.env.AIDLC_TEST_PS_DENIED;
      } else {
        process.env.AIDLC_TEST_PS_DENIED = priorPsDenied;
      }
    }
  });

  test("a failed SessionStart cannot restore the previous session when process lookup recovers", () => {
    const current = createIntent(proj, "current", "default", "feature");
    writeSessionBinding(proj, "current-session", "default", current.dirName);
    // Both fixture PIDs are alive; only their parent links and lookup time are
    // simulated. Two levels also expose falling through to an older ancestor.
    const lookup = mockMacProcessTree(new Map([[process.ppid, process.pid]]));
    try {
      writeSessionPidAncestry(proj, "previous-session");
      expect(resolveSessionIdFromAncestry(proj)).toBe("previous-session");
      expect(readdirSync(sessionPidMapDir(proj))).toHaveLength(2);

      process.env.AIDLC_TEST_PS_DENIED = "1";
      writeSessionPidAncestry(proj, "current-session");
      delete process.env.AIDLC_TEST_PS_DENIED;

      // Recovery must not make the superseded parent or an older ancestor win.
      expect(resolveSessionIdFromAncestry(proj)).toBeNull();
      process.env.AIDLC_SESSION_OVERRIDE = "current-session";
      expect(resolveWorkflowSelection(proj).intent).toBe(current.dirName);

      // A later successful refresh restores normal ancestry selection.
      writeSessionPidAncestry(proj, "current-session");
      expect(resolveSessionIdFromAncestry(proj)).toBe("current-session");
    } finally {
      lookup.restore();
    }
  });

  test("a new session's nearest ancestor is written even when many stale entries are queued for GC", () => {
    const pidDir = sessionPidMapDir(proj);
    mkdirSync(pidDir, { recursive: true });
    for (let index = 0; index < 40; index++) {
      writeFileSync(
        join(pidDir, String(999_900_000 + index)),
        `${JSON.stringify({
          sessionId: "stale-session",
          startTime: null,
        })}\n`,
        "utf-8",
      );
    }

    // Model a 5ms ps call deterministically: GC-first exhausts the 50ms budget
    // on stale entries. The current walk resolves its parent once and GC
    // reaps dead PIDs without ps, regardless of host scheduling.
    const lookup = mockMacProcessTree();
    try {
      writeSessionPidAncestry(proj, "fresh-session");
      const nearest = join(pidDir, String(process.ppid));
      expect(existsSync(nearest)).toBe(true);
      expect(
        JSON.parse(readFileSync(nearest, "utf-8")).sessionId,
      ).toBe("fresh-session");
      expect(lookup.ps).toHaveBeenCalledTimes(1);
      expect(readdirSync(pidDir)).toEqual([String(process.ppid)]);
    } finally {
      lookup.restore();
    }
  });

  test("the PID map is optional and missing entries preserve cursor fallback", () => {
    rmSync(sessionPidMapDir(proj), { recursive: true, force: true });
    expect(resolveSessionIdFromAncestry(proj)).toBeNull();
  });

  test.skipIf(process.platform !== "win32")("native Windows identity agrees with Bun's self and parent PIDs", () => {
    const self = windowsSessionProcessIdentity(process.pid);
    const parent = windowsSessionProcessIdentity(process.ppid);
    expect(self).not.toBeNull();
    expect(parent).not.toBeNull();
    expect(self!.ppid).toBe(process.ppid);
    expect(self!.startTime).toMatch(/^win32:[0-9a-f]{16}$/);
    expect(parent!.startTime).toMatch(/^win32:[0-9a-f]{16}$/);
    expect(parent!.startTime! < self!.startTime!).toBe(true);
    expect(windowsSessionProcessIdentity(process.pid)).toEqual(self);
    expect(windowsSessionProcessIdentity(process.pid, Date.now())).toBeNull();
    for (const pid of [0, 1, -1, 1.5, 0x100000000]) {
      expect(windowsSessionProcessIdentity(pid)).toBeNull();
    }
  });

  test("Windows edge fixture: a newer or equal-time parent keeps its existing PID record", () => {
    // Deterministic edge metadata, not a claim that the OS recycled a live PID.
    // Exercise the actual writer ordering and its subsequent GC exclusion.
    process.env.AIDLC_TEST_SESSION_PLATFORM = "win32";
    const pidDir = sessionPidMapDir(proj);
    mkdirSync(pidDir, { recursive: true });
    const path = join(pidDir, String(process.ppid));
    for (const startTime of ["win32:0000000000000020", "win32:0000000000000010"]) {
      const before = `${JSON.stringify({ sessionId: "unrelated-owner", startTime })}\n`;
      writeFileSync(path, before);
      const probes: number[] = [];
      writeSessionPidAncestry(proj, "must-not-replace", (pid) => {
        probes.push(pid);
        return pid === process.pid
          ? { ppid: process.ppid, startTime: "win32:0000000000000010" }
          : { ppid: 1, startTime };
      });
      expect(probes).toEqual([process.pid, process.ppid]);
      expect(readFileSync(path, "utf-8")).toBe(before);
      expect(readdirSync(pidDir)).toEqual([String(process.ppid)]);
    }
  });

  test("Windows edge fixture: unknown inspection or an expired budget leaves a null barrier", () => {
    process.env.AIDLC_TEST_SESSION_PLATFORM = "win32";
    const pidDir = sessionPidMapDir(proj);
    mkdirSync(pidDir, { recursive: true });
    const path = join(pidDir, String(process.ppid));
    for (const failure of ["self", "parent", "deadline"]) {
      writeFileSync(path, JSON.stringify({
        sessionId: "previous-session",
        startTime: "win32:0000000000000001",
      }));
      let now = 1000;
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      try {
        writeSessionPidAncestry(proj, "unverified-session", (pid) => {
          if (pid === process.pid) {
            return failure === "self"
              ? null
              : { ppid: process.ppid, startTime: "win32:0000000000000010" };
          }
          if (failure === "deadline") now = 1051;
          return failure === "parent"
            ? null
            : { ppid: 1, startTime: "win32:0000000000000001" };
        });
        expect(JSON.parse(readFileSync(path, "utf-8")), failure).toEqual({
          sessionId: null,
          startTime: null,
        });
      } finally {
        clock.mockRestore();
      }
    }
  });

  test.skipIf(process.platform !== "win32")("native Windows child identity expires on exit and its PID receipt is collected", async () => {
    const child = Bun.spawn([
      process.execPath,
      "-e",
      'process.stdout.write("ready\\n"); await new Response(Bun.stdin.stream()).text();',
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let inputClosed = false;
    try {
      const reader = child.stdout.getReader();
      try {
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
      } finally {
        reader.releaseLock();
      }
      const identity = windowsSessionProcessIdentity(child.pid);
      expect(identity).not.toBeNull();
      expect(identity!.ppid).toBe(process.pid);
      writeSessionPidEntry(proj, child.pid, "native-child");
      const receiptPath = join(sessionPidMapDir(proj), String(child.pid));
      expect(JSON.parse(readFileSync(receiptPath, "utf-8"))).toEqual({
        sessionId: "native-child",
        startTime: identity!.startTime,
      });
      child.stdin.end();
      inputClosed = true;
      expect(await child.exited).toBe(0);
      // PID reuse after exit may produce a new observation, never this generation.
      expect(windowsSessionProcessIdentity(child.pid)?.startTime ?? null).not.toBe(identity!.startTime);
      writeSessionPidAncestry(proj, "after-child-exit");
      expect(existsSync(receiptPath)).toBe(false);
    } finally {
      if (!inputClosed) child.stdin.end();
      await child.exited;
    }
  });

  test.skipIf(process.platform !== "win32")("native Windows ancestry rejects another generation and unverified legacy receipts", () => {
    writeSessionPidAncestry(proj, "far-session");
    writeSessionPidEntry(proj, process.ppid, "near-session");
    const path = join(sessionPidMapDir(proj), String(process.ppid));
    const receipt = JSON.parse(readFileSync(path, "utf-8")) as {
      sessionId: string;
      startTime: string;
    };
    expect(receipt.startTime).toMatch(/^win32:[0-9a-f]{16}$/);
    expect(resolveSessionIdFromAncestry(proj)).toBe("near-session");
    const otherGeneration = BigInt(`0x${receipt.startTime.slice("win32:".length)}`) + 1n;
    writeFileSync(path, JSON.stringify({
      ...receipt,
      startTime: `win32:${otherGeneration.toString(16).padStart(16, "0")}`,
    }));
    expect(resolveSessionIdFromAncestry(proj)).not.toBe("near-session");

    // Re-publishing invalidates the negative cache before each changed receipt.
    writeSessionPidEntry(proj, process.ppid, "near-session");
    writeFileSync(path, JSON.stringify({ sessionId: "legacy-session", startTime: null }));
    expect(resolveSessionIdFromAncestry(proj)).toBeNull();
    writeSessionPidEntry(proj, process.ppid, "near-session");
    writeFileSync(path, JSON.stringify({ sessionId: null, startTime: null }));
    expect(resolveSessionIdFromAncestry(proj)).toBeNull();
    writeSessionPidEntry(proj, process.ppid, "refreshed-session");
    expect(resolveSessionIdFromAncestry(proj)).toBe("refreshed-session");
  });

  test.skipIf(process.platform === "win32")("a Windows test override cannot load native Windows APIs on another host", () => {
    writeSessionPidEntry(proj, process.ppid, "native-host-session");
    process.env.AIDLC_TEST_SESSION_PLATFORM = "win32";
    const loader = spyOn(ffi, "dlopen");
    try {
      expect(windowsSessionProcessIdentity(process.pid)).toBeNull();
      expect(resolveSessionIdFromAncestry(proj)).toBeNull();
      writeSessionPidAncestry(proj, "unsupported-host-session");
      expect(loader).not.toHaveBeenCalled();
    } finally {
      loader.mockRestore();
    }
  });

  test("a payload override selects its binding when Darwin ps access is denied", () => {
    const bound = createIntent(proj, "bound", "default", "feature");
    const cursor = createIntent(proj, "cursor", "default", "feature");
    writeSessionBinding(proj, "codex-session", "default", bound.dirName);
    setActiveIntentCursor(proj, cursor.dirName, "default");
    process.env.AIDLC_TEST_SESSION_PLATFORM = "darwin";
    process.env.AIDLC_TEST_PS_DENIED = "1";
    writeSessionPidEntry(proj, process.ppid, "ancestry-session");

    expect(resolveSessionIdFromAncestry(proj)).toBeNull();
    process.env.AIDLC_SESSION_OVERRIDE = "codex-session";
    process.env.AIDLC_SESSION_OVERRIDE_SOURCE = "payload";
    expect(resolveWorkflowSelection(proj).intent).toBe(bound.dirName);
  });

  test("every authored harness already ignores the sessions directory", () => {
    const root = join(import.meta.dir, "..", "..");
    for (const harness of [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "kiro",
      "kiro-ide",
      "opencode",
    ]) {
      const body = readFileSync(
        join(root, "harness", harness, "dot-gitignore"),
        "utf-8",
      );
      expect(body, harness).toContain("aidlc/.aidlc-sessions/");
    }
  });
});

describe("t318b workflow participation", () => {
  const intentsRoot = () => join(proj, "aidlc", "spaces", "default", "intents");
  // A fresh clone: the teammate's committed record, no per-user cursor.
  function loneRecordWithoutCursor(): string {
    const record = createIntent(proj, "teammate-work", "default", "feature").dirName;
    rmSync(join(intentsRoot(), "active-intent"), { force: true });
    return record;
  }
  const classify = (sessionId?: string) =>
    workflowParticipation(proj, resolveWorkflowSelection(proj, sessionId ? { sessionId } : {}));

  test("the lone-record fallback resolves the record but is not participation", () => {
    const record = loneRecordWithoutCursor();
    expect(activeIntent(proj, "default")).toBe(record);
    expect(readActiveIntentCursor(proj, "default")).toBeNull();
    expect(resolveWorkflowSelection(proj).intent).toBe(record);
    expect(classify()).toBe("outsider");
  });

  test("the local cursor naming the record is participation", () => {
    const record = loneRecordWithoutCursor();
    setActiveIntentCursor(proj, record, "default");
    expect(readActiveIntentCursor(proj, "default")).toBe(record);
    expect(classify()).toBe("participant");
  });

  test("a binding participates only through a trusted source or the cursor", () => {
    const record = loneRecordWithoutCursor();
    for (const source of ["create", "migration", "switch", "space-switch-cursor", "cursor", "stamp"] as const) {
      writeSessionBinding(proj, `s-${source}`, "default", record, source);
      expect(readSessionBinding(proj, `s-${source}`)?.source).toBe(source);
      expect(classify(`s-${source}`)).toBe("participant");
    }
    // Worktree and Unit-claim joins are re-checked against their evidence.
    for (const source of ["observed-create", "space-switch-lone", "unjoined", "worktree", "unit-claim"] as const) {
      writeSessionBinding(proj, `s-${source}`, "default", record, source);
      expect(classify(`s-${source}`)).toBe("outsider");
    }
    // Written before sources were recorded: trusted only with the cursor.
    writeSessionBinding(proj, "s-legacy", "default", record);
    expect(readSessionBinding(proj, "s-legacy")?.source).toBeUndefined();
    expect(classify("s-legacy")).toBe("outsider");
    setActiveIntentCursor(proj, record, "default");
    expect(classify("s-legacy")).toBe("participant");
    expect(classify("s-unjoined")).toBe("participant");
  });

  test("an unrecognised source reads as absent and a null intent never participates", () => {
    const record = loneRecordWithoutCursor();
    const sessions = join(proj, "aidlc", ".aidlc-sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "s-odd.binding.json"),
      `${JSON.stringify({ space: "default", intent: record, boundAt: new Date().toISOString(), source: "trust-me" })}\n`,
    );
    expect(readSessionBinding(proj, "s-odd")?.source).toBeUndefined();
    expect(classify("s-odd")).toBe("outsider");
    writeSessionBinding(proj, "s-null", "default", null, "unjoined");
    expect(classify("s-null")).toBe("outsider");
  });

  test("a Unit claimed on this machine names the record it participates in", () => {
    const record = loneRecordWithoutCursor();
    const uuid = listIntents(proj, "default").find((entry) => entry.dirName === record)?.uuid ?? "";
    const stamp = (intentUuid: string) => writeFileSync(unitScopePath(proj), JSON.stringify({
      version: 1, space: "default", intent_uuid: intentUuid, intent_id8: intentUuid.slice(-8), unit: "u1",
      owner: "me", generation: 1, nonce: "n", claim_ref: "r", claim_oid: "o", claimed_from_oid: "f",
      integration_ref: "i", gate_rhythm: "per-stage",
    }));
    stamp("00000000-0000-7000-8000-000000000000");
    expect(classify()).toBe("outsider");
    stamp(uuid);
    expect(classify()).toBe("participant");
  });

  test("a creation that binds its session leaves no receipt; one that cannot, leaves one", () => {
    const receipt = (dirName: string) =>
      existsSync(join(proj, "aidlc", "spaces", "default", "intents", dirName, ".aidlc-engine", "creation-receipt"));
    const bound = createIntent(proj, "bound-work", "default", "feature", undefined, "s-creator");
    expect(readSessionBinding(proj, "s-creator")).toMatchObject({ intent: bound.dirName, source: "create" });
    expect(receipt(bound.dirName)).toBe(false);
    const unbound = createIntent(proj, "unbound-work", "default", "feature");
    expect(receipt(unbound.dirName)).toBe(true);
  });

  test("usage follows the binding when an older stamp names another record", () => {
    const first = createIntent(proj, "first-work", "default", "feature");
    const second = createIntent(proj, "second-work", "default", "feature");
    writeSessionIntentUuid(proj, "s-usage", first.uuid);
    writeSessionBinding(proj, "s-usage", "default", second.dirName, "switch");
    expect(intentUsageKey(proj, "s-usage")).toBe(`intent:${second.uuid}`);
    writeSessionBinding(proj, "s-usage", "default", first.dirName, "switch");
    expect(intentUsageKey(proj, "s-usage")).toBe(`intent:${first.uuid}`);
    // Bound to no record because it stayed out: the stamp names nothing it joined.
    writeSessionBinding(proj, "s-usage", "default", null, "unjoined");
    expect(intentUsageKey(proj, "s-usage")).not.toBe(`intent:${first.uuid}`);
  });

  test("a stamp left behind after archive or an empty-space switch attributes nothing", () => {
    const left = createIntent(proj, "left-work", "default", "feature");
    for (const source of ["archive", "space-switch-none"] as const) {
      // Leaving should have cleared the stamp; this session kept it.
      writeSessionIntentUuid(proj, "s-left", left.uuid);
      writeSessionBinding(proj, "s-left", "default", null, source);
      expect(intentUsageKey(proj, "s-left")).toBe("record:default/legacy");
    }
  });

  test("worktree metadata participates only when it was written for this repository", () => {
    const record = loneRecordWithoutCursor();
    childProcess.spawnSync("git", ["init", "-q"], { cwd: proj });
    const common = realpathSync(join(proj, ".git")).replace(/\\/g, "/");
    const key = process.platform === "win32" ? common.toLowerCase() : common;
    const write = (hash: string) => {
      mkdirSync(join(proj, ".aidlc"), { recursive: true });
      writeFileSync(join(proj, ".aidlc", "worktree-meta.json"), JSON.stringify({
        version: 1, intentRecord: `aidlc/spaces/default/intents/${record}`, gitCommonDirHash: hash,
      }));
    };
    write(createHash("sha256").update("/some/other/clone/.git").digest("hex"));
    expect(classify()).toBe("outsider");
    write(createHash("sha256").update(key).digest("hex"));
    expect(classify()).toBe("participant");
  });
});
