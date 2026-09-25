// covers: function:isGuardRecoveryOperation, function:guardOperationInvocation,
// function:renderGuardOperation, function:guardOperationMatchesCommand,
// function:guardOperationMatchesRemedy, function:isGuardRecoveryEngineInvocation,
// function:sameGuardOperation, function:aidlcEngineCommand, directive:guard-recovery
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  consumeSharedDirectiveAsk,
  evaluateGuardRefusal,
  guardRecoveryAskForRefusal,
  readActiveDirectiveMarker,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../core/tools/aidlc-lib.ts";
import { validateDirective } from "../../core/tools/aidlc-directive.ts";
import {
  type GuardRecoveryOperation,
  isGuardRecoveryEngineInvocation,
  renderGuardOperation,
  sameGuardOperation,
} from "../../core/tools/aidlc-guard-operation.ts";
import { aidlcEngineCommand } from "../../core/tools/aidlc-runtime-paths.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  cleanupTestProject,
  createTestProject,
  seedStateFile,
  seededStateFile,
} from "../harness/fixtures.ts";

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

function recovery(marker: " " | "-" | "R" | "x" = " ") {
  return guardRecoveryAskForRefusal(evaluateGuardRefusal({
    code: "REVIEW_EVIDENCE_MISSING",
    blockedAction: "complete",
    stage: "requirements-analysis",
    stateContent: `# State\n- [${marker}] requirements-analysis — EXECUTE\n`,
    invariant: "Completion requires current review evidence.",
    userMessage: "Review evidence is missing.",
    attempt: {
      recovery: "spent",
      summaryCoverage: "current",
      reviewCoverage: "stale",
      sourceCoverage: "current",
    },
    humanAuthority: { freshTurn: true, unattended: false },
  }))!;
}

