// aidlc-opencode-adapter.ts — the opencode hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies in <project>/.aidlc/hooks/ are PACKAGED core,
// byte-shared with the Claude Code harness).
//
// opencode has no settings.json/hooks.json hook registry; its extension seam is
// the PLUGIN API (auto-discovered from .opencode/plugin/*.ts, loaded in-process
// by the opencode runtime). This one plugin maps opencode's hook surface onto
// the core hook bodies, each run as a bun subprocess fed the ClaudeCodeHookInput
// JSON shape the core hooks parse (live-verified on opencode 1.17.18):
//
//   opencode moment                      → core hook (Claude event it mirrors)
//   ------------------------------------------------------------------------
//   chat.message (first per session)     → aidlc-session-start.ts  (SessionStart)
//   chat.message (every human turn)      → aidlc-record-human-turn.ts  (UserPromptSubmit)
//   tool.execute.before task             → aidlc-deliver-stage-rules.ts rewrite + plan-approval guard (PreToolUse)
//   tool.execute.before other tools      → entrypoint boundary + aidlc-reviewer-scope.ts (PreToolUse)
//   tool.execute.after write|edit|patch  → aidlc-write-audit-log.ts + aidlc-run-sensors.ts (PostToolUse Write|Edit)
//   tool.execute.after bash              → aidlc-rebuild-stage-graph.ts (PostToolUse Bash)
//   tool.execute.after todowrite         → aidlc-sync-workflow-state.ts (PostToolUse TaskUpdate)
//   tool.execute.after task              → aidlc-log-subagent.ts    (SubagentStop)
//   event session.idle                   → aidlc-continue-workflow.ts            (Stop)
//   experimental.session.compacting      → aidlc-validate-state.ts  (PreCompact)
//
// Stop enforcement: session.idle is a REACTIVE event (opencode has no blocking
// continue-workflow channel), so when the core continue-workflow hook answers {"decision":"block",
// "reason":…} this plugin re-engages the loop by injecting the reason as a new
// session prompt via the SDK client. The injected prompt carries the NUDGE
// sentinel so the chat.message arm never mints HUMAN presence for it (a
// synthetic nudge is not a human turn), and loop-guarding stays with the core
// hook's run-mode-aware no-progress ceiling — this shim never counts.
//
// Known degradations vs Claude Code (documented in AGENTS.md):
//   - session-start's additionalContext has no injection channel; the hook
//     still runs for its side effects (session→intent stamp, state checks).
//   - There is no session-end moment; SESSION_ENDED is not emitted.
//   - Presence minting is skipped for subagent (child) sessions. A parent
//     lookup failure fails closed for that event and is retried later; an
//     uncertain child can never record-human-turn a HUMAN_TURN into the shared ledger.
//   - tool.execute.before carries no active-agent field. Reviewer identity is
//     correlated from chat.message.agent by session; when that field is absent,
//     a child session is treated as scoped registration while a dispatch record
//     exists. This can scope another child worker during that narrow window,
//     but never scopes the main session.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

const NUDGE_SENTINEL = "[aidlc-forwarding-nudge]";

// The core hook bodies ship in the ENGINE dir (<project>/.aidlc/hooks/), not
// beside this plugin — .opencode/ carries only natively-consumed surfaces.
// Resolved per-call from the project directory opencode hands the plugin.
const HOOKS_SUBDIR = join(".aidlc", "hooks");

// The opencode runtime is its own binary, so process.execPath is NOT bun.
// Resolve bun from PATH, then the default install dir; absent → every hook is
// a silent no-op (advisory hooks fail open, mirroring the plugin compose hook).
function bunBin(): string | null {
  const home = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(home)) return home;
  return "bun"; // PATH resolution; spawn error is caught per-call below
}

