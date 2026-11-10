// readSessionsFolder() feeds safe.json. The usage ledger's cursor keys are the
// absolute paths of the person's chat logs, so their folder names must not
// reach it: only how many logs AI-DLC followed, and from which tool.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionsFolder } from "../../core/skills/aidlc-issue-report/scripts/lib-audit.ts";

test("ledger cursors leave no path in the result", () => {
  const project = mkdtempSync(join(tmpdir(), "sessions-test-"));
  const base = join(project, "aidlc", ".aidlc-sessions");
  mkdirSync(base, { recursive: true });
  const cursors = {
    "/Users/jdoe/.claude/projects/-Users-jdoe-acmecorp-portal/137307be-2b29-4ff6-91c0-0948e739ddcd.jsonl": {},
    "/home/jdoe/.codex/sessions/2026/10/29/rollout-2026-10-29T01-00-00-acmecorp.jsonl": {},
  };
  writeFileSync(join(base, "usage-ledger.json"), JSON.stringify({ cursors }));
  const result = readSessionsFolder(project);
  const text = JSON.stringify(result);
  expect(text).not.toContain("acmecorp");
  expect(text).not.toContain("jdoe");
  expect(result.transcriptCursors).toEqual({ count: 2, tools: ["claude", "codex"] });
});