describe("structured guard recovery operations", () => {
  test("operation identity ignores JSON property ordering but preserves target and action", () => {
    const operation = { kind: "abort-bolt", unit: "alpha", slug: "alpha" };
    expect(sameGuardOperation(operation, { slug: "alpha", unit: "alpha", kind: "abort-bolt" })).toBe(true);
    expect(sameGuardOperation(operation, { ...operation, slug: "other" })).toBe(false);
    expect(sameGuardOperation(operation, { kind: "restart-stage", stage: "alpha" })).toBe(false);
  });

  test("pending, revising and completed stages offer executable source and native reset operations", () => {
    for (const marker of [" ", "R", "x"] as const) {
      const ask = recovery(marker);
      const remedy = ask.remedies.find((entry) => entry.operation)!;
      expect(remedy.interaction).toBe("command");
      expect(remedy.requiresHuman).toBe(true);
      for (const mode of ["source", "native"] as const) {
        const command = renderGuardOperation(remedy.operation!, { mode, harnessDir: ".kiro" });
        const result = validateDirective({ ...ask, remedies: [{ ...remedy, command }] });
        expect(result.valid, JSON.stringify(result)).toBe(true);
      }
    }
  });

  test("the displayed command cannot change target, append work, or remove the human requirement", () => {
    const ask = recovery();
    const remedy = ask.remedies[0];
    const command = "aidlc engine orchestrate next --stage requirements-analysis";
    for (const changed of [
      { command: command.replace("requirements-analysis", "code-generation") },
      { command: `${command}; touch src/generated.ts` },
      { command: `${command} --single` },
      { command, operation: { kind: "approve-stage", stage: "requirements-analysis" } },
      { command, operation: { kind: "restart-stage", stage: "code-generation" } },
      { command, operation: { kind: "restart-stage", stage: "requirements-analysis", approve: true } },
      { command, requiresHuman: false },
      { command, interaction: "external-work" },
      { command, operation: undefined },
    ]) {
      expect(validateDirective({
        ...ask, remedies: [{ ...remedy, ...changed }],
      }).valid, JSON.stringify(changed)).toBe(false);
    }
  });

  test("action-only human recovery does not pretend to be a command", () => {
    const ask = recovery("-");
    const requestChanges = ask.remedies.find((remedy) => remedy.op === "request-changes")!;
    expect(requestChanges.interaction).toBe("human-input");
    expect(requestChanges.command).toBeUndefined();
    expect(requestChanges.operation).toBeUndefined();
    expect(validateDirective(ask).valid).toBe(true);
  });

  test("a pending review with withdrawn summary cannot offer a verdict its owner will refuse", () => {
    const refusal = evaluateGuardRefusal({
      code: "SUMMARY_EVIDENCE_INVALID",
      blockedAction: "review-verdict",
      stage: "requirements-analysis",
      stateContent: "# State\n- [-] requirements-analysis — EXECUTE\n",
      invariant: "A terminal review requires current summary authority.",
      userMessage: "Summary confirmation was withdrawn.",
      attempt: {
        recovery: "pending",
        pendingReview: { iteration: 1, retryable: true, verdictRecordable: true },
        summaryCoverage: "missing", reviewCoverage: "missing", sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: true, unattended: false },
    });
    const ask = guardRecoveryAskForRefusal(refusal)!;
    expect(ask.remedies.some((remedy) => ["record-verdict", "retry-pending"].includes(remedy.op)))
      .toBe(false);
    expect(ask.remedies.some((remedy) => remedy.op === "reconfirm-summary")).toBe(true);
  });

  test("native recovery admission is limited to the exact abort operation", () => {
    const args = [
      "engine", "bolt", "abort", "--name", "alpha", "--slug", "alpha",
      "--reason", "stale review recovery exhausted", "--discard",
    ];
    expect(isGuardRecoveryEngineInvocation(args)).toBe(true);
    for (const changed of [
      [...args, "--force"],
      args.slice(0, -1),
      args.map((value) => value === "abort" ? "merge" : value),
      args.map((value, index) => index === 4 ? "../other" : value),
      ["engine", "state", "approve", "code-generation"],
    ]) {
      expect(isGuardRecoveryEngineInvocation(changed)).toBe(false);
    }
  });

  test("a native child never receives a TypeScript filename in the command position", () => {
    const previous = process.env.AIDLC_COMPILED_EXECUTABLE;
    process.env.AIDLC_COMPILED_EXECUTABLE = "/native install/aidlc";
    try {
      const args = ["next", "--project-dir", "/workspace with spaces"];
      expect(aidlcEngineCommand("orchestrate", args, "/source/aidlc-orchestrate.ts"))
        .toEqual(["/native install/aidlc", "engine", "orchestrate", ...args]);
      expect(aidlcEngineCommand("log", ["answer"], "/source/aidlc-log.ts"))
        .toEqual(["/native install/aidlc", "engine", "log", "answer"]);
    } finally {
      if (previous === undefined) delete process.env.AIDLC_COMPILED_EXECUTABLE;
      else process.env.AIDLC_COMPILED_EXECUTABLE = previous;
    }
  });

  // The three core hooks that spawn an engine child used to name "bun"
  // literally. A native install ships no Bun and runs those hooks inside the
  // compiled binary, so the child was an ENOENT: the Stop hook threw before its
  // fail-open branch and stopped enforcing, and the graph rebuild and sensor
  // dispatch recorded an empty drop. No hook may carry a bare interpreter name.
  test("no core hook spawns a bare interpreter; each routes through the engine command", () => {
    const hooks = [
      "aidlc-continue-workflow.ts",
      "aidlc-rebuild-stage-graph.ts",
      "aidlc-run-sensors.ts",
    ];
    // Strip comments first: prose may name the interpreter (these hooks explain
    // why they must not spawn it), but no CODE may hold the literal, in any
    // spawn shape - `spawnSync("bun", …)`, `cmd: ["bun", …]`, or an argument on
    // its own line.
    const code = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const hook of hooks) {
      const source = readFileSync(join(REPO_ROOT, "core", "hooks", hook), "utf-8");
      expect(code(source).match(/"bun"/g) ?? [], `${hook} names the interpreter in code`)
        .toEqual([]);
      expect(source, `${hook} does not route through the engine command`)
        .toContain("aidlcEngineCommand(");
    }
  });

  test("the engine command reaches the runtime and sensor dispatchers", () => {
    const previous = process.env.AIDLC_COMPILED_EXECUTABLE;
    process.env.AIDLC_COMPILED_EXECUTABLE = "/native install/aidlc";
    try {
      expect(aidlcEngineCommand("runtime", ["compile"], "/source/aidlc-runtime.ts"))
        .toEqual(["/native install/aidlc", "engine", "runtime", "compile"]);
      expect(aidlcEngineCommand("sensor", ["fire", "linter"], "/source/aidlc-sensor.ts"))
        .toEqual(["/native install/aidlc", "engine", "sensor", "fire", "linter"]);
    } finally {
      if (previous === undefined) delete process.env.AIDLC_COMPILED_EXECUTABLE;
      else process.env.AIDLC_COMPILED_EXECUTABLE = previous;
    }
    // Source mode names Bun by absolute path, so the child resolves even when
    // Bun's install directory is absent from the hook's PATH.
    expect(aidlcEngineCommand("runtime", ["compile"], "/source/aidlc-runtime.ts", null))
      .toEqual([process.execPath, "/source/aidlc-runtime.ts", "compile"]);
  });

  test("explicit source and native children ignore the compiled executable environment override", () => {
    const previous = process.env.AIDLC_COMPILED_EXECUTABLE;
    process.env.AIDLC_COMPILED_EXECUTABLE = "/tmp/evil/aidlc";
    try {
      const args = ["approve", "code-generation", "--project-dir", "/workspace with spaces"];
      expect(aidlcEngineCommand("state", args, "/source/aidlc-state.ts", null))
        .toEqual([process.execPath, "/source/aidlc-state.ts", ...args]);
      expect(aidlcEngineCommand("state", args, "/source/aidlc-state.ts", "/native install/aidlc"))
        .toEqual(["/native install/aidlc", "engine", "state", ...args]);
    } finally {
      if (previous === undefined) delete process.env.AIDLC_COMPILED_EXECUTABLE;
      else process.env.AIDLC_COMPILED_EXECUTABLE = previous;
    }
  });
});

