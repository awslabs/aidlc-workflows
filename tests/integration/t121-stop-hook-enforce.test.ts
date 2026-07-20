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
//   :259 runEngineNextDirective() — spawns the engine; null (spawn fail / non-zero /
//          unparseable) fails OPEN (allow)
//   :298 continuationReason(kind, stage) — names "pending step", the kind, the
//          forwarding-loop steps; phrased as continuation, never override-shaped
//   :314 isTTY → allowStop; :321 no aidlc-state.md → allowStop; :356 done →
//          resetGuard + allowStop; :336 garbage stdin → stopHookActive=false (no crash)
//   blockCap() :122 (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP overrides); the default is
//          now RUN-MODE aware (defaultBlockCap :131): 8 for autonomous
//          Construction (AUTONOMOUS_BLOCK_CAP), 2 otherwise (INTERACTIVE_BLOCK_CAP)
//   isConversationalStop() :599 / transcriptIsConversational() :490 /
//          isEngineToolCall() :474: the tier-3 conversational carve-out reads
//          the harness transcript (Claude / Codex) and ALLOWS when the most
//          recent human prompt was answered with NO workflow-engine call
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
// NEW (the tier-3 conversational carve-out + the run-mode-aware default cap,
// issue #365 broader reading). The hook reads the harness transcript
// (Claude / Codex) and ALLOWS when the human's last prompt was answered with NO
// workflow-engine call; the default block cap is 2 interactive / 8 autonomous:
//   (f) Claude chat transcript (TEXT-only answer)        -> ALLOW (conversational)
//   (f) Claude transcript + aidlc-orchestrate Bash call  -> BLOCK (engine engaged)
//   (f) Codex rollout chat transcript                    -> ALLOW (codex reader)
//   (f) Codex rollout + function_call aidlc-orchestrate  -> BLOCK
//   (f) chat transcript under autonomous Construction    -> BLOCK (carve-out off)
//   (f) autonomous cap is 8 (count 2 + stop_hook_active) -> BLOCK (not interactive 2)
//   (f) transcript_path -> nonexistent file              -> BLOCK (fail-closed, count 1)
//   (g) interactive default cap 2: block then RELEASE at the 2nd no-progress
//   (g) autonomous default cap 8: same sequence blocks 1-7, releases only at 8
//
// §6-E note: this is a non-golden twin (a flow-altering hook whose block event
// must ACTUALLY FIRE). Cases (a)/(c2) drive the BLOCK path to real
// {"decision":"block"} stdout; the guard/release/fail-open cases prove the hook
// lets go — a happy-path-only twin would not be equal-or-stronger.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
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
// and the current stage's canonical or per-unit memory/questions dir. All
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
const stage = process.env.MOCK_STAGE ?? "requirements-analysis";
const unit = process.env.MOCK_UNIT ?? "";
if (kind === "done") {
  console.log(JSON.stringify({ kind: "done", reason: "Workflow complete." }));
} else if (kind === "parked") {
  console.log(JSON.stringify({ kind: "parked", reason: "Workflow parked at \\"requirements-analysis\\".", stage }));
} else if (kind === "__nonzero__") {
  process.stderr.write("mock engine failure\\n");
  process.exit(1);
} else {
  console.log(JSON.stringify({ kind, stage, ...(unit ? { unit } : {}) }));
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
 * carve-out. Writes Lifecycle Phase (so the hook can derive the canonical or
 * per-unit stage dir) and a `[-]` checkbox row. Options:
 *   - `questions`: if given, writes `<slug>-questions.md` in the stage dir with
 *     this body (a blank `[Answer]:` tag = a pending question; an answered one
 *     = resolved). Omit to seed NO questions file.
 *   - `unit`: if given for Construction, writes under the per-unit
 *     `<record>/construction/<unit>/<slug>/` layout and must also be returned by
 *     the mock engine for the hook to select that exact directory.
 *   - `autonomy`: if given, writes `- **Construction Autonomy Mode**: <value>`
 *     into state — `"autonomous"` must suppress the carve-out (loop stays alive).
 * `phase` defaults to inception (requirements-analysis' real phase).
 */
function seedInProgressWithQuestions(
  proj: string,
  opts: {
    slug?: string;
    phase?: string;
    questions?: string;
    autonomy?: string;
    unit?: string;
  } = {},
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
    // The stage's questions dir re-roots under the record.
    const stageDir = opts.unit
      ? join(seededRecordDir(proj), phase.toLowerCase(), opts.unit, slug)
      : join(seededRecordDir(proj), phase.toLowerCase(), slug);
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, `${slug}-questions.md`), opts.questions, "utf-8");
  }
}

