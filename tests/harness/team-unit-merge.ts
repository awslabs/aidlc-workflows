// Shared fixture for the t326 pinned team Unit merge suites
// (tests/integration/t326-team-unit-merge*.test.ts). The cases live in two
// files so the integration tier can run them in parallel; one file ran for
// about 20 minutes on a Windows runner.

import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  artifactFilename,
  auditShardName,
  loadStageGraphAll,
  readUnitMergeTransaction,
  reviewArtifactFingerprint,
  reviewRecordDigest,
  reviewRecordRelativePath,
  serializeReviewRecord,
  type ReviewRecord,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  approvalFingerprint,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "./fixtures.ts";

export const UNIT = join(AIDLC_SRC, "tools", "aidlc-unit.ts");
export const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
export const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
export const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
export const tempDirs: string[] = [];

/** Remove every checkout and remote a case created; register as afterEach. */
export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (dir.includes("aidlc-test-")) cleanupTestProject(dir);
    else rmSync(dir, { recursive: true, force: true });
  }
}

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return (result.stdout ?? "").trim();
}

export function runMergeTool(
  tool: string,
  args: string[],
  cwd: string,
  enforceHumanPresence = false,
  extraEnv: Record<string, string> = {},
): { status: number; stdout: string; out: string } {
  // Keep Git's diagnostics for Windows claim/pin failures and receipt
  // revalidation during gate/land on every platform.
  // Store traces outside the checkout so dirty-tree policies stay meaningful.
  const reviewOperation = tool === UNIT && (args[0] === "gate" || args[0] === "land");
  const windowsClaimOrPin = process.platform === "win32" && tool === UNIT &&
    (args[0] === "claim" || args[0] === "pin");
  const traceNeeded = reviewOperation || windowsClaimOrPin;
  const traceDir = traceNeeded && extraEnv.GIT_TRACE2_EVENT === undefined
    ? mkdtempSync(join(tmpdir(), "aidlc-inc3-git-trace-"))
    : null;
  if (traceDir) tempDirs.push(traceDir);
  const tracePath = extraEnv.GIT_TRACE2_EVENT ??
    (traceDir ? join(traceDir, "git-events.ndjson") : null);
  const result = spawnSync(
    process.execPath,
    [tool, ...args, "--project-dir", cwd],
    {
      cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: enforceHumanPresence ? "0" : "1",
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
        AIDLC_SKIP_ARTIFACT_GUARD: "1",
        ...(tracePath ? { GIT_TRACE2_EVENT: tracePath.replaceAll("\\", "/") } : {}),
        ...extraEnv,
      },
    },
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const reviewUnit = reviewOperation ? args[1] : undefined;
  if (result.status !== 0 && reviewUnit && tracePath &&
      (out.includes("reviewer READY receipts") || out.includes("candidate-exact"))) {
    console.error(`t326 merge validation failed:\n${JSON.stringify({
      args, status: result.status, signal: result.signal, error: result.error?.message, out,
    }, null, 2)}`);
    reportPinnedMergeFailure(cwd, reviewUnit, tracePath, out);
  } else if (result.status !== 0 && windowsClaimOrPin && tracePath && existsSync(tracePath)) {
    console.error(`t326 ${args[0]} Git trace (${tracePath}):\n${readFileSync(tracePath, "utf-8")}`);
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    out,
  };
}

export function stateBody(): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: inc3 merge
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Unit Ownership**: team
- **Unit Gate Rhythm**: per-stage
- **Review Override**: adversarial
- **Worktree Path**:
- **Bolt Refs**:

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
- [ ] ci-pipeline — EXECUTE

## Unit Progress
| unit | owner | functional-design | nfr-requirements | nfr-design | infrastructure-design | code-generation | gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| skeleton | - | [x] | [x] | [x] | [x] | [x] | [x] |
| alpha | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| beta | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-08-20T00:00:00Z
`;
}

export function dependencyBody(): string {
  return `# Unit dependencies

\`\`\`yaml
units:
  - name: skeleton
    depends_on: []
  - name: alpha
    depends_on: [skeleton]
  - name: beta
    depends_on: [alpha]
\`\`\`
`;
}

