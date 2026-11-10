// The AI tools a report names, and which of them a chat log showed the run in: from the transcript labels the readers
// write (lib-transcripts.ts). A leaf module, with no imports of its own.

export const TOOL_KEYS = ["kiro-ide", "kiro-cli", "claude", "codex", "copilot"] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];

// Transcript `tool` labels -> the tool whose version matters for this run.
const USED_BY_LABEL: [RegExp, ToolKey][] = [
  [/^claude-code$/, "claude"],
  [/^codex$/, "codex"],
  [/Kiro IDE/, "kiro-ide"],
  [/Kiro CLI|^kiro-cli/, "kiro-cli"],
  [/^copilot-cli$/, "copilot"],
];

type Read = { tool?: string; sessions?: number; reportSessions?: number; mixedSessions?: number; error?: string };

// The sessions of the run: a session that only made this report is not one (one that held the run first is).
export function runSessions(t: Read): number {
  return Math.max(0, (t.sessions ?? 0) - (t.reportSessions ?? 0) + (t.mixedSessions ?? 0));
}
// A tool whose only sessions made this report is not a tool the run used.
export function toolsUsed(transcripts: Read[]): ToolKey[] {
  return toolsOf(transcripts, (t) => !t.error && runSessions(t) > 0);
}
function toolsOf(transcripts: Read[], keep: (t: Read) => boolean): ToolKey[] {
  const used = new Set<ToolKey>();
  for (const t of transcripts) {
    if (!t.tool || !keep(t)) continue;
    for (const [re, key] of USED_BY_LABEL) if (re.test(t.tool)) used.add(key);
  }
  return TOOL_KEYS.filter((k) => used.has(k));
}
