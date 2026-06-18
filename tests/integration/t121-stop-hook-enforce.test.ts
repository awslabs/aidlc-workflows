// covers: hook:aidlc-stop
//
// Behavioural contract for the Stop hook `aidlc-stop.ts` — the framework's
// FIRST flow-altering hook. Migrated from tests/integration/t121-stop-hook-enforce.sh
// (originally TAP plan 13; now 16 named tests — the original 13 .sh assertions
// plus the three (e) human-wait carve-out cases added with that feature).
// Mechanism: cli. The hook's entire contract lives on the
// PROCESS boundary — it reads Claude Code JSON off stdin, resolves the project
// via CLAUDE_PROJECT_DIR, spawns a sub-engine (`aidlc-orchestrate.ts next`)
// via Bun.spawnSync, and answers by writing {"decision":"block",...} to stdout
// (or nothing) and exiting 0. There is no exported function to call in-process;
// the seam is the spawn, stdin, env, stdout, exit code, and the on-disk guard
// file. So like the .sh we spawn the REAL hook with a MOCK engine placed at
// <proj>/.claude/tools/aidlc-orchestrate.ts whose emitted directive `kind` is
// driven by MOCK_KIND. This isolates the hook's block/done/guard logic from
// engine correctness (the engine has its own corpus in t114/t118).
//
// Source under test (dist/claude/.claude/hooks/aidlc-stop.ts):
//   :97  allowStop()       — emit nothing, exit 0 (the precedent non-blocking pattern)
//   :104 blockStop(reason) — console.log({decision:"block",reason}); exit 0
//   :129 guardFilePath()   — aidlc-docs/.aidlc-stop-hook/block-count.json
//   :137 progressSignature(state) — `${Current-Stage}::${audit-line-count}`
//   :204 decideBlock(state, stopHookActive) — the no-progress counter + cap logic:
//          - sameSignature  → nextCount = prior.count + 1
//          - prior===null && stopHookActive → nextCount = 2 (joining mid-flight)
//          - else → nextCount = 1
//          - persist; RELEASE (return false) once nextCount >= cap, else block
//   :259 runEngineNextKind() — spawns the engine; null (spawn fail / non-zero /
//          unparseable) fails OPEN (allow)
//   :298 continuationReason(kind, stage) — names "pending step", the kind, the
//          forwarding-loop steps; phrased as continuation, never override-shaped
//   :314 isTTY → allowStop; :321 no aidlc-state.md → allowStop; :356 done →
//          resetGuard + allowStop; :336 garbage stdin → stopHookActive=false (no crash)
//   blockCap() :68 — CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (default 8)
//
// Old TAP -> new test parity (13 .sh assertions -> 13 named tests, several
// STRONGER — exact-shape JSON parse, no override-verbs scan, block,block,
// RELEASE,RELEASE sequence, persisted-counter reset):
//   .sh (a) assert RC=0 on pending           -> "(a) exits 0 on a pending directive"
//   .sh (a) decision:block in stdout         -> "(a) pending run-stage directive emits decision:block"
//   .sh (a) reason names pending work + kind  -> "(a) reason names the pending run-stage work as on-task continuation"
//   .sh (a) reason re-feeds loop, no override -> "(a) reason is a sanctioned continuation (re-feeds the loop, no override verbs)"
//   .sh (b) assert RC=0 on done               -> "(b) done directive exits 0"
//   .sh (b) done => empty stdout              -> "(b) done directive emits nothing (stop allowed)"
//   .sh (c1) RC=0 at ceiling                  -> "(c1) recursion guard at ceiling exits 0"
//   .sh (c1) cap8 + stop_hook_active releases -> "(c1) counter at default cap (8) + stop_hook_active releases (no block)"
//   .sh (c2) block,block,RELEASE,RELEASE       -> "(c2) no-progress streak (cap 3) flips at the cap and stays released"
//   .sh (c3) progress resets streak to 1      -> "(c3) progress (stage pivot) resets the no-progress streak to 1"
//   .sh (d) RC=0 with no state file           -> "(d) no aidlc-state.md exits 0"
//   .sh (d) no-op outside AIDLC => empty       -> "(d) no active workflow emits nothing (non-AIDLC session never blocked)"
//   .sh robustness (3 fail-open sub-cases)    -> "garbage stdin + unparseable engine output fail OPEN"
//
// NEW (no .sh predecessor) — the tier-1 human-wait carve-out. The hook reads
// the current stage's checkbox state (exported parseCheckboxes, aidlc-lib.ts
// :587) and ALLOWS the stop when it is positively [?]/[R], so an interactive
// gate / Request-Changes pause no longer spams the forwarding-loop nudge:
//   (e) [?] awaiting-approval -> ALLOW (run-stage pending, but human-wait)
//   (e) [R] revising          -> ALLOW (Request-Changes loop, human-wait)
//   (e) [-] in-progress       -> BLOCK (positive-only; not widened into [-])
//
// §6-E note: this is a non-golden twin (a flow-altering hook whose block event
// must ACTUALLY FIRE). Cases (a)/(c2) drive the BLOCK path to real
// {"decision":"block"} stdout; the guard/release/fail-open cases prove the hook
// lets go — a happy-path-only twin would not be equal-or-stronger.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test (mirrors t104)
const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOK_TS = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "hooks",
  "aidlc-stop.ts",
);

