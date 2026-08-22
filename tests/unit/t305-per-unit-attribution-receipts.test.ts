// covers: function:readUnitSourceManifest
// covers: function:sourceClaimCovers
// covers: function:readBaselineSourceSnapshot
// covers: function:readUnitSourceSnapshot
// covers: function:workspaceSourceListing
// covers: function:writeBaselineSourceSnapshot
// covers: function:writeUnitSourceSnapshot
// covers: function:currentStageSourceBaseline
// covers: function:currentSwarmSourceMergeChain
// covers: function:currentSwarmSourceOpeningFingerprint
// covers: function:sourceBaselineAuditFields
// covers: function:sourceListingEntriesEqual
// covers: audit:SWARM_SOURCE_MERGED
//
// t305 - focused #662 substrate and guard-contract coverage. End-to-end receipt,
// recovery, shielding, baselines, aggregate swarm authority, and multi-repo
// attribution are kept here so upstream-owned t304 remains conflict-minimal.

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  currentStageSourceBaseline,
  currentSwarmSourceMergeChain,
  currentSwarmSourceOpeningFingerprint,
  freshReviewReceipts,
  latestMainWorkflowStageRunFloorForProject,
  readAllAuditShards,
  readBaselineSourceSnapshot,
  readUnitSourceManifest,
  readUnitSourceSnapshot,
  recordDir,
  sourceClaimCovers,
  sourceListingEntriesEqual,
  serializeSourceListing,
  sourceBaselineAuditFields,
  sourceListingSha256,
  workspaceSourceListing,
  workspaceSourceState,
  writeBaselineSourceSnapshot,
  writeUnitSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  createTestProject,
  FIXTURES_DIR,
  seedBoltDag,
  seededAuditDir,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PROTOCOL = join(ROOT, "core", "aidlc-common", "protocols");
const STAGE = join(ROOT, "core", "aidlc-common", "stages", "construction", "code-generation.md");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const SWARM = join(AIDLC_SRC, "tools", "aidlc-swarm.ts");
const WORKTREE = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent";
const dirs: string[] = [];
const worktreeDirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dir of worktreeDirs.splice(0)) cleanupWorktreeFixture(dir);
});

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function fixture(repos: string[] = []): { project: string; record: string } {
  const project = mkdtempSync(join(tmpdir(), "aidlc-t305-"));
  dirs.push(project);
  const record = join(project, "aidlc", "spaces", "default", "intents", "fixture-intent");
  mkdirSync(record, { recursive: true });
  writeFileSync(join(record, "aidlc-state.md"), "# State\n- **Scope**: feature\n", "utf-8");
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", "intents.json"), `${JSON.stringify([{ uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "active", repos }])}\n`);
  writeFileSync(join(project, "aidlc", "spaces", "default", "intents", ".active-intent"), "fixture-intent\n");
  if (repos.length === 0) {
    git(project, ["init", "-q"]); git(project, ["config", "user.email", "t@test"]); git(project, ["config", "user.name", "t"]);
    writeFileSync(join(project, "app.ts"), "export const app = 1;\n"); git(project, ["add", "-A"]); git(project, ["commit", "-qm", "seed"]);
  } else {
    for (const repo of repos) {
      const path = join(project, repo); mkdirSync(path, { recursive: true });
      git(path, ["init", "-q"]); git(path, ["config", "user.email", "t@test"]); git(path, ["config", "user.name", "t"]);
      writeFileSync(join(path, `${repo}.ts`), `export const ${repo.replace(/-/g, "_")} = 1;\n`); git(path, ["add", "-A"]); git(path, ["commit", "-qm", "seed"]);
    }
  }
  return { project, record };
}

function manifest(record: string, unit: string, value: unknown): string {
  const dir = join(record, "construction", unit, "code-generation"); mkdirSync(dir, { recursive: true });
  const path = join(dir, "source-manifest.json"); writeFileSync(path, `${JSON.stringify(value)}\n`); return path;
}

