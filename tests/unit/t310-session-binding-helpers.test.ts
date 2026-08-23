// covers: function:readSessionBinding function:writeSessionBinding function:resolveWorkflowSelection function:SessionResolutionConflictError function:validSessionId function:writeSessionPidEntry function:writeSessionPidAncestry function:resolveSessionIdFromAncestry
//
// Deterministic coverage for the per-session binding store and PID ancestry
// resolver. All writes stay under a fresh project fixture.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createIntent,
  readSessionBinding,
  resolveSessionIdFromAncestry,
  resolveWorkflowSelection,
  SessionResolutionConflictError,
  sessionPidMapDir,
  sessionsDir,
  setActiveIntentCursor,
  validSessionId,
  writeSessionBinding,
  writeSessionPidAncestry,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

let proj = "";
const originalSessionOverride = process.env.AIDLC_SESSION_OVERRIDE;

beforeEach(() => {
  delete process.env.AIDLC_SESSION_OVERRIDE;
  proj = createTestProject();
});

afterEach(() => {
  if (originalSessionOverride === undefined) {
    delete process.env.AIDLC_SESSION_OVERRIDE;
  } else {
    process.env.AIDLC_SESSION_OVERRIDE = originalSessionOverride;
  }
  cleanupTestProject(proj);
  proj = "";
});

describe("t310 session binding helpers", () => {
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

  test("the PID map is optional and missing entries preserve cursor fallback", () => {
    rmSync(sessionPidMapDir(proj), { recursive: true, force: true });
    expect(resolveSessionIdFromAncestry(proj)).toBeNull();
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
