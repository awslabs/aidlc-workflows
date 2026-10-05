// covers: hook:aidlc-record-human-turn, audit:GUARD_POLICY_SET, audit:GUARD_DISABLED,
// subcommand:aidlc-utility:intent-create, subcommand:aidlc-utility:config-change,
// subcommand:aidlc-utility:status, scope:enterprise
//
// Live customer journey: the person lowers production guards by typing a
// switch, which the shipped UserPromptSubmit hook applies, or by asking in
// plain words, which the agent carries out as the person's request.
// SPENDS TOKENS. Requires AIDLC_CLAUDE_SDK_LIVE=1 and --production-guards.
// Like t-guard-recovery-production, the fixture profile skips rather than
// restoring disabled guards. The runner explains an explicitly selected skip:
// "For production guard journeys, rerun with --production-guards".
// Calling driveAidlc marks this file SDK-dependent for t19 and --no-llm.

import { describe, expect, test } from "bun:test";
import {
  auditBlockField,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { assertToolResultContains } from "../harness/assert.ts";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";
import {
  type DriveOptions,
  driveAidlc,
  readAuditEvents,
  readAuditText,
  readStateFile,
  stateFilePathFor,
} from "../harness/sdk-drive.ts";

const productionTest =
  process.env.AIDLC_TEST_GUARD_PROFILE === "production" ? test : test.skip;
const GUARD_SWITCHES = [
  "AIDLC_SKIP_ARTIFACT_GUARD",
  "AIDLC_SKIP_HUMAN_PRESENCE_GUARD",
  "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
  "AIDLC_SKIP_REVISION_BACKSTOP",
  "AIDLC_SKIP_REVIEWER_GATE_GUARD",
  "AIDLC_SKIP_SOURCE_FRESHNESS",
  "AIDLC_DISABLE_REVIEW_FREEZE_HOOK",
  "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK",
  "AIDLC_DISABLE_PLAN_APPROVAL_GUARD",
  "AIDLC_ALLOW_DIRECT_AUDIT_EVENTS",
  "AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS",
  "AIDLC_UNATTENDED",
] as const;

// The six drive caps total 13 minutes; leave teardown room below 14 minutes.
const TEST_TIMEOUT_MS = 820_000;
const INIT_STATE_SUMMARY = "State initialized:";
const RELAXED_LINE = "- **Guard Policy**: relaxed (set by you)";

describe.skipIf(
  process.env.AIDLC_CLAUDE_SDK_LIVE !== "1" ||
    process.env.AIDLC_NO_LLM === "1" ||
    !Bun.which("claude"),
)("production guards: lowering from a live Claude chat", () => {
  productionTest("typed switches and plain words both lower the active intent's guards, as the person's", async () => {
    // Do not sanitize these: a fixture bypass must fail this production proof.
    for (const key of GUARD_SWITCHES) {
      expect(process.env[key], `${key} disables the production contract`).not.toBe("1");
    }
    const projectDir = setupIntegrationProject({
      noAidlcDocs: true,
      stripEnvScope: true,
    });
    const guardEvents = (event: string) =>
      (readAuditEvents(projectDir) ?? []).filter((value) => value === event);
    const stateLines = () => readStateFile(projectDir)?.split("\n") ?? [];
    const drive = async (
      prompt: string,
      timeoutMs: number,
      stopAfterToolResult?: DriveOptions["stopAfterToolResult"],
    ) => {
      const started = Date.now();
      const result = await driveAidlc(prompt, {
        projectDir,
        timeoutMs,
        stopAfterToolResult,
        persistSession: stopAfterToolResult === undefined,
      });
      // Preserve exact state/audit evidence and usage in the runner log even if
      // an assertion fails and the scratch project is subsequently removed.
      console.info("[live-guards]", JSON.stringify({
        prompt,
        elapsedMs: Date.now() - started,
        timedOut: result.timedOut,
        stoppedAfterToolResult: result.stoppedAfterToolResult,
        turns: result.resultEvent?.num_turns,
        usage: result.resultEvent?.raw.usage,
        costUsd: result.resultEvent?.raw.total_cost_usd,
        assistantText: result.resultEvent?.result ?? result.assistantText,
        statePath: stateFilePathFor(projectDir),
        state: readStateFile(projectDir),
        audit: readAuditText(projectDir),
      }));
      expect(result.timedOut, `Live drive timed out: ${prompt}`).toBe(false);
      return result;
    };

    try {
      const created = await drive(
        '/aidlc --scope enterprise "add a health endpoint returning ok"',
        120_000,
        { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY },
      );
      assertToolResultContains(created, "Bash", INIT_STATE_SUMMARY);
      expect(stateLines()).toContain("- **Guard Policy**: strict (from scope enterprise)");
      expect(guardEvents("GUARD_POLICY_SET")).toHaveLength(0);
      expect(guardEvents("GUARD_DISABLED")).toHaveLength(0);

      // A flags-only invocation resumes the workflow after applying the switch.
      // Stop at its deterministic acknowledgement, before unrelated stage work.
      const relaxed = await drive("/aidlc --guard-policy relaxed", 240_000, {
        toolName: "Bash",
        resultIncludes: "Guard Policy",
      });
      expect(stateLines()).toContain(RELAXED_LINE);
      expect(guardEvents("GUARD_POLICY_SET")).toHaveLength(1);
      const policyRows = readAuditShardEvents(projectDir).filter(
        (entry) => entry.event === "GUARD_POLICY_SET",
      );
      expect(policyRows).toHaveLength(1);
      expect(auditBlockField(policyRows[0].block, "Source")).toBe("you");
      assertToolResultContains(relaxed, "Bash", "Guard Policy");

      const disabled = await drive("/aidlc config set guard.state-transition off", 90_000, {
        toolName: "Bash",
        resultIncludes: "Fence state-transition",
      });
      expect(stateLines()).toContain(RELAXED_LINE);
      expect(stateLines()).toContain("- **Guards Off**: state-transition (set by you)");
      expect(guardEvents("GUARD_POLICY_SET")).toHaveLength(1);
      expect(guardEvents("GUARD_DISABLED")).toHaveLength(1);
      const disabledRows = readAuditShardEvents(projectDir).filter(
        (entry) => entry.event === "GUARD_DISABLED",
      );
      expect(disabledRows).toHaveLength(1);
      expect(auditBlockField(disabledRows[0].block, "Guard")).toBe("state-transition");
      expect(auditBlockField(disabledRows[0].block, "Source")).toBe("you");
      assertToolResultContains(disabled, "Bash", "Fence state-transition");

      const status = await drive("/aidlc --status", 60_000, {
        toolName: "Bash",
        resultIncludes: "Checks off:",
      });
      assertToolResultContains(status, "Bash", "Guard Policy");
      assertToolResultContains(status, "Bash", "Checks off:");
      const statusOutput = status.toolResults.find(
        (result) => result.toolName === "Bash" && result.resultText.includes("Checks off:"),
      );
      expect(statusOutput?.resultText).toMatch(/^Checks off:.*\bstate-transition\b/m);

      // Plain words that name one check lower that check, not the whole
      // policy: the review freeze setter runs and Guard Policy stays relaxed.
      const one = await drive("stop asking me to re-approve when files change", 120_000, {
        toolName: "Bash",
        resultIncludes: "review-freeze",
      });
      assertToolResultContains(one, "Bash", "review-freeze");
      expect(stateLines()).toContain(RELAXED_LINE);
      expect(guardEvents("GUARD_POLICY_SET")).toHaveLength(1);

      // Plain words are the person's request too: the agent runs the setter for
      // them, the change is set by you with their words, and one line says how
      // to put it back. No exact typing. The guards as a whole are the Guard
      // Policy, even when the same words also name one check.
      const asked = "please stop asking me to re-approve when files change, turn the guards off";
      const plain = await drive(asked, 150_000, {
        toolName: "Bash",
        resultIncludes: "Guard Policy is off for this piece of work",
      });
      assertToolResultContains(plain, "Bash", `Guard Policy is off for this piece of work, because you said: "${asked}".`);
      expect(stateLines()).toContain("- **Guard Policy**: off (set by you)");
      const plainRows = readAuditShardEvents(projectDir).filter((entry) => entry.event === "GUARD_POLICY_SET");
      expect(plainRows).toHaveLength(2);
      expect(auditBlockField(plainRows[1].block, "Source")).toBe("you");
      expect(auditBlockField(plainRows[1].block, "Person Reply")).toBe(asked);
    } finally {
      cleanupTestProject(projectDir);
    }
  }, TEST_TIMEOUT_MS);
});
