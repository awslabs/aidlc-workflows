#!/usr/bin/env bun
// aidlc-kiro-adapter.ts — the Kiro CLI hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness).
//
// Kiro hook payloads are near-isomorphic to Claude Code's but differ in
// three load-bearing ways (live-captured on kiro-cli 2.6.1 — see
// docs/spikes/dist-kiro/findings.md §0.2 in the framework repo):
//   1. tool_name arrives as the ALIAS: `shell` (execute_bash), `write`
//      (fs_write).
//   2. the write payload's file path field is `path`, not `file_path`.
//   3. `todo_list` input is command-shaped ({command: "create", tasks:
//      [{task_description}]}) — there is no status/activeForm transition.
//
// This shim normalizes a Kiro payload into the ClaudeCodeHookInput shape the
// core hooks parse, then pipes it into the named core hook (same directory)
// as a bun subprocess, forwarding stdout and the exit code. Two outputs need
// post-processing:
//   - session-start emits {"additionalContext": "..."} — Kiro's context
//     channel is plain stdout at exit 0, so the shim unwraps the JSON and
//     prints the text.
//   - stop emits {"decision":"block","reason":"..."} — Kiro's stop contract
//     is IDENTICAL (verified live), so it passes through verbatim.
//
// Usage (registered in .kiro/agents/aidlc.json):
//   bun .kiro/hooks/aidlc-kiro-adapter.ts <target>
// where <target> ∈ session-start | audit-and-sensors | runtime-compile |
//                  state-sync | log-subagent | stop | verb-intercept |
//                  pretool-block | reviewer-scope

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyTerminalCommand,
  hasOpenGate,
  humanActedSinceGate,
  humanPresenceGuardDisabled,
  isAutonomousMode,
  splitDoubleQuotedArgs,
  stateFilePath,
} from "../tools/aidlc-lib.ts";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

interface KiroHookInput {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  assistant_response?: string;
}

