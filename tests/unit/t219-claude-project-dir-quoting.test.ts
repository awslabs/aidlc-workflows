// covers: file:settings.json
//
// t219 - Claude settings must use root-relative dispatcher command paths.
//
// Regression pin for issue 519: Claude Code expands the settings.json command
// strings through a shell. The authored harness settings and generated Claude
// dist now route hooks through the root-relative dispatcher, so command fields
// contain no `$CLAUDE_PROJECT_DIR` references and paths with spaces never enter
// these command strings. The executable permission uses the matching
// root-relative `Bash(bun .claude/tools/*)` form.
//
// Mechanism: none. This reads and parses the two static JSON files on disk,
// walks command fields and permission entries, and checks both dispatcher forms.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const SUBJECTS = [
  {
    label: "authored Claude harness settings",
    path: join(REPO_ROOT, "harness", "claude", "settings.json"),
    commandPrefix: "{{INVOKE}}",
    foldUsageCommand: "{{INVOKE}} engine hook fold-usage",
  },
  {
    label: "generated Claude dist settings",
    path: join(REPO_ROOT, "dist", "claude", ".claude", "settings.json"),
    commandPrefix: "bun .claude/tools/aidlc.ts",
    foldUsageCommand: "bun .claude/tools/aidlc.ts engine hook fold-usage",
  },
] as const;

const PROJECT_DIR_RE = /\$CLAUDE_PROJECT_DIR/g;
const EXPECTED_PROJECT_DIR_COMMAND_REFERENCES = 0;
const EXPECTED_PERMISSION_GLOB = "Bash(bun .claude/tools/*)";

interface Settings {
  permissions?: { allow?: unknown };
}

function readSettings(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectCommandStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectCommandStrings(item, out);
    return out;
  }

  if (!isRecord(value)) return out;

  for (const [key, child] of Object.entries(value)) {
    if (key === "command" && typeof child === "string") out.push(child);
    collectCommandStrings(child, out);
  }
  return out;
}

function permissionEntries(settings: unknown): string[] {
  const allow = (settings as Settings).permissions?.allow;
  return Array.isArray(allow)
    ? allow.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function eventHookGroups(settings: unknown, event: string): unknown[] {
  if (!isRecord(settings) || !isRecord(settings.hooks)) return [];
  const groups = settings.hooks[event];
  return Array.isArray(groups) ? groups : [];
}

function hasUnfilteredFoldUsageHook(
  settings: unknown,
  event: string,
  expectedCommand: string,
): boolean {
  return eventHookGroups(settings, event).some((group) => {
    if (!isRecord(group) || group.matcher !== "" || !Array.isArray(group.hooks)) {
      return false;
    }
    return group.hooks.some(
      (hook) =>
        isRecord(hook) &&
        hook.command === expectedCommand,
    );
  });
}

function projectDirReferenceCount(values: string[]): number {
  return values.reduce(
    (count, value) => count + [...value.matchAll(PROJECT_DIR_RE)].length,
    0,
  );
}

describe("t219 Claude settings use root-relative dispatcher commands", () => {
  for (const subject of SUBJECTS) {
    test(`${subject.label}: command paths use the dispatcher without CLAUDE_PROJECT_DIR`, () => {
      const settings = readSettings(subject.path);
      const commands = collectCommandStrings(settings);

      expect(commands.length).toBeGreaterThan(0);
      expect(projectDirReferenceCount(commands)).toBe(
        EXPECTED_PROJECT_DIR_COMMAND_REFERENCES,
      );
      expect(
        commands.every((command) => command.startsWith(subject.commandPrefix)),
      ).toBe(true);
      expect(permissionEntries(settings)).toContain(EXPECTED_PERMISSION_GLOB);
      expect(projectDirReferenceCount(permissionEntries(settings))).toBe(0);
    });

    test(`${subject.label}: fold-usage is unfiltered on both tool events`, () => {
      const settings = readSettings(subject.path);
      expect(
        hasUnfilteredFoldUsageHook(
          settings,
          "PreToolUse",
          subject.foldUsageCommand,
        ),
      ).toBe(true);
      expect(
        hasUnfilteredFoldUsageHook(
          settings,
          "PostToolUse",
          subject.foldUsageCommand,
        ),
      ).toBe(true);
    });
  }
});
