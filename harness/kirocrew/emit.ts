// harness/kirocrew/emit.ts — the Kiro Crew per-shell emission plugin.
//
// WHY THIS EXISTS
// ---------------
// Kiro Crew drives the Kiro CLI, so its lifecycle events (UserPromptSubmit /
// PreToolUse / PostToolUse / Stop, exit-2 deny) match the Kiro CLI's and the
// authored stdin adapter (hooks/aidlc-kiro-adapter.ts) is shared verbatim.
// What differs is HOW hooks are REGISTERED. The Kiro CLI reads a project's
// `.kiro.hook` manifests and the agent-JSON `hooks` block directly. Kiro Crew
// does NEITHER: its gateway rebuilds the agent config from its OWN controlled
// sources (bundled defaults + explicit `agent.kiro_hooks` config + a `*.sh`
// autoimport from `~/.kiro/hooks`), then strips everything to kiro-cli-valid
// hook keys (`agent.py` `_kiro_hooks_only`, a deliberate security boundary).
// So the harness's `.kiro.hook` manifests and its `.ts` adapter are INERT on
// Kiro Crew — the gates never fire, exactly the wall a gated `/aidlc` workflow
// hits (no HUMAN_TURN recorded, plan-approval guard never blocks).
//
// Kiro Crew's SANCTIONED inlet for external hooks is `*.sh` autoimport: an
// executable `*.sh` in `~/.kiro/hooks` with a `# event:` header (or a
// `-pre/-post/-prompt/-spawn/-stop.sh` filename suffix) and an optional
// `# matcher:` header is ingested into the agent-config `hooks` block that the
// underlying kiro-cli fires — the same block native Kiro CLI honors. This is
// Kiro Crew's equivalent of the Kiro CLI's agent-JSON hooks: the same door the
// gateway built for exactly this purpose, not a way around it. Verified live on
// gateway 0.7.0.5: a shaped `*.sh` shim autoimports and its exit 2 blocks a
// real `fs_write` through the running gateway (stderr reason relayed to the
// model); exit 0 lets the call through.
//
// This emit() therefore composes one small `*.sh` shim per lifecycle event and
// writes them into `dist/kirocrew/.kiro/hooks/`. Each shim reads the hook
// payload on stdin and pipes it to the shared adapter route
// (`<INVOKE> engine adapter kirocrew <target>`), relaying the adapter's exit
// code — 2 blocks, 0 allows. `aidlc config` installs the project tree; the
// `register-hooks` adapter verb links these shims into `~/.kiro/hooks` and
// prompts the gateway reload (see aidlc-kiro-adapter.ts). This is the Kiro IDE
// precedent applied to Kiro Crew: a harness emits hooks in whatever shape the
// surface consumes.
//
// The ONE transform class is the harness-dir token / invocation seam, exposed
// via ctx.substituteToken (identical to every declarative projection). Nothing
// here invents a new sed.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmitContext } from "../../scripts/manifest-types.ts";

// ---------------------------------------------------------------------------
// Hook wiring — kiro-normative shape: register ONLY events with a real
// core-hook consumer, one shim per (event, target). The Kiro Crew autoimport
// recognizes exactly five events (preToolUse, postToolUse, userPromptSubmit,
// agentSpawn, stop). Both agentStop and the subagent-stop manifest collapse to
// Kiro Crew's single `stop` event; the adapter targets self-filter on the
// payload (they exit 0 for irrelevant tools/turns) so co-registering several
// `stop`/`postToolUse` shims is safe — the same self-filtering the Codex
// emitter relies on when it omits matchers.
//
// `suffix` is the autoimport filename-suffix that encodes the event, so the
// shim resolves to the right event even if the `# event:` header were dropped.
// We emit BOTH the header and a matching suffix for defense in depth.
type ShimSpec = {
  /** Stable shim identity, becomes aidlc-<name>-<suffix>.sh. */
  name: string;
  /** Kiro Crew autoimport event (PascalCase for the `# event:` header). */
  event: "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "AgentSpawn" | "Stop";
  /** Filename-suffix that independently encodes the event for autoimport. */
  suffix: "-pre.sh" | "-post.sh" | "-prompt.sh" | "-spawn.sh" | "-stop.sh";
  /** Adapter target dispatched by aidlc-kiro-adapter.ts. */
  target: string;
  /** One-line description for the shim header (operator-facing). */
  note: string;
};