describe("t305 strict source-manifest validation", () => {
  test("accepts exact and directory claims and rejects schema/path violations", () => {
    const { project, record } = fixture();
    const valid = { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }, { path: "src/generated/" }] };
    manifest(record, "alpha", valid);
    const accepted = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(sourceClaimCovers("\0app.ts", accepted)).toBe(true);
      expect(sourceClaimCovers("\0src/generated/a.ts", accepted)).toBe(true);
    }
    const rejected = [
      { ...valid, unknown: true },
      { ...valid, stage: "other" },
      { ...valid, unit: "beta" },
      { ...valid, version: 2 },
      { ...valid, writes: [{ path: "../escape.ts" }] },
      { ...valid, writes: [{ path: "/absolute.ts" }] },
      { ...valid, writes: [{ path: "bad\\path.ts" }] },
      { ...valid, writes: [{ path: "*.ts" }] },
      { ...valid, writes: [{ path: "aidlc/internal.ts" }] },
      { ...valid, writes: [{ path: "app.ts" }, { path: "./app.ts" }] },
    ];
    for (const value of rejected) {
      manifest(record, "alpha", value);
      expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);
    }
  });

  test("multi-repo requires recorded repo and scopes claims to it", () => {
    const { project, record } = fixture(["repo-a", "repo-b"]);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ repo: "repo-a", path: "repo-a.ts" }, { repo: "repo-b", path: "repo-b.ts" }] });
    const accepted = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(sourceClaimCovers("repo-b\0repo-b.ts", accepted)).toBe(true);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "repo-a.ts" }] });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ repo: "repo-c", path: "x.ts" }] });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok).toBe(false);
  });

  test("accepts a trailing-slash prefix for a directory committed in HEAD", () => {
    const { project, record } = fixture();
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "committed.ts"), "export const committed = true;\n");
    git(project, ["add", "--", "src/committed.ts"]);
    git(project, ["commit", "-qm", "commit source directory"]);
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "src/" }],
    });

    const accepted = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(sourceClaimCovers("\0src/committed.ts", accepted)).toBe(true);
    }
  });

  test("rejects ignored exact claims and prefixes containing ignored source", () => {
    const { project, record } = fixture();
    writeFileSync(
      join(project, ".gitignore"),
      "ignored.ts\nignored-dir/*.tmp\n",
    );
    writeFileSync(join(project, "ignored.ts"), "ignored\n");
    mkdirSync(join(project, "ignored-dir"), { recursive: true });
    writeFileSync(join(project, "ignored-dir", "generated.tmp"), "ignored\n");

    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "ignored.ts" }],
    });
    const exact = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(exact.ok).toBe(false);
    if (!exact.ok) expect(exact.reason).toContain("ignored by Git");

    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "ignored-dir/" }],
    });
    const prefix = readUnitSourceManifest(project, "code-generation", "alpha");
    expect(prefix.ok).toBe(false);
    if (!prefix.ok) expect(prefix.reason).toContain("contains ignored application source");

    writeFileSync(join(project, "force-only.secret"), "staged but uncommitted\n");
    writeFileSync(
      join(project, ".gitignore"),
      "ignored.ts\nignored-dir/*.tmp\n*.secret\n",
    );
    git(project, ["add", ".gitignore"]);
    git(project, ["commit", "-qm", "ignore rules"]);
    git(project, ["add", "-f", "force-only.secret"]);
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "force-only.secret" }],
    });
    const forceOnly = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(forceOnly.ok).toBe(false);
    if (!forceOnly.ok) expect(forceOnly.reason).toContain("ignored by Git");
    git(project, ["reset", "-q", "HEAD", "--", "force-only.secret"]);

    writeFileSync(join(project, "head-tracked.secret"), "tracked in HEAD\n");
    git(project, ["add", "-f", "head-tracked.secret"]);
    git(project, ["commit", "-qm", "track ignored source"]);
    git(project, ["rm", "-q", "--cached", "head-tracked.secret"]);
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "head-tracked.secret" }],
    });
    expect(readUnitSourceManifest(project, "code-generation", "alpha").ok)
      .toBe(true);
    expect(workspaceSourceListing(project)?.has("\0head-tracked.secret"))
      .toBe(true);

    mkdirSync(join(project, "slashless"), { recursive: true });
    manifest(record, "alpha", {
      stage: "code-generation",
      unit: "alpha",
      version: 1,
      writes: [{ path: "slashless" }],
    });
    const slashless = readUnitSourceManifest(
      project,
      "code-generation",
      "alpha",
    );
    expect(slashless.ok).toBe(false);
    if (!slashless.ok) expect(slashless.reason).toContain("must end with");
  });
});

