// covers: function:readSessionBinding function:writeSessionBinding function:resolveWorkflowSelection function:SessionResolutionConflictError function:validSessionId function:writeSessionPidEntry function:writeSessionPidAncestry function:resolveSessionIdFromAncestry function:hookChildEnv
//
// Deterministic coverage for the per-session binding store and PID ancestry
// resolver. All writes stay under a fresh project fixture.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

beforeEach(() => {
  delete process.env.AIDLC_SESSION_OVERRIDE;
  delete process.env.AIDLC_SESSION_OVERRIDE_SOURCE;
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
