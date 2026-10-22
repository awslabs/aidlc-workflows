// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, function:resolveArtifactPaths, function:splitConsumesByPresence, function:producedLine, function:commonFolder, function:owedPipelineLinks, function:pipelineLinkWayOn, function:fitPipelineRecord, function:reposNote
//
// #2874: a workspace of very many sibling repositories. Reverse Engineering
// writes nine files per repository, and the step used to list each of them,
// as did every later stage that reads them, the gate's "It produced ..." line
// and the replies that name the owed link commands. At 190 repositories each
// of those printed more than the engine sends in one result, so the work
// stopped before the analysis, one stage after it, at its gate and at a
// "Request Changes". These cases build that workspace (a `.git` folder and one
// file per repository) on the packaged Claude tree (the common 28 KiB limit)
// and the Copilot tree (its declared 19,000 bytes), run the engine as the
// agent would, and pin every printed result under the limit while the gate
// still checks every repository's files.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { cleanupTestProject, createTestProject, FIXTURES_DIR, REPO_ROOT, seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 4);

const COMMON_LIMIT = 28 * 1024;
const TREES = [
  { name: "claude", root: join(REPO_ROOT, "dist", "claude"), dir: ".claude" },
  { name: "copilot", root: join(REPO_ROOT, "dist", "copilot"), dir: ".aidlc" },
] as const;
type Tree = (typeof TREES)[number];
const RE = "reverse-engineering";
const LEAD = "aidlc-developer-agent";
const FINAL = "aidlc-architect-agent";
const ARTIFACTS = [
  "business-overview", "architecture", "code-structure", "api-documentation", "component-inventory",
  "technology-stack", "dependencies", "code-quality-assessment", "reverse-engineering-timestamp",
];
const STATE_FIXTURE = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8");
const STAGE_LINE = /^- \[[ x-]\] ([a-z0-9-]+) \u2014 EXECUTE$/gm;
const FIXTURE_STAGES = [...STATE_FIXTURE.matchAll(STAGE_LINE)].map((match) => match[1] ?? "");

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function limitOf(tree: Tree): number {
  const data = JSON.parse(readFileSync(join(tree.root, tree.dir, "tools", "data", "harness.json"), "utf-8"));
  return typeof data.directiveMaxBytes === "number" ? Math.min(data.directiveMaxBytes, COMMON_LIMIT) : COMMON_LIMIT;
}

const repoNames = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `service-${String(index).padStart(3, "0")}`);

interface Shape {
  repos: number;
  stage: string;
  // The stage's checkbox: in progress, or waiting at its gate.
  mark?: "-" | "?";
  stores?: boolean;
  scope?: string;
  policy?: "strict" | "relaxed" | "off";
  // The gate fires the required-sections sensor once per file (1,710 at 190
  // repos), which these cases are not about.
  sensorsOff?: boolean;
}

// The brownfield feature state with `stage` at `mark`, every earlier stage done,
// in a workspace whose work records `repos` sibling repositories.
function workspace(tree: Tree, shape: Shape): { proj: string; repos: string[] } {
  const proj = createTestProject();
  projects.push(proj);
  cpSync(join(tree.root, tree.dir), join(proj, tree.dir), { recursive: true });
  cpSync(join(tree.root, "aidlc"), join(proj, "aidlc"), { recursive: true });
  const at = FIXTURE_STAGES.indexOf(shape.stage);
  const mark = shape.mark ?? "-";
  let state = STATE_FIXTURE
    .replace(/^(- \*\*Current Stage\*\*: ).*$/m, `$1${shape.stage}`)
    .replace(/^(- \*\*In Progress\*\*: ).*$/m, `$1${shape.stage}`)
    .replace(STAGE_LINE, (line, slug: string) => {
      const index = FIXTURE_STAGES.indexOf(slug);
      return line.replace(/^- \[[ x-]\]/, `- [${index < at ? "x" : index === at ? mark : " "}]`);
    });
  if (shape.scope) state = state.replace(/^- \*\*Scope\*\*: .*/m, `- **Scope**: ${shape.scope}`);
  if (shape.sensorsOff) state = state.replace(/^(- \*\*Scope\*\*: .*)$/m, "$1\n- **Sensors**: off (set by you)");
  if (shape.policy) state = state.replace(/^- \*\*Change Control\*\*: .*/m, `- **Change Control**: ${shape.policy} (set by you)`);
  writeFileSync(seededStateFile(proj), state, "utf-8");
  const repos = repoNames(shape.repos);
  const registry = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
  const rows = JSON.parse(readFileSync(registry, "utf-8"));
  rows[0].repos = repos;
  // The person chose to read all of them; the question before that is
  // t-re-repo-scope's.
  rows[0].repos_named = true;
  writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`);
  for (const repo of repos) {
    mkdirSync(join(proj, repo, ".git"), { recursive: true });
    writeFileSync(join(proj, repo, "main.py"), "print('hello')\n");
    if (shape.stores) {
      const store = join(proj, "aidlc", "spaces", "default", "codekb", repo);
      mkdirSync(store, { recursive: true });
      for (const name of ARTIFACTS) writeFileSync(join(store, `${name}.md`), `# ${name}\n\n## Overview\n\n${repo}\n`);
    }
  }
  return { proj, repos };
}

