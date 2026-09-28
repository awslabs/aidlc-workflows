// covers: function:isGuardRecoveryOperation, function:guardOperationInvocation,
// function:renderGuardOperation, function:guardOperationMatchesCommand,
// function:guardOperationMatchesRemedy, function:isGuardRecoveryEngineInvocation,
// function:sameGuardOperation, function:aidlcEngineCommand, directive:guard-recovery,
// function:guardRecoveryAnswerAdmits, function:guardOperationMatchesEngineArgs,
// function:parseGuardRestartContinuationCommand
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActiveDirectiveMarker,
  consumeSharedDirectiveAsk,
  evaluateGuardRefusal,
  guardRecoveryAnswerAdmits,
  guardRecoveryAskForRefusal,
  readActiveDirectiveMarker,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../core/tools/aidlc-lib.ts";
import { validateDirective } from "../../core/tools/aidlc-directive.ts";
import {
  type GuardRecoveryOperation,
  guardOperationMatchesEngineArgs,
  isGuardRecoveryEngineInvocation,
  isGuardRecoveryOperation,
  parseGuardRestartContinuationCommand,
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

describe("the answers an open recovery ask admits", () => {
  // An ask the person answered by picking `selected` (null: not answered yet).
  const askMarker = (
    remedies: NonNullable<ActiveDirectiveMarker["remedies"]>,
    unit?: string,
    selected: string | null = remedies[0]?.op ?? null,
  ): ActiveDirectiveMarker => ({
    version: 2,
    kind: "ask",
    ask_type: "guard-recovery",
    stage: "code-generation",
    ...(unit ? { unit } : {}),
    state_sha256: "0".repeat(64),
    needs_rehydrate: false,
    remedies,
    delivery: selected === null ? "issued" : "consumed",
    ...(selected === null ? {} : {
      guard_recovery_response: {
        status: "ready" as const,
        selection_sha256: "1".repeat(64),
        selected_op: selected as never,
        feedback_sha256: "2".repeat(64),
      },
    }),
  });
  const report = (...extra: string[]) =>
    ["engine", "orchestrate", "report", "--stage", "code-generation", ...extra];

  test("a Unit's missing completion receipt is recorded by an exact state command", () => {
    const operation: GuardRecoveryOperation = {
      kind: "record-unit-completion", stage: "code-generation", unit: "billing",
    };
    expect(isGuardRecoveryOperation(operation)).toBe(true);
    expect(isGuardRecoveryOperation({ ...operation, unit: "../other" })).toBe(false);
    expect(renderGuardOperation(operation, { mode: "native", shell: "posix" }))
      .toBe("aidlc engine state unit complete --stage code-generation --unit billing");
    const args = ["engine", "state", "unit", "complete", "--stage", "code-generation", "--unit", "billing"];
    expect(guardOperationMatchesEngineArgs(operation, args)).toBe(true);
    expect(guardOperationMatchesEngineArgs(operation, [...args, "--wave"])).toBe(false);
    expect(guardOperationMatchesEngineArgs(operation, args.map((a) => a === "billing" ? "search" : a)))
      .toBe(false);
    const refusal = evaluateGuardRefusal({
      code: "UNIT_COMPLETION_MISSING",
      blockedAction: "present-approval-gate",
      stage: "code-generation",
      unit: "billing",
      stateContent: "# State\n- [-] code-generation — EXECUTE\n",
      invariant: "The Unit lifecycle is complete in the current attempt.",
      userMessage: "no current UNIT_COMPLETED receipt is recorded.",
      attempt: {
        recovery: "available",
        summaryCoverage: "current",
        reviewCoverage: "current",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: true, unattended: false },
    });
    expect(refusal.remedies[0]).toMatchObject({
      op: "record-unit-completion",
      interaction: "command",
      executableNow: true,
      requiresHuman: false,
      operation,
    });
  });

  test("only the answer the person picked, for the ask's own stage, Unit, and project", () => {
    const remedies: NonNullable<ActiveDirectiveMarker["remedies"]> = [
      { op: "request-changes", action: "Ask what should change.", interaction: "human-input" },
      { op: "finish-revision", action: "Finish the revision.", interaction: "external-work" },
    ];
    const reject = report("--unit", "billing", "--result", "rejected",
      "--user-input", "Request Changes", "--reason", "Use Stripe.");
    // The offer alone grants nothing, and each pick admits only its own route.
    expect(guardRecoveryAnswerAdmits(askMarker(remedies, "billing", null), reject)).toBe(false);
    expect(guardRecoveryAnswerAdmits(askMarker(remedies, "billing", "finish-revision"), reject)).toBe(false);
    expect(guardRecoveryAnswerAdmits(askMarker(remedies, "billing", "finish-revision"),
      report("--result", "revised"))).toBe(true);
    const marker = askMarker(remedies, "billing");
    expect(guardRecoveryAnswerAdmits(marker, reject)).toBe(true);
    expect(guardRecoveryAnswerAdmits(marker, [...reject, "--project-dir", "/work/shop"], "/work/shop"))
      .toBe(true);
    for (const foreign of [
      [...reject, "--project-dir", "/work/other"],
      [...reject, "--project-dir=/work/shop"],
      [...reject, "--intent", "other-work"],
      [...reject, "--space", "platform"],
    ]) {
      expect(guardRecoveryAnswerAdmits(marker, foreign, "/work/shop"), foreign.join(" ")).toBe(false);
    }
    for (const refused of [
      report("--unit", "billing", "--result", "approved"),
      report("--unit", "search", "--result", "rejected"),
      ["engine", "orchestrate", "report", "--stage", "build-and-test", "--result", "rejected"],
      ["engine", "orchestrate", "report", "--result", "rejected"],
      ["engine", "state", "reject", "code-generation"],
      ["engine", "log", "review", "--stage", "code-generation"],
      ["orchestrate", "report", "--stage", "code-generation", "--result", "rejected"],
    ]) {
      expect(guardRecoveryAnswerAdmits(marker, refused), refused.join(" ")).toBe(false);
    }
    expect(guardRecoveryAnswerAdmits({ ...marker, kind: "run-stage" }, reject)).toBe(false);
    expect(guardRecoveryAnswerAdmits({ ...marker, needs_rehydrate: true }, reject)).toBe(false);
    expect(guardRecoveryAnswerAdmits(null, reject)).toBe(false);
  });

  test("an offered operation is admitted in its native and source spellings only", () => {
    const operation: GuardRecoveryOperation = {
      kind: "record-unit-completion", stage: "code-generation", unit: "billing",
    };
    const marker = askMarker([{
      op: "record-unit-completion", action: "Record it.", interaction: "command", operation,
    }], "billing");
    expect(guardRecoveryAnswerAdmits({ ...marker, delivery: "issued" },
      ["engine", "state", "unit", "complete", "--stage", "code-generation", "--unit", "billing"]))
      .toBe(false);
    const args = ["engine", "state", "unit", "complete", "--stage", "code-generation", "--unit", "billing"];
    expect(guardRecoveryAnswerAdmits(marker, args)).toBe(true);
    expect(guardRecoveryAnswerAdmits(marker, [...args, "--project-dir", "/other"])).toBe(false);
    expect(guardRecoveryAnswerAdmits(marker, report("--unit", "billing", "--result", "rejected")))
      .toBe(false);
  });

  test("source installs spell the fence switch and the restart continuation through their tools", () => {
    expect(isGuardRecoveryEngineInvocation(
      ["engine", "utility", "config-change", "--guard.plan-approval", "off"],
    )).toBe(true);
    for (const changed of [
      ["engine", "utility", "config-change", "--guard.plan-approval", "on"],
      ["engine", "utility", "config-change", "--guard.human-presence", "off"],
      ["engine", "utility", "config-change", "--guard.plan-approval", "off", "--intent", "x"],
    ]) {
      expect(isGuardRecoveryEngineInvocation(changed), changed.join(" ")).toBe(false);
    }
    const source = "bun .claude/tools/aidlc-jump.ts execute --target code-generation --direction redo --scope poc";
    expect(parseGuardRestartContinuationCommand(source, { harnessDir: ".claude" })).toMatchObject({
      operation: { kind: "restart-stage", stage: "code-generation" },
      direction: "redo",
      scope: "poc",
    });
    expect(parseGuardRestartContinuationCommand(source)).toBeNull();
    expect(parseGuardRestartContinuationCommand(source, { harnessDir: ".kiro" })).toBeNull();
    expect(parseGuardRestartContinuationCommand(source.replace("aidlc-jump.ts", "aidlc-state.ts"),
      { harnessDir: ".claude" })).toBeNull();
    expect(parseGuardRestartContinuationCommand(`${source} --force`, { harnessDir: ".claude" }))
      .toBeNull();
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

  test("with Request Changes the only choice, a reply that does not pick it is the feedback (#1290)", () => {
    const { project, state } = publish("human-input");
    expect(consumeSharedDirectiveAsk(project, "Use Redis for the session store.")).toBe(true);
    const response = readActiveDirectiveMarker(project, state)?.guard_recovery_response;
    expect(response).toMatchObject({ status: "ready", selected_op: "request-changes" });
    expect(response?.feedback_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("with Request Changes the only choice, the latest reply is the feedback until it is submitted", () => {
    const { project, state } = publish("human-input");
    expect(consumeSharedDirectiveAsk(project, "Why was this refused?")).toBe(true);
    const first = readActiveDirectiveMarker(project, state)?.guard_recovery_response;
    expect(consumeSharedDirectiveAsk(project, "Split the billing step in two.")).toBe(true);
    const latest = readActiveDirectiveMarker(project, state)?.guard_recovery_response;
    expect(latest).toMatchObject({ status: "ready", selected_op: "request-changes" });
    expect(latest?.feedback_sha256).not.toBe(first?.feedback_sha256);
    // Picking the option again, or a dismissed question, keeps the words given.
    for (const kept of ["Request Changes", "Cancelled"]) {
      consumeSharedDirectiveAsk(project, kept);
      expect(readActiveDirectiveMarker(project, state)?.guard_recovery_response?.feedback_sha256)
        .toBe(latest?.feedback_sha256);
    }
  });

  test("with Request Changes the only choice, a dismissed question is not feedback", () => {
    const { project, state } = publish("human-input");
    expect(consumeSharedDirectiveAsk(project, "Cancelled")).toBe(true);
    const dismissed = readActiveDirectiveMarker(project, state)?.guard_recovery_response;
    expect(dismissed?.selected_op).toBeNull();
    expect(dismissed?.feedback_sha256).toBeUndefined();
    expect(consumeSharedDirectiveAsk(project, "Split the billing step in two.")).toBe(true);
    expect(readActiveDirectiveMarker(project, state)?.guard_recovery_response)
      .toMatchObject({ status: "ready", selected_op: "request-changes" });
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