// P9 per-intent layout: the stop hook reads state (stateFilePath), the audit
// (auditFilePath — its own resolved shard, for the progress-signature length),
// the guard counter (stopHookDir → <record>/.aidlc-stop-hook/block-count.json),
// and the current stage's memory/questions dir (<record>/<phase>/<slug>/). All
// re-root under the active intent's record. We PIN the clone-id so the hook
// (subprocess) and progressSig (in-process) resolve the SAME audit shard.
const PINNED_CLONE_ID = "testcloneid121";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}
function pinnedShardPath(proj: string): string {
  return join(seededAuditDir(proj), pinnedShardName());
}
/** Seed the per-intent workspace shell + pin the clone-id (mirrors fixtures.ts
 *  seedWorkspaceShell). */
function seedShell(proj: string): void {
  const intentsDir = intentsDirOf(proj, DEFAULT_SPACE);
  mkdirSync(join(proj, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(proj), { recursive: true });
  writeFileSync(join(proj, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [{ uuid: "00000000-0000-7000-8000-000000000001", slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" }],
      null,
      2,
    )}\n`,
    "utf-8",
  );
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
}

// The stop-hook guard counter, re-rooted under the record (stopHookDir).
function guardFilePath(proj: string): string {
  return join(seededRecordDir(proj), ".aidlc-stop-hook", "block-count.json");
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// The MOCK engine, byte-for-byte the .sh's heredoc: emit one directive of
// kind=$MOCK_KIND. `done` carries the terminal shape; `__nonzero__` simulates
// an engine that fails to answer (non-zero exit, no directive). The hook
// spawns this via join(projectDir, ".claude/tools/aidlc-orchestrate.ts").
const MOCK_ENGINE = `// t121 mock engine: emit one directive of kind=$MOCK_KIND.
const kind = process.env.MOCK_KIND ?? "run-stage";
if (kind === "done") {
  console.log(JSON.stringify({ kind: "done", reason: "Workflow complete." }));
} else if (kind === "__nonzero__") {
  process.stderr.write("mock engine failure\\n");
  process.exit(1);
} else {
  console.log(JSON.stringify({ kind, stage: "requirements-analysis" }));
}
process.exit(0);
`;

/** A self-contained project with a MOCK engine + the per-intent shell (so the
 *  stop hook's state/audit/guard/memory paths resolve under the record). Mirrors
 *  make_project (.sh). */
function makeProject(): string {
  const proj = mkdtempSync(join(tmpdir(), "aidlc-t121-"));
  tempDirs.push(proj);
  mkdirSync(join(proj, ".claude", "tools"), { recursive: true });
  writeFileSync(
    join(proj, ".claude", "tools", "aidlc-orchestrate.ts"),
    MOCK_ENGINE,
    "utf-8",
  );
  seedShell(proj);
  return proj;
}

/** Write the audit fixture into the pinned per-clone shard (the stop hook reads
 *  auditFilePath(projectDir) — that exact shard — for the progress signature). */
function seedAuditShard(proj: string, body = "audit row 1\n"): void {
  mkdirSync(seededAuditDir(proj), { recursive: true });
  writeFileSync(pinnedShardPath(proj), body, "utf-8");
}

/** Seed an active mid-stage workflow so the hook reaches the engine call. */
function seedActive(proj: string, slug = "requirements-analysis"): void {
  writeFileSync(
    seededStateFile(proj),
    `- **Workflow**: feature\n- **Scope**: feature\n- **Current Stage**: ${slug}\n`,
    "utf-8",
  );
  seedAuditShard(proj);
}

/**
 * Seed an active workflow whose Current Stage ALSO carries a checkbox row in a
 * given state — the shape the tier-1 human-wait carve-out reads. `marker` is the
 * raw checkbox glyph ("?" awaiting-approval, "R" revising, "-" in-progress); the
 * row matches parseCheckboxes' `^- \[([ xSR?-])\] (\S+)\s*—\s*(.*)$` grammar
 * (aidlc-lib.ts:589 — note the em-dash). seedActive's stateless shape (no rows)
 * remains the default the 13 legacy assertions use, which is exactly why they
 * stay green: parseCheckboxes returns [] and the carve-out cannot trigger.
 */
function seedActiveWithCheckbox(
  proj: string,
  marker: string,
  slug = "requirements-analysis",
): void {
  writeFileSync(
    seededStateFile(proj),
    `- **Workflow**: feature\n- **Scope**: feature\n- **Current Stage**: ${slug}\n` +
      `\n## Stage Progress\n- [${marker}] ${slug} — EXECUTE\n`,
    "utf-8",
  );
  seedAuditShard(proj);
}

/**
 * Seed an active workflow at [-] in-progress for the tier-2 pending-question
 * carve-out. Writes Lifecycle Phase (so the hook can derive the stage dir
 * `aidlc-docs/<phase-lowercase>/<slug>/`, mirroring memoryPathFor in
 * aidlc-orchestrate.ts:353) and a `[-]` checkbox row. Options:
 *   - `questions`: if given, writes `<slug>-questions.md` in the stage dir with
 *     this body (a blank `[Answer]:` tag = a pending question; an answered one
 *     = resolved). Omit to seed NO questions file.
 *   - `autonomy`: if given, writes `- **Construction Autonomy Mode**: <value>`
 *     into state — `"autonomous"` must suppress the carve-out (loop stays alive).
 * `phase` defaults to inception (requirements-analysis' real phase).
 */
function seedInProgressWithQuestions(
  proj: string,
  opts: { slug?: string; phase?: string; questions?: string; autonomy?: string } = {},
): void {
  const slug = opts.slug ?? "requirements-analysis";
  const phase = opts.phase ?? "inception";
  const autonomyLine = opts.autonomy
    ? `- **Construction Autonomy Mode**: ${opts.autonomy}\n`
    : "";
  writeFileSync(
    seededStateFile(proj),
    `- **Workflow**: feature\n- **Scope**: feature\n- **Lifecycle Phase**: ${phase.toUpperCase()}\n` +
      `- **Current Stage**: ${slug}\n${autonomyLine}` +
      `\n## Stage Progress\n- [-] ${slug} — EXECUTE\n`,
    "utf-8",
  );
  seedAuditShard(proj);
  if (opts.questions !== undefined) {
    // The stage's questions/memory dir re-roots under the record (<record>/<phase>/<slug>/).
    const stageDir = join(seededRecordDir(proj), phase.toLowerCase(), slug);
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, `${slug}-questions.md`), opts.questions, "utf-8");
  }
}

