// covers: subcommand:aidlc-log:link, audit:PIPELINE_LINK_COMPLETED, function:pipelineLinkEvidence, function:currentPipelineLinkReceipts, function:pipelineLinks, function:checkPipelineLinkEvidence
//
// Pipeline links are durable, ordered completion evidence. The log tool owns
// each receipt; the engine and direct state transitions require the complete
// current-attempt chain before a pipeline stage can gate or complete.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  runOrchestrateNext,
  seedAidlcMemory,
  seededAuditDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  codekbScopeFingerprint,
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
  writeHandoff = true,
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
  if (link === LEAD) {
    const artifact = developerHandoffPath(proj, repo);
    if (writeHandoff) writeDeveloperHandoff(proj, repo);
    args.splice(
      args.length - 2,
      0,
      "--artifact",
      relative(proj, artifact),
    );
  }
  const result = spawnSync(BUN, args, {
    encoding: "utf-8",
    env: childEnv(),
  });
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function developerHandoffPath(proj: string, repo?: string): string {
  return join(
    dirname(seededStateFile(proj)),
    "inception",
    RE_STAGE,
    repo ? `developer-scan-${repo}.md` : "developer-scan.md",
  );
}

function writeDeveloperHandoff(proj: string, repo?: string): void {
  const path = developerHandoffPath(proj, repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "## Developer Code Scan Results\n\n### Scan Coverage\n\n- src/\n\n## Handoff Summary\n\nCurrent attempt.\n",
    "utf-8",
  );
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

function orchestrate(
  proj: string,
  args: string[],
): { rc: number; out: string } {
  const result = spawnSync(
    BUN,
    [ORCH, ...args, "--project-dir", proj],
    { encoding: "utf-8", env: childEnv() },
  );
  return {
    rc: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function report(
  proj: string,
  args: string[],
): { rc: number; out: string; directive: Record<string, unknown> | null } {
  const result = spawnSync(
    BUN,
    [ORCH, "report", ...args, "--project-dir", proj],
    { encoding: "utf-8", env: childEnv() },
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  let directive: Record<string, unknown> | null = null;
  try {
    directive = JSON.parse((result.stdout ?? "").trim()) as Record<
      string,
      unknown
    >;
  } catch {
    // Keep the process output for the assertion that follows.
  }
  return { rc: result.status ?? -1, out, directive };
}

function writeAllCodekbArtifacts(proj: string, repo = basename(proj)): void {
  const dir = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", repo);
  mkdirSync(dir, { recursive: true });
  for (const name of PRODUCES) {
    writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
  }
}

function writeCurrentCodekbStore(
  proj: string,
  registeredRepo?: string,
): { repo: string; source: string; store: string; codekb: string } {
  const repo = registeredRepo ?? basename(proj);
  const sourceRoot = registeredRepo ? join(proj, registeredRepo) : proj;
  mkdirSync(join(sourceRoot, "src"), { recursive: true });
  const init = spawnSync("git", ["init", "-q"], {
    cwd: sourceRoot,
    encoding: "utf-8",
  });
  if (init.status !== 0) {
    throw new Error(`git init failed: ${init.stderr}`);
  }
  const source = join(sourceRoot, "src", "app.ts");
  writeFileSync(source, "export const current = true;\n", "utf-8");
  const fingerprint = codekbScopeFingerprint(
    sourceRoot,
    ["src"],
    registeredRepo ? [] : ["aidlc"],
  );
  if (!fingerprint) throw new Error("could not mint CodeKB scope fingerprint");

  writeAllCodekbArtifacts(proj, repo);
  const codekb = join(
    proj,
    "aidlc",
    "spaces",
    DEFAULT_SPACE,
    "codekb",
    repo,
  );
  writeFileSync(
    join(codekb, "reverse-engineering-timestamp.md"),
    `# Reverse Engineering Timestamp

## Scope of Analysis

\`\`\`yaml
scope_version: 1
kind: partial
intent: fixture
fingerprint: ${fingerprint}
analyzed:
  paths:
    - src
  components: []
shallow:
  paths: []
\`\`\`
`,
    "utf-8",
  );
  return {
    repo,
    source,
    store: `aidlc/spaces/${DEFAULT_SPACE}/codekb/${repo}/`,
    codekb,
  };
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

function auditBlock(
  event: string,
  timestamp: string,
  fields: Record<string, string>,
): string {
  return [
    `## ${event}`,
    `**Timestamp**: ${timestamp}`,
    `**Event**: ${event}`,
    ...Object.entries(fields).map(([key, value]) => `**${key}**: ${value}`),
    "",
    "---",
    "",
  ].join("\n");
}

describe("t315 pipeline link receipts", () => {
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
    expect(audit).toContain("**Artifact Path**:");
    expect(audit).toMatch(/\*\*Artifact SHA256\*\*: sha256:[0-9a-f]{64}/);
    expect(audit).toContain("**Artifact Mtime Ms**:");
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
    const repeated = runLog(proj, LEAD, undefined, false, false);
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

  for (const [evidenceFile, boundaryFile] of [
    ["aaaa-evidence.md", "zzzz-boundary.md"],
    ["zzzz-evidence.md", "aaaa-boundary.md"],
  ]) {
    test(`same-second cross-shard boundaries invalidate receipts and reuse (${evidenceFile})`, () => {
      const proj = pipelineProject();
      rewriteIntentRepos(proj, ["repo-a", "repo-b"]);
      const auditDir = seededAuditDir(proj);
      mkdirSync(auditDir, { recursive: true });
      const prior = "2026-08-25T19:59:59Z";
      const tied = "2026-08-25T20:00:00Z";
      writeFileSync(
        join(auditDir, evidenceFile),
        [
          "# AI-DLC Audit Log\n",
          auditBlock("STAGE_STARTED", prior, {
            Stage: RE_STAGE,
            Agent: LEAD,
          }),
          auditBlock("ARTIFACT_REUSED", tied, {
            Stage: RE_STAGE,
            Decision: "keep",
            Artifacts: `aidlc/spaces/${DEFAULT_SPACE}/codekb/repo-a/`,
            Repo: "repo-a",
          }),
          auditBlock("PIPELINE_LINK_COMPLETED", tied, {
            Stage: RE_STAGE,
            Link: LEAD,
            Position: "1/2",
            Repo: "repo-b",
          }),
          auditBlock("PIPELINE_LINK_COMPLETED", tied, {
            Stage: RE_STAGE,
            Link: FINAL,
            Position: "2/2",
            Repo: "repo-b",
          }),
        ].join(""),
        "utf-8",
      );
      writeFileSync(
        join(auditDir, boundaryFile),
        [
          "# AI-DLC Audit Log\n",
          auditBlock("GATE_REJECTED", tied, {
            Stage: RE_STAGE,
            Feedback: "Revise every repository",
          }),
        ].join(""),
        "utf-8",
      );

      const evidence = pipelineLinkEvidence(proj, {
        slug: RE_STAGE,
        lead_agent: LEAD,
        support_agents: [FINAL],
      });
      expect(evidence.receipts).toEqual([]);
      expect(evidence.reusedRepos).toEqual([]);
      expect(evidence.missing).toEqual([
        { link: LEAD, repo: "repo-a" },
        { link: FINAL, repo: "repo-a" },
        { link: LEAD, repo: "repo-b" },
        { link: FINAL, repo: "repo-b" },
      ]);
    });
  }

  test("rejection cannot mint a fresh developer receipt from the stale handoff", () => {
    const proj = pipelineProject();
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
    expect(runLog(proj, LEAD).rc).toBe(0);
    expect(runLog(proj, FINAL).rc).toBe(0);

    appendAuditEntry(
      "GATE_REJECTED",
      { Stage: RE_STAGE, Feedback: "Rescan" },
      proj,
    );
    const stale = runLog(proj, LEAD, undefined, false, false);
    expect(stale.rc).not.toBe(0);
    expect(stale.out).toMatch(
      /not written in the current stage attempt|not rewritten after its prior pipeline receipt/,
    );

    expect(runLog(proj, LEAD).rc).toBe(0);
  });

  test("post-receipt handoff edits invalidate the whole downstream chain", () => {
    const proj = pipelineProject();
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
    expect(runLog(proj, LEAD).rc).toBe(0);
    expect(runLog(proj, FINAL).rc).toBe(0);

    const handoff = developerHandoffPath(proj);
    const receiptMtime = statSync(handoff).mtimeMs;
    appendFileSync(handoff, "\nPost-receipt edit.\n");
    const evidence = pipelineLinkEvidence(proj, {
      slug: RE_STAGE,
      lead_agent: LEAD,
      support_agents: [FINAL],
    });
    expect(evidence.receipts).toEqual([]);
    expect(evidence.completed).toEqual([]);
    expect(evidence.missing).toEqual([
      { link: LEAD, repo: null },
      { link: FINAL, repo: null },
    ]);

    writeDeveloperHandoff(proj);
    const rewrittenAt = new Date(receiptMtime + 1_000);
    utimesSync(handoff, rewrittenAt, rewrittenAt);
    expect(pipelineLinkEvidence(proj, {
      slug: RE_STAGE,
      lead_agent: LEAD,
      support_agents: [FINAL],
    }).receipts).toEqual([]);

    expect(runLog(proj, LEAD, undefined, false, false).rc).toBe(0);
    expect(pipelineLinkEvidence(proj, {
      slug: RE_STAGE,
      lead_agent: LEAD,
      support_agents: [FINAL],
    }).completed).toEqual([LEAD]);
    expect(runLog(proj, FINAL).rc).toBe(0);
    expect(pipelineLinkEvidence(proj, {
      slug: RE_STAGE,
      lead_agent: LEAD,
      support_agents: [FINAL],
    }).completed).toEqual([LEAD, FINAL]);
  });

  test("gate-start and approve refuse conductor-written artifacts without the final receipt", () => {
    const proj = pipelineProject();
    writeAllCodekbArtifacts(proj);
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
    expect(runLog(proj, LEAD).rc).toBe(0);

    const gate = state(proj, ["gate-start", RE_STAGE]);
    expect(gate.rc).not.toBe(0);
    expect(gate.out).toContain("pipeline handoffs have not been recorded");
    expect(gate.out).toContain(FINAL);

    expect(state(proj, ["gate-start", RE_STAGE], true).rc).toBe(0);
    const approve = state(
      proj,
      ["approve", RE_STAGE, "--user-input", "Approve"],
    );
    expect(approve.rc).not.toBe(0);
    expect(approve.out).toContain("pipeline handoffs have not been recorded");
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

  test("--single first-run lifecycle starts before receipts and stays isolated from the main chain", () => {
    const proj = pipelineProject();
    const directReport = report(proj, [
      "--single",
      "--stage",
      RE_STAGE,
      "--result",
      "completed",
    ]);
    expect(directReport.directive?.kind).toBe("error");
    expect(directReport.out).toContain("no open single-stage");

    const first = runOrchestrateNext(
      ORCH,
      proj,
      ["--scope", "bugfix", "--stage", RE_STAGE, "--single"],
      { env: childEnv() },
    );
    expect(first.status).toBe(0);
    expect(first.directive?.kind).toBe("run-stage");
    expect(first.directive?.single).toBe(true);
    expect(first.directive?.pipeline).toEqual({
      links: [LEAD, FINAL],
      completed: [],
    });

    expect(runLog(proj, LEAD, undefined, true).rc).toBe(0);
    expect(runLog(proj, FINAL, undefined, true).rc).toBe(0);
    const resumed = runOrchestrateNext(
      ORCH,
      proj,
      ["--scope", "bugfix", "--stage", RE_STAGE, "--single"],
      { env: childEnv() },
    );
    expect(
      resumed.directive?.kind,
      JSON.stringify(resumed.directive),
    ).toBe("run-stage");
    expect(resumed.directive?.pipeline).toEqual({
      links: [LEAD, FINAL],
      completed: [LEAD, FINAL],
    });
    writeAllCodekbArtifacts(proj);
    const completed = report(proj, [
      "--single",
      "--stage",
      RE_STAGE,
      "--result",
      "completed",
    ]);
    expect(completed.directive?.kind).toBe("done");

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

    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
    expect(runLog(proj, LEAD).rc).toBe(0);
    expect(runLog(proj, FINAL).rc).toBe(0);
    const audit = readAllAuditShards(proj);
    expect(audit).toContain(`**Workflow**: single-stage:${RE_STAGE}`);
    const singleLifecycle = audit
      .split("\n---\n")
      .filter((block) =>
        block.includes(`**Workflow**: single-stage:${RE_STAGE}`)
      );
    expect(
      singleLifecycle.filter((block) =>
        block.includes("**Event**: STAGE_STARTED")
      ),
    ).toHaveLength(1);
    expect(
      singleLifecycle.filter((block) =>
        block.includes("**Event**: STAGE_COMPLETED")
      ),
    ).toHaveLength(1);
  });

  test("exactly one registered repo stays qualified through isolated routing and receipts", () => {
    const proj = pipelineProject();
    rewriteIntentRepos(proj, ["repo-a"]);

    const first = runOrchestrateNext(
      ORCH,
      proj,
      ["--scope", "bugfix", "--stage", RE_STAGE, "--single"],
      { env: childEnv() },
    );
    expect(first.directive?.pipeline).toEqual({
      links: [LEAD, FINAL],
      completed: [],
    });
    expect(
      (first.directive?.produces as string[]).every((path) =>
        path.startsWith(
          `aidlc/spaces/${DEFAULT_SPACE}/codekb/repo-a/`,
        )
      ),
    ).toBe(true);

    const unqualified = runLog(proj, LEAD, undefined, true);
    expect(unqualified.rc).not.toBe(0);
    expect(unqualified.out).toContain("pass --repo <repo>");
    expect(runLog(proj, LEAD, "repo-a", true).rc).toBe(0);
    expect(runLog(proj, FINAL, "repo-a", true).rc).toBe(0);

    const resumed = runOrchestrateNext(
      ORCH,
      proj,
      ["--scope", "bugfix", "--stage", RE_STAGE, "--single"],
      { env: childEnv() },
    );
    expect(
      resumed.directive?.kind,
      JSON.stringify(resumed.directive),
    ).toBe("run-stage");
    expect(resumed.directive?.pipeline).toEqual({
      links: [LEAD, FINAL],
      completed: [`repo-a:${LEAD}`, `repo-a:${FINAL}`],
    });
    writeAllCodekbArtifacts(proj, "repo-a");
    expect(report(proj, [
      "--single",
      "--stage",
      RE_STAGE,
      "--result",
      "completed",
    ]).directive?.kind).toBe("done");

    const evidence = pipelineLinkEvidence(proj, {
      slug: RE_STAGE,
      lead_agent: LEAD,
      support_agents: [FINAL],
    }, { singleRun: true });
    expect(evidence.repos).toEqual(["repo-a"]);
    expect(evidence.missing).toEqual([]);
    const audit = readAllAuditShards(proj);
    expect(audit).toContain("developer-scan-repo-a.md");
    expect(audit).toContain("**Repo**: repo-a");
  });

  test("isolated all-reuse records fresh authority and refuses a stale next attempt", () => {
    const proj = pipelineProject();
    const current = writeCurrentCodekbStore(proj);
    expect(runOrchestrateNext(
      ORCH,
      proj,
      ["--scope", "bugfix", "--stage", RE_STAGE, "--single"],
      { env: childEnv() },
    ).directive?.kind).toBe("run-stage");

    const reused = state(proj, [
      "reuse-artifact",
      RE_STAGE,
      "--decision",
      "keep",
      "--artifacts",
      current.store,
      "--single",
    ]);
    expect(reused.rc, reused.out).toBe(0);
    expect(reused.out).toContain('"single":true');
    const evidence = pipelineLinkEvidence(proj, {
      slug: RE_STAGE,
      lead_agent: LEAD,
      support_agents: [FINAL],
    }, { singleRun: true });
    expect(evidence.reusedRepos).toEqual([]);
    expect(evidence.completed).toEqual([LEAD, FINAL]);
    expect(evidence.missing).toEqual([]);
    expect(report(proj, [
      "--single",
      "--stage",
      RE_STAGE,
      "--result",
      "completed",
    ]).directive?.kind).toBe("done");
    const lateReuse = state(proj, [
      "reuse-artifact",
      RE_STAGE,
      "--decision",
      "keep",
      "--artifacts",
      current.store,
      "--single",
    ]);
    expect(lateReuse.rc).not.toBe(0);
    expect(lateReuse.out).toContain("run next");

    expect(runOrchestrateNext(
      ORCH,
      proj,
      ["--scope", "bugfix", "--stage", RE_STAGE, "--single"],
      { env: childEnv() },
    ).directive?.kind).toBe("run-stage");
    appendFileSync(current.source, "export const changed = true;\n");
    const stale = state(proj, [
      "reuse-artifact",
      RE_STAGE,
      "--decision",
      "keep",
      "--artifacts",
      current.store,
      "--single",
    ]);
    expect(stale.rc).not.toBe(0);
    expect(stale.out).toContain("is not CURRENT");
  });

  test("isolated mixed reuse accepts fresh reused repos and links only scanned repos", () => {
    const proj = pipelineProject();
    rewriteIntentRepos(proj, ["repo-a", "repo-b"]);
    const reusedRepo = writeCurrentCodekbStore(proj, "repo-a");
    writeCurrentCodekbStore(proj, "repo-b");
    expect(runOrchestrateNext(
      ORCH,
      proj,
      ["--scope", "bugfix", "--stage", RE_STAGE, "--single"],
      { env: childEnv() },
    ).directive?.kind).toBe("run-stage");

    expect(state(proj, [
      "reuse-artifact",
      RE_STAGE,
      "--decision",
      "keep",
      "--artifacts",
      reusedRepo.store,
      "--repo",
      "repo-a",
      "--single",
    ]).rc).toBe(0);
    expect(runLog(proj, LEAD, "repo-b", true).rc).toBe(0);
    expect(runLog(proj, FINAL, "repo-b", true).rc).toBe(0);

    const stage = {
      slug: RE_STAGE,
      lead_agent: LEAD,
      support_agents: [FINAL],
    };
    expect(pipelineLinkEvidence(proj, stage, {
      singleRun: true,
    }).completed).toEqual([
      `repo-a:${LEAD}`,
      `repo-a:${FINAL}`,
      `repo-b:${LEAD}`,
      `repo-b:${FINAL}`,
    ]);

    appendFileSync(reusedRepo.source, "export const changed = true;\n");
    expect(pipelineLinkEvidence(proj, stage, {
      singleRun: true,
    }).missing).toEqual([
      { link: LEAD, repo: "repo-a" },
      { link: FINAL, repo: "repo-a" },
    ]);
    const staleReport = report(proj, [
      "--single",
      "--stage",
      RE_STAGE,
      "--result",
      "completed",
    ]);
    expect(staleReport.directive?.kind).toBe("error");
    expect(staleReport.out).toContain(`repo-a:${LEAD}`);
  });

  test("isolated all-reuse refuses missing, redirected, and invalid required artifacts", () => {
    const cases = [
      {
        artifact: "architecture",
        mutate: (path: string) => rmSync(path),
      },
      {
        artifact: "dependencies",
        mutate: (path: string, current: ReturnType<typeof writeCurrentCodekbStore>) => {
          rmSync(path);
          linkSync(current.source, path);
        },
      },
      {
        artifact: "component-inventory",
        mutate: (path: string) => {
          rmSync(path);
          mkdirSync(path);
        },
      },
    ];

    for (const item of cases) {
      const proj = pipelineProject();
      const current = writeCurrentCodekbStore(proj);
      expect(runOrchestrateNext(
        ORCH,
        proj,
        ["--scope", "bugfix", "--stage", RE_STAGE, "--single"],
        { env: childEnv() },
      ).directive?.kind).toBe("run-stage");
      const stateBefore = readFileSync(seededStateFile(proj), "utf-8");
      item.mutate(join(current.codekb, `${item.artifact}.md`), current);

      const refused = state(proj, [
        "reuse-artifact",
        RE_STAGE,
        "--decision",
        "keep",
        "--artifacts",
        current.store,
        "--single",
      ]);
      expect(refused.rc).not.toBe(0);
      expect(refused.out).toContain("artifact set is incomplete or invalid");
      expect(readAllAuditShards(proj)).not.toContain(
        "**Event**: ARTIFACT_REUSED",
      );
      expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(stateBefore);

      appendAuditEntry("ARTIFACT_REUSED", {
        Stage: RE_STAGE,
        Decision: "keep",
        Artifacts: current.store,
        Workflow: `single-stage:${RE_STAGE}`,
      }, proj);
      const forged = report(proj, [
        "--single",
        "--stage",
        RE_STAGE,
        "--result",
        "completed",
      ]);
      expect(forged.directive?.kind).toBe("error");
      expect(forged.out).toContain("required CodeKB artifacts");
      expect(forged.out).toContain(`${item.artifact}.md`);
      expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(stateBefore);
    }
  });

  test("isolated mixed reuse rejects an incomplete reused repo and incomplete scanned repo", () => {
    const proj = pipelineProject();
    rewriteIntentRepos(proj, ["repo-a", "repo-b"]);
    const repoA = writeCurrentCodekbStore(proj, "repo-a");
    const repoB = writeCurrentCodekbStore(proj, "repo-b");
    expect(runOrchestrateNext(
      ORCH,
      proj,
      ["--scope", "bugfix", "--stage", RE_STAGE, "--single"],
      { env: childEnv() },
    ).directive?.kind).toBe("run-stage");
    const stateBefore = readFileSync(seededStateFile(proj), "utf-8");

    const missingReused = join(repoA.codekb, "architecture.md");
    rmSync(missingReused);
    const refused = state(proj, [
      "reuse-artifact",
      RE_STAGE,
      "--decision",
      "keep",
      "--artifacts",
      repoA.store,
      "--repo",
      "repo-a",
      "--single",
    ]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("architecture.md");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(stateBefore);
    writeFileSync(missingReused, "# architecture\n", "utf-8");
    expect(state(proj, [
      "reuse-artifact",
      RE_STAGE,
      "--decision",
      "keep",
      "--artifacts",
      repoA.store,
      "--repo",
      "repo-a",
      "--single",
    ]).rc).toBe(0);
    expect(runLog(proj, LEAD, "repo-b", true).rc).toBe(0);
    expect(runLog(proj, FINAL, "repo-b", true).rc).toBe(0);

    rmSync(join(repoB.codekb, "dependencies.md"));
    const incompleteScan = report(proj, [
      "--single",
      "--stage",
      RE_STAGE,
      "--result",
      "completed",
    ]);
    expect(incompleteScan.directive?.kind).toBe("error");
    expect(incompleteScan.out).toContain("required CodeKB artifacts");
    expect(incompleteScan.out).toContain(
      "aidlc/spaces/default/codekb/repo-b/dependencies.md",
    );
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(stateBefore);
  });

  test("--single directives resume isolated receipts and reports require the full isolated chain", () => {
    const proj = pipelineProject();
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
    expect(runLog(proj, LEAD).rc).toBe(0);

    const initial = runOrchestrateNext(
      ORCH,
      proj,
      ["--stage", RE_STAGE, "--single"],
      { env: childEnv() },
    );
    expect(initial.directive?.pipeline).toEqual({
      links: [LEAD, FINAL],
      completed: [],
    });

    const noReceipts = orchestrate(proj, [
      "report",
      "--single",
      "--stage",
      RE_STAGE,
      "--result",
      "completed",
    ]);
    expect(noReceipts.out).toContain('"kind":"error"');
    expect(noReceipts.out).toContain("complete an isolated run");
    expect(noReceipts.out).toContain(LEAD);
    expect(noReceipts.out).toContain(FINAL);

    expect(runLog(proj, LEAD, undefined, true).rc).toBe(0);
    const resumed = runOrchestrateNext(
      ORCH,
      proj,
      ["--stage", RE_STAGE, "--single"],
      { env: childEnv() },
    );
    expect(resumed.directive?.pipeline).toEqual({
      links: [LEAD, FINAL],
      completed: [LEAD],
    });

    const partial = orchestrate(proj, [
      "report",
      "--single",
      "--stage",
      RE_STAGE,
      "--result",
      "completed",
    ]);
    expect(partial.out).toContain('"kind":"error"');
    expect(partial.out).toContain(FINAL);

    expect(runLog(proj, FINAL, undefined, true).rc).toBe(0);
    const complete = orchestrate(proj, [
      "report",
      "--single",
      "--stage",
      RE_STAGE,
      "--result",
      "completed",
    ]);
    expect(complete.rc).toBe(0);
    expect(complete.out).toContain('"kind":"done"');
  });
});