describe("t305 content-addressed source review evidence", () => {
  test("baseline and unit snapshots round-trip and fail closed after destruction or tamper", () => {
    const { project, record } = fixture();
    const listing = workspaceSourceListing(project); expect(listing).not.toBeNull();
    if (listing === null) return;
    expect(listing.get("\0app.ts")).toMatch(/^100644 [0-9a-f]{40,64}$/);
    const baseline = writeBaselineSourceSnapshot(project, "code-generation", listing);
    expect(readBaselineSourceSnapshot(project, "code-generation", baseline)?.get("\0app.ts"))
      .toMatch(/^100644 [0-9a-f]{40,64}$/);
    manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }] });
    const claims = readUnitSourceManifest(project, "code-generation", "alpha"); expect(claims.ok).toBe(true);
    if (!claims.ok) return;
    const unit = writeUnitSourceSnapshot(project, "code-generation", "alpha", listing, claims, claims.rawBytesSha256);
    expect(readUnitSourceSnapshot(project, "code-generation", "alpha", unit)?.manifestSha256).toBe(claims.rawBytesSha256);
    const unitPath = join(record, ".aidlc-source-review", "code-generation", `unit-alpha-${unit.slice(7, 19)}.tsv`);
    writeFileSync(unitPath, "tampered\n");
    expect(readUnitSourceSnapshot(project, "code-generation", "alpha", unit)).toBeNull();
  });

  test("manifest bytes are bound, covering direct-fs post-review tamper and deleted claims", () => {
    const { project, record } = fixture();
    const path = manifest(record, "alpha", { stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "app.ts" }] });
    const first = readUnitSourceManifest(project, "code-generation", "alpha"); expect(first.ok).toBe(true);
    writeFileSync(path, `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [] }, null, 2)}\n`);
    const second = readUnitSourceManifest(project, "code-generation", "alpha"); expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.rawBytesSha256).not.toBe(first.rawBytesSha256);
    rmSync(join(project, "app.ts"));
    expect(workspaceSourceListing(project)?.has("\0app.ts")).toBe(false);
  });

  test("legacy OID-only entries migrate by content while modern mode changes remain distinct", () => {
    const oid = "a".repeat(40);
    expect(sourceListingEntriesEqual(oid, `100644 ${oid}`)).toBe(true);
    expect(sourceListingEntriesEqual(`100644 ${oid}`, `100755 ${oid}`)).toBe(false);
  });

  test("an unchanged no-Git greenfield binds to empty source while raw application files fail closed", () => {
    const project = createTestProject();
    dirs.push(project);
    const empty = workspaceSourceState(project);
    expect(empty).not.toBeNull();
    expect(empty?.listing.size).toBe(0);
    expect(empty?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    writeFileSync(join(project, "untracked-without-git.ts"), "unbound\n");
    expect(workspaceSourceState(project)).toBeNull();
  });

  test("no-Git workflow birth and jump both emit empty modern unit-major baselines", () => {
    const born = createTestProject();
    dirs.push(born);
    const created = spawnSync(
      process.execPath,
      [
        UTILITY,
        "intent-create",
        "--scope",
        "feature",
        "--label",
        "empty-baseline",
        "--project-dir",
        born,
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_WORKFLOW_INTENT: "empty baseline birth",
        },
      },
    );
    expect(created.status, `${created.stdout ?? ""}${created.stderr ?? ""}`)
      .toBe(0);
    const birthAudit = readAllAuditShards(born);
    const birthField = /\*\*Event\*\*: WORKFLOW_STARTED[\s\S]*?\*\*Source Baseline\*\*: (sha256:[0-9a-f]{64})/
      .exec(birthAudit)?.[1];
    expect(birthField).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      readBaselineSourceSnapshot(
        born,
        "code-generation",
        birthField as string,
      )?.size,
    ).toBe(0);
    const bornBaseline = currentStageSourceBaseline(
      born,
      "code-generation",
      true,
    );
    expect(bornBaseline.state).toBe("ready");
    if (bornBaseline.state === "ready") {
      expect(bornBaseline.listing.size).toBe(0);
    }

    const jumped = createTestProject();
    dirs.push(jumped);
    seedStateFile(jumped, "state-mid-ideation.md");
    git(jumped, ["init", "-q"]);
    git(jumped, ["config", "user.email", "t@test"]);
    git(jumped, ["config", "user.name", "t"]);
    writeFileSync(join(jumped, "existing.ts"), "export const existing = true;\n");
    git(jumped, ["add", "-A"]);
    git(jumped, ["commit", "-qm", "existing source"]);
    const initial = writeBaselineSourceSnapshot(
      jumped,
      "code-generation",
      workspaceSourceListing(jumped) as Map<string, string>,
    );
    appendAuditEntry(
      "WORKFLOW_STARTED",
      { Scope: "feature", "Source Baseline": initial },
      jumped,
    );
    rmSync(join(jumped, ".git"), { recursive: true, force: true });
    const boundarySecond = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === boundarySecond) {}
    const executed = spawnSync(
      process.execPath,
      [
        JUMP,
        "execute",
        "--target",
        "code-generation",
        "--direction",
        "forward",
        "--scope",
        "feature",
        "--project-dir",
        jumped,
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
        },
      },
    );
    expect(executed.status, `${executed.stdout ?? ""}${executed.stderr ?? ""}`)
      .toBe(0);
    const jumpBlock = readAllAuditShards(jumped)
      .split(/\n---\n/)
      .filter((block) => block.includes("**Event**: STAGE_JUMPED"))
      .at(-1);
    const jumpField = jumpBlock?.match(
      /^\*\*Source Baseline\*\*: (sha256:[0-9a-f]{64})$/m,
    )?.[1];
    expect(jumpField).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(jumpField).not.toBe(initial);
    expect(
      readBaselineSourceSnapshot(
        jumped,
        "code-generation",
        jumpField as string,
      )?.size,
    ).toBe(0);
    const selected = currentStageSourceBaseline(
      jumped,
      "code-generation",
      true,
    );
    expect(selected.state).toBe("ready");
    if (selected.state === "ready") expect(selected.listing.size).toBe(0);
    expect(recordDir(jumped)).not.toBeNull();
  }, 30000);

  test("current swarm source chain binds its opening baseline and latest per-unit convergence", () => {
    const { project } = runtimeFixture();
    const floor = latestMainWorkflowStageRunFloorForProject(
      project,
      "code-generation",
    );
    const opening = currentSwarmSourceOpeningFingerprint(
      project,
      "code-generation",
    );
    expect(opening.state).toBe("ready");
    if (opening.state !== "ready") return;
    const current = workspaceSourceState(project);
    expect(current).not.toBeNull();
    if (current === null) return;
    const commit = spawnSync(
      "git",
      ["-C", project, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    expect(commit).toMatch(/^[0-9a-f]{40,64}$/);

    for (const unit of ["alpha", "beta"]) {
      appendAuditEntry(
        "SWARM_UNIT_CONVERGED",
        {
          "Batch number": "1",
          "Unit name": unit,
          Stage: "code-generation",
          "Run floor": floor,
          "Source Commit": commit,
        },
        project,
      );
      appendAuditEntry(
        "SWARM_SOURCE_MERGED",
        {
          "Batch number": "1",
          "Unit name": unit,
          Stage: "code-generation",
          "Run floor": floor,
          "Previous Source Fingerprint":
            unit === "alpha" ? opening.fingerprint : current.fingerprint,
          "Source Fingerprint": current.fingerprint,
          "Source Commit": commit,
          "Merge commit": commit,
        },
        project,
      );
    }

    const chain = currentSwarmSourceMergeChain(project, "code-generation");
    expect(chain.state).toBe("ready");
    if (chain.state === "ready") {
      expect(chain.fingerprint).toBe(current.fingerprint);
      expect([...chain.units].sort()).toEqual(["alpha", "beta"]);
    }
    expect(opening.fingerprint).toBe(
      sourceListingSha256(
        serializeSourceListing(
          opening.listing ?? new Map(),
        ),
      ),
    );
  }, 30000);
});