// Every link of every repository on record for the current attempt, written
// the way `aidlc-log.ts link` writes it: the attempt's start, each developer
// handoff file, then each receipt in chain order.
function recordEveryLink(proj: string, repos: string[], links: string[]): void {
  appendAuditEntry("STAGE_STARTED", { Stage: RE, Agent: LEAD }, proj);
  const record = join(seededStateFile(proj), "..");
  const handoffs = join(record, "inception", RE);
  mkdirSync(handoffs, { recursive: true });
  for (const repo of repos) {
    const handoff = join(handoffs, `developer-scan-${repo}.md`);
    const text = "## Developer Code Scan Results\n\n### Scan Coverage\n\n- src/\n\n## Handoff Summary\n\nCurrent attempt.\n";
    writeFileSync(handoff, text);
    links.forEach((link, index) => {
      const fields: Record<string, string> = { Stage: RE, Link: link, Position: `${index + 1}/${links.length}` };
      if (link === LEAD) {
        fields["Artifact Path"] = handoff.slice(proj.length + 1).replaceAll("\\", "/");
        fields["Artifact SHA256"] = `sha256:${createHash("sha256").update(text).digest("hex")}`;
        fields["Artifact Mtime Ms"] = String(statSync(handoff).mtimeMs);
      }
      fields.Repo = repo;
      appendAuditEntry("PIPELINE_LINK_COMPLETED", fields, proj);
    });
  }
}

type Printed = Record<string, unknown> & { kind?: string };

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

// One engine command as the agent runs it, then every rules part it is handed
// on to, with every result it printed.
function engine(tree: Tree, proj: string, args: string[], env: NodeJS.ProcessEnv = childEnv()): { final: Printed; printed: string[] } {
  const tool = join(proj, tree.dir, "tools", "aidlc-orchestrate.ts");
  const printed: string[] = [];
  let argv = args;
  for (let part = 0; part < 20; part++) {
    const res = spawnSync(process.execPath, [tool, ...argv, "--project-dir", proj], {
      cwd: proj,
      env,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS * 4),
    });
    const stdout = (res.stdout ?? "").trim();
    printed.push(stdout);
    let directive: Printed;
    try {
      directive = JSON.parse(stdout);
    } catch {
      throw new Error(`${args.join(" ")} printed no directive (${res.status}): ${stdout.slice(0, 600)} ${res.stderr ?? ""}`);
    }
    if (directive.kind !== "load-steering") return { final: directive, printed };
    argv = ["continue", String(directive.receipt)];
  }
  throw new Error("the rules parts did not end");
}

function expectWithin(tree: Tree, printed: string[]): void {
  const limit = limitOf(tree);
  for (const result of printed) {
    expect(Buffer.byteLength(result, "utf-8"), `${tree.name}: ${result.slice(0, 300)}`).toBeLessThanOrEqual(limit);
  }
}

const CODEKB = "aidlc/spaces/default/codekb";

