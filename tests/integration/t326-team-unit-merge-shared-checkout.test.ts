// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  auditShardHost,
  auditShardName,
  readApplicableTeamUnitScopeStamp,
  readUnitScopeStamp,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, seededAuditDir, seededRecordDir } from "../harness/fixtures.ts";
import {
  UNIT,
  appendMainHumanTurn,
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

// A Unit claimed in a checkout whose own audit shard main already has: the
// lead's own checkout, where Inception ran, or a copy of that folder carrying
// its clone id. Pin accepts exactly one newly added team shard, so the claim
// keeps the Unit's evidence in a shard of its own, and the lead's shard, rows
// written before the claim included, is published as main has it. Once the
// Unit lands and the lead pulls main, the checkout is no longer held to it.

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

// The lead's Inception record reaches main in the lead's own shard.
function leadShardOnMain(lead: string): string {
  appendMainHumanTurn(lead);
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", "lead inception audit"]);
  git(lead, ["push", "origin", "main"]);
  return auditShardName(lead);
}

// A write into another Unit's record, as the claimed-checkout bound reads it.
function otherUnitWrite(checkout: string): ReturnType<typeof spawnSync> {
  const record = relative(checkout, seededRecordDir(checkout)).replaceAll("\\", "/");
  return spawnSync(process.execPath, [join(AIDLC_SRC, "hooks", "aidlc-reviewer-scope.ts")], {
    cwd: checkout,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `touch ${record}/construction/beta/notes.md` },
      cwd: checkout,
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
    encoding: "utf-8",
  });
}

function cloneShard(checkout: string): string {
  const [token, host] = readFileSync(join(checkout, "aidlc", ".aidlc-clone-id"), "utf-8").split(/\r?\n/);
  return `${host}-${token}.md`;
}

