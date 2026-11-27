// covers: subcommand:aidlc-worktree:merge, subcommand:aidlc-utility:doctor, audit:SWARM_SOURCE_MERGED

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boltSlugForUnit } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  CHECK, ISOLATED_GIT_ENV, STAGE, cleanupCheckpointFixtures, fixture, reviewRevisedSource, runCheckpointTool, swarm,
  writeUnitSource,
} from "../harness/swarm-checkpoint.ts";
import { AIDLC_SRC, runOrchestrateNext, seededAuditDir } from "../harness/fixtures.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const UNIT = "alpha";

function land(pd: string, extra: string[] = []) {
  return runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
    "merge", "--slug", boltSlugForUnit(UNIT), "--target", "main", "--strategy", "squash", "--project-dir", pd, ...extra,
  ]);
}

function converged(unit = UNIT): string {
  const pd = fixture([unit], CHECK, false, null);
  expect(swarm(pd, ["prepare", "--batch", "1", "--units", unit, "--base", "main"]).code).toBe(0);
  writeUnitSource(pd, unit, 2);
  expect(swarm(pd, ["check", unit]).code).toBe(0);
  reviewRevisedSource(pd, unit, [`src/${unit}.ts`]);
  const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", unit, "--claimed", unit]);
  expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
  return pd;
}

function auditText(pd: string): string {
  const dir = seededAuditDir(pd);
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

function rewriteAudit(pd: string, from: RegExp, to: string): void {
  const dir = seededAuditDir(pd);
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
    const path = join(dir, name);
    const text = readFileSync(path, "utf-8");
    if (from.test(text)) writeFileSync(path, text.replace(from, to));
  }
}

function loseStageBaseline(pd: string): number {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.startsWith("baseline-") && entry.name.endsWith(".tsv")) found.push(path);
    }
  };
  walk(pd);
  for (const path of found) rmSync(path);
  return found.length;
}

function refusalOf(out: string): string {
  const parsed: unknown = JSON.parse(out);
  if (parsed === null || typeof parsed !== "object" || !("error" in parsed) || typeof parsed.error !== "string") {
    throw new Error(`expected a refusal, got ${out}`);
  }
  return parsed.error;
}

function doctorRows(pd: string): string[] {
  const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "doctor", "--verbose", "--project-dir", pd], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd,
    env: { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
    stdout: "pipe",
    stderr: "pipe",
  });
  return `${result.stdout}${result.stderr}`.split("\n");
}

function next(pd: string) {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), pd, [], {
    cwd: pd, env: { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
  });
  expect(result.status, result.out).toBe(0);
  return result.directive!;
}

describe("a converged Unit whose stage-start baseline is not on this machine", () => {
  test("the refusal names the baseline it could not read and the step that starts the links from here", () => {
    const pd = converged();
    expect(loseStageBaseline(pd)).toBeGreaterThan(0);
    const refused = land(pd);
    expect(refused.code).toBe(1);
    const error = refusalOf(`${refused.out}${refused.err}`);
    expect(error).toContain(`stage "${STAGE}" started from`);
    expect(error).toContain("not on this machine");
    expect(error).toContain("--accept-source-baseline");
    expect(error).not.toContain("current source baseline is unavailable");
  });

  test("that step lands the Unit, records the accepted opening, and the batch goes on", () => {
    const pd = converged();
    expect(loseStageBaseline(pd)).toBeGreaterThan(0);
    const landed = land(pd, ["--accept-source-baseline"]);
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    const row = auditText(pd).split("## Swarm Source Merged").at(-1) ?? "";
    expect(row).toContain("**Opening Source**: accepted");
    expect(row).toContain("**Unit name**: alpha");
    expect(row).toContain("**Source Commit**: ");
    expect(next(pd).kind).toBe("run-stage");
  });

  test("a stage start whose baseline is unbindable names that too, and the same step goes on", () => {
    const pd = converged();
    rewriteAudit(pd, /\*\*Source Baseline\*\*: sha256:[0-9a-f]{64}/g, "**Source Baseline**: unbindable");
    const refused = land(pd);
    expect(refused.code).toBe(1);
    const error = refusalOf(`${refused.out}${refused.err}`);
    expect(error).toContain("could not be bound to a listing");
    expect(error).toContain("--accept-source-baseline");
    const landed = land(pd, ["--accept-source-baseline"]);
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    expect(next(pd).kind).toBe("run-stage");
  });

  test("doctor counts a converged Unit awaiting its landing, not an orphan to discard", () => {
    const pd = converged();
    const rows = doctorRows(pd);
    expect(rows.some((row) => row.includes("Orphan worktrees: 0 (1 converged, awaiting landing: bolt-00000001_alpha)"))).toBe(true);
    expect(rows.some((row) => row.includes("Orphan state files: 0") && row.includes("awaiting landing: bolt-00000001_alpha"))).toBe(true);
    expect(rows.some((row) => row.includes("drift") && row.includes("bolt-00000001_alpha"))).toBe(false);
    const fixLine = rows.find((row) => row.includes("unmatched (no audit trail)")) ?? "";
    expect(fixLine).toBe("");
    expect(land(pd).code).toBe(0);
  });
});