/**
 * Write a harness transcript file under the project for the tier-3
 * conversational carve-out, and return its absolute path. The hook reads it off
 * the Stop payload's `transcript_path` and classifies the ending turn
 * (transcriptIsConversational, aidlc-stop.ts:490). Two formats:
 *   - "claude": message-shaped JSONL. A genuine human prompt is
 *     `{type:"user",message:{role:"user",content:"..."}}` (string or a [{type:"text"}]
 *     array; a [{type:"tool_result"}] array is NOT a human prompt). An assistant
 *     turn is `{type:"assistant",message:{role:"assistant",content:[...]}}`; an
 *     engine call is a `tool_use` Bash running aidlc-orchestrate/aidlc-state.
 *   - "codex": rollout JSONL, `{type:"response_item",payload:{...}}`. A human
 *     prompt is `payload:{type:"message",role:"user",content:[{type:"input_text"}]}`;
 *     an engine call is `payload:{type:"function_call",name:"Bash",arguments:"<json>"}`.
 * The file basename matters for codex: the hook picks the codex reader ONLY when
 * the path ends in `rollout-*.jsonl` (aidlc-stop.ts:721), so the codex variant is
 * written as `rollout-<stamp>.jsonl` and the claude variant as `transcript.jsonl`.
 *
 * `engineCall`: when false the assistant answers the human with TEXT only (a
 * conversational turn -> ALLOW); when true the assistant runs an
 * aidlc-orchestrate Bash call after the human prompt (engine engaged -> BLOCK).
 */
function seedTranscript(
  proj: string,
  opts: { format: "claude" | "codex"; engineCall: boolean },
): string {
  let body: string;
  let name: string;
  if (opts.format === "claude") {
    name = "transcript.jsonl";
    const human = JSON.stringify({
      type: "user",
      message: { role: "user", content: "What does this stage actually do?" },
    });
    const assistant = opts.engineCall
      ? JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "bun .claude/tools/aidlc-orchestrate.ts next" },
              },
            ],
          },
        })
      : JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "It analyses the requirements." }],
          },
        });
    body = `${human}\n${assistant}\n`;
  } else {
    // Codex rollout: the basename MUST end in rollout-*.jsonl for the hook to
    // select the codex reader.
    name = "rollout-2026-06-26T00-00-00.jsonl";
    const human = JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Explain what this stage does." }],
      },
    });
    const assistant = opts.engineCall
      ? JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "Bash",
            arguments: JSON.stringify({
              command: "bun .codex/tools/aidlc-orchestrate.ts next",
            }),
          },
        })
      : JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "It analyses the requirements." }],
          },
        });
    body = `${human}\n${assistant}\n`;
  }
  const path = join(proj, name);
  writeFileSync(path, body, "utf-8");
  return path;
}

/**
 * A flexible transcript builder for the (h) classifier-refinement cases. Where
 * seedTranscript above writes a fixed 2-entry shape, this one takes an ORDERED
 * list of high-level entries and emits the matching JSONL line per harness, so a
 * single test can model multi-turn transcripts (a human prompt, the hook's own
 * isMeta re-prompt, an engine call with a specific command, plain text, ...).
 *
 * Entry kinds (the hook's transcriptIsConversational classifies them via
 * isEngineToolCall, aidlc-stop.ts:474/508):
 *   - {kind:"human", text}        a genuine human prompt (the anchor the hook
 *                                 answers; string content).
 *   - {kind:"text"}               an assistant TEXT-only turn (no engine call).
 *   - {kind:"bash", command}      an assistant turn that runs a Bash tool with
 *                                 `command`; the hook routes the command string
 *                                 through isEngineToolCall (read-only `--status`
 *                                 / `aidlc-utility` are NOT engagement; a bare
 *                                 `next` / `report` / `aidlc-state approve` ARE).
 *   - {kind:"meta", text}         a `type:"user"` entry with `isMeta:true`
 *                                 (Claude only): the Stop hook's own injected
 *                                 continuation, which the classifier must SKIP
 *                                 so it does not reset the human-prompt anchor.
 *   - {kind:"userText", text}     a `type:"user"` entry WITHOUT isMeta (Claude)
 *                                 / a plain user message (Codex). Used to model
 *                                 the hook-feedback turn excluded purely by its
 *                                 "Stop hook feedback:" content prefix.
 *
 * Mirrors seedTranscript's file-naming contract: the codex variant is written as
 * `rollout-*.jsonl` (so the hook picks the codex reader, aidlc-stop.ts:792); the
 * claude variant as `transcript.jsonl`.
 */
