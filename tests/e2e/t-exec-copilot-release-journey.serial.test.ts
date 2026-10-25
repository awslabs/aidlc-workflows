// covers: scope:bugfix, file:skills/aidlc/SKILL.md, hook:aidlc-record-human-turn, audit:GATE_APPROVED
//
// t-exec-copilot-release-journey.serial.test.ts - a person's first day with
// AI-DLC on GitHub Copilot CLI, live, before each release (#1345). The shared
// journey is in tests/harness/release-journey.ts: install through the copy
// channel, doctor, the documented first step, "1" at the plan question,
// "Approve" at Reverse Engineering.
//
//   case 1: the folder is trusted, the way Copilot's own trust dialog records
//           it. Every line the person types has a message record (the hooks
//           ran) and no other record holds words they never typed (a
//           subagent's brief is no turn of theirs), the plan question waits
//           for them, their files stay as they were until "1" starts the
//           bugfix plan, Reverse Engineering asks for approval and "Approve"
//           approves it, and doctor no longer says the hooks never ran.
//   case 2: the folder is NOT trusted. `copilot -p` then skips the project's
//           hooks without a word, which is how a workshop lost a morning: no
//           message record may appear, and doctor must tell the person the
//           folder is not trusted and how to fix it.
//
// The model is Copilot's own-model mode (BYOK): in CI the Full Suite points it
// at the credential broker, so no GitHub sign-in or Copilot seat is involved.
// Pass/fail reads only what AI-DLC recorded, doctor and the person's files,
// never the agent's prose.
// The run's report (seconds per turn, hook runs by kind from Copilot's own
// session record, tokens) lands in the test's log folder.
//
// LIVE GATE: AIDLC_COPILOT_EXEC_LIVE=1, a copilot >= 1.0.95 binary on PATH (or
// AIDLC_COPILOT_BIN), a model provider (BYOK variables, a GitHub token, or
// AIDLC_COPILOT_ASSUME_AUTH=1) and the production guard profile
// (--production-guards). Skips cleanly otherwise. SPENDS TOKENS. Serial.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { copilotTurn, trustCopilotFolder } from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  checkReleaseJourneyTurn,
  doctorChecks,
  expectPersonFirstInJourney,
  hooksRanProblems,
  RELEASE_JOURNEY_TURNS,
  type ReleaseJourneyReport,
  recordedPersonLines,
  releaseJourneyEvidence,
  runReleaseJourney,
  setupReleaseJourneyProject,
} from "../harness/release-journey.ts";

const COPILOT_BIN = process.env.AIDLC_COPILOT_BIN ?? "copilot";
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);

