/** Completed root messages from Codex exec's JSONL stream. */
export interface CodexTurn {
  rc: number;
  stdout: string;
  stderr: string;
  sessionId?: string;
  agentMessages: string[];
}

export function turnEvidence(stdout: string): Pick<CodexTurn, "sessionId" | "agentMessages"> {
  const sessions = new Set<string>();
  const agentMessages: string[] = [];
  let completed = false;
  let failed = false;
  for (const line of stdout.split("\n").filter((line) => line.trim())) {
    const event = JSON.parse(line);
    if (event?.type === "thread.started") {
      if (typeof event.thread_id !== "string" || !/^[0-9a-f-]{36}$/i.test(event.thread_id)) {
        throw new Error("Codex JSON evidence has an invalid session id");
      }
      sessions.add(event.thread_id);
    } else if (event?.type === "turn.started") {
      completed = false;
      agentMessages.length = 0;
    } else if (event?.type === "item.completed" && event.item?.type === "agent_message") {
      if (typeof event.item.text !== "string") throw new Error("Codex JSON evidence has an invalid agent message");
      agentMessages.push(event.item.text);
    } else if (event?.type === "turn.completed") {
      completed = true;
    } else if (event?.type === "turn.failed") {
      failed = true;
    }
  }
  if (sessions.size !== 1) throw new Error("Codex JSON evidence must identify exactly one session");
  if (!completed || failed) throw new Error("Codex JSON evidence must contain a successful completed turn");
  return { sessionId: [...sessions][0], agentMessages };
}

export function gateText(turn: Pick<CodexTurn, "agentMessages">): string {
  // Both predicates must occur in one user-visible root message. Tool outputs,
  // reasoning and collab results cannot establish that the conductor asked.
  return turn.agentMessages.findLast((text) => /approv|choose/i.test(text) && /reject/i.test(text)) ??
    turn.agentMessages.at(-1) ?? "";
}
