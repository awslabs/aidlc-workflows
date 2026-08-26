// covers: subcommand:aidlc-orchestrate:team-board, function:buildTeamConstructionBoard, function:buildTeamConstructionBoardForIntent, function:renderTeamConstructionBoard, function:localUnitClaimOverviewForIntent, function:unitMergeTransactionsForIdentity, function:CLAIM_ACTIVITY_STALE_HOURS

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  activeIntentUuid,
  idSuffix,
  setActiveIntentCursor,
  unitDependencyPath,
  unitMergeTransactionPath,
  writeUnitClaimRegistryCache,
  writeUnitMergeTransaction,
  writeUnitScopeStamp,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  buildTeamConstructionBoard,
  buildTeamConstructionBoardForIntent,
  renderTeamConstructionBoard,
} from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    cleanupTestProject(tempDirs.pop()!);
  }
});

function run(
  tool: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): { status: number; stdout: string; out: string } {
  const result = spawnSync(
    process.execPath,
    [tool, ...args, "--project-dir", cwd],
    {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, ...env },
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function nextDirective(
  project: string,
  env: Record<string, string> = {},
  nextArgs: string[] = [],
): Record<string, unknown> {
  let result = run(ORCH, ["next", ...nextArgs], project, env);
  expect(result.status, result.out).toBe(0);
  let directive = JSON.parse(result.stdout) as Record<string, unknown>;
  while (
    directive.kind === "load-steering" &&
    typeof directive.continue_token === "string"
  ) {
    result = run(
      ORCH,
      ["continue", directive.continue_token],
      project,
      env,
    );
    expect(result.status, result.out).toBe(0);
    directive = JSON.parse(result.stdout) as Record<string, unknown>;
  }
  return directive;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return (result.stdout ?? "").trim();
}

function teamState(): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: dispatcher fixture
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Unit Ownership**: team
- **Unit Gate Rhythm**: per-stage
- **Review Override**: none
- **Skeleton Stance**: on

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
| unit | owner | functional-design | nfr-requirements | nfr-design | infrastructure-design | code-generation | gate | merged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| merged | main | [x] | [x] | [x] | [x] | [x] | [x] | [x] |
| awaiting | awaiting-team | [x] | [x] | [x] | [x] | [x] | [x] | [ ] |
| claimed | claimed-team | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| claimable | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| blocked | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Active Agent**: aidlc-architect-agent
- **Last Completed Stage**: delivery-planning
- **Next Stage**: nfr-requirements
`;
}

function dependencyBody(): string {
  return `# Unit dependencies

\`\`\`yaml
units:
  - name: merged
    depends_on: []
  - name: awaiting
    depends_on: [merged]
  - name: claimed
    depends_on: [merged]
  - name: claimable
    depends_on: [merged]
  - name: blocked
    depends_on: [awaiting]
\`\`\`
`;
}

function seedGit(projectDir: string): void {
  git(projectDir, ["init", "-b", "main"]);
  git(projectDir, ["config", "user.name", "dispatcher"]);
  git(projectDir, ["config", "user.email", "dispatcher@example.test"]);
  git(projectDir, ["add", "-A"]);
  git(projectDir, ["commit", "-m", "seed"]);
}

function boardFixture(): { project: string; intentUuid: string } {
  const project = createTestProject();
  tempDirs.push(project);
  seedAidlcMemory(project);
  writeFileSync(seededStateFile(project), teamState());
  const dependencyPath = unitDependencyPath(project);
  mkdirSync(join(dependencyPath, ".."), { recursive: true });
  writeFileSync(dependencyPath, dependencyBody());
  mkdirSync(seededAuditDir(project), { recursive: true });
  writeFileSync(
    join(seededAuditDir(project), "merged.md"),
    `## Unit Merged
**Timestamp**: 2026-08-20T11:00:00Z
**Event**: UNIT_MERGED
**Unit**: merged
**Owner**: main
**Pinned OID**: ${"1".repeat(40)}
**Merge commit OID**: ${"2".repeat(40)}
**Attempt Generation**: 1

---
`,
  );
  seedGit(project);
  const intentUuid = activeIntentUuid(project, "default")!;
  const intentId8 = idSuffix(intentUuid);
  writeUnitClaimRegistryCache(project, {
    version: 1,
    space: "default",
    intent_uuid: intentUuid,
    claims: {
      awaiting: {
        status: "claimed",
        owner: "awaiting-team",
        generation: 1,
        nonce: "awaiting-nonce",
        ref: `refs/heads/claim/${intentId8}/awaiting`,
        oid: "a".repeat(40),
        observed_at: "2026-08-19T12:00:00Z",
      },
      claimed: {
        status: "claimed",
        owner: "claimed-team",
        generation: 2,
        nonce: "claimed-nonce",
        ref: `refs/heads/claim/${intentId8}/claimed`,
        oid: "b".repeat(40),
        observed_at: "2026-08-20T12:00:00Z",
      },
    },
  });
  writeUnitMergeTransaction(project, {
    version: 1,
    status: "pinned",
    space: "default",
    intent_uuid: intentUuid,
    intent_id8: intentId8,
    unit: "awaiting",
    owner: "awaiting-team",
    generation: 1,
    nonce: "awaiting-nonce",
    claim_ref: `refs/heads/claim/${intentId8}/awaiting`,
    pinned_oid: "c".repeat(40),
    candidate_tree_oid: "d".repeat(40),
    candidate_base_oid: "e".repeat(40),
    integration_oid: "f".repeat(40),
    integration_branch: "main",
    main_before_oid: "1".repeat(40),
    pinned_at: "2026-08-20T12:30:00Z",
    evidence: {
      stages_expected: [
        "functional-design",
        "nfr-requirements",
        "nfr-design",
        "infrastructure-design",
        "code-generation",
      ],
      stages_completed: [],
      gates_expected: [],
      gates_approved: [],
      reviewers_expected: [],
      reviewers_ready: [],
      plan_fingerprint: null,
      artifact_paths: [],
      audit_shards: [],
      outside_unit_record_paths: [],
      merge_held: false,
    },
  });
  return { project, intentUuid };
}

function snapshotFiles(project: string): Record<string, string> {
  const roots = [
    seededStateFile(project),
    join(project, "aidlc", ".aidlc-claim-registry.json"),
    join(project, "aidlc", ".aidlc-claim-generations.json"),
    join(project, "aidlc", ".aidlc-unit-scope.json"),
    seededAuditDir(project),
    join(project, "aidlc", ".aidlc-unit-merges"),
  ];
  const snapshot: Record<string, string> = {};
  const visit = (path: string): void => {
    if (!existsSync(path)) {
      snapshot[path] = "<missing>";
      return;
    }
    if (statSync(path).isDirectory()) {
      snapshot[path] = "<directory>";
      for (const entry of readdirSync(path).sort()) {
        visit(join(path, entry));
      }
      return;
    }
    snapshot[path] = readFileSync(path, "utf-8");
  };
  for (const root of roots) visit(root);
  return snapshot;
}

function writeIntent(
  project: string,
  dirName: string,
  body: string,
  dependency?: string,
  space = "default",
): void {
  const record = join(
    project,
    "aidlc",
    "spaces",
    space,
    "intents",
    dirName,
  );
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "aidlc-state.md"), body);
  if (dependency) {
    const path = join(
      record,
      "inception",
      "units-generation",
      "unit-of-work-dependency.md",
    );
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, dependency);
  }
}

