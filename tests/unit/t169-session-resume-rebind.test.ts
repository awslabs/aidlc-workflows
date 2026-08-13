// covers: hook:aidlc-session-start
//
// t169 — the P8 RESUME REBIND. A conversation works ONE intent, but the
// active-intent CURSOR is durable + shared across sessions. So resuming an
// A-chat after the cursor moved to B would silently inject B's context (vision
// §3, the central multi-space hazard). The fix is a per-session→intent stamp at
// aidlc/.aidlc-sessions/<session_id>:
//   - On a STARTED-class event, session-start STAMPS the working intent's UUID
//     keyed by session_id.
//   - On RESUMED, if the stamped UUID differs from the live cursor AND still
//     names a real intent, it injects a rebind OFFER in additionalContext — a
//     print directive that CORRECTS the per-user cursor (it never rebuilds the
//     session). On a MATCH (cursor unchanged), no offer.
//
// WHY CLI (process-boundary, not in-process): the SUBJECT is the session-start
// hook. It reads source + session_id off the PostToolUse-shaped stdin JSON,
// stamps/reads the session record, and writes additionalContext to stdout —
// none reachable by importing a function. So this twin SPAWNS the real shipped
// hook the same way Claude Code's SessionStart drives it (same pattern as t10).
//
// SEEDING: createIntent() (aidlc-lib.ts) mints two real per-intent records in
// space "default" and sets the active-intent cursor; setActiveIntentCursor()
// moves the cursor between the START fire and the RESUME fire to simulate the
// drift. The hook gates on stateFilePath existing, which createIntent satisfies
// (it writes a header-only state stub bound to the active cursor).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createIntent,
  intentsRegistryPath,
  readIntentRegistry,
  readSessionIntentUuid,
  setActiveIntentCursor,
  setActiveSpaceCursor,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");

let proj: string;
beforeEach(() => {
  proj = createTestProject();
});
afterEach(() => {
  cleanupTestProject(proj);
});

interface FireResult {
  exitCode: number;
  context: string;
}

/** Fire the real session-start hook with a source + session_id payload; return
 *  exit code + the decoded additionalContext (the hook's only stdout write). */
function fire(p: string, source: string, sessionId: string): FireResult {
  const r = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(JSON.stringify({ source, session_id: sessionId })),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
  });
  const stdout = new TextDecoder().decode(r.stdout).trim();
  let context = "";
  try {
    context = (JSON.parse(stdout).additionalContext as string) ?? "";
  } catch {
    /* leave context empty on a non-JSON stdout */
  }
  return { exitCode: r.exitCode, context };
}

