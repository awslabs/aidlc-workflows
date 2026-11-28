// covers: subcommand:aidlc-utility:status, function:workflowUsageSummary, function:selectionUsageKey
//
// Status says what a piece of work has used so far, over every session that
// worked on it. The status line counts one session and starts over in the
// next, so without this line the person has no running total until a stage
// completes. The line is there only where usage is recorded: with no ledger
// (every harness but Claude Code) or with tracking switched off, status is
// as it was.
//
// Mechanism: cli for status (the shipped tool against a temp project), with
// the ledger seeded in-process through updateLedger, the fold hook's own
// writer. Zero tokens, zero network.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  cleanupTestProject,
  removeWorkspaceRecord,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { costSegment } from "../../dist/claude/.claude/hooks/aidlc-statusline.ts";
import {
  computeCost,
  intentUsageKey,
  updateLedger,
  workflowUsageSummary,
  type TokenCounts,
  type UsageRow,
} from "../../dist/claude/.claude/tools/aidlc-usage.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// No chat names itself to the tools, so the work resolves from the project.
const env: Record<string, string | undefined> = { ...process.env };
for (const key of [
  "AIDLC_DISABLE_USAGE_TRACKING", "AIDLC_MODEL_RATES", "AIDLC_SCOPE_MAPPING",
  "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "KIRO_SESSION_ID",
]) {
  delete env[key];
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function tool(
  proj: string,
  name: string,
  [subcommand, ...args]: string[],
  extraEnv: Record<string, string> = {},
): string {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", name), subcommand, "--project-dir", proj, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...env, ...extraEnv },
    cwd: proj,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  expect(res.status, out).toBe(0);
  return out;
}

// A new piece of work on an empty folder.
function started(): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  removeWorkspaceRecord(proj);
  tool(proj, "aidlc-utility.ts", ["intent-create", "--scope", "feature"]);
  return proj;
}

const OPUS = "converse/us.anthropic.claude-opus-4-8";

function row(uuid: string, model: string, o: { input?: number; output?: number }): UsageRow {
  const counts: TokenCounts = {
    input: o.input ?? 0,
    output: o.output ?? 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
  };
  return {
    uuid,
    msgId: "",
    timestamp: "2026-07-23T04:22:43.957Z",
    model,
    isSidechain: false,
    sourceKey: uuid,
    agentId: null,
    agentType: "main",
    counts,
    usd: computeCost(counts, model).usd,
  };
}

// One session's usage folded onto the project's selected work.
function fold(proj: string, transcript: string, usage: UsageRow): void {
  updateLedger(proj, [usage], "requirements-analysis", {
    workflowKey: intentUsageKey(proj),
    sessionKey: `transcript:${transcript}`,
  });
}

function usageLine(out: string): string | null {
  return out.split("\n").find((line) => line.startsWith("Usage so far:")) ?? null;
}

describe("status says what the work has used so far", () => {
  test("no line without recorded usage, then the total over every session", () => {
    const proj = started();
    const before = tool(proj, "aidlc-utility.ts", ["status"]);
    expect(usageLine(before)).toBeNull();

    // 400k in + 50k out on opus = $3.25; the second session adds $0.09.
    fold(proj, "/t/first.jsonl", row("a1", OPUS, { input: 400_000, output: 50_000 }));
    expect(usageLine(tool(proj, "aidlc-utility.ts", ["status"])))
      .toBe("Usage so far:   400k tokens in, 50k out, about $3.25");

    fold(proj, "/t/second.jsonl", row("b1", OPUS, { input: 26, output: 3_500 }));
    const after = tool(proj, "aidlc-utility.ts", ["status"]);
    expect(usageLine(after)).toBe("Usage so far:   400k tokens in, 53.5k out, about $3.34 (2 sessions)");
    // The status line of the second session shows that session alone.
    expect(costSegment(proj, "/t/second.jsonl")).toBe("↑26 ↓3.5k $0.09");
    // The line sits under Completion; the rest of status is as it was.
    expect(after).toContain("stages (0%)\nUsage so far:   400k tokens in");
    expect(after.split("\n").filter((line) => !line.startsWith("Usage so far:")).join("\n")).toBe(before);

    // Tracking switched off: the ledger stays on disk and status says nothing.
    expect(usageLine(tool(proj, "aidlc-utility.ts", ["status"], { AIDLC_DISABLE_USAGE_TRACKING: "1" })))
      .toBeNull();
  });

  test("usage that cannot be priced shows its tokens and no cost", () => {
    const proj = started();
    fold(proj, "/t/only.jsonl", row("u1", "some-unlisted-model", { input: 1_200, output: 340 }));
    expect(workflowUsageSummary(proj, intentUsageKey(proj))).toBe("1.2k tokens in, 340 out");
    expect(usageLine(tool(proj, "aidlc-utility.ts", ["status"])))
      .toBe("Usage so far:   1.2k tokens in, 340 out");
  });
});