export function parallelDependencyBody(): string {
  return `# Unit dependencies

\`\`\`yaml
units:
  - name: skeleton
    depends_on: []
  - name: alpha
    depends_on: [skeleton]
  - name: beta
    depends_on: [skeleton]
\`\`\`
`;
}

export function makeSeed(
  dependencies = dependencyBody(),
): { seed: string; remote: string } {
  const seed = createTestProject();
  tempDirs.push(seed);
  seedAidlcMemory(seed);
  writeFileSync(seededStateFile(seed), stateBody());
  const depDir = join(seededRecordDir(seed), "inception", "units-generation");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, "unit-of-work-dependency.md"), dependencies);
  mkdirSync(seededAuditDir(seed), { recursive: true });
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(
    join(seed, "src", "shared.ts"),
    'export const left = "base";\n' +
      'export const keep1 = "same";\n' +
      'export const keep2 = "same";\n' +
      'export const keep3 = "same";\n' +
      'export const right = "base";\n',
  );
  writeFileSync(
    join(seededAuditDir(seed), "skeleton.md"),
    "## Bolt Started\n**Timestamp**: 2026-08-20T00:00:00Z\n" +
      "**Event**: BOLT_STARTED\n**Bolt names**: skeleton\n**Walking skeleton**: true\n\n---\n" +
      "## Bolt Completed\n**Timestamp**: 2026-08-20T00:00:01Z\n" +
      "**Event**: BOLT_COMPLETED\n**Bolt names**: skeleton\n\n---\n",
  );
  completeUnitOnMain(seed, "skeleton");
  writeFileSync(
    join(seed, ".gitignore"),
    "aidlc/.aidlc-clone-id\naidlc/.aidlc-unit-scope.json\n" +
      "aidlc/.aidlc-unit-parked\naidlc/.aidlc-claim-generations.json\n" +
      "aidlc/.aidlc-unit-participant\naidlc/.aidlc-claim-registry.json\n" +
      "aidlc/.aidlc-unit-releases/\naidlc/.aidlc-unit-merges/\n",
  );
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "main"]);
  git(seed, ["config", "user.email", "main@example.test"]);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "seed"]);
  const remote = mkdtempSync(join(tmpdir(), "aidlc-inc3-remote-"));
  tempDirs.push(remote);
  git(remote, ["init", "--bare"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { seed: clone(remote, "main"), remote };
}

export function clone(remote: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aidlc-inc3-${label}-`));
  rmSync(dir, { recursive: true, force: true });
  // Git's local clone optimization can race with source-repository updates.
  git(tmpdir(), ["clone", "--no-local", remote, dir]);
  tempDirs.push(dir);
  git(dir, ["config", "user.name", label]);
  git(dir, ["config", "user.email", `${label}@example.test`]);
  return dir;
}

export function auditBlock(
  event: string,
  unit: string,
  generation: number,
  stage: string,
  extra = "",
): string {
  return `## ${event}
**Timestamp**: 2026-08-20T01:00:00Z
**Event**: ${event}
**Stage**: ${stage}
**Unit**: ${unit}
**Run floor**: unstarted#0
**Attempt Generation**: ${generation}
${extra}
---
`;
}

export function reviewAuditExtras(
  projectDir: string,
  stage: string,
  unit: string,
  reviewer: string,
  fingerprint: string,
  nonce: string,
): { request: string; completion: string } {
  const requestId = `review:${createHash("sha256").update(nonce).digest("hex").slice(0, 32)}`;
  const attempt = createHash("sha256").update(`attempt:${nonce}`).digest("hex").slice(0, 16);
  const record: ReviewRecord = {
    version: 1,
    stage,
    unit,
    workflow: null,
    attempt,
    iteration: 1,
    reviewer,
    verdict: "READY",
    request_id: requestId,
    request_challenge: null,
    artifact_fingerprint: fingerprint,
    source_fingerprint: null,
    unit_source_fingerprint: null,
    findings: [],
    body: `**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Iteration:** 1\n`,
    recorded_at: "2026-08-20T01:00:00Z",
  };
  const bytes = serializeReviewRecord(record);
  const path = reviewRecordRelativePath(stage, unit, attempt, 1);
  const target = join(seededRecordDir(projectDir), ...path.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, bytes);
  return {
    request:
      `**Reviewer**: ${reviewer}\n**Iteration**: 1\n` +
      `**Artifact Fingerprint**: ${fingerprint}\n**Request Id**: ${requestId}\n`,
    completion:
      `**Reviewer**: ${reviewer}\n**Iteration**: 1\n` +
      `**Verdict**: READY\n**Request Fingerprint**: ${fingerprint}\n` +
      `**Artifact Fingerprint**: ${fingerprint}\n**Request Id**: ${requestId}\n` +
      `**Review Record**: ${path}\n**Review Record Digest**: ${reviewRecordDigest(bytes)}\n`,
  };
}

// The fixture cleanup removes candidate checkouts even when an assertion fails.
// Keep the pinned inputs and the original Git command outcomes in the test log
// when any gate/land call rejects review evidence or candidate-exact content.
export function reportPinnedMergeFailure(
  projectDir: string,
  unit: string,
  tracePath: string,
  failureOutput: string,
): void {
  try {
    const prefix = relative(projectDir, seededRecordDir(projectDir)).replaceAll("\\", "/");
    const filesAt = (oid: string) => {
      const paths = git(projectDir, ["ls-tree", "-r", "--name-only", oid, "--", prefix])
        .split("\n").filter(Boolean);
      return Object.fromEntries(paths.map((path) => {
        const result = spawnSync("git", ["show", `${oid}:${path}`, "--"], {
          cwd: projectDir,
          encoding: "utf-8",
        });
        return [path, {
          status: result.status,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          error: result.error?.message,
        }];
      }));
    };
    const transaction = readUnitMergeTransaction(projectDir, unit);
    const pinnedOid = transaction?.pinned_oid ?? null;
    const landingHead = git(projectDir, ["rev-parse", "HEAD"]);
    let candidateExact = null;
    try { candidateExact = JSON.parse(failureOutput).candidate_exact ?? null; } catch { /* Keep the other captures. */ }
    const readBlob = (oid: string | null, treeish: string, path: string) => {
      const args = oid ? ["cat-file", "blob", oid] : ["show", `${treeish}:${path}`, "--"];
      const result = spawnSync("git", args, {
        cwd: projectDir,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
        maxBuffer: 64 * 1024,
      });
      const bytes = result.stdout ?? Buffer.alloc(0);
      return {
        args, status: result.status, signal: result.signal,
        error: result.error?.message,
        errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
        stderr: result.stderr?.toString("utf8"),
        capturedBytes: bytes.length,
        capturedSha256: createHash("sha256").update(bytes).digest("hex"),
        capturedBase64: bytes.toString("base64"),
        utf8Preview: bytes.toString("utf8").slice(0, 4000),
      };
    };
    const mismatches = candidateExact?.object_mismatches ?? [];
    // Read the captured identities, including a rolled-back commit, before
    // cleanup. These probes supplement rather than replace the original reads.
    const blobComparisons = mismatches.slice(0, 8).map((entry: {
      path: string; expected_treeish: string;
      actual: { oid: string | null }; expected: { oid: string | null };
    }) => ({
      path: entry.path,
      expectedAfterFailure: readBlob(entry.expected.oid, entry.expected_treeish, entry.path),
      actualAfterFailure: readBlob(entry.actual.oid, candidateExact.treeish, entry.path),
      pendingAfterFailure: candidateExact.passed_pending_tree_oid
        ? readBlob(null, candidateExact.passed_pending_tree_oid, entry.path)
        : null,
    }));
    console.error(`t326 pinned merge diagnostics:\n${JSON.stringify({
      unit,
      pinnedOid,
      landingHead,
      transaction,
      candidateExact,
      blobComparisons,
      omittedBlobComparisons: Math.max(0, mismatches.length - blobComparisons.length),
      pinnedFiles: pinnedOid ? filesAt(pinnedOid) : null,
      landingFiles: filesAt(landingHead),
      checkedTreeFiles: candidateExact?.treeish ? filesAt(candidateExact.treeish) : null,
      passedPendingTreeFiles: candidateExact?.passed_pending_tree_oid
        ? filesAt(candidateExact.passed_pending_tree_oid)
        : null,
    }, null, 2)}`);
  } catch (error) {
    console.error(`t326 pinned merge diagnostics unavailable: ${String(error)}`);
  }
  try {
    console.error(`t326 landing Git trace:\n${readFileSync(tracePath, "utf-8")}`);
  } catch (error) {
    console.error(`t326 landing Git trace unavailable: ${String(error)}`);
  }
}

export function prepareCandidate(
  remote: string,
  unit: string,
  label: string,
  options: {
    mergeHeld?: boolean;
    sourceText?: string;
    sharedText?: string;
    wave?: boolean;
  } = {},
): {
  checkout: string;
  candidateOid: string;
  generation: number;
  auditShard: string;
} {
  const checkout = clone(remote, label);
  const claim = runMergeTool(UNIT, ["claim", unit, "--team", label], checkout);
  expect(claim.status, claim.out).toBe(0);
  const claimPayload = JSON.parse(claim.stdout);
  const generation = claimPayload.generation as number;
  const intentUuid = claimPayload.intent_uuid as string;
  const stages = [
    "functional-design",
    "nfr-requirements",
    "nfr-design",
    "infrastructure-design",
    "code-generation",
  ];
  let state = readFileSync(seededStateFile(checkout), "utf-8");
  const rowCells = [
    unit,
    label,
    "[x]",
    "[x]",
    "[x]",
    "[x]",
    "[x]",
    "[x]",
  ];
  if (/^\| unit \|.*\| merged \|$/m.test(state)) rowCells.push("");
  const row = `| ${rowCells.join(" | ")} |`;
  state = state.replace(
    new RegExp(`^\\| ${unit} \\|.*$`, "m"),
    row,
  );
  if (options.mergeHeld) {
    state = state.replace(
      "## Project Information",
      "## Project Information\n- **Merge-Held**: true",
    );
  }
  writeFileSync(seededStateFile(checkout), state);

  const graph = loadStageGraphAll();
  for (const stageSlug of stages) {
    const stage = graph.find((entry) => entry.slug === stageSlug)!;
    const dir = join(
      seededRecordDir(checkout),
      "construction",
      unit,
      stageSlug,
    );
    mkdirSync(dir, { recursive: true });
    for (const name of stage.produces ?? []) {
      writeFileSync(
        join(dir, artifactFilename(name)),
        `# ${name}\n\ncandidate ${unit}\n`,
      );
    }
  }
  const codeDir = join(
    seededRecordDir(checkout),
    "construction",
    unit,
    "code-generation",
  );
  const contract = resolveTestingPosture(checkout);
  const plan =
    `# Code Generation Plan\n\n${renderTestingContract(contract)}\n` +
    "## Steps\n\n- [ ] Implement the Unit.\n";
  const instructions =
    "# Unit Test Instructions\n\n## Command\n\n`bun test`\n";
  const authority = {
    targetId: `unit:${unit}`,
    intentId: intentUuid,
    directiveEpoch: `sha256:${createHash("sha256")
      .update(`directive:${unit}:${generation}`)
      .digest("hex")}`,
    runFloor: "unstarted#0",
    sourceFloor: `sha256:${createHash("sha256")
      .update(`source:${unit}:${generation}`)
      .digest("hex")}`,
  };
  const planFingerprint = approvalFingerprint(
    plan,
    instructions,
    contract.contract_sha256,
    authority,
  );
  const questionsFile = join(codeDir, "code-generation-questions.md");
  const questions =
    "## Plan Approval\n" +
    `[Approval Fingerprint]: ${planFingerprint}\n` +
    "[Answer]: A. Approve Plan\n";
  writeFileSync(join(codeDir, "code-generation-plan.md"), plan);
  writeFileSync(join(codeDir, "unit-test-instructions.md"), instructions);
  writeFileSync(questionsFile, questions);
  const srcDir = join(checkout, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, `${unit}.ts`),
    options.sourceText ?? `export const ${unit} = "team";\n`,
  );
  if (options.sharedText !== undefined) {
    writeFileSync(join(srcDir, "shared.ts"), options.sharedText);
  }

  let audit = "";
  for (const stage of stages) {
    const stageNode = graph.find((entry) => entry.slug === stage);
    const lifecycleExtra = options.wave && stageNode
      ? `**Mode**: wave\n**Artifact Fingerprint**: ${
        reviewArtifactFingerprint(
          checkout,
          stageNode,
          unit,
          { requireRequiredArtifacts: true },
        )
      }\n`
      : "";
    audit += auditBlock(
      "UNIT_COMPLETED",
      unit,
      generation,
      stage,
      lifecycleExtra,
    );
    if (stage === "code-generation") {
      const promptSha256 = createHash("sha256")
        .update(
          `${questions
            .replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:")
            .trimEnd()}\n`,
          "utf-8",
        )
        .digest("hex");
      audit += auditBlock(
        "PLAN_APPROVAL_RECORDED",
        unit,
        generation,
        stage,
        `**Details**: Approve Plan\n` +
          `**Checkpoint**: Code Generation Plan Approval\n` +
          `**Plan Target**: unit:${unit}\n` +
          `**Intent**: ${intentUuid}\n` +
          `**Directive Epoch**: ${authority.directiveEpoch}\n` +
          `**Approval Fingerprint**: ${planFingerprint}\n` +
          `**Questions File**: ${relative(checkout, questionsFile).replaceAll("\\", "/")}\n` +
          `**Questions SHA-256**: ${createHash("sha256").update(questions, "utf-8").digest("hex")}\n` +
          `**Prompt SHA-256**: ${promptSha256}\n` +
          `**Session**: ${label}-session\n`,
      );
    }
    if (stageNode?.reviewer) {
      const fingerprint = reviewArtifactFingerprint(
        checkout,
        stageNode,
        unit,
      );
      expect(fingerprint).not.toBeNull();
      const review = reviewAuditExtras(
        checkout,
        stage,
        unit,
        stageNode.reviewer,
        fingerprint as string,
        `${label}:${unit}:${generation}:${stage}`,
      );
      audit += auditBlock(
        "REVIEW_REQUESTED",
        unit,
        generation,
        stage,
        review.request,
      );
      audit += auditBlock(
        "REVIEW_COMPLETED",
        unit,
        generation,
        stage,
        review.completion,
      );
    }
    audit += auditBlock(
      "GATE_APPROVED",
      unit,
      generation,
      stage,
      `**Gate Scope**: per-stage\n**Gate Stages**: ${stage}\n**User Input**: Approve\n`,
    );
  }
  const auditShard = auditShardName(checkout);
  writeFileSync(join(seededAuditDir(checkout), auditShard), audit);
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-m", `complete ${unit}`]);
  const published = runMergeTool(UNIT, ["publish", unit], checkout);
  expect(published.status, published.out).toBe(0);
  return {
    checkout,
    candidateOid: JSON.parse(published.stdout).candidate_oid,
    generation,
    auditShard,
  };
}

