import { expect, test } from "bun:test";
import { gateText, turnEvidence } from "../harness/codex-turn-evidence.ts";

const thread = { type: "thread.started", thread_id: "00000000-0000-4000-8000-000000000001" };
const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const message = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });
const completed = { type: "turn.completed" };

test("gate evidence survives a later final-message reminder", () => {
  const proposal = "Choose one:\n1. Approve\n2. Edit the grid\n3. Reject";
  const evidence = turnEvidence(jsonl([
    thread, message(proposal), message("Your move."), completed,
  ]));
  expect(evidence.sessionId).toBe(thread.thread_id);
  expect(gateText(evidence)).toBe(proposal);
});

test("tool output and subagent results cannot supply the conductor's approval gate", () => {
  const reminder = "Awaiting your choice: `1`, `2`, or `3`.";
  const evidence = turnEvidence(jsonl([
    thread,
    { type: "item.completed", item: { type: "command_execution", aggregated_output: "Approve, Edit, Reject" } },
    { type: "item.completed", item: { type: "collab_tool_call", output: "Choose one: Approve, Edit, Reject" } },
    { type: "item.completed", item: { type: "reasoning", text: "Approve, Edit, Reject" } },
    message(reminder), completed,
  ]));
  expect(evidence.agentMessages).toEqual([reminder]);
  expect(/approv|choose/i.test(gateText(evidence))).toBe(false);
  expect(/reject/i.test(gateText(evidence))).toBe(false);
});

test("conflicting sessions and incomplete turns cannot establish gate evidence", () => {
  expect(() => turnEvidence(jsonl([
    thread, { ...thread, thread_id: "00000000-0000-4000-8000-000000000002" }, completed,
  ]))).toThrow("exactly one session");
  expect(() => turnEvidence(jsonl([thread, message("Approve or Reject")]))).toThrow("completed turn");
  expect(() => turnEvidence(jsonl([thread, { type: "turn.failed" }, completed]))).toThrow("completed turn");
  expect(() => turnEvidence(jsonl([thread, completed, { type: "turn.started" }]))).toThrow("completed turn");
});
