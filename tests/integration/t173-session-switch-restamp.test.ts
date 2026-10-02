// covers: hook:aidlc-session-start (writeCurrentSessionId), tool:aidlc-utility handleIntent (re-stamp), tool:aidlc-utility handleSpace (re-stamp), lib:readCurrentSessionId/writeCurrentSessionId/writeSessionIntentUuid, function:writeSessionIntentHandoff, function:readSessionIntentHandoff, function:recordSessionIntentSwitch, function:NO_PRIOR_INTENT
//
// t173 — the M2 SELF-SWITCH RE-STAMP. The P8 resume rebind (t169) stamps a
// session→intent UUID keyed by session_id (which only the session-start hook
// sees) and OFFERS a rebind on resume when the stamp drifts from the live
// cursor. BUG: an in-conversation `/aidlc intent <slug>` switch moves the cursor
// via a CLI tool that has NO session_id, so the live session's stamp stays
// pointing at the OLD intent → resuming THAT SAME conversation fires a FALSE
// rebind nag ("was working X, switch back?") even though THIS conversation
// deliberately switched.
//
// FIX: the hook records the live conversation in a fixed-name `.current-session`
// marker on EVERY fire; the switch tool reads that marker and re-stamps the
// live session's record to the switched-to intent.
//   - Self-switch: the marker names THIS session, so the re-stamp follows the
//     cursor → resume of this session sees stamp == cursor → NO offer.
//   - Foreign drift: a DIFFERENT session moved the cursor (its OWN session-start
//     set the marker to itself), so the re-stamp lands on THAT session's record,
//     not ours → resuming our session still sees a genuine drift → OFFER fires.
//
// The same re-stamp leaves the one-shot handoff receipt intent creation writes
// (#1263): a switch to another intent or populated space moves the session
// inside the turn, so the Stop hook needs the receipt to let that turn end
// instead of sending the agent to drive the workflow the person only selected.
// A self-switch crosses no boundary and leaves none.
//
// WHY CLI (process-boundary, not in-process): the subjects are the shipped
// session-start HOOK (reads session_id off stdin, writes the marker + stamp) and
// the shipped aidlc-utility `intent` switch (a separate process with no
// session_id) — the cross-process marker handoff is the whole point, so this
// twin SPAWNS both real dist artifacts exactly as Claude Code drives them.
//
// SEEDING: createIntent() mints two real per-intent records in space "default"
// and moves the active-intent cursor between fires; the hook's no-state gate is
// satisfied by createIntent's header-only state stub (same pattern as t169).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  createIntent,
  readSessionIntentHandoff,
  readSessionIntentUuid,
  setActiveIntentCursor,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

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

/** Run the REAL `/aidlc intent <target>` switch via the shipped utility tool —
 *  a separate process with no session_id, exactly as the slash command runs.
 *  `verb` runs the `space` switch the same way. */