function runCore(
  hookFile: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const bin = bunBin();
    if (bin === null) return resolve({ stdout: "", stderr: "", code: 0 });
    try {
      const child = spawn(bin, [join(cwd, HOOKS_SUBDIR, hookFile)], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
      });
      child.on("error", () => resolve({ stdout: "", stderr: "", code: 0 })); // fail open
      child.on("close", (code: number | null) =>
        resolve({ stdout: out, stderr: err, code: code ?? 0 })
      );
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch {
      resolve({ stdout: "", stderr: "", code: 0 }); // fail open
    }
  });
}

export type PluginInput = {
  client: {
    session: {
      get: (opts: { path: { id: string } }) => Promise<{ data?: { parentID?: string } }>;
      prompt: (opts: {
        path: { id: string };
        body: { parts: Array<{ type: "text"; text: string }> };
      }) => Promise<unknown>;
    };
  };
  directory: string;
  /** Unit-test seam. Production uses the build-time list embedded by emit.ts. */
  aidlcEntrypoints?: ReadonlySet<string>;
};

const AIDLC_BUN_PREFIX = /^bun[ \t]+\.aidlc\/(?:tools|hooks)\//;
const AIDLC_ENTRYPOINT = /^\.aidlc\/(tools|hooks)\/([A-Za-z0-9][A-Za-z0-9._-]*\.ts)$/;

// emit.ts replaces the empty array with every packaged .aidlc/{tools,hooks}/*.ts
// path. The adapter can then reject a newly-authored payload.ts even though the
// host's coarse bash permission glob matches it.
const shippedAidlcEntrypoints: ReadonlySet<string> = new Set<string>(
  /* @aidlc-shipped-entrypoints@ */ [
    "hooks/aidlc-continue-workflow.ts",
    "hooks/aidlc-deliver-stage-rules.ts",
    "hooks/aidlc-fold-usage.ts",
    "hooks/aidlc-log-subagent.ts",
    "hooks/aidlc-plan-approval-guard.ts",
    "hooks/aidlc-rebuild-stage-graph.ts",
    "hooks/aidlc-record-human-turn.ts",
    "hooks/aidlc-review-freeze.ts",
    "hooks/aidlc-reviewer-scope.ts",
    "hooks/aidlc-run-sensors.ts",
    "hooks/aidlc-session-end.ts",
    "hooks/aidlc-session-start.ts",
    "hooks/aidlc-state-transition-guard.ts",
    "hooks/aidlc-statusline.ts",
    "hooks/aidlc-sync-workflow-state.ts",
    "hooks/aidlc-validate-state.ts",
    "hooks/aidlc-write-audit-log.ts",
    "tools/aidlc-audit.ts",
    "tools/aidlc-bolt.ts",
    "tools/aidlc-directive.ts",
    "tools/aidlc-doctor-bundle.ts",
    "tools/aidlc-graph.ts",
    "tools/aidlc-includes.ts",
    "tools/aidlc-jump.ts",
    "tools/aidlc-learnings.ts",
    "tools/aidlc-lib.ts",
    "tools/aidlc-log.ts",
    "tools/aidlc-metrics.ts",
    "tools/aidlc-orchestrate.ts",
    "tools/aidlc-rule-schema.ts",
    "tools/aidlc-runner-gen.ts",
    "tools/aidlc-runtime-paths.ts",
    "tools/aidlc-runtime.ts",
    "tools/aidlc-sensor-claim-sources.ts",
    "tools/aidlc-sensor-linter.ts",
    "tools/aidlc-sensor-required-sections.ts",
    "tools/aidlc-sensor-schema.ts",
    "tools/aidlc-sensor-type-check.ts",
    "tools/aidlc-sensor-upstream-coverage.ts",
    "tools/aidlc-sensor.ts",
    "tools/aidlc-stage-schema.ts",
    "tools/aidlc-state.ts",
    "tools/aidlc-steering.ts",
    "tools/aidlc-swarm.ts",
    "tools/aidlc-tiers.ts",
    "tools/aidlc-usage.ts",
    "tools/aidlc-utility.ts",
    "tools/aidlc-validate.ts",
    "tools/aidlc-version.ts",
    "tools/aidlc-workspace-doctor.ts",
    "tools/aidlc-workspace-manifest.ts",
    "tools/aidlc-workspace-sync.ts",
    "tools/aidlc-worktree.ts",
    "tools/aidlc.ts"
  ],
);