function copilotVersion(): string | null {
  const result = spawnSync(COPILOT_BIN, ["--version"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  const match = (result.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (result.status !== 0 || !match) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major > 1 || (major === 1 && (minor > 0 || patch >= 95)) ? match[0] : null;
}

// The runner gives this file the production guard profile on its own (it looks
// for this comparison), even in a shard of fixture-profile files.
const PRODUCTION_GUARDS = process.env.AIDLC_TEST_GUARD_PROFILE === "production";

function skipReason(): string | null {
  if (process.env.AIDLC_COPILOT_EXEC_LIVE !== "1") return "set AIDLC_COPILOT_EXEC_LIVE=1 to run the live Copilot release journey (uses your provider)";
  if (!PRODUCTION_GUARDS) return "run with --production-guards: the journey is the person's own guard profile";
  if (!copilotVersion()) return `copilot >= 1.0.95 not found (AIDLC_COPILOT_BIN=${COPILOT_BIN})`;
  if (!existsSync(join(REPO_ROOT, "dist", "copilot"))) return "dist/copilot is missing: run bun scripts/package.ts";
  if (
    !process.env.COPILOT_PROVIDER_BASE_URL && !process.env.COPILOT_GITHUB_TOKEN && !process.env.GH_TOKEN &&
    !process.env.GITHUB_TOKEN && process.env.AIDLC_COPILOT_ASSUME_AUTH !== "1"
  ) {
    return "no provider visible: set COPILOT_PROVIDER_BASE_URL (BYOK), a GitHub token variable, or AIDLC_COPILOT_ASSUME_AUTH=1 for a signed-in CLI";
  }
  return null;
}
const SKIP_REASON = skipReason();

// Hook runs by kind, from Copilot's own session record of this home.
function hookRuns(copilotHome: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const sessions = join(copilotHome, "session-state");
  if (!existsSync(sessions)) return counts;
  for (const session of readdirSync(sessions)) {
    const events = join(sessions, session, "events.jsonl");
    if (!existsSync(events)) continue;
    for (const line of readFileSync(events, "utf8").split("\n")) {
      try {
        const event = JSON.parse(line) as { type?: string; data?: { hookType?: string } };
        if (event.type === "hook.start") counts[event.data?.hookType ?? "?"] = (counts[event.data?.hookType ?? "?"] ?? 0) + 1;
      } catch {
        // A partly written last line is not a hook run.
      }
    }
  }
  return counts;
}

function tokens(usageFile: string): Record<string, number> {
  if (!existsSync(usageFile)) return {};
  const usage = JSON.parse(readFileSync(usageFile, "utf8")) as {
    modelMetrics?: Record<string, { usage?: { inputTokens?: number; outputTokens?: number } }>;
  };
  let input = 0;
  let output = 0;
  for (const metrics of Object.values(usage.modelMetrics ?? {})) {
    input += metrics.usage?.inputTokens ?? 0;
    output += metrics.usage?.outputTokens ?? 0;
  }
  return { "input tokens": input, "output tokens": output };
}

describe("t-exec-copilot-release-journey: a person's first day on Copilot CLI, before each release", () => {
  test.skipIf(SKIP_REASON !== null)(
    `trusted folder: every line recorded, the plan question asked, Reverse Engineering approved${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const deadline = Date.now() + TEST_TIMEOUT_MS;
      const project = setupReleaseJourneyProject("copilot");
      const copilotHome = join(project.root, "copilot-home");
      trustCopilotFolder(copilotHome, project.proj);
      const env = { ...process.env, COPILOT_HOME: copilotHome };
      const sessionId = randomUUID();
      const usageFile = join(project.root, "usage.json");
      const report: ReleaseJourneyReport = {
        harness: "copilot", toolVersion: copilotVersion() ?? "?", turns: [], extra: {}, problems: [],
      };
      let lastOut = "";
      runReleaseJourney(report, () => {
        for (const [index, line] of RELEASE_JOURNEY_TURNS.entries()) {
          const started = Date.now();
          const turn = copilotTurn(project.proj, line, {
            copilotHome, sessionId, resume: index > 0, usageFile, timeoutMs: Math.max(1, deadline - Date.now()),
          });
          report.turns.push({ line, seconds: Math.round((Date.now() - started) / 1000) });
          lastOut = turn.out;
          if (turn.rc !== 0) report.problems.push(`Copilot ended "${line}" with exit ${turn.rc}: ${turn.out.slice(-1500)}`);
          checkReleaseJourneyTurn(report, project, index + 1, line);
          if (report.problems.length) break;
        }
        // A subagent's brief reaches the hooks as a prompt too: only the lines
        // the person typed may be on their record.
        const typed: readonly string[] = RELEASE_JOURNEY_TURNS;
        for (const line of recordedPersonLines(project.proj).filter((recorded) => !typed.includes(recorded))) {
          report.problems.push(`a message record holds words the person never typed: "${line.slice(0, 120)}"`);
        }
        if (!report.problems.length) report.problems.push(...hooksRanProblems(doctorChecks(project, env)));
        const runs = hookRuns(copilotHome);
        report.extra = { "hook runs": Object.values(runs).reduce((sum, count) => sum + count, 0), ...tokens(usageFile), hooksByKind: runs };
        if (report.problems.length) report.extra.evidence = { ...releaseJourneyEvidence(project.proj), output: lastOut.slice(-4000) };
      });
      expectPersonFirstInJourney(report);
      expect(report.problems).toEqual([]);
      rmSync(project.root, { recursive: true, force: true });
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(SKIP_REASON !== null)(
    `folder not trusted: no hook runs, and doctor names the trust fix${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const project = setupReleaseJourneyProject("copilot");
      const copilotHome = join(project.root, "copilot-home");
      mkdirSync(copilotHome, { recursive: true });
      const turn = copilotTurn(project.proj, RELEASE_JOURNEY_TURNS[0], {
        copilotHome, sessionId: randomUUID(), resume: false, timeoutMs: TEST_TIMEOUT_MS,
      });
      const checks = doctorChecks(project, { ...process.env, COPILOT_HOME: copilotHome });
      expect({
        rc: turn.rc,
        recorded: recordedPersonLines(project.proj),
        untrustedNamed: checks.some((check) => !check.pass && check.label.startsWith("Copilot CLI has not trusted this folder")),
      }, turn.out.slice(-1500)).toEqual({ rc: 0, recorded: [], untrustedNamed: true });
      rmSync(project.root, { recursive: true, force: true });
    },
    TEST_TIMEOUT_MS,
  );
});