const HOOK_SHIMS: ShimSpec[] = [
  {
    name: "aidlc-session-start",
    event: "UserPromptSubmit",
    suffix: "-prompt.sh",
    target: "session-start",
    note: "Give the assistant the current workflow context at the start of a turn.",
  },
  {
    name: "aidlc-record-human-turn",
    event: "UserPromptSubmit",
    suffix: "-prompt.sh",
    target: "record-human-turn",
    note: "Record a real human prompt as the authority event approval gates require.",
  },
  {
    name: "aidlc-plan-approval-guard",
    event: "PreToolUse",
    suffix: "-pre.sh",
    target: "plan-approval-guard",
    note: "Block code-gen dispatch and workspace mutation until the active plan has a human approval receipt (exit 2 = deny).",
  },
  {
    name: "aidlc-audit-and-sensors",
    event: "PostToolUse",
    suffix: "-post.sh",
    target: "audit-and-sensors",
    note: "Record every artifact created/updated in the audit log, then run the checks that apply to it.",
  },
  {
    name: "aidlc-sync-workflow-state",
    event: "PostToolUse",
    suffix: "-post.sh",
    target: "sync-workflow-state",
    note: "Keep aidlc-state.md's Current Stage in step with what actually happened.",
  },
  {
    name: "aidlc-rebuild-stage-graph",
    event: "PostToolUse",
    suffix: "-post.sh",
    target: "rebuild-stage-graph",
    note: "Rebuild the compiled plan of remaining stages after the workflow moves.",
  },
  {
    name: "aidlc-log-subagent",
    event: "PostToolUse",
    suffix: "-post.sh",
    target: "log-subagent",
    note: "Record in the audit log when a specialist agent finishes its part of a stage.",
  },
  {
    name: "aidlc-continue-workflow",
    event: "Stop",
    suffix: "-stop.sh",
    target: "continue-workflow",
    note: "When the assistant tries to end its turn with work pending, remind it to finish the current step.",
  },
];

/**
 * The shim body. Reads the hook payload on stdin, pipes it to the shared
 * adapter route, and relays the adapter's exit code so exit 2 blocks the tool
 * call under Kiro Crew's exit-2 deny contract. The `# event:` / `# matcher:`
 * headers are within the first 5 lines (Kiro Crew scans only that many).
 *
 * `invoke` is the pack-time-resolved invocation (the compiled `aidlc` binary,
 * or `bun .kiro/tools/aidlc.ts` in a copy-channel build). `errexit` is off on
 * purpose: we forward the adapter's own exit code verbatim rather than letting
 * `set -e` mask a 2 as a 1.
 */
function shimBody(spec: ShimSpec, invoke: string): string {
  const command = `${invoke} engine adapter kirocrew ${spec.target}`;
  return `#!/usr/bin/env bash
# event: ${spec.event}
# matcher: .*
# aidlc-kirocrew hook shim — ${spec.note}
#
# Autoimported by Kiro Crew from ~/.kiro/hooks (executable *.sh + a recognized
# event). Kiro Crew delivers the kiro-cli-shaped hook payload on stdin; this
# shim pipes it to the shared adapter and forwards the adapter's exit code
# (2 = block the tool call, 0 = allow). Do not hand-edit — regenerated by
# \`aidlc config\` / the register-hooks verb from harness/kirocrew/emit.ts.
exec ${command}
`;
}

export default function emit(ctx: EmitContext): void {
  const { distRoot, harnessDir, substituteToken } = ctx;
  const invoke = substituteToken("{{INVOKE}}");
  const hooksDir = join(distRoot, harnessDir, "hooks");

  for (const spec of HOOK_SHIMS) {
    const path = join(hooksDir, `${spec.name}${spec.suffix}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, shimBody(spec, invoke), "utf-8");
    // Executable bit is load-bearing: Kiro Crew autoimport skips non-executable
    // files. 0o755 so the gateway subprocess can run it.
    chmodSync(path, 0o755);
  }
}
