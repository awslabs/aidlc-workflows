// covers: subcommand:aidlc-utility:intent-birth, subcommand:aidlc-utility:space-create, subcommand:aidlc-utility:space, subcommand:aidlc-utility:intent, file:skills/aidlc/SKILL.md
//
// t-journey-workspace.sdk.test.ts — the LIVE workspace journey, Claude-SDK
// logic half (P10 / Stage E). This is the ONE phase that exercises the vision's
// §0 promise as a COMPOSED lived flow rather than mechanism-by-mechanism: a
// developer opens one workspace, builds a feature that SPANS TWO REPOS, runs a
// SECOND intent alongside it, works in a NON-DEFAULT SPACE, and none of it
// collides — driven live through the real Claude harness surface.
//
// The journey (one shared on-disk workspace root carried across SDK turns; each
// driveAidlc() is a fresh SDK session operating on the SAME persisted records —
// the cross-session on-disk record state IS the proof of composition):
//   1. `/aidlc "build auth across both repos"` on a fresh two-sibling-repo
//      workspace → the engine names intent-birth, the conductor runs it, and the
//      intent auto-births spanning repo-a + repo-b. Asserted on disk: one
//      intents.json row, repos == the SORTED set ["repo-a","repo-b"], a real
//      UUIDv7, status "in-flight".
//   2. (cheaper variant the card sanctions) a reverse-engineering stage writes a
//      per-repo codekb artifact into the space-level codekb store for repo-a +
//      repo-b (aidlc/spaces/<space>/codekb/<repo>/ — the codekb-determinism
//      placement fix; codekbFiles tolerates the bare workspace-root form too) —
//      WITHOUT driving the full worktree-forking swarm (the most fragile/expensive
//      beat, which combines badly with the in-turn forwarding loop). Asserted:
//      both per-repo codekb dirs exist with content.
//   3. birth a SECOND intent alongside the active one via the deterministic
//      `intent-birth` verb (the engine has NO "offer a 2nd intent" directive on
//      the logic path — it would advance A via Branch 10; intent-birth mints
//      unconditionally, the shared cross-harness path). Asserted: two isolated
//      registry rows + record dirs, distinct UUIDs, and A's state + audit shard
//      byte-untouched by B's birth.
//   4. `/aidlc space-create teamB` → `/aidlc space teamB` → birth an intent
//      there. The two space verbs are driven the PLAIN user way — the engine now
//      routes a leading space/space-create/intent token through the conductor
//      (aidlc-orchestrate.ts Branch 1b → terminal print naming aidlc-utility.ts),
//      so no "do NOT run next" steering is needed; the conductor runs the named
//      utility and stops without touching the active intent. Asserted:
//      teamB/memory/org.md copied from default's; team.md + project.md are FRESH
//      EMPTY stubs (default's promoted learnings do NOT leak); the space-level
//      knowledge/ dir appears at FIRST BIRTH into teamB (lazy ensure-exists), NOT
//      at space-create; the active-space cursor moved.
//   5. `/aidlc space default` (again the plain conductor-routed switch) → intent A
//      is still resumable (the cursor flip is a pure write) and its audit shard is
//      intact.
//
// DRIFT NOTE (verified @ this branch, surfaced for the runbook): the engine's
// `next` flag parser (aidlc-orchestrate.ts parseNextFlags :249) does NOT
// recognise `--repos`, and birthPrintDirective (:304) never threads it into the
// named intent-birth command — so on the AUTO-BIRTH path the repo span is
// captured by SIBLING AUTO-DISCOVERY (resolveBirthRepoSet → discoverSiblingRepos,
// lib:1299/1273), not by an explicit flag. Step 1 therefore drives the bare
// `/aidlc "<desc>"` (no --repos, which would pollute the slug as a stray
// positional) and relies on auto-discovery to capture both git-init'd siblings —
// which is the genuine composed behaviour the vision promises (an intent spanning
// the repos present in the workspace). The explicit `--repos` flag is honoured
// only on a direct `intent-birth --repos` invocation (exercised by t164/unit).
//
// Assertions stay at the JOURNEY level (on-disk record state + verbatim
// tool-result bytes), tolerant of conversational variance — NEVER on
// assistantText. SPENDS TOKENS — driveAidlc drives the real /aidlc on
// Opus/Bedrock. Gated on claude-CLI presence (the file calls driveAidlc, so
// claude-gate.ts marks it SDK-dependent; the runner skips-with-reason when claude
// is absent — never a hard fail).

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupWorkspaceJourney,
  setupWorkspaceJourney,
} from "../harness/fixtures.ts";
import {
  type CapturedToolResult,
  driveAidlc,
} from "../harness/sdk-drive.ts";
import {
  activeSpace,
  getField,
  listIntents,
  readIntentRegistry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// This is the suite's heaviest live test: SIX SDK turns across one journey, one
// of which (the per-repo reverse-engineering codekb beat) writes many artifacts
// over two repos. Budget it like the other multi-stage live journeys (2400s
// default), and split the budget so the cheap deterministic-verb beats get a
// modest cap while the heavy codekb beat gets the lion's share.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;
// Per-beat caps (a fresh SDK session each): the verb beats finish in one or two
// tool round-trips; the reverse-engineering codekb beat fans 9 artifacts × 2
// repos and needs far longer.
const VERB_DRIVE_MS = 300_000;
const CODEKB_DRIVE_MS = Math.max(600_000, TEST_TIMEOUT_MS - 6 * VERB_DRIVE_MS);

const INIT_STATE_SUMMARY = "State initialized:";
const STOP_AFTER_BIRTH = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
const SINGLE_RE_DONE = "single-stage:reverse-engineering";

// A UUIDv7 has version nibble 7 and variant nibble in {8,9,a,b}.
const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The user types "teamB"; the engine slugifies it on disk (slugify lowercases —
// aidlc-lib.ts:463), so the SPACE DIR + cursor + registry key are "teamb".
const TEAM_B_SLUG = "teamb";

/**
 * Build a prompt that makes the conductor run the deterministic intent-birth
 * UTILITY directly (not route the request through `next`). WHY this matters: a
 * bare `/aidlc intent-birth …` slash command is parsed by the conductor as
 * freeform input and fed to `aidlc-orchestrate.ts next`; with intent A ALREADY
 * active, the engine then advances/scope-changes A (Branch 10) instead of
 * birthing — a verified live failure: the conductor ran `scope-change --scope poc`
 * on A, rewriting A's state Scope feature→poc. The journey wants the
 * mints-unconditionally handler (aidlc-utility.ts intent-birth, :1995), so we
 * instruct the conductor to invoke that tool verbatim and NOT touch the active
 * intent. (This is the SKILL.md run-then-continue shape, named explicitly.)
 */
function birthToolPrompt(scope: string, args: string): string {
  return (
    `Run this exact command with the Bash tool and then stop — do NOT run \`next\`, ` +
    `do NOT advance or scope-change the currently active intent: ` +
    `bun .claude/tools/aidlc-utility.ts intent-birth --scope ${scope} --arguments ${JSON.stringify(args)}`
  );
}

/** Read every codekb artifact filename for a repo, tolerant of WHERE the store
 *  anchors. The engine NOW resolves the per-repo codekb to the SPACE-LEVEL
 *  sibling of intents/ (aidlc/spaces/<space>/codekb/<repo>/ — the
 *  codekb-determinism placement fix), but the live RE subagent occasionally still
 *  writes to the bare workspace-root form aidlc/codekb/<repo>/. Either is a valid
 *  per-repo store for this beat's promise; accept BOTH, only absence is a fail. */
function codekbFiles(root: string, repo: string): string[] {
  const candidates = [
    join(root, "aidlc", "spaces", activeSpace(root), "codekb", repo),
    join(root, "aidlc", "codekb", repo),
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

/** The active intent's record dir (the cursor target) for the active space. */
function activeRecordDir(root: string): string | undefined {
  const sp = activeSpace(root);
  return listIntents(root, sp).find((i) => i.active)?.dirName ?? undefined;
}

function shellCommand(result: CapturedToolResult): string | undefined {
  if (result.toolName !== "Bash" && result.toolName !== "Shell") return undefined;
  return typeof result.input.command === "string"
    ? result.input.command
    : undefined;
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

/** How many WORKFLOW_STARTED audit events the record's shards hold. An intent's
 *  birth emits exactly one; a SECOND would mean another intent's birth bled into
 *  this record — the collision the vision forbids. (Per-session SessionStart/End
 *  hooks append SESSION_* events to the active intent, so the raw shard bytes are
 *  not stable across fresh sessions; this count is the stable collision signal.) */
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

describe("t-journey-workspace (live SDK multi-repo·intent·space journey)", () => {
  test(
    "one feature spanning two repos, a second intent alongside, a non-default space — composed live, no collision",
    async () => {
      const journey = setupWorkspaceJourney("claude");
      const root = journey.root;
      try {
        // --- Step 1: auto-birth intent A spanning both sibling repos ----------
        // Name the scope explicitly so the engine births via Branch 9a (no
        // scope-confirm gate) — a bare prose `/aidlc "<desc>"` emits an `ask`
        // scope-confirm (Branch 8, orchestrate:1148) that the single-turn ACP /
        // one-shot codex drivers cannot answer, so the cross-harness journey names
        // the scope. The repo span is STILL captured by sibling auto-discovery
        // (the DRIFT NOTE above), so this stays the genuine multi-repo auto-birth.
        const r1 = await driveAidlc(
          `/aidlc --scope feature "build auth across both repos"`,
          {
            projectDir: root,
            answerScript: "default",
            timeoutMs: VERB_DRIVE_MS,
            stopAfterToolResult: STOP_AFTER_BIRTH,
          },
        );
        // The conductor acted on the engine's birth print: intent-birth ran and
        // its verbatim summary landed.
        assertToolResultContains(r1, "Bash", INIT_STATE_SUMMARY);

        // On disk: exactly one intent, spanning BOTH siblings (sorted set),
        // distinct UUIDv7, in-flight.
        const reg1 = readIntentRegistry(root);
        expect(reg1.length).toBe(1);
        const intentA = reg1[0];
        expect(intentA.repos).toEqual(["repo-a", "repo-b"]);
        expect(intentA.uuid).toMatch(UUIDV7_RE);
        expect(intentA.status).toBe("in-flight");
        const recordA = activeRecordDir(root);
        expect(recordA).toBeDefined();

        // --- Step 2: per-repo codekb written for BOTH siblings (cheaper variant)
        // Drive a reverse-engineering pass over the recorded repo set; the stage
        // writes its artifacts to the space-level codekb store per repo
        // (aidlc/spaces/<space>/codekb/<repo>/ — RE stage prose defers the dir to
        // the codekb-path tool). We drive only as far as the per-repo codekb
        // landing — NOT the swarm.
        const r2 = await driveAidlc(
          `/aidlc --stage reverse-engineering --single`,
          {
            projectDir: root,
            answerScript: "default",
            timeoutMs: CODEKB_DRIVE_MS,
            stopAfterToolResult: {
              toolName: "Bash",
              resultIncludes: SINGLE_RE_DONE,
            },
          },
        );
        expect(r2.timedOut).toBe(false);
        expect(r2.stoppedAfterToolResult).toBe(true);

        const r2Commands = r2.toolResults
          .map(shellCommand)
          .filter((command): command is string => command !== undefined);
        const r2Next = r2Commands.filter((command) =>
          /aidlc-orchestrate\.ts["']?\s+next\b/.test(command)
        );
        expect(r2Next.length).toBeGreaterThan(0);
        for (const command of r2Next) {
          expect(command).toMatch(/--single\b/);
          expect(command).toMatch(/--stage(?:=|\s+)(?:["'])?reverse-engineering\b/);
        }
        const r2Reports = r2Commands.filter((command) =>
          /aidlc-orchestrate\.ts["']?\s+report\b/.test(command)
        );
        expect(
          r2Reports,
          `expected exactly one isolated completion report: ${JSON.stringify(r2Commands)}`,
        ).toHaveLength(1);
        expect(r2Reports[0]).toMatch(/--single\b/);
        expect(r2Reports[0]).toMatch(
          /--stage(?:=|\s+)(?:["'])?reverse-engineering\b/,
        );
        expect(r2Reports[0]).toMatch(
          /--result(?:=|\s+)(?:["'])?completed\b/,
        );
        expect(
          r2Commands.some((command) =>
            /--result(?:=|\s+)(?:["'])?awaiting-approval\b/.test(command)
          ),
        ).toBe(false);
        expect(
          r2Commands.some((command) =>
            /aidlc-learnings\.ts["']?\s+(?:surface|persist)\b/.test(command)
          ),
        ).toBe(false);
        expect(
          r2Commands.some((command) =>
            /aidlc-orchestrate\.ts["']?\s+park\b/.test(command)
          ),
        ).toBe(false);
        // Resolve A's record dir up front (hoisted above the codekb asserts) so we
        // can read its state-file and tell which of the two valid RE outcomes applies.
        const recordADir = join(root, "aidlc", "spaces", "default", "intents", recordA as string);
        if (greenfieldReSkip(recordADir)) {
          // Greenfield: reverse-engineering was stamped SKIP at birth, so no per-repo
          // codekb is expected here. The recorded skip is the correct outcome; accept
          // it and do NOT run the codekb asserts. This branch is permissive by design
          // (if the LLM writes codekb anyway despite the skip, the journey stays green).
          expect(greenfieldReSkip(recordADir)).toBe(true);
        } else {
          // Brownfield: reverse-engineering ran, so both repos got an independent
          // codekb store (the multi-repo read the vision promises: an intent spanning
          // two repos reads both folders).
          expect(codekbFiles(root, "repo-a").length).toBeGreaterThan(0);
          expect(codekbFiles(root, "repo-b").length).toBeGreaterThan(0);
        }

        // Snapshot A's WORKFLOW STATE before birthing B — the deterministic
        // isolation proof (B's birth must never touch A's aidlc-state.md). We do
        // NOT byte-compare A's audit SHARD: the per-session SessionStart/SessionEnd
        // hooks (aidlc-session-{start,end}.ts → appendAuditEntry) legitimately
        // append SESSION_* events to whatever intent is active, and a fresh
        // driveAidlc() is a new session — so the shard gains session-lifecycle
        // noise that is NOT a collision. The collision the vision forbids is B's
        // BIRTH bleeding into A; that surfaces as a SECOND WORKFLOW_STARTED in A's
        // shard, which we guard directly via workflowStartedCount().
        const stateABefore = readFileSync(join(recordADir, "aidlc-state.md"), "utf-8");
        expect(workflowStartedCount(recordADir)).toBe(1);

        // --- Step 3: birth a SECOND intent alongside active A -----------------
        // The deterministic shared path: the intent-birth utility mints
        // unconditionally (aidlc-utility.ts:1995). The engine has no "offer 2nd
        // intent" directive on the logic drivers; routed through `next` with A
        // active it would advance/scope-change A (Branch 10) — so we name the tool
        // command directly (see birthToolPrompt).
        const r3 = await driveAidlc(
          birthToolPrompt("poc", "build a standalone metrics dashboard"),
          {
            projectDir: root,
            answerScript: "default",
            timeoutMs: VERB_DRIVE_MS,
            stopAfterToolResult: STOP_AFTER_BIRTH,
          },
        );
        assertToolResultContains(r3, "Bash", INIT_STATE_SUMMARY);

        // Two isolated rows, distinct UUIDs, both in-flight.
        const reg3 = readIntentRegistry(root);
        expect(reg3.length).toBe(2);
        const uuids = new Set(reg3.map((e) => e.uuid));
        expect(uuids.size).toBe(2);
        for (const e of reg3) expect(e.uuid).toMatch(UUIDV7_RE);
        // Two distinct on-disk record dirs.
        const dirs = listIntents(root).map((i) => i.dirName).filter(Boolean);
        expect(new Set(dirs).size).toBe(2);

        // A's WORKFLOW STATE untouched by B's birth (B took the workspace lock
        // and wrote into B's record; A's state file is byte-identical), and B's
        // birth event did NOT bleed into A's shard (still exactly one
        // WORKFLOW_STARTED — A's own).
        expect(readFileSync(join(recordADir, "aidlc-state.md"), "utf-8")).toBe(stateABefore);
        expect(workflowStartedCount(recordADir)).toBe(1);

        // --- Step 4: a non-default space, no learnings leak -------------------
        // The user TYPES "teamB"; the engine slugifies it to "teamb" on disk
        // (slugify lowercases — lib:463), so every on-disk path/assertion uses the
        // slug while the command string keeps the human spelling.
        await driveAidlc(`/aidlc space-create teamB`, {
          projectDir: root,
          answerScript: "default",
          timeoutMs: VERB_DRIVE_MS,
        });
        const teamBMemory = join(root, "aidlc", "spaces", TEAM_B_SLUG, "memory");
        // org.md copied from default's baseline.
        const defaultOrg = readFileSync(
          join(root, "aidlc", "spaces", "default", "memory", "org.md"),
          "utf-8",
        );
        expect(readFileSync(join(teamBMemory, "org.md"), "utf-8")).toBe(defaultOrg);
        // team.md / project.md are FRESH EMPTY stubs (default's promoted learnings
        // do NOT leak into a new team).
        expect(readFileSync(join(teamBMemory, "team.md"), "utf-8")).toBe("# Team practices\n");
        expect(readFileSync(join(teamBMemory, "project.md"), "utf-8")).toBe("# Project overrides\n");
        // space-create (#5) provisions the FULL space shape — memory/ + intents/
        // PLUS the codekb/ and knowledge/ siblings (with .gitkeep floors) — so a
        // new space matches default's committed shape immediately (vision §11.2).
        const teamBRoot = join(root, "aidlc", "spaces", TEAM_B_SLUG);
        expect(existsSync(join(teamBRoot, "knowledge"))).toBe(true);
        expect(existsSync(join(teamBRoot, "knowledge", ".gitkeep"))).toBe(true);
        expect(existsSync(join(teamBRoot, "codekb"))).toBe(true);
        expect(existsSync(join(teamBRoot, "codekb", ".gitkeep"))).toBe(true);

        // Switch into teamB and birth an intent there. The plain `/aidlc space
        // teamB` is forwarded to `next`, which (with intent A active in default)
        // recognises the leading `space` verb and emits a TERMINAL print naming
        // `aidlc-utility.ts space teamB` (Branch 1b, before state inspection — so
        // the active intent is never advanced); the conductor runs that tool and
        // stops. The on-disk cursor moving to teamb is the proof the real path ran.
        await driveAidlc(`/aidlc space teamB`, {
          projectDir: root,
          answerScript: "default",
          timeoutMs: VERB_DRIVE_MS,
          stopAfterToolResult: { resultIncludes: `Active space → ${TEAM_B_SLUG}` },
        });
        expect(activeSpace(root)).toBe(TEAM_B_SLUG); // the active-space cursor moved

        const r4b = await driveAidlc(
          birthToolPrompt("poc", "teamB onboarding flow"),
          {
            projectDir: root,
            answerScript: "default",
            timeoutMs: VERB_DRIVE_MS,
            stopAfterToolResult: STOP_AFTER_BIRTH,
          },
        );
        assertToolResultContains(r4b, "Bash", INIT_STATE_SUMMARY);
        // teamB now holds exactly one intent, isolated from default's two.
        expect(readIntentRegistry(root, TEAM_B_SLUG).length).toBe(1);
        expect(readIntentRegistry(root, "default").length).toBe(2);
        // The space-level knowledge/ dir appeared at FIRST BIRTH into teamB (lazy
        // ensure-exists), not at space-create.
        expect(existsSync(join(root, "aidlc", "spaces", TEAM_B_SLUG, "knowledge"))).toBe(true);

        // --- Step 5: switch back to default; intent A still resumable ---------
        // Same plain conductor-routed switch as beat 4, back the other way.
        await driveAidlc(`/aidlc space default`, {
          projectDir: root,
          answerScript: "default",
          timeoutMs: VERB_DRIVE_MS,
          stopAfterToolResult: { resultIncludes: "Active space → default" },
        });
        expect(activeSpace(root)).toBe("default");
        // A's WORKFLOW STATE survived the round trip untouched (the cursor flip is
        // a pure write; nothing rewrote A's state), and no foreign birth bled into
        // its shard. The audit shard itself may carry session-lifecycle events
        // from the intervening turns (see workflowStartedCount's note) — that is
        // not a collision.
        expect(readFileSync(join(recordADir, "aidlc-state.md"), "utf-8")).toBe(stateABefore);
        expect(workflowStartedCount(recordADir)).toBe(1);
        // Both default intents are still on disk and resumable.
        expect(readIntentRegistry(root, "default").length).toBe(2);
      } finally {
        cleanupWorkspaceJourney(journey);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