describe("t169 session-start resume rebind (mechanism cli — spawned hook + cursor drift)", () => {
  test("startup stamps the working intent; resume after a cursor move OFFERS a rebind", () => {
    // Two real intents in the default space. createIntent leaves the cursor on
    // the LAST born (export-bug). Move it to auth-service so the conversation
    // starts bound to auth-service.
    const a = createIntent(proj, "auth-service", "default", "feature");
    const b = createIntent(proj, "export-bug", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default"); // cursor → auth-service

    // 1) STARTUP: this conversation (session "S1") stamps auth-service's uuid.
    const started = fire(proj, "startup", "S1");
    expect(started.exitCode).toBe(0);
    expect(started.context).not.toContain("INTENT REBIND OFFER");

    // The cursor drifts to export-bug (a switch in another conversation).
    setActiveIntentCursor(proj, b.dirName, "default");

    // 2) RESUME S1: stamped auth-service ≠ live export-bug → OFFER.
    const resumed = fire(proj, "resume", "S1");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).toContain("INTENT REBIND OFFER");
    expect(resumed.context).toContain("was working auth-service");
    expect(resumed.context).toContain("active intent is export-bug");
    // The offer names the cursor-correction command, not a session rebuild.
    expect(resumed.context).toContain("/aidlc intent auth-service");
    expect(resumed.context).toContain("never rebuilds the conversation");
    // Until the user accepts the offered switch, a decline continues on the
    // live intent and usage must not remain stamped to the old workflow.
    expect(readSessionIntentUuid(proj, "S1")).toBe(b.uuid);
  });

  test("resume with the cursor UNCHANGED offers nothing (no false positive)", () => {
    const a = createIntent(proj, "billing", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    // Startup stamps billing; cursor stays on billing.
    fire(proj, "startup", "S2");
    const resumed = fire(proj, "resume", "S2");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).not.toContain("INTENT REBIND OFFER");
  });

  test("cross-space rebind emits two sequential skill invocations", () => {
    const a = createIntent(proj, "billing", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    setActiveSpaceCursor(proj, "default");
    fire(proj, "startup", "S-CROSS");

    const b = createIntent(proj, "search", "team-b", "feature");
    setActiveIntentCursor(proj, b.dirName, "team-b");
    setActiveSpaceCursor(proj, "team-b");

    const resumed = fire(proj, "resume", "S-CROSS");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).toContain("first run `/aidlc space default`");
    expect(resumed.context).toContain(
      "after it completes, run `/aidlc intent billing`",
    );
    expect(resumed.context).not.toContain("&&");
  });

  test("resume with NO prior stamp (fresh session id) offers nothing", () => {
    const a = createIntent(proj, "search", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    // A resume for a session that never fired startup here → no stamp → no offer.
    const resumed = fire(proj, "resume", "NEVER-STAMPED");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).not.toContain("INTENT REBIND OFFER");
    expect(readSessionIntentUuid(proj, "NEVER-STAMPED")).toBe(a.uuid);
  });

  test("flat-legacy project (no per-intent record) never offers a rebind", () => {
    // No birth — the project is flat-legacy (activeIntentUuid → null). Seed a
    // flat state file so the hook passes its no-state gate, then fire resume.
    mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
    writeFileSync(
      join(proj, "aidlc-docs", "aidlc-state.md"),
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n",
      "utf-8",
    );
    fire(proj, "startup", "S3"); // no uuid to stamp (flat-legacy)
    const resumed = fire(proj, "resume", "S3");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).not.toContain("INTENT REBIND OFFER");
  });

  test("resume onto a UUID-less orphan clears the prior workflow stamp", () => {
    const old = createIntent(proj, "registered-work", "default", "feature");
    setActiveIntentCursor(proj, old.dirName, "default");
    fire(proj, "startup", "S4");
    expect(readSessionIntentUuid(proj, "S4")).toBe(old.uuid);

    // Keep the old intent registered so the hook can offer a rebind, but move
    // the live cursor to an orphan record whose registry row no longer exists.
    const orphan = createIntent(proj, "orphan-work", "orphan-space", "feature");
    setActiveIntentCursor(proj, orphan.dirName, "orphan-space");
    setActiveSpaceCursor(proj, "orphan-space");
    rmSync(intentsRegistryPath(proj, "orphan-space"));

    const resumed = fire(proj, "resume", "S4");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).toContain("INTENT REBIND OFFER");
    expect(resumed.context).toContain("active intent is (none)");
    expect(readSessionIntentUuid(proj, "S4")).toBeNull();
  });

  test("resume after the prior intent was deleted restamps the live workflow", () => {
    const old = createIntent(proj, "deleted-work", "default", "feature");
    setActiveIntentCursor(proj, old.dirName, "default");
    fire(proj, "startup", "S5");

    const live = createIntent(proj, "live-work", "default", "feature");
    const registry = readIntentRegistry(proj, "default")
      .filter((entry) => entry.uuid !== old.uuid);
    writeFileSync(
      intentsRegistryPath(proj, "default"),
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    rmSync(
      join(proj, "aidlc", "spaces", "default", "intents", old.dirName),
      { recursive: true },
    );

    const resumed = fire(proj, "resume", "S5");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).not.toContain("INTENT REBIND OFFER");
    expect(readSessionIntentUuid(proj, "S5")).toBe(live.uuid);
  });
});