export async function run(
  target: string,
  input: string,
  extraArgs: string[] = [],
): Promise<number> {
let kiro: KiroHookInput = {};
if (!process.stdin.isTTY) {
  try {
    if (input.length > 0) kiro = JSON.parse(input) as KiroHookInput;
  } catch {
    return 0; // malformed stdin — advisory hooks fail open
  }
}

const projectDirRaw =
  process.env.AIDLC_PROJECT_DIR ?? kiro.cwd ?? process.cwd();
const projectDir = isAbsolute(projectDirRaw)
  ? projectDirRaw
  : resolve(process.cwd(), projectDirRaw);
const projectEnv = process.env.AIDLC_PROJECT_DIR
  ? {
      ...process.env,
      AIDLC_PROJECT_DIR: projectDir,
      CLAUDE_PROJECT_DIR: projectDir,
    }
  : process.env;
const childCwd = process.env.AIDLC_PROJECT_DIR ? projectDir : process.cwd();

// --- verb-intercept: the deterministic terminal-command seam (userPromptSubmit) ---
//
// A `/aidlc` command that leads with a workspace navigation verb
// (space/space-create/intent) or a read-only utility flag (--status/--doctor/
// --help/--version) is TERMINAL — it maps 1:1 to an aidlc-utility.ts subcommand
// and carries no workflow work. Over an ACTIVE workflow the live conductor is
// unreliable at honouring these: under accumulated session context it runs a
// bare `next` and advances the active intent (verb dropped) or rolls into the
// active stage (read-only flag ignored) — the "roll-forward" bug. This hook
// dispatches them DETERMINISTICALLY before the conductor decides anything:
// recover the raw args, classify with the engine's own classifier
// (classifyTerminalCommand — same sets the engine routes on), run the tool, and
// hand the conductor the verbatim output with an explicit do-NOT-advance
// instruction (Kiro's context channel is plain stdout at exit 0; it has no
// block API, so the conductor relays rather than is bypassed — measured to land
// the command and leave the active intent untouched).
//
// WHY the args are recovered from the EXPANDED body: Kiro fires userPromptSubmit
// with `prompt` = the fully-expanded skill body (the raw `/aidlc …` literal is
// gone), but it SUBSTITUTES the user's post-/aidlc text ($ARGUMENTS) into the
// forwarding-loop anchor `aidlc-orchestrate.ts next <ARGS>`. We read the args
// back from that anchor — the same text the conductor would forward.
function extractNextArgs(expandedPrompt: string): string[] {
  // Match the FIRST `… aidlc-orchestrate.ts next <ARGS>` occurrence (the loop's
  // step-1 anchor) and take the tokens up to the closing backtick. The anchor is
  // inside a markdown code span, so the args end at the backtick.
  const m = expandedPrompt.match(/aidlc-orchestrate\.ts next ([^`\n]*)`/);
  if (!m) return [];
  return splitDoubleQuotedArgs(m[1].trim());
}

if (target === "verb-intercept") {
  // The whole turn's only job here is to deterministically handle a terminal
  // command; anything else falls through to the conductor untouched (exit 0, no
  // output → Kiro proceeds to the LLM normally). Advisory: any failure fails open.
  const args = extractNextArgs(kiro.prompt ?? "");
  const cmd = classifyTerminalCommand(args);
  // Turn-clock: bump a per-turn counter EVERY time this seam fires (it fires
  // once per turn, BEFORE the cmd===null exit so a bare-next turn still advances
  // the clock and a prior turn's latch goes stale). The read-only/nav latch
  // below stamps THIS counter value; the engine done-guard + preToolUse backstop
  // fire ONLY when the latch's turn === the current counter (same turn) — truly
  // turn-scoped, no time window, no wedge. Best-effort; failure fails open.
  let turn = 0;
  try {
    const cwd = projectDir;
    mkdirSync(join(cwd, "aidlc"), { recursive: true });
    const cp = join(cwd, "aidlc", ".aidlc-turn-counter");
    turn = existsSync(cp)
      ? (Number.parseInt(readFileSync(cp, "utf-8").trim(), 10) || 0) + 1
      : 1;
    writeFileSync(cp, String(turn) + "\n", "utf-8");
  } catch { /* turn-clock best-effort */ }
  // Human presence: this seam fires on a real human turn, so record a HUMAN_TURN
  // event in the active intent's audit shard. The gate (handleApprove/handleAnswer)
  // refuses unless a HUMAN_TURN was recorded since the last gate resolution; the
  // preToolUse block below is the exit-2 floor. Own try block, SEPARATE from the
  // turn-counter bump above (that is the roll-forward latch clock - a counter I/O
  // failure must not skip the mint, or a genuine approval gets refused). Gated on
  // workflow state existing (same self-gate as the core mint hook) so a prompt in
  // a project that never ran the framework does not scaffold audit shards.
  try {
    const cwd = projectDir;
    if (existsSync(stateFilePath(cwd))) {
      appendAuditEntry("HUMAN_TURN", {}, cwd);
    }
  } catch { /* presence best-effort - mint never blocks the turn */ }
  if (cmd === null) return 0; // not a terminal command — conductor handles it

  const cwd = projectDir;
  const forwarded = cmd.args ?? (cmd.arg !== undefined ? [cmd.arg] : []);
  let out: string;
  if (cmd.error !== undefined) {
    out = cmd.error;
  } else {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const compiledArgs = (() => {
      if (cmd.subcommand === "space-create") return ["space", "create", ...forwarded];
      if (cmd.subcommand === "intent-birth") return ["intent", "birth", ...forwarded];
      return [cmd.subcommand, ...forwarded];
    })();
    const utilArgs = [join(".kiro", "tools", "aidlc-utility.ts"), cmd.subcommand, ...forwarded];
    // Reuse the exact bun binary running this adapter; the child must not depend on
    // PATH containing bun (the hook environment often lacks the bun install dir).
    const run = Bun.spawnSync(
      executable ? [executable, ...compiledArgs] : [process.execPath, ...utilArgs],
      { cwd, stdout: "pipe", stderr: "pipe", env: projectEnv },
    );
    out = ((run.stdout?.toString() ?? "") + (run.stderr?.toString() ?? "")).trim();
  }

  // Turn-scoped latch: a terminal command was handled OFF-BAND this turn (the
  // seam ran the tool; the conductor only relays). Stamp the latch with the
  // CURRENT turn counter so the engine done-guard + preToolUse backstop know a
  // bare advancing `next` THIS SAME turn is the spurious roll-forward and must
  // be neutralized. Read-only flags (--status/--doctor/--help/--version) and
  // workspace verbs (space/space-create/intent) both arm it, so the same guard
  // catches the read-only AND the nav roll-forward. Best-effort; fails open.
  if (cmd.source === "read-only-flag" || cmd.source === "workspace-verb") {
    try {
      const cwd = projectDir;
      mkdirSync(join(cwd, "aidlc"), { recursive: true });
      const flag = cmd.source === "read-only-flag"
        ? cmd.subcommand
        : (cmd.display ?? [cmd.subcommand, ...forwarded].join(" "));
      writeFileSync(
        join(cwd, "aidlc", ".aidlc-readonly-latch"),
        JSON.stringify({ turn, flag, source: cmd.source, ts: Date.now() }) + "\n",
        "utf-8",
      );
    } catch { /* latch best-effort */ }
  }
  // Echo the command the way the user typed it (verb + arg, or the --flag) so the
  // short-circuit message is legible.
  const typed = cmd.source === "read-only-flag"
    ? `--${cmd.subcommand}`
    : (cmd.display ?? [cmd.subcommand, ...forwarded].join(" "));
  process.stdout.write(
    `SYSTEM (deterministic harness dispatch): The command \`/aidlc ${typed}\` has ALREADY been run by the harness — it is a read-only/navigation command that carries NO workflow work. Its verbatim output is below. Your ONLY action this turn: relay that output to the user, then STOP. Do NOT run \`aidlc-orchestrate.ts next\`. Do NOT advance, resume, or run any workflow stage.\n\n--- OUTPUT ---\n${out}\n--- END OUTPUT ---\n`,
  );
  return 0;
}

// --- pretool-block: the preToolUse roll-forward backstop (matcher: execute_bash) ---
//
// Defense-in-depth behind the engine done-guard. The verb-intercept seam above
// handles a read-only/nav command off-band and stamps aidlc/.aidlc-readonly-latch
// with the current turn counter; the engine's `next` then emits `done` for a bare
// advancing next this same turn. But Kiro's userPromptSubmit can only INJECT, not
// block — so if the live conductor retries a bare `next` past the engine's `done`,
// this preToolUse hook is the hard floor: when the latch is fresh-for-this-turn and
// the attempted execute_bash command is a TRULY BARE advancing `aidlc-orchestrate.ts
// next` (no advancing flag, classifyTerminalCommand === null), exit 2 + stderr →
// Kiro BLOCKS the tool call (live-verified contract: only exit 2 blocks; exit 1 and
// a JSON {"decision":...} on stdout do NOT). It does NOT consume the latch (the
// conductor may retry within the turn; the next turn bumps the counter so the latch
// goes stale and a legitimate advancing next runs). Advisory/fail-open: any
// parse/read failure exits 0 and never blocks a real next.
if (target === "pretool-block") {
  const cmdStr = String(kiro.tool_input?.command ?? "");
  const cwd = projectDir;
  const m = cmdStr.match(/aidlc-orchestrate\.ts\s+next\b([^\n]*)/);
  const nextArgs = m ? splitDoubleQuotedArgs(m[1].trim()) : [];
  // A next carrying ANY advancing/config flag is a DELIBERATE move — only a truly
  // bare next is the spurious roll-forward. Mirrors the engine done-guard's
  // exemptions (the engine doesn't parse --init/--force — retired P4 — so listing
  // them here is a harmless superset).
  const ADVANCING_FLAGS = new Set([
    "--stage", "--phase", "--scope", "--resume", "--depth",
    "--test-strategy", "--single", "--init", "--force",
    "--new-scope", "--report",
  ]);
  // A leading `compose` verb is a deliberate composer dispatch (the engine's
  // Branch 0 exempts flags.compose the same way) - never the spurious bare
  // roll-forward this backstop exists to block.
  const isBareAdvancing =
    m !== null &&
    nextArgs[0] !== "compose" &&
    !nextArgs.some((a) => ADVANCING_FLAGS.has(a)) &&
    classifyTerminalCommand(nextArgs) === null;

  let counter = -1;
  let latchTurn = -2;
  try {
    const cp = join(cwd, "aidlc", ".aidlc-turn-counter");
    if (existsSync(cp)) {
      const n = Number.parseInt(readFileSync(cp, "utf-8").trim(), 10);
      if (Number.isFinite(n)) counter = n;
    }
    const lp = join(cwd, "aidlc", ".aidlc-readonly-latch");
    if (existsSync(lp)) {
      const r = JSON.parse(readFileSync(lp, "utf-8")) as { turn?: number };
      if (typeof r.turn === "number") latchTurn = r.turn;
    }
  } catch { /* fail open */ }

  if (isBareAdvancing && counter >= 0 && latchTurn === counter) {
    process.stderr.write(
      "read-only/navigation command already handled this turn by the deterministic harness — do not advance the workflow. The output was already relayed; end the turn.\n",
    );
    return 2; // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
  }

  // --- human-presence floor (second exit-2 branch) ---
  //
  // Refuse a tool call ONLY while an approval gate is actually OPEN (a stage sits
  // at [?] in the state file) and no HUMAN_TURN has been recorded since the last
  // gate resolution: the hard floor that stops a model under autopilot from
  // fabricating an approval (the verb-intercept seam above records a HUMAN_TURN
  // on a real human turn). The gate-open predicate is load-bearing: after a
  // legitimate approval the resolution follows the turn's HUMAN_TURN, and without
  // it the floor would block the mandated same-turn continuation into the next
  // stage. Distinct from the roll-forward latch above. Carve-outs mirror the core
  // gate: autonomous Construction (swarm/Bolt) first, then the deterministic
  // off-switch, then no-open-gate. Fail-open on any read/parse error: advisory,
  // must never wedge a legitimate turn.
  try {
    const content = existsSync(stateFilePath(cwd))
      ? readFileSync(stateFilePath(cwd), "utf-8")
      : null;
    if (isAutonomousMode(content)) return 0; // autonomous: never block
    if (humanPresenceGuardDisabled()) return 0; // deterministic off-switch
    if (!hasOpenGate(content)) return 0; // no gate awaits approval

    if (!humanActedSinceGate(cwd)) {
      process.stderr.write(
        "an approval gate is open and no human has acted since it opened: refusing the tool call. A real human must respond at the gate. End the turn.\n",
      );
      return 2; // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
    }
  } catch { /* fail open: advisory presence floor */ }

  return 0;
}

// --- reviewer-scope: the per-unit reviewer read-scope bound (preToolUse) ---
//
// Registered inside the REVIEWER agents' own JSON configs (not the
// conductor's), so every call arriving through this registration is that
// reviewer's - the scoping IS the agent identity on Kiro, whose hook
// payloads carry no agent_type. Each registration passes ITS OWN agent name
// as an extra argument (`reviewer-scope <agent-name>`), which the shim forwards
// as agent_type so the core hook still compares against the dispatch record's
// reviewer field - a stale record naming a DIFFERENT reviewer then fails
// open exactly like on Claude/Codex, instead of scoping the wrong agent.
// The shim normalizes the alias payload (shell -> Bash {command}; read ->
// Read {paths} from operations[]; write -> Write {path}) and forwards the
// core hook's stderr + exit code verbatim - exit 2 + stderr is Kiro's
// reject contract, the same channel pretool-block uses. Fail-open: a
// missing name (scoped_registration fallback) or an unspawnable core hook
// allows the call.
if (target === "reviewer-scope") {
  const tool = kiro.tool_name ?? "";
  const ti = kiro.tool_input ?? {};
  let coreTool = "";
  const coreInput: Record<string, unknown> = {};
  if (tool === "shell" || tool === "execute_bash") {
    coreTool = "Bash";
    coreInput.command = (ti.command as string) ?? "";
  } else if (tool === "read" || tool === "fs_read") {
    coreTool = "Read";
    const ops = (ti.operations as Array<{ path?: string; pattern?: string }>) ?? [];
    coreInput.paths = ops.map((o) => o.path ?? "").filter((p) => p.length > 0);
    coreInput.path = (ti.path as string) ?? "";
  } else if (tool === "write" || tool === "fs_write") {
    coreTool = "Write";
    coreInput.file_path = (ti.path as string) ?? (ti.file_path as string) ?? "";
    // Batch shape: mirror the read side - if the payload carries an
    // operations[] collection, every per-operation path is inspected too
    // (a batched write across siblings must not bypass on the top-level
    // path being absent).
    const wops = (ti.operations as Array<{ path?: string }>) ?? [];
    coreInput.paths = wops.map((o) => o.path ?? "").filter((p) => p.length > 0);
  } else {
    return 0;
  }
  const registeredAgent = extraArgs[0] ?? "";
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const command = executable
    ? [executable, "hook", "reviewer-scope"]
    : [process.execPath, join(HOOKS_DIR, "aidlc-reviewer-scope.ts")];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: coreTool,
        tool_input: coreInput,
        ...(registeredAgent.length > 0
          ? { agent_type: registeredAgent }
          : { scoped_registration: true }),
      }),
      "utf-8",
    ),
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: projectEnv,
  });
  const stderrText = r.stderr?.toString() ?? "";
  if (r.exitCode === 2) {
    process.stderr.write(stderrText);
    return 2; // Kiro reject contract: exit 2 + stderr BLOCKS the tool call.
  }
  return 0;
}