function util(p: string, target: string, verb = "intent"): { exitCode: number; stdout: string } {
  const r = Bun.spawnSync({
    cmd: [BUN, UTIL, verb, target, "--project-dir", p],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  return { exitCode: r.exitCode, stdout: new TextDecoder().decode(r.stdout).trim() };
}

describe("t173 session switch re-stamp (mechanism cli — spawned hook + real intent switch)", () => {
  test("self-switch: resume of the switching conversation does NOT nag", () => {
    // Two real intents; cursor starts on A (auth-service).
    const a = createIntent(proj, "auth-service", "default", "feature");
    const b = createIntent(proj, "export-bug", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");

    // 1) STARTUP S1: marker → S1, stamp S1 → auth-service.
    const started = fire(proj, "startup", "S1");
    expect(started.exitCode).toBe(0);
    expect(started.context).not.toContain("INTENT REBIND OFFER");

    // 2) This SAME conversation deliberately switches to B via the real tool.
    //    handleIntent reads marker (S1) and re-stamps S1 → export-bug.
    const sw = util(proj, b.slug);
    expect(sw.exitCode).toBe(0);
    expect(sw.stdout).toContain(`Active intent -> ${b.dirName}`);

    // 3) RESUME S1: stamp S1 (export-bug) == live cursor (export-bug) → NO offer.
    //    Without the fix the stamp would still read auth-service → false nag.
    const resumed = fire(proj, "resume", "S1");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).not.toContain("INTENT REBIND OFFER");
  });

  test("foreign drift: a DIFFERENT session moving the cursor still nags us", () => {
    const a = createIntent(proj, "auth-service", "default", "feature");
    const b = createIntent(proj, "export-bug", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");

    // 1) STARTUP S1: marker → S1, stamp S1 → auth-service. Our conversation.
    const s1 = fire(proj, "startup", "S1");
    expect(s1.exitCode).toBe(0);
    expect(s1.context).not.toContain("INTENT REBIND OFFER");

    // 2) A DIFFERENT conversation S2 becomes live: its OWN session-start sets the
    //    marker → S2 and stamps S2 → auth-service.
    const s2 = fire(proj, "startup", "S2");
    expect(s2.exitCode).toBe(0);

    // 3) S2 switches the cursor to B. The marker names S2, so the re-stamp lands
    //    on S2's record (S2 → export-bug) and moves the cursor — NOT on S1's.
    const sw = util(proj, b.slug);
    expect(sw.exitCode).toBe(0);
    expect(sw.stdout).toContain(`Active intent -> ${b.dirName}`);

    // 4) RESUME S1: its stamp is still auth-service; live cursor is export-bug →
    //    a GENUINE drift S1 never caused → OFFER fires, naming the way back to A.
    const resumed = fire(proj, "resume", "S1");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).toContain("INTENT REBIND OFFER");
    expect(resumed.context).toContain(`/aidlc intent ${a.dirName}`);
  });

  test("a switch to another intent or populated space leaves the Stop handoff receipt; a self-switch leaves none", () => {
    const a = createIntent(proj, "auth-service", "default", "feature");
    const b = createIntent(proj, "export-bug", "default", "feature");
    const c = createIntent(proj, "billing", "payments", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");

    // STARTUP S1: stamp S1 -> auth-service.
    expect(fire(proj, "startup", "S1").exitCode).toBe(0);

    // Selecting the intent S1 already works crosses no boundary.
    const self = util(proj, a.slug);
    expect(self.exitCode).toBe(0);
    expect(self.stdout).toContain(`Active intent -> ${a.dirName}`);
    expect(readSessionIntentHandoff(proj, "S1")).toBeNull();

    // Another intent: the receipt runs from the prior stamp to the destination.
    const sw = util(proj, b.slug);
    expect(sw.exitCode).toBe(0);
    expect(sw.stdout).toContain(`Active intent -> ${b.dirName}`);
    expect(readSessionIntentHandoff(proj, "S1")).toMatchObject({
      fromIntentUuid: a.uuid,
      toIntentUuid: b.uuid,
    });

    // A populated space: the receipt names the intent the space's cursor
    // selects, and still runs from where this turn started.
    const space = util(proj, "payments", "space");
    expect(space.exitCode).toBe(0);
    expect(space.stdout).toContain("Active space -> payments");
    expect(readSessionIntentHandoff(proj, "S1")).toMatchObject({
      fromIntentUuid: a.uuid,
      toIntentUuid: c.uuid,
      via: "switch",
    });
  });

  test("a switch away and straight back leaves no receipt, so the turn on that intent gets no free stop", () => {
    const a = createIntent(proj, "auth-service", "default", "feature");
    const b = createIntent(proj, "export-bug", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    expect(fire(proj, "startup", "S1").exitCode).toBe(0);

    expect(util(proj, b.slug).exitCode).toBe(0);
    expect(readSessionIntentHandoff(proj, "S1")).toMatchObject({ fromIntentUuid: a.uuid, toIntentUuid: b.uuid });
    expect(util(proj, a.slug).exitCode).toBe(0);
    expect(readSessionIntentHandoff(proj, "S1")).toBeNull();
  });

  test("an empty space leaves no receipt; leaving it for a space with work starts from no intent", () => {
    const a = createIntent(proj, "auth-service", "default", "feature");
    const c = createIntent(proj, "billing", "payments", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    expect(fire(proj, "startup", "S1").exitCode).toBe(0);

    expect(util(proj, "scratch", "space-create").exitCode).toBe(0);
    expect(util(proj, "scratch", "space").exitCode).toBe(0);
    expect(readSessionIntentUuid(proj, "S1")).toBeNull();
    expect(readSessionIntentHandoff(proj, "S1")).toBeNull();

    // The person types /aidlc space payments in a later turn: it only selects,
    // so the Stop hook gets a receipt even though no intent was stamped before.
    const payments = util(proj, "payments", "space");
    expect(payments.exitCode).toBe(0);
    expect(readSessionIntentHandoff(proj, "S1")).toMatchObject({ fromIntentUuid: "none", toIntentUuid: c.uuid });
  });

  test("a hop through a teammate's lone-record space keeps the receipt, so a switch back to the origin cancels it", () => {
    const a = createIntent(proj, "auth-service", "default", "feature");
    const c = createIntent(proj, "billing", "payments", "feature");
    createIntent(proj, "solo-work", "solo", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    // No cursor in the solo space: its one record is found by the lone rule,
    // which selects it without joining (no stamp).
    rmSync(join(proj, "aidlc", "spaces", "solo", "intents", "active-intent"), { force: true });
    expect(fire(proj, "startup", "S1").exitCode).toBe(0);

    expect(util(proj, "payments", "space").exitCode).toBe(0);
    expect(readSessionIntentHandoff(proj, "S1")).toMatchObject({ fromIntentUuid: a.uuid, toIntentUuid: c.uuid });
    expect(util(proj, "solo", "space").exitCode).toBe(0);
    expect(readSessionIntentUuid(proj, "S1")).toBeNull();
    expect(readSessionIntentHandoff(proj, "S1")).toMatchObject({ fromIntentUuid: a.uuid, toIntentUuid: c.uuid });
    // Back where the turn started: no boundary crossed, so no free stop.
    expect(util(proj, "default", "space").exitCode).toBe(0);
    expect(readSessionIntentHandoff(proj, "S1")).toBeNull();
  });

  test("a hop through an empty space spends the earlier receipt, so a return to the origin still only selects", () => {
    const a = createIntent(proj, "auth-service", "default", "feature");
    const c = createIntent(proj, "billing", "payments", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    expect(fire(proj, "startup", "S1").exitCode).toBe(0);

    expect(util(proj, "payments", "space").exitCode).toBe(0);
    expect(readSessionIntentHandoff(proj, "S1")).toMatchObject({ fromIntentUuid: a.uuid, toIntentUuid: c.uuid });
    expect(util(proj, "scratch", "space-create").exitCode).toBe(0);
    expect(util(proj, "scratch", "space").exitCode).toBe(0);
    expect(readSessionIntentHandoff(proj, "S1")).toBeNull();

    // Back to the origin's space within the receipt window: still a selection,
    // with its own receipt, not a chain that cancels itself.
    expect(util(proj, "default", "space").exitCode).toBe(0);
    expect(readSessionIntentHandoff(proj, "S1")).toMatchObject({ fromIntentUuid: "none", toIntentUuid: a.uuid });
  });
});
