// covers: subcommand:aidlc-log:link, audit:PIPELINE_LINK_COMPLETED, function:pipelineLinkEvidence, function:currentPipelineLinkReceipts, function:pipelineLinks
//
// Pipeline links are durable, ordered completion evidence. The log tool owns
// each receipt; the engine and direct state transitions require the complete
// current-attempt chain before a pipeline stage can gate or complete.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  runOrchestrateNext,
  seedAidlcMemory,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  pipelineLinkEvidence,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const RE_STAGE = "reverse-engineering";
const LEAD = "aidlc-developer-agent";
const FINAL = "aidlc-architect-agent";
const PRODUCES = [
  "business-overview",
  "architecture",
  "code-structure",
  "api-documentation",
  "component-inventory",
  "technology-stack",
  "dependencies",
  "code-quality-assessment",
  "reverse-engineering-timestamp",
];

const projects: string[] = [];
afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop());
});

function pipelineProject(): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-brownfield-init-done.md");
  return proj;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
  return env;
}

function runLog(
  proj: string,
  link: string,
  repo?: string,
  single = false,
): { rc: number; out: string } {
  const args = [
    LOG,
    "link",
    "--stage",
    RE_STAGE,
    "--link",
    link,
    "--project-dir",
    proj,
  ];
  if (repo) args.splice(args.length - 2, 0, "--repo", repo);
  if (single) args.splice(args.length - 2, 0, "--single");
  const result = spawnSync(BUN, args, {
    encoding: "utf-8",
    env: childEnv(),
  });
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function state(
  proj: string,
  args: string[],
  evidenceDisabled = false,
): { rc: number; out: string } {
  const env = childEnv();
  env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
  env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "1";
  if (evidenceDisabled) env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE = "1";
  const result = spawnSync(
    BUN,
    [STATE, ...args, "--project-dir", proj],
    { encoding: "utf-8", env },
  );
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function writeAllCodekbArtifacts(proj: string, repo = basename(proj)): void {
  const dir = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", repo);
  mkdirSync(dir, { recursive: true });
  for (const name of PRODUCES) {
    writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
  }
}

function rewriteIntentRepos(proj: string, repos: string[]): void {
  const registry = join(
    proj,
    "aidlc",
    "spaces",
    DEFAULT_SPACE,
    "intents",
    "intents.json",
  );
  const rows = JSON.parse(readFileSync(registry, "utf-8")) as Array<
    Record<string, unknown>
  >;
  rows[0].repos = repos;
  writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`);
}

describe("t304 pipeline link receipts", () => {
  test("emits the ordered tool-owned receipt fields", () => {
    const proj = pipelineProject();
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);

    const lead = runLog(proj, LEAD);
    expect(lead.rc).toBe(0);
    expect(lead.out).toContain('"emitted":"PIPELINE_LINK_COMPLETED"');
    const final = runLog(proj, FINAL);
    expect(final.rc).toBe(0);

    const audit = readAllAuditShards(proj);
    expect(audit).toContain("**Event**: PIPELINE_LINK_COMPLETED");
    expect(audit).toContain(`**Link**: ${LEAD}`);
    expect(audit).toContain("**Position**: 1/2");
    expect(audit).toContain(`**Link**: ${FINAL}`);
    expect(audit).toContain("**Position**: 2/2");
  });

  test("refuses an out-of-order final link and a repeated link", () => {
    const proj = pipelineProject();
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);

    const early = runLog(proj, FINAL);
    expect(early.rc).not.toBe(0);
    expect(early.out).toContain("out of order");

    expect(runLog(proj, LEAD).rc).toBe(0);
    const repeated = runLog(proj, LEAD);
    expect(repeated.rc).not.toBe(0);
    expect(repeated.out).toContain("already completed this attempt");
  });

  test("a later STAGE_STARTED resets the receipt chain", () => {
    const proj = pipelineProject();
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
    expect(runLog(proj, LEAD).rc).toBe(0);

    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
    const staleFinal = runLog(proj, FINAL);
    expect(staleFinal.rc).not.toBe(0);
    expect(staleFinal.out).toContain("out of order");
    expect(runLog(proj, LEAD).rc).toBe(0);
  });

  test("gate rejection and stage jumps reset the main receipt chain", () => {
    const boundaries: Array<{
      event: string;
      fields: Record<string, string>;
    }> = [
      {
        event: "GATE_REJECTED",
        fields: { Stage: RE_STAGE, Feedback: "Re-run the analysis" },
      },
      {
        event: "STAGE_JUMPED",
        fields: { Source: "requirements-analysis", Target: RE_STAGE },
      },
    ];
    for (const boundary of boundaries) {
      const proj = pipelineProject();
      appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
      expect(runLog(proj, LEAD).rc).toBe(0);
      expect(runLog(proj, FINAL).rc).toBe(0);

      appendAuditEntry(boundary.event, boundary.fields, proj);
      const evidence = pipelineLinkEvidence(proj, {
        slug: RE_STAGE,
        lead_agent: LEAD,
        support_agents: [FINAL],
      });
      expect(evidence.receipts).toEqual([]);
      expect(runLog(proj, FINAL).out).toContain("out of order");
    }
  });

  test("gate-start and approve refuse conductor-written artifacts without the final receipt", () => {
    const proj = pipelineProject();
    writeAllCodekbArtifacts(proj);
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
    expect(runLog(proj, LEAD).rc).toBe(0);

    const gate = state(proj, ["gate-start", RE_STAGE]);
    expect(gate.rc).not.toBe(0);
    expect(gate.out).toContain("PIPELINE_LINK_COMPLETED");
    expect(gate.out).toContain(FINAL);

    expect(state(proj, ["gate-start", RE_STAGE], true).rc).toBe(0);
    const approve = state(
      proj,
      ["approve", RE_STAGE, "--user-input", "Approve"],
    );
    expect(approve.rc).not.toBe(0);
    expect(approve.out).toContain("PIPELINE_LINK_COMPLETED");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
      `- [?] ${RE_STAGE}`,
    );
  });

  test("run-stage resumes with the current-attempt completed link list", () => {
    const proj = pipelineProject();
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
    expect(runLog(proj, LEAD).rc).toBe(0);

    const result = runOrchestrateNext(ORCH, proj, [], { env: childEnv() });
    expect(result.status).toBe(0);
    expect(result.directive?.kind).toBe("run-stage");
    expect(result.directive?.stage).toBe(RE_STAGE);
    expect(result.directive?.pipeline).toEqual({
      links: [LEAD, FINAL],
      completed: [LEAD],
    });
  });

  test("multi-repo intents enforce one ordered chain per repo", () => {
    const proj = pipelineProject();
    rewriteIntentRepos(proj, ["repo-a", "repo-b"]);
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);

    const missingRepo = runLog(proj, LEAD);
    expect(missingRepo.rc).not.toBe(0);
    expect(missingRepo.out).toContain("pass --repo <repo>");

    expect(runLog(proj, LEAD, "repo-a").rc).toBe(0);
    expect(runLog(proj, FINAL, "repo-a").rc).toBe(0);
    const earlyB = runLog(proj, FINAL, "repo-b");
    expect(earlyB.rc).not.toBe(0);
    expect(earlyB.out).toContain("out of order");
    expect(runLog(proj, LEAD, "repo-b").rc).toBe(0);
    expect(runLog(proj, FINAL, "repo-b").rc).toBe(0);

    const audit = readAllAuditShards(proj);
    expect(audit).toContain("**Repo**: repo-a");
    expect(audit).toContain("**Repo**: repo-b");
  });

  test("a reused repo is exempt while the scanned repo still requires its full chain", () => {
    const proj = pipelineProject();
    const repos = ["repo-a", "repo-b"];
    rewriteIntentRepos(proj, repos);
    writeAllCodekbArtifacts(proj, "repo-a");
    writeAllCodekbArtifacts(proj, "repo-b");
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);

    const reused = state(proj, [
      "reuse-artifact",
      RE_STAGE,
      "--decision",
      "keep",
      "--artifacts",
      `aidlc/spaces/${DEFAULT_SPACE}/codekb/repo-a/`,
      "--repo",
      "repo-a",
    ]);
    expect(reused.rc).toBe(0);
    expect(reused.out).toContain('"repo":"repo-a"');
    expect(runLog(proj, LEAD, "repo-b").rc).toBe(0);
    expect(runLog(proj, FINAL, "repo-b").rc).toBe(0);

    const evidence = pipelineLinkEvidence(proj, {
      slug: RE_STAGE,
      lead_agent: LEAD,
      support_agents: [FINAL],
    });
    expect(evidence.reusedRepos).toEqual(["repo-a"]);
    expect(evidence.missing).toEqual([]);
    expect(evidence.completed).toEqual([
      `repo-a:${LEAD}`,
      `repo-a:${FINAL}`,
      `repo-b:${LEAD}`,
      `repo-b:${FINAL}`,
    ]);

    const next = runOrchestrateNext(ORCH, proj, [], { env: childEnv() });
    expect(next.directive?.pipeline).toEqual({
      links: [LEAD, FINAL],
      completed: evidence.completed,
    });
    expect(state(proj, ["gate-start", RE_STAGE]).rc).toBe(0);
  });

  test("modify and redo decisions never grant a repo reuse exemption", () => {
    const proj = pipelineProject();
    const repos = ["repo-a", "repo-b"];
    rewriteIntentRepos(proj, repos);
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);

    for (const decision of ["modify", "redo"]) {
      expect(state(proj, [
        "reuse-artifact",
        RE_STAGE,
        "--decision",
        decision,
        "--artifacts",
        `aidlc/spaces/${DEFAULT_SPACE}/codekb/repo-a/`,
        "--repo",
        "repo-a",
      ]).rc).toBe(0);
    }

    const evidence = pipelineLinkEvidence(proj, {
      slug: RE_STAGE,
      lead_agent: LEAD,
      support_agents: [FINAL],
    });
    expect(evidence.reusedRepos).toEqual([]);
    expect(evidence.missing).toContainEqual({ link: LEAD, repo: "repo-a" });
    expect(evidence.missing).toContainEqual({ link: FINAL, repo: "repo-a" });
  });

  test("--single receipts stay isolated and do not duplicate or satisfy the main chain", () => {
    const proj = pipelineProject();
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);

    expect(runLog(proj, LEAD, undefined, true).rc).toBe(0);
    expect(runLog(proj, FINAL, undefined, true).rc).toBe(0);
    const mainBefore = pipelineLinkEvidence(proj, {
      slug: RE_STAGE,
      lead_agent: LEAD,
      support_agents: [FINAL],
    });
    expect(mainBefore.receipts).toEqual([]);
    expect(mainBefore.missing).toEqual([
      { link: LEAD, repo: null },
      { link: FINAL, repo: null },
    ]);

    expect(runLog(proj, LEAD).rc).toBe(0);
    expect(runLog(proj, FINAL).rc).toBe(0);
    const audit = readAllAuditShards(proj);
    expect(audit).toContain(`**Workflow**: single-stage:${RE_STAGE}`);
  });
});