export function completeUnitOnMain(projectDir: string, unit: string): void {
  const stages = [
    "functional-design",
    "nfr-requirements",
    "nfr-design",
    "infrastructure-design",
    "code-generation",
  ];
  const graph = loadStageGraphAll();
  for (const stageSlug of stages) {
    const stage = graph.find((entry) => entry.slug === stageSlug)!;
    const dir = join(
      seededRecordDir(projectDir),
      "construction",
      unit,
      stageSlug,
    );
    mkdirSync(dir, { recursive: true });
    for (const name of stage.produces ?? []) {
      writeFileSync(
        join(dir, artifactFilename(name)),
        `# ${name}\n\nmain-built ${unit}\n`,
      );
    }
  }
  const codeDir = join(
    seededRecordDir(projectDir),
    "construction",
    unit,
    "code-generation",
  );
  const contract = resolveTestingPosture(projectDir);
  const plan =
    `# Code Generation Plan\n\n${renderTestingContract(contract)}\n` +
    "## Steps\n\n- [ ] Implement the Unit on main.\n";
  const instructions =
    "# Unit Test Instructions\n\n## Command\n\n`bun test`\n";
  const planFingerprint = approvalFingerprint(
    plan,
    instructions,
    contract.contract_sha256,
    {
      targetId: `unit:${unit}`,
      intentId: "main-fixture",
      runFloor: "unstarted#0",
    },
  );
  writeFileSync(join(codeDir, "code-generation-plan.md"), plan);
  writeFileSync(join(codeDir, "unit-test-instructions.md"), instructions);
  writeFileSync(
    join(codeDir, "code-generation-questions.md"),
    "## Plan Approval\n" +
      `[Approval Fingerprint]: ${planFingerprint}\n` +
      "[Answer]: A. Approve Plan\n",
  );
  writeFileSync(
    join(projectDir, "src", `${unit}.ts`),
    `export const ${unit} = "main";\n`,
  );
  let audit = "";
  for (const stageSlug of stages) {
    const stage = graph.find((entry) => entry.slug === stageSlug)!;
    audit += auditBlock("UNIT_COMPLETED", unit, 1, stageSlug);
    if (stage.reviewer) {
      const fingerprint = reviewArtifactFingerprint(
        projectDir,
        stage,
        unit,
      );
      expect(fingerprint).not.toBeNull();
      const review = reviewAuditExtras(
        projectDir,
        stageSlug,
        unit,
        stage.reviewer,
        fingerprint as string,
        `main:${unit}:1:${stageSlug}`,
      );
      audit += auditBlock(
        "REVIEW_REQUESTED",
        unit,
        1,
        stageSlug,
        review.request,
      );
      audit += auditBlock(
        "REVIEW_COMPLETED",
        unit,
        1,
        stageSlug,
        review.completion,
      );
    }
    audit += auditBlock(
      "GATE_APPROVED",
      unit,
      1,
      stageSlug,
      `**Gate Scope**: per-stage\n**Gate Stages**: ${stageSlug}\n**User Input**: Approve\n`,
    );
  }
  writeFileSync(
    join(seededAuditDir(projectDir), `main-built-${unit}.md`),
    audit,
  );
}

