// covers: subcommand:aidlc-utility:intent-birth, subcommand:aidlc-utility:space-create, subcommand:aidlc-utility:space, file:skills/aidlc/SKILL.md
//
// t-acp-kiro-journey-workspace.serial.test.ts — the LIVE workspace journey,
// Kiro-ACP logic half (P10 / Stage E). Proves the SAME composed §0 promise the
// SDK + Codex legs prove (one feature spanning two repos · per-repo codekb · a
// 2nd intent alongside active A · a non-default space switch + birth there + no
// collision · switch back), expressed in the ACP driver's NATIVE turn shape: a
// SEQUENCE of single-turn driveKiroAcp invocations against one shared on-disk
// workspace root, each bounded by stopAfterToolTitle at a tool boundary.
//
// The assertable surfaces are the verbatim tool output (tool_call_update text) +
// the on-disk record state read straight off the workspace root. NEVER the prose,
// and NEVER the inferred scope (the conductor infers a new intent's scope from the
// new-work text — non-deterministic; the invariants below do not depend on it).
//
// TWO conducting techniques, by surface design (both live-verified on this branch,
// kiro-cli 2.7.0):
//
//   * Beats 1-3 drive through the PRODUCTION `aidlc` conductor. Beat 3 (birth a
//     2nd intent alongside active A) is the conductor's AUTHORIZED offer→confirm
//     routing (SKILL.md § "New work while an intent is active": on a genuine
//     new-work prose it renders an offer, and on the human's "Yes" it runs
//     `intent-birth` DIRECTLY — "the same run-then-continue shape the print
//     directive already uses"). That does NOT fight the forwarding override in
//     agents/aidlc.json, so the production conductor births the 2nd intent over a
//     keepAlive multi-turn ACP session: turn 1 auto-births A, turn 2 (new-work)
//     stops at the offer's compare-read (`intent --json`), turn 3 (confirm) stops
//     at the birth. Live-verified: turn 3 ran `intent-birth` directly; A's state
//     was byte-unchanged.
//
//   * Beats 4-5 (space-create teamB · switch · birth into teamB · switch back) are
//     driven through the `aidlc-developer-agent` (a delegation target), NOT the
//     production `aidlc` conductor — DELIBERATE, documented, not a workaround for
//     tidiness. Unlike beat 3's offer→confirm, the `space`/`space-create` verbs
//     have NO authorized conductor routing path: the engine's `next` does not parse
//     or route them (verified — parseNextFlags aidlc-orchestrate.ts:249 has no
//     space branch, and the Branch ladder has none; `space-create teamB` falls into
//     freeform intent words → with active A, Branch 10 advances A instead, the
//     Codex leg's spaceSwitchPrompt comment documents the same failure). And the
//     production `aidlc` agent's prompt hard-wires "The engine binary
//     aidlc-orchestrate.ts is the ONLY authority on the next move … never re-derive
//     routing", so naming the space tool to it routes to `next` (a verified probe:
//     the agent's first tool call was `next`, never the space verb). So there is no
//     single ACP turn through the production conductor that runs a space verb. The
//     `aidlc-developer-agent` IS the drivable surface: its config carries
//     `execute_bash` with allowedCommands `bun \.kiro/tools/.*` (so the space verbs
//     are permitted) and its persona file lacks the forwarding override, so it just
//     runs the exact command it is given and stops. Live-verified: each beat-4/5
//     turn's first AND only tool call was the named space/birth command; zero
//     `next`. This proves the ACP SURFACE carries the space-switch + isolated-birth
//     mutations live; the production conductor's offer→confirm half is exercised by
//     beat 3 above and by the SDK + Codex legs.
//
// (There is NO Kiro-TUI leg for these beats — Kiro ships no statusline, so the
// render-half matrix is Claude only for the statusline surface; the
// multi-repo/intent/space composition is a logic-half concern proven here.)
//
// SPENDS Kiro credits — gated AIDLC_KIRO_ACP_LIVE=1; skip-with-reason when unset
// OR kiro-cli is absent/unauthenticated. Serial: one live ACP session at a time.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeSpace,
  listIntents,
  readIntentRegistry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupWorkspaceJourney,
  setupWorkspaceJourney,
} from "../harness/fixtures.ts";
import { AcpSession, driveKiroAcp } from "../harness/kiro-acp-drive.ts";
import { KIRO_SRC } from "../harness/tui-fixtures.ts";

