// covers: harness-instrument:tui-drive-setting-sources
// covers: harness-instrument:tui-drive-revision-recovery
// covers: harness-instrument:kiro-numbered-prose-answering
//
// Pins the TUI harness' setting-source isolation. Live TUI journeys drive the
// real Claude CLI, but should load only the copied project .claude settings by
// default so developer/user-level hooks cannot contaminate deterministic tests.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  readAllAuditShards,
  stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  CUSTOM_SCOPE,
  SNAPSHOT_STAGE_SLUG,
} from "../harness/custom-harness.ts";
import {
  gridIsApprovalGate,
  normalizeTuiCommand,
  pickRevisionOption,
  pickRevisionTypeSomethingOption,
} from "../harness/tui-drive.ts";
import {
  cleanupTuiProject,
  compileTuiRuntimeGraph,
  createKiroNumberedProseAnswerState,
  nextKiroNumberedProseAnswer,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import { seededRecordDir } from "../harness/fixtures.ts";

function env(settingSources?: string): NodeJS.ProcessEnv {
  return settingSources === undefined
    ? {}
    : { AIDLC_TUI_SETTING_SOURCES: settingSources };
}

describe("tui-drive setting-source isolation", () => {
  test("bare claude commands default to project-only settings", () => {
    expect(
      normalizeTuiCommand(["claude", "--dangerously-skip-permissions"], env()),
    ).toEqual([
      "claude",
      "--setting-sources",
      "project",
      "--dangerously-skip-permissions",
    ]);
  });

  test("absolute claude paths and Windows executables are normalized too", () => {
    expect(
      normalizeTuiCommand(["/opt/homebrew/bin/claude", "--resume"], env()),
    ).toEqual([
      "/opt/homebrew/bin/claude",
      "--setting-sources",
      "project",
      "--resume",
    ]);

    expect(
      normalizeTuiCommand(["C:\\Program Files\\nodejs\\claude.exe"], env()),
    ).toEqual([
      "C:\\Program Files\\nodejs\\claude.exe",
      "--setting-sources",
      "project",
    ]);
  });

  test("Windows claude.cmd npm shims are normalized too", () => {
    expect(
      normalizeTuiCommand(["claude.cmd", "--dangerously-skip-permissions"], env()),
    ).toEqual([
      "claude.cmd",
      "--setting-sources",
      "project",
      "--dangerously-skip-permissions",
    ]);

    expect(
      normalizeTuiCommand(["C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd"], env()),
    ).toEqual([
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
      "--setting-sources",
      "project",
    ]);
  });

  test("Windows claude.ps1 npm shims are normalized too", () => {
    expect(
      normalizeTuiCommand(["claude.ps1", "--resume"], env()),
    ).toEqual([
      "claude.ps1",
      "--setting-sources",
      "project",
      "--resume",
    ]);

    expect(
      normalizeTuiCommand(["C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1"], env()),
    ).toEqual([
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1",
      "--setting-sources",
      "project",
    ]);
  });

  test("explicit setting sources win", () => {
    expect(
      normalizeTuiCommand(
        ["claude", "--setting-sources", "user,project,local", "--resume"],
        env(),
      ),
    ).toEqual(["claude", "--setting-sources", "user,project,local", "--resume"]);

    expect(
      normalizeTuiCommand(["claude", "--setting-sources=user,project,local"], env()),
    ).toEqual(["claude", "--setting-sources=user,project,local"]);
  });

  test("environment override can customize or disable injection", () => {
    expect(
      normalizeTuiCommand(["claude"], env("project,local")),
    ).toEqual(["claude", "--setting-sources", "project,local"]);

    expect(normalizeTuiCommand(["claude"], env("default"))).toEqual(["claude"]);
    expect(normalizeTuiCommand(["claude"], env(""))).toEqual(["claude"]);
  });

  test("non-claude commands are left unchanged", () => {
    expect(
      normalizeTuiCommand(["node", "script.js", "claude"], env()),
    ).toEqual(["node", "script.js", "claude"]);
  });
});

describe("tui-drive revision recovery detection", () => {
  test("recognizes a numbered Approve / Request Changes approval gate", () => {
    const approvalGate = `
Approve the stage and continue?

❯ 1. Approve
  Accept the artifacts and continue.
  2. Request Changes
  Revise the artifacts before continuing.
  3. Type something.
────────────────────────────────────────────────────────────────
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

    expect(gridIsApprovalGate(approvalGate)).toBe(true);
  });

  test("does not mistake a preparatory Guide / Edit / Chat menu for approval", () => {
    const preparatoryMenu = `
How would you like to continue?

❯ 1. Guide me
  Ask focused questions.
  2. Edit directly
  Open the draft.
  3. Chat about this
────────────────────────────────────────────────────────────────
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

    expect(gridIsApprovalGate(preparatoryMenu)).toBe(false);
  });

  test("does not mistake consolidated summary confirmation for approval", () => {
    const summaryConfirmation = `
Does this all look correct before I generate the artifact?

❯ 1. Looks correct
  Generate the artifact from these answers.
  2. Request changes
  Revise one or more answers before generation.
────────────────────────────────────────────────────────────────
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

    expect(gridIsApprovalGate(summaryConfirmation)).toBe(false);
  });

  test("does not treat a pending multi-tab learnings tab as revision feedback", () => {
    const learningsTab = `
←  ☒ RE Gate  ☐ Learnings  ✔ Submit  →

The stage diary surfaced learning candidates. Persist any as a project-level rule?

❯ 1. [ ] None (recommended)
  These are one-off diagnostic findings for this bug.
  2. [ ] localStorage default
  Persist: prefer browser-native localStorage.
  3. [ ] Type something
     Submit
────────────────────────────────────────────────────────────────
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

    expect(pickRevisionOption(learningsTab)).toBeNull();
  });

  test("picks the first real revision directive from the recovery menu", () => {
    const recoveryMenu = `
What would you like to change?

❯ 1. Actually approve & continue
  I didn't mean to request changes.
  2. Narrow root cause to checkbox persistence
  Revise the analysis before advancing.
  3. Type something.
────────────────────────────────────────────────────────────────
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

    expect(pickRevisionOption(recoveryMenu)).toBe(2);
  });

  test("selects the typed-feedback path from a change-type recovery menu", () => {
    const changeTypeMenu = `
What would you like changed in the reverse-engineering artifacts?

❯ 1. Fix a specific artifact
  One or more files has an inaccuracy or omission.
  2. Add detail / depth
  The artifacts are correct but too shallow somewhere.
  3. Redo the stage
  Re-run the scan and synthesis from scratch.
  4. Type something.
────────────────────────────────────────────────────────────────
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

    expect(pickRevisionOption(changeTypeMenu)).toBeNull();
    expect(pickRevisionTypeSomethingOption(changeTypeMenu)).toBe(4);
  });
});

describe("Kiro numbered-prose answer classification", () => {
  test("answers guide batches, summary, learnings, and approval in order", () => {
    const state = createKiroNumberedProseAnswerState();
    expect(
      nextKiroNumberedProseAnswer(
        "How would you like to answer these? 1. Guide me 2. Edit 3. Chat",
        state,
      ),
    ).toBe("1");
    expect(
      nextKiroNumberedProseAnswer(
        "Q1. First question\n1. A\nQ2. Second question\n1. A",
        state,
      ),
    ).toBe("Q1: 1, Q2: 1");
    expect(
      nextKiroNumberedProseAnswer(
        "Does this all look correct?\n1. Looks correct\n2. Request changes",
        state,
      ),
    ).toBe("Looks correct");
    expect(
      nextKiroNumberedProseAnswer(
        "Anything to add for next time?\n1. Nothing to add\n2. Add a note",
        state,
      ),
    ).toBe("Nothing to add");
    expect(
      nextKiroNumberedProseAnswer(
        "How would you like to proceed?\n1. Approve\n2. Request Changes",
        state,
      ),
    ).toBe("Approve");
    expect(state.learningsAnswered).toBe(1);
    expect(state.approvalsAnswered).toBe(1);
  });

  test("declines surfaced candidates without skipping the free-text channel", () => {
    const state = createKiroNumberedProseAnswerState();
    expect(
      nextKiroNumberedProseAnswer(
        "1. Keep c1\n2. Nothing to keep - discard all\nAnything to add for next time?",
        state,
      ),
    ).toBe("Nothing to keep. Nothing to add.");
    expect(state.learningsAnswered).toBe(1);
  });

  test("rejects an approval prompt combined with the unanswered learning channel", () => {
    const state = createKiroNumberedProseAnswerState();
    expect(() =>
      nextKiroNumberedProseAnswer(
        "Anything to add for next time? Nothing to add / Add a note\n" +
          "Approval\n1. Approve\n2. Request Changes",
        state,
      )
    ).toThrow("approval before the mandatory learning response");
    expect(state.learningsAnswered).toBe(0);
    expect(state.approvalsAnswered).toBe(0);
  });

  test("ignores retained learning text after that response and answers the current approval", () => {
    const state = createKiroNumberedProseAnswerState();
    expect(
      nextKiroNumberedProseAnswer(
        "Anything to add for next time?\n1. Nothing to add\n2. Add a note",
        state,
      ),
    ).toBe("Nothing to add");
    expect(
      nextKiroNumberedProseAnswer(
        "Anything to add for next time?\n1. Nothing to add\n2. Add a note\n\n" +
          "How would you like to proceed?\n1. Approve\n2. Request Changes",
        state,
      ),
    ).toBe("Approve");
    expect(state.learningsAnswered).toBe(1);
    expect(state.approvalsAnswered).toBe(1);
  });

  test("answers an ad-hoc lettered clarification menu once, and a distinct one after it", () => {
    // A live hub that spots a contradiction between two recorded answers may
    // invent a mid-stage lettered menu (observed live: intent-capture Q3-vs-Q5
    // feature-set contradiction). The classifier answers the first option once
    // per distinct menu; a repaint of the SAME menu is not re-answered (null),
    // while a DIFFERENT clarification still gets a response.
    const state = createKiroNumberedProseAnswerState();
    const contradiction =
      "Which is correct for the first version?\n" +
      "- A. Include Add + Toggle complete + Delete (recommended)\n" +
      "- B. Include Add + Toggle complete + Delete + Edit\n" +
      "- D. Truly Add-only for the first version\n" +
      "- X. Other (please specify)";
    expect(nextKiroNumberedProseAnswer(contradiction, state)).toBe("A");
    expect(nextKiroNumberedProseAnswer(contradiction, state)).toBeNull();
    const second =
      "Which persistence approach?\n" +
      "- A. Browser localStorage\n" +
      "- B. A server with accounts";
    expect(nextKiroNumberedProseAnswer(second, state)).toBe("A");
  });

  test("answers a new learning prompt when an older approval remains visible", () => {
    const state = createKiroNumberedProseAnswerState();
    state.learningsAnswered = 1;
    state.approvalsAnswered = 1;
    expect(
      nextKiroNumberedProseAnswer(
        "How would you like to proceed?\n1. Approve\n2. Request Changes\n\n" +
          "Anything to add for next time?\n1. Nothing to add\n2. Add a note",
        state,
      ),
    ).toBe("Nothing to add");
    expect(state.learningsAnswered).toBe(2);
    expect(state.approvalsAnswered).toBe(1);
  });
});

describe("tui fixture runtime graph", () => {
  test("repairs seeded Claude and Kiro workflows and remains idempotent", () => {
    for (const harness of ["claude", "kiro"] as const) {
      const projectDir = setupTuiProject({
        harness,
        withState: "state-mid-ideation.md",
        withAudit: true,
        runtimeGraph: true,
      });
      try {
        const graphPath = join(
          seededRecordDir(projectDir),
          "runtime-graph.json",
        );
        const firstGraph = readFileSync(graphPath, "utf8");
        const graph = JSON.parse(firstGraph) as {
          stages?: Array<{ stage_slug?: string }>;
        };
        expect(
          graph.stages?.some((stage) => stage.stage_slug === "feasibility"),
        ).toBe(true);

        const firstAudit = readAllAuditShards(projectDir);
        expect(firstAudit.match(/\*\*Event\*\*: WORKFLOW_STARTED/g)).toHaveLength(1);
        expect(firstAudit).toMatch(
          /\*\*Event\*\*: STAGE_STARTED[\s\S]*?\*\*Stage\*\*: feasibility/,
        );

        compileTuiRuntimeGraph(projectDir);
        expect(readFileSync(graphPath, "utf8")).toBe(firstGraph);
        expect(readAllAuditShards(projectDir)).toBe(firstAudit);
      } finally {
        cleanupTuiProject(projectDir);
      }
    }
  });

  test("resolves the active intent created by direct custom-harness birth", () => {
    const projectDir = setupTuiProject({ customHarness: true });
    try {
      const birth = spawnSync(
        process.execPath,
        [
          join(projectDir, ".claude", "tools", "aidlc-utility.ts"),
          "intent-birth",
          "--scope",
          CUSTOM_SCOPE,
        ],
        {
          cwd: projectDir,
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
        },
      );
      expect(birth.status, birth.stderr).toBe(0);

      compileTuiRuntimeGraph(projectDir);
      const graph = JSON.parse(
        readFileSync(
          join(dirname(stateFilePath(projectDir)), "runtime-graph.json"),
          "utf8",
        ),
      ) as { stages?: Array<{ stage_slug?: string }> };
      expect(
        graph.stages?.some(
          (stage) => stage.stage_slug === SNAPSHOT_STAGE_SLUG,
        ),
      ).toBe(true);
    } finally {
      cleanupTuiProject(projectDir);
    }
  });
});