export function dispatchMerge(
  main: string,
  unit: string,
  pinnedOid: string,
  generation = 1,
): void {
  const pinId = readUnitMergeTransaction(main, unit)?.pin_id;
  expect(pinId).toBeTruthy();
  const invoked = runMergeTool(
    BOLT,
    [
      "dispatch-event",
      "--event",
      "MERGE_DISPATCH_INVOKED",
      "--slug",
      unit,
      "--pinned-oid",
      pinnedOid,
      "--attempt-generation",
      String(generation),
      "--pin-id",
      pinId!,
      "--practices-excerpt",
      "trunk-based integration on main",
    ],
    main,
  );
  expect(invoked.status, invoked.out).toBe(0);
  const returned = runMergeTool(
    BOLT,
    [
      "dispatch-event",
      "--event",
      "MERGE_DISPATCH_RETURNED",
      "--slug",
      unit,
      "--pinned-oid",
      pinnedOid,
      "--attempt-generation",
      String(generation),
      "--pin-id",
      pinId!,
      "--strategy",
      "merge",
      "--target",
      "main",
      "--confidence",
      "1",
      "--notes",
      `merge pinned candidate ${pinnedOid}`,
    ],
    main,
  );
  expect(returned.status, returned.out).toBe(0);
}

export function appendMainHumanTurn(projectDir: string): void {
  const shard = join(seededAuditDir(projectDir), auditShardName(projectDir));
  let existing = "";
  try {
    existing = readFileSync(shard, "utf-8");
  } catch {
    // The dispatch bracket normally creates the main shard first.
  }
  writeFileSync(
    shard,
    `${existing}## Human Turn
**Timestamp**: ${
  new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}
**Event**: HUMAN_TURN

---
`,
  );
}

