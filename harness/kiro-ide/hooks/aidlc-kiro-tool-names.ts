// harness/kiro-ide/hooks/aidlc-kiro-tool-names.ts — the one table of the Kiro
// tool names this row's hooks act on.
//
// Kiro IDE 1.x and Kiro CLI v3 name their tools alike at PreToolUse and
// PostToolUse: `fs_write`, `str_replace` and `execute_bash` on both, a delegate
// as `subagent_<agent>` on both, `invoke_sub_agent` on Kiro IDE and
// `orchestrate_subagent` on Kiro CLI. The adapter asks this table what a name
// is. The hook registrations (hooks/*.json) are written by hand, and t245
// compares each one's matcher with the one KIRO_HOOK_MATCHERS builds from this
// table: a shell, delegate, audited or guarded write name added here also has
// to be added to the registrations that deliver it.
//
// This file has no imports: t245 reads it straight from the authored tree, and
// the adapter imports it from beside itself in every projection.
//
// These are hook tool names. The persona `tools:` categories and the
// `permissions.rules` capabilities in manifest.ts are Kiro's permission
// vocabulary, even where a spelling is the same, and are not decided here.

type KiroTool =
  // A file mutation the adapter forwards to the core hooks as Write or Edit.
  // `audited` says whether the audit route can read this tool's result text
  // ("Created the <PATH> file.", "Replaced text in <PATH>") — it has to be
  // stated for every name, so adding one is a decision about its audit too.
  // `guarded` says whether review-freeze and state-transition-guard can read the
  // call's targets from its input: only a name whose payload shape is captured.
  // An unguarded name reaches neither guard, rather than an empty target they
  // would allow; Plan Approval still counts it as a mutation.
  | {
    role: "write" | "edit";
    audited: boolean;
    guarded: boolean;
    legacyPlanningWrite?: true;
    append?: true;
  }
  | { role: "shell"; powershell?: true }
  | { role: "delegate"; pipeline?: true }
  | { role: "read" };

const KIRO_TOOLS: Record<string, KiroTool> = {
  // Before Plan Approval on a build that sends no tool arguments, only the two
  // legacy planning writes may author the plan files. `write` is the kiro-cli
  // 2.6.1 name (captured with `command: "create"`); no KAS capture carries it,
  // but a call under that name is still a write.
  write: { role: "write", audited: false, guarded: true },
  fs_write: { role: "write", audited: true, guarded: true, legacyPlanningWrite: true },
  create_file: { role: "write", audited: false, guarded: false },
  str_replace: { role: "edit", audited: true, guarded: true, legacyPlanningWrite: true },
  fs_append: { role: "edit", audited: true, guarded: true, append: true },
  // `delete_file` names its target `targetFile` (every captured payload is
  // {explanation, targetFile}).
  delete_file: { role: "edit", audited: false, guarded: true },
  // No payload of these is captured, and a patch carries its paths inside its
  // text (none was seen on Kiro IDE 1.2.4 or Kiro CLI 2.27.1).
  apply_patch: { role: "edit", audited: false, guarded: false },
  edit_file: { role: "edit", audited: false, guarded: false },
  // The shell tool is `execute_bash` on POSIX hosts, `execute_pwsh` on Windows,
  // and `shell` in some IDE generations.
  execute_bash: { role: "shell" },
  execute_pwsh: { role: "shell", powershell: true },
  shell: { role: "shell" },
  // The conductor's tools list selects these two because only they run a
  // delegate under its own permissions; `orchestrate_subagent` runs a pipeline
  // of stages. The named `subagent_<agent>` family is below. A delegation call
  // carries an agent and a prompt but no file path, so without this role the
  // adapter would refuse it as an unattributable mutation; the target agent is
  // the attribution, and the adapter forwards it to the core guard as a `Task`
  // (#1175).
  invoke_sub_agent: { role: "delegate" },
  orchestrate_subagent: { role: "delegate", pipeline: true },
  // Reads, which cannot change the workspace during a Plan Approval window.
  read: { role: "read" },
  fs_read: { role: "read" },
  read_file: { role: "read" },
  read_files: { role: "read" },
  read_code: { role: "read" },
  list_directory: { role: "read" },
  file_search: { role: "read" },
  glob: { role: "read" },
  grep_search: { role: "read" },
  grep: { role: "read" },
  web_fetch: { role: "read" },
  web_search: { role: "read" },
  // `disclose_context` activates skills or steering files into context. Kiro
  // documents it under Context tools beside `introspect` and `knowledge` and
  // gives it no write surface; anything an activated skill then asks for is
  // still gated by its own PreToolUse call, and approval authority comes from
  // the active directive and disk receipts, never from activated context. So it
  // cannot mutate the workspace during a Plan Approval window, while denying it
  // stopped a Windows customer mid-workflow (#1039).
  disclose_context: { role: "read" },
  thinking: { role: "read" },
  todo_list: { role: "read" },
};

