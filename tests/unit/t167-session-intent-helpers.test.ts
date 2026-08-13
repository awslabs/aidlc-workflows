// covers: function:activeIntentUuid function:createIntent function:findIntentByUuid function:readSessionIntentUuid function:writeSessionIntentUuid function:clearSessionIntentUuid
//
// t167 — the P8 session→intent helper layer behind the resume rebind (the
// session-start hook composes these). Mechanism: none (pure in-process reads/
// writes against a seeded workspace) — they take a projectDir and touch only the
// per-user session record + the intent registry, so they're directly callable.
//
//   - writeSessionIntentUuid / readSessionIntentUuid — the per-conversation
//     stamp at aidlc/.aidlc-sessions/<session_id>. A round-trip returns the
//     stamped uuid; an unstamped session id returns null; a blank session id /
//     blank uuid is a no-op (never writes a stray file).
//   - activeIntentUuid — the uuid of the active intent (cursor / lone), or null
//     on flat-legacy (no per-intent record).
//   - findIntentByUuid — resolves a uuid to {space, slug, dirName} across EVERY
//     space, or null for an unknown uuid (a stale stamp from a deleted intent).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  activeIntentUuid,
  clearSessionIntentHandoff,
  createIntent,
  clearSessionIntentUuid,
  findIntentByUuid,
  readSessionIntentHandoff,
  readSessionIntentUuid,
  setActiveIntentCursor,
  writeSessionIntentHandoff,
  writeSessionIntentUuid,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

let proj: string;
beforeEach(() => {
  proj = createTestProject();
});
afterEach(() => {
  cleanupTestProject(proj);
});

describe("t167 session→intent helpers (mechanism none — pure in-process)", () => {
  test("writeSessionIntentUuid → readSessionIntentUuid round-trips", () => {
    writeSessionIntentUuid(proj, "S1", "uuid-abc");
    expect(readSessionIntentUuid(proj, "S1")).toBe("uuid-abc");
  });

  test("readSessionIntentUuid returns null for an unstamped session id", () => {
    expect(readSessionIntentUuid(proj, "never-stamped")).toBeNull();
  });

  test("a blank session id never writes a stray record (no-op)", () => {
    writeSessionIntentUuid(proj, "", "uuid-x");
    expect(existsSync(join(proj, "aidlc", ".aidlc-sessions"))).toBe(false);
  });

  test("a blank uuid is a no-op (does not clear/create)", () => {
    writeSessionIntentUuid(proj, "S2", "");
    expect(readSessionIntentUuid(proj, "S2")).toBeNull();
  });

  test("clearSessionIntentUuid removes an existing stamp", () => {
    writeSessionIntentUuid(proj, "S-clear", "uuid-old");
    clearSessionIntentUuid(proj, "S-clear");
    expect(readSessionIntentUuid(proj, "S-clear")).toBeNull();
  });

  test("session handoff receipts round-trip and clear independently of ownership", () => {
    writeSessionIntentUuid(proj, "S-handoff", "uuid-old");
    writeSessionIntentHandoff(proj, "S-handoff", "uuid-old", "uuid-new");
    expect(readSessionIntentHandoff(proj, "S-handoff")).toMatchObject({
      fromIntentUuid: "uuid-old",
      toIntentUuid: "uuid-new",
    });

    clearSessionIntentHandoff(proj, "S-handoff");
    expect(readSessionIntentHandoff(proj, "S-handoff")).toBeNull();
    expect(readSessionIntentUuid(proj, "S-handoff")).toBe("uuid-old");
  });

  test("activeIntentUuid returns the active (lone) intent's uuid", () => {
    const a = createIntent(proj, "auth-service", "default", "feature");
    expect(activeIntentUuid(proj, "default")).toBe(a.uuid);
  });

  test("activeIntentUuid returns null on a flat-legacy project (no record)", () => {
    expect(activeIntentUuid(proj, "default")).toBeNull();
  });

  test("activeIntentUuid follows the active-intent cursor among several", () => {
    const a = createIntent(proj, "first", "default", "feature");
    const b = createIntent(proj, "second", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    expect(activeIntentUuid(proj, "default")).toBe(a.uuid);
    setActiveIntentCursor(proj, b.dirName, "default");
    expect(activeIntentUuid(proj, "default")).toBe(b.uuid);
  });

  test("findIntentByUuid resolves a uuid to its logical and on-disk identity across spaces", () => {
    createIntent(proj, "in-default", "default", "feature");
    const t = createIntent(proj, "in-teamb", "teamB", "feature");
    const found = findIntentByUuid(proj, t.uuid);
    expect(found).not.toBeNull();
    expect(found?.space).toBe("teamB");
    expect(found?.slug).toBe("in-teamb");
    expect(found?.dirName).toBe(t.dirName);
  });

  test("findIntentByUuid returns null for an unknown uuid (stale stamp)", () => {
    createIntent(proj, "real", "default", "feature");
    expect(findIntentByUuid(proj, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  test("findIntentByUuid returns null when the registry row has no record", () => {
    const removed = createIntent(proj, "removed", "default", "feature");
    rmSync(removed.recordDir, { recursive: true, force: true });
    expect(findIntentByUuid(proj, removed.uuid)).toBeNull();
  });
});