/** Parse one expansion-free shell command into argv, or reject shell syntax. */
function directShellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < command.length) {
        const next = command[++i];
        if (next === "\n" || next === "\r") return null;
        word += next;
        continue;
      }
      if (ch === "`" || ch === "$" || ch === "\n" || ch === "\r") return null;
      word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStarted = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (wordStarted) {
        words.push(word);
        word = "";
        wordStarted = false;
      }
      continue;
    }
    if (
      ch === "\n" ||
      ch === "\r" ||
      ch === "\\" ||
      ch === "`" ||
      ch === "$" ||
      ch === "#" ||
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === "(" ||
      ch === ")" ||
      ch === "<" ||
      ch === ">"
    ) {
      return null;
    }
    word += ch;
    wordStarted = true;
  }
  if (quote !== null) return null;
  if (wordStarted) words.push(word);
  return words;
}

/** Return a denial reason only when the static AIDLC allow-prefix would match. */
function aidlcBashBoundaryViolation(
  command: string,
  allowedEntrypoints: ReadonlySet<string> = shippedAidlcEntrypoints,
): string | null {
  if (!AIDLC_BUN_PREFIX.test(command)) return null;
  const words = directShellWords(command);
  const target = words?.[1]?.match(AIDLC_ENTRYPOINT);
  if (
    words?.[0] === "bun" &&
    target &&
    allowedEntrypoints.has(`${target[1]}/${target[2]}`)
  ) {
    return null;
  }
  return (
    "AIDLC bash permission allows one direct invocation of a shipped tool or hook only. " +
    "Use an unchanged .aidlc entrypoint without chaining, redirection, expansion, or command substitution."
  );
}

/** Extract every source and destination path touched by an apply_patch call. */
function applyPatchPaths(args: Record<string, unknown>): string[] {
  const patch =
    (args.patchText as string) ??
    (args.patch as string) ??
    (args.command as string) ??
    "";
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    paths.push(match[1].trim());
  }
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
    paths.push(match[1].trim());
  }
  return Array.from(new Set(paths.filter((p) => p.length > 0)));
}

type ReviewerCall = {
  toolName: "Read" | "Edit" | "Write" | "LS" | "Glob" | "Grep" | "Bash";
  toolInput: Record<string, unknown>;
};

function reviewerCalls(tool: string, args: Record<string, unknown>): ReviewerCall[] {
  if (tool === "bash") {
    return [{ toolName: "Bash", toolInput: { command: (args.command as string) ?? "" } }];
  }
  if (tool === "read") {
    return [{
      toolName: "Read",
      toolInput: { file_path: (args.filePath as string) ?? (args.path as string) ?? "" },
    }];
  }
  if (tool === "write") {
    return [{
      toolName: "Write",
      toolInput: { file_path: (args.filePath as string) ?? (args.path as string) ?? "" },
    }];
  }
  if (tool === "edit") {
    return [{
      toolName: "Edit",
      toolInput: { file_path: (args.filePath as string) ?? (args.path as string) ?? "" },
    }];
  }
  if (tool === "glob") {
    return [{
      toolName: "Glob",
      toolInput: {
        pattern: (args.pattern as string) ?? "",
        path: (args.path as string) ?? "",
      },
    }];
  }
  if (tool === "grep") {
    return [{
      toolName: "Grep",
      toolInput: {
        pattern: (args.pattern as string) ?? "",
        path: (args.path as string) ?? "",
        glob: (args.include as string) ?? "",
      },
    }];
  }
  if (tool === "list") {
    return [{
      toolName: "LS",
      toolInput: { path: (args.path as string) ?? "" },
    }];
  }
  if (tool === "apply_patch") {
    return applyPatchPaths(args).map((filePath) => ({
      toolName: "Write",
      toolInput: { file_path: filePath },
    }));
  }
  return [];
}