function runtimeFixture(): { project: string; record: string } {
  const { project, record } = fixture();
  let state = readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8");
  state = state
    .replace("- **Current Stage**: feasibility", "- **Current Stage**: code-generation\n- **Construction Iteration**: stage-major")
    .replace("- [ ] code-generation — EXECUTE", "- [?] code-generation — EXECUTE");
  writeFileSync(join(record, "aidlc-state.md"), state, "utf-8");
  const dag = join(record, "inception", "units-generation");
  mkdirSync(dag, { recursive: true });
  writeFileSync(join(dag, "unit-of-work-dependency.md"), "```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n```\n");
  const listing = workspaceSourceListing(project);
  if (listing === null) throw new Error("runtime fixture source listing missing");
  const baseline = writeBaselineSourceSnapshot(project, "code-generation", listing);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, project);
  appendAuditEntry("STAGE_STARTED", {
    Stage: "code-generation",
    Agent: "aidlc-developer-agent",
    "Source Baseline": baseline,
  }, project);
  // Audit timestamps are second-precision. The boundary is emitted in this
  // test process while product CLIs append from child processes/shards; wait
  // for the next second so the fixture does not manufacture causal ambiguity.
  const boundarySecond = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === boundarySecond) {}
  return { project, record };
}

function seedArtifacts(record: string, unit: string): string {
  const dir = join(record, "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  for (const name of ["code-generation-plan.md", "unit-test-instructions.md", "code-summary.md", "traceability.json"])
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), name.endsWith(".json") ? "{}\n" : `# ${name}\n`);
  return dir;
}

