// covers: subcommand:aidlc-unit:adopt, subcommand:aidlc-unit:claim, subcommand:aidlc-unit:release, subcommand:aidlc-unit:participate, subcommand:aidlc-unit:status, subcommand:aidlc-utility:claim, subcommand:aidlc-utility:release, subcommand:aidlc-utility:participate, subcommand:aidlc-state:sync-unit-scope-stage, subcommand:aidlc-orchestrate:next, function:UNIT_SCOPE_FILE, function:UNIT_PARKED_FILE, function:CLAIM_GENERATIONS_FILE, function:UNIT_PARTICIPANT_FILE, function:CLAIM_REGISTRY_CACHE_FILE, function:UNIT_RELEASE_PENDING_FILE, function:unitScopePath, function:unitParkedPath, function:claimGenerationsPath, function:unitParticipantPath, function:claimRegistryCachePath, function:unitReleasePendingPath, function:readUnitScopeStamp, function:readApplicableTeamUnitScopeStamp, function:writeUnitScopeStamp, function:clearUnitScopeStamp, function:readClaimGenerations, function:writeClaimGeneration, function:clearClaimGeneration, function:readUnitClaimRegistryCache, function:writeUnitClaimRegistryCache, function:claimAttemptFields, function:eventMatchesClaimAttempt, function:effectiveUnitGateRhythm, function:hasAnyUnitClaimRefs, function:validateLiveUnitScope, function:requireLiveClaimForTeamUnit, function:isWalkingSkeletonUnitOnMain, function:worktreeClaimBoundaryMatches, function:ensureCloneId, function:invalidateLiveClaimPayloadCache

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activeIntentUuid,
  artifactFilename,
  eventMatchesClaimAttempt,
  readAllAuditShards,
  unitReleasePendingPath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const UNIT = join(AIDLC_SRC, "tools", "aidlc-unit.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const AUDIT = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const RUNTIME = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");
const WORKTREE = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    if (dir.includes("aidlc-test-")) cleanupTestProject(dir);
    else rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return (result.stdout ?? "").trim();
}

function stateBody(
  scope = "feature",
  skeletonComplete = true,
  rhythm = "per-stage",
): string {
  const skeletonMarker = skeletonComplete ? "[x]" : "[ ]";
  return `# AI-DLC State Tracking

## Project Information
- **Project**: inc2 claims
- **Project Type**: Greenfield
- **Scope**: ${scope}
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Unit Ownership**: team
- **Unit Gate Rhythm**: ${rhythm}
- **Review Override**: none
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

## Unit Progress
| unit | owner | functional-design | nfr-requirements | nfr-design | infrastructure-design | code-generation | gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| skeleton | - | ${skeletonMarker} | ${skeletonMarker} | ${skeletonMarker} | ${skeletonMarker} | ${skeletonMarker} | ${skeletonMarker} |
| alpha | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| beta | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| gamma | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-08-20T00:00:00Z
`;
}

function dependencyBody(): string {
  return `# Unit dependencies

\`\`\`yaml
units:
  - name: skeleton
    depends_on: []
  - name: alpha
    depends_on: [skeleton]
  - name: beta
    depends_on: [alpha]
  - name: gamma
    depends_on: [skeleton]
\`\`\`
`;
}

function makeSeed(options: {
  scope?: string;
  skeletonComplete?: boolean;
  rhythm?: "per-stage" | "unit-end";
} = {}): { seed: string; remote: string } {
  const seed = createTestProject();
  tempDirs.push(seed);
  seedAidlcMemory(seed);
  writeFileSync(
    seededStateFile(seed),
    stateBody(options.scope, options.skeletonComplete, options.rhythm),
  );
  const depDir = join(seededRecordDir(seed), "inception", "units-generation");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, "unit-of-work-dependency.md"), dependencyBody());
  if (options.skeletonComplete !== false) {
    mkdirSync(seededAuditDir(seed), { recursive: true });
    writeFileSync(
      join(seededAuditDir(seed), "skeleton.md"),
      "## Bolt Started\n**Timestamp**: 2026-08-20T00:00:00Z\n" +
        "**Event**: BOLT_STARTED\n**Bolt names**: skeleton\n**Walking skeleton**: true\n\n---\n" +
        "## Bolt Completed\n**Timestamp**: 2026-08-20T00:00:01Z\n" +
        "**Event**: BOLT_COMPLETED\n**Bolt names**: skeleton\n\n---\n",
    );
  }
  writeFileSync(
    join(seed, ".gitignore"),
    "aidlc/.aidlc-clone-id\naidlc/.aidlc-unit-scope.json\naidlc/.aidlc-unit-parked\n" +
      "aidlc/.aidlc-claim-generations.json\naidlc/.aidlc-unit-participant\n" +
      "aidlc/.aidlc-claim-registry.json\naidlc/.aidlc-unit-releases/\n",
  );
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "seed"]);
  git(seed, ["config", "user.email", "seed@example.test"]);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "seed"]);
  const remote = mkdtempSync(join(tmpdir(), "aidlc-inc2-remote-"));
  tempDirs.push(remote);
  git(remote, ["init", "--bare"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { seed, remote };
}

function clone(remote: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aidlc-inc2-${label}-`));
  rmSync(dir, { recursive: true, force: true });
  git(tmpdir(), ["clone", remote, dir]);
  tempDirs.push(dir);
  git(dir, ["config", "user.name", label]);
  git(dir, ["config", "user.email", `${label}@example.test`]);
  return dir;
}

function partialClone(remote: string, label: string): string {
  git(remote, ["config", "uploadpack.allowFilter", "true"]);
  const dir = mkdtempSync(join(tmpdir(), `aidlc-inc2-${label}-`));
  rmSync(dir, { recursive: true, force: true });
  git(tmpdir(), [
    "clone",
    "--filter=blob:none",
    "--no-local",
    `file://${remote}`,
    dir,
  ]);
  tempDirs.push(dir);
  git(dir, ["config", "user.name", label]);
  git(dir, ["config", "user.email", `${label}@example.test`]);
  return dir;
}

