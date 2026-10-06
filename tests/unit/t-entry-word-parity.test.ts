// covers: file:tools/aidlc-lib.ts
//
// The entry word the person typed (`/aidlc`, Codex's `$aidlc`) is never an
// argument. When an agent passes it on as the first argument, the engine's own
// reading drops it (t114 pins the work's name), and so do the terminal
// classifiers the hooks and adapters use: the Stop check, Kiro's intercept and
// Copilot's claim gate see the same command the engine runs.

import { describe, expect, test } from "bun:test";
import {
  classifyTerminalCommand,
  isReadOnlyNextArgv,
  withoutEntryWord,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const FORMS: string[][] = [
  ["help"],
  ["--help"],
  ["--status"],
  ["--doctor"],
  ["--version"],
  ["intent", "list"],
  ["space", "list"],
  ["config", "get", "depth"],
  ["knowledge", "list"],
  ["plugin", "list"],
  ["park"],
  ["--scope", "feature", "build auth across both repos"],
  ["build auth across both repos"],
];

describe("a leading entry word reads the same as the command after it", () => {
  for (const entry of ["/aidlc", "$aidlc"]) {
    test.each(FORMS.map((form) => [form.join(" "), form] as const))(`${entry} %s`, (_label, form) => {
      const passed = [entry, ...form];
      expect(withoutEntryWord(passed)).toEqual(form);
      expect(classifyTerminalCommand(passed)).toEqual(classifyTerminalCommand(form));
      expect(isReadOnlyNextArgv(passed)).toBe(isReadOnlyNextArgv(form));
    });
  }

  test("only the first argument, and only the bare word, is the entry word", () => {
    expect(withoutEntryWord(["build", "/aidlc", "support"])).toEqual(["build", "/aidlc", "support"]);
    expect(withoutEntryWord(["/aidlcx", "help"])).toEqual(["/aidlcx", "help"]);
    expect(withoutEntryWord([])).toEqual([]);
  });
});