function pickerFixture(teamMode: boolean, count: 1 | 3): string {
  const project = createTestProject();
  tempDirs.push(project);
  seedAidlcMemory(project);
  const intentsRoot = join(
    project,
    "aidlc",
    "spaces",
    "default",
    "intents",
  );
  rmSync(intentsRoot, { recursive: true, force: true });
  mkdirSync(intentsRoot, { recursive: true });
  const rows = [
    {
      uuid: "00000000-0000-0000-0000-000011111111",
      slug: "team-work",
      dirName: "team-work-11111111",
      scope: "feature",
      status: "active",
    },
  ];
  writeIntent(
    project,
    "team-work-11111111",
    teamMode
      ? teamState().replace(
        "- **Scope**: feature",
        "- **Scope**: bugfix",
      ).replace(
        /\| (merged|awaiting|claimed|claimable|blocked) \|.*\n/g,
        "",
      ).replace(
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ).replace(
        "| unit | owner | functional-design | nfr-requirements | nfr-design | infrastructure-design | code-generation | gate | merged |",
        "| unit | owner | functional-design | nfr-requirements | nfr-design | infrastructure-design | code-generation | gate |",
      ).replace(
        "## Current Status",
        "| alpha | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |\n" +
          "| beta | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |\n\n" +
          "## Current Status",
      )
      : teamState().replace(
        "- **Unit Ownership**: team",
        "- **Unit Ownership**: solo",
      ),
    teamMode
      ? `# Units\n\n\`\`\`yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n\`\`\`\n`
      : undefined,
  );
  if (count === 3) {
    rows.push(
      {
        uuid: "00000000-0000-0000-0000-000022222222",
        slug: "parked-work",
        dirName: "parked-work-22222222",
        scope: "feature",
        status: "active",
      },
      {
        uuid: "00000000-0000-0000-0000-000033333333",
        slug: "done-work",
        dirName: "done-work-33333333",
        scope: "feature",
        status: "complete",
      },
    );
    writeIntent(
      project,
      "parked-work-22222222",
      teamState()
        .replace("- **Unit Ownership**: team", "- **Unit Ownership**: solo")
        .replace(
          "- **Unit Gate Rhythm**: per-stage",
          "- **Unit Gate Rhythm**: per-stage\n- **Parked**: 2026-08-20T12:00:00Z\n- **Parked At Stage**: code-generation",
        )
        .replace(
          "- **Current Stage**: functional-design",
          "- **Current Stage**: code-generation",
        ),
    );
    writeIntent(
      project,
      "done-work-33333333",
      teamState()
        .replace("- **Unit Ownership**: team", "- **Unit Ownership**: solo")
        .replace("- **Status**: Running", "- **Status**: Completed"),
    );
  }
  writeFileSync(
    join(intentsRoot, "intents.json"),
    `${JSON.stringify(rows, null, 2)}\n`,
  );
  return project;
}

