// covers: hook:aidlc-session-start (writeCurrentSessionId), tool:aidlc-utility handleIntent (re-stamp), lib:readCurrentSessionId/writeCurrentSessionId/writeSessionIntentUuid
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
// WHY CLI (process-boundary, not in-process): the subjects are the shipped
// session-start HOOK (reads session_id off stdin, writes the marker + stamp) and
// the shipped aidlc-utility `intent` switch (a separate process with no
// session_id) — the cross-process marker handoff is the whole point, so this
// twin SPAWNS both real dist artifacts exactly as Claude Code drives them.
//
// SEEDING: birthIntent() mints two real per-intent records in space "default"
// and moves the active-intent cursor between fires; the hook's no-state gate is
// satisfied by birthIntent's header-only state stub (same pattern as t169).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  birthIntent,
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
 *  a separate process with no session_id, exactly as the slash command runs. */
function util(p: string, target: string): { exitCode: number; stdout: string } {
  const r = Bun.spawnSync({
    cmd: [BUN, UTIL, "intent", target, "--project-dir", p],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  return { exitCode: r.exitCode, stdout: new TextDecoder().decode(r.stdout).trim() };
}

describe("t173 session switch re-stamp (mechanism cli — spawned hook + real intent switch)", () => {
  test("self-switch: resume of the switching conversation does NOT nag", () => {
    // Two real intents; cursor starts on A (auth-service).
    const a = birthIntent(proj, "auth-service", "default", "feature");
    const b = birthIntent(proj, "export-bug", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");

    // 1) STARTUP S1: marker → S1, stamp S1 → auth-service.
    const started = fire(proj, "startup", "S1");
    expect(started.exitCode).toBe(0);
    expect(started.context).not.toContain("INTENT REBIND OFFER");

    // 2) This SAME conversation deliberately switches to B via the real tool.
    //    handleIntent reads marker (S1) and re-stamps S1 → export-bug.
    const sw = util(proj, b.slug);
    expect(sw.exitCode).toBe(0);
    expect(sw.stdout).toContain(`Active intent → ${b.dirName}`);

    // 3) RESUME S1: stamp S1 (export-bug) == live cursor (export-bug) → NO offer.
    //    Without the fix the stamp would still read auth-service → false nag.
    const resumed = fire(proj, "resume", "S1");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).not.toContain("INTENT REBIND OFFER");
  });

  test("foreign drift: a DIFFERENT session moving the cursor still nags us", () => {
    const a = birthIntent(proj, "auth-service", "default", "feature");
    const b = birthIntent(proj, "export-bug", "default", "feature");
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
    expect(sw.stdout).toContain(`Active intent → ${b.dirName}`);

    // 4) RESUME S1: its stamp is still auth-service; live cursor is export-bug →
    //    a GENUINE drift S1 never caused → OFFER fires, naming the way back to A.
    const resumed = fire(proj, "resume", "S1");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.context).toContain("INTENT REBIND OFFER");
    expect(resumed.context).toContain(`/aidlc intent ${a.slug}`);
  });
});
