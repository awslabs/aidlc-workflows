// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-utility:recompose
//
// "Approve, and add <Stage> next" at a gate whose plan skips that stage (Requirements Analysis with User Stories,
// Domain Design with Units Generation): the person picks it, the agent runs `next --add <stage>` and the commands
// its step names, and the next `next` starts the added stage. Every step is new: the gate is not asked again and no
// step comes back, under every Guard Policy. The plan rows are the engine's own: intent creation writes a skipped
// stage as an unchecked box marked SKIP.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename,
  auditBlockField,
  findStageBySlug,
  getField,
  readAuditShardEvents,
  setGuardPolicyLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { env, exec, next, projectAt, say, templateProjects, type Exec } from "../harness/aidlc-answers-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const POLICIES = ["off", "relaxed", "strict"] as const;
type Policy = (typeof POLICIES)[number];
// Domain Design's own documents and review are not what this walk is about.
const NO_OUTPUT_CHECKS = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
};

const projects: string[] = [];
afterAll(() => {
  for (const proj of [...projects, ...templateProjects()]) cleanupTestProject(proj);
});

// The Requirements Analysis gate open on a bugfix plan, its skipped stages written as intent creation writes them.
async function gateAt(policy: Policy): Promise<string> {
  const proj = await projectAt("stage-gate");
  projects.push(proj);
  const file = seededStateFile(proj);
  const engineRows = readFileSync(file, "utf-8").replace(/^- \[S\] (\S+) \u2014 SKIP \(bugfix scope\)$/gm, "- [ ] $1 \u2014 SKIP");
  writeFileSync(file, setGuardPolicyLine(engineRows, `${policy} (set by you)`));
  return proj;
}

const tool = (proj: string, path: string, args: string[], extra: Record<string, string> = {}): Promise<Exec> =>
  exec([process.execPath, path, ...args, "--project-dir", proj], { cwd: proj, env: env(proj, { env: extra }) });
const checkbox = (proj: string, slug: string): string | undefined =>
  new RegExp(`^- \\[(.)\\] ${slug} \u2014`, "m").exec(readFileSync(seededStateFile(proj), "utf-8"))?.[1];
const current = (proj: string): string => getField(readFileSync(seededStateFile(proj), "utf-8"), "Current Stage") ?? "";
const approvals = (proj: string, stage: string) => readAuditShardEvents(proj)
  .filter((row) => row.event === "GATE_APPROVED" && auditBlockField(row.block, "Stage") === stage);