type TranscriptEntry =
  | { kind: "human"; text: string }
  | { kind: "text" }
  | { kind: "bash"; command: string }
  | { kind: "meta"; text: string }
  | { kind: "userText"; text: string };

function seedTranscriptEntries(
  proj: string,
  format: "claude" | "codex",
  entries: TranscriptEntry[],
): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (format === "claude") {
      switch (e.kind) {
        case "human":
          lines.push(
            JSON.stringify({ type: "user", message: { role: "user", content: e.text } }),
          );
          break;
        case "userText":
          // A type:"user" entry with NO isMeta, excluded only if its content
          // starts with "Stop hook feedback:" (the content guard).
          lines.push(
            JSON.stringify({ type: "user", message: { role: "user", content: e.text } }),
          );
          break;
        case "meta":
          // The Stop hook's own re-prompt: isMeta:true AND the content prefix.
          lines.push(
            JSON.stringify({
              type: "user",
              isMeta: true,
              message: { role: "user", content: e.text },
            }),
          );
          break;
        case "text":
          lines.push(
            JSON.stringify({
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Sure, here is the answer."}],
              },
            }),
          );
          break;
        case "bash":
          lines.push(
            JSON.stringify({
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "tool_use", name: "Bash", input: { command: e.command } }],
              },
            }),
          );
          break;
      }
    } else {
      switch (e.kind) {
        case "human":
        case "userText":
          lines.push(
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: e.text }],
              },
            }),
          );
          break;
        case "meta":
          // Codex has no isMeta flag; the hook excludes the hook-feedback turn by
          // its content prefix only, so a "meta" entry on codex is a plain user
          // message whose text carries the "Stop hook feedback:" prefix.
          lines.push(
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: e.text }],
              },
            }),
          );
          break;
        case "text":
          lines.push(
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Sure, here is the answer."}],
              },
            }),
          );
          break;
        case "bash":
          lines.push(
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "function_call",
                name: "Bash",
                arguments: JSON.stringify({ command: e.command }),
              },
            }),
          );
          break;
      }
    }
  }
  const name = format === "codex" ? "rollout-2026-06-26T00-00-00.jsonl" : "transcript.jsonl";
  const path = join(proj, name);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
  return path;
}

interface HookResult {
  rc: number;
  out: string; // stdout only (the .sh discarded stderr with 2>/dev/null)
}

/**
 * Run the real hook. Mirrors run_hook (.sh): pipe `payload` on stdin with
 * CLAUDE_PROJECT_DIR / MOCK_KIND / MOCK_UNIT /
 * CLAUDE_CODE_STOP_HOOK_BLOCK_CAP set, capture stdout, return exit code. `cap`
 * empty-string => env var unset (default cap).
 */
