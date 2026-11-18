// The refusal Codex reads from a PreToolUse hook's answer, or null when the
// call goes through: exit 2 with the reason on stderr, or exit 0 with a
// permissionDecision deny on stdout, which is how the Codex adapter answers on
// Windows (Codex runs a call whose hook exits 2 there). Every test that reads a
// Codex refusal reads it through this, so neither form goes unread on any
// platform. A deny's reason comes back with the line break stderr ended with.
export function codexRefusal(answer: { code: number | null; stdout: string; stderr: string }): string | null {
  if (answer.code === 2) return answer.stderr;
  if (answer.code !== 0 || !answer.stdout.trim()) return null;
  try {
    const output = (JSON.parse(answer.stdout) as {
      hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown };
    }).hookSpecificOutput;
    return output?.permissionDecision === "deny" && typeof output.permissionDecisionReason === "string"
      ? `${output.permissionDecisionReason}\n`
      : null;
  } catch {
    return null;
  }
}