describe("Reverse Engineering in a workspace of 190 repositories", () => {
  for (const tree of TREES) {
    test(`${tree.name}: the step starts, naming each file once for every repository`, () => {
      const { proj } = workspace(tree, { repos: 190, stage: RE });
      const { final, printed } = engine(tree, proj, ["next"]);
      expectWithin(tree, printed);
      expect(final.kind, JSON.stringify(final).slice(0, 600)).toBe("run-stage");
      expect(final.produces).toEqual(ARTIFACTS.map((name) => `${CODEKB}/{repo}/${name}.md`));
      expect(String(final.repos_note)).toContain("190");
      expect(String(final.repos_note)).toContain("aidlc/spaces/default/intents/intents.json");
      expect(String(final.narration ?? "")).not.toContain("{repo}");
    });

    test(`${tree.name}: a resume with every link of every repository recorded fits`, () => {
      const { proj, repos } = workspace(tree, { repos: 190, stage: RE, stores: true, scope: "enterprise" });
      recordEveryLink(proj, repos, [LEAD, FINAL]);
      const { final, printed } = engine(tree, proj, ["next"]);
      expectWithin(tree, printed);
      expect(final.kind, JSON.stringify(final).slice(0, 600)).toBe("run-stage");
      const pipeline = final.pipeline as { links: string[]; completed: string[]; record: unknown[]; completed_other_repos?: number };
      expect(pipeline.links).toEqual([LEAD, FINAL]);
      expect(pipeline.record).toEqual([]);
      expect(pipeline.completed).toEqual(repos.slice(0, 9).flatMap((repo) => [`${repo}:${LEAD}`, `${repo}:${FINAL}`]));
      expect(pipeline.completed_other_repos).toBe(181);
    });

    test(`${tree.name}: the stages that read the code knowledge base start after it`, () => {
      for (const stage of ["practices-discovery", "requirements-analysis"]) {
        const { proj } = workspace(tree, { repos: 190, stage, stores: true });
        const { final, printed } = engine(tree, proj, ["next"]);
        expectWithin(tree, printed);
        expect(final.kind, `${stage}: ${JSON.stringify(final).slice(0, 600)}`).toBe("run-stage");
        const consumes = final.consumes as string[];
        expect(consumes).toContain(`${CODEKB}/{repo}/architecture.md`);
        expect(consumes.filter((path) => path.startsWith(`${CODEKB}/`)).every((path) => path.includes("/{repo}/"))).toBe(true);
        expect(String(final.repos_note)).toContain("190");
      }
    });

    test(`${tree.name}: the gate names the repositories in one line and still checks every repository's files`, () => {
      const evidenceOff = childEnv({ AIDLC_DISABLE_ENSEMBLE_EVIDENCE: "1" });
      const { proj } = workspace(tree, { repos: 190, stage: RE, stores: true, sensorsOff: true });
      rmSync(join(proj, CODEKB, "service-100", "architecture.md"));
      const refused = engine(tree, proj, ["report", "--stage", RE, "--result", "awaiting-approval"], evidenceOff);
      expectWithin(tree, refused.printed);
      expect(refused.final.reason_codes, JSON.stringify(refused.final).slice(0, 600)).toEqual(["REQUIRED_ARTIFACTS_MISSING"]);
      writeFileSync(join(proj, CODEKB, "service-100", "architecture.md"), "# architecture\n\n## Overview\n\nback\n");
      const gate = engine(tree, proj, ["report", "--stage", RE, "--result", "awaiting-approval"], evidenceOff);
      expectWithin(tree, gate.printed);
      expect(String(gate.final.narration)).toBe(
        "Reverse Engineering is ready for your review. It produced the code knowledge base of 190 repositories, " +
          `9 files each, in ${CODEKB}/, one folder per repository.`,
      );
      const shownAgain = engine(tree, proj, ["next"], evidenceOff);
      expectWithin(tree, shownAgain.printed);
      expect(shownAgain.final.gate_only).toBe(true);
      expect(String(shownAgain.final.narration)).toStartWith("Reverse Engineering is ready for your review. It produced the code knowledge base of 190 repositories");
    });

    // The state tool's floor, reached through `next` at the open gate: its
    // refusal is the recovery question's way on (54,142 bytes on main).
    test(`${tree.name}: next at an open gate with links still owed names the first repositories' commands`, () => {
      const { proj } = workspace(tree, { repos: 190, stage: RE, mark: "?", stores: true, sensorsOff: true });
      const { final, printed } = engine(tree, proj, ["next"]);
      expectWithin(tree, printed);
      expect(final.kind, JSON.stringify(final).slice(0, 600)).toBe("ask");
      expect(final.reason_codes).toEqual(["PIPELINE_EVIDENCE_MISSING"]);
      const said = JSON.stringify(final);
      expect(said).toContain(`service-008:${LEAD}, and the links of 181 other repositories`);
      expect(said).toContain("--repo service-008");
      expect(said).not.toContain("--repo service-009");
      expect(said).toContain("which names the commands for the other 181 repositories, and shows the gate again once every link is in");
    });
  }
});

