// covers: function:readSessionBinding function:writeSessionBinding function:resolveWorkflowSelection function:SessionResolutionConflictError function:validSessionId function:writeSessionPidEntry function:writeSessionPidAncestry function:resolveSessionIdFromAncestry function:hookChildEnv
//
// Deterministic coverage for the per-session binding store and PID ancestry
// resolver. All writes stay under a fresh project fixture.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditFilePath,
  createIntent,
  docsRoot,
  hookChildEnv,
  readSessionBinding,
  resolveSessionIdFromAncestry,
  resolveWorkflowSelection,
  SessionResolutionConflictError,
  sessionPidMapDir,
  sessionsDir,
  setActiveIntentCursor,
  setActiveSpaceCursor,
  stateFilePath,
  validSessionId,
  writeSessionBinding,
  writeSessionPidAncestry,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

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
    writeSessionPidEntry(proj, process.ppid, "session-a");
    process.env.AIDLC_SESSION_OVERRIDE = "session-b";

    expect(() => resolveWorkflowSelection(proj)).toThrow(
      SessionResolutionConflictError,
    );
    expect(
      resolveWorkflowSelection(proj, { sessionId: "session-b" }).intent,
    ).toBe(second.dirName);
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

    writeSessionPidEntry(proj, process.ppid, "payload-session");
    const matching = hookChildEnv(proj, "payload-session");
    expect(matching.AIDLC_SESSION_OVERRIDE).toBe("payload-session");
    expect(matching.AIDLC_SESSION_OVERRIDE_SOURCE).toBeUndefined();

    const divergent = hookChildEnv(proj, "different-session");
    expect(divergent.AIDLC_SESSION_OVERRIDE).toBe("different-session");
    expect(divergent.AIDLC_SESSION_OVERRIDE_SOURCE).toBe("payload");
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