describe("t326 pinned team Unit merge: a claim in a checkout whose shard main has", () => {
  test("the lead's own checkout claims, publishes, and pin, gate and land accept it", () => {
    const { seed: lead, remote } = makeSeed();
    const leadShard = leadShardOnMain(lead);
    const leadShardPath = join(seededAuditDir(lead), leadShard);
    const leadShardOnMainText = readFileSync(leadShardPath, "utf-8");
    // The claim request is the lead's own turn, recorded before the claim and
    // committed with the Unit's work by `git add -A`.
    appendMainHumanTurn(lead);
    const leadShardBeforeClaim = readFileSync(leadShardPath, "utf-8");

    const candidate = prepareCandidate(remote, "alpha", "lead", { checkout: lead });
    // Until the landing reaches it, the checkout stays held to the Unit.
    expect(runMergeTool(UNIT, ["pin", "alpha"], lead).out)
      .toContain("Unit pinning must run from an unscoped main checkout.");
    expect(otherUnitWrite(lead).status).toBe(2);
    const pinner = clone(remote, "pinner");
    gateAndLand(pinner, "alpha");

    expect(candidate.auditShard).not.toBe(leadShard);
    expect(auditShardHost(candidate.auditShard)).toBe(auditShardHost(leadShard));
    expect(readFileSync(leadShardPath, "utf-8")).toBe(leadShardBeforeClaim);
    const record = relative(lead, seededAuditDir(lead)).replaceAll("\\", "/");
    expect(git(pinner, ["show", `HEAD:${record}/${leadShard}`])).toBe(leadShardOnMainText.trim());
    expect(git(pinner, ["show", `HEAD:${record}/${candidate.auditShard}`]))
      .toContain("**Event**: UNIT_COMPLETED");

    // The landed Unit's claim is over once the lead pulls main: the checkout is
    // theirs again, writing their own shard, and the next Unit claims there.
    git(pinner, ["push", "origin", "main"]);
    git(lead, ["pull", "--ff-only", "origin", "main"]);
    expect(readApplicableTeamUnitScopeStamp(lead)).toBeNull();
    expect(auditShardName(lead)).toBe(leadShard);
    expect(otherUnitWrite(lead).status).toBe(0);
    expect(runMergeTool(UNIT, ["pin", "beta"], lead).out).not.toContain("unscoped main checkout");
    expect(nextDirective(lead)).not.toMatchObject({ unit: "alpha" });
    const beta = runMergeTool(UNIT, ["claim", "beta", "--team", "lead"], lead);
    expect(beta.status, beta.out).toBe(0);
    expect(JSON.parse(beta.stdout)).toMatchObject({ claimed: true, unit: "beta" });
  });

  test("after the landing, the claimant checkout takes over a teammate's claim of the next Unit", () => {
    const { seed: lead, remote } = makeSeed();
    leadShardOnMain(lead);
    prepareCandidate(remote, "alpha", "lead", { checkout: lead });
    const pinner = clone(remote, "pinner");
    gateAndLand(pinner, "alpha");
    git(pinner, ["push", "origin", "main"]);
    git(lead, ["pull", "--ff-only", "origin", "main"]);

    const mate = clone(remote, "mate");
    const claimed = runMergeTool(UNIT, ["claim", "beta", "--team", "mate"], mate);
    expect(claimed.status, claimed.out).toBe(0);
    const ref = JSON.parse(claimed.stdout).claim_ref as string;
    git(lead, ["fetch", "origin", `${ref}:${ref}`]);
    git(lead, ["switch", ref.replace(/^refs\/heads\//, "")]);
    const adopted = runMergeTool(UNIT, ["adopt", "beta"], lead);
    expect(adopted.status, adopted.out).toBe(0);
    expect(readApplicableTeamUnitScopeStamp(lead)?.unit).toBe("beta");
  });

  test("a second claim and a second publish in that checkout start nothing new", () => {
    const { seed: lead, remote } = makeSeed();
    leadShardOnMain(lead);
    appendMainHumanTurn(lead);
    const candidate = prepareCandidate(remote, "alpha", "lead", { checkout: lead });

    const again = runMergeTool(UNIT, ["claim", "alpha", "--team", "lead"], lead);
    expect(again.status, again.out).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ recovered: true, audit_shard: candidate.auditShard });
    const republished = runMergeTool(UNIT, ["publish", "alpha"], lead);
    expect(republished.status, republished.out).toBe(0);
    expect(JSON.parse(republished.stdout)).toMatchObject({
      recovered: true,
      candidate_oid: candidate.candidateOid,
      local_rows_withheld: 1,
    });
  });

  test("a copy of the lead's checkout, same clone id, claims and pin accepts it", () => {
    const { seed: lead, remote } = makeSeed();
    const leadShard = leadShardOnMain(lead);
    const copy = clone(remote, "copy");
    copyFileSync(join(lead, "aidlc", ".aidlc-clone-id"), join(copy, "aidlc", ".aidlc-clone-id"));

    const candidate = prepareCandidate(remote, "alpha", "copy", { checkout: copy });
    const pin = runMergeTool(UNIT, ["pin", "alpha"], lead);
    expect(pin.status, pin.out).toBe(0);
    expect(candidate.auditShard).not.toBe(leadShard);

    // A teammate whose own shard main also has takes the attempt over and
    // keeps writing the claim's shard.
    const mate = clone(remote, "mate");
    copyFileSync(join(lead, "aidlc", ".aidlc-clone-id"), join(mate, "aidlc", ".aidlc-clone-id"));
    const ref = readUnitScopeStamp(copy)!.claim_ref;
    git(mate, ["fetch", "origin", `${ref}:${ref}`]);
    git(mate, ["switch", ref.replace(/^refs\/heads\//, "")]);
    const adopted = runMergeTool(UNIT, ["adopt", "alpha"], mate);
    expect(adopted.status, adopted.out).toBe(0);
    expect(auditShardName(mate)).toBe(candidate.auditShard);
  });

  test("a fresh clone still binds its own clone shard", () => {
    const { seed: lead, remote } = makeSeed();
    leadShardOnMain(lead);
    const candidate = prepareCandidate(remote, "alpha", "alpha-fresh");
    expect(candidate.auditShard).toBe(cloneShard(candidate.checkout));
    const pin = runMergeTool(UNIT, ["pin", "alpha"], lead);
    expect(pin.status, pin.out).toBe(0);
  });
});
