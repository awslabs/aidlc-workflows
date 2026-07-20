// covers: file:settings.json
//
// t219 - Claude settings must quote CLAUDE_PROJECT_DIR command paths.
//
// Regression pin for issue 519: Claude Code expands the settings.json command
// strings through a shell, so `bun $CLAUDE_PROJECT_DIR/...` splits when the
// workspace path contains spaces. The authored harness settings and the
// generated Claude dist copy must both keep every `$CLAUDE_PROJECT_DIR`
// occurrence inside double quotes. The permissions glob deliberately leaves the
// `*` outside the quotes so Claude's Bash matcher still globs:
// `Bash(bun "$CLAUDE_PROJECT_DIR/.claude/tools/"*)`.
//
// Mechanism: none. This reads and parses the two static JSON files on disk,
// walks only command fields and permission entries (the executable surfaces),
// and checks the exact bug shape cannot reappear.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const SUBJECTS = [
  {
    label: "authored Claude harness settings",
    path: join(REPO_ROOT, "harness", "claude", "settings.json"),
  },
  {
    label: "generated Claude dist settings",
    path: join(REPO_ROOT, "dist", "claude", ".claude", "settings.json"),
  },
] as const;

const PROJECT_DIR = "$CLAUDE_PROJECT_DIR";
const PROJECT_DIR_RE = /\$CLAUDE_PROJECT_DIR/g;
const BUG_SHAPE_RE = /(^|[\s(])\$CLAUDE_PROJECT_DIR\b/;
const EXPECTED_PROJECT_DIR_REFERENCES = 15; // 13 + both PreToolUse guards
const EXPECTED_PERMISSION_GLOB = 'Bash(bun "$CLAUDE_PROJECT_DIR/.claude/tools/"*)';

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

function executableSettingsStrings(settings: unknown): string[] {
  return [...collectCommandStrings(settings), ...permissionEntries(settings)];
}

function projectDirReferenceCount(values: string[]): number {
  return values.reduce(
    (count, value) => count + [...value.matchAll(PROJECT_DIR_RE)].length,
    0,
  );
}

function isInsideDoubleQuotes(value: string, index: number): boolean {
  let inDoubleQuotes = false;
  let escaped = false;

  for (let i = 0; i < index; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inDoubleQuotes = !inDoubleQuotes;
  }

  return inDoubleQuotes;
}

function hasClosingDoubleQuote(value: string, index: number): boolean {
  let escaped = false;

  for (let i = index; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') return true;
  }

  return false;
}

function unquotedProjectDirReferences(value: string): string[] {
  return [...value.matchAll(PROJECT_DIR_RE)]
    .filter(
      (match) =>
        !isInsideDoubleQuotes(value, match.index) ||
        !hasClosingDoubleQuote(value, match.index),
    )
    .map((match) => value.slice(Math.max(0, match.index - 8)));
}

describe("t219 Claude settings quote CLAUDE_PROJECT_DIR command paths", () => {
  for (const subject of SUBJECTS) {
    test(`${subject.label}: executable settings quote every CLAUDE_PROJECT_DIR reference`, () => {
      const settings = readSettings(subject.path);
      const values = executableSettingsStrings(settings).filter((value) =>
        value.includes(PROJECT_DIR),
      );

      expect(projectDirReferenceCount(values)).toBe(EXPECTED_PROJECT_DIR_REFERENCES);
      expect(permissionEntries(settings)).toContain(EXPECTED_PERMISSION_GLOB);

      const unquoted = values.filter((value) =>
        unquotedProjectDirReferences(value).length > 0,
      );
      expect(unquoted).toEqual([]);

      // Pin the original shell-splitting bug shape directly: reverting the fix
      // to `bun $CLAUDE_PROJECT_DIR/...` trips this even if formatting moves.
      expect(values.filter((value) => BUG_SHAPE_RE.test(value))).toEqual([]);
    });
  }
});