interface HookResult {
  rc: number;
  out: string; // stdout only (the .sh discarded stderr with 2>/dev/null)
}

/**
 * Run the real hook. Mirrors run_hook (.sh): pipe `payload` on stdin with
 * CLAUDE_PROJECT_DIR / MOCK_KIND / CLAUDE_CODE_STOP_HOOK_BLOCK_CAP set, capture
 * stdout, return exit code. `cap` empty-string => env var unset (default cap).
 */
function runHook(
  proj: string,
  payload: string,
  kind = "run-stage",
  cap = "",
): HookResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: proj,
    MOCK_KIND: kind,
  };
  // The .sh always exported CLAUDE_CODE_STOP_HOOK_BLOCK_CAP (possibly empty).
  // An empty value is falsy in blockCap() (:69 `if (!raw)`), so it behaves
  // exactly like unset — the default cap of 8. Pass it through for parity.
  env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = cap;
  // The hook reads stdin + env only; it ignores argv (mirrors the .sh's bare
  // `bun "$HOOK_TS"`).
  const res = spawnSync(BUN, [HOOK_TS], {
    input: payload,
    encoding: "utf-8",
    env,
    timeout: 20_000,
  });
  return { rc: res.status ?? -1, out: (res.stdout ?? "").trim() };
}

/**
 * The hook's progress signature for a project — Current Stage + audit line
 * count — so a test can seed the counter at the matching key. Mirrors the
 * .sh's progress_sig (and aidlc-stop.ts:137 progressSignature).
 */
