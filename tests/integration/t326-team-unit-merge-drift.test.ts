// covers: subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:gate, subcommand:aidlc-unit:land, audit:UNIT_MERGED, function:UNIT_MERGE_DIR, function:readUnitMergeTransaction, function:unitMergedReceipts

import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readAllAuditShards,
  readUnitMergeTransaction,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  git,
  runMergeTool,
  parallelDependencyBody,
  makeSeed,
  clone,
  prepareCandidate,
  dispatchMerge,
  gateAndLand,
  nextDirective,
} from "../harness/team-unit-merge.ts";

// The pinned merge cases are split across four files
// (t326-team-unit-merge*.test.ts) so the integration tier runs them in
// parallel; the shared fixture is tests/harness/team-unit-merge.ts.

// Several independent Git trees and CLI sessions share each case. Use the
// generous workload backstop for both its work and its afterEach cleanup.
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

describe("t326 pinned team Unit merge", () => {
  test("a concurrently published sibling still pins after main advances", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    prepareCandidate(remote, "alpha", "alpha-parallel");
    prepareCandidate(remote, "beta", "beta-parallel");
    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);
    gateAndLand(seed, "beta");
    expect(
      readAllAuditShards(seed).match(/\*\*Event\*\*: UNIT_MERGED/g) ?? [],
    ).toHaveLength(2);
    expect(nextDirective(seed)).toMatchObject({
      kind: "run-stage",
      stage: "build-and-test",
    });
  });

  test("a rebased candidate republishes against the current integration base", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    prepareCandidate(remote, "alpha", "alpha-rebase");
    const beta = prepareCandidate(remote, "beta", "beta-rebase");
    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);

    git(beta.checkout, ["fetch", "origin", "main"]);
    const betaRow = readFileSync(seededStateFile(beta.checkout), "utf-8")
      .split(/\r?\n/)
      .find((line) => line.startsWith("| beta |"))!;
    const rebased = spawnSync("git", ["rebase", "origin/main"], {
      cwd: beta.checkout,
      encoding: "utf-8",
    });
    const rebaseResult = (result: typeof rebased) => ({
      status: result.status, signal: result.signal, error: result.error?.message,
      stdout: result.stdout, stderr: result.stderr,
    });
    const reportRebaseFailure = (continued?: typeof rebased) => {
      try {
        const probes = [
          ["status", "--porcelain=v1", "--branch"],
          ["ls-files", "--unmerged"],
          ["diff", "--cached", "--name-status"],
          ["rev-parse", "--verify", "REBASE_HEAD"],
          ["rev-parse", "--verify", "HEAD"],
        ].map((args) => ({
          args,
          ...rebaseResult(spawnSync("git", args, {
            cwd: beta.checkout, encoding: "utf-8", timeout: NATIVE_STARTUP_TIMEOUT_MS,
          })),
        }));
        console.error(`t326 rebase diagnostics:\n${JSON.stringify({
          checkout: beta.checkout, initial: rebaseResult(rebased),
          continued: continued ? rebaseResult(continued) : null, probes,
        }, null, 2)}`);
      } catch (error) {
        console.error(`t326 rebase diagnostics unavailable: ${String(error)}`);
      }
    };
    if ((rebased.status ?? 1) !== 0) {
      const statePath = seededStateFile(beta.checkout);
      const stateRelative = statePath
        .slice(beta.checkout.length + 1)
        .replaceAll("\\", "/");
      // Resolve only the expected state conflict. An unrelated Git failure must
      // not cause us to manufacture staged changes and mask the original error.
      const unmerged = spawnSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: beta.checkout, encoding: "utf-8",
      });
      const conflicts = (unmerged.stdout ?? "").split(/\r?\n/).filter(Boolean);
      if (unmerged.status !== 0 || conflicts.length !== 1 || conflicts[0] !== stateRelative) {
        reportRebaseFailure();
      }
      expect(unmerged.status, JSON.stringify({ initial: rebaseResult(rebased), unmerged: rebaseResult(unmerged) })).toBe(0);
      expect(conflicts, JSON.stringify(rebaseResult(rebased))).toEqual([stateRelative]);
      git(beta.checkout, ["checkout", "origin/main", "--", stateRelative]);
      writeFileSync(
        statePath,
        readFileSync(statePath, "utf-8").replace(
          /^\| beta \|.*$/m,
          betaRow,
        ),
      );
      git(beta.checkout, ["add", stateRelative]);
      const continued = spawnSync("git", ["rebase", "--continue"], {
        cwd: beta.checkout,
        encoding: "utf-8",
        env: { ...process.env, GIT_EDITOR: "true" },
      });
      if (continued.status !== 0) reportRebaseFailure(continued);
      expect(continued.status, `${continued.stdout}${continued.stderr}`).toBe(0);
    }
    const rebasedStatePath = seededStateFile(beta.checkout);
    const rebasedState = readFileSync(rebasedStatePath, "utf-8");
    const header = rebasedState
      .split(/\r?\n/)
      .find((line) => line.startsWith("| unit |"))!
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const currentBetaRow = rebasedState
      .split(/\r?\n/)
      .find((line) => line.startsWith("| beta |"))!;
    const betaCells = currentBetaRow
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (betaCells.length < header.length) {
      betaCells.push(...Array(header.length - betaCells.length).fill("[ ]"));
      writeFileSync(
        rebasedStatePath,
        rebasedState.replace(
          currentBetaRow,
          `| ${betaCells.join(" | ")} |`,
        ),
      );
      git(beta.checkout, ["add", rebasedStatePath]);
      git(beta.checkout, ["commit", "-m", "align rebased Unit Progress"]);
    }

    const currentIntegration = git(
      beta.checkout,
      ["rev-parse", "origin/main"],
    );
    const published = runMergeTool(UNIT, ["publish", "beta"], beta.checkout);
    expect(published.status, published.out).toBe(0);
    const candidateOid = JSON.parse(published.stdout).candidate_oid as string;
    const payload = JSON.parse(
      git(beta.checkout, [
        "show",
        `${candidateOid}:.aidlc-unit-claim.json`,
      ]),
    );
    expect(payload.base_oid).toBe(currentIntegration);

    const pin = runMergeTool(UNIT, ["pin", "beta"], seed);
    expect(pin.status, pin.out).toBe(0);
    dispatchMerge(
      seed,
      "beta",
      JSON.parse(pin.stdout).pinned_oid,
      JSON.parse(pin.stdout).generation,
    );
    expect(
      runMergeTool(
        UNIT,
        ["gate", "beta", "--decision", "approve", "--user-input", "Approve"],
        seed,
      ).status,
    ).toBe(0);
    expect(runMergeTool(UNIT, ["land", "beta"], seed).status).toBe(0);
  });

  test("pin refuses a candidate whose live Unit contract changed on main", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "stale-contract");
    const dependency = join(
      seededRecordDir(seed),
      "inception",
      "units-generation",
      "unit-of-work-dependency.md",
    );
    writeFileSync(
      dependency,
      readFileSync(dependency, "utf-8").replace(
        "  - name: alpha\n    depends_on: [skeleton]",
        "  - name: alpha\n    kind: service\n    depends_on: [skeleton]",
      ),
    );
    git(seed, ["add", dependency]);
    git(seed, ["commit", "-m", "change alpha live contract"]);
    git(seed, ["push", "origin", "main"]);
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status).not.toBe(0);
    expect(pin.out).toContain("stale Construction contract");
    expect(pin.out).toContain("rebase");
  });

  test("re-pinning the same candidate requires a new dispatch bracket", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "repin-dispatch");
    const first = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(first.status, first.out).toBe(0);
    const firstPayload = JSON.parse(first.stdout);
    dispatchMerge(seed, "alpha", firstPayload.pinned_oid, firstPayload.generation);
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "reject", "--user-input", "Reject"],
        seed,
      ).status,
    ).toBe(0);
    const second = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(second.status, second.out).toBe(0);
    expect(JSON.parse(second.stdout).pin_id).not.toBe(firstPayload.pin_id);
    const gate = runMergeTool(
      UNIT,
      ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
      seed,
    );
    expect(gate.status).not.toBe(0);
    expect(gate.out).toContain("MERGE_DISPATCH_INVOKED after pinning");
  });

  test("landing rejects an unrelated dirty audit shard from main", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "dirty-audit");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    const payload = JSON.parse(pin.stdout);
    dispatchMerge(seed, "alpha", payload.pinned_oid, payload.generation);
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        seed,
      ).status,
    ).toBe(0);
    const forged = join(seededAuditDir(seed), "forged.md");
    writeFileSync(
      forged,
      "## Forged\n**Timestamp**: 2099-01-01T00:00:00Z\n" +
        "**Event**: WORKFLOW_STARTED\n\n---\n",
    );
    const head = git(seed, ["rev-parse", "HEAD"]);
    const landed = runMergeTool(UNIT, ["land", "alpha", "--step", "git"], seed);
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain("clean source worktree");
    expect(landed.out).toContain("forged.md");
    expect(git(seed, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(forged, "utf-8")).toContain("WORKFLOW_STARTED");
  });

  test("landing refuses live Unit contract drift after merge approval", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "land-contract-drift");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    const payload = JSON.parse(pin.stdout);
    dispatchMerge(seed, "alpha", payload.pinned_oid, payload.generation);
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        seed,
      ).status,
    ).toBe(0);

    const dependency = join(
      seededRecordDir(seed),
      "inception",
      "units-generation",
      "unit-of-work-dependency.md",
    );
    writeFileSync(
      dependency,
      readFileSync(dependency, "utf-8").replace(
        "  - name: alpha\n    depends_on: [skeleton]",
        "  - name: alpha\n    kind: service\n    depends_on: [skeleton]",
      ),
    );
    git(seed, ["add", dependency]);
    git(seed, ["commit", "-m", "change alpha contract after gate"]);
    git(seed, ["push", "origin", "main"]);
    const head = git(seed, ["rev-parse", "HEAD"]);

    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain("stale Construction contract");
    expect(landed.out).toContain("rebase");
    expect(git(seed, ["rev-parse", "HEAD"])).toBe(head);
    expect(readUnitMergeTransaction(seed, "alpha")?.status).toBe("approved");
  });

  test("landing refuses a stale local target after the remote integration branch advances", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "stale-target");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    const payload = JSON.parse(pin.stdout);
    dispatchMerge(seed, "alpha", payload.pinned_oid, payload.generation);
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        seed,
      ).status,
    ).toBe(0);

    const advancing = clone(remote, "remote-advance");
    writeFileSync(
      join(advancing, "src", "remote-only.ts"),
      "export const remoteOnly = true;\n",
    );
    git(advancing, ["add", "src/remote-only.ts"]);
    git(advancing, ["commit", "-m", "advance remote integration"]);
    git(advancing, ["push", "origin", "main"]);

    const head = git(seed, ["rev-parse", "HEAD"]);
    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status).not.toBe(0);
    const error = JSON.parse(landed.out).error as string;
    expect(error).toContain('local target "main" is stale');
    expect(error).toContain("Fast-forward or rebase");
    expect(git(seed, ["rev-parse", "HEAD"])).toBe(head);
    expect(readUnitMergeTransaction(seed, "alpha")?.status).toBe("approved");
  });
});
