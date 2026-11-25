// covers: file:tests/harness/depth-refusal-turn.ts
//
// What the depth journey (t-tui-t27-depth-override) reads off a live Claude
// Code turn, fed hand-made calls: the call that took the person's
// `/aidlc --depth extreme` to `next`, the skill's first command `next --entry`
// among them, and the one picker after it, with the host's own lookup of a
// tool before it.

import { afterAll, describe, expect, test } from "bun:test";
import { afterHostLookups, isCanonicalDepthRefusalCall } from "../harness/depth-refusal-turn.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";
import type { NativeToolCall } from "../harness/t139-fidelity.ts";

const NEXT = "bun .claude/tools/aidlc.ts engine orchestrate next";
const project = createTestProject();
const elsewhere = createTestProject();
afterAll(() => {
  cleanupTestProject(project);
  cleanupTestProject(elsewhere);
});

// A folder as the agent types it in front of its command: in double quotes,
// with backslashes on Windows.
function typedFolder(dir: string): string {
  return `"${process.platform === "win32" ? dir.replaceAll("/", "\\") : dir}"`;
}
const bash = (command: string): NativeToolCall => ({ name: "Bash", input: { command } });
const tool = (name: string, input: Record<string, unknown> = {}): NativeToolCall => ({ name, input });
const picker = tool("AskUserQuestion", { questions: [{ question: "Which depth did you mean?" }] });
const names = (calls: readonly NativeToolCall[]): string[] => calls.map((call) => call.name);

// Each command, and whether it is the call that took their line to `next`.
function recognised(commands: readonly string[], dir = project): Record<string, boolean> {
  return Object.fromEntries(commands.map((command) => [command, isCanonicalDepthRefusalCall(bash(command), dir)]));
}

// A turn as the journey's picker branch reads it: the calls after the first
// one that took their line to `next`, the host's lookups before the picker
// taken off; null when no call did.
function afterTheRefusal(calls: readonly NativeToolCall[]): string[] | null {
  const refused = calls.findIndex((call) => isCanonicalDepthRefusalCall(call, project));
  return refused < 0 ? null : names(afterHostLookups(calls.slice(refused + 1)));
}

describe("the call that took their depth word to next", () => {
  test("the skill's first command, next --entry, whatever the agent put after the word", () => {
    const commands = [
      `${NEXT} --entry`,
      `${NEXT} --entry --depth extreme`,
      `${NEXT} --entry --resume --depth extreme`,
      `${NEXT} --entry --entry --depth extreme`,
      `${NEXT} --entry --depth comprehensive`,
      `cd ${typedFolder(project)} && ${NEXT} --entry --depth extreme`,
    ];
    expect(recognised(commands)).toEqual(Object.fromEntries(commands.map((command) => [command, true])));
  });

  test("a next line with no entry word first is read as it is written", () => {
    expect(recognised([`${NEXT} --depth extreme`, `${NEXT} --resume --depth extreme`])).toEqual({
      [`${NEXT} --depth extreme`]: true,
      [`${NEXT} --resume --depth extreme`]: true,
    });
    expect(recognised([`${NEXT} --depth comprehensive`, NEXT, `${NEXT} --resume`])).toEqual({
      [`${NEXT} --depth comprehensive`]: false,
      [NEXT]: false,
      [`${NEXT} --resume`]: false,
    });
  });

  test("a call in another folder, another engine command or another tool is not that call", () => {
    const other = `cd ${typedFolder(elsewhere)} && ${NEXT} --entry --depth extreme`;
    const resumed = "bun .claude/tools/aidlc.ts engine orchestrate continue --entry";
    expect(recognised([other, resumed])).toEqual({ [other]: false, [resumed]: false });
    expect(isCanonicalDepthRefusalCall(picker, project)).toBe(false);
  });
});

describe("what came after it", () => {
  test("the host's lookup of a tool before the picker is no call of the agent's", () => {
    expect(names(afterHostLookups([tool("ToolSearch"), picker]))).toEqual(["AskUserQuestion"]);
    expect(names(afterHostLookups([tool("ToolSearch"), tool("ToolSearch"), picker]))).toEqual(["AskUserQuestion"]);
    expect(names(afterHostLookups([picker]))).toEqual(["AskUserQuestion"]);
    expect(names(afterHostLookups([]))).toEqual([]);
  });

  test("any other call before the picker, and anything after it, still counts", () => {
    expect(names(afterHostLookups([tool("Bash"), picker]))).toEqual(["Bash", "AskUserQuestion"]);
    expect(names(afterHostLookups([tool("ToolSearch"), tool("Bash"), picker]))).toEqual(["Bash", "AskUserQuestion"]);
    expect(names(afterHostLookups([picker, tool("ToolSearch")]))).toEqual(["AskUserQuestion", "ToolSearch"]);
  });
});

describe("a turn that asked with one picker after next refused the word", () => {
  test("next with their word on it, the host's lookup of the picker's tool, then the picker", () => {
    const turn = [
      bash(`${NEXT} --depth extreme`),
      tool("ToolSearch", { query: "select:AskUserQuestion", max_results: 1 }),
      picker,
    ];
    expect(afterTheRefusal(turn)).toEqual(["AskUserQuestion"]);
  });

  test("the skill's first command with their word after it, then the picker", () => {
    const turn = [bash(`cd ${typedFolder(project)} && ${NEXT} --entry --depth extreme`), picker];
    expect(afterTheRefusal(turn)).toEqual(["AskUserQuestion"]);
  });
});