function progressSig(proj: string): string {
  const s = readFileSync(seededStateFile(proj), "utf-8");
  const m = s.match(/Current Stage\*{0,2}:?\s*`?([^\n`]*)`?/);
  const stage = (m?.[1] ?? "").trim();
  let al = 0;
  try {
    // The hook reads its own resolved shard (auditFilePath); with the pinned
    // clone-id that is exactly the pinned shard, so read the same one.
    al = readFileSync(pinnedShardPath(proj), "utf-8").split("\n").length;
  } catch {
    /* audit absent => 0 */
  }
  return `${stage}::${al}`;
}

/** Read the persisted no-progress counter (or null if missing/corrupt). */
function guardCount(proj: string): number | null {
  try {
    return JSON.parse(readFileSync(guardFilePath(proj), "utf-8")).count as number;
  } catch {
    return null;
  }
}

describe("t121 aidlc-stop hook — forwarding-loop enforcement (migrated from t121-stop-hook-enforce.sh, plan 13 + 3 human-wait carve-out cases)", () => {
  // =========================================================================
  // (a) Pending directive -> BLOCK + re-fed via reason. The block event MUST
  //     actually fire (§6-E non-golden).
  // =========================================================================
  test("(a) exits 0 on a pending directive (block is via stdout, not exit code)", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
  }, 30000);

  test("(a) pending run-stage directive emits {\"decision\":\"block\"} on stdout", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    // STRONGER than the .sh's substring grep: parse the JSON and assert the
    // exact decision field shape blockStop() writes (aidlc-stop.ts:105).
    const parsed = JSON.parse(r.out) as { decision?: string; reason?: string };
    expect(parsed.decision).toBe("block");
    expect(typeof parsed.reason).toBe("string");
  }, 30000);

  test("(a) reason names the pending run-stage work as on-task continuation", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    const reason = (JSON.parse(r.out) as { reason: string }).reason;
    // .sh: grep '"reason"' && 'pending step' && 'run-stage'. Here all three
    // assert against the parsed reason string (continuationReason :298-307).
    expect(reason).toContain("pending step");
    expect(reason).toContain("run-stage");
    // The directive's stage context is carried into the continuation too.
    expect(reason).toContain("requirements-analysis");
  }, 30000);

  test("(a) reason is a sanctioned continuation (re-feeds the loop, no override verbs)", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    const reason = (JSON.parse(r.out) as { reason: string }).reason;
    // Security property (aidlc-stop.ts:22-27): re-feeds the loop (names the
    // engine), NEVER an override-shaped instruction.
    expect(reason).toContain("aidlc-orchestrate");
    expect(/ignore|override|disregard|bypass/i.test(reason)).toBe(false);
  }, 30000);

  // =========================================================================
  // (b) `done` directive -> stop ALLOWED (no block, exit 0).
  // =========================================================================
  test("(b) done directive exits 0", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const r = runHook(proj, '{"stop_hook_active":false}', "done");
    expect(r.rc).toBe(0);
  }, 30000);

  test("(b) done directive emits nothing (stop allowed, no block)", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const r = runHook(proj, '{"stop_hook_active":false}', "done");
    expect(r.out).toBe("");
  }, 30000);

  // =========================================================================
  // (c) RECURSION GUARD — asserted hardest. The session must ALWAYS release.
  // =========================================================================
  // (c1) Seed the no-progress counter AT the default ceiling (8) with a
  // matching signature, then invoke with stop_hook_active:true. The hook MUST
  // release — a stuck loop can never trap a turn.
  test("(c1) recursion guard at ceiling exits 0", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    mkdirSync(join(seededRecordDir(proj), ".aidlc-stop-hook"), {
      recursive: true,
    });
    const sig = progressSig(proj);
    writeFileSync(
      guardFilePath(proj),
      JSON.stringify({ signature: sig, count: 8 }),
      "utf-8",
    );
    const r = runHook(proj, '{"stop_hook_active":true}', "run-stage"); // default cap 8
    expect(r.rc).toBe(0);
  }, 30000);

  test("(c1) counter at default cap (8) + stop_hook_active:true releases (no block) — session NOT trapped", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    mkdirSync(join(seededRecordDir(proj), ".aidlc-stop-hook"), {
      recursive: true,
    });
    const sig = progressSig(proj);
    writeFileSync(
      guardFilePath(proj),
      JSON.stringify({ signature: sig, count: 8 }),
      "utf-8",
    );
    const r = runHook(proj, '{"stop_hook_active":true}', "run-stage");
    // sameSignature => nextCount = 8 + 1 = 9 >= cap 8 => RELEASE (decideBlock
    // :231). No block on stdout.
    expect(r.out).toBe("");
  }, 30000);

  // (c2) Drive consecutive no-progress blocks to a low ceiling and prove the
  // hook flips from BLOCK to ALLOW exactly at the cap, and STAYS released.
  test("(c2) no-progress streak (cap 3): block,block,RELEASE,RELEASE — flips at the cap and stays released", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // cap=3, stop_hook_active false so the streak is driven purely by the
    // unchanged signature (no report ran between invocations).
    const b1 = runHook(proj, '{"stop_hook_active":false}', "run-stage", "3");
    const b2 = runHook(proj, '{"stop_hook_active":false}', "run-stage", "3");
    const b3 = runHook(proj, '{"stop_hook_active":false}', "run-stage", "3");
    const b4 = runHook(proj, '{"stop_hook_active":false}', "run-stage", "3");
    // counts go 1 (block), 2 (block), 3 (>=cap -> RELEASE), 4 (RELEASE).
    expect(b1.out).toContain("block");
    expect(b2.out).toContain("block");
    expect(b3.out).toBe("");
    expect(b4.out).toBe("");
    // STRONGER: the first two are real, parseable block decisions.
    expect((JSON.parse(b1.out) as { decision: string }).decision).toBe("block");
    expect((JSON.parse(b2.out) as { decision: string }).decision).toBe("block");
  }, 30000);

  // (c3) PROGRESS resets the streak — a healthy loop is never throttled even
  // when stop_hook_active stays true. Block twice at stage-a, then pivot the
  // stage + grow the audit (a report's effect): the counter resets to 1.
  test("(c3) progress (stage pivot) resets the no-progress streak to 1 — healthy loop never throttled", () => {
    const proj = makeProject();
    seedActive(proj, "stage-a");
    runHook(proj, '{"stop_hook_active":true}', "run-stage", "8");
    runHook(proj, '{"stop_hook_active":true}', "run-stage", "8");
    const countBefore = guardCount(proj);
    // Simulate a report landing: Current Stage pivots, the audit shard grows.
    writeFileSync(
      seededStateFile(proj),
      "- **Workflow**: feature\n- **Scope**: feature\n- **Current Stage**: stage-b\n",
      "utf-8",
    );
    seedAuditShard(proj, "audit row 1\naudit row 2\n");
    runHook(proj, '{"stop_hook_active":true}', "run-stage", "8");
    const countAfter = guardCount(proj);
    // .sh: count_after == 1 && count_before != 1. After two no-progress blocks
    // at stage-a the streak climbed past 1; the pivot resets it to 1.
    expect(countAfter).toBe(1);
    expect(countBefore).not.toBe(1);
  }, 30000);

  // =========================================================================
  // (d) No-op outside AIDLC — no state file -> exit 0, no block.
  // =========================================================================
  test("(d) no aidlc-state.md exits 0", () => {
    const proj = makeProject(); // NO seedActive => no aidlc-state.md
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
  }, 30000);

  test("(d) no active workflow emits nothing (non-AIDLC session is never blocked)", () => {
    const proj = makeProject();
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.out).toBe("");
  }, 30000);

  // =========================================================================
  // (e) HUMAN-WAIT CARVE-OUT — when the current stage is positively in a
  // human-wait checkbox state ([?] awaiting-approval / [R] revising) the
  // conductor is correctly parked on the human, so the hook ALLOWS the stop
  // even though the engine still returns a pending run-stage. Tier 1 only:
  // [-] in-progress and stateless cases are NOT carved out (positive-only),
  // so a genuine mid-stage quit is still nudged by the cap-bounded block.
  // =========================================================================
  test("(e) current stage awaiting-approval [?] allows the stop (human-wait carve-out)", () => {
    const proj = makeProject();
    // Engine still says run-stage (pending) — the carve-out is what releases,
    // not the engine. The [?] row for the current slug is the positive signal.
    seedActiveWithCheckbox(proj, "?", "requirements-analysis");
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
    expect(r.out).toBe(""); // allowed: empty stdout, no decision:block
  }, 30000);

  test("(e) current stage revising [R] allows the stop (human-wait carve-out)", () => {
    const proj = makeProject();
    seedActiveWithCheckbox(proj, "R", "requirements-analysis");
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
    expect(r.out).toBe("");
  }, 30000);

  test("(e) carve-out is positive-only — [-] in-progress still BLOCKS (cap is the only release)", () => {
    const proj = makeProject();
    // [-] in-progress is ALSO the normal 'stage work still owed' state — a
    // blanket carve-out here would gut the hook. It must still block (today's
    // behaviour); only the no-progress cap releases it. This pins that tier-1
    // did NOT widen into in-progress.
    seedActiveWithCheckbox(proj, "-", "requirements-analysis");
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
    const parsed = JSON.parse(r.out) as { decision?: string };
    expect(parsed.decision).toBe("block");
  }, 30000);

  // =========================================================================
  // (f) TIER-2 PENDING-QUESTION CARVE-OUT — a mid-stage [-] stage with a
  // questions file that has an UNANSWERED [Answer]: tag means the conductor is
  // parked on the human (a clarifying question), so allow the stop. Strictly
  // gated: (1) a blank/underscore [Answer]: must exist, (2) the workflow must
  // NOT be in autonomous Construction (where the loop must keep running). Any
  // miss → fall through to the cap-bounded block. This closes the [-] gap the
  // tier-1 comment flagged as a follow-up, without touching autonomous runs.
  // =========================================================================
  test("(f) [-] with a blank [Answer]: question allows the stop (pending-question carve-out)", () => {
    const proj = makeProject();
    seedInProgressWithQuestions(proj, {
      questions: "# Questions\n\n## Q1\nWhich URL scheme?\n[Answer]:\n",
    });
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
    expect(r.out).toBe(""); // allowed — a question is genuinely pending
  }, 30000);

  test("(f) [-] with an underscore-only [Answer]: also allows (treated as blank)", () => {
    const proj = makeProject();
    seedInProgressWithQuestions(proj, {
      questions: "# Questions\n\n## Q1\nWhich URL scheme?\n[Answer]: ____\n",
    });
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
    expect(r.out).toBe("");
  }, 30000);

  test("(f) [-] with an ANSWERED question still BLOCKS (no pending question)", () => {
    const proj = makeProject();
    seedInProgressWithQuestions(proj, {
      questions: "# Questions\n\n## Q1\nWhich URL scheme?\n[Answer]: A\n",
    });
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(f) [-] with NO questions file still BLOCKS (a genuine mid-stage quit)", () => {
    const proj = makeProject();
    seedInProgressWithQuestions(proj, {}); // no questions file written
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(f) AUTONOMY GUARD — [-] + blank question BUT Construction Autonomy Mode=autonomous still BLOCKS", () => {
    const proj = makeProject();
    // The exact regression the autonomy gate prevents: in an autonomous
    // Construction run the loop must keep moving even with a stray open
    // question. A blank [Answer]: must NOT release the stop here.
    seedInProgressWithQuestions(proj, {
      slug: "code-generation",
      phase: "construction",
      autonomy: "autonomous",
      questions: "# Questions\n\n## Q1\nEdge case?\n[Answer]:\n",
    });
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(f) gated Construction — [-] + blank question DOES allow (autonomy not granted)", () => {
    const proj = makeProject();
    // The complement: same Construction stage, but autonomy is 'gated' (or
    // unset) → the human is in the loop, so a pending question releases.
    seedInProgressWithQuestions(proj, {
      slug: "code-generation",
      phase: "construction",
      autonomy: "gated",
      questions: "# Questions\n\n## Q1\nEdge case?\n[Answer]:\n",
    });
    const r = runHook(proj, '{"stop_hook_active":false}', "run-stage");
    expect(r.rc).toBe(0);
    expect(r.out).toBe("");
  }, 30000);

  // =========================================================================
  // Robustness — garbage stdin must never crash and never trap (fail open).
  // Empty / malformed / truncated JSON and an engine that fails to answer all
  // ALLOW (exit 0, no block), even mid-stage.
  // =========================================================================
  test("garbage stdin + unparseable engine output fail OPEN (exit 0, no block) — never crash, never trap", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");

    // malformed JSON with a done engine -> allow (no crash).
    const m = runHook(proj, "this is not json", "done");
    expect(m.rc).toBe(0);
    expect(m.out).toBe("");

    // truncated JSON with a done engine -> allow.
    const t = runHook(proj, '{"stop_hook_active":', "done");
    expect(t.rc).toBe(0);
    expect(t.out).toBe("");

    // engine returns non-zero / no directive -> fail open (allow), even
    // mid-stage. runEngineNextKind() returns null on non-zero exit (:274).
    const n = runHook(proj, '{"stop_hook_active":false}', "__nonzero__");
    expect(n.rc).toBe(0);
    expect(n.out).toBe("");
  }, 30000);
});