function selectorFixture(): {
  project: string;
  space: string;
  intentDir: string;
  intentUuid: string;
  state: string;
  dependency: string;
} {
  const { project } = boardFixture();
  const space = "secondary";
  const intentDir = "secondary-work-55555555";
  const intentUuid = "00000000-0000-0000-0000-000055555555";
  const state = teamState()
    .replace("- **Project**: dispatcher fixture", "- **Project**: secondary fixture")
    .replace(
      /^## Unit Progress[\s\S]*?(?=^## Current Status)/m,
      "",
    );
  const dependency = `# Unit dependencies

\`\`\`yaml
units:
  - name: secondary-alpha
    depends_on: []
  - name: secondary-beta
    depends_on: [secondary-alpha]
\`\`\`
`;
  writeIntent(project, intentDir, state, dependency, space);
  const intentsRoot = join(project, "aidlc", "spaces", space, "intents");
  writeFileSync(
    join(intentsRoot, "intents.json"),
    `${JSON.stringify([
      {
        uuid: intentUuid,
        slug: "secondary-work",
        dirName: intentDir,
        scope: "feature",
        status: "active",
      },
    ], null, 2)}\n`,
  );
  setActiveIntentCursor(project, intentDir, space);
  writeUnitMergeTransaction(project, {
    version: 1,
    status: "pinned",
    space,
    intent_uuid: intentUuid,
    intent_id8: idSuffix(intentUuid),
    unit: "secondary-alpha",
    owner: "secondary-team",
    generation: 3,
    nonce: "secondary-nonce",
    claim_ref:
      `refs/heads/claim/${idSuffix(intentUuid)}/secondary-alpha`,
    pinned_oid: "2".repeat(40),
    candidate_tree_oid: "3".repeat(40),
    candidate_base_oid: "4".repeat(40),
    integration_oid: "5".repeat(40),
    integration_branch: "main",
    main_before_oid: "6".repeat(40),
    pinned_at: "2026-08-21T00:00:00Z",
    evidence: {
      stages_expected: [],
      stages_completed: [],
      gates_expected: [],
      gates_approved: [],
      reviewers_expected: [],
      reviewers_ready: [],
      plan_fingerprint: null,
      artifact_paths: [],
      audit_shards: [],
      outside_unit_record_paths: [],
      merge_held: false,
    },
  });
  return { project, space, intentDir, intentUuid, state, dependency };
}

