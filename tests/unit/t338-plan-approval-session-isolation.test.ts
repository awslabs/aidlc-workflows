// covers: function:resolvePlanApprovalSession, function:writePlanApprovalSessionBinding, function:readPlanApprovalSessionBinding, function:recordPlanApprovalHumanResponse, function:recordPlanApprovalReceipt
//
// Plan Approval human authority must never cross a session boundary. A human
// response recorded under session A cannot consume the pending challenge of
// session B, and a receipt cannot be certified under A from a challenge and
// response that live under B — even when both sessions present the identical
// plan identity, and even when `.current-session` happens to name B. The only
// sanctioned indirection is the session binding minted beside the challenge
// (token = intent id, what the orchestrator passes as --session); a stale
// binding never resolves.

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readPlanApprovalChallenge,
  readPlanApprovalResponse,
  readPlanApprovalSessionBinding,
  resolvePlanApprovalSession,
  sessionsDir,
  stateDigest,
  workspaceSourceFingerprint,
  writeActiveDirectiveMarker,
  writeCurrentSessionId,
  writePlanApprovalChallenge,
  writePlanApprovalResponse,
  writePlanApprovalSessionBinding,
  type PlanApprovalRuntimeChallenge,
} from "../../core/tools/aidlc-lib.ts";
import {
  recordPlanApprovalHumanResponse,
  recordPlanApprovalReceipt,
  resolveCodeGenerationAuthority,
  type PlanApprovalQuestionEvidence,
} from "../../core/tools/aidlc-testing-posture.ts";
import {
  cleanupTestProject,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const projects: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
}, 30000);

function initGitBaseline(project: string): void {
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "-A"],
    ["commit", "-qm", "baseline"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
}

// An active code-generation directive on a bindable workspace: the minimum the
// receipt-certification path needs to reach the session checks.
function createProject(): string {
  const project = setupIntegrationProject({
    withState: "state-brownfield-feature.md",
  });
  projects.push(project);
  const statePath = join(seededRecordDir(project), "aidlc-state.md");
  const state = readFileSync(statePath, "utf-8")
    .replace(
      /^- \*\*Current Stage\*\*:.*$/m,
      "- **Current Stage**: code-generation",
    )
    .replace(
      /^- \[[ xSR?-]\] code-generation(\s+—\s+)EXECUTE$/m,
      "- [-] code-generation$1EXECUTE",
    );
  writeFileSync(statePath, state, "utf-8");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "base.ts"), "export const base = 1;\n");
  initGitBaseline(project);
  writeActiveDirectiveMarker(project, {
    kind: "run-stage",
    stage: "code-generation",
    state_sha256: stateDigest(state),
  });
  return project;
}

const SHARED_IDENTITY = {
  targetId: "stage:code-generation",
  runFloor: "run-floor",
  fingerprint: "a".repeat(64),
  questionsFile: "questions.md",
  promptSha256: "b".repeat(64),
};

function writeChallenge(
  project: string,
  session: string,
  overrides: Partial<PlanApprovalRuntimeChallenge> = {},
): PlanApprovalRuntimeChallenge {
  const challenge: PlanApprovalRuntimeChallenge = {
    version: 1,
    session,
    challengeId: `challenge-${session}-${randomUUID()}`,
    intentId: `intent-${randomUUID()}`,
    directiveEpoch: "epoch",
    sourceFloor: "c".repeat(64),
    markerRevision: 0,
    plannedSourceSha256: "d".repeat(64),
    ...SHARED_IDENTITY,
    options: ["Approve Plan", "Request Changes"],
    requireExactOptionLabels: false,
    hashedOptionLabels: false,
    ...overrides,
  };
  writePlanApprovalChallenge(project, challenge);
  return challenge;
}