function runHook(
  proj: string,
  payload: string,
  kind = "run-stage",
  cap = "",
  unit = "",
): HookResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: proj,
    MOCK_KIND: kind,
    MOCK_UNIT: unit,
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
  // (b2) `parked` directive -> stop ALLOWED (no block), like `done` (#367).
  // The intentional multi-session exit: the hook must let the turn end rather
  // than re-feed the forwarding-loop nudge, so the agent never rubber-stamps.
  // =========================================================================
  test("(b2) parked directive exits 0 and emits nothing (stop allowed)", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const r = runHook(proj, '{"stop_hook_active":false}', "parked");
    expect(r.rc).toBe(0);
    expect(r.out).toBe("");
  }, 30000);

  test("(b2) parked resets the no-progress guard (like done)", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // Pre-seed a no-progress streak; a parked allow must clear it.
    mkdirSync(join(seededRecordDir(proj), ".aidlc-stop-hook"), { recursive: true });
    writeFileSync(
      guardFilePath(proj),
      JSON.stringify({ signature: "requirements-analysis::1", count: 5 }),
      "utf-8",
    );
    runHook(proj, '{"stop_hook_active":false}', "parked");
    expect(guardCount(proj)).toBe(0);
  }, 30000);

  // (b2)(3) AUTONOMY GUARD - salvaged from #365. A `parked` directive under
  // autonomous Construction must NOT release the stop: an unattended swarm/Bolt
  // run has no human to resume it, so the parked allow is suppressed and the
  // turn falls through to the cap-bounded block (the loop stays alive). Mirror
  // of the (f) pending-question autonomy guard.
  test("(b2) parked under Construction Autonomy Mode=autonomous still BLOCKS", () => {
    const proj = makeProject();
    // Seed an active workflow flagged autonomous (reuse the autonomy seed).
    seedInProgressWithQuestions(proj, { autonomy: "autonomous" });
    const r = runHook(proj, '{"stop_hook_active":false}', "parked");
    expect(r.rc).toBe(0);
    // The parked allow is declined; the hook blocks instead.
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
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

  test("(f) gated per-unit Construction finds the active unit's blank question", () => {
    const proj = makeProject();
    seedInProgressWithQuestions(proj, {
      slug: "code-generation",
      phase: "construction",
      autonomy: "gated",
      unit: "checkout-api",
      questions: "# Plan Approval\n\nApprove this plan?\n[Answer]:\n",
    });
    const r = runHook(
      proj,
      '{"stop_hook_active":false}',
      "run-stage",
      "",
      "checkout-api",
    );
    expect(r.rc).toBe(0);
    expect(r.out).toBe("");
  }, 30000);

  test("(f) per-unit lookup ignores a different unit's stale blank question", () => {
    const proj = makeProject();
    seedInProgressWithQuestions(proj, {
      slug: "code-generation",
      phase: "construction",
      autonomy: "gated",
      unit: "stale-unit",
      questions: "# Plan Approval\n\nApprove this old plan?\n[Answer]:\n",
    });
    const r = runHook(
      proj,
      '{"stop_hook_active":false}',
      "run-stage",
      "",
      "active-unit",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  // =========================================================================
  // (f) TIER-3 CONVERSATIONAL CARVE-OUT (issue #365 broader reading): when the
  // ending turn answered the human's most recent prompt with NO workflow-engine
  // engagement (no aidlc-orchestrate / aidlc-state call since that prompt) the
  // human was just chatting mid-workflow, so the hook ALLOWS the stop even
  // though the engine still returns a pending run-stage. The signal is the
  // harness transcript (Claude / Codex deliver `transcript_path` on the Stop
  // payload). Strictly gated and fail-CLOSED (isConversationalStop,
  // aidlc-stop.ts:599): an engine call in the responding turn, autonomous
  // Construction, an unreadable / missing transcript, or no human prompt found
  // all fall through to the cap-bounded block. It only ever ALLOWS.
  // =========================================================================
  test("(f) Claude chat transcript (human prompt answered with TEXT only) allows the stop (conversational carve-out)", () => {
    const proj = makeProject();
    // Active, non-autonomous, pending run-stage: the engine still says block;
    // the conversational transcript is what releases.
    seedActive(proj, "requirements-analysis");
    const tp = seedTranscript(proj, { format: "claude", engineCall: false });
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect(r.out).toBe(""); // allowed (the turn was conversational)
  }, 30000);

  test("(f) Claude transcript with an aidlc-orchestrate Bash call after the prompt still BLOCKS (engine was engaged)", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // Same human prompt, but the responding turn ran the engine -> a mid-loop
    // bail that must still be nudged.
    const tp = seedTranscript(proj, { format: "claude", engineCall: true });
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(f) Codex rollout chat transcript allows the stop (conversational carve-out, codex reader)", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // The codex reader is selected only when the path ends in rollout-*.jsonl
    // (aidlc-stop.ts:721); seedTranscript names the codex variant accordingly.
    const tp = seedTranscript(proj, { format: "codex", engineCall: false });
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect(r.out).toBe("");
  }, 30000);

  test("(f) Codex rollout with a function_call aidlc-orchestrate after the prompt still BLOCKS", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const tp = seedTranscript(proj, { format: "codex", engineCall: true });
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(f) AUTONOMY GUARD - a chat transcript under Construction Autonomy Mode=autonomous still BLOCKS (carve-out disabled)", () => {
    const proj = makeProject();
    // Autonomous Construction: there is no human chatting to release, so the
    // conversational carve-out is suppressed and the loop stays alive.
    seedInProgressWithQuestions(proj, { autonomy: "autonomous" });
    const tp = seedTranscript(proj, { format: "claude", engineCall: false });
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(f) AUTONOMY cap is 8 - autonomous workflow does NOT release at the interactive cap (2)", () => {
    const proj = makeProject();
    // Same autonomous workflow, no transcript. Seed the no-progress counter at
    // count 2 (the interactive cap) at the matching signature, then drive a
    // post-block stop. At cap 8 (autonomous default) nextCount = 3 < 8 -> BLOCK;
    // an interactive run would have RELEASED at 2. This pins the run-mode-aware
    // default: the autonomous cap is genuinely 8, not 2.
    seedInProgressWithQuestions(proj, { autonomy: "autonomous" });
    mkdirSync(join(seededRecordDir(proj), ".aidlc-stop-hook"), {
      recursive: true,
    });
    const sig = progressSig(proj);
    writeFileSync(
      guardFilePath(proj),
      JSON.stringify({ signature: sig, count: 2 }),
      "utf-8",
    );
    // No transcript and no autonomy carve-out, so the cap governs. sameSignature
    // => nextCount = 2 + 1 = 3 < cap 8 => still BLOCK.
    const r = runHook(proj, '{"stop_hook_active":true}', "run-stage");
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(f) FAIL-CLOSED - a transcript_path pointing at a nonexistent file falls through to the cap-bounded block", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // No transcript written; point the payload at a path that does not exist.
    // transcriptIsConversational fails closed on the unreadable file -> fall
    // through to decideBlock, which on a fresh first block at count 1 BLOCKS.
    const r = runHook(
      proj,
      JSON.stringify({
        stop_hook_active: false,
        transcript_path: join(proj, "does-not-exist.jsonl"),
      }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
    expect(guardCount(proj)).toBe(1); // a fresh first block, not released
  }, 30000);

  // =========================================================================
  // (g) RUN-MODE-AWARE DEFAULT BLOCK CAP: with no CLAUDE_CODE_STOP_HOOK_BLOCK_CAP
  // override the default cap is now run-mode aware: 2 for an INTERACTIVE run,
  // 8 for `Construction Autonomy Mode: autonomous` (AUTONOMOUS_BLOCK_CAP=8,
  // INTERACTIVE_BLOCK_CAP=2, aidlc-stop.ts:136-137). A human who pauses or chats
  // is released after a single nudge; an unattended autonomous run keeps the
  // long ceiling. No env var, no transcript, purely the no-progress streak.
  // =========================================================================
  test("(g) INTERACTIVE default cap (2): block then RELEASE at the 2nd no-progress attempt", () => {
    const proj = makeProject();
    // Non-autonomous active workflow, no transcript, NO explicit cap env so the
    // interactive default (2) governs. stop_hook_active:false so the streak is
    // driven purely by the unchanged signature (no report between invocations).
    seedActive(proj, "requirements-analysis");
    const b1 = runHook(proj, '{"stop_hook_active":false}', "run-stage"); // count 1 -> block
    const b2 = runHook(proj, '{"stop_hook_active":false}', "run-stage"); // count 2 >= cap 2 -> RELEASE
    expect((JSON.parse(b1.out) as { decision?: string }).decision).toBe("block");
    expect(b2.out).toBe(""); // released at the interactive cap of 2
  }, 30000);

  test("(g) AUTONOMOUS default cap (8): the SAME sequence does NOT release at 2, keeps blocking through 7, releases only at 8", () => {
    const proj = makeProject();
    // Identical no-progress sequence as the interactive case, but flagged
    // autonomous (the autonomy seed). The default cap is 8, so blocks 1-7 hold
    // and only the 8th attempt releases, proving the autonomous default is not
    // throttled to 2. No transcript / no env override.
    seedInProgressWithQuestions(proj, { autonomy: "autonomous" });
    const outs: string[] = [];
    for (let i = 1; i <= 8; i++) {
      outs.push(runHook(proj, '{"stop_hook_active":false}', "run-stage").out);
    }
    // Attempts 1-7 BLOCK (count 1..7 < cap 8); attempt 8 RELEASES (count 8 >= 8).
    for (let i = 0; i < 7; i++) {
      expect((JSON.parse(outs[i]) as { decision?: string }).decision).toBe("block");
    }
    expect(outs[7]).toBe(""); // released only at the autonomous cap of 8
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
    // mid-stage. runEngineNextDirective() returns null on non-zero exit (:274).
    const n = runHook(proj, '{"stop_hook_active":false}', "__nonzero__");
    expect(n.rc).toBe(0);
    expect(n.out).toBe("");
  }, 30000);

  // =========================================================================
  // (h) CLASSIFIER REFINEMENTS (commit 92b94a2): two hardenings of the tier-3
  // conversational carve-out, pinned deterministically against the real hook:
  //
  //   1. READ-ONLY ENGINE QUERIES are NOT workflow engagement. isEngineToolCall
  //      (aidlc-stop.ts:474) returns FALSE for `--status` / `--doctor` / `--help`
  //      / `--version` / `aidlc-orchestrate next --status` and ANY aidlc-utility
  //      call, even though they name aidlc-orchestrate/aidlc-state. It returns
  //      TRUE only for loop-advancing / state-mutating calls: bare
  //      `aidlc-orchestrate next`, `aidlc-orchestrate report`, and `aidlc-state`
  //      with approve/advance/finalize/complete-workflow/gate-start/checkbox/
  //      park/unpark/set. So a chat turn whose conductor ANSWERED with a
  //      read-only query stays conversational (ALLOW); a turn that ran a
  //      loop-advancing / mutating call then bailed BLOCKS.
  //   2. The hook's OWN injected continuation is NOT a human prompt. Claude
  //      records it as a `type:"user"` entry with `isMeta:true` whose content
  //      starts "Stop hook feedback:" (aidlc-stop.ts:546,564). The classifier
  //      SKIPS it (by isMeta AND by the content prefix) so the human-prompt
  //      anchor stays the human's, not the hook's. Codex has no isMeta, so the
  //      content guard alone excludes it there (aidlc-stop.ts:605).
  //
  // Each case uses a FRESH makeProject() (so the per-project no-progress counter
  // starts at 0 and a BLOCK is a real first block at the interactive cap of 2,
  // never masked by a released counter from a prior call; see the (a) pattern).
  // =========================================================================

  // --- (h.1) read-only engine queries are conversational (ALLOW) ---
  test("(h) chat + read-only `aidlc-orchestrate next --status` after the human prompt allows the stop", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // A chatting human asks "what stage am I on?"; the conductor answers with a
    // read-only `next --status`. isEngineToolCall returns false on --status, so
    // the turn is still conversational.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "what stage am I on?" },
      { kind: "bash", command: "bun .claude/tools/aidlc-orchestrate.ts next --status" },
      { kind: "text" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect(r.out).toBe(""); // allowed: read-only query is not engagement
  }, 30000);

  test("(h) chat + `aidlc-utility status` after the human prompt allows the stop", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // aidlc-utility names neither aidlc-orchestrate nor aidlc-state, so
    // isEngineToolCall returns false at its first gate (:483): not engagement.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "show me the workflow status" },
      { kind: "bash", command: "bun .claude/tools/aidlc-utility.ts status" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect(r.out).toBe("");
  }, 30000);

  test("(h) chat + `aidlc-orchestrate --doctor` / `--help` / `--version` each allow the stop", () => {
    for (const flag of ["--doctor", "--help", "--version"]) {
      const proj = makeProject(); // fresh per flag: counter starts at 0
      seedActive(proj, "requirements-analysis");
      const tp = seedTranscriptEntries(proj, "claude", [
        { kind: "human", text: "is the workflow healthy?" },
        { kind: "bash", command: `bun .claude/tools/aidlc-orchestrate.ts ${flag}` },
      ]);
      const r = runHook(
        proj,
        JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
        "run-stage",
      );
      expect(r.rc).toBe(0);
      expect(r.out).toBe(""); // each read-only flag stays conversational
    }
  }, 30000);

  // --- (h.1) loop-advancing / mutating calls are engagement (BLOCK) ---
  test("(h) engaged: bare `aidlc-orchestrate next` after the human prompt BLOCKS", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // A bare `next` (no read-only flag) fetches the next directive to act on;
    // that IS engagement, so a conductor that ran it then bailed must be nudged.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "continue" },
      { kind: "bash", command: "bun .claude/tools/aidlc-orchestrate.ts next" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(h) engaged: `aidlc-orchestrate report --stage x --result approved` BLOCKS", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "looks good, proceed" },
      {
        kind: "bash",
        command:
          "bun .claude/tools/aidlc-orchestrate.ts report --stage requirements-analysis --result approved",
      },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(h) engaged: `aidlc-state approve foo` BLOCKS", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "approve it" },
      { kind: "bash", command: "bun .claude/tools/aidlc-state.ts approve foo" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  // --- (h.2) the hook's own re-prompt is excluded from "genuine human prompt" ---
  test("(h) isMeta exclusion: an isMeta 'Stop hook feedback:' re-prompt does NOT reset the human anchor; engine call after the REAL prompt still BLOCKS", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // The REAL human prompt is "continue"; the conductor engaged the engine
    // (bare next), produced text, then the hook injected its OWN re-prompt as a
    // type:"user" isMeta entry, then the conductor ran the engine again. The
    // classifier MUST skip the isMeta entry rather than treat it as the latest
    // human prompt: the genuine anchor stays at "continue", and an engine call
    // (bare next) appears after it, so the turn is NOT conversational -> BLOCK.
    // Were the isMeta entry counted as the human prompt, the anchor would move
    // past the first next and the engaged run could be misread as chat.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "continue" },
      { kind: "bash", command: "bun .claude/tools/aidlc-orchestrate.ts next" },
      { kind: "text" },
      { kind: "meta", text: "Stop hook feedback: The AIDLC workflow has a pending step." },
      { kind: "bash", command: "bun .claude/tools/aidlc-orchestrate.ts next" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(h) content exclusion (no isMeta): a 'Stop hook feedback:' user entry is excluded by content, so the last GENUINE prompt was a chat answer -> ALLOW", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // No isMeta flag this time. The genuine human prompt is "explain X", answered
    // with TEXT only (no engine call). A later type:"user" entry whose content
    // starts "Stop hook feedback:" is excluded BY CONTENT, so it must not become
    // the new anchor; the last genuine prompt stays "explain X" -> conversational.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "explain what this stage does" },
      { kind: "text" },
      { kind: "userText", text: "Stop hook feedback: The AIDLC workflow has a pending step." },
      { kind: "text" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect(r.out).toBe(""); // allowed: feedback entry excluded by content prefix
  }, 30000);

  // --- (h) Codex-format equivalents (read-only ALLOW + bare-next BLOCK) ---
  test("(h) Codex: chat + read-only `aidlc-orchestrate next --status` allows the stop", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // The codex reader routes the function_call arguments through isEngineToolCall
    // too (aidlc-stop.ts:639), so the read-only exemption holds across formats.
    const tp = seedTranscriptEntries(proj, "codex", [
      { kind: "human", text: "what stage am I on?" },
      { kind: "bash", command: "bun .codex/tools/aidlc-orchestrate.ts next --status" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect(r.out).toBe("");
  }, 30000);

  test("(h) Codex: engaged bare `aidlc-orchestrate next` BLOCKS", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    const tp = seedTranscriptEntries(proj, "codex", [
      { kind: "human", text: "continue" },
      { kind: "bash", command: "bun .codex/tools/aidlc-orchestrate.ts next" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  // =========================================================================
  // (i) CLASSIFIER-LEAK REGRESSIONS (commit e9b6e48). Three precision fixes to
  // isEngineToolCall (aidlc-stop.ts:474) / isEngineEngagementSegment (:507) /
  // isInjectedHookFeedback (:542), all closing 'wrong-allow' leaks an adversarial
  // review of the tier-3 conversational carve-out found. They could let an
  // engine-engaged turn be misread as chat (ALLOW) when it should BLOCK:
  //
  //   1. PRECEDENCE - a command is split on shell separators (&& || ; | newline)
  //      and each segment judged on its own (aidlc-stop.ts:489). A read-only flag
  //      (--status/--doctor/--help/--version) now exempts ONLY the segment it
  //      appears in, so a chained `... --status && aidlc-orchestrate report ...`,
  //      or a `report --reason '...--status...'` whose --status is inside an
  //      argument, is ENGAGEMENT (BLOCK), not exempt.
  //   2. MISSED COMMANDS - aidlc-jump / aidlc-bolt / aidlc-swarm (conductor-run,
  //      state-mutating) and aidlc-state skip/reject/revise/resume now count as
  //      engagement (:525,:531); an unrecognised aidlc-* verb fails TOWARD
  //      engagement (BLOCK). A read-only `aidlc-bolt --help` stays chat (ALLOW).
  //   3. CODEX RAW CONTINUATION - the hook's own injected nudge is excluded from
  //      human-prompt detection not just by the Claude "Stop hook feedback:"
  //      wrapper but also by the RAW continuationReason body ("The AIDLC workflow
  //      has a pending step" + "forwarding loop"; aidlc-stop.ts:546-548), in BOTH
  //      readers. So an engine-engaged turn whose last user entry is that raw
  //      nudge (no wrapper) still BLOCKS - the nudge must not reset the human
  //      anchor.
  //
  // Each BLOCK-expecting case uses a FRESH makeProject() (the interactive cap is
  // 2; a reused project's counter would release on the 2nd no-progress call and
  // mask a real BLOCK - see the (a)/(h) pattern).
  // =========================================================================

  // --- (i.1) PRECEDENCE: per-segment judgement of chained / argument-embedded flags ---
  test("(i) chained `aidlc-utility --status && aidlc-orchestrate report` after the human prompt BLOCKS (per-segment precedence)", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // The read-only --status is in the FIRST segment (aidlc-utility, not even an
    // engine verb); the SECOND segment runs a mutating `report`. Pre-fix the
    // line-level --status wrongly exempted the whole chain; now each segment is
    // judged on its own, so the report segment is engagement -> BLOCK.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "looks fine" },
      {
        kind: "bash",
        command:
          "bun .claude/tools/aidlc-utility.ts --status && bun .claude/tools/aidlc-orchestrate.ts report --stage requirements-analysis --result approved",
      },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(i) `aidlc-orchestrate report --reason \"checked --status earlier\"` BLOCKS (flag inside an argument is not an exemption)", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // The --status token only appears INSIDE the --reason argument of a single
    // `report` segment. Pre-fix the line-level scan saw --status and exempted the
    // turn; now the lone segment carries `report` (advancing) -> engagement -> BLOCK.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "proceed" },
      {
        kind: "bash",
        command:
          'bun .claude/tools/aidlc-orchestrate.ts report --stage requirements-analysis --result approved --reason "checked --status earlier"',
      },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  // --- (i.2) MISSED COMMANDS: jump / state-skip count as engagement; bolt --help does not ---
  test("(i) engaged: `aidlc-jump.ts execute application-design` after the human prompt BLOCKS", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // aidlc-jump moves the pointer (state-mutating); pre-fix it was not in the
    // engagement set, so a jump-then-bail was misread as chat. Now it BLOCKS.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "jump ahead" },
      { kind: "bash", command: "bun .claude/tools/aidlc-jump.ts execute application-design" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(i) engaged: `aidlc-state.ts skip foo` after the human prompt BLOCKS", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // skip is a state-mutating aidlc-state verb newly recognised as engagement
    // (aidlc-stop.ts:525); a skip-then-bail must be nudged.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "skip this one" },
      { kind: "bash", command: "bun .claude/tools/aidlc-state.ts skip foo" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(i) read-only `aidlc-bolt.ts --help` after a chat prompt allows the stop (read-only verb is not engagement)", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // The complement to the engagement cases: aidlc-bolt is in the engagement
    // set, but a read-only --help on it is NOT engagement (aidlc-stop.ts:530), so
    // a chatting human who asked about bolt and got --help stays conversational.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "how does bolt work?" },
      { kind: "bash", command: "bun .claude/tools/aidlc-bolt.ts --help" },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect(r.out).toBe(""); // allowed: read-only --help is not engagement
  }, 30000);

  // --- (i.3) CODEX RAW CONTINUATION: the raw nudge body must not reset the human anchor ---
  // The hook's continuationReason body (aidlc-stop.ts:781-792) is excluded from
  // human-prompt detection by isInjectedHookFeedback's RAW-body branch
  // (:546-548): starts "The AIDLC workflow has a pending step" AND contains
  // "forwarding loop". So a turn that engaged the engine (bare `next` after the
  // real "continue") whose LAST user entry is that raw nudge (no "Stop hook
  // feedback:" wrapper) must STILL BLOCK: were the raw nudge counted as the
  // latest human prompt, the anchor would move past the engine call and the
  // engaged run would be misread as chat (wrong ALLOW).
  const RAW_NUDGE =
    "The AIDLC workflow has a pending step (a run-stage directive). " +
    "You haven't finished the forwarding loop yet. Run `bun .claude/tools/aidlc-orchestrate.ts next`, " +
    "act on the directive it emits, then report.";

  test("(i) Claude: a RAW continuation body (no 'Stop hook feedback:' wrapper) does NOT reset the human anchor; the engaged turn still BLOCKS", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // Genuine human prompt "continue"; conductor ran the engine (bare next) then
    // bailed; the hook re-injected its RAW nudge as a user entry (no wrapper).
    // The classifier must exclude the raw nudge by body, keeping the anchor at
    // "continue" with the engine call after it -> NOT conversational -> BLOCK.
    const tp = seedTranscriptEntries(proj, "claude", [
      { kind: "human", text: "continue" },
      { kind: "bash", command: "bun .claude/tools/aidlc-orchestrate.ts next" },
      { kind: "userText", text: RAW_NUDGE },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);

  test("(i) Codex: a RAW continuation body (no wrapper) does NOT reset the human anchor; the engaged turn still BLOCKS", () => {
    const proj = makeProject();
    seedActive(proj, "requirements-analysis");
    // The codex reader applies the same isInjectedHookFeedback raw-body guard
    // (aidlc-stop.ts:652), so the raw nudge is excluded there too.
    const tp = seedTranscriptEntries(proj, "codex", [
      { kind: "human", text: "continue" },
      { kind: "bash", command: "bun .codex/tools/aidlc-orchestrate.ts next" },
      { kind: "userText", text: RAW_NUDGE },
    ]);
    const r = runHook(
      proj,
      JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
      "run-stage",
    );
    expect(r.rc).toBe(0);
    expect((JSON.parse(r.out) as { decision?: string }).decision).toBe("block");
  }, 30000);
});
