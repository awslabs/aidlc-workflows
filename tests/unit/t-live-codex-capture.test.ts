// covers: function:codexWords, function:codexExecArgs
//
// The live input check reads what Codex said to the person out of `codex exec` output, and hands Codex the typed line.
// Three ways that capture once blamed the agent for the tool's own output: codex exec prints the workspace diff after
// the agent's last message, so the diff was judged as the agent's words; a line that starts with a codex exec
// subcommand word (`help`) or a dash (`--change-control strict`) was parsed by codex exec itself, so its usage text or
// error was judged as the agent's words; and without any message marker the whole output stood as the agent's words.
import { describe, expect, test } from "bun:test";
import { codexWords } from "../harness/aidlc-input-corpus.ts";
import { codexExecArgs } from "../harness/exec-drive.ts";

const EVENT_LOG = [
  "OpenAI Codex v0.160.0",
  "--------",
  "user",
  "$aidlc fix the login",
  "hook: UserPromptSubmit",
  "hook: UserPromptSubmit Completed",
  "codex",
  "Let me get started on 'fix the login'.",
  "hook: PreToolUse",
  "exec",
  "/usr/bin/zsh -lc 'bun .codex/tools/aidlc.ts engine orchestrate next fix the login' in /tmp/proj",
  " succeeded in 841ms:",
  '{"kind":"ask","question":"Work is already in progress"}',
  "",
  "hook: PostToolUse",
  "codex",
  "**New Work Routing** Work is already in progress on: \"Todo app bug fix\". What should I do?",
  "",
  "1. **Part of the active work**",
  "2. **Separate new piece of work**",
  "",
  "Reply with a number, or just tell me.",
  "diff --git a/aidlc/spaces/default/intents/fixture/aidlc-state.md b/aidlc/spaces/default/intents/fixture/aidlc-state.md",
  "index 1111111..2222222 100644",
  "--- a/aidlc/spaces/default/intents/fixture/aidlc-state.md",
  "+++ b/aidlc/spaces/default/intents/fixture/aidlc-state.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "tokens used",
  "40,712",
].join("\n");

describe("what Codex said to the person", () => {
  test("the agent's messages, without the tool log, the engine's JSON or the workspace diff codex exec prints last", () => {
    const words = codexWords(EVENT_LOG);
    expect(words).toContain("Let me get started on 'fix the login'.");
    expect(words).toContain("Reply with a number, or just tell me.");
    expect(words).not.toContain("engine orchestrate next");
    expect(words).not.toContain('"kind":"ask"');
    expect(words).not.toContain("diff --git");
    expect(words).not.toContain("+new");
  });

  test("codex exec's own usage text or error, with no message from the agent, is not the agent's words", () => {
    const usage = ["Run Codex non-interactively", "", "Usage: codex exec [OPTIONS] [PROMPT]", "Commands:", "  help    Print this message"].join("\n");
    expect(codexWords(usage)).toBe("");
    expect(codexWords("error: unexpected argument '--change-control strict' found")).toBe("");
  });
});

describe("the typed line reaches Codex as the prompt", () => {
  test("a line that is a codex exec subcommand word or starts with a dash is still the prompt, never an argument", () => {
    for (const line of ["help", "--change-control strict", "resume", "$aidlc --status"]) {
      const argv = codexExecArgs(line);
      expect(argv.at(-1), line).toBe(line);
      expect(argv.at(-2), `${line}: options end before the prompt`).toBe("--");
    }
  });
});
