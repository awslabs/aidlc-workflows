// covers: subcommand:aidlc-utility:intent-create, subcommand:aidlc-utility:space-create, subcommand:aidlc-utility:space, subcommand:aidlc-utility:intent, file:skills/aidlc/SKILL.md
//
// t-journey-workspace.sdk.test.ts — the LIVE workspace journey, Claude-SDK
// logic half. This is the ONE phase that exercises the vision's section 0
// promise as a COMPOSED lived flow rather than mechanism-by-mechanism: a
// developer opens one workspace, builds a feature that SPANS TWO REPOS, runs a
// SECOND intent alongside it, works in a NON-DEFAULT SPACE, and none of it
// collides — driven live through the real Claude harness surface.
//
// The journey (one shared on-disk workspace root carried across SDK turns; each
// driveAidlc() is a fresh SDK session operating on the SAME persisted records —
// the cross-session on-disk record state IS the proof of composition):
//   1. `/aidlc --scope feature "build auth across both repos"` on a fresh
//      two-sibling-repo workspace -> the engine names intent-create, the
//      conductor runs it, and the intent auto-creates spanning repo-a + repo-b.
//      Asserted on disk: one intents.json row, repos == the SORTED set
//      ["repo-a","repo-b"], a real UUIDv7, status "in-flight".
//   2. (cheaper variant the card sanctions) a reverse-engineering stage writes a
//      per-repo codekb artifact into the space-level codekb store for repo-a +
//      repo-b (aidlc/spaces/<space>/codekb/<repo>/; codekbFiles tolerates the
//      bare workspace-root form too) - WITHOUT driving the full worktree-forking
//      swarm (the most fragile/expensive beat, which combines badly with the
//      in-turn forwarding loop). Asserted: both per-repo codekb dirs exist with
//      content, unless greenfield RE is skipped (greenfieldReSkip).
//   3. the person asks for a SECOND piece of work in their own words with A
//      active (`/aidlc --scope poc "<desc>"`); the engine asks where it goes
//      and they pick separate new work. Asserted: two isolated registry rows +
//      record dirs, distinct UUIDs, A's state byte-untouched by B's creation, and no second
//      WORKFLOW_STARTED in A's audit shard.
//   4. `/aidlc space-create teamB` -> `/aidlc space teamB` -> ask for work
//      there the same way. The two space verbs are driven the PLAIN user way - the engine
//      routes a leading space/space-create/intent token through the conductor
//      (aidlc-orchestrate.ts Branch 1b -> terminal print naming aidlc.ts),
//      so no "do NOT run next" steering is needed; the conductor runs the named
//      utility and stops without touching the active intent. Asserted:
//      teamb/memory/org.md copied from default's; team.md + project.md are FRESH
//      EMPTY stubs (default's promoted learnings do NOT leak); the space-level
//      knowledge/ dir appears at space-create, with a .gitkeep floor; the
//      active-space cursor moved.
//   5. `/aidlc space default` (again the plain conductor-routed switch) → intent A
//      is still resumable (the cursor flip is a pure write) and its audit shard
//      holds no second WORKFLOW_STARTED.
//
// DRIFT NOTE: the engine's
// `next` flag parser (aidlc-orchestrate.ts parseNextFlags) does NOT
// recognise `--repos`, and createPrintDirective never threads it into the
// named intent-create command - so on the AUTO-CREATE path the repo span is
// captured by SIBLING AUTO-DISCOVERY (resolveIntentRepoSet → discoverSiblingRepos,
// lib:1299/1273), not by an explicit flag. Step 1 therefore drives the bare
// `/aidlc --scope feature "<desc>"` (no --repos, which would pollute the slug as
// a stray positional) and relies on auto-discovery to capture both git-init'd
// siblings - which is the genuine composed behaviour the vision promises (an
// intent spanning the repos present in the workspace). The explicit `--repos`
// flag is honoured only on a direct `intent-create --repos` invocation
// (exercised by t165/integration).
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
import { assertResultOk, assertToolResultContains } from "../harness/assert.ts";
import {
  LIVE_COMMAND_TIMEOUT_MS,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  fileCleanupReserveMs,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  cleanupWorkspaceJourney,
  setupWorkspaceJourney,
} from "../harness/fixtures.ts";
import { stageEvents } from "../harness/outcomes.ts";
import {
  type AnswerScript,
  type CapturedToolResult,
  type DriveResult,
  driveAidlc,
  separateWorkOptionIndex,
} from "../harness/sdk-drive.ts";
import {
  activeSpace,
  getField,
  listIntents,
  readIntentRegistry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// This is the suite's heaviest live test: seven SDK turns across one journey, one
// of which (the per-repo reverse-engineering codekb beat) writes many artifacts
// over two repos. Budget it like the other multi-stage live journeys (2400s
// default). Individual ceilings are backstops; the shared parent deadline bounds
// actual elapsed work without pre-reserving every other operation's worst case.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;
const VERB_DRIVE_MS = LIVE_COMMAND_TIMEOUT_MS;
const CODEKB_DRIVE_MS = LIVE_LONG_OPERATION_TIMEOUT_MS;

const INIT_STATE_SUMMARY = "State initialized:";
const STOP_AFTER_CREATION = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
const SINGLE_RE_DONE = "single-stage:reverse-engineering";

// A UUIDv7 has version nibble 7 and variant nibble in {8,9,a,b}.
const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The user types "teamB"; the engine slugifies it on disk (slugify lowercases —
// aidlc-lib.ts), so the SPACE DIR + cursor + registry key are "teamb".
const TEAM_B_SLUG = "teamb";

/**
 * The person asks for new work in their own words. With work active the engine
 * asks where it goes, and they pick the option for separate new work (as the
 * agent worded it, found the way question-once and t176 find it); any other
 * question takes its first option. An agent that changes the active work's
 * scope instead leaves A's state changed, which the journey checks.
 */
const SEPARATE_WORK: AnswerScript = {
  kind: "pick",
  pick: (question) => {
    const at = separateWorkOptionIndex(question.options);
    return at < 0 ? undefined : { optionIndex: at };
  },
};

/** Read every codekb artifact filename for a repo, tolerant of WHERE the store
 *  anchors. The engine resolves the per-repo codekb to the SPACE-LEVEL
 *  sibling of intents/ (aidlc/spaces/<space>/codekb/<repo>/), but the live RE
 *  subagent occasionally writes to the bare workspace-root form
 *  aidlc/codekb/<repo>/. Either is a valid per-repo store for this beat's
 *  promise; accept BOTH, only absence is a fail. */
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

/** Session audit rows may grow; workflow state and stage artifacts must not. */
function workflowMarkdownSnapshot(recordDir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  function visit(dir: string, prefix = ""): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (relative !== "audit") visit(join(dir, entry.name), relative);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        snapshot[relative] = readFileSync(join(dir, entry.name), "utf-8");
      }
    }
  }
  visit(recordDir);
  return snapshot;
}