describe("t327 team construction dispatcher", () => {
  test("full status board renders claim, merge, claimable, blocked, and merged states and is turn-terminal", () => {
    const { project } = boardFixture();
    const state = readFileSync(seededStateFile(project), "utf-8");
    const board = buildTeamConstructionBoard(project, state, {
      readOnly: true,
    });
    const rendered = renderTeamConstructionBoard(board, "dispatcher");
    const mergedRow = rendered
      .split(/\r?\n/)
      .find((line) => line.startsWith("| merged |"))!;
    expect(mergedRow).toContain("| merged | main | [ ] |");
    expect(mergedRow).toEndWith("| [ ] | [x] |");
    expect(rendered).toContain("| awaiting | claimed | awaiting-team | 1 |");
    expect(rendered).toContain("pinned and ready for merge gate");
    expect(rendered).toContain("- claimable");
    expect(rendered).toContain("| blocked | awaiting |");
    expect(rendered).toContain("last observed ref movement 2026-08-19T12:00:00Z");
    expect(rendered).toContain("`/aidlc --claim claimable`");
    expect(rendered).toContain("`aidlc unit gate awaiting`");

    const actual = run(ORCH, ["next"], project);
    expect(actual.status, actual.out).toBe(0);
    const directive = JSON.parse(actual.stdout);
    expect(directive.kind).toBe("notice");
    expect(directive.message).toContain("# Team Construction Dispatcher");
    const beforeProbe = snapshotFiles(project);
    const probe = run(
      ORCH,
      ["next"],
      project,
      { AIDLC_STOP_HOOK_PROBE: "1" },
    );
    expect(probe.status, probe.out).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual(directive);
    expect(snapshotFiles(project)).toEqual(beforeProbe);

    writeFileSync(
      seededStateFile(project),
      readFileSync(seededStateFile(project), "utf-8").replace(
        /^\| (awaiting|claimed|claimable|blocked) \|.*$/gm,
        (line) => {
          const cells = line
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim());
          return `| ${cells[0]} | ${cells[1]} | [x] | [x] | [x] | [x] | [x] | [x] | [x] |`;
        },
      ),
    );
    const transactionPath = unitMergeTransactionPath(project, "awaiting");
    const transaction = JSON.parse(readFileSync(transactionPath, "utf-8"));
    transaction.status = "state-folded";
    writeFileSync(
      transactionPath,
      `${JSON.stringify(transaction, null, 2)}\n`,
    );
    const pendingAudit = nextDirective(project);
    expect(pendingAudit.kind).toBe("notice");
    expect(pendingAudit.message as string).toContain(
      "state folded; audit finalization pending",
    );
    expect(pendingAudit.message as string).toContain(
      "`aidlc unit land awaiting`",
    );
  });

  test("participants with no claimable Unit receive the board, while released-only history resumes main", () => {
    const participant = boardFixture();
    writeFileSync(
      unitDependencyPath(participant.project),
      dependencyBody()
        .replace(
          "  - name: claimable\n    depends_on: [merged]",
          "  - name: claimable\n    depends_on: [awaiting]",
        ),
    );
    writeFileSync(
      join(participant.project, "aidlc", ".aidlc-unit-participant"),
      "participant\n",
    );
    const participantDirective = nextDirective(participant.project);
    expect(participantDirective.kind).toBe("notice");
    expect(participantDirective.message as string).toContain(
      "claimed (claimed-team)",
    );
    expect(participantDirective.message as string).toContain(
      "claimable waits on awaiting",
    );

    const released = boardFixture();
    rmSync(join(released.project, "aidlc", ".aidlc-unit-merges"), {
      recursive: true,
      force: true,
    });
    const cachePath = join(
      released.project,
      "aidlc",
      ".aidlc-claim-registry.json",
    );
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    for (const claim of Object.values(cache.claims) as Array<
      Record<string, unknown>
    >) {
      claim.status = "released";
    }
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    const resumed = nextDirective(released.project);
    expect(resumed.kind).not.toBe("notice");
    expect(resumed.kind).toBe("run-stage");
    const snapshot = run(
      ORCH,
      ["team-board", "--snapshot"],
      released.project,
    );
    expect(snapshot.status, snapshot.out).toBe(0);
    expect(snapshot.stdout).toContain("| awaiting | released |");
    expect(snapshot.stdout).toContain("`/aidlc --claim awaiting`");

    const race = boardFixture();
    const raceCachePath = join(
      race.project,
      "aidlc",
      ".aidlc-claim-registry.json",
    );
    const raceCache = JSON.parse(readFileSync(raceCachePath, "utf-8"));
    raceCache.claims.awaiting.status = "released";
    raceCache.claims.awaiting.generation = 2;
    writeFileSync(
      raceCachePath,
      `${JSON.stringify(raceCache, null, 2)}\n`,
    );
    const raceTransactionPath = unitMergeTransactionPath(
      race.project,
      "awaiting",
    );
    const raceTransaction = JSON.parse(
      readFileSync(raceTransactionPath, "utf-8"),
    );
    raceTransaction.status = "git-landed";
    raceTransaction.git_commit_oid = "7".repeat(40);
    writeFileSync(
      raceTransactionPath,
      `${JSON.stringify(raceTransaction, null, 2)}\n`,
    );
    const recoveryBoard = nextDirective(race.project);
    expect(recoveryBoard.kind).toBe("notice");
    expect(recoveryBoard.message as string).toContain(
      'aidlc unit land awaiting --accept-released-attempt --user-input "<human acknowledgment>"',
    );
  });

  test("--status appends the same read-only board in unscoped and scoped checkouts", () => {
    const { project, intentUuid } = boardFixture();
    const before = snapshotFiles(project);
    const unscoped = run(UTILITY, ["status"], project);
    expect(unscoped.status, unscoped.out).toBe(0);
    expect(unscoped.stdout).toContain("# Team Construction Snapshot");
    expect(snapshotFiles(project)).toEqual(before);

    const targeted = run(
      UTILITY,
      [
        "status",
        "--intent",
        basename(seededRecordDir(project)),
        "--space",
        "default",
      ],
      project,
    );
    expect(targeted.status, targeted.out).toBe(0);
    expect(targeted.stdout).toBe(unscoped.stdout);

    const scopedDir = join(project, ".worktrees", "claimed");
    mkdirSync(join(project, ".worktrees"), { recursive: true });
    git(project, ["worktree", "add", scopedDir, "-b", "scoped-claimed"]);
    writeUnitScopeStamp(scopedDir, {
      version: 1,
      space: "default",
      intent_uuid: intentUuid,
      intent_id8: idSuffix(intentUuid),
      unit: "claimed",
      owner: "claimed-team",
      generation: 2,
      nonce: "claimed-nonce",
      claim_ref: `refs/heads/claim/${idSuffix(intentUuid)}/claimed`,
      claim_oid: "b".repeat(40),
      claimed_from_oid: "f".repeat(40),
      integration_ref: "refs/heads/main",
      gate_rhythm: "per-stage",
    });
    const scopedBefore = snapshotFiles(project);
    const scopedCheckoutBefore = snapshotFiles(scopedDir);
    const scoped = run(UTILITY, ["status"], scopedDir);
    expect(scoped.status, scoped.out).toBe(0);
    expect(scoped.stdout).toBe(unscoped.stdout);
    expect(snapshotFiles(project)).toEqual(scopedBefore);
    expect(snapshotFiles(scopedDir)).toEqual(scopedCheckoutBefore);

    const routed = run(
      DISPATCHER,
      ["team-board", "--snapshot"],
      project,
    );
    expect(routed.status, routed.out).toBe(0);
    expect(routed.stdout).toContain("# Team Construction Snapshot");
  });

  test("explicit space and intent selectors stay on the selected identity and derive a fresh grid", () => {
    const fixture = selectorFixture();
    const before = snapshotFiles(fixture.project);
    const directBoard = buildTeamConstructionBoardForIntent(
      fixture.project,
      fixture.state,
      {
        space: fixture.space,
        intentUuid: fixture.intentUuid,
        dependencyBody: fixture.dependency,
      },
    );
    const expected = `${renderTeamConstructionBoard(directBoard, "snapshot")}\n`;
    expect(expected).toContain("| secondary-alpha | secondary-team |");
    expect(expected).toContain("secondary-beta waits on secondary-alpha");
    expect(expected).toContain("`aidlc unit gate secondary-alpha`");
    expect(expected).not.toContain("awaiting-team");

    const bySpace = run(
      ORCH,
      ["team-board", "--space", fixture.space, "--snapshot"],
      fixture.project,
    );
    expect(bySpace.status, bySpace.out).toBe(0);
    expect(bySpace.stdout).toBe(expected);

    const byIntent = run(
      ORCH,
      [
        "team-board",
        "--space",
        fixture.space,
        "--intent",
        fixture.intentDir,
        "--snapshot",
      ],
      fixture.project,
    );
    expect(byIntent.status, byIntent.out).toBe(0);
    expect(byIntent.stdout).toBe(expected);

    const statusBySpace = run(
      UTILITY,
      ["status", "--space", fixture.space],
      fixture.project,
    );
    const statusByIntent = run(
      UTILITY,
      [
        "status",
        "--space",
        fixture.space,
        "--intent",
        fixture.intentDir,
      ],
      fixture.project,
    );
    expect(statusBySpace.status, statusBySpace.out).toBe(0);
    expect(statusByIntent.status, statusByIntent.out).toBe(0);
    expect(statusBySpace.stdout).toBe(statusByIntent.stdout);
    expect(statusBySpace.stdout).toContain(expected.trimEnd());
    expect(snapshotFiles(fixture.project)).toEqual(before);

    const missingIntent = run(
      ORCH,
      ["team-board", "--intent", "--snapshot"],
      fixture.project,
    );
    expect(missingIntent.status).not.toBe(0);
    expect(missingIntent.out).toContain(
      "team-board --intent requires a value",
    );
    const missingSpace = run(
      ORCH,
      ["team-board", "--space", "--intent", fixture.intentDir],
      fixture.project,
    );
    expect(missingSpace.status).not.toBe(0);
    expect(missingSpace.out).toContain(
      "team-board --space requires a value",
    );
  });

  test("multi-intent picker annotates team, parked, and complete while dormant paths stay byte-identical", () => {
    const team = pickerFixture(true, 3);
    const teamPicker = nextDirective(team, {}, ["--scope", "feature"]);
    expect(teamPicker).toMatchObject({ kind: "ask" });
    const question = teamPicker.question as string;
    expect(question).toContain("`team-work` (team construction, 2 units claimable)");
    expect(question).toContain("`parked-work` (parked at code-generation)");
    expect(question).toContain("`done-work` (complete)");

    const parkedPath = join(
      team,
      "aidlc",
      "spaces",
      "default",
      "intents",
      "parked-work-22222222",
      "aidlc-state.md",
    );
    const validParked = readFileSync(parkedPath, "utf-8");
    writeFileSync(
      parkedPath,
      validParked.replace(/^- \*\*Parked\*\*:.*\n/m, ""),
    );
    const markerMissing = nextDirective(team, {}, ["--scope", "feature"]);
    expect(markerMissing.question as string).not.toContain(
      "`parked-work` (parked at",
    );
    writeFileSync(
      parkedPath,
      validParked.replace(
        "- **Current Stage**: code-generation",
        "- **Current Stage**: functional-design",
      ),
    );
    const staleByProgress = nextDirective(team, {}, ["--scope", "feature"]);
    expect(staleByProgress.question as string).not.toContain(
      "`parked-work` (parked at",
    );

    const solo = pickerFixture(false, 3);
    const soloQuestion = nextDirective(
      solo,
      {},
      ["--scope", "feature"],
    ).question as string;
    expect(soloQuestion).toContain(
      "`team-work`, `parked-work`, `done-work`",
    );
    expect(soloQuestion).not.toContain("team construction");
    expect(soloQuestion).not.toContain("parked at");

    const single = pickerFixture(true, 1);
    const singleDirective = nextDirective(single);
    expect(singleDirective).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
    });
    expect(JSON.stringify(singleDirective)).not.toContain("team construction");
  });

  test("doctor detects stale stamps, inactive claims, and orphan refs and stays silent when clean", () => {
    const stale = boardFixture();
    writeUnitScopeStamp(stale.project, {
      version: 1,
      space: "default",
      intent_uuid: stale.intentUuid,
      intent_id8: idSuffix(stale.intentUuid),
      unit: "awaiting",
      owner: "awaiting-team",
      generation: 1,
      nonce: "awaiting-nonce",
      claim_ref:
        `refs/heads/claim/${idSuffix(stale.intentUuid)}/awaiting`,
      claim_oid: "a".repeat(40),
      claimed_from_oid: "f".repeat(40),
      integration_ref: "refs/heads/main",
      gate_rhythm: "per-stage",
    });
    const cachePath = join(
      stale.project,
      "aidlc",
      ".aidlc-claim-registry.json",
    );
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    cache.claims.awaiting.status = "released";
    cache.claims.awaiting.generation = 2;
    cache.claims.claimed.observed_at = "2026-08-18T00:00:00Z";
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    const intentsPath = join(
      stale.project,
      "aidlc",
      "spaces",
      "default",
      "intents",
      "intents.json",
    );
    const intentRows = JSON.parse(readFileSync(intentsPath, "utf-8"));
    intentRows.push({
      uuid: "00000000-0000-0000-0000-000044444444",
      slug: "other-work",
      dirName: "other-work-44444444",
      scope: "feature",
      status: "active",
    });
    writeFileSync(intentsPath, `${JSON.stringify(intentRows, null, 2)}\n`);
    writeIntent(
      stale.project,
      "other-work-44444444",
      teamState(),
      dependencyBody(),
    );
    setActiveIntentCursor(stale.project, "other-work-44444444");
    git(
      stale.project,
      [
        "update-ref",
        "refs/heads/claim/deadbeef/orphan",
        "HEAD",
      ],
    );
    const detected = run(UTILITY, ["doctor"], stale.project);
    expect(detected.status).not.toBe(0);
    expect(detected.out).toContain("Unit claim stamp stale");
    expect(detected.out).toContain("✗  Unit claim activity:");
    expect(detected.out).toContain("no observed ref movement");
    expect(detected.out).toContain("Orphan Unit claim refs");

    const clean = boardFixture();
    const cleanCachePath = join(
      clean.project,
      "aidlc",
      ".aidlc-claim-registry.json",
    );
    const cleanCache = JSON.parse(readFileSync(cleanCachePath, "utf-8"));
    cleanCache.claims.awaiting.observed_at = new Date().toISOString();
    cleanCache.claims.claimed.observed_at = new Date().toISOString();
    writeFileSync(cleanCachePath, `${JSON.stringify(cleanCache, null, 2)}\n`);
    const cleanDoctor = run(UTILITY, ["doctor"], clean.project);
    expect(cleanDoctor.out).not.toContain("Unit claim stamp stale");
    expect(cleanDoctor.out).not.toContain("no observed ref movement");
    expect(cleanDoctor.out).not.toContain("Orphan Unit claim refs");

    const upgrade = boardFixture();
    const upgradeCachePath = join(
      upgrade.project,
      "aidlc",
      ".aidlc-claim-registry.json",
    );
    const upgradeCache = JSON.parse(
      readFileSync(upgradeCachePath, "utf-8"),
    );
    delete upgradeCache.claims.awaiting.observed_at;
    delete upgradeCache.claims.claimed.observed_at;
    writeFileSync(
      upgradeCachePath,
      `${JSON.stringify(upgradeCache, null, 2)}\n`,
    );
    const upgradeDoctor = run(UTILITY, ["doctor"], upgrade.project);
    expect(upgradeDoctor.out).toContain(
      "Unit claim activity baseline missing (advisory)",
    );
    expect(upgradeDoctor.out).not.toContain("✗  Unit claim activity:");

    git(
      clean.project,
      [
        "update-ref",
        "refs/remotes/origin/topic/claim/deadbeef/work",
        "HEAD",
      ],
    );
    const unrelated = run(UTILITY, ["doctor"], clean.project);
    expect(unrelated.out).not.toContain("Orphan Unit claim refs");

    const moved = boardFixture();
    const movedCachePath = join(
      moved.project,
      "aidlc",
      ".aidlc-claim-registry.json",
    );
    const movedCache = JSON.parse(readFileSync(movedCachePath, "utf-8"));
    movedCache.claims.awaiting.status = "released";
    movedCache.claims.claimed.observed_at = "2026-08-18T00:00:00Z";
    writeFileSync(movedCachePath, `${JSON.stringify(movedCache, null, 2)}\n`);
    const baseOid = git(moved.project, ["rev-parse", "HEAD"]);
    const movedId8 = idSuffix(moved.intentUuid);
    writeFileSync(
      join(moved.project, ".aidlc-unit-claim.json"),
      `${JSON.stringify({
        version: 1,
        status: "claimed",
        owner: "claimed-team",
        space: "default",
        intent_uuid: moved.intentUuid,
        intent_id8: movedId8,
        unit: "claimed",
        generation: 2,
        nonce: "claimed-moved-nonce",
        base_oid: baseOid,
        integration_ref: "refs/heads/main",
        claim_ref: `refs/heads/claim/${movedId8}/claimed`,
        predecessor_oid: null,
        gate_rhythm: "per-stage",
      }, null, 2)}\n`,
    );
    git(moved.project, ["add", ".aidlc-unit-claim.json"]);
    git(moved.project, ["commit", "-m", "moved local claim ref"]);
    git(
      moved.project,
      [
        "update-ref",
        `refs/heads/claim/${movedId8}/claimed`,
        "HEAD",
      ],
    );
    const movedBoard = nextDirective(moved.project);
    expect(movedBoard.kind).toBe("notice");
    expect(movedBoard.message as string).toContain(
      "observed ref movement since 2026-08-18T00:00:00Z",
    );
    const refreshedCache = JSON.parse(
      readFileSync(movedCachePath, "utf-8"),
    );
    expect(refreshedCache.claims.claimed.oid).toBe(
      git(moved.project, ["rev-parse", "HEAD"]),
    );
    expect(refreshedCache.claims.claimed.observed_at).not.toBe(
      "2026-08-18T00:00:00Z",
    );
    const movedDoctor = run(UTILITY, ["doctor"], moved.project);
    expect(movedDoctor.out).not.toContain("no observed ref movement");
  });

  test("local board failures name the real source instead of blaming the registry", () => {
    const fixture = boardFixture();
    writeFileSync(
      unitDependencyPath(fixture.project),
      "# Unit dependencies\n\n```yaml\nunits: not-a-list\n```\n",
    );
    const directive = nextDirective(fixture.project);
    expect(directive.kind).toBe("notice");
    expect(directive.message as string).toContain(
      "could not compose its local board",
    );
    expect(directive.message as string).toContain(
      "Cannot resolve Unit dependencies",
    );
    expect(directive.message as string).not.toContain(
      "registry is locally unreadable",
    );
    expect(directive.message as string).not.toContain("git fetch");
  });

  test("knob-off status, picker, team-board, and doctor surfaces remain dormant", () => {
    const project = pickerFixture(false, 1);
    const before = snapshotFiles(project);
    const legacy = run(UTILITY, ["status"], project);
    expect(legacy.status, legacy.out).toBe(0);
    expect(legacy.stdout).not.toContain("Team Construction Snapshot");
    const picker = nextDirective(project, {}, ["--scope", "feature"]);
    expect(picker).toMatchObject({ kind: "run-stage" });
    expect(JSON.stringify(picker)).not.toContain("team construction");

    const board = run(ORCH, ["team-board", "--snapshot"], project);
    expect(board.status).not.toBe(0);
    expect(board.out).toContain(
      "Team Construction board requires Unit Ownership: team",
    );
    expect(board.out).not.toContain("Unit Progress derivation requires");

    const doctor = run(UTILITY, ["doctor"], project);
    expect(doctor.out).not.toContain("Unit claim stamp stale");
    expect(doctor.out).not.toContain("Unit claim activity");
    expect(doctor.out).not.toContain("Orphan Unit claim refs");
    expect(snapshotFiles(project)).toEqual(before);
  });
});