function sessionStartHandled(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { additionalContext?: unknown };
    return typeof parsed.additionalContext === "string";
  } catch {
    return false;
  }
}

export default async ({
  client,
  directory,
  aidlcEntrypoints = shippedAidlcEntrypoints,
}: PluginInput) => {
  // Sessions whose session-start hook reached an active workflow.
  const started = new Set<string>();
  // Main sessions that delivered a real human turn. Stop enforcement keys on
  // this lighter latch because workflow state can be born during turn one.
  const sawHumanTurn = new Set<string>();
  // Sessions confirmed as main (no parentID) — presence + continue-workflow enforcement
  // apply only to these; child (task-tool) sessions are workers, not humans.
  const mainSession = new Map<string, boolean>();
  const sessionAgent = new Map<string, string>();
  const idleInFlight = new Set<string>();

  async function isMainSession(sessionID: string): Promise<boolean> {
    const cached = mainSession.get(sessionID);
    if (cached !== undefined) return cached;
    try {
      const s = await client.session.get({ path: { id: sessionID } });
      const main = !s.data?.parentID;
      mainSession.set(sessionID, main);
      return main;
    } catch {
      // An uncertain child must never record-human-turn human presence. Do not cache the
      // transient failure; a later event gets a fresh lookup.
      return false;
    }
  }

  return {
    "chat.message": async (
      input: { sessionID: string; agent?: string },
      output: { parts: Array<{ type?: string; text?: string }> },
    ) => {
      if (input.agent) sessionAgent.set(input.sessionID, input.agent);
      // Never treat this plugin's own continue-workflow-nudge injection as a human turn.
      const first = output.parts.find((p) => p.type === "text");
      if (first?.text?.startsWith(NUDGE_SENTINEL)) return;
      if (!(await isMainSession(input.sessionID))) return;
      sawHumanTurn.add(input.sessionID);
      if (!started.has(input.sessionID)) {
        const result = await runCore(
          "aidlc-session-start.ts",
          {
            hook_event_name: "SessionStart",
            source: "startup",
            session_id: input.sessionID,
          },
          directory,
        );
        // A fresh project has no state yet, so the core hook emits no context.
        // Retry on later human turns until an active workflow is available.
        if (sessionStartHandled(result.stdout)) started.add(input.sessionID);
      }
      await runCore("aidlc-record-human-turn.ts", { hook_event_name: "UserPromptSubmit" }, directory);
    },

    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ) => {
      const args = output.args ?? {};
      if (input.tool === "task") {
        const dispatch = await runCore(
          "aidlc-deliver-stage-rules.ts",
          {
            hook_event_name: "PreToolUse",
            tool_name: "task",
            tool_input: args,
            cwd: directory,
          },
          directory,
        );
        if (dispatch.code === 2) {
          throw new Error(
            dispatch.stderr.trim() ||
              "required active-stage rules could not be loaded for subagent dispatch",
          );
        }
        if (dispatch.stdout.trim()) {
          try {
            const parsed = JSON.parse(dispatch.stdout) as {
              hookSpecificOutput?: {
                updatedInput?: Record<string, unknown>;
              };
            };
            if (parsed.hookSpecificOutput?.updatedInput) {
              output.args = parsed.hookSpecificOutput.updatedInput;
            }
          } catch {
            throw new Error(
              "AIDLC deliver-stage-rules hook returned invalid rewrite output",
            );
          }
        }
      }
      if (input.tool === "bash") {
        const command = (args.command as string) ?? "";
        const violation = aidlcBashBoundaryViolation(command, aidlcEntrypoints);
        if (violation) throw new Error(violation);
        // State-transition guard, parallel to the Claude/Kiro/Codex PreToolUse
        // wiring. The state CLI's ownership check remains the hard floor; this
        // gives the conductor the same immediate redirect the other harnesses
        // get instead of a late CLI error.
        const guard = await runCore(
          "aidlc-state-transition-guard.ts",
          {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command },
            cwd: directory,
          },
          directory,
        );
        if (guard.code === 2) {
          throw new Error(
            guard.stderr.trim() ||
              "stage status is changed by the workflow tools, not by hand: use aidlc-orchestrate.ts report instead of calling aidlc-state.ts directly",
          );
        }
      }

      // Review-freeze (§12a terminal-receipt write-freeze): runs for EVERY
      // agent - unlike reviewer-scope there is no identity gate, because any
      // produces[] write voids a fresh READY receipt regardless of who makes
      // it. The core hook self-filters to write tools and fails open.
      if (
        input.tool === "bash" ||
        input.tool === "write" ||
        input.tool === "edit" ||
        input.tool === "apply_patch"
      ) {
        const freezeCalls =
          input.tool === "bash"
            ? [{ toolName: "Bash", toolInput: { command: (args.command as string) ?? "" } }]
            : (input.tool === "apply_patch" ? applyPatchPaths(args) : [
                (args.filePath as string) ?? (args.path as string) ?? "",
              ])
                .filter((filePath) => filePath.length > 0)
                .map((filePath) => ({
                  toolName: input.tool === "edit" ? "Edit" : "Write",
                  toolInput: { file_path: filePath },
                }));
        for (const call of freezeCalls) {
          const freeze = await runCore(
            "aidlc-review-freeze.ts",
            {
              hook_event_name: "PreToolUse",
              tool_name: call.toolName,
              tool_input: call.toolInput,
              cwd: directory,
            },
            directory,
          );
          if (freeze.code === 2) {
            throw new Error(
              freeze.stderr.trim() ||
                "review-freeze: this write would invalidate a fresh READY review receipt",
            );
          }
        }
      }

      // Plan-approval guard, parallel to the Claude Task-matcher wiring:
      // opencode's delegation surface is the task tool, whose args carry the
      // target agent (subagent_type or agent) plus the prompt/description.
      // Only developer-agent dispatches consult the core hook; it decides
      // from workflow state whether code-generation's plan-before-generation
      // ordering is satisfied, and a block surfaces as a thrown error (the
      // plugin's reject contract).
      if (input.tool === "task") {
        const target =
          (args.subagent_type as string) ?? (args.agent as string) ?? "";
        if (target === "aidlc-developer-agent") {
          const guard = await runCore(
            "aidlc-plan-approval-guard.ts",
            {
              hook_event_name: "PreToolUse",
              tool_name: "Task",
              tool_input: {
                subagent_type: target,
                prompt: [(args.prompt as string) ?? "", (args.description as string) ?? ""]
                  .filter((t) => t.length > 0)
                  .join("\n"),
              },
              cwd: directory,
            },
            directory,
          );
          if (guard.code === 2) {
            throw new Error(
              guard.stderr.trim() ||
                "code-generation requires an approved plan before dispatching the developer agent",
            );
          }
        }
      }

      const calls = reviewerCalls(input.tool, args);
      if (calls.length === 0) return;

      const agent = sessionAgent.get(input.sessionID);
      const identity =
        agent
          ? { agent_type: agent }
          : (await isMainSession(input.sessionID))
            ? null
            : { scoped_registration: true };
      if (identity === null) return;

      for (const call of calls) {
        const result = await runCore(
          "aidlc-reviewer-scope.ts",
          {
            hook_event_name: "PreToolUse",
            tool_name: call.toolName,
            tool_input: call.toolInput,
            cwd: directory,
            ...identity,
          },
          directory,
        );
        if (result.code === 2) {
          throw new Error(result.stderr.trim() || "reviewer read-scope refused this tool call");
        }
      }
    },

    "tool.execute.after": async (input: {
      tool: string;
      sessionID: string;
      callID: string;
      args: Record<string, unknown>;
    }) => {
      const { tool, args } = input;
      if (tool === "write" || tool === "edit" || tool === "apply_patch") {
        const paths =
          tool === "apply_patch"
            ? applyPatchPaths(args)
            : [((args.filePath as string) ?? (args.path as string) ?? "")];
        for (const filePath of paths) {
          if (!filePath) continue;
          const absolutePath = isAbsolute(filePath) ? filePath : join(directory, filePath);
          const payload = {
            hook_event_name: "PostToolUse",
            tool_name: "Write",
            tool_input: { file_path: absolutePath },
          };
          // audit THEN sensors, mirroring the Claude settings.json order.
          await runCore("aidlc-write-audit-log.ts", payload, directory);
          await runCore("aidlc-run-sensors.ts", payload, directory);
        }
        return;
      }
      if (tool === "bash") {
        const payload = {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: (args.command as string) ?? "" },
        };
        await runCore("aidlc-rebuild-stage-graph.ts", payload, directory);
        return;
      }
      if (tool === "todowrite") {
        // The core hook keys on Claude's TaskUpdate in_progress transition;
        // map the first in-progress todo's content onto activeForm.
        const todos = (args.todos as Array<{ content?: string; status?: string }>) ?? [];
        const active = todos.find((t) => t.status === "in_progress");
        if (!active?.content) return;
        await runCore(
          "aidlc-sync-workflow-state.ts",
          {
            hook_event_name: "PostToolUse",
            tool_name: "TaskUpdate",
            tool_input: { status: "in_progress", activeForm: active.content },
          },
          directory,
        );
        return;
      }
      if (tool === "task") {
        await runCore(
          "aidlc-log-subagent.ts",
          {
            hook_event_name: "SubagentStop",
            agent_type:
              (args.subagent_type as string) ?? (args.agent as string) ?? "unknown",
            agent_id: input.callID,
          },
          directory,
        );
      }
    },

    "experimental.session.compacting": async (_input: { sessionID: string }) => {
      await runCore("aidlc-validate-state.ts", { hook_event_name: "PreCompact" }, directory);
    },

    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type !== "session.idle") return;
      const sessionID = (event.properties?.sessionID as string) ?? "";
      // A workflow can be born during the first turn, after session-start saw
      // no state. Let the core Stop hook's own state-file guard decide.
      if (!sessionID || !sawHumanTurn.has(sessionID)) return;
      if (!(await isMainSession(sessionID))) return;
      if (idleInFlight.has(sessionID)) return;
      idleInFlight.add(sessionID);
      // opencode provides no stop_hook_active flag and no transcript, so the
      // core hook's run-mode-aware no-progress ceiling is the loop guard here
      // (same degradation profile as Kiro). The absent transcript no longer makes
      // the conversational carve-out inert: the core hook falls back to the
      // `.aidlc-human-turn` / `.aidlc-engine-touch` mtime comparison, and the
      // chat.message arm's aidlc-record-human-turn.ts forward writes the former.
      let nudgeReason: string | null = null;
      try {
        const res = await runCore(
          "aidlc-continue-workflow.ts",
          { hook_event_name: "Stop", stop_hook_active: false },
          directory,
        );
        try {
          const parsed = JSON.parse(res.stdout) as { decision?: string; reason?: string };
          if (parsed.decision === "block" && parsed.reason) {
            nudgeReason = parsed.reason;
          }
        } catch {
          /* no/unparseable output → allow the continue-workflow (advisory) */
        }
      } finally {
        idleInFlight.delete(sessionID);
      }
      // Release serialization before the prompt: OpenCode may synchronously
      // deliver the continuation's next idle while this promise is pending.
      if (nudgeReason) {
        await client.session.prompt({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: `${NUDGE_SENTINEL} ${nudgeReason}` }] },
        });
      }
    },
  };
};