// Evidence that satisfies runtimeIdentityMatches against `challenge` and binds
// to the workspace source as it currently stands.
function evidenceFor(
  project: string,
  challenge: PlanApprovalRuntimeChallenge,
  overrides: Partial<PlanApprovalQuestionEvidence> = {},
): PlanApprovalQuestionEvidence {
  const authority = resolveCodeGenerationAuthority(project, { unit: null });
  return {
    authority: {
      ...authority,
      targetId: challenge.targetId,
      intentId: challenge.intentId,
      runFloor: challenge.runFloor,
      directiveEpoch: challenge.directiveEpoch,
      sourceFloor: challenge.sourceFloor,
      markerRevision: challenge.markerRevision,
    },
    fingerprint: challenge.fingerprint,
    questionsPath: join(project, challenge.questionsFile),
    questionsRelativePath: challenge.questionsFile,
    questionsSha256: "e".repeat(64),
    promptSha256: challenge.promptSha256,
    plannedSourceSha256:
      workspaceSourceFingerprint(project) ?? challenge.plannedSourceSha256,
    changeNotices: [],
    ...overrides,
  };
}

function runtimeDir(project: string): string {
  return join(sessionsDir(project), "plan-approval");
}

function receiptFiles(project: string): string[] {
  try {
    return readdirSync(runtimeDir(project)).filter(
      (name) => name.startsWith("receipt-") && name.endsWith(".json"),
    );
  } catch {
    return [];
  }
}

