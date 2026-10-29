// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { auditShardHost, auditShardName, readUnitScopeStamp } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededAuditDir } from "../harness/fixtures.ts";
import {
  UNIT,
  appendMainHumanTurn,
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

// A Unit claimed in a checkout whose own audit shard main already has: the
// lead's own checkout, where Inception ran, or a copy of that folder carrying
// its clone id. Pin accepts exactly one newly added team shard, so the claim
// keeps the Unit's evidence in a shard of its own, and the lead's shard, rows
// written before the claim included, is published as main has it.

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
    const pinner = clone(remote, "pinner");
    gateAndLand(pinner, "alpha");

    expect(candidate.auditShard).not.toBe(leadShard);
    expect(auditShardHost(candidate.auditShard)).toBe(auditShardHost(leadShard));
    expect(readFileSync(leadShardPath, "utf-8")).toBe(leadShardBeforeClaim);
    const record = relative(lead, seededAuditDir(lead)).replaceAll("\\", "/");
    expect(git(pinner, ["show", `HEAD:${record}/${leadShard}`])).toBe(leadShardOnMainText.trim());
    expect(git(pinner, ["show", `HEAD:${record}/${candidate.auditShard}`]))
      .toContain("**Event**: UNIT_COMPLETED");
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
