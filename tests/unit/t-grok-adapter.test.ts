// The Grok adapter is packaged beside the core hooks. These cases spawn that
// file. They do not import it: the source tree's relative aidlc-lib import
// resolves only after packaging.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const ADAPTER = join(REPO_ROOT, "dist", "grok", ".grok", "hooks", "aidlc-grok-adapter.ts");
const SOURCE_ADAPTER = join(REPO_ROOT, "harness", "grok", "hooks", "aidlc-grok-adapter.ts");

function run(
  target: string,
  stdin: string,
  cwd = REPO_ROOT,
  extraEnv: Record<string, string> = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [ADAPTER, target], {
    input: stdin,
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_PROJECT_DIR: cwd,
      CLAUDE_PROJECT_DIR: cwd,
      AIDLC_UNATTENDED: "",
      ...extraEnv,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("t-grok-adapter", () => {
  test("the hook file calls the adapter guards target", () => {
    for (const path of [
      join(REPO_ROOT, "harness", "grok", "hooks", "aidlc.json"),
      join(REPO_ROOT, "dist", "grok", ".grok", "hooks", "aidlc.json"),
    ]) {
      const wiring = JSON.parse(readFileSync(path, "utf-8")) as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
      };
      expect(wiring.hooks.PreToolUse[0]?.hooks[0]?.command, path).toBe(
        "bun .grok/hooks/aidlc-grok-adapter.ts guards",
      );
      expect(wiring.hooks.PreToolUse[0]?.hooks[0]?.timeout, path).toBe(60);
    }
  });

  test("the adapter source names the reviewer-scope and state-transition guards", () => {
    const source = readFileSync(SOURCE_ADAPTER, "utf-8");
    expect(source).toContain("aidlc-reviewer-scope.ts");
    expect(source).toContain("aidlc-state-transition-guard.ts");
  });

  test("malformed guard input denies the call", () => {
    const result = run("guards", "{");
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "deny" });
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("a nested spawn_subagent is denied before the core guards", () => {
    const result = run(
      "guards",
      JSON.stringify({
        tool_name: "spawn_subagent",
        subagentType: "aidlc-developer-agent",
        tool_input: { prompt: "keep going" },
      }),
    );
    expect(result.status).toBe(2);
    const body = JSON.parse(result.stdout) as { decision?: string; reason?: string };
    expect(body.decision).toBe("deny");
    expect(body.reason).toContain("nested delegation is not allowed");
  });

  test("a closing stop and a subagent stop are not completion gates", () => {
    const closed = run("stop", JSON.stringify({ reason: "channel_closed" }));
    expect(closed.status).toBe(0);
    expect(closed.stdout).toBe("");
    const nested = run(
      "stop",
      JSON.stringify({ reason: "end_turn", subagentType: "aidlc-developer-agent" }),
    );
    expect(nested.status).toBe(0);
    expect(nested.stdout).toBe("");
  });

  function pickerMessages(dir: string): Array<{ source?: string; text?: string; words?: string | null; picker?: Array<{ question: string; reply: string | null }> }> {
    const folder = join(dir, "aidlc", ".aidlc-sessions", "messages");
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(folder, name), "utf-8")) as {
        source?: string;
        text?: string;
        words?: string | null;
        picker?: Array<{ question: string; reply: string | null }>;
      });
  }

  function hasTurnHeartbeat(dir: string): boolean {
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop() ?? dir;
      for (const entry of readdirSync(current)) {
        const path = join(current, entry);
        if (statSync(path).isDirectory()) stack.push(path);
        else if (entry === "record-human-turn.last") return true;
      }
    }
    return false;
  }

  function questionPayload(result: unknown): string {
    return JSON.stringify({
      session_id: "grok-picker-test",
      tool_name: "ask_user_question",
      tool_input: {
        questions: [{
          question: "How would you like to answer them?",
          options: [
            { label: "Guide me", description: "Walk through each question" },
            { label: "I'll edit the file", description: "Fill in the file" },
            { label: "Chat", description: "Discuss freely" },
          ],
        }],
      },
      tool_response: result,
    });
  }

  test("a Grok question-box pick is recorded as the person's reply", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-grok-picker-"));
    try {
      const result = run(
        "audit-and-sensors",
        questionPayload({
          type: "AskUserQuestion",
          UserAnswered: {
            message: "User has answered your questions: \"How would you like to answer them?\"=\"Guide me\".",
            answers: [{
              question: "How would you like to answer them?",
              options: ["Guide me", "I'll edit the file", "Chat"],
              picked: ["Guide me"],
            }],
          },
        }),
        dir,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      const stored = pickerMessages(dir);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        source: "picker",
        text: "Guide me",
        words: "Guide me",
        picker: [{ question: "How would you like to answer them?", reply: "Guide me" }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("several picks in one Grok question box stay several picks", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-grok-picker-multi-"));
    try {
      const result = run(
        "audit-and-sensors",
        questionPayload({
          type: "AskUserQuestion",
          UserAnswered: {
            answers: [{
              question: "How would you like to answer them?",
              picked: ["Guide me", "Chat"],
            }],
          },
        }),
        dir,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      const stored = pickerMessages(dir);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.picker).toEqual([
        { question: "How would you like to answer them?", reply: "Guide me, Chat" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dismissed Grok question box records no reply", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-grok-picker-empty-"));
    try {
      const result = run(
        "audit-and-sensors",
        questionPayload({
          type: "AskUserQuestion",
          UserAnswered: {
            answers: [{
              question: "How would you like to answer them?",
              picked: [],
            }],
          },
        }),
        dir,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(pickerMessages(dir)).toEqual([]);
      expect(hasTurnHeartbeat(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an AskUserQuestion result that is not a question box records nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-grok-picker-foreign-"));
    try {
      const result = run(
        "audit-and-sensors",
        questionPayload({ type: "Bash", output: "Guide me" }),
        dir,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(pickerMessages(dir)).toEqual([]);
      expect(hasTurnHeartbeat(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Read in an empty project is not denied", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-grok-adapter-"));
    try {
      const result = run(
        "guards",
        JSON.stringify({ tool_name: "read_file", tool_input: { target_file: "README.md" } }),
        dir,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
