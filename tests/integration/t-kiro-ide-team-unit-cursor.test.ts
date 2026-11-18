// covers: hook:aidlc-sync-workflow-state, function:statusSyncLeavesCursor, subcommand:aidlc-orchestrate:continue
//
// On Kiro IDE the status sync runs after every shell command and takes the
// stage from the audit tail's last STAGE_STARTED. In a checkout that claimed a
// team Unit, a Unit step writes no STAGE_STARTED, so once the Unit's Functional
// Design is approved the last start is still the facilitator's Functional
// Design, while the engine rests Current Stage on the Unit's next stage. The
// sync moved Current Stage back after each command, the step the engine had
// issued went stale, and `continue` handed back the same steering step and
// receipt every time, so the Unit could not get past it (#3560). The sync now
// leaves the cursor and the step, and `continue` reaches the Unit's step.
//
// Mechanism: cli - the shipped tools and the shipped Kiro IDE hook adapter
// against a seeded team project, a bare remote and a clone that claimed alpha.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, seededAuditDir, seededStateFile } from "../harness/fixtures.ts";
import {
  ORCH,
  cleanupTempDirs,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";
import {
  auditShardName,
  getField,
  readActiveDirectiveMarker,
  readStateFile,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

// More steering parts than any stage's rules take: a `continue` that never
// moves on fails on its receipt first.
const MAX_PARTS = 8;

// The team's main with its skeleton stance answered, after the facilitator's
// checkout started the block's first stage.
function teamSeed(): string {
  const { seed, remote } = makeSeed();
  const statePath = seededStateFile(seed);
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8").replace("- **State Version**: 8", "- **State Version**: 8\n- **Skeleton Stance**: on"),
  );
  appendFileSync(
    join(seededAuditDir(seed), auditShardName(seed)),
    "## STAGE_STARTED\n**Timestamp**: 2026-08-20T00:30:00Z\n**Event**: STAGE_STARTED\n" +
      "**Stage**: functional-design\n**Run floor**: unstarted#0\n---\n",
  );
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "the facilitator starts functional-design"]);
  git(seed, ["push", "origin", "main"]);
  return remote;
}

// What the Kiro IDE runs after a shell command: its after-shell status sync,
// through the shipped adapter, with the payload the IDE gives.
function afterShellCommand(checkout: string): void {
  const run = spawnSync(process.execPath, [join(checkout, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "sync-workflow-state"], {
    cwd: checkout,
    input: "",
    encoding: "utf-8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: checkout,
      VSCODE_IPC_HOOK: `t-kiro-ide-team-unit-cursor:${checkout}`,
      VSCODE_PID: "3560",
      USER_PROMPT: JSON.stringify({ toolName: "execute_bash", toolArgs: {}, toolResult: "Output:\nok\n\nExit Code: 0", toolSuccess: true }),
    },
    timeout: NATIVE_STARTUP_TIMEOUT_MS,
  });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
}

function orchestrate(checkout: string, args: string[]): Record<string, unknown> {
  const run = runMergeTool(ORCH, args, checkout);
  expect(run.status, run.out).toBe(0);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

const currentStage = (checkout: string): string =>
  (getField(readStateFile(checkout), "Current Stage") ?? "").trim();

describe("t-kiro-ide-team-unit-cursor: a claimed Unit's step survives the IDE's after-shell sync", () => {
  test("after the Unit's Functional Design, continue reaches its NFR Requirements step", () => {
    let reached: Record<string, unknown> | null = null;
    prepareCandidate(teamSeed(), "alpha", "alpha-team", {
      stages: ["functional-design"],
      beforeCommit: (checkout) => {
        cpSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro"), join(checkout, ".kiro"), { recursive: true });
        appendFileSync(join(checkout, ".git", "info", "exclude"), ".kiro/\n");

        let directive = orchestrate(checkout, ["next"]);
        expect(directive, JSON.stringify(directive)).toMatchObject({ kind: "load-steering", stage: "nfr-requirements" });
        expect(currentStage(checkout)).toBe("nfr-requirements");
        for (let part = 0; directive.kind === "load-steering"; part++) {
          expect(part, JSON.stringify(directive)).toBeLessThan(MAX_PARTS);
          const receipt = directive.receipt as string;
          afterShellCommand(checkout);
          expect(currentStage(checkout)).toBe("nfr-requirements");
          directive = orchestrate(checkout, ["continue", receipt]);
          expect(directive.receipt, "continue handed back the step it was given").not.toBe(receipt);
        }
        expect(directive, JSON.stringify(directive)).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: "alpha" });
        afterShellCommand(checkout);
        expect(currentStage(checkout)).toBe("nfr-requirements");
        reached = readActiveDirectiveMarker(checkout, readStateFile(checkout)) as Record<string, unknown> | null;
      },
    });
    // The step the engine issued is still the current one after the sync.
    expect(reached).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: "alpha" });
  });
});