// `subagent_<agent>` is the named dispatch an agent gets from the `subagent`
// tool category. `subagent_response` is the completion shell that carries no
// output, not a dispatch.
const NAMED_DELEGATE_PREFIX = "subagent_";
const DELEGATE_RESPONSE = "subagent_response";

function kiroTool(name: string): KiroTool | undefined {
  if (Object.hasOwn(KIRO_TOOLS, name)) return KIRO_TOOLS[name];
  return name.startsWith(NAMED_DELEGATE_PREFIX) && name !== DELEGATE_RESPONSE
    ? { role: "delegate" }
    : undefined;
}

function namesWhere(select: (tool: KiroTool) => boolean): string[] {
  return Object.entries(KIRO_TOOLS)
    .filter(([, tool]) => select(tool))
    .map(([name]) => name);
}

export function isKiroShellTool(name: string): boolean {
  return kiroTool(name)?.role === "shell";
}

export function isKiroPowerShellTool(name: string): boolean {
  const tool = kiroTool(name);
  return tool?.role === "shell" && tool.powershell === true;
}

export function isKiroDelegationTool(name: string): boolean {
  return kiroTool(name)?.role === "delegate";
}

// The two dispatch tools that name their delegate in the tool input rather
// than in the tool name.
export function isKiroGenericDelegationTool(name: string): boolean {
  return Object.hasOwn(KIRO_TOOLS, name) && KIRO_TOOLS[name].role === "delegate";
}

export function isKiroPipelineDelegationTool(name: string): boolean {
  const tool = kiroTool(name);
  return tool?.role === "delegate" && tool.pipeline === true;
}

// The agent a `subagent_<agent>` tool name dispatches to, or "".
export function kiroNamedDelegate(name: string): string {
  return isKiroDelegationTool(name) && !isKiroGenericDelegationTool(name)
    ? name.slice(NAMED_DELEGATE_PREFIX.length).trim()
    : "";
}

// The core tool name a file mutation is forwarded as. Write creates a
// (possibly new) file; the edits always target an existing one, so Edit forces
// ARTIFACT_UPDATED in the core write-audit-log.
export function canonicalWriteTool(name: string): "Write" | "Edit" | "" {
  const role = kiroTool(name)?.role;
  return role === "write" ? "Write" : role === "edit" ? "Edit" : "";
}

export function isLegacyPlanningWriteTool(name: string): boolean {
  const tool = kiroTool(name);
  return (tool?.role === "write" || tool?.role === "edit") && tool.legacyPlanningWrite === true;
}

export function isKiroAppendTool(name: string): boolean {
  const tool = kiroTool(name);
  return (tool?.role === "write" || tool?.role === "edit") && tool.append === true;
}

// A file mutation review-freeze and state-transition-guard receive.
export function isGuardedWriteTool(name: string): boolean {
  const tool = kiroTool(name);
  return (tool?.role === "write" || tool?.role === "edit") && tool.guarded;
}

export function isPlanApprovalSafeReadTool(name: string): boolean {
  return kiroTool(name)?.role === "read";
}

// Any name the table does not call a read may change the workspace, including
// one it does not know.
export function mutationCapableTool(name: string): boolean {
  return name.length > 0 && !isPlanApprovalSafeReadTool(name);
}

const shellNames = namesWhere((tool) => tool.role === "shell").join("|");

// The matcher each registration must carry, built from the table (read by
// t245; the registrations themselves are hand-written JSON). PostToolUse
// matchers stay unanchored and PreToolUse ones anchored, as each was written;
// the delegate-completion matcher admits `subagent_response` too, which the
// adapter then drops.
export const KIRO_HOOK_MATCHERS = {
  auditedWrite: namesWhere((tool) =>
    (tool.role === "write" || tool.role === "edit") && tool.audited
  ).join("|"),
  shellPostToolUse: shellNames,
  shellPreToolUse: `^(${shellNames})$`,
  guardedPreToolUse: `^(${
    [...namesWhere((tool) => (tool.role === "write" || tool.role === "edit") && tool.guarded), shellNames].join("|")
  })$`,
  delegateCompletion: `^(${
    [`${NAMED_DELEGATE_PREFIX}.+`, ...namesWhere((tool) => tool.role === "delegate")].join("|")
  })$`,
} as const;
