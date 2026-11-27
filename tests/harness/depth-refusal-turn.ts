// What the depth journey (tests/e2e/t-tui-t27-depth-override.serial.test.ts)
// reads off a Claude Code turn: the engine calls the agent made in its
// project, the one that took the person's `/aidlc --depth extreme` to `next`,
// and the calls after it. Its unit check feeds it hand-made calls, since a
// live turn cannot be had on demand.

import { statSync } from "node:fs";
import { nextFlagShape, parseLiteralShellInvocation } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import type { NativeToolCall } from "./t139-fidelity.ts";

const CANONICAL_NEXT = ["bun", ".claude/tools/aidlc.ts", "engine", "orchestrate", "next"];

// A literal engine call made in this project: no directory prelude, or one
// that is this project directory.
export function literalEngineCall(call: NativeToolCall, projectDir: string): string[] | null {
  if (call.name !== "Bash") return null;
  const parsed = parseLiteralShellInvocation(String(call.input.command));
  if (!parsed) return null;
  if (parsed.directory === null) return parsed.argv;
  try {
    const selected = statSync(parsed.directory, { bigint: true });
    const expected = statSync(projectDir, { bigint: true });
    return selected.isDirectory() && expected.isDirectory() &&
      selected.ino !== 0n && selected.dev === expected.dev && selected.ino === expected.ino
      ? parsed.argv
      : null;
  } catch {
    return null;
  }
}

export function startsWithWords(argv: readonly string[], words: readonly string[]): boolean {
  return JSON.stringify(argv.slice(0, words.length)) === JSON.stringify(words);
}

// The call that took the person's `--depth extreme` to `next`. The skill's
// first command is `next --entry`: the orchestrator's entry point (`main` in
// core/tools/aidlc-orchestrate.ts) takes the word off when it is the first of
// `next`'s own words, and runs the line the person typed, read from its own
// record (`entryTokens`); what the agent put after it is the command only
// where no line of theirs is on record (`entryLine` returns "step"), and the
// line this journey types is (the prompt hook records it). So that call is
// the one, whatever follows the word. Any other line is read as written: the
// agent may add a flag of its own that takes no value (`--resume`, as the
// resume line tells it to); `next` reads the refused value first and takes
// nothing else from the line, so that call is the same refusal.
export function isCanonicalDepthRefusalCall(call: NativeToolCall, projectDir: string): boolean {
  const argv = literalEngineCall(call, projectDir);
  if (argv === null || !startsWithWords(argv, CANONICAL_NEXT)) return false;
  const words = argv.slice(CANONICAL_NEXT.length);
  if (words[0] === "--entry") return true;
  const modifier = words.filter((token) => nextFlagShape(token)?.value !== "none");
  return JSON.stringify(modifier) === JSON.stringify(["--depth", "extreme"]);
}

// Claude Code's own lookup of a tool it has not loaded yet: it asks and
// decides nothing for the person.
const HOST_LOOKUP = "ToolSearch";

// The calls from the first that is not the host's lookup.
export function afterHostLookups(calls: readonly NativeToolCall[]): NativeToolCall[] {
  const first = calls.findIndex((call) => call.name !== HOST_LOOKUP);
  return first < 0 ? [] : calls.slice(first);
}
