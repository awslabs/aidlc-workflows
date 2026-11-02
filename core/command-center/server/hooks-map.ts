// Which Claude Code event runs each AIDLC hook (as registered in `.claude/settings.json`), and the shared "Needs
// fixing" types. No Node imports: the UI imports this file too.

export type HookPhase = "PreToolUse" | "PostToolUse" | "Stop" | "SessionStart" | "SessionEnd" | "SubagentStop" | "PreCompact" | "UserPromptSubmit";

/** Hook → the events it is registered for. A hook can run on more than one event. */
export const HOOK_PHASES: Record<string, HookPhase[]> = {
  "state-transition-guard": ["PreToolUse"],
  "reviewer-scope": ["PreToolUse"],
  "review-freeze": ["PreToolUse"],
  "plan-approval-guard": ["PreToolUse"],
  "deliver-stage-rules": ["PreToolUse", "PostToolUse"],
  "fold-usage": ["PreToolUse", "PostToolUse"],
  "write-audit-log": ["PostToolUse"],
  "run-sensors": ["PostToolUse"],
  "sync-workflow-state": ["PostToolUse"],
  "record-human-turn": ["UserPromptSubmit", "PostToolUse"],
  "rebuild-stage-graph": ["PostToolUse"],
  "session-start": ["SessionStart"],
  "session-end": ["SessionEnd"],
  "validate-state": ["PreCompact"],
  "log-subagent": ["SubagentStop"],
  "continue-workflow": ["Stop"],
};
/** Hooks that write a `<hook>.last` heartbeat at the start of every run (the others never do). */
export const HEARTBEAT_HOOKS = ["write-audit-log", "run-sensors", "sync-workflow-state", "record-human-turn", "rebuild-stage-graph", "plan-approval-guard",
  "review-freeze", "reviewer-scope", "session-start", "session-end", "validate-state", "log-subagent", "continue-workflow"] as const;

/** The single event a hook runs on, or null when it runs on several (or is unknown). */
export const hookPhaseOf = (hook: string | null | undefined): HookPhase | null => {
  const p = hook ? HOOK_PHASES[hook] : undefined;
  return p && p.length === 1 ? p[0]! : null;
};
/** "PreToolUse" → "Pre", "PostToolUse" → "Post", others unchanged: the short label the tables show. */
export const shortPhase = (p: string) => (p === "PreToolUse" ? "Pre" : p === "PostToolUse" ? "Post" : p);
export const phasesLabel = (hook: string) => (HOOK_PHASES[hook] ?? []).map(shortPhase).join(" · ") || "—";

/** `accepted`: a non-blocking check that failed (or did not run) on a stage or unit that has since passed its gate. */
export type IssueGroup = "hard-stop" | "failure" | "refused" | "bypass" | "accepted";
export type Recoverable = "yes" | "needs-you" | "no";
export interface Issue {
  id: string; group: IssueGroup;
  resolved: { by: string; at: string | null } | null;
  /** When it happened (the newest occurrence when folded); null when the record does not say. */
  at: string | null;
  where: { hook?: string; hookPhase?: HookPhase | null; tool?: string; stage?: string | null; unit?: string | null; inferred?: string | null };
  kind: string;
  /** Verbatim from the record (AIDLC's own words). */
  message: string;
  detail?: string;
  recoverable: Recoverable;
  fix: { text: string; source: "aidlc" | "hint" } | null;
  source: { file: string; line?: number };
  /** Identical occurrences folded into this one (1 when not folded); `firstAt` is the oldest. */
  count: number; firstAt?: string | null;
  /** Counts toward "needs fixing": open hard stops and failures, and refusals that repeat (≥ 3) or are terminal. */
  needsFixing: boolean;
  /** Why it happened, only as AIDLC recorded it (findings, codes, exit status, …); null when nothing beyond the message is recorded. */
  cause?: IssueCause | null;
  /** The exact record lines this issue comes from, plus the supporting files AIDLC wrote with it. */
  evidence?: IssueEvidence | null;
}
export interface IssueCause { summary: string; points: { label: string; value: string }[]; source: "aidlc" }
export type SupportingKind = "sensor-detail" | "checkpoint" | "guard-refusal" | "review-record" | "hooks-health" | "recovery" | "other";
export interface SupportingFile { path: string; label: string; kind: SupportingKind }
export interface IssueEvidence {
  /** Workspace-relative: the audit shard for audit entries, else the file the issue was read from. */
  auditFile: string;
  /** The 1-based line of `lines[0]` in that file. */
  startLine: number; lines: string[];
  /** The line to emphasise (the entry's heading, the drop line, …), or null. */
  focusLine?: number | null;
  /** Workspace-relative paths, each realpath-contained in the workspace's `aidlc/` folder when it was listed. */
  supporting: SupportingFile[];
}
export type HookState = "ok" | "stale" | "never" | "frozen";
export interface HookRow { workspace: string; intentKey: string | null; hook: string; phase: string; lastAt: string | null; state: HookState; drops: number; benignDrops: number;
  /** Why this row is informational rather than a problem (not the active intent, or no heartbeats at all here). */
  note?: string }
export type TranscriptCoverage = "off" | "on" | "unavailable" | "unrecognised";
export interface HealthCoverage {
  transcripts: TranscriptCoverage; trace: boolean; note: string | null;
  /** With transcripts on: hook runs seen, hook failures found, and AIDLC Stop-hook re-prompts (by design, not failures). */
  transcriptRuns?: number; transcriptFailures?: number; transcriptReprompts?: number;
}
export type ScopedIssue = Issue & { workspace: string; intentKey: string | null; intentName: string };
export interface HealthPayload { issues: ScopedIssue[]; hooks: HookRow[]; coverage: HealthCoverage; generatedAt: string }
export interface HealthCounts { needsFixing: number; open: Record<IssueGroup, number>; resolved: number; byIntent: Record<string, number> }

export const GROUP_META: Record<IssueGroup, { glyph: string; label: string; cls: string; long?: string }> = {
  "hard-stop": { glyph: "🔴", label: "Hard stop", cls: "bad" },
  failure: { glyph: "🟠", label: "Failure", cls: "wait" },
  refused: { glyph: "🟡", label: "Refused", cls: "dim" },
  bypass: { glyph: "⚪", label: "Bypass", cls: "faint" },
  accepted: { glyph: "☑", label: "Accepted at gate", cls: "dim", long: "accepted at gate · not re-checked" },
};
export const GROUPS: IssueGroup[] = ["hard-stop", "failure", "refused", "bypass", "accepted"];
export const COVERAGE_NOTE = "Hook crashes are not recorded by AIDLC. Turn on Read hook failures from Claude Code transcripts in Settings, or set AIDLC_HOOK_TRACE_DIR before starting your harness.";

export function countIssues(issues: (Issue & { workspace?: string; intentKey?: string | null })[]): HealthCounts {
  const open: Record<IssueGroup, number> = { "hard-stop": 0, failure: 0, refused: 0, bypass: 0, accepted: 0 };
  let resolved = 0; let needsFixing = 0; const byIntent: Record<string, number> = {};
  for (const i of issues) {
    if (i.resolved) { resolved++; continue; }
    open[i.group]++;
    if (i.needsFixing) {
      needsFixing++;
      if (i.workspace && i.intentKey) { const k = `${i.workspace}::${i.intentKey}`; byIntent[k] = (byIntent[k] ?? 0) + 1; }
    }
  }
  return { needsFixing, open, resolved, byIntent };
}
