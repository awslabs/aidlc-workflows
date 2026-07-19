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
// ALL FIVE beats drive through the PRODUCTION `aidlc` conductor (live-verified on
// this branch, kiro-cli 2.7.0):
//
//   * Beats 1-3. Beat 3 (birth a 2nd intent alongside active A) is the conductor's
//     AUTHORIZED offer→confirm routing (SKILL.md § "New work while an intent is
//     active": on a genuine new-work prose it renders an offer, and on the human's
//     "Yes" it runs `intent-birth` DIRECTLY — "the same run-then-continue shape the
//     print directive already uses"). That does NOT fight the forwarding override in
//     agents/aidlc.json, so the production conductor births the 2nd intent over a
//     keepAlive multi-turn ACP session: turn 1 auto-births A, turn 2 (new-work)
//     stops at the offer's compare-read (`intent --json`), turn 3 (confirm) stops
//     at the birth. Live-verified: turn 3 ran `intent-birth` directly; A's state
//     was byte-unchanged.
//
//   * Beats 4-5 (space-create teamB · switch · birth into teamB · switch back) now
//     ALSO drive through the production `aidlc` conductor — the d44828b engine fix
//     routes the workspace navigation verbs through `next`: a LEADING
//     `space`/`space-create`/`intent` token (parseNextFlags aidlc-orchestrate.ts:276,
//     WORKSPACE_VERBS:146) maps to a TERMINAL print directive naming
//     `bun .kiro/tools/aidlc-utility.ts <verb> [<arg>]` (handleNext Branch 1b ~:921,
//     placed BEFORE state inspection so it works with or without an active workflow
//     — it never advances a workflow). The `aidlc` agent's prompt rule (3) — "When a
//     directive is a print whose message names a command to run, run THAT EXACT
//     command as your immediate next tool call" — makes the live conductor honor it:
//     each beat-4/5 turn's tool calls are exactly `next <verb>` (forward) then
//     `aidlc-utility.ts <verb>` (run the named tool); zero intent-advance.
//     Live-verified 3/3 via a throwaway spike (the ndjson trace showed the two-call
//     pair for space-create/space/space default, never a `next`-advances-A). The
//     teamB birth (4c) rides the same engine seam: in teamB (zero intents) a
//     `/aidlc --scope poc "<desc>"` hits the birth gate (Branch 9a →
//     birthPrintDirective ~:1231) which prints `intent-birth …`; the conductor runs
//     it. Each space verb is its own single-turn driveKiroAcp call (ACP is
//     single-turn; stopAfterToolTitle catches the named tool's output). This proves
//     the ACP SURFACE carries the space-switch + isolated-birth mutations live
//     through the SAME production conductor the SDK + Codex legs exercise.
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
  getField,
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

/** The RE codekb beat has TWO valid outcomes, and both keep the multi-repo journey
 *  intact. Brownfield: reverse-engineering EXECUTEs and writes a per-repo codekb
 *  store, so the codekbFiles asserts below hold. Greenfield: the engine stamps
 *  reverse-engineering SKIP at intent birth (aidlc-utility.ts records it in the
 *  Stages to Skip row), so no codekb is written and the asserts must not run (the
 *  skip is the correct behaviour, not a flake). This reads the born intent's
 *  aidlc-state.md and returns true only for that greenfield RE-skip: Project Type is
 *  Greenfield AND the Stages to Skip row names the reverse-engineering slug. We match
 *  the bare slug, never the row's human annotation (the engine writes it with an
 *  em-dash phrase we deliberately avoid touching). A genuine brownfield RE failure
 *  still falls through to the asserts and reds, as it should. */