describe("recovery selection records the next interaction", () => {
  function publish(interaction: "command" | "human-input", operation?: GuardRecoveryOperation) {
    const project = createTestProject();
    projects.push(project);
    seedStateFile(project, "state-mid-inception.md");
    const state = readFileSync(seededStateFile(project), "utf8");
    writeActiveDirectiveMarker(project, {
      kind: "ask",
      stage: "requirements-analysis",
      ask_type: "guard-recovery",
      state_sha256: stateDigest(state),
      remedies: [{
        op: operation ? "restart-stage" : "request-changes",
        action: operation ? "Restart this stage." : "Ask what should change.",
        interaction,
        ...(operation ? { operation } : {}),
      }],
    });
    return { project, state };
  }

  test("a later unrelated reply supersedes a command selection instead of becoming its feedback", () => {
    const operation: GuardRecoveryOperation = { kind: "restart-stage", stage: "requirements-analysis" };
    const { project, state } = publish("command", operation);
    expect(consumeSharedDirectiveAsk(project, "1")).toBe(true);
    const selected = readActiveDirectiveMarker(project, state)!;
    expect(selected.remedies?.[0].operation).toEqual(operation);
    expect(selected.guard_recovery_response?.status).toBe("ready");
    expect(selected.guard_recovery_response?.feedback_sha256).toBeUndefined();
    expect(consumeSharedDirectiveAsk(project, "an unrelated later message")).toBe(true);
    const superseded = readActiveDirectiveMarker(project, state)!;
    expect(superseded.guard_recovery_response?.status).not.toBe("ready");
    expect(superseded.guard_recovery_response?.selected_op).toBeNull();
    expect(superseded.guard_recovery_response?.feedback_sha256).toBeUndefined();
    expect(superseded.delivery).toBe("consumed");
    expect(consumeSharedDirectiveAsk(project, "1")).toBe(true);
    const reselected = readActiveDirectiveMarker(project, state)!;
    expect(reselected.guard_recovery_response?.status).toBe("ready");
    expect(reselected.guard_recovery_response?.selected_op).toBe("restart-stage");
    expect(reselected.remedies).toEqual(selected.remedies);
  });

  test("Request Changes still needs separate human feedback", () => {
    const { project, state } = publish("human-input");
    expect(consumeSharedDirectiveAsk(project, "Request Changes")).toBe(true);
    expect(readActiveDirectiveMarker(project, state)?.guard_recovery_response?.status)
      .toBe("awaiting-feedback");
    expect(consumeSharedDirectiveAsk(project, "Add the missing acceptance criterion.")).toBe(true);
    const response = readActiveDirectiveMarker(project, state)?.guard_recovery_response;
    expect(response?.status).toBe("ready");
    expect(response?.feedback_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