// Normalize Kiro's alias tool names to the canonical names the core hooks
// match on. Both alias and canonical forms are accepted defensively.
function canonicalTool(name: string): string {
  if (name === "write" || name === "fs_write") return "Write";
  if (name === "shell" || name === "execute_bash") return "Bash";
  return name;
}

type Forward = { hook: string; input: Record<string, unknown> } | null;

function buildForward(): Forward {
  const tool = canonicalTool(kiro.tool_name ?? "");
  const ti = kiro.tool_input ?? {};

  switch (target) {
    case "session-start":
      // session_id is forwarded when present so the core hook writes its
      // per-session→intent STAMP (the session→intent record). BUT agentSpawn
      // carries no source discrimination — every spawn reports as "startup"
      // from the core hook's perspective (Kiro has no resume signal in this
      // payload), so SESSION_RESUMED can never fire and the P8 resume-rebind
      // OFFER is structurally unreachable on Kiro — a documented harness
      // limitation, not a bug. We never fake a resume source. The state-file
      // self-gate keeps the whole thing a no-op outside active workflows.
      return {
        hook: "aidlc-session-start.ts",
        input: {
          hook_event_name: "SessionStart",
          source: "startup",
          ...(kiro.session_id ? { session_id: kiro.session_id } : {}),
        },
      };

    case "audit-and-sensors": {
      // postToolUse(write) → audit-logger THEN sensor-fire (both ship core).
      if (tool !== "Write") return null;
      const filePath = (ti.path as string) ?? (ti.file_path as string) ?? "";
      if (!filePath) return null;
      return {
        hook: "__audit_and_sensors__", // handled specially below (two hooks)
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: filePath },
        },
      };
    }

    case "runtime-compile": {
      if (tool !== "Bash") return null;
      return {
        hook: "aidlc-runtime-compile.ts",
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: (ti.command as string) ?? "" },
        },
      };
    }

    case "state-sync": {
      // Kiro's todo_list is command-shaped. A `create` whose first task
      // description carries the stage-protocol "[slug]" suffix maps to the
      // Claude TaskUpdate in_progress transition the core hook keys on.
      if ((kiro.tool_name ?? "") !== "todo_list") return null;
      if ((ti.command as string) !== "create") return null;
      const tasks = (ti.tasks as Array<{ task_description?: string }>) ?? [];
      const desc = tasks[0]?.task_description ?? "";
      if (!desc) return null;
      return {
        hook: "aidlc-sync-statusline.ts",
        input: {
          hook_event_name: "PostToolUse",
          tool_name: "TaskUpdate",
          tool_input: { status: "in_progress", activeForm: desc },
        },
      };
    }

    case "log-subagent": {
      if ((kiro.tool_name ?? "") !== "subagent") return null;
      const stages = (ti.stages as Array<{ role?: string }>) ?? [];
      const roles = [...new Set(stages.map((s) => s.role ?? "unknown"))].join(",");
      return {
        hook: "aidlc-log-subagent.ts",
        input: {
          hook_event_name: "SubagentStop",
          agent_type: roles || "unknown",
          agent_id: kiro.session_id ?? "",
        },
      };
    }

    case "stop":
      // Kiro provides neither stop_hook_active NOR a transcript_path, so the
      // core hook's run-mode-aware no-progress ceiling is the loop guard here
      // (it defaults stop_hook_active to false). With no transcript the core
      // hook's conversational carve-out is inert on Kiro, so a chatting or
      // pausing human is released by the INTERACTIVE cap (default 2; 8 under
      // autonomous Construction) instead, after one nudge rather than eight. The
      // {"decision":"block"} stdout contract is identical.
      return {
        hook: "aidlc-stop.ts",
        input: { hook_event_name: "Stop", stop_hook_active: false },
      };

    default:
      return null;
  }
}

