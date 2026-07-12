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
//   chat.message (every human turn)      → aidlc-mint-presence.ts  (UserPromptSubmit)
//   tool.execute.after write|edit        → aidlc-audit-logger.ts + aidlc-sensor-fire.ts (PostToolUse Write|Edit)
//   tool.execute.after bash              → aidlc-runtime-compile.ts (PostToolUse Bash)
//   tool.execute.after todowrite         → aidlc-sync-statusline.ts (PostToolUse TaskUpdate)
//   tool.execute.after task              → aidlc-log-subagent.ts    (SubagentStop)
//   event session.idle                   → aidlc-stop.ts            (Stop)
//   experimental.session.compacting      → aidlc-validate-state.ts  (PreCompact)
//
// Stop enforcement: session.idle is a REACTIVE event (opencode has no blocking
// stop channel), so when the core stop hook answers {"decision":"block",
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
//   - Presence minting is skipped for subagent (child) sessions when the
//     parent lookup succeeds; on lookup failure it fails OPEN (mints) so a
//     gate approval is never wedged by a transient API error.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const bin = bunBin();
    if (bin === null) return resolve({ stdout: "", code: 0 });
    try {
      const child = spawn(bin, [join(cwd, HOOKS_SUBDIR, hookFile)], {
        cwd,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.on("error", () => resolve({ stdout: "", code: 0 })); // fail open
      child.on("close", (code: number | null) => resolve({ stdout: out, code: code ?? 0 }));
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch {
      resolve({ stdout: "", code: 0 }); // fail open
    }
  });
}

type PluginInput = {
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
};

export default async ({ client, directory }: PluginInput) => {
  // Sessions whose first human turn already forwarded session-start.
  const started = new Set<string>();
  // Sessions confirmed as main (no parentID) — presence + stop enforcement
  // apply only to these; child (task-tool) sessions are workers, not humans.
  const mainSession = new Map<string, boolean>();

  async function isMainSession(sessionID: string): Promise<boolean> {
    const cached = mainSession.get(sessionID);
    if (cached !== undefined) return cached;
    let main = true; // fail OPEN: a wedged gate is worse than a stray mint
    try {
      const s = await client.session.get({ path: { id: sessionID } });
      main = !s.data?.parentID;
    } catch {
      /* lookup failure → treat as main */
    }
    mainSession.set(sessionID, main);
    return main;
  }

  return {
    "chat.message": async (
      input: { sessionID: string },
      output: { parts: Array<{ type?: string; text?: string }> },
    ) => {
      // Never treat this plugin's own stop-nudge injection as a human turn.
      const first = output.parts.find((p) => p.type === "text");
      if (first?.text?.startsWith(NUDGE_SENTINEL)) return;
      if (!(await isMainSession(input.sessionID))) return;
      if (!started.has(input.sessionID)) {
        started.add(input.sessionID);
        await runCore(
          "aidlc-session-start.ts",
          {
            hook_event_name: "SessionStart",
            source: "startup",
            session_id: input.sessionID,
          },
          directory,
        );
      }
      await runCore("aidlc-mint-presence.ts", { hook_event_name: "UserPromptSubmit" }, directory);
    },

    "tool.execute.after": async (input: {
      tool: string;
      sessionID: string;
      callID: string;
      args: Record<string, unknown>;
    }) => {
      const { tool, args } = input;
      if (tool === "write" || tool === "edit") {
        const filePath = (args.filePath as string) ?? "";
        if (!filePath) return;
        const payload = {
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: filePath },
        };
        // audit THEN sensors, mirroring the Claude settings.json order.
        await runCore("aidlc-audit-logger.ts", payload, directory);
        await runCore("aidlc-sensor-fire.ts", payload, directory);
        return;
      }
      if (tool === "bash") {
        await runCore(
          "aidlc-runtime-compile.ts",
          {
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_input: { command: (args.command as string) ?? "" },
          },
          directory,
        );
        return;
      }
      if (tool === "todowrite") {
        // The core hook keys on Claude's TaskUpdate in_progress transition;
        // map the first in-progress todo's content onto activeForm.
        const todos = (args.todos as Array<{ content?: string; status?: string }>) ?? [];
        const active = todos.find((t) => t.status === "in_progress");
        if (!active?.content) return;
        await runCore(
          "aidlc-sync-statusline.ts",
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
      // Enforce only on sessions this plugin saw a human turn in: a session
      // with no chat.message here is another project's or a worker's.
      if (!sessionID || !started.has(sessionID)) return;
      if (!(await isMainSession(sessionID))) return;
      // opencode provides no stop_hook_active flag and no transcript, so the
      // core hook's run-mode-aware no-progress ceiling is the loop guard here
      // (same degradation profile as Kiro; the conversational carve-out is
      // inert and the INTERACTIVE cap releases a chatting human).
      const res = await runCore(
        "aidlc-stop.ts",
        { hook_event_name: "Stop", stop_hook_active: false },
        directory,
      );
      try {
        const parsed = JSON.parse(res.stdout) as { decision?: string; reason?: string };
        if (parsed.decision === "block" && parsed.reason) {
          await client.session.prompt({
            path: { id: sessionID },
            body: { parts: [{ type: "text", text: `${NUDGE_SENTINEL} ${parsed.reason}` }] },
          });
        }
      } catch {
        /* no/unparseable output → allow the stop (advisory) */
      }
    },
  };
};