function run(
  tool: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
) {
  const result = spawnSync(process.execPath, [tool, ...args, "--project-dir", cwd], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      ...extraEnv,
    },
  });
  return {
    status: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    stdout: result.stdout ?? "",
  };
}

function nextDirective(
  cwd: string,
  extraEnv: Record<string, string> = {},
): Record<string, unknown> {
  const first = run(ORCH, ["next"], cwd, extraEnv);
  expect(first.status, first.out).toBe(0);
  const directive = JSON.parse(first.stdout) as Record<string, unknown>;
  if (
    directive.kind === "load-steering" &&
    typeof directive.continue_token === "string"
  ) {
    const continued = run(
      ORCH,
      ["continue", directive.continue_token],
      cwd,
      extraEnv,
    );
    expect(continued.status, continued.out).toBe(0);
    return JSON.parse(continued.stdout) as Record<string, unknown>;
  }
  return directive;
}

function writeFunctionalArtifacts(projectDir: string, unit: string): void {
  const functionalDir = join(
    seededRecordDir(projectDir),
    "construction",
    unit,
    "functional-design",
  );
  mkdirSync(functionalDir, { recursive: true });
  for (const artifact of [
    "entities",
    "rules",
    "functional-spec",
    "frontend-components",
    "traceability",
  ]) {
    writeFileSync(
      join(functionalDir, artifactFilename(artifact)),
      `# ${artifact}\n`,
    );
  }
}

function fetchClaimRefs(projectDir: string): void {
  git(projectDir, [
    "fetch",
    "origin",
    "+refs/heads/claim/*:refs/remotes/origin/claim/*",
  ]);
}

function localRuntimeSnapshot(projectDir: string): Record<string, string | null> {
  const paths = [
    seededStateFile(projectDir),
    join(projectDir, "aidlc", ".aidlc-unit-scope.json"),
    join(projectDir, "aidlc", ".aidlc-unit-parked"),
    join(projectDir, "aidlc", ".aidlc-claim-generations.json"),
    join(projectDir, "aidlc", ".aidlc-claim-registry.json"),
    join(projectDir, "aidlc", ".aidlc-unit-participant"),
    unitReleasePendingPath(projectDir, "alpha"),
    unitReleasePendingPath(projectDir, "beta"),
    join(seededRecordDir(projectDir), ".aidlc-active-directive.json"),
    join(seededRecordDir(projectDir), ".aidlc-steering-token-key"),
  ];
  return Object.fromEntries(
    paths.map((path) => [path, exists(path) ? readFileSync(path, "utf-8") : null]),
  );
}