describe("t338 Plan Approval session isolation", () => {
  test("a human response under session A cannot consume the challenge pending under session B", () => {
    const project = createProject();
    // Literal reproduction: .current-session names session B, the pending
    // challenge lives under session B, and the human response arrives under
    // session A.
    writeCurrentSessionId(project, "session-b");
    writeChallenge(project, "session-b");

    const result = recordPlanApprovalHumanResponse(
      project,
      "session-a",
      "Approve Plan",
    );

    expect(result.recorded).toBe(false);
    expect(readPlanApprovalResponse(project, "session-a")).toBeNull();
    // Session B's challenge must remain untouched: nothing written under it.
    expect(readPlanApprovalResponse(project, "session-b")).toBeNull();
    expect(readPlanApprovalChallenge(project, "session-b")).not.toBeNull();
  });

  test("a challenge and response under session B cannot certify a receipt under session A", () => {
    const project = createProject();
    writeCurrentSessionId(project, "session-b");
    const challenge = writeChallenge(project, "session-b");
    writePlanApprovalResponse(project, {
      version: 1,
      session: "session-b",
      challengeId: challenge.challengeId,
      choice: "Approve Plan",
      responseSha256: "f".repeat(64),
    });

    expect(() =>
      recordPlanApprovalReceipt(
        project,
        evidenceFor(project, challenge),
        "session-a",
        "Approve Plan",
      ),
    ).toThrow();
    expect(receiptFiles(project)).toEqual([]);
    // The untouched pair under session B still stands.
    expect(readPlanApprovalChallenge(project, "session-b")).not.toBeNull();
    expect(readPlanApprovalResponse(project, "session-b")).not.toBeNull();
  });

  test("identical plan identities in both sessions do not weaken session isolation", () => {
    const project = createProject();
    writeCurrentSessionId(project, "session-b");
    const identity = { intentId: `intent-${randomUUID()}` };
    writeChallenge(project, "session-a", identity);
    writeChallenge(project, "session-b", identity);

    const result = recordPlanApprovalHumanResponse(
      project,
      "session-a",
      "Approve Plan",
    );

    expect(result.recorded).toBe(true);
    const responseA = readPlanApprovalResponse(project, "session-a");
    expect(responseA?.session).toBe("session-a");
    // Session B's side is untouched: no response written under it.
    expect(readPlanApprovalResponse(project, "session-b")).toBeNull();
  });

  test("a mismatched plan identity remains rejected", () => {
    const project = createProject();
    const challenge = writeChallenge(project, "session-b");
    writePlanApprovalResponse(project, {
      version: 1,
      session: "session-b",
      challengeId: challenge.challengeId,
      choice: "Approve Plan",
      responseSha256: "f".repeat(64),
    });

    const drifted = evidenceFor(project, challenge, {
      fingerprint: "9".repeat(64),
    });
    expect(() =>
      recordPlanApprovalReceipt(
        project,
        drifted,
        "session-b",
        "Approve Plan",
      ),
    ).toThrow();
    expect(receiptFiles(project)).toEqual([]);
  });

  test("an intent-UUID session argument resolves the bound answering session end to end", () => {
    const project = createProject();
    // The orchestrator passes the intent UUID as --session. The binding minted
    // beside the challenge carries that token, so the human's answer and the
    // certified receipt both land under the real answering session.
    const challenge = writeChallenge(project, "session-b", {
      intentId: "intent-token-orchestrator",
    });
    const evidence = evidenceFor(project, challenge);

    const result = recordPlanApprovalHumanResponse(
      project,
      challenge.intentId,
      "Approve Plan",
    );
    expect(result.recorded).toBe(true);
    expect(readPlanApprovalResponse(project, "session-b")?.session).toBe(
      "session-b",
    );
    expect(
      readPlanApprovalResponse(project, challenge.intentId),
    ).toBeNull();

    const receipt = recordPlanApprovalReceipt(
      project,
      evidence,
      challenge.intentId,
      "Approve Plan",
    );
    expect(receipt.receipt?.session).toBe("session-b");
    expect(receipt.receipt?.challengeId).toBe(challenge.challengeId);
  });

  test("two live challenges sharing one intent id retire the binding instead of letting the last writer win", () => {
    const project = createProject();
    const intentId = `intent-${randomUUID()}`;
    // Two sessions present plans with the same intent id. Whichever challenge
    // writes second must not steal the binding from the first — the token is
    // ambiguous and resolves nothing.
    const first = writeChallenge(project, "session-a", { intentId });
    const second = writeChallenge(project, "session-b", { intentId });

    expect(resolvePlanApprovalSession(project, intentId)).toBeNull();
    expect(readPlanApprovalSessionBinding(project, intentId)).toBeNull();

    // Recording by token writes nothing under either session.
    expect(
      recordPlanApprovalHumanResponse(project, intentId, "Approve Plan").recorded,
    ).toBe(false);
    expect(readPlanApprovalResponse(project, "session-a")).toBeNull();
    expect(readPlanApprovalResponse(project, "session-b")).toBeNull();

    // Certifying by token emits no receipt.
    expect(() =>
      recordPlanApprovalReceipt(
        project,
        evidenceFor(project, second),
        intentId,
        "Approve Plan",
      ),
    ).toThrow();
    expect(receiptFiles(project)).toEqual([]);

    // Each session's own challenge still stands and remains usable by its real
    // session name.
    expect(readPlanApprovalChallenge(project, "session-a")?.challengeId).toBe(
      first.challengeId,
    );
    expect(
      recordPlanApprovalHumanResponse(project, "session-b", "Approve Plan")
        .recorded,
    ).toBe(true);
  });

  test("a stale binding whose named challenge was replaced never resolves", () => {
    const project = createProject();
    const challenge = writeChallenge(project, "session-b", {
      intentId: "intent-token-orchestrator",
    });
    // The session re-mints its challenge (a new presentation); the binding on
    // disk still names the retired challengeId, as a binding written before a
    // rotate or left behind by an interrupted write would.
    const replacement = writeChallenge(project, "session-b", {
      intentId: challenge.intentId,
    });
    writePlanApprovalSessionBinding(project, {
      version: 1,
      token: challenge.intentId,
      session: "session-b",
      challengeId: challenge.challengeId,
      intentId: challenge.intentId,
      boundAt: new Date().toISOString(),
    });

    expect(resolvePlanApprovalSession(project, challenge.intentId)).toBeNull();
    expect(
      recordPlanApprovalHumanResponse(
        project,
        challenge.intentId,
        "Approve Plan",
      ).recorded,
    ).toBe(false);
    expect(readPlanApprovalResponse(project, "session-b")).toBeNull();
    // The live challenge under session B is untouched by the failed resolve.
    expect(readPlanApprovalChallenge(project, "session-b")?.challengeId).toBe(
      replacement.challengeId,
    );
  });
});