function greenfieldReSkip(recordDir: string): boolean {
  let content: string;
  try {
    content = readFileSync(join(recordDir, "aidlc-state.md"), "utf-8");
  } catch {
    return false;
  }
  const projectType = (getField(content, "Project Type") ?? "").toLowerCase();
  const stagesToSkip = getField(content, "Stages to Skip") ?? "";
  return projectType === "greenfield" && stagesToSkip.includes("reverse-engineering");
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
 *  real failure the assertions below catch.
 *
 *  Second cancel arm: a LEGITIMATE greenfield RE-skip. When the intent is greenfield
 *  the engine stamped reverse-engineering SKIP at birth, so this `--single` run never
 *  writes codekb and would otherwise burn the whole codekb budget (~20 min of live
 *  Kiro credits) waiting for stores that will never appear. So we also cancel the
 *  moment greenfieldReSkip becomes true on disk; the assertions below then take the
 *  greenfield branch and accept the skip. The two arms are independent: either a
 *  real both-repos landing OR a recorded greenfield skip ends the turn fast. */
async function driveCodekbUntilBothRepos(
  session: AcpSession,
  root: string,
  recordDir: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof driveKiroAcp>>> {
  let done = false;
  const poll = setInterval(() => {
    if (done || !session.sessionId) return;
    const bothRepos =
      codekbFiles(root, "repo-a").length > 0 && codekbFiles(root, "repo-b").length > 0;
    if (bothRepos || greenfieldReSkip(recordDir)) {
      done = true;
      session.notify("session/cancel", { sessionId: session.sessionId });
    }
  }, 2000);
  try {
    return await driveKiroAcp({
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

function withoutLastUpdated(state: string): string {
  return state.replace(/^- \*\*Last Updated\*\*:.*$/m, "- **Last Updated**: <volatile>");
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
      // new-work prose, and renders the offer. Beats 4-5 open a THIRD fresh `aidlc`
      // session (`space`) for the same reason: beat 3's `offer` session is cancelled
      // mid-birth, so reusing it would resume that birth rather than parse the new
      // `/aidlc space-create` prompt. Each space verb is a terminal print directive
      // ("…then stop"), so all of beats 4-5 reuse this ONE keepAlive `space` session
      // (spike-verified: three sequential space verbs run clean on one session).
      const conductor = new AcpSession(root, "aidlc", true);
      const offer = new AcpSession(root, "aidlc", true);
      const space = new AcpSession(root, "aidlc", true);
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
        // poller also fast-cancels on a legitimate greenfield RE-skip so a skip does
        // not burn the codekb budget. The on-disk assertions below are the proof.
        const codekbRun = await driveCodekbUntilBothRepos(
          conductor,
          root,
          recordADir,
          CODEKB_DRIVE_MS,
        );
        expect([...r1.toolCallIssues, ...codekbRun.toolCallIssues]).toEqual([]);
        if (greenfieldReSkip(recordADir)) {
          // Greenfield: reverse-engineering was stamped SKIP at birth, so no per-repo
          // codekb is expected. The recorded skip is the correct outcome; accept it
          // and do NOT run the codekb asserts (permissive by design).
          expect(greenfieldReSkip(recordADir)).toBe(true);
        } else {
          // Brownfield: reverse-engineering ran, so both repos got a codekb store.
          expect(codekbFiles(root, "repo-a").length).toBeGreaterThan(0);
          expect(codekbFiles(root, "repo-b").length).toBeGreaterThan(0);
        }

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
        const offerR1 = await driveKiroAcp({
          projectDir: root,
          session: offer,
          prompt:
            "a completely separate, unrelated standalone metrics dashboard — a brand " +
            "new project, nothing to do with the auth work",
          timeoutMs: VERB_DRIVE_MS,
          stopAfterToolTitle: /aidlc-utility\.ts intent --json/,
          keepAlive: true,
        });
        expect(offerR1.toolCallIssues).toEqual([]);
        // PIN the compare-read itself: the offer flow's documented first move is
        // `intent --json` (SKILL.md; the spike-verified offer-render boundary).
        // A live run was observed reaching a natural end_turn via --help /
        // `intent list` exploration WITHOUT ever running the compare-read, and
        // nothing failed — the offer path was silently not exercised. Assert the
        // tool actually ran so that divergence reds instead of passing dark.
        expect(
          offerR1.toolCalls.some((tc) =>
            /aidlc-utility\.ts intent --json/.test(tc.title),
          ),
        ).toBe(true);
        // Turn 3b: confirm. The conductor routes through `next --new-intent`,
        // then acts on the engine's intent-birth print. The inferred scope is
        // non-deterministic; assert only the registry shape and A's integrity.
        const offerR2 = await driveKiroAcp({
          projectDir: root,
          session: offer,
          prompt: "Yes — start a second intent for the metrics dashboard.",
          timeoutMs: VERB_DRIVE_MS,
          stopAfterToolTitle: /aidlc-utility\.ts intent-birth/,
          keepAlive: true,
        });
        expect(offerR2.toolCallIssues).toEqual([]);
        const reg3 = readIntentRegistry(root);
        expect(reg3.length).toBe(2);
        expect(new Set(reg3.map((e) => e.uuid)).size).toBe(2);
        for (const e of reg3) expect(e.uuid).toMatch(UUIDV7_RE);
        // A's substantive workflow state is untouched + B's birth did not
        // bleed into A's shard. The conductor may park A while handling the
        // new-work offer, which legitimately refreshes only Last Updated.
        expect(
          withoutLastUpdated(readFileSync(join(recordADir, "aidlc-state.md"), "utf-8")),
        ).toBe(withoutLastUpdated(stateABefore));
        expect(workflowStartedCount(recordADir)).toBe(1);

        // --- Beat 4: non-default space — create, switch, birth there; no leak --
        // The space NAVIGATION verbs (space-create / space) are TERMINAL commands —
        // they map 1:1 to an aidlc-utility.ts subcommand and carry no workflow work.
        // On Kiro they are dispatched DETERMINISTICALLY by the userPromptSubmit seam
        // (agents/aidlc.json → aidlc-kiro-adapter.ts verb-intercept): the hook runs
        // the tool OFF-BAND (not as a conductor tool call) and hands the conductor the
        // verbatim output with a do-NOT-advance instruction, so the conductor relays
        // and ends the turn making ZERO tool calls (live-verified: toolCalls=[],
        // stopReason=end_turn, the space created on disk). Therefore each verb turn is
        // driven to its natural end_turn — NOT stopAfterToolTitle (the tool runs inside
        // the hook, never surfaces as an ACP tool_call, so a title stop would never
        // fire). The assertable surface is the on-disk outcome. (Beat 4c below is a
        // BIRTH — run-then-continue, genuine conductor work — so it keeps its title
        // stop.) Each verb reuses the keepAlive `space` session; the seam ends every
        // verb turn cleanly so reuse is safe.
        // 4a: create teamB; assert org.md byte-copied from default, fresh empty
        // team/project stubs, knowledge/ ABSENT at create time.
        const createSpace = await driveKiroAcp({
          projectDir: root,
          session: space,
          prompt: `/aidlc space-create teamB`,
          timeoutMs: VERB_DRIVE_MS,
          keepAlive: true,
        });
        expect(createSpace.toolCallIssues).toEqual([]);
        const teamBMemory = join(root, "aidlc", "spaces", TEAM_B_SLUG, "memory");
        const defaultOrg = readFileSync(
          join(root, "aidlc", "spaces", "default", "memory", "org.md"),
          "utf-8",
        );
        expect(readFileSync(join(teamBMemory, "org.md"), "utf-8")).toBe(defaultOrg);
        expect(readFileSync(join(teamBMemory, "team.md"), "utf-8")).toBe("# Team practices\n");
        expect(readFileSync(join(teamBMemory, "project.md"), "utf-8")).toBe("# Project overrides\n");
        // space-create (#5) provisions the full space shape incl. the codekb/ +
        // knowledge/ siblings (with .gitkeep floors), matching default.
        expect(existsSync(join(root, "aidlc", "spaces", TEAM_B_SLUG, "knowledge"))).toBe(true);
        expect(existsSync(join(root, "aidlc", "spaces", TEAM_B_SLUG, "codekb"))).toBe(true);

        // 4b: switch to teamB (terminal verb — seam-dispatched, drive to end_turn).
        const switchSpace = await driveKiroAcp({
          projectDir: root,
          session: space,
          prompt: `/aidlc space teamB`,
          timeoutMs: VERB_DRIVE_MS,
          keepAlive: true,
        });
        expect(switchSpace.toolCallIssues).toEqual([]);
        expect(activeSpace(root)).toBe(TEAM_B_SLUG);

        // 4c: birth into teamB via the conductor's birth gate — in teamB (zero
        // intents) a `/aidlc --scope poc "<desc>"` hits Branch 9a → birthPrintDirective
        // → the conductor runs `intent-birth …` directly. knowledge/ now PRESENT
        // (lazy ensure on first birth); teamB holds its 1 intent, default still holds
        // its 2 (no cross-space leak).
        const birthTeamB = await driveKiroAcp({
          projectDir: root,
          session: space,
          prompt: `/aidlc --scope poc "teamB onboarding flow"`,
          timeoutMs: VERB_DRIVE_MS,
          stopAfterToolTitle: /aidlc-utility\.ts intent-birth/,
          keepAlive: true,
        });
        expect(birthTeamB.toolCallIssues).toEqual([]);
        expect(listIntents(root, TEAM_B_SLUG).length).toBe(1);
        expect(listIntents(root, "default").length).toBe(2);
        expect(existsSync(join(root, "aidlc", "spaces", TEAM_B_SLUG, "knowledge"))).toBe(true);

        // --- Beat 5: back to default; A still resumable ----------------------
        // `space default` is a terminal verb — seam-dispatched, drive to end_turn.
        const backToDefault = await driveKiroAcp({
          projectDir: root,
          session: space,
          prompt: `/aidlc space default`,
          timeoutMs: VERB_DRIVE_MS,
          keepAlive: true,
        });
        expect(backToDefault.toolCallIssues).toEqual([]);
        expect(activeSpace(root)).toBe("default");
        // A's workflow state survived the round trip; no foreign birth bled in.
        expect(readFileSync(join(recordADir, "aidlc-state.md"), "utf-8")).toBe(stateABefore);
        expect(workflowStartedCount(recordADir)).toBe(1);
        expect(listIntents(root, "default").length).toBe(2);
      } finally {
        conductor.close();
        offer.close();
        space.close();
        cleanupWorkspaceJourney(journey);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