function runCore(hookFile: string, input: Record<string, unknown>): { stdout: string; code: number } {
  // Reuse the exact bun binary running this adapter; the child must not depend on
  // PATH containing bun (the hook environment often lacks the bun install dir).
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
  const command = executable
    ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
    : [process.execPath, join(HOOKS_DIR, hookFile)];
  const r = Bun.spawnSync(command, {
    stdin: Buffer.from(JSON.stringify(input), "utf-8"),
    stdout: "pipe",
    stderr: "ignore",
    cwd: childCwd,
    env: projectEnv,
  });
  return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
}

const fwd = buildForward();
if (fwd === null) {
  return 0;
}

if (fwd.hook === "__audit_and_sensors__") {
  // Two core hooks ride the same write event, in audit-then-sensors order
  // (mirrors the Claude settings.json registration). Both advisory: exit 0.
  runCore("aidlc-audit-logger.ts", fwd.input);
  runCore("aidlc-sensor-fire.ts", fwd.input);
  return 0;
}

const result = runCore(fwd.hook, fwd.input);

if (target === "session-start") {
  // Unwrap {"additionalContext": ...} → plain text on stdout (Kiro's context
  // channel). Anything unparseable passes through untouched.
  try {
    const parsed = JSON.parse(result.stdout) as { additionalContext?: string };
    if (parsed.additionalContext) {
      process.stdout.write(parsed.additionalContext);
    }
  } catch {
    if (result.stdout) process.stdout.write(result.stdout);
  }
  return 0;
}

// stop (and any future passthrough target): forward stdout + exit code
// verbatim — the {"decision":"block","reason"} contract is shared.
if (result.stdout) process.stdout.write(result.stdout);
return result.code;
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text(), process.argv.slice(3)));
}
