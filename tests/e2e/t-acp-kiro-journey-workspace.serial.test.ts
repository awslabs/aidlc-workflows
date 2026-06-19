// covers: subcommand:aidlc-utility:intent-birth, file:skills/aidlc/SKILL.md
//
// t-acp-kiro-journey-workspace.serial.test.ts — the LIVE workspace journey,
// Kiro-ACP logic half (P10 / Stage E), SCOPED to the beats the single-turn ACP
// surface can drive deterministically. A SEQUENCE of single-turn driveKiroAcp
// invocations against one shared on-disk workspace root (NOT one multi-gate run —
// the ACP driver is single-turn by design, kiro-acp-drive.ts:354-359).
//
// The assertable surfaces are the verbatim tool output (tool_call_update text) +
// the on-disk record state read straight off the workspace root. NEVER the prose.
//
// Beats this leg proves live over the real Kiro ACP surface:
//   1. `/aidlc --scope feature "build auth across both repos"` → auto-birth intent
//      A spanning BOTH sibling repos (repos captured by sibling auto-discovery —
//      the engine drops --repos, see the SDK leg's DRIFT NOTE; scope named so
//      Branch 9a births with no scope-confirm gate the single-turn driver can't
//      answer). Assert: one row, repos sorted set ["repo-a","repo-b"], UUIDv7,
//      in-flight — the vision's "an intent spanning repos" promise.
//   2. (cheaper variant) `/aidlc --stage reverse-engineering --single` writes
//      per-repo codekb to aidlc/codekb/repo-a + repo-b — no swarm. Assert both
//      dirs have content — the vision's per-repo multi-repo codekb read.
//
// Beats 3-5 (a 2nd intent alongside A · a non-default space switch while active ·
// switch back) are NOT driven over ACP, BY SURFACE LIMITATION — stated, not faked
// (the honesty the card demands for Codex's absent TUI). They need a CONDUCTOR-
// SIDE workspace verb the engine's `next` does not route, and Kiro's `aidlc` ACP
// agent neither runs a bare-prose bash command (the SDK/codex path) nor ends its
// IN-TURN forwarding loop at the offer gate (kiro-acp-drive.ts:354-359). Those
// beats are proven on the TURN-PACED surfaces — the SDK + Codex logic legs (full
// 5-beat journey) and the Kiro-TUI render leg (commit 2). See the block comment
// at the end of the test for the verified-live detail.
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
import { driveKiroAcp } from "../harness/kiro-acp-drive.ts";
import { KIRO_SRC } from "../harness/tui-fixtures.ts";

// A multi-turn live journey (heaviest e2e). On ACP the forwarding loop runs
// IN-TURN once a workflow is active (kiro-acp-drive.ts:354-359), so the per-repo
// reverse-engineering codekb beat (9 artifacts × 2 repos) keeps executing inside
// one turn for many minutes — the longest single turn in the suite. Budget the
// whole journey at 3600s, give the cheap verb turns a modest cap, and the codekb
// turn the lion's share.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "3600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 3600) * 1000;
const VERB_DRIVE_MS = 240_000;
const CODEKB_DRIVE_MS = Math.max(1_200_000, TEST_TIMEOUT_MS - 6 * VERB_DRIVE_MS);

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