// The stage's reviewer's READY verdict on record, as a run leaves it before the gate.
async function reviewedReady(proj: string, stage: string, reviewer: string): Promise<void> {
  const base = ["review", "--stage", stage, "--reviewer", reviewer, "--iteration", "1"];
  const asked = await tool(proj, LOG, base, NO_OUTPUT_CHECKS);
  expect(asked.status, asked.stdout + asked.stderr).toBe(0);
  const reviewFile = (JSON.parse(asked.stdout.split("\n").find((line) => line.startsWith("{")) ?? "{}") as { reviewFile?: string }).reviewFile;
  expect(reviewFile, asked.stdout).toBeDefined();
  writeFileSync(join(proj, reviewFile as string),
    `## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
      "### Findings\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n", "utf-8");
  const ready = await tool(proj, LOG, [...base, "--verdict", "READY"], NO_OUTPUT_CHECKS);
  expect(ready.status, ready.stdout + ready.stderr).toBe(0);
}

// The person picks the offer; the agent runs `next --add <stage>`, then each command its step names, then `next`.
// Every directive on the way is a new one, and the last starts the added stage.
async function pickApproveAndAdd(
  proj: string, gate: string, added: string, label: string, extra: Record<string, string> = {},
): Promise<void> {
  const seen: string[] = [];
  const step = (directive: unknown): void => {
    const key = JSON.stringify(directive);
    expect(seen, key).not.toContain(key);
    seen.push(key);
  };
  expect((await say(proj, "3", "claude")).status).toBe(0);
  const change = await next(proj, ["--add", added]);
  expect(change.status, change.out).toBe(0);
  step(change.directive);
  const message = String(change.directive?.message ?? "");
  expect(message, change.out).toContain(`recompose --add ${added}`);
  expect(message, change.out).toContain(`report --stage ${gate} --result approved`);
  const recomposed = await tool(proj, UTILITY, ["recompose", "--add", added]);
  expect(recomposed.status, recomposed.stdout + recomposed.stderr).toBe(0);
  expect(checkbox(proj, added)).toBe(" ");
  const approved = await tool(proj, ORCHESTRATE, ["report", "--stage", gate, "--result", "approved", "--user-input", label], extra);
  expect(approved.status, approved.stdout + approved.stderr).toBe(0);
  step(JSON.parse(approved.stdout.trim().split("\n").findLast((line) => line.startsWith("{")) ?? "{}"));
  expect(approvals(proj, gate), approved.stdout + approved.stderr).toHaveLength(1);
  const started = await next(proj, []);
  expect(started.status, started.out).toBe(0);
  step(started.directive);
  expect(started.directive?.kind, started.out).toBe("run-stage");
  expect(started.directive?.stage, started.out).toBe(added);
  expect(current(proj)).toBe(added);
  // Once more, as the agent would after a turn: the same stage, never the gate it left.
  const again = await next(proj, []);
  expect(again.directive?.stage, again.out).toBe(added);
  expect(approvals(proj, gate)).toHaveLength(1);
}

describe("t-approve-and-add-walk: Approve, and add <Stage> next adds the stage and starts it, with no step twice", () => {
  for (const policy of POLICIES) {
    test(`${policy}: at Requirements Analysis, "Approve, and add User Stories next"`, async () => {
      const proj = await gateAt(policy);
      expect(checkbox(proj, "user-stories")).toBe(" ");
      await pickApproveAndAdd(proj, "requirements-analysis", "user-stories", "Approve, and add User Stories next");
    });

    test(`${policy}: at Domain Design, "Approve, and add Units Generation next"`, async () => {
      // The person put Domain Design on this bugfix plan at the Requirements Analysis gate; Units Generation stays
      // skipped, so Domain Design's gate offers to add it.
      const proj = await gateAt(policy);
      expect((await say(proj, "Approve, and add Domain Design", "claude")).status).toBe(0);
      expect((await tool(proj, UTILITY, ["recompose", "--add", "domain-design"])).status).toBe(0);
      const approved = await tool(proj, ORCHESTRATE, ["report", "--stage", "requirements-analysis", "--result", "approved", "--user-input", "Approve"]);
      expect(approved.status, approved.stdout + approved.stderr).toBe(0);
      const started = await next(proj, []);
      expect(started.directive?.stage, started.out).toBe("domain-design");
      const dir = join(seededRecordDir(proj), "inception", "domain-design");
      mkdirSync(dir, { recursive: true });
      for (const name of findStageBySlug("domain-design")?.produces ?? []) {
        const file = join(dir, artifactFilename(name));
        writeFileSync(file, `# ${name}\n\n- Task: a title that is never blank.\n`, "utf-8");
        appendAuditEntry("ARTIFACT_CREATED", { File: file }, proj);
      }
      await reviewedReady(proj, "domain-design", findStageBySlug("domain-design")?.reviewer ?? "");
      const gate = await tool(proj, ORCHESTRATE, ["report", "--stage", "domain-design", "--result", "awaiting-approval"], NO_OUTPUT_CHECKS);
      expect(gate.status, gate.stdout + gate.stderr).toBe(0);
      expect(checkbox(proj, "domain-design")).toBe("?");
      expect(checkbox(proj, "units-generation")).toBe(" ");
      await pickApproveAndAdd(proj, "domain-design", "units-generation", "Approve, and add Units Generation next", NO_OUTPUT_CHECKS);
    });
  }
});
