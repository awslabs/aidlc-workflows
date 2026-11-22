// covers: harness-instrument:sdk-drive-turns
//
// Pins the SDK harness pieces a multi-turn live journey relies on, without
// driving a live Claude turn: the person's next message reaches the same
// session in order, nothing is sent after the drive closes, a Stop hook block
// is read from its output, and "Chat about this" returns Claude Code's own
// clarify result with no answer in it. The tokens a drive used come from
// Claude Code's transcripts, each reply counted once at its final usage.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturedStopHook, chatAboutThisResult, driveInput, transcriptUsage } from "../harness/sdk-drive.ts";

async function collect(messages: AsyncIterable<{ message: { content: unknown } }>): Promise<unknown[]> {
  const seen: unknown[] = [];
  for await (const m of messages) seen.push(m.message.content);
  return seen;
}

describe("sdk-drive turns", () => {
  test("the prompt, then each next message in order; the stream ends at close and drops later sends", async () => {
    const input = driveInput("first");
    const seen = collect(input.messages);
    await Bun.sleep(5);
    input.send("second");
    input.send("third");
    await Bun.sleep(5);
    input.close("done");
    input.send("after close");
    expect(await seen).toEqual(["first", "second", "third"]);
    expect(input.closedReason).toBe("done");
  });

  test("a message sent before the stream is read still arrives after the prompt", async () => {
    const input = driveInput("first");
    input.send("second");
    input.close("done");
    expect(await collect(input.messages)).toEqual(["first", "second"]);
  });

  test("a Stop hook block is read from its output; an empty output lets the turn end", () => {
    const reason = "The AI-DLC workflow is not finished.";
    expect(capturedStopHook({ stdout: `${JSON.stringify({ decision: "block", reason })}\n`, outcome: "success" }, 1))
      .toEqual({ turn: 1, blocked: true, reason, outcome: "success" });
    expect(capturedStopHook({ stdout: "", outcome: "success" }, 2)).toEqual({ turn: 2, blocked: false, outcome: "success" });
    expect(capturedStopHook({ stdout: "not json", outcome: "error" }, 1)).toEqual({ turn: 1, blocked: false, outcome: "error" });
  });

  test("Chat about this names every question as unanswered", () => {
    const text = chatAboutThisResult([
      { question: "Where does this go?", options: [{ label: "Here" }] },
      { question: "Anything else?", options: [{ label: "No" }] },
    ]);
    expect(text.startsWith("The user wants to clarify these questions.")).toBe(true);
    expect(text).toContain('- "Where does this go?"\n  (No answer provided)\n- "Anything else?"\n  (No answer provided)');
    expect(text).not.toContain("Answer:");
  });

  test("a drive's token use: each reply once, at its last usage, in the main and subagent transcripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-usage-"));
    const line = (id: string, model: string, usage: Record<string, number>) => JSON.stringify({ type: "assistant", message: { id, model, usage } });
    mkdirSync(join(dir, "projects", "p", "s1", "subagents"), { recursive: true });
    writeFileSync(join(dir, "projects", "p", "s1.jsonl"), [
      line("m1", "claude-opus-4-8", { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 40, output_tokens: 6 }),
      line("m1", "claude-opus-4-8", { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 40, output_tokens: 120 }),
      JSON.stringify({ type: "user", message: { content: "no usage here" } }),
      '{"type":"assistant","message":{"id":"m9","usage":{"output_t',
    ].join("\n"));
    writeFileSync(join(dir, "projects", "p", "s1", "subagents", "a.jsonl"),
      line("m2", "claude-sonnet-4-6", { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 7 }));
    expect(transcriptUsage(dir)).toEqual({
      "claude-opus-4-8": { input: 3, cacheRead: 100, cacheWrite: 40, output: 120 },
      "claude-sonnet-4-6": { input: 1, cacheRead: 10, cacheWrite: 0, output: 7 },
    });
    expect(transcriptUsage(join(dir, "missing"))).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
});