describe("t325 atomic team Unit claims", () => {
  test("a fresh clone can adopt the checked-out live claim and publish", () => {
    const { remote } = makeSeed();
    const owner = clone(remote, "adopt-owner");
    const claimed = run(UNIT, ["claim", "alpha", "--team", "adopt-team"], owner);
    expect(claimed.status, claimed.out).toBe(0);
    const claim = JSON.parse(claimed.stdout);

    const teammate = clone(remote, "adopt-teammate");
    git(teammate, [
      "fetch",
      "origin",
      `${claim.claim_ref}:${claim.claim_ref}`,
    ]);
    git(teammate, ["switch", claim.claim_ref.replace("refs/heads/", "")]);
    const adopted = run(UNIT, ["adopt", "alpha"], teammate);
    expect(adopted.status, adopted.out).toBe(0);
    expect(JSON.parse(adopted.stdout)).toMatchObject({
      adopted: true,
      unit: "alpha",
      generation: claim.generation,
      nonce: claim.nonce,
      audit_shard: claim.audit_shard,
    });
    writeFileSync(join(teammate, "adopted.txt"), "continued by teammate\n");
    git(teammate, ["add", "adopted.txt"]);
    git(teammate, ["commit", "-m", "continue adopted Unit"]);
    const published = run(UNIT, ["publish", "alpha"], teammate);
    expect(published.status, published.out).toBe(0);
  }, 120000);

  test("claim opening enforces skeleton and dependency blockers", () => {
    const skeletonOn = makeSeed({ skeletonComplete: false });
    const cloneOn = clone(skeletonOn.remote, "blocked");
    const blocked = run(
      UNIT,
      ["claim", "skeleton", "--team", "blocked"],
      cloneOn,
    );
    expect(blocked.status).not.toBe(0);
    expect(blocked.out).toContain("walking skeleton");

    const skeletonOff = makeSeed({
      scope: "express",
      skeletonComplete: false,
    });
    const cloneOff = clone(skeletonOff.remote, "open");
    const open = run(UNIT, ["claim", "skeleton", "--team", "open"], cloneOff);
    expect(open.status, open.out).toBe(0);

    const dependency = makeSeed();
    const dependencyClone = clone(dependency.remote, "waiting");
    const waiting = run(
      UNIT,
      ["claim", "beta", "--team", "waiting"],
      dependencyClone,
    );
    expect(waiting.status).not.toBe(0);
    expect(waiting.out).toContain("beta waits on alpha");
  }, 60000);

  test("malformed public claim flags fail closed instead of advancing", () => {
    const { seed } = makeSeed();
    for (const args of [
      ["next", "--claim"],
      ["next", "--release"],
      ["next", "--team", "x"],
      ["next", "--claim", "alpha", "--rhythm"],
    ]) {
      const result = run(ORCH, args, seed);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).kind).toBe("error");
    }
  });

  test("participant-first picker and Stop-hook probes are local, pure, and directive-identical", () => {
    const fresh = makeSeed({ scope: "express", skeletonComplete: false });
    const participant = clone(fresh.remote, "first-participant");
    expect(run(UNIT, ["participate"], participant).status).toBe(0);
    git(participant, ["remote", "set-url", "origin", join(participant, "dead-remote")]);
    expect(
      nextDirective(participant, { AIDLC_STOP_HOOK_PROBE: "1" }),
    ).toMatchObject({
      kind: "ask",
      ask_type: "unit-claim",
      claimable_units: ["skeleton"],
    });

    const claimless = makeSeed();
    git(claimless.seed, [
      "remote",
      "set-url",
      "origin",
      join(claimless.seed, "dead-remote"),
    ]);
    const claimlessAudit = readAllAuditShards(claimless.seed);
    const claimlessRuntime = localRuntimeSnapshot(claimless.seed);
    const claimlessDirective = nextDirective(claimless.seed, {
      AIDLC_STOP_HOOK_PROBE: "1",
    });
    expect(claimlessDirective).toMatchObject({ kind: "run-stage", unit: "skeleton" });
    expect(localRuntimeSnapshot(claimless.seed)).toEqual(claimlessRuntime);
    expect(readAllAuditShards(claimless.seed)).toBe(claimlessAudit);

    const knobOff = clone(claimless.remote, "stray-stamp");
    writeFileSync(
      seededStateFile(knobOff),
      readFileSync(seededStateFile(knobOff), "utf-8").replace(
        "- **Unit Ownership**: team",
        "- **Unit Ownership**: solo",
      ),
    );
    const beforeStamp = nextDirective(knobOff, { AIDLC_STOP_HOOK_PROBE: "1" });
    writeFileSync(
      join(knobOff, "aidlc", ".aidlc-unit-scope.json"),
      `${JSON.stringify({
        version: 1,
        space: "wrong",
        intent_uuid: "wrong-intent",
        intent_id8: "deadbeef",
        unit: "beta",
        owner: "stray",
        generation: 99,
        nonce: "stray",
        claim_ref: "refs/heads/claim/deadbeef/beta",
        claim_oid: "1".repeat(40),
        claimed_from_oid: "2".repeat(40),
        integration_ref: "refs/heads/main",
        gate_rhythm: "unit-end",
      })}\n`,
    );
    const knobState = readFileSync(seededStateFile(knobOff), "utf-8");
    const knobAudit = readAllAuditShards(knobOff);
    expect(nextDirective(knobOff, { AIDLC_STOP_HOOK_PROBE: "1" })).toEqual(
      beforeStamp,
    );
    expect(readFileSync(seededStateFile(knobOff), "utf-8")).toBe(knobState);
    expect(readAllAuditShards(knobOff)).toBe(knobAudit);
    expect(
      eventMatchesClaimAttempt(
        knobOff,
        "**Event**: UNIT_COMPLETED\n**Unit**: alpha\n**Attempt Generation**: 1\n",
        "alpha",
      ),
    ).toBe(true);

    const fanout = makeSeed();
    const claimant = clone(fanout.remote, "fanout");
    expect(run(UNIT, ["claim", "alpha", "--team", "fanout"], claimant).status).toBe(0);
    fetchClaimRefs(fanout.seed);
    const actual = nextDirective(fanout.seed);
    expect(actual.kind).toBe("notice");
    const runtimeBefore = localRuntimeSnapshot(fanout.seed);
    const auditBefore = readAllAuditShards(fanout.seed);
    git(fanout.seed, [
      "remote",
      "set-url",
      "origin",
      join(fanout.seed, "dead-remote"),
    ]);
    const probe = nextDirective(fanout.seed, {
      AIDLC_STOP_HOOK_PROBE: "1",
    });
    expect(probe).toEqual(actual);
    expect(localRuntimeSnapshot(fanout.seed)).toEqual(runtimeBefore);
    expect(readAllAuditShards(fanout.seed)).toBe(auditBefore);
  }, 120000);

  test("scoped receipt writes and claim-sensitive forks are offline-first", () => {
    const { remote } = makeSeed();
    const checkout = clone(remote, "offline");
    expect(run(UNIT, ["claim", "alpha", "--team", "offline"], checkout).status).toBe(0);
    git(checkout, [
      "remote",
      "set-url",
      "origin",
      join(checkout, "dead-remote"),
    ]);
    writeFileSync(
      seededStateFile(checkout),
      readFileSync(seededStateFile(checkout), "utf-8").replace(
        "- **Review Override**: none",
        "- **Review Override**: adversarial",
      ),
    );
    const scopedActual = nextDirective(checkout);
    expect(scopedActual).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
      unit: "alpha",
    });
    const scopedRuntimeBefore = localRuntimeSnapshot(checkout);
    const firstProbe = run(
      ORCH,
      ["next"],
      checkout,
      { AIDLC_STOP_HOOK_PROBE: "1" },
    );
    expect(firstProbe.status, firstProbe.out).toBe(0);
    let probeDirective = JSON.parse(firstProbe.stdout) as Record<string, unknown>;
    expect(localRuntimeSnapshot(checkout)).toEqual(scopedRuntimeBefore);
    while (
      probeDirective.kind === "load-steering" &&
      typeof probeDirective.continue_token === "string"
    ) {
      const continued = run(
        ORCH,
        ["continue", probeDirective.continue_token],
        checkout,
        { AIDLC_STOP_HOOK_PROBE: "1" },
      );
      expect(continued.status, continued.out).toBe(0);
      probeDirective = JSON.parse(continued.stdout) as Record<string, unknown>;
    }
    expect(probeDirective).toEqual(scopedActual);
    expect(
      run(
        STATE,
        ["unit", "start", "--stage", "functional-design", "--unit", "alpha"],
        checkout,
      ).status,
    ).toBe(0);
    writeFunctionalArtifacts(checkout, "alpha");
    expect(
      run(
        LOG,
        [
          "decision",
          "--stage",
          "functional-design",
          "--decision",
          "Offline choice",
          "--unit",
          "alpha",
        ],
        checkout,
      ).status,
    ).toBe(0);
    expect(
      run(
        LOG,
        [
          "answer",
          "--stage",
          "functional-design",
          "--details",
          "Offline answer",
          "--unit",
          "alpha",
        ],
        checkout,
      ).status,
    ).toBe(0);
    expect(
      run(
        LOG,
        [
          "review",
          "--stage",
          "functional-design",
          "--reviewer",
          "aidlc-architecture-reviewer-agent",
          "--iteration",
          "1",
          "--unit",
          "alpha",
        ],
        checkout,
      ).status,
    ).toBe(0);
    // Completion validates a canonical reviewer appendix appended to the
    // stage's review_artifact after the request.
    appendFileSync(
      join(
        seededRecordDir(checkout),
        "construction",
        "alpha",
        "functional-design",
        artifactFilename("functional-spec"),
      ),
      "\n## Review\n\n" +
        "**Verdict:** READY\n" +
        "**Reviewer:** aidlc-architecture-reviewer-agent\n" +
        "**Iteration:** 1\n\n" +
        "### Findings\n\nNo blocking findings.\n",
    );
    expect(
      run(
        LOG,
        [
          "review",
          "--stage",
          "functional-design",
          "--reviewer",
          "aidlc-architecture-reviewer-agent",
          "--iteration",
          "1",
          "--verdict",
          "READY",
          "--unit",
          "alpha",
        ],
        checkout,
      ).status,
    ).toBe(0);
    expect(
      run(
        STATE,
        ["unit", "complete", "--stage", "functional-design", "--unit", "alpha"],
        checkout,
      ).status,
    ).toBe(0);
    expect(
      JSON.parse(
        run(
          ORCH,
          [
            "report",
            "--stage",
            "functional-design",
            "--unit",
            "alpha",
            "--result",
            "awaiting-approval",
          ],
          checkout,
        ).stdout,
      ).kind,
    ).toBe("print");

    expect(
      run(WORKTREE, ["create", "--slug", "alpha", "--base", "main"], checkout)
        .status,
    ).toBe(0);
    const fork = run(STATE, ["fork", "--slug", "alpha"], checkout);
    expect(fork.status, fork.out).toBe(0);
    expect(fork.out).toContain("registry is unavailable");
    const auditFork = run(AUDIT, ["audit-fork", "--slug", "alpha"], checkout);
    expect(auditFork.status, auditFork.out).toBe(0);
    const fragmentFork = run(
      RUNTIME,
      ["fragment-fork", "--slug", "alpha"],
      checkout,
    );
    expect(fragmentFork.status, fragmentFork.out).toBe(0);
  }, 120000);

  test("claim-time rhythm overrides are authoritative in both directions", () => {
    const perStageState = makeSeed({ rhythm: "unit-end" });
    const perStage = clone(perStageState.remote, "override-per-stage");
    expect(
      run(
        UNIT,
        ["claim", "alpha", "--team", "per-stage", "--rhythm", "per-stage"],
        perStage,
      ).status,
    ).toBe(0);
    expect(nextDirective(perStage)).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
      unit: "alpha",
    });
    expect(
      run(
        STATE,
        ["unit", "start", "--stage", "functional-design", "--unit", "alpha"],
        perStage,
      ).status,
    ).toBe(0);
    writeFunctionalArtifacts(perStage, "alpha");
    expect(
      run(
        STATE,
        ["unit", "complete", "--stage", "functional-design", "--unit", "alpha"],
        perStage,
      ).status,
    ).toBe(0);
    expect(nextDirective(perStage)).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
      unit: "alpha",
      unit_gate: "per-stage",
    });
    expect(
      JSON.parse(
        run(
          ORCH,
          [
            "report",
            "--stage",
            "functional-design",
            "--unit",
            "alpha",
            "--result",
            "awaiting-approval",
          ],
          perStage,
        ).stdout,
      ).kind,
    ).toBe("print");
    expect(
      JSON.parse(
        run(
          ORCH,
          [
            "report",
            "--stage",
            "functional-design",
            "--unit",
            "alpha",
            "--result",
            "approved",
            "--user-input",
            "Approve",
          ],
          perStage,
        ).stdout,
      ).kind,
    ).toBe("done");
    expect(nextDirective(perStage)).toMatchObject({
      kind: "run-stage",
      stage: "nfr-requirements",
      unit: "alpha",
    });

    const unitEndState = makeSeed({ rhythm: "per-stage" });
    const unitEnd = clone(unitEndState.remote, "override-unit-end");
    expect(
      run(
        UNIT,
        ["claim", "alpha", "--team", "unit-end", "--rhythm", "unit-end"],
        unitEnd,
      ).status,
    ).toBe(0);
    expect(nextDirective(unitEnd)).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
      unit: "alpha",
    });
    expect(
      run(
        STATE,
        ["unit", "start", "--stage", "functional-design", "--unit", "alpha"],
        unitEnd,
      ).status,
    ).toBe(0);
    writeFunctionalArtifacts(unitEnd, "alpha");
    expect(
      run(
        STATE,
        ["unit", "complete", "--stage", "functional-design", "--unit", "alpha"],
        unitEnd,
      ).status,
    ).toBe(0);
    expect(nextDirective(unitEnd)).toMatchObject({
      kind: "run-stage",
      stage: "nfr-requirements",
      unit: "alpha",
    });
    const earlyGate = run(
      ORCH,
      [
        "report",
        "--stage",
        "functional-design",
        "--unit",
        "alpha",
        "--result",
        "awaiting-approval",
      ],
      unitEnd,
    );
    expect(JSON.parse(earlyGate.stdout).kind).toBe("error");
    expect(earlyGate.stdout).toContain("must be reported against");
  }, 120000);

  test("remote CAS has one winner; release preserves history; safe re-claim works", async () => {
    const { seed, remote } = makeSeed();
    const alice = clone(remote, "alice");
    const bob = clone(remote, "bob");

    expect(nextDirective(seed)).toMatchObject({
      kind: "run-stage",
      unit: "skeleton",
    });

    const command = (cwd: string, team: string) =>
      Bun.spawn([
        process.execPath,
        UNIT,
        "claim",
        "alpha",
        "--team",
        team,
        "--project-dir",
        cwd,
      ], { cwd, stdout: "pipe", stderr: "pipe" });
    const contenders = [command(alice, "alice"), command(bob, "bob")];
    const outcomes = await Promise.all(
      contenders.map(async (proc) => ({
        code: await proc.exited,
        stdout: await new Response(proc.stdout).text(),
        stderr: await new Response(proc.stderr).text(),
      })),
    );
    expect(outcomes.filter((outcome) => outcome.code === 0)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.code !== 0)).toHaveLength(1);
    const winnerName = outcomes[0].code === 0 ? "alice" : "bob";
    const loser = outcomes.find((outcome) => outcome.code !== 0)!;
    expect(loser.stderr).toContain(winnerName);
    const winner = winnerName === "alice" ? alice : bob;
    const loserDir = winnerName === "alice" ? bob : alice;
    expect(exists(join(winner, "aidlc", ".aidlc-unit-scope.json"))).toBe(true);
    const recoveredClaim = run(
      UNIT,
      ["claim", "alpha", "--team", winnerName],
      winner,
    );
    expect(recoveredClaim.status, recoveredClaim.out).toBe(0);
    expect(JSON.parse(recoveredClaim.stdout).recovered).toBe(true);
    const participant = clone(remote, "participant");
    expect(run(UNIT, ["participate"], participant).status).toBe(0);
    expect(run(UTILITY, ["participate"], participant).status).toBe(0);
    const status = run(UNIT, ["status"], participant);
    expect(status.status, status.out).toBe(0);
    expect(JSON.parse(status.stdout).claimed).toContainEqual({
      unit: "alpha",
      owner: winnerName,
      generation: 1,
    });
    expect(nextDirective(participant)).toMatchObject({
      kind: "ask",
      ask_type: "unit-claim",
      claimable_units: ["gamma"],
      claimed_units: [{ unit: "alpha", holder: winnerName }],
      waiting_units: [{ unit: "beta", blocked_by: ["alpha"] }],
    });
    writeFileSync(
      seededStateFile(winner),
      readFileSync(seededStateFile(winner), "utf-8").replace(
        "- **Revision Count**: 0",
        "- **Revision Count**: 0\n- **Parked**: inherited\n- **Parked At Stage**: functional-design",
      ),
    );

    expect(nextDirective(winner)).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
      unit: "alpha",
    });
    expect(readFileSync(seededStateFile(winner), "utf-8")).toContain(
      "- **Current Stage**: functional-design",
    );
    const foreignStart = run(
      STATE,
      ["unit", "start", "--stage", "functional-design", "--unit", "beta"],
      winner,
    );
    expect(foreignStart.status).not.toBe(0);
    expect(foreignStart.out).toContain("scoped to Unit");
    const foreignReport = run(
      ORCH,
      [
        "report",
        "--stage",
        "functional-design",
        "--unit",
        "beta",
        "--result",
        "awaiting-approval",
      ],
      winner,
    );
    expect(JSON.parse(foreignReport.stdout).kind).toBe("error");
    const started = run(
      STATE,
      ["unit", "start", "--stage", "functional-design", "--unit", "alpha"],
      winner,
    );
    expect(started.status, started.out).toBe(0);
    expect(readAllAuditShards(winner)).toContain("**Attempt Generation**: 1");
    writeFunctionalArtifacts(winner, "alpha");
    const completed = run(
      STATE,
      ["unit", "complete", "--stage", "functional-design", "--unit", "alpha"],
      winner,
    );
    expect(completed.status, completed.out).toBe(0);
    const unitGate = nextDirective(winner);
    expect(unitGate).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
      unit: "alpha",
      unit_gate: "per-stage",
    });
    expect(
      JSON.parse(
        run(
          ORCH,
          [
            "report",
            "--stage",
            "functional-design",
            "--unit",
            "alpha",
            "--result",
            "awaiting-approval",
          ],
          winner,
        ).stdout,
      ).kind,
    ).toBe("print");
    expect(
      JSON.parse(
        run(
          ORCH,
          [
            "report",
            "--stage",
            "functional-design",
            "--unit",
            "alpha",
            "--result",
            "approved",
            "--user-input",
            "Approve",
          ],
          winner,
        ).stdout,
      ).kind,
    ).toBe("done");
    expect(nextDirective(winner)).toMatchObject({
      kind: "run-stage",
      stage: "nfr-requirements",
      unit: "alpha",
    });
    expect(readFileSync(seededStateFile(winner), "utf-8")).toContain(
      "- **Current Stage**: nfr-requirements",
    );

    fetchClaimRefs(seed);
    const notice = nextDirective(seed);
    expect(notice.kind).toBe("notice");
    expect(JSON.stringify(notice)).toContain(`alpha (${winnerName})`);
    writeFileSync(
      seededStateFile(seed),
      readFileSync(seededStateFile(seed), "utf-8").replace(
        "| alpha | - |",
        `| alpha | ${winnerName} |`,
      ),
    );

    const released = run(UTILITY, ["release", "alpha"], seed);
    expect(released.status, released.out).toBe(0);
    const releasedPayload = JSON.parse(released.stdout);
    expect(releasedPayload.generation).toBe(2);
    expect(readFileSync(seededStateFile(seed), "utf-8")).toContain(
      "| alpha | - |",
    );
    const retriedRelease = run(UNIT, ["release", "alpha"], seed);
    expect(retriedRelease.status, retriedRelease.out).toBe(0);
    expect(JSON.parse(retriedRelease.stdout).recovered).toBe(true);
    expect(
      git(seed, ["ls-remote", "origin", "refs/heads/claim/*/alpha"]),
    ).toContain("refs/heads/claim/");

    expect(
      eventMatchesClaimAttempt(
        seed,
        "**Event**: UNIT_COMPLETED\n**Unit**: alpha\n**Attempt Generation**: 1\n",
        "alpha",
      ),
    ).toBe(true);
    expect(
      run(WORKTREE, ["create", "--slug", "alpha", "--base", "main"], winner)
        .status,
    ).toBe(0);
    const staleFork = run(STATE, ["fork", "--slug", "alpha"], winner);
    expect(staleFork.status).not.toBe(0);
    expect(staleFork.out).toContain("stale or released");
    const stalePark = run(ORCH, ["park"], winner);
    expect(stalePark.status, stalePark.out).toBe(0);
    expect(JSON.parse(stalePark.stdout).kind).toBe("parked");
    expect(exists(join(winner, "aidlc", ".aidlc-unit-parked"))).toBe(true);
    rmSync(join(winner, "aidlc", ".aidlc-unit-parked"), { force: true });
    expect(nextDirective(winner).kind).not.toBe("error");

    const reclaimed = run(
      UNIT,
      ["claim", "alpha", "--team", "replacement"],
      loserDir,
    );
    expect(reclaimed.status, reclaimed.out).toBe(0);
    expect(JSON.parse(reclaimed.stdout).generation).toBe(2);
    const unsafeRetry = run(UNIT, ["release", "alpha"], seed);
    expect(unsafeRetry.status).not.toBe(0);
    expect(unsafeRetry.out).toContain("successor claim");
  }, 120000);

  test("claim recovery preserves its local stamp while the registry is transiently unavailable", () => {
    const { remote } = makeSeed();
    const checkout = clone(remote, "recovery-offline");
    const claimed = run(
      UNIT,
      ["claim", "alpha", "--team", "recovery-offline"],
      checkout,
    );
    expect(claimed.status, claimed.out).toBe(0);
    const stampPath = join(checkout, "aidlc", ".aidlc-unit-scope.json");
    const stampBefore = readFileSync(stampPath, "utf-8");

    git(checkout, [
      "remote",
      "set-url",
      "origin",
      join(checkout, "dead-remote"),
    ]);
    const offline = run(
      UNIT,
      ["claim", "alpha", "--team", "recovery-offline"],
      checkout,
    );
    expect(offline.status).not.toBe(0);
    expect(offline.out).toContain("claim registry read failed");
    expect(readFileSync(stampPath, "utf-8")).toBe(stampBefore);

    git(checkout, ["remote", "set-url", "origin", remote]);
    const recovered = run(
      UNIT,
      ["claim", "alpha", "--team", "recovery-offline"],
      checkout,
    );
    expect(recovered.status, recovered.out).toBe(0);
    expect(JSON.parse(recovered.stdout).recovered).toBe(true);
  }, 60000);

  test("release recovery journals are isolated by Unit and identity", () => {
    const { seed, remote } = makeSeed();
    const dependencyPath = join(
      seededRecordDir(seed),
      "inception",
      "units-generation",
      "unit-of-work-dependency.md",
    );
    writeFileSync(
      dependencyPath,
      readFileSync(dependencyPath, "utf-8").replace(
        "depends_on: [alpha]",
        "depends_on: [skeleton]",
      ),
    );
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "open parallel releases"]);
    git(seed, ["push", "origin", "main"]);

    const alpha = clone(remote, "release-alpha");
    const beta = clone(remote, "release-beta");
    expect(
      run(UNIT, ["claim", "alpha", "--team", "release-alpha"], alpha).status,
    ).toBe(0);
    expect(
      run(UNIT, ["claim", "beta", "--team", "release-beta"], beta).status,
    ).toBe(0);
    expect(run(UNIT, ["release", "alpha"], seed).status).toBe(0);
    const betaRelease = run(UNIT, ["release", "beta"], seed);
    expect(betaRelease.status, betaRelease.out).toBe(0);

    const intentUuid = activeIntentUuid(seed, "default")!;
    const alphaPath = unitReleasePendingPath(
      seed,
      "alpha",
      "default",
      intentUuid,
    );
    const betaPath = unitReleasePendingPath(
      seed,
      "beta",
      "default",
      intentUuid,
    );
    expect(alphaPath).not.toBe(betaPath);
    expect(readFileSync(alphaPath, "utf-8")).toContain('"unit": "alpha"');
    expect(readFileSync(betaPath, "utf-8")).toContain('"unit": "beta"');
    expect(
      unitReleasePendingPath(
        seed,
        "alpha",
        "other-space",
        "00000000-0000-7000-8000-000000000099",
      ),
    ).not.toBe(alphaPath);
  }, 120000);

  test("partial clones explicitly hydrate claim payload blobs with lazy fetch disabled", () => {
    const { remote } = makeSeed();
    const owner = clone(remote, "payload-owner");
    const partial = partialClone(remote, "payload-partial");
    const claimed = run(
      UNIT,
      ["claim", "alpha", "--team", "payload-owner"],
      owner,
    );
    expect(claimed.status, claimed.out).toBe(0);

    const released = run(
      UNIT,
      ["release", "alpha"],
      partial,
      { GIT_NO_LAZY_FETCH: "1" },
    );
    expect(released.status, released.out).toBe(0);
    expect(released.out).not.toContain("payload is invalid");
    expect(released.out).not.toContain("missing the claim payload blob");

    const reclaimed = run(
      UNIT,
      ["claim", "alpha", "--team", "payload-partial"],
      partial,
      { GIT_NO_LAZY_FETCH: "1" },
    );
    expect(reclaimed.status, reclaimed.out).toBe(0);
    writeFileSync(join(partial, "partial-candidate.txt"), "candidate\n");
    git(partial, ["add", "partial-candidate.txt"]);
    git(partial, ["commit", "-m", "partial candidate"]);
    const published = run(
      UNIT,
      ["publish", "alpha"],
      partial,
      { GIT_NO_LAZY_FETCH: "1" },
    );
    expect(published.status, published.out).toBe(0);
    expect(published.out).not.toContain("payload is invalid");
  }, 15000);

  test("release refuses completed rows and claim metadata is ref/table safe", () => {
    const unsafe = makeSeed();
    const unsafeClone = clone(unsafe.remote, "unsafe");
    const badRef = run(
      UNIT,
      ["claim", "a..b", "--team", "unsafe"],
      unsafeClone,
    );
    expect(badRef.status).not.toBe(0);
    expect(badRef.out).toContain("claim-ref safe");
    const badOwner = run(
      UNIT,
      ["claim", "alpha", "--team", "bad|owner"],
      unsafeClone,
    );
    expect(badOwner.status).not.toBe(0);
    expect(badOwner.out).toContain("pipes or newlines");

    const headerName = makeSeed();
    writeFileSync(
      seededStateFile(headerName.seed),
      readFileSync(seededStateFile(headerName.seed), "utf-8").replace(
        "| alpha | - |",
        "| unit | - |",
      ),
    );
    const dependencyPath = join(
      seededRecordDir(headerName.seed),
      "inception",
      "units-generation",
      "unit-of-work-dependency.md",
    );
    writeFileSync(
      dependencyPath,
      readFileSync(dependencyPath, "utf-8")
        .replace("name: alpha", "name: unit")
        .replace("depends_on: [alpha]", "depends_on: [unit]"),
    );
    git(headerName.seed, ["add", "-A"]);
    git(headerName.seed, ["commit", "-m", "unit header collision"]);
    git(headerName.seed, ["push", "origin", "main"]);
    const headerClone = clone(headerName.remote, "unit-header");
    const headerClaim = run(
      UNIT,
      ["claim", "unit", "--team", "header"],
      headerClone,
    );
    expect(headerClaim.status, headerClaim.out).toBe(0);

    const completed = makeSeed();
    const claimant = clone(completed.remote, "completed");
    const claimed = run(
      UNIT,
      ["claim", "alpha", "--team", "completed"],
      claimant,
    );
    expect(claimed.status, claimed.out).toBe(0);
    writeFileSync(
      seededStateFile(completed.seed),
      readFileSync(seededStateFile(completed.seed), "utf-8").replace(
        "| alpha | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |",
        "| alpha | completed | [x] | [x] | [x] | [x] | [x] | [x] |",
      ),
    );
    git(completed.seed, ["add", seededStateFile(completed.seed)]);
    git(completed.seed, ["commit", "-m", "complete alpha"]);
    git(completed.seed, ["push", "origin", "main"]);
    const refused = run(UNIT, ["release", "alpha"], completed.seed);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("already complete/merged");
  }, 120000);

  test("unreadable local claim refs stop routing instead of falling through", () => {
    const { seed, remote } = makeSeed();
    const claimant = clone(remote, "corrupt-local");
    const claim = run(
      UNIT,
      ["claim", "alpha", "--team", "corrupt-local"],
      claimant,
    );
    expect(claim.status, claim.out).toBe(0);
    const payload = JSON.parse(claim.stdout);
    const localRef = `refs/remotes/origin/claim/${payload.intent_id8}/alpha`;
    git(seed, ["update-ref", localRef, "HEAD"]);
    const directive = nextDirective(seed, { AIDLC_STOP_HOOK_PROBE: "1" });
    expect(directive.kind).toBe("notice");
    expect(JSON.stringify(directive)).toContain(
      "could not compose its local board",
    );
    expect(JSON.stringify(directive)).toContain(
      "claim registry payload is unavailable or invalid",
    );
    expect(JSON.stringify(directive)).not.toContain('"kind":"run-stage"');
  });

  test("scoped park remains checkout-local and still honors autonomous refusal", () => {
    const { remote } = makeSeed();
    const checkout = clone(remote, "park");
    expect(run(UNIT, ["claim", "alpha", "--team", "park"], checkout).status).toBe(0);
    const stateBefore = readFileSync(seededStateFile(checkout), "utf-8");
    const parked = run(ORCH, ["park"], checkout);
    expect(parked.status, parked.out).toBe(0);
    expect(JSON.parse(parked.stdout).kind).toBe("parked");
    expect(readFileSync(seededStateFile(checkout), "utf-8")).toBe(stateBefore);
    expect(exists(join(checkout, "aidlc", ".aidlc-unit-parked"))).toBe(true);
    rmSync(join(checkout, "aidlc", ".aidlc-unit-parked"), { force: true });
    writeFileSync(
      seededStateFile(checkout),
      stateBefore.replace(
        "- **Revision Count**: 0",
        "- **Revision Count**: 0\n- **Construction Autonomy Mode**: autonomous",
      ),
    );
    const refused = run(ORCH, ["park"], checkout);
    expect(refused.status, refused.out).toBe(0);
    expect(JSON.parse(refused.stdout).kind).toBe("error");
    expect(refused.stdout).toContain("autonomous");
  });

  test("no-remote sibling worktree claim uses the shared local ref namespace", () => {
    const { seed } = makeSeed();
    git(seed, ["remote", "remove", "origin"]);
    const sibling = join(dirname(seed), `${seed.split("/").at(-1)}-unit-wt`);
    git(seed, ["worktree", "add", sibling, "-b", "unit-work", "main"]);
    tempDirs.push(sibling);
    const claim = run(
      UTILITY,
      ["claim", "alpha", "--team", "local"],
      sibling,
    );
    expect(claim.status, claim.out).toBe(0);
    const claimResult = JSON.parse(claim.stdout);
    expect(
      git(seed, [
        "show-ref",
        `refs/heads/claim/${claimResult.intent_id8}/alpha`,
      ]),
    ).toContain("refs/heads/claim/");
  }, 60000);

  test("team fork primitives bind to the live claimed Unit and mint a fresh worktree clone id", () => {
    const { remote } = makeSeed();
    const checkout = clone(remote, "fork-team");
    const claim = run(UNIT, ["claim", "alpha", "--team", "fork-team"], checkout);
    expect(claim.status, claim.out).toBe(0);
    const scopedRelease = run(UNIT, ["release", "alpha"], checkout);
    expect(scopedRelease.status).not.toBe(0);
    expect(scopedRelease.out).toContain("unscoped checkout");

    const slugless = run(
      BOLT,
      ["start", "--name", "Alpha", "--batch", "1"],
      checkout,
    );
    expect(slugless.status, slugless.out).toBe(0);
    expect(readAllAuditShards(checkout)).toContain("**Attempt Generation**: 1");
    expect(readAllAuditShards(checkout)).toContain("**Bolt slug**: alpha");

    expect(
      run(WORKTREE, ["create", "--slug", "beta", "--base", "main"], checkout)
        .status,
    ).toBe(0);
    for (const direct of [
      run(STATE, ["fork", "--slug", "beta"], checkout),
      run(AUDIT, ["audit-fork", "--slug", "beta"], checkout),
      run(RUNTIME, ["fragment-fork", "--slug", "beta"], checkout),
    ]) {
      expect(direct.status).not.toBe(0);
      expect(direct.out).toContain("scoped to Unit");
    }

    const foreign = run(
      BOLT,
      [
        "start",
        "--name",
        "beta",
        "--batch",
        "1",
        "--worktree",
        "--slug",
        "beta",
      ],
      checkout,
    );
    expect(foreign.status).not.toBe(0);
    expect(foreign.out).toContain("scoped to Unit");
    expect(foreign.out).toContain("alpha");

    expect(
      run(AUDIT, [
        "append",
        "HEALTH_CHECKED",
        "--field",
        "Details=claim fixture",
      ], checkout).status,
    ).toBe(0);
    const created = run(
      WORKTREE,
      ["create", "--slug", "alpha", "--base", "main"],
      checkout,
    );
    expect(created.status, created.out).toBe(0);
    const stateFork = run(STATE, ["fork", "--slug", "alpha"], checkout);
    expect(stateFork.status, stateFork.out).toBe(0);
    expect(
      run(AUDIT, ["audit-fork", "--slug", "alpha"], checkout).status,
    ).toBe(0);
    expect(
      run(RUNTIME, ["fragment-fork", "--slug", "alpha"], checkout).status,
    ).toBe(0);
    const wt = join(checkout, ".aidlc", "worktrees", "bolt-alpha");
    const mainCloneId = readFileSync(
      join(checkout, "aidlc", ".aidlc-clone-id"),
      "utf-8",
    );
    const worktreeCloneId = readFileSync(
      join(wt, "aidlc", ".aidlc-clone-id"),
      "utf-8",
    );
    expect(worktreeCloneId).not.toBe(mainCloneId);
    const retriedFork = run(AUDIT, ["audit-fork", "--slug", "alpha"], checkout);
    expect(retriedFork.status, retriedFork.out).toBe(0);
    expect(
      readFileSync(join(wt, "aidlc", ".aidlc-clone-id"), "utf-8"),
    ).toBe(worktreeCloneId);
    const workerEvent = run(AUDIT, [
      "append",
      "HEALTH_CHECKED",
      "--field",
      "Details=claimed worktree delta",
    ], wt);
    expect(workerEvent.status, workerEvent.out).toBe(0);
    const mergedAudit = run(AUDIT, ["audit-merge", "--slug", "alpha"], checkout);
    expect(mergedAudit.status, mergedAudit.out).toBe(0);
    const mergedLedger = readAllAuditShards(checkout);
    expect(mergedLedger).toContain("claimed worktree delta");
    expect(mergedLedger.match(/Details\*\*: claim fixture/g) ?? []).toHaveLength(1);

    const facilitator = clone(remote, "fork-facilitator");
    const released = run(UNIT, ["release", "alpha"], facilitator);
    expect(released.status, released.out).toBe(0);
    const staleMerge = run(
      BOLT,
      [
        "complete",
        "--name",
        "alpha",
        "--batch",
        "1",
        "--merge",
        "--slug",
        "alpha",
      ],
      checkout,
    );
    expect(staleMerge.status).not.toBe(0);
    expect(staleMerge.out).toContain("stale or released");
  }, 60000);

  test("walking-skeleton bypass is main-only and bound to the first DAG Unit", () => {
    const { seed } = makeSeed({ skeletonComplete: false });
    const wrong = run(
      BOLT,
      [
        "start",
        "--name",
        "beta",
        "--batch",
        "1",
        "--walking-skeleton",
        "true",
      ],
      seed,
    );
    expect(wrong.status).not.toBe(0);
    expect(wrong.out).toContain("first DAG Unit");

    const valid = run(
      BOLT,
      [
        "start",
        "--name",
        "skeleton",
        "--batch",
        "1",
        "--walking-skeleton",
        "true",
      ],
      seed,
    );
    expect(valid.status, valid.out).toBe(0);
  });

  test("direct audit fork and merge use the same claimed shard authority", () => {
    const { remote } = makeSeed();
    const checkout = clone(remote, "audit-direct");
    expect(run(UNIT, ["claim", "alpha", "--team", "audit-direct"], checkout).status).toBe(0);
    expect(
      run(AUDIT, [
        "append",
        "HEALTH_CHECKED",
        "--field",
        "Details=direct audit fixture",
      ], checkout).status,
    ).toBe(0);
    expect(
      run(WORKTREE, ["create", "--slug", "alpha", "--base", "main"], checkout)
        .status,
    ).toBe(0);
    const fork = run(AUDIT, ["audit-fork", "--slug", "alpha"], checkout);
    expect(fork.status, fork.out).toBe(0);
    const wt = join(checkout, ".aidlc", "worktrees", "bolt-alpha");
    expect(
      run(AUDIT, [
        "append",
        "HEALTH_CHECKED",
        "--field",
        "Details=direct audit delta",
      ], wt).status,
    ).toBe(0);
    const merge = run(AUDIT, ["audit-merge", "--slug", "alpha"], checkout);
    expect(merge.status, merge.out).toBe(0);
    expect(readAllAuditShards(checkout)).toContain("direct audit delta");
  }, 60000);
});

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