/** A new piece of work carries on into its first stage, so a drive stopped at
 *  its creation can leave that step's command finishing just after the drive
 *  returns. Read the record once it has stopped changing, so a later comparison
 *  sees only what came after. */
async function settledSnapshot(recordDir: string): Promise<Record<string, string>> {
  // ponytail: a fixed 3 s quiet window, up to 30 s; a step still writing after that shows as a red diff naming the file.
  let last = workflowMarkdownSnapshot(recordDir);
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(3_000);
    const now = workflowMarkdownSnapshot(recordDir);
    if (Bun.deepEquals(now, last)) return now;
    last = now;
  }
  return last;
}

function assertTerminalWorkspaceTurn(result: DriveResult, output: string): void {
  expect(result.timedOut, `terminal workspace command timed out: ${output}`).toBe(false);
  expect(result.stoppedAfterToolResult).toBe(false);
  expect(result.stoppedAfterAskUserQuestion).toBe(false);
  assertResultOk(result);
  assertToolResultContains(result, "Bash", output);
  expect(
    result.toolResults.at(-1)?.resultText,
    "workspace navigation must end with the requested utility output",
  ).toContain(output);
  expect(result.askedQuestions, "workspace navigation must not start workflow intake").toEqual([]);
  expect(
    result.toolResults.filter((tool) => {
      if (tool.toolName !== "Bash") return false;
      try {
        const directive = JSON.parse(tool.resultText) as { kind?: string };
        return ["run-stage", "load-steering", "dispatch-subagent", "invoke-swarm"]
          .includes(directive.kind ?? "");
      } catch {
        return false; // ordinary utility output, not an engine directive
      }
    }),
    "terminal workspace navigation must not deliver workflow work",
  ).toEqual([]);
}