export function approveMerge(
  main: string,
  unit: string,
): { pinnedOid: string; stateBeforeGit: string } {
  const pin = runMergeTool(UNIT, ["pin", unit], main);
  expect(pin.status, pin.out).toBe(0);
  const pinPayload = JSON.parse(pin.stdout);
  const pinnedOid = pinPayload.pinned_oid as string;
  dispatchMerge(main, unit, pinnedOid, pinPayload.generation);
  const gate = runMergeTool(
    UNIT,
    [
      "gate",
      unit,
      "--decision",
      "approve",
      "--user-input",
      "Approve pinned candidate",
    ],
    main,
  );
  expect(gate.status, gate.out).toBe(0);
  return { pinnedOid, stateBeforeGit: readFileSync(seededStateFile(main), "utf-8") };
}

export function gateAndLand(
  main: string,
  unit: string,
  stepwise = false,
): { pinnedOid: string; stateBeforeGit: string } {
  const { pinnedOid, stateBeforeGit } = approveMerge(main, unit);
  if (stepwise) {
    const gitStep = runMergeTool(UNIT, ["land", unit, "--step", "git"], main);
    expect(gitStep.status, gitStep.out).toBe(0);
    const firstCommit = JSON.parse(gitStep.stdout).git_commit_oid;
    expect(readFileSync(seededStateFile(main), "utf-8")).toBe(stateBeforeGit);
    expect(readFileSync(join(main, "src", `${unit}.ts`), "utf-8")).toContain("team");
    expect(() => readFileSync(join(main, ".aidlc-unit-claim.json"), "utf-8")).toThrow();
    const retryGit = runMergeTool(UNIT, ["land", unit, "--step", "git"], main);
    expect(retryGit.status, retryGit.out).toBe(0);
    expect(JSON.parse(retryGit.stdout).git_commit_oid).toBe(firstCommit);

    const stateStep = runMergeTool(UNIT, ["land", unit, "--step", "state"], main);
    expect(stateStep.status, stateStep.out).toBe(0);
    const folded = readFileSync(seededStateFile(main), "utf-8");
    const targetCells = unitProgressRow(main, unit)
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    expect(targetCells[0]).toBe(unit);
    expect(targetCells[1]).not.toBe("-");
    expect(targetCells.slice(2)).toEqual(
      targetCells.slice(2).map(() => "[x]"),
    );
    expect(folded).toContain("| merged |");
    const retryState = runMergeTool(UNIT, ["land", unit, "--step", "state"], main);
    expect(retryState.status, retryState.out).toBe(0);
    expect(readFileSync(seededStateFile(main), "utf-8")).toBe(folded);

    const auditStep = runMergeTool(UNIT, ["land", unit, "--step", "audit"], main);
    expect(auditStep.status, auditStep.out).toBe(0);
    const retryAudit = runMergeTool(UNIT, ["land", unit, "--step", "audit"], main);
    expect(retryAudit.status, retryAudit.out).toBe(0);
  } else {
    const landed = runMergeTool(UNIT, ["land", unit], main);
    expect(landed.status, landed.out).toBe(0);
  }
  return { pinnedOid, stateBeforeGit };
}

export function nextDirective(projectDir: string): Record<string, unknown> {
  const first = runMergeTool(ORCH, ["next"], projectDir);
  expect(first.status, first.out).toBe(0);
  let directive = JSON.parse(first.stdout) as Record<string, unknown>;
  while (
    directive.kind === "load-steering" &&
    typeof directive.receipt === "string"
  ) {
    const continued = runMergeTool(
      ORCH,
      ["continue", directive.receipt],
      projectDir,
    );
    expect(continued.status, continued.out).toBe(0);
    directive = JSON.parse(continued.stdout) as Record<string, unknown>;
  }
  return directive;
}

export function unitProgressRow(projectDir: string, unit: string): string {
  return readFileSync(seededStateFile(projectDir), "utf-8")
    .split(/\r?\n/)
    .find((line) => line.startsWith(`| ${unit} |`)) ?? "";
}