function writeManifest(record: string, unit: string, writes: Array<{ path: string; repo?: string }>): void {
  const dir = seedArtifacts(record, unit);
  writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit, version: 1, writes }, null, 2)}\n`);
}

function cli(tool: string, args: string[], project: string, env: Record<string, string> = {}): { rc: number; out: string } {
  const merged = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_REVISION_BACKSTOP: "1", ...env };
  const r = spawnSync(process.execPath, [tool, ...args, "--project-dir", project], { encoding: "utf-8", env: merged });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function review(
  project: string,
  record: string,
  unit: string,
  writes: Array<{ path: string; repo?: string }>,
  env: Record<string, string> = {},
  iteration?: string,
): { request: {rc:number;out:string}; verdict: {rc:number;out:string} } {
  writeManifest(record, unit, writes);
  const prior = (readAllAuditShards(project).match(new RegExp(`\\*\\*Event\\*\\*: REVIEW_REQUESTED[\\s\\S]*?\\*\\*Unit\\*\\*: ${unit}`, "g")) ?? []).length;
  const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", unit, "--iteration", iteration ?? String(prior + 1)];
  const request = cli(LOG, args, project, env);
  const verdict = request.rc === 0 ? cli(LOG, [...args, "--verdict", "READY"], project, env) : { rc: request.rc, out: request.out };
  return { request, verdict };
}

function approve(project: string, env: Record<string, string> = {}): { rc: number; out: string } {
  return cli(STATE, ["approve", "code-generation", "--user-input", "ship"], project, env);
}

function stripUnitBindings(project: string): void {
  const root = join(project, "aidlc", "spaces", "default", "intents");
  for (const rec of readdirSync(root)) {
    const audit = join(root, rec, "audit"); if (!existsSync(audit)) continue;
    for (const file of readdirSync(audit)) {
      const path = join(audit, file); let body = readFileSync(path, "utf-8");
      body = body.replace(/^\*\*(?:Unit Source Fingerprint|Unit Source Binding Bypass)\*\*: .*\r?\n/gm, "");
      writeFileSync(path, body);
    }
  }
}

function swarmFixture(): string {
  const project = setupWorktreeFixture();
  worktreeDirs.push(project);
  git(project, ["config", "user.email", "t@test"]);
  git(project, ["config", "user.name", "t"]);
  const state = readFileSync(
    join(FIXTURES_DIR, "state-construction-with-worktree.md"),
    "utf-8",
  ).replace(/^(- \*\*Bolt Refs\*\*: ).*$/m, "$1");
  writeFileSync(seededStateFile(project), state);
  mkdirSync(seededAuditDir(project), { recursive: true });
  writeFileSync(
    seededAuditShard(project),
    "# AI-DLC Audit Log\n",
    "utf-8",
  );
  writeFileSync(
    join(project, ".gitignore"),
    [
      "aidlc/active-space",
      "aidlc/.aidlc-clone-id",
      "aidlc/spaces/*/intents/active-intent",
      "aidlc/spaces/*/intents/*/runtime-graph.json",
      "aidlc/spaces/*/intents/*/.aidlc-*",
      "aidlc/spaces/*/intents/*/audit/",
      "",
    ].join("\n"),
  );
  git(project, ["add", "-A"]);
  git(project, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--amend",
    "--no-edit",
  ]);
  appendAuditEntry(
    "WORKFLOW_STARTED",
    {
      Scope: "feature",
      ...sourceBaselineAuditFields(project, "code-generation"),
    },
    project,
  );
  const boundarySecond = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === boundarySecond) {}
  return project;
}

function runSwarm(
  project: string,
  args: string[],
): { rc: number; out: string } {
  const result = spawnSync(
    process.execPath,
    [SWARM, "--project-dir", project, ...args],
    { cwd: project, encoding: "utf-8" },
  );
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function auditLockWatcher(
  shard: string,
  marker: string,
  slug: string,
) {
  const script = `
    const fs = require("node:fs");
    const shard = process.env.AIDLC_TEST_AUDIT_SHARD;
    const marker = process.env.AIDLC_TEST_AUDIT_MARKER;
    const slug = process.env.AIDLC_TEST_BOLT_SLUG;
    const deadline = Date.now() + 15000;
    const poll = () => {
      let body = "";
      try { body = fs.readFileSync(shard, "utf8"); } catch {}
      if (
        body.includes("**Event**: WORKTREE_MERGED") &&
        body.includes("**Bolt slug**: " + slug)
      ) {
        fs.chmodSync(shard, 0o444);
        fs.writeFileSync(marker, "locked\\n");
        process.exit(0);
      }
      if (Date.now() >= deadline) process.exit(2);
      setTimeout(poll, 1);
    };
    poll();
  `;
  return spawn(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      AIDLC_TEST_AUDIT_SHARD: shard,
      AIDLC_TEST_AUDIT_MARKER: marker,
      AIDLC_TEST_BOLT_SLUG: slug,
    },
    stdio: "ignore",
  });
}

describe("t305 real receipt and guard flows", () => {
  test("2 stamp refuses without manifest; bypass marker is check-time enforced", () => {
    const { project, record } = runtimeFixture(); seedArtifacts(record, "alpha");
    const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", "alpha", "--iteration", "1"];
    expect(cli(LOG, args, project).rc).toBe(0);
    const refused = cli(LOG, [...args, "--verdict", "READY"], project);
    expect(refused.rc).toBe(1); expect(refused.out).toContain("has no valid source manifest");
    expect(readAllAuditShards(project)).not.toContain("**Event**: REVIEW_COMPLETED");
    const bypass = cli(LOG, [...args, "--verdict", "READY"], project, { AIDLC_SKIP_SOURCE_FRESHNESS: "1" });
    expect(bypass.rc).toBe(0); expect(readAllAuditShards(project)).toContain("**Unit Source Binding Bypass**: true");
    review(project, record, "beta", [{ path: "app.ts" }], { AIDLC_SKIP_SOURCE_FRESHNESS: "1" });
    expect(approve(project).rc).toBe(1);
    expect(approve(project, { AIDLC_SKIP_SOURCE_FRESHNESS: "1" }).rc).toBe(0);
  }, 30000);

  test("terminal review refuses an explicitly claimed ignored path without minting a receipt", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(project, "ignored.ts"), "ignored\n");
    writeManifest(record, "alpha", [{ path: "ignored.ts" }]);
    const args = [
      "review",
      "--stage",
      "code-generation",
      "--reviewer",
      REVIEWER,
      "--unit",
      "alpha",
      "--iteration",
      "1",
    ];
    expect(cli(LOG, args, project).rc).toBe(0);
    const refused = cli(LOG, [...args, "--verdict", "READY"], project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("ignored by Git");
    expect(readAllAuditShards(project)).not.toMatch(
      /\*\*Event\*\*: REVIEW_COMPLETED[\s\S]*?\*\*Unit\*\*: alpha/,
    );
  }, 30000);

  test("3 disjoint unit invalidation names only beta and bounded recovery clears", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, "alpha.ts"), "export const a=1\n"); writeFileSync(join(project, "beta.ts"), "export const b=1\n");
    review(project, record, "alpha", [{ path: "alpha.ts" }]); review(project, record, "beta", [{ path: "beta.ts" }]);
    writeFileSync(join(project, "beta.ts"), "export const b=2\n");
    // Refresh the global outer binding with alpha while beta remains stale.
    review(project, record, "alpha", [{ path: "alpha.ts" }]);
    const refused = approve(project); expect(refused.rc).toBe(1); expect(refused.out).toContain("Invalidated receipts: beta"); expect(refused.out).not.toContain("Invalidated receipts: alpha");
    const recovered = review(project, record, "beta", [{ path: "beta.ts" }]); expect(recovered.verdict.rc).toBe(0); expect(approve(project).rc).toBe(0);
  }, 30000);

  test("executable-bit changes invalidate the owning unit after another review refreshes the global binding", () => {
    const { project, record } = runtimeFixture();
    const script = join(project, "script.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o644);
    review(project, record, "alpha", [{ path: "script.sh" }]);
    review(project, record, "beta", []);

    chmodSync(script, 0o755);
    review(project, record, "beta", []);
    const refused = approve(project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("Invalidated receipts: alpha");
  }, 30000);

  test("4 newest claimant shields overlap, but a stale newer claimant invalidates both", () => {
    const pass = runtimeFixture(); writeFileSync(join(pass.project, "shared.ts"), "export const s=1\n");
    review(pass.project, pass.record, "alpha", [{ path: "shared.ts" }]); writeFileSync(join(pass.project, "shared.ts"), "export const s=2\n"); review(pass.project, pass.record, "beta", [{ path: "shared.ts" }]); expect(approve(pass.project).rc).toBe(0);
    const fail = runtimeFixture(); writeFileSync(join(fail.project, "shared.ts"), "export const s=1\n");
    review(fail.project, fail.record, "alpha", [{ path: "shared.ts" }]); writeFileSync(join(fail.project, "shared.ts"), "export const s=2\n"); review(fail.project, fail.record, "beta", [{ path: "shared.ts" }]); writeFileSync(join(fail.project, "shared.ts"), "export const s=3\n");
    const r=approve(fail.project); expect(r.rc).toBe(1); expect(r.out).toContain("source-fingerprint mismatch");
    const state=readFileSync(join(fail.record,"aidlc-state.md"),"utf-8"); const receipts=freshReviewReceipts(fail.project,state,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]}); expect([...receipts.unitStale].sort()).toEqual(["alpha","beta"]);
  }, 30000);

  test("5 unclaimed add refuses; claim+recovery and revert both clear", () => {
    const claimed = runtimeFixture(); review(claimed.project, claimed.record, "alpha", [{ path: "app.ts" }]); review(claimed.project, claimed.record, "beta", []);
    writeFileSync(join(claimed.project, "extra.ts"), "export const x=1\n"); review(claimed.project, claimed.record, "beta", []);
    expect(approve(claimed.project).out).toContain("Unclaimed source changes fail closed");
    review(claimed.project, claimed.record, "alpha", [{ path: "app.ts" }, { path: "extra.ts" }]); expect(approve(claimed.project).rc).toBe(0);
    const reverted = runtimeFixture(); review(reverted.project, reverted.record, "alpha", [{ path: "app.ts" }]); review(reverted.project, reverted.record, "beta", []);
    writeFileSync(join(reverted.project, "extra.ts"), "export const x=1\n"); review(reverted.project, reverted.record, "beta", []); expect(approve(reverted.project).rc).toBe(1); rmSync(join(reverted.project, "extra.ts")); expect(approve(reverted.project).rc).toBe(0);
  }, 30000);

  test("rejection never launders an unclaimed path into the next attempt baseline", () => {
    const { project, record } = runtimeFixture();
    writeFileSync(join(project, "evil.ts"), "export const evil = true;\n");
    review(project, record, "alpha", [{ path: "app.ts" }]);
    review(project, record, "beta", []);

    const rejected = cli(
      STATE,
      ["reject", "code-generation", "--feedback", "revise the reviewed work"],
      project,
    );
    expect(rejected.rc, rejected.out).toBe(0);
    expect(
      review(project, record, "alpha", [{ path: "app.ts" }], {}, "1").verdict.rc,
    ).toBe(0);
    expect(review(project, record, "beta", [], {}, "1").verdict.rc).toBe(0);
    const refused = cli(STATE, ["revise", "code-generation"], project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("evil.ts");
    expect(refused.out).toContain("Unclaimed source changes fail closed");
  }, 30000);

  test("6 unit-major ignores late STAGE_STARTED and destroyed baseline fails closed", () => {
    const late = runtimeFixture(); const state=join(late.record,"aidlc-state.md"); writeFileSync(state,readFileSync(state,"utf-8").replace("stage-major","unit-major"));
    writeFileSync(join(late.project,"late.ts"),"export const late=1\n");
    const now=workspaceSourceListing(late.project)!; appendAuditEntry("STAGE_STARTED",{Workflow:"single-stage:code-generation",Stage:"code-generation",Agent:"aidlc-developer-agent","Source Baseline":writeBaselineSourceSnapshot(late.project,"code-generation",now)},late.project);
    const syntheticSecond=Math.floor(Date.now()/1000); while(Math.floor(Date.now()/1000)===syntheticSecond){}
    review(late.project,late.record,"alpha",[{path:"app.ts"}]); review(late.project,late.record,"beta",[]); const lateState=readFileSync(state,"utf-8"); const lateReceipts=freshReviewReceipts(late.project,lateState,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]}); expect(lateReceipts.sourceBaseline.state).toBe("ready"); if (lateReceipts.sourceBaseline.state === "ready") expect(lateReceipts.sourceBaseline.listing.has("\0late.ts")).toBe(false); expect(approve(late.project).out).toContain("late.ts");
    const destroyed=runtimeFixture(); review(destroyed.project,destroyed.record,"alpha",[{path:"app.ts"}]); review(destroyed.project,destroyed.record,"beta",[]);
    const audit=readAllAuditShards(destroyed.project); const hash=/\*\*Source Baseline\*\*: sha256:([0-9a-f]{64})/.exec(audit)![1]; rmSync(join(destroyed.record,".aidlc-source-review","code-generation",`baseline-${hash.slice(0,12)}.tsv`)); expect(approve(destroyed.project).out).toContain("baseline snapshot is missing");
  }, 30000);

  test("7 manifest tamper and 8 claimed deletion make only the owning unit stale", () => {
    const tamper=runtimeFixture(); review(tamper.project,tamper.record,"alpha",[{path:"app.ts"}]); review(tamper.project,tamper.record,"beta",[]); writeManifest(tamper.record,"alpha",[]); expect(approve(tamper.project).out).toContain("Invalidated receipts: alpha");
    const deleted=runtimeFixture(); writeFileSync(join(deleted.project,"alpha.ts"),"a\n"); review(deleted.project,deleted.record,"alpha",[{path:"alpha.ts"}]); review(deleted.project,deleted.record,"beta",[]); rmSync(join(deleted.project,"alpha.ts")); review(deleted.project,deleted.record,"beta",[]); expect(approve(deleted.project).out).toContain("Invalidated receipts: alpha");
  }, 30000);

  test("9 fieldless per-unit bindings preserve legacy global policy and 11 zero-unit stays manifest-free", () => {
    const legacy=runtimeFixture(); review(legacy.project,legacy.record,"alpha",[{path:"app.ts"}]); review(legacy.project,legacy.record,"beta",[]); stripUnitBindings(legacy.project); expect(approve(legacy.project).rc).toBe(0);
    const zero=runtimeFixture(); rmSync(join(zero.record,"inception"),{recursive:true,force:true});
    const args=["review","--stage","code-generation","--reviewer",REVIEWER,"--iteration","1"]; expect(cli(LOG,args,zero.project).rc).toBe(0); expect(cli(LOG,[...args,"--verdict","READY"],zero.project).rc).toBe(0); expect(approve(zero.project).rc).toBe(0);
  }, 30000);

  test("12 two recorded repos invalidate only the owning repo and unit", () => {
    const base=runtimeFixture(); const project=base.project; const record=base.record; rmSync(join(project,".git"),{recursive:true,force:true}); for (const repo of ["repo-a","repo-b"]) { const path=join(project,repo); mkdirSync(path,{recursive:true}); git(path,["init","-q"]); git(path,["config","user.email","t@test"]); git(path,["config","user.name","t"]); writeFileSync(join(path,`${repo}.ts`),`export const ${repo.replace(/-/g,"_")}=1\n`); git(path,["add","-A"]); git(path,["commit","-qm","seed"]); } const registry=join(project,"aidlc","spaces","default","intents","intents.json"); const rows=JSON.parse(readFileSync(registry,"utf-8")); rows[0].repos=["repo-a","repo-b"]; writeFileSync(registry,`${JSON.stringify(rows)}\n`); const initial=workspaceSourceListing(project)!; appendAuditEntry("STAGE_JUMPED",{Target:"code-generation","Source Baseline":writeBaselineSourceSnapshot(project,"code-generation",initial)},project); const multiBoundary=Math.floor(Date.now()/1000); while(Math.floor(Date.now()/1000)===multiBoundary){}
    review(project,record,"alpha",[{repo:"repo-a",path:"repo-a.ts"}]); review(project,record,"beta",[{repo:"repo-b",path:"repo-b.ts"}]); writeFileSync(join(project,"repo-b","repo-b.ts"),"export const repo_b=2\n"); review(project,record,"alpha",[{repo:"repo-a",path:"repo-a.ts"}]); const r=approve(project); expect(r.out).toContain("Invalidated receipts: beta"); expect(r.out).not.toContain("Invalidated receipts: alpha");
  }, 30000);

  test("absent exact claim becomes stale when the path appears before an unrelated review", () => {
    const {project,record}=runtimeFixture(); review(project,record,"alpha",[{path:"future.ts"}]); writeFileSync(join(project,"future.ts"),"future\n"); review(project,record,"beta",[{path:"app.ts"}]); expect(approve(project).out).toContain("Invalidated receipts: alpha");
  }, 30000);

  test("ghost/non-applicable units cannot mint review authority or cover unclaimed source", () => {
    const {project,record}=runtimeFixture();
    review(project,record,"alpha",[{path:"app.ts"}]); review(project,record,"beta",[]);
    writeFileSync(join(project,"extra.ts"),"extra\n");
    writeManifest(record,"ghost",[{path:"extra.ts"}]);
    const ghost=cli(LOG,["review","--stage","code-generation","--reviewer",REVIEWER,"--unit","ghost","--iteration","1"],project);
    expect(ghost.rc).toBe(1); expect(ghost.out).toContain("not present in the authoritative unit DAG");
    const forgedState=readFileSync(join(record,"aidlc-state.md"),"utf-8");
    const receipts=freshReviewReceipts(project,forgedState,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]});
    expect(receipts.freshUnitClaims.has("ghost")).toBe(false);
  }, 30000);

  test("stage-major selects the tighter STAGE_STARTED baseline", () => {
    const {project,record}=runtimeFixture();
    // Replace the fixture's equal workflow/stage snapshots with a workflow
    // baseline, a pre-stage source addition, and a tighter stage baseline.
    const auditDir=join(record,"audit"); rmSync(auditDir,{recursive:true,force:true}); mkdirSync(auditDir,{recursive:true});
    const workflow=writeBaselineSourceSnapshot(project,"code-generation",workspaceSourceListing(project)!);
    appendAuditEntry("WORKFLOW_STARTED",{Scope:"feature","Source Baseline":workflow},project);
    writeFileSync(join(project,"prestage.ts"),"pre\n");
    const stageBaseline=writeBaselineSourceSnapshot(project,"code-generation",workspaceSourceListing(project)!);
    appendAuditEntry("STAGE_STARTED",{Stage:"code-generation",Agent:"aidlc-developer-agent","Source Baseline":stageBaseline},project);
    const second=Math.floor(Date.now()/1000); while(Math.floor(Date.now()/1000)===second){}
    writeFileSync(join(project,"later.ts"),"later\n"); review(project,record,"alpha",[{path:"app.ts"}]); review(project,record,"beta",[]);
    const out=approve(project).out; expect(out).toContain("later.ts"); expect(out).not.toContain("prestage.ts");
  }, 30000);

  test("an empty modern baseline still exposes source created after Git initialization", () => {
    const { project, record } = runtimeFixture();
    rmSync(join(project, ".git"), { recursive: true, force: true });
    const auditDir = join(record, "audit");
    rmSync(auditDir, { recursive: true, force: true });
    mkdirSync(auditDir, { recursive: true });
    const emptyBaseline = writeBaselineSourceSnapshot(
      project,
      "code-generation",
      new Map(),
    );
    appendAuditEntry("WORKFLOW_STARTED", {
      Scope: "feature",
      "Source Baseline": emptyBaseline,
    }, project);
    const boundarySecond = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === boundarySecond) {}

    git(project, ["init", "-q"]);
    git(project, ["config", "user.email", "t@test"]);
    git(project, ["config", "user.name", "t"]);
    writeFileSync(join(project, "claimed.ts"), "claimed\n");
    writeFileSync(join(project, "unclaimed.ts"), "unclaimed\n");
    const alpha = review(project, record, "alpha", [{ path: "claimed.ts" }]);
    expect(alpha.verdict.rc, alpha.verdict.out).toBe(0);
    const beta = review(project, record, "beta", []);
    expect(beta.verdict.rc, beta.verdict.out).toBe(0);

    const refused = approve(project);
    expect(refused.rc).toBe(1);
    expect(refused.out).toContain("unclaimed.ts");
  }, 30000);

  test("calls freshReviewReceipts directly for a modern unit chain", () => {
    const {project,record}=runtimeFixture(); review(project,record,"alpha",[{path:"app.ts"}]); review(project,record,"beta",[]); const state=readFileSync(join(record,"aidlc-state.md"),"utf-8"); const receipts=freshReviewReceipts(project,state,{slug:"code-generation",phase:"construction",for_each:"unit-of-work",reviewer:REVIEWER,reviewer_max_iterations:2,workspace_requires:true,produces:["code-generation-plan","unit-test-instructions","code-summary","traceability"]}); expect(receipts.unitVerdicts.size).toBe(2);
  }, 30000);
});

describe("t305 post-merge source authority failure", () => {
  test("an unrelated source write during merge is not folded into aggregate authority", () => {
    const project = swarmFixture();
    const unit = "merge-interleave";
    seedBoltDag(project, [unit]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      unit,
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);

    const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
    const source = `${unit}.ts`;
    writeFileSync(join(wt, source), "export const reviewed = true;\n");
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      unit,
      [{ path: source }],
    );
    expect(reviewed.request.rc, reviewed.request.out).toBe(0);
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      unit,
      "--claimed",
      unit,
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('${source}')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const hook = join(project, ".git", "hooks", "post-commit");
    writeFileSync(
      hook,
      "#!/bin/sh\nprintf '%s\\n' 'export const unreviewed = true;' > merge-interleaved.ts\n",
    );
    chmodSync(hook, 0o755);
    const merged = spawnSync(
      process.execPath,
      [
        WORKTREE,
        "merge",
        "--slug",
        unit,
        "--target",
        "main",
        "--strategy",
        "squash",
        "--project-dir",
        project,
      ],
      { cwd: project, encoding: "utf-8" },
    );
    const output = `${merged.stdout ?? ""}${merged.stderr ?? ""}`;
    expect(merged.status).not.toBe(0);
    expect(output).toContain("[merge-succeeded:");
    expect(output).toContain("outside immutable reviewed commit");
    expect(output).toContain("Do not retry this merge");
    expect(existsSync(join(project, source))).toBe(true);
    expect(existsSync(join(project, "merge-interleaved.ts"))).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(readAllAuditShards(project)).not.toContain(
      "**Event**: SWARM_SOURCE_MERGED",
    );
  }, 120000);

  test("an audit append failure after source merge is tagged, non-retryable, and preserves recovery state", () => {
    expect(typeof process.getuid === "function" ? process.getuid() : -1)
      .not.toBe(0);
    const project = swarmFixture();
    const unit = "audit-failure";
    seedBoltDag(project, [unit]);
    const prepared = runSwarm(project, [
      "prepare",
      "--batch",
      "1",
      "--units",
      unit,
      "--base",
      "main",
    ]);
    expect(prepared.rc, prepared.out).toBe(0);

    const wt = join(project, ".aidlc", "worktrees", `bolt-${unit}`);
    const source = `${unit}.ts`;
    writeFileSync(
      join(wt, source),
      "export const auditFailure = true;\n",
    );
    const reviewed = review(
      wt,
      seededRecordDir(wt),
      unit,
      [{ path: source }],
    );
    expect(reviewed.request.rc, reviewed.request.out).toBe(0);
    expect(reviewed.verdict.rc, reviewed.verdict.out).toBe(0);
    const finalized = runSwarm(project, [
      "finalize",
      "--batch",
      "1",
      "--units",
      unit,
      "--claimed",
      unit,
      "--check-cmd",
      `"${process.execPath}" -e "require('fs').accessSync('${source}')"`,
    ]);
    expect(finalized.rc, finalized.out).toBe(0);

    const shard = seededAuditShard(project);
    const marker = join(project, ".aidlc", "audit-lock-marker");
    const originalMode = statSync(shard).mode & 0o777;
    const watcher = auditLockWatcher(shard, marker, unit);
    let merge: ReturnType<typeof spawnSync>;
    let locked = false;
    try {
      merge = spawnSync(
        process.execPath,
        [
          WORKTREE,
          "merge",
          "--slug",
          unit,
          "--target",
          "main",
          "--strategy",
          "squash",
          "--project-dir",
          project,
        ],
        { cwd: project, encoding: "utf-8" },
      );
      locked = existsSync(marker);
    } finally {
      watcher.kill();
      chmodSync(shard, originalMode);
      rmSync(marker, { force: true });
    }

    const output = `${merge.stdout ?? ""}${merge.stderr ?? ""}`;
    expect(locked).toBe(true);
    expect(merge.status).not.toBe(0);
    expect(output).toContain("[merge-succeeded:");
    expect(output).toContain("Do not retry this merge");
    expect(existsSync(join(project, source))).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(readAllAuditShards(project)).not.toContain(
      "**Event**: SWARM_SOURCE_MERGED",
    );
  }, 120000);
});

describe("t305 stage and protocol source-attribution requirements", () => {
  test("pins schema, Bolt-relative paths, review freeze, and workspace_requires semantics", () => {
    const stage=readFileSync(STAGE,"utf-8"); const reviewer=readFileSync(join(PROTOCOL,"stage-protocol-reviewer.md"),"utf-8"); const construction=readFileSync(join(PROTOCOL,"stage-protocol-construction.md"),"utf-8"); const definition=readFileSync(join(PROTOCOL,"stage-definition.md"),"utf-8");
    expect(stage).toContain('"version": 1'); expect(stage).toContain("created, modified, or deleted"); expect(stage).toContain("trailing `/` directory claim"); expect(stage).toContain("MUST omit `repo`"); expect(stage).toContain("unclaimed changed paths\nblock stage completion"); expect(stage).toContain("engine-validated against its strict schema");
    expect(reviewer).toContain("differentially at those paths"); expect(reviewer).toContain("source-manifest.json"); expect(reviewer).toContain("claimed source paths");
    expect(construction).toContain("before the in-Bolt review"); expect(construction).toContain("worktree-relative and omit `repo`"); expect(definition).toContain("source-manifest.json"); expect(definition).toContain("stage-entry source baseline");
  });
});
