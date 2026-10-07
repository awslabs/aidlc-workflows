// covers: hook:aidlc-record-human-turn, hook:aidlc-session-start, file:skills/aidlc/SKILL.md
//
// t-journey-check-off-on.sdk.test.ts - the person turns one of their own
// checks off, and back on, from the chat (live SDK).
//
// What a person hit without this (live run L13-C, Claude Code): they asked in
// the chat to turn the review freeze check off and were refused three times
// ("your switch, not mine."), had to type the terminal command themselves, and
// "turn it back on" was refused with a false reason.
//
// The journey: a piece of work in progress, Guard Policy strict.
//   chat 1: the person types "turn the review freeze check off for this
//           project". It is off at once, recorded as the person's own chat
//           request, with no question first.
//   chat 2: a new chat. The session start says the check is off and that the
//           person asked for it. The person types "turn the review freeze
//           check back on for this project". It is on again at once, with no
//           question first.
//
// Pass/fail reads only what the engine recorded and printed: the setting
// (`engine config get guard.review-freeze`), the recorded switch, the engine's
// lines handed to the agent, the SessionStart hook's output, and the pickers
// shown. NEVER the agent's prose.
//
// The fixture guard profile is used on purpose: a production run sets every
// recordable bypass to 0 in the environment, which overrides the very settings
// file this journey checks.
//
// It SPENDS TOKENS. Gated on the claude CLI (calling driveAidlc marks the file
// SDK-dependent; the runner skips with a reason when claude is absent).

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
  NATIVE_STARTUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";
import { type DriveResult, driveAidlc } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

const SWITCH = "AIDLC_DISABLE_REVIEW_FREEZE_HOOK";
const TURN_OFF = "turn the review freeze check off for this project";
const TURN_ON = "turn the review freeze check back on for this project";
// The engine's own lines (aidlc-recorded-switches.ts).
const OFF_LINE = "The review freeze check (it stops edits to work you already approved) is off for this project since";
const ON_LINE = "The review freeze check is on again for this project.";

function reviewFreeze(proj: string): string {
  const r = spawnSync("bun", [".claude/tools/aidlc.ts", "engine", "config", "get", "guard.review-freeze"], {
    cwd: proj,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}

// The switches still off and how each was set, read in a fresh process: the
// settings reader caches each file per process, and this one outlives the
// agent's changes.
function switchesOff(proj: string): Array<{ name: string; entry: { how?: string } | null }> {
  const r = spawnSync("bun", ["-e", `
    const { switchesOff } = await import(${JSON.stringify(join(proj, ".claude", "tools", "aidlc-recorded-switches.ts"))});
    console.log(JSON.stringify(switchesOff(process.argv[1])));
  `, proj], { cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

function engineSaid(result: DriveResult, line: string): number {
  return result.toolResults.filter((t) => t.toolName === "Bash" && t.resultText.includes(line)).length;
}

describe("t-journey-check-off-on (sdk): a check turned off and on from the chat is done at once and said plainly", () => {
  test(
    "off from the chat, the new chat says so, back on from the chat",
    async () => {
      expect(process.env[SWITCH], `${SWITCH} in the environment would hide the person's switch`).toBeUndefined();
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const budget = () => remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
        deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
      });
      const proj = setupIntegrationProject({ withState: "state-mid-ideation.md", stripEnvScope: true });
      try {
        const state = seededStateFile(proj);
        writeFileSync(state, readFileSync(state, "utf-8")
          .replace("- **Scope**: feature", "- **Scope**: feature\n- **Guard Policy**: strict (set by you)"));
        expect(reviewFreeze(proj)).toBe("on (default)");

        // Chat 1: off, at once, as the person's own request.
        const off = await driveAidlc(TURN_OFF, { projectDir: proj, persistSession: true, timeoutMs: budget() });
        expect(off.timedOut).toBe(false);
        expect(off.askedQuestions, "a question came before the person's own request was done").toEqual([]);
        expect(reviewFreeze(proj)).toBe(`off (${SWITCH} in aidlc.settings.local.json)`);
        const recorded = switchesOff(proj).find((item) => item.name === SWITCH);
        expect(recorded?.entry?.how, "the switch was not recorded as the person's chat request").toBe("chat");
        expect(engineSaid(off, OFF_LINE), "the done line was not handed out once").toBe(1);

        // Chat 2: the new chat says it is off, then back on at once.
        const on = await driveAidlc(TURN_ON, { projectDir: proj, persistSession: true, timeoutMs: budget() });
        expect(on.timedOut).toBe(false);
        const started = (on.sessionStarts ?? []).join("\n");
        expect(started, "the new chat did not say the check is off").toContain(OFF_LINE);
        expect(started).toContain("because you said:");
        expect(on.askedQuestions, "a question came before the person's own request was done").toEqual([]);
        expect(reviewFreeze(proj)).toBe("on (default)");
        expect(switchesOff(proj).some((item) => item.name === SWITCH), "the switch is still recorded off").toBe(false);
        expect(engineSaid(on, ON_LINE), "the on-again line was not handed out once").toBe(1);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