function codekbFiles(root: string, repo: string): string[] {
  try {
    return readdirSync(join(root, "aidlc", "codekb", repo)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

function activeRecordDir(root: string): string | undefined {
  return listIntents(root, activeSpace(root)).find((i) => i.active)?.dirName ?? undefined;
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

describe("t-acp-kiro-journey-workspace (live ACP multi-repo journey — the beats the single-turn surface drives)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `one feature spanning two repos: auto-birth + per-repo codekb, live over ACP${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const journey = setupWorkspaceJourney("kiro");
      const root = journey.root;
      try {
        // --- Step 1: auto-birth A spanning both siblings ---------------------
        // Name the scope explicitly: a bare prose `/aidlc "<desc>"` emits an `ask`
        // scope-confirm (orchestrate Branch 8 :1148) that the SINGLE-TURN ACP
        // driver cannot answer (it renders as prose, not a protocol gate) — so the
        // turn would end before birth. `--scope feature` births via Branch 9a with
        // no gate; the repo span is still captured by sibling auto-discovery.
        const r1 = await driveKiroAcp({
          projectDir: root,
          prompt: `/aidlc --scope feature "build auth across both repos"`,
          timeoutMs: VERB_DRIVE_MS,
          stopAfterToolTitle: /aidlc-utility\.ts intent-birth/,
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

        // --- Step 2: per-repo codekb for both siblings (cheaper variant) ------
        // The RE stage writes both repos' codekb, then verifies them with a single
        // `cd aidlc/codekb && for d in repo-a repo-b …` shell check (observed
        // live). Cancel on that verify title: on ACP the conductor's IN-TURN
        // forwarding loop does NOT end the turn after the stage work (it narrates
        // on for many minutes — the kiro-acp-drive.ts:354-359 hazard), so without a
        // stop the turn just burns the budget. The verify fires only AFTER both
        // repos' codekb is written, so cancelling there leaves both stores intact;
        // the on-disk assertions below are the proof.
        await driveKiroAcp({
          projectDir: root,
          prompt: `/aidlc --stage reverse-engineering --single`,
          timeoutMs: CODEKB_DRIVE_MS,
          stopAfterToolTitle: /aidlc\/codekb|codekb\/repo-b|repo-b\/reverse-engineering-timestamp/,
        });
        expect(codekbFiles(root, "repo-a").length).toBeGreaterThan(0);
        expect(codekbFiles(root, "repo-b").length).toBeGreaterThan(0);

        const recordADir = join(root, "aidlc", "spaces", "default", "intents", recordA as string);
        expect(workflowStartedCount(recordADir)).toBe(1);

        // --- Journey beats 3-5 are NOT driven over ACP — by surface limitation,
        //     stated, not faked (the same honesty the card demands for Codex's
        //     absent TUI). Beats 3 (birth a 2nd intent ALONGSIDE an active one),
        //     4 (space-create + SWITCH while an intent is active), and 5 (switch
        //     back) all require the conductor to run a CONDUCTOR-SIDE workspace
        //     verb — `intent-birth` / `space <name>` — that the engine's `next`
        //     does NOT route (verified: aidlc-orchestrate.ts has no `space`/
        //     birth-while-active branch; parseNextFlags :249 + the Branch ladder).
        //     On the SDK + Codex harnesses the conductor satisfies that by running
        //     the tool DIRECTLY from a prose instruction (the SDK/codex journey
        //     legs drive exactly this and pass). Kiro's `aidlc` ACP agent does
        //     NOT execute a bare-prose bash command (verified live: the turn ends
        //     with zero tool calls), and a `/aidlc intent-birth …` slash command
        //     is fed verbatim to `next`, which — with intent A active — advances/
        //     executes A instead of birthing B (verified live: the turn ran
        //     stage-execution tool calls, never intent-birth). The only ACP path
        //     to a 2nd intent is the conductor's offer→confirm beat, which is
        //     GATE-PACED — and ACP's forwarding loop runs IN-TURN, so it does not
        //     end the turn at the offer (verified live: the offer turn overran the
        //     budget). That is precisely the boundary kiro-acp-drive.ts:354-359
        //     draws: "turn-per-gate pacing is NOT a dependable ACP primitive.
        //     Gate-paced journeys belong to the TUI driver." So the multi-intent /
        //     space beats are proven on the TURN-PACED surfaces — the SDK + Codex
        //     logic legs (full 5-beat journey) and the Kiro-TUI render leg (commit
        //     2) — NOT over single-turn ACP. The ACP leg proves the beats its
        //     surface CAN drive deterministically: the multi-repo auto-birth +
        //     per-repo codekb composition above (the vision's "an intent spanning
        //     repos" promise, live on the real Kiro ACP surface).
      } finally {
        cleanupWorkspaceJourney(journey);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