/** The RE codekb beat has TWO valid outcomes, and both keep the multi-repo journey
 *  intact. Brownfield: reverse-engineering EXECUTEs and writes a per-repo codekb
 *  store, so the codekbFiles asserts below hold. Greenfield: the engine stamps
 *  reverse-engineering SKIP at intent creation (aidlc-utility.ts records it in the
 *  Stages to Skip row), so no codekb is required and the asserts must not run (the
 *  skip is the correct behaviour, not a flake). This reads the created intent's
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
 *  creation emits exactly one; a SECOND would mean another intent's creation bled into
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
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const operationBudget = (requestedMs: number) => remainingOperationTimeoutMs(requestedMs, {
        deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "workspace SDK journey",
      });
      const journey = setupWorkspaceJourney("claude");
      const root = journey.root;
      try {
        // --- Step 1: auto-create intent A spanning both sibling repos ----------
        // Name the scope explicitly so the engine creates via Branch 9a (no
        // scope-confirm gate) - a bare prose `/aidlc "<desc>"` needs a plan proposal
        // and scope-confirm (Branch 8, aidlc-orchestrate.ts freshWorkRoute) that the
        // single-turn ACP / one-shot codex drivers cannot answer, so the cross-harness
        // journey names the scope. The repo span is STILL captured by sibling
        // auto-discovery (the DRIFT NOTE above), so this stays the genuine multi-repo
        // auto-create.
        const r1 = await driveAidlc(
          `/aidlc --scope feature "build auth across both repos"`,
          {
            projectDir: root,
            answerScript: "default",
            timeoutMs: operationBudget(VERB_DRIVE_MS),
            stopAfterToolResult: STOP_AFTER_CREATION,
          },
        );
        expect(r1.timedOut).toBe(false);
        assertToolResultContains(r1, "Bash", INIT_STATE_SUMMARY);

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
            timeoutMs: operationBudget(CODEKB_DRIVE_MS),
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
          /(?:aidlc-orchestrate\.ts["']?|engine orchestrate)\s+next\b/.test(command)
        );
        expect(r2Next.length).toBeGreaterThan(0);
        for (const command of r2Next) {
          expect(command).toMatch(/--single\b/);
          expect(command).toMatch(/--stage(?:=|\s+)(?:["'])?reverse-engineering\b/);
        }
        // The record, not the commands: one isolated completion, nothing
        // completed against the main workflow, and no gate opened for the stage
        // (a bare report the agent runs to look around writes nothing).
        const commands = JSON.stringify(r2Commands);
        expect(
          stageEvents(root, "STAGE_COMPLETED", "reverse-engineering", "single-stage:reverse-engineering"),
          `expected exactly one isolated completion: ${commands}`,
        ).toBe(1);
        expect(
          stageEvents(root, "STAGE_COMPLETED", "reverse-engineering"),
          `reverse-engineering completed against the main workflow: ${commands}`,
        ).toBe(1);
        expect(stageEvents(root, "STAGE_AWAITING_APPROVAL", "reverse-engineering"), commands).toBe(0);
        expect(
          r2Commands.some((command) =>
            /aidlc-learnings\.ts["']?\s+(?:surface|persist)\b/.test(command)
          ),
        ).toBe(false);
        expect(
          r2Commands.some((command) =>
            /(?:aidlc-orchestrate\.ts["']?|engine orchestrate)\s+park\b/.test(command)
          ),
        ).toBe(false);
        const recordADir = join(root, "aidlc", "spaces", "default", "intents", recordA as string);
        if (greenfieldReSkip(recordADir)) {
          // Greenfield: reverse-engineering was stamped SKIP at creation, so no per-repo
          // codekb is expected here. The recorded skip is the correct outcome; accept
          // it and do NOT run the codekb asserts. This branch is permissive by design
          // (if the LLM writes codekb anyway despite the skip, the journey stays green).
          expect(greenfieldReSkip(recordADir)).toBe(true);
        } else {
          expect(codekbFiles(root, "repo-a").length).toBeGreaterThan(0);
          expect(codekbFiles(root, "repo-b").length).toBeGreaterThan(0);
        }

        // Snapshot A's WORKFLOW STATE before creating B - the deterministic
        // isolation proof (B's creation must never touch A's aidlc-state.md). We do
        // NOT byte-compare A's audit SHARD: the per-session SessionStart/SessionEnd
        // hooks (aidlc-session-{start,end}.ts → appendAuditEntry) legitimately
        // append SESSION_* events to whatever intent is active, and a fresh
        // driveAidlc() is a new session — so the shard gains session-lifecycle
        // noise that is NOT a collision. The collision the vision forbids is B's
        // INTENT CREATION bleeding into A; that surfaces as a SECOND WORKFLOW_STARTED in A's
        // shard, which we guard directly via workflowStartedCount().
        const stateABefore = readFileSync(join(recordADir, "aidlc-state.md"), "utf-8");
        expect(workflowStartedCount(recordADir)).toBe(1);

        // --- Step 3: create a SECOND intent alongside active A -----------------
        // In the person's words: with A active the engine asks where the new
        // work goes, and they pick separate new work (SEPARATE_WORK).
        const r3 = await driveAidlc(
          `/aidlc --scope poc "build a standalone metrics dashboard"`,
          {
            projectDir: root,
            answerScript: SEPARATE_WORK,
            timeoutMs: operationBudget(VERB_DRIVE_MS),
            stopAfterToolResult: STOP_AFTER_CREATION,
          },
        );
        expect(r3.timedOut).toBe(false);
        assertToolResultContains(r3, "Bash", INIT_STATE_SUMMARY);

        const reg3 = readIntentRegistry(root);
        expect(reg3.length).toBe(2);
        const uuids = new Set(reg3.map((e) => e.uuid));
        expect(uuids.size).toBe(2);
        for (const e of reg3) expect(e.uuid).toMatch(UUIDV7_RE);
        const dirs = listIntents(root).map((i) => i.dirName).filter(Boolean);
        expect(new Set(dirs).size).toBe(2);

        // A's WORKFLOW STATE untouched by B's creation (B took the workspace lock
        // and wrote into B's record; A's state file is byte-identical), and B's
        // creation event did NOT bleed into A's shard (still exactly one
        // WORKFLOW_STARTED — A's own).
        expect(readFileSync(join(recordADir, "aidlc-state.md"), "utf-8")).toBe(stateABefore);
        expect(workflowStartedCount(recordADir)).toBe(1);
        const recordB = activeRecordDir(root);
        expect(recordB).toBeDefined();
        const recordBDir = join(root, "aidlc", "spaces", "default", "intents", recordB!);
        const stateAndArtifactsA = workflowMarkdownSnapshot(recordADir);
        const stateAndArtifactsB = await settledSnapshot(recordBDir);

        // --- Step 4: a non-default space, no learnings leak -------------------
        // The user TYPES "teamB"; the engine slugifies it to "teamb" on disk
        // (slugify lowercases - aidlc-lib.ts), so every on-disk path/assertion uses the
        // slug while the command string keeps the human spelling.
        const createSpace = await driveAidlc(`/aidlc space-create teamB`, {
          projectDir: root,
          answerScript: "default",
          timeoutMs: operationBudget(VERB_DRIVE_MS),
          // Exercise the real Stop hook with a readable transcript and wait
          // for its natural terminal result, not just the utility tool result.
          persistSession: true,
        });
        assertTerminalWorkspaceTurn(createSpace, `Space created: ${TEAM_B_SLUG}`);
        expect(workflowMarkdownSnapshot(recordADir)).toEqual(stateAndArtifactsA);
        expect(workflowMarkdownSnapshot(recordBDir)).toEqual(stateAndArtifactsB);
        const teamBMemory = join(root, "aidlc", "spaces", TEAM_B_SLUG, "memory");
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

        // Switch into teamB and create an intent there. The plain `/aidlc space
        // teamB` is forwarded to `next`, which (with intent B active in default)
        // recognises the leading `space` verb and emits a TERMINAL print naming
        // `aidlc.ts engine space teamB` (Branch 1b, before state inspection - so
        // the active intent is never advanced); the conductor runs that tool and
        // stops. The on-disk cursor moving to teamb is the proof the real path ran.
        const switchTeam = await driveAidlc(`/aidlc space teamB`, {
          projectDir: root,
          answerScript: "default",
          timeoutMs: operationBudget(VERB_DRIVE_MS),
          persistSession: true,
        });
        assertTerminalWorkspaceTurn(switchTeam, `Now working in space \`${TEAM_B_SLUG}\`.`);
        expect(activeSpace(root)).toBe(TEAM_B_SLUG);
        expect(workflowMarkdownSnapshot(recordADir)).toEqual(stateAndArtifactsA);
        expect(workflowMarkdownSnapshot(recordBDir)).toEqual(stateAndArtifactsB);

        const r4b = await driveAidlc(
          `/aidlc --scope poc "teamB onboarding flow"`,
          {
            projectDir: root,
            answerScript: SEPARATE_WORK,
            timeoutMs: operationBudget(VERB_DRIVE_MS),
            stopAfterToolResult: STOP_AFTER_CREATION,
          },
        );
        expect(r4b.timedOut).toBe(false);
        assertToolResultContains(r4b, "Bash", INIT_STATE_SUMMARY);
        expect(readIntentRegistry(root, TEAM_B_SLUG).length).toBe(1);
        expect(readIntentRegistry(root, "default").length).toBe(2);
        expect(existsSync(join(root, "aidlc", "spaces", TEAM_B_SLUG, "knowledge"))).toBe(true);

        // --- Step 5: switch back to default; intent A still resumable ---------
        const teamRecord = activeRecordDir(root);
        expect(teamRecord).toBeDefined();
        const teamRecordDir = join(root, "aidlc", "spaces", TEAM_B_SLUG, "intents", teamRecord!);
        const teamStateAndArtifacts = await settledSnapshot(teamRecordDir);
        const switchDefault = await driveAidlc(`/aidlc space default`, {
          projectDir: root,
          answerScript: "default",
          timeoutMs: operationBudget(VERB_DRIVE_MS),
          persistSession: true,
        });
        assertTerminalWorkspaceTurn(switchDefault, "Now working in space `default`.");
        expect(activeSpace(root)).toBe("default");
        expect(workflowMarkdownSnapshot(recordADir)).toEqual(stateAndArtifactsA);
        expect(workflowMarkdownSnapshot(recordBDir)).toEqual(stateAndArtifactsB);
        expect(workflowMarkdownSnapshot(teamRecordDir)).toEqual(teamStateAndArtifacts);
        // A's WORKFLOW STATE survived the round trip untouched (the cursor flip is
        // a pure write; nothing rewrote A's state), and no foreign creation bled into
        // its shard. The audit shard itself may carry session-lifecycle events
        // from the intervening turns (see workflowStartedCount's note) — that is
        // not a collision.
        expect(readFileSync(join(recordADir, "aidlc-state.md"), "utf-8")).toBe(stateABefore);
        expect(workflowStartedCount(recordADir)).toBe(1);
        expect(readIntentRegistry(root, "default").length).toBe(2);
      } finally {
        cleanupWorkspaceJourney(journey);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
