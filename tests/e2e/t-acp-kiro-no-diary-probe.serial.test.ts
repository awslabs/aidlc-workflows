// covers: file:skills/aidlc/SKILL.md
//
// Live Kiro ACP trace for the run-stage diary boundary. The engine creates the
// stage memory.md before it emits run-stage; the conductor must move from the
// required context reads to the stage body without reading, probing, or
// initializing that path. We cancel at the first questions-file write and
// inspect only tool calls up to that checkpoint.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { seededRecordDir } from "../harness/fixtures.ts";
import {
  type AcpToolCall,
  AcpSession,
  driveKiroAcp,
} from "../harness/kiro-acp-drive.ts";
import {
  cleanupTuiProject,
  KIRO_SRC,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "900", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 900) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(180_000, TEST_TIMEOUT_MS - 30_000);

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro no-diary-probe trace (uses Kiro credits)";
  }
  if (spawnSync("kiro-cli", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not found";
  }
  if (spawnSync("kiro-cli", ["whoami"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

function callInput(call: AcpToolCall): string {
  return `${call.title}\n${call.kind}\n${JSON.stringify(call.rawInput ?? "")}`;
}

function exactDiaryPathPattern(): RegExp {
  return /(?:^|[/\\\s"'=:])memory\.md(?![A-Za-z0-9._-])/i;
}

function isForbiddenDiaryAccess(call: AcpToolCall): boolean {
  const input = callInput(call);
  if (!exactDiaryPathPattern().test(input)) return false;

  // Kiro's diary contract permits only its native edit operation. Any shell
  // command touching the exact diary path is forbidden, regardless of whether
  // it reads, probes, appends, or rewrites; otherwise `cat`, PowerShell, or a
  // novel shell spelling could bypass a read-verb allowlist.
  return call.kind.toLowerCase() !== "edit";
}

function isCompletedQuestionsWrite(call: AcpToolCall): boolean {
  if (
    call.kind.toLowerCase() !== "edit" ||
    call.status.toLowerCase() !== "completed" ||
    call.rawInput === null ||
    typeof call.rawInput !== "object" ||
    Array.isArray(call.rawInput)
  ) {
    return false;
  }
  const path = (call.rawInput as { path?: unknown }).path;
  return (
    typeof path === "string" &&
    /(?:^|[/\\])intent-capture-questions\.md$/i.test(path)
  );
}

function syntheticCall(
  title: string,
  kind: string,
  rawInput: unknown,
  status = "completed",
): AcpToolCall {
  return {
    toolCallId: title,
    title,
    kind,
    rawInput,
    output: [],
    status,
  };
}

describe("t-acp-kiro no pre-stage diary probe", () => {
  test("diary classifier rejects native and shell access while allowing direct edits", () => {
    const diary =
      "aidlc/spaces/default/intents/work/ideation/intent-capture/memory.md";
    const forbidden = [
      syntheticCall("Reading memory.md:1", "read", {
        operations: [{ mode: "Line", path: diary }],
      }),
      syntheticCall(`Running: cat ${diary}`, "execute", {
        command: `cat ${diary}`,
      }),
      syntheticCall(`Running: sed -n '1,20p' ${diary}`, "execute", {
        command: `sed -n '1,20p' ${diary}`,
      }),
      syntheticCall(`Running: [ -f "${diary}" ]`, "execute", {
        command: `[ -f "${diary}" ]`,
      }),
      syntheticCall(`Running: Get-Content ${diary}`, "execute", {
        command: `Get-Content ${diary}`,
      }),
      syntheticCall(`Running: Test-Path ${diary}`, "execute", {
        command: `Test-Path ${diary}`,
      }),
      syntheticCall(`Running: type ${diary}`, "execute", {
        command: `type ${diary}`,
      }),
      syntheticCall(`Running: printf note >> ${diary}`, "execute", {
        command: `printf note >> ${diary}`,
      }),
      syntheticCall(`Running: cat ${diary};true`, "execute", {
        command: `cat ${diary};true`,
      }),
      syntheticCall(`Running: cat ${diary}|more`, "execute", {
        command: `cat ${diary}|more`,
      }),
      syntheticCall(`Running: cat ${diary}&echo ok`, "execute", {
        command: `cat ${diary}&echo ok`,
      }),
      syntheticCall(`Running: output=$(cat ${diary})`, "execute", {
        command: `output=$(cat ${diary})`,
      }),
    ];
    expect(
      forbidden
        .filter((call) => !isForbiddenDiaryAccess(call))
        .map((call) => call.title),
    ).toEqual([]);

    const allowed = [
      syntheticCall("Editing memory.md", "edit", {
        path: diary,
        oldStr: "## Interpretations",
        newStr: "## Interpretations\n- observation",
      }),
      syntheticCall("Reading memory-template.md:1", "read", {
        operations: [
          {
            mode: "Line",
            path: ".kiro/knowledge/aidlc-shared/memory-template.md",
          },
        ],
      }),
      syntheticCall("Reading aidlc-state.md:1", "read", {
        operations: [{ mode: "Line", path: "aidlc-state.md" }],
      }),
      syntheticCall("Reading memory.md.bak:1", "read", {
        operations: [{ mode: "Line", path: `${diary}.bak` }],
      }),
      syntheticCall("Reading memory.md2:1", "read", {
        operations: [{ mode: "Line", path: `${diary}2` }],
      }),
    ];
    expect(
      allowed
        .filter(isForbiddenDiaryAccess)
        .map((call) => call.title),
    ).toEqual([]);
  });

  test("questions checkpoint ignores probes and failed edits before the completed native write", () => {
    const questions =
      "aidlc/spaces/default/intents/work/ideation/intent-capture/intent-capture-questions.md";
    const diary =
      "aidlc/spaces/default/intents/work/ideation/intent-capture/memory.md";
    const calls = [
      syntheticCall("Reading intent-capture-questions.md:1", "read", {
        operations: [{ mode: "Line", path: questions }],
      }),
      syntheticCall("Creating intent-capture-questions.md", "edit", {
        path: questions,
        content: "incomplete",
      }, "failed"),
      syntheticCall("Reading memory.md:1", "read", {
        operations: [{ mode: "Line", path: diary }],
      }),
      syntheticCall("Creating intent-capture-questions.md", "edit", {
        path: questions,
        content: "complete",
      }),
    ];

    const checkpoint = calls.findIndex(isCompletedQuestionsWrite);
    expect(checkpoint).toBe(3);
    expect(calls[checkpoint]?.kind).toBe("edit");
    expect(
      calls
        .slice(0, checkpoint + 1)
        .filter(isForbiddenDiaryAccess)
        .map((call) => call.title),
    ).toEqual(["Reading memory.md:1"]);
  });

  test.skipIf(SKIP_REASON !== null)(
    `run-stage reaches its first questions write without reading or probing memory.md${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const project = setupTuiProject({
        harness: "kiro",
        withState: "state-initialization-done.md",
        greenfieldStub: true,
        withAudit: true,
        runtimeGraph: true,
      });
      const stageDir = join(
        seededRecordDir(project),
        "ideation",
        "intent-capture",
      );
      const diaryPath = join(stageDir, "memory.md");
      const questionsPath = join(stageDir, "intent-capture-questions.md");
      const session = new AcpSession(project, "aidlc", true);
      let cancelled = false;
      const poll = setInterval(() => {
        if (!cancelled && session.sessionId && existsSync(questionsPath)) {
          cancelled = true;
          session.notify("session/cancel", { sessionId: session.sessionId });
        }
      }, 250);

      try {
        const result = await driveKiroAcp({
          projectDir: project,
          session,
          keepAlive: true,
          timeoutMs: DRIVE_TIMEOUT_MS,
          prompt:
            "/aidlc --scope poc --stage intent-capture --single " +
            "Build a tiny TypeScript command-line program that prints Hello World. " +
            "Create the stage questions, then wait for my answer.",
        });

        expect(existsSync(questionsPath)).toBe(true);
        expect(existsSync(diaryPath)).toBe(true);
        const diary = readFileSync(diaryPath, "utf-8");
        expect(diary).toContain("## Interpretations");
        expect(diary).toContain("## Open questions");

        const questionCallIndex =
          result.toolCalls.findIndex(isCompletedQuestionsWrite);
        expect(questionCallIndex).toBeGreaterThan(-1);
        expect(result.toolCalls[questionCallIndex]?.kind).toBe("edit");
        const preCheckpointCalls = result.toolCalls.slice(0, questionCallIndex + 1);
        const forbidden = preCheckpointCalls
          .filter(isForbiddenDiaryAccess)
          .map((call) => callInput(call));
        expect(forbidden).toEqual([]);

        expect(
          preCheckpointCalls.some((call) =>
            /(?:^|[/\\])intent-capture\.md(?:$|["'\s,}\]])/i.test(
              callInput(call),
            ),
          ),
        ).toBe(true);
      } finally {
        clearInterval(poll);
        session.close();
        cleanupTuiProject(project);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
