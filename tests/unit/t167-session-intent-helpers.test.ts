// covers: function:activeIntentUuid function:findIntentByUuid function:readSessionIntentUuid function:writeSessionIntentUuid
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
//   - findIntentByUuid — resolves a uuid to {space, slug} across EVERY space, or
//     null for an unknown uuid (a stale stamp from a deleted intent).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  activeIntentUuid,
  birthIntent,
  findIntentByUuid,
  readSessionIntentUuid,
  setActiveIntentCursor,
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

  test("activeIntentUuid returns the active (lone) intent's uuid", () => {
    const a = birthIntent(proj, "auth-service", "default", "feature");
    expect(activeIntentUuid(proj, "default")).toBe(a.uuid);
  });

  test("activeIntentUuid returns null on a flat-legacy project (no record)", () => {
    expect(activeIntentUuid(proj, "default")).toBeNull();
  });

  test("activeIntentUuid follows the active-intent cursor among several", () => {
    const a = birthIntent(proj, "first", "default", "feature");
    const b = birthIntent(proj, "second", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    expect(activeIntentUuid(proj, "default")).toBe(a.uuid);
    setActiveIntentCursor(proj, b.dirName, "default");
    expect(activeIntentUuid(proj, "default")).toBe(b.uuid);
  });

  test("findIntentByUuid resolves a uuid to {space, slug} across spaces", () => {
    birthIntent(proj, "in-default", "default", "feature");
    const t = birthIntent(proj, "in-teamb", "teamB", "feature");
    const found = findIntentByUuid(proj, t.uuid);
    expect(found).not.toBeNull();
    expect(found?.space).toBe("teamB");
    expect(found?.slug).toBe("in-teamb");
  });

  test("findIntentByUuid returns null for an unknown uuid (stale stamp)", () => {
    birthIntent(proj, "real", "default", "feature");
    expect(findIntentByUuid(proj, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
