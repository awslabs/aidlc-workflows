// Kiro's own chat record for Kiro CLI v3 and Kiro IDE:
// ~/.kiro/sessions/<workspace id>/<session id>/messages.jsonl, one
// {id, timestamp, payload} row per line, in the shape kiro-cli 3.0.0 writes
// (captured live). A message the person types while the agent works is a
// `steer-<id>` row of its own, written as it is typed; Kiro then hands it to the
// agent inside its own envelope (`steering-injection`) and clears it at the
// turn's end (`steering_boundary_`).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let rows = 0;
const rowId = (): string => `1062d840-ccc8-4e6e-87eb-${String(++rows).padStart(12, "0")}`;
const at = (): string => new Date(Date.UTC(2026, 10, 6, 5, 5, rows)).toISOString();

export function kiroV3Record(home: string, session: string, records: unknown[]): string {
  const dir = join(home, ".kiro", "sessions", "b59fd518bbdd8a1b", session);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "messages.jsonl");
  writeFileSync(path, `${records.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");
  return path;
}

// A typed prompt, and the row that starts its turn.
export const kiroV3Prompt = (content: string) => [
  { id: rowId(), timestamp: at(), payload: { type: "user", content, _meta: { kiro: { userMessageTag: `prompt_${rowId()}` } } } },
  { id: `${rowId()}-turn-start`, timestamp: at(), payload: { type: "turn_start" } },
];

export const kiroV3ToolResult = (output: string) =>
  ({ id: `run_command_toolu_${rowId()}-result`, timestamp: at(), payload: { type: "tool_result", content: `Output:\n${output}\n\nExit Code: 0`, _meta: { kiro: { agentMode: "aidlc" } } } });

// A message typed while the agent works, as Kiro writes it when it is typed.
export const kiroV3Typed = (words: string, id: string) =>
  ({ id, timestamp: at(), payload: { type: "user", content: words, source: "steer" } });

// Kiro's envelope around it, written when Kiro hands it to the agent.
export const kiroV3HandedOn = (words: string, id: string) =>
  ({
    id: rowId(),
    timestamp: at(),
    payload: {
      type: "user",
      content: "[LIVE STEERING - New message from user]\n\nThe user sent a new message while you are working. As the currently " +
        `active agent, adjust your approach if necessary based on this guidance.\n\n<user_message id="${id}">\n${words}\n</user_message>`,
      _meta: { kiro: { syntheticUserMessageReason: "steering-injection", steeringConsumedIds: [id] } },
    },
  });

// Typed while the agent works, then handed on.
export const kiroV3Steer = (words: string, id: string) => [kiroV3Typed(words, id), kiroV3HandedOn(words, id)];

// What Kiro writes when its turn ends: the steers it handed on, cleared.
export const kiroV3TurnEnd = (cleared: string[]) => [
  { id: `${rowId()}-turn-end`, timestamp: at(), payload: { type: "turn_end" } },
  { id: `steering_boundary_${rowId()}`, timestamp: at(), payload: { type: "user", content: "", source: "steer", _meta: { kiro: { steeringClearedIds: cleared } } } },
];

// A workflow's notice, as Kiro CLI 2.34.0 on its v3 engine writes it with Workflows on
// (captured live): `source: "steer"` too.
export const kiroV3WorkflowNotice = (content: string) =>
  ({
    id: `notify-${rowId()}`,
    timestamp: at(),
    payload: { type: "user", content, source: "steer", _meta: { kiro: { notification: { kind: "system-notification", status: "success" } } } },
  });