// A multi-turn live journey (heaviest e2e). On ACP the forwarding loop runs
// IN-TURN once a workflow is active (kiro-acp-drive.ts:354-359), so the per-repo
// reverse-engineering codekb beat (9 artifacts × 2 repos) keeps executing inside
// one turn for many minutes — the longest single turn in the suite. Budget the
// whole journey at 3600s, give the cheap verb turns a modest cap, and the codekb
// turn the lion's share.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "3600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 3600) * 1000;
const VERB_DRIVE_MS = 300_000;
const CODEKB_DRIVE_MS = Math.max(1_200_000, TEST_TIMEOUT_MS - 7 * VERB_DRIVE_MS);

// The user types "teamB"; the engine slugifies it on disk (slugify lowercases —
// aidlc-lib.ts), so the SPACE DIR + cursor + registry key are "teamb".
const TEAM_B_SLUG = "teamb";

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro ACP workspace journey (uses Kiro credits)";
  }
  if (spawnSync("kiro-cli", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not found";
  }
  if (spawnSync("kiro-cli", ["whoami"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

// Count the per-repo codekb artifacts the RE stage wrote, tolerant of WHERE the
// stage chose to anchor the store. The stage prose authoritatively targets the
// workspace-root store `aidlc/codekb/<repo>/` (reverse-engineering.md:111), but the
// live LLM occasionally writes to the SPACE-scoped sibling
// `aidlc/spaces/<space>/codekb/<repo>/` instead (the same path family — codekb is a
// space-level sibling of intents per the vision). Either location is a valid
// per-repo codekb store for this beat's promise ("per-repo multi-repo codekb"), so
// accept BOTH; only the absence of any per-repo store is a real failure.
function codekbFiles(root: string, repo: string): string[] {
  const candidates = [
    join(root, "aidlc", "codekb", repo),
    join(root, "aidlc", "spaces", activeSpace(root), "codekb", repo),
  ];
  for (const dir of candidates) {
    try {
      const md = readdirSync(dir).filter((f) => f.endsWith(".md"));
      if (md.length > 0) return md;
    } catch {
      /* try the next candidate */
    }
  }
  return [];
}

function activeRecordDir(root: string): string | undefined {
  return listIntents(root, activeSpace(root)).find((i) => i.active)?.dirName ?? undefined;
}

/** Drive the reverse-engineering `--single` codekb turn and cancel it the moment
 *  BOTH repos' per-repo codekb has landed on disk — a DISK-CONDITION stop, not a
 *  tool-title one. A title stop (`/codekb/repo-b/…/`) is unreliable here: the
 *  conductor writes the two repos in a NON-deterministic order and runs a per-repo
 *  verify (`cd …/codekb/<repo>`) right after EACH repo, so a `codekb/repo-X` title
 *  can fire after only ONE repo's artifacts exist — leaving the other repo's
 *  codekbFiles() at 0 (live-observed flake: repo-b verified + stopped before repo-a
 *  was ever written). On ACP the conductor's IN-TURN forwarding loop also does NOT
 *  voluntarily end after the stage work (kiro-acp-drive.ts hazard), so we cannot
 *  just await a natural turn-end. Instead: own the session, poll the workspace for
 *  both repos' codekb (tolerant of the root OR space-scoped store — see
 *  codekbFiles), and `session/cancel` once both are present. The driver's awaited
 *  session/prompt then resolves with stopReason=cancelled. Falls through on the
 *  drive's own timeout (the budget) if the stage never produces both stores — a
 *  real failure the assertions below catch. */
async function driveCodekbUntilBothRepos(
  session: AcpSession,
  root: string,
  timeoutMs: number,
): Promise<void> {
  let bothPresent = false;
  const poll = setInterval(() => {
    if (
      !bothPresent &&
      session.sessionId &&
      codekbFiles(root, "repo-a").length > 0 &&
      codekbFiles(root, "repo-b").length > 0
    ) {
      bothPresent = true;
      session.notify("session/cancel", { sessionId: session.sessionId });
    }
  }, 2000);
  try {
    await driveKiroAcp({
      projectDir: root,
      session,
      prompt: `/aidlc --stage reverse-engineering --single`,
      timeoutMs,
      keepAlive: true,
    });
  } finally {
    clearInterval(poll);
  }
}

/** Count WORKFLOW_STARTED events in a record's audit shards — exactly one for an
 *  intent's own birth; a SECOND means a foreign birth bled in (the collision the
 *  vision forbids). Per-session SessionStart/End hooks append SESSION_* events to
 *  the active intent, so raw shard bytes are not stable across turns; this count
 *  is the stable collision signal (see the SDK leg's note). */
function workflowStartedCount(recordDir: string): number {
  let n = 0;
  try {
    for (const f of readdirSync(join(recordDir, "audit"))) {
      if (!f.endsWith(".md")) continue;
      const body = readFileSync(join(recordDir, "audit", f), "utf-8");
      n += (body.match(/^\*\*Event\*\*:\s*WORKFLOW_STARTED\s*$/gm) ?? []).length;
    }
  } catch {
    /* no audit dir → 0 */
  }
  return n;
}

/** Drive ONE deterministic workspace verb through the `aidlc-developer-agent`
 *  (Approach C): the delegation target lacks the production conductor's forwarding
 *  override, so it runs the EXACT command it is handed and stops at the verb's tool
 *  boundary. The vehicle for beats 4-5 (the space verbs the production conductor
 *  cannot route — see the header). The named tool's verbatim output is captured
 *  before the stopAfterToolTitle cancel fires; the on-disk assertions are the proof. */
async function driveDevVerb(root: string, verbArgs: string, stop: RegExp): Promise<void> {
  await driveKiroAcp({
    projectDir: root,
    agent: "aidlc-developer-agent",
    prompt: `Run this exact shell command and then stop: bun .kiro/tools/aidlc-utility.ts ${verbArgs}`,
    timeoutMs: VERB_DRIVE_MS,
    stopAfterToolTitle: stop,
  });
}

describe("t-acp-kiro-journey-workspace (live ACP multi-repo·intent·space journey)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `one feature spanning two repos, per-repo codekb, a 2nd intent, a non-default space — composed live over ACP${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const journey = setupWorkspaceJourney("kiro");
      const root = journey.root;
      // Beats 1-2 share ONE live `aidlc`-conductor ACP session (keepAlive). Beat 3
      // opens a FRESH `aidlc` session (`offer`) — DELIBERATE: beat 2's RE `--single`
      // run is cancelled mid-gate by stopAfterToolTitle (the conductor's IN-TURN
      // forwarding loop never voluntarily ends), which leaves THAT session "inside"
      // the RE stage; reusing it for beat 3 made the conductor resume the RE gate
      // (learnings ritual + memory.md edit) instead of parsing the new-work prose,
      // so `intent --json` never ran and the turn overran (live-verified). A fresh
      // session reads the workspace clean off disk (A active, RE'd), recognises the
      // new-work prose, and renders the offer. Beats 4-5 spawn their own
      // `aidlc-developer-agent` sessions (the ACP agent is fixed at process spawn —
      // driveDevVerb opens a fresh one each).
      const conductor = new AcpSession(root, "aidlc", true);
      const offer = new AcpSession(root, "aidlc", true);
      try {
        // --- Beat 1: auto-birth A spanning both siblings ---------------------
        // Name the scope explicitly: a bare prose `/aidlc "<desc>"` emits an `ask`
        // scope-confirm (orchestrate Branch 8) that the SINGLE-TURN ACP driver
        // cannot answer (it renders as prose, not a protocol gate) — so the turn
        // would end before birth. `--scope feature` births via Branch 9a with no
        // gate; the repo span is still captured by sibling auto-discovery.
        const r1 = await driveKiroAcp({
          projectDir: root,
          session: conductor,
          prompt: `/aidlc --scope feature "build auth across both repos"`,
          timeoutMs: VERB_DRIVE_MS,
          stopAfterToolTitle: /aidlc-utility\.ts intent-birth/,
          keepAlive: true,
        });
        const out1 = r1.toolCalls
          .filter((t) => t.title.includes("aidlc-utility.ts intent-birth"))
          .map((t) => t.output.join(""))
          .join("");
        expect(out1).toContain("State initialized:");

        const reg1 = readIntentRegistry(root);
        expect(reg1.length).toBe(1);
        expect(reg1[0].repos).toEqual(["repo-a", "repo-b"]);
        expect(reg1[0].uuid).toMatch(UUIDV7_RE);
        expect(reg1[0].status).toBe("in-flight");
        const recordA = activeRecordDir(root);
        expect(recordA).toBeDefined();
        const recordADir = join(root, "aidlc", "spaces", "default", "intents", recordA as string);

        // --- Beat 2: per-repo codekb for both siblings (cheaper variant) ------
        // The RE stage writes both repos' codekb. Drive it and cancel the moment
        // BOTH repos' stores are on disk (a disk-condition stop — see
        // driveCodekbUntilBothRepos for why a tool-title stop flakes here). The
        // on-disk assertions below are the proof.
        await driveCodekbUntilBothRepos(conductor, root, CODEKB_DRIVE_MS);
        expect(codekbFiles(root, "repo-a").length).toBeGreaterThan(0);
        expect(codekbFiles(root, "repo-b").length).toBeGreaterThan(0);

        // A's birth emitted exactly one WORKFLOW_STARTED; the RE pass added stage
        // work but no second birth bled into A's shard.
        expect(workflowStartedCount(recordADir)).toBe(1);
        // Snapshot A's workflow state AFTER the RE pass settles — beats 3-5 must
        // leave THIS byte-identical (no foreign birth/space switch bleeds into A).
        const stateABefore = readFileSync(join(recordADir, "aidlc-state.md"), "utf-8");

        // --- Beat 3: a SECOND isolated intent alongside A, via the conductor's
        //     AUTHORIZED offer→confirm routing (the production flow) -----------
        // On the FRESH `offer` session (see above). Turn 3a: genuine new-work prose.
        // The conductor reads the active intent (it may first emit a Branch-10
        // run-stage for A and read its stage file), recognises the topic change, and
        // runs `intent --json` to compare against the active intent (the offer's
        // compare-read, SKILL.md), then renders the offer as numbered prose. Stop at
        // the compare-read — the dependable offer-render boundary (spike-verified).
        await driveKiroAcp({
          projectDir: root,
          session: offer,
          prompt:
            "a completely separate, unrelated standalone metrics dashboard — a brand " +
            "new project, nothing to do with the auth work",
          timeoutMs: VERB_DRIVE_MS,
          stopAfterToolTitle: /aidlc-utility\.ts intent --json/,
          keepAlive: true,
        });
        // Turn 3b: confirm. The conductor runs `intent-birth` DIRECTLY (the
        // SKILL.md "On CONFIRM: run intent-birth" prose — authorized routing, so it
        // does not fight the forwarding override). The inferred scope is
        // non-deterministic; we assert ONLY the registry shape and A's integrity.
        await driveKiroAcp({
          projectDir: root,
          session: offer,
          prompt: "Yes — start a second intent for the metrics dashboard.",
          timeoutMs: VERB_DRIVE_MS,
          stopAfterToolTitle: /aidlc-utility\.ts intent-birth/,
          keepAlive: true,
        });
        const reg3 = readIntentRegistry(root);
        expect(reg3.length).toBe(2);
        expect(new Set(reg3.map((e) => e.uuid)).size).toBe(2);
        for (const e of reg3) expect(e.uuid).toMatch(UUIDV7_RE);
        // A's workflow state untouched + B's birth did not bleed into A's shard.
        expect(readFileSync(join(recordADir, "aidlc-state.md"), "utf-8")).toBe(stateABefore);
        expect(workflowStartedCount(recordADir)).toBe(1);

        // --- Beat 4: non-default space — create, switch, birth there; no leak --
        // Through the developer agent (the space verbs aren't conductor-routable —
        // see the header). 4a: create teamB; assert org.md byte-copied from default,
        // fresh empty team/project stubs, knowledge/ ABSENT at create time.
        await driveDevVerb(root, "space-create teamB", /aidlc-utility\.ts space-create/);
        const teamBMemory = join(root, "aidlc", "spaces", TEAM_B_SLUG, "memory");
        const defaultOrg = readFileSync(
          join(root, "aidlc", "spaces", "default", "memory", "org.md"),
          "utf-8",
        );
        expect(readFileSync(join(teamBMemory, "org.md"), "utf-8")).toBe(defaultOrg);
        expect(readFileSync(join(teamBMemory, "team.md"), "utf-8")).toBe("# Team practices\n");
        expect(readFileSync(join(teamBMemory, "project.md"), "utf-8")).toBe("# Project overrides\n");
        expect(existsSync(join(root, "aidlc", "spaces", TEAM_B_SLUG, "knowledge"))).toBe(false);

        // 4b: switch to teamB.
        await driveDevVerb(root, "space teamB", /aidlc-utility\.ts space teamB/);
        expect(activeSpace(root)).toBe(TEAM_B_SLUG);

        // 4c: birth into teamB — knowledge/ now PRESENT (lazy ensure on first birth);
        // teamB holds its 1 intent, default still holds its 2 (no cross-space leak).
        await driveDevVerb(
          root,
          'intent-birth --scope poc --arguments "teamB onboarding flow"',
          /aidlc-utility\.ts intent-birth/,
        );
        expect(listIntents(root, TEAM_B_SLUG).length).toBe(1);
        expect(listIntents(root, "default").length).toBe(2);
        expect(existsSync(join(root, "aidlc", "spaces", TEAM_B_SLUG, "knowledge"))).toBe(true);

        // --- Beat 5: back to default; A still resumable ----------------------
        await driveDevVerb(root, "space default", /aidlc-utility\.ts space default/);
        expect(activeSpace(root)).toBe("default");
        // A's workflow state survived the round trip; no foreign birth bled in.
        expect(readFileSync(join(recordADir, "aidlc-state.md"), "utf-8")).toBe(stateABefore);
        expect(workflowStartedCount(recordADir)).toBe(1);
        expect(listIntents(root, "default").length).toBe(2);
      } finally {
        conductor.close();
        offer.close();
        cleanupWorkspaceJourney(journey);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