describe("the owed link commands in a reply", () => {
  const tree = TREES[1];
  for (const policy of ["strict", "relaxed", "off"] as const) {
    test(`Request Changes at a 190-repository gate under Guard Policy ${policy} names the first repositories' commands`, () => {
      const { proj } = workspace(tree, { repos: 190, stage: RE, mark: "?", stores: true, sensorsOff: true, policy });
      const { final, printed } = engine(tree, proj, [
        "report", "--stage", RE, "--result", "rejected", "--user-input", "Request Changes",
        "--reason", "the payments service needs a deeper scan",
      ], childEnv({ AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" }));
      expectWithin(tree, printed);
      const said = JSON.stringify(final);
      expect(said).toContain("Recorded rejected");
      expect(said).toContain("--repo service-000");
      expect(said).toContain("--repo service-008");
      expect(said).not.toContain("--repo service-009");
      expect(said).toContain("which names the commands for the other 181 repositories");
    });
  }

  test("the gate refused for missing links names whole repositories, and nine or fewer read as before", () => {
    const large = workspace(tree, { repos: 190, stage: RE, stores: true, sensorsOff: true });
    const refused = engine(tree, large.proj, ["report", "--stage", RE, "--result", "awaiting-approval"]);
    expectWithin(tree, refused.printed);
    const said = JSON.stringify(refused.final);
    expect(said).toContain(`service-008:${LEAD}, and the links of 181 other repositories`);
    expect(said).toContain("which names the commands for the other 181 repositories");
    expect(said).not.toContain("service-009");

    const small = workspace(tree, { repos: 9, stage: RE, stores: true, sensorsOff: true });
    const named = JSON.stringify(engine(tree, small.proj, ["report", "--stage", RE, "--result", "awaiting-approval"]).final);
    expect(named).toContain(`service-008:${LEAD}.`);
    expect(named).toContain("--repo service-008");
    expect(named).not.toContain("other repositories");
  });

  test("an approval with links still owed names the approve retry as the step that names the rest", () => {
    const { proj } = workspace(tree, { repos: 190, stage: RE, mark: "?", stores: true, sensorsOff: true });
    const { final, printed } = engine(tree, proj, ["report", "--stage", RE, "--result", "approved", "--user-input", "Approve"],
      childEnv({ AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" }));
    expectWithin(tree, printed);
    const said = JSON.stringify(final);
    expect(said).toContain("--repo service-008");
    expect(said).not.toContain("--repo service-009");
    expect(said).toMatch(/again, which names the commands for the other 181 repositories/);
  });
});

describe("a workspace of two repositories", () => {
  const tree = TREES[0];
  test("the step names both in its note and the gate names both", () => {
    const { proj } = workspace(tree, { repos: 2, stage: RE, stores: true, sensorsOff: true });
    const { final } = engine(tree, proj, ["next"]);
    expect(final.kind).toBe("run-stage");
    expect(final.produces).toEqual(ARTIFACTS.map((name) => `${CODEKB}/{repo}/${name}.md`));
    expect(final.repos_note).toBe("Each path with {repo} is one file per repository this work covers: service-000 and service-001.");
    const gate = engine(tree, proj, ["report", "--stage", RE, "--result", "awaiting-approval"],
      childEnv({ AIDLC_DISABLE_ENSEMBLE_EVIDENCE: "1" }));
    expect(String(gate.final.narration)).toBe(
      "Reverse Engineering is ready for your review. It produced the code knowledge base of service-000 and " +
        `service-001, 9 files each, in ${CODEKB}/, one folder per repository.`,
    );
  });

  test("a consumed file one repository lacks is still listed; one no repository has is left out", () => {
    const { proj } = workspace(tree, { repos: 2, stage: "requirements-analysis", stores: true });
    rmSync(join(proj, CODEKB, "service-000", "architecture.md"));
    for (const repo of ["service-000", "service-001"]) rmSync(join(proj, CODEKB, repo, "code-structure.md"));
    const consumes = engine(tree, proj, ["next"]).final.consumes as string[];
    expect(consumes).toContain(`${CODEKB}/{repo}/architecture.md`);
    expect(consumes).toContain(`${CODEKB}/{repo}/business-overview.md`);
    expect(consumes.some((path) => path.endsWith("code-structure.md"))).toBe(false);
  });
});
