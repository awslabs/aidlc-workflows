// Kiro CLI's own chat record for its default engine:
// ~/.kiro/sessions/cli/<session id>.jsonl, one row per message, in the shape
// kiro-cli 2.34.0 writes (captured live). A message the person types while the
// agent works rides the `ToolResults` row after the running tool, as a `text`
// item beside the tool's result, in Kiro's own envelope.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let rows = 0;
const messageId = (): string => `0f1e2d3c-4b5a-6978-8a9b-${String(++rows).padStart(12, "0")}`;

export function kiroCliRecord(home: string, session: string, records: unknown[]): string {
  const dir = join(home, ".kiro", "sessions", "cli");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path, `${records.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");
  return path;
}

export const kiroCliPrompt = (text: string) => ({
  version: "v1",
  kind: "Prompt",
  data: { message_id: messageId(), content: [{ kind: "text", data: text }], meta: { timestamp: 1792832882 } },
});

export const kiroCliToolUse = (command: string) => ({
  version: "v1",
  kind: "AssistantMessage",
  data: {
    message_id: messageId(),
    content: [{ kind: "toolUse", data: { toolUseId: "toolu_0f1e2d3c", name: "shell", input: { command } } }],
  },
});

// The envelope Kiro wraps a message typed while the agent works in.
export const kiroCliSteerText = (words: string, id: string): string =>
  "[LIVE STEERING - New message from user]\n\nThe user sent a new message while you are working. As the currently " +
  "active agent, adjust your approach if necessary based on this guidance.\n\n" +
  `<user_message id="${id}">\n${words}\n</user_message>\n\nIMPORTANT: After completing your work, include a brief ` +
  "note about how you handled this steering message. Use this exact format:\n\n" +
  `[STEERING ${id}: <describe what you did or why it wasn't applicable>]`;

// The running tool's result, with each message typed meanwhile beside it.
export const kiroCliToolResults = (stdout: string, steers: Array<{ words: string; id: string }> = []) => ({
  version: "v1",
  kind: "ToolResults",
  data: {
    message_id: messageId(),
    content: [
      {
        kind: "toolResult",
        data: {
          toolUseId: "toolu_0f1e2d3c",
          content: [{ kind: "json", data: { exit_status: "exit status: 0", stdout, stderr: "" } }],
          status: "success",
        },
      },
      ...steers.map(({ words, id }) => ({ kind: "text", data: kiroCliSteerText(words, id) })),
    ],
    results: {},
  },
});
