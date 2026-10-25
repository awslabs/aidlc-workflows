// covers: file:aidlc-common/protocols/stage-protocol-reviewer.md, file:aidlc-common/protocols/stage-protocol-swarm.md, file:aidlc-common/protocols/stage-protocol-ensemble.md, file:aidlc-common/protocols/stage-protocol-construction.md, file:aidlc-common/protocols/stage-protocol-learnings.md, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  REPO_ROOT,
  resetAidlcEnv,
  runOrchestrateNext,
  seedBoltDagBatches,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const MODULES = [
  "reviewer",
  "swarm",
  "ensemble",
  "construction",
  "learnings",
  "checkpoint",
  "loopback",
  "wave",
  "collaborators",
  "reviewer-unit",
  "reviewer-repair",
  "summary",
  "sensors",
] as const;

let project = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  if (project) cleanupTestProject(project);
  project = "";
});

function directiveFor(
  stage: string,
  scope: string,
  withMainWorkflow = false,
  env: Record<string, string> = {},
): Record<string, unknown> {
  project = createOrchestrationTestProject();
  if (withMainWorkflow) {
    seedStateFile(project, "state-mid-inception.md");
    writeFileSync(
      seededStateFile(project),
      readFileSync(seededStateFile(project), "utf-8")
        .replace("- **Scope**: bugfix", `- **Scope**: ${scope}`),
    );
  }
  const result = runOrchestrateNext(
    ORCHESTRATE,
    project,
    ["--stage", stage, "--single", "--scope", scope],
    {
      cwd: project,
      env: { ...process.env, AWS_AIDLC_DEFAULT_SCOPE: undefined, ...env },
    },
  );
  expect(result.status).toBe(0);
  expect(result.directive?.kind).toBe("run-stage");
  return result.directive as Record<string, unknown>;
}

// An isolated run with no workflow state of its own resolves Guard Policy
// strict, so its review can take the one stale-receipt recovery and lists
// reviewer-repair beside the reviewer.
function moduleList(directive: Record<string, unknown>): string[] {
  const value = directive.protocol_modules;
  return Array.isArray(value) ? value.map(String) : [];
}

function singleRequirementsAuditShard(): string {
  const start = readAuditShardEvents(project).find((entry) =>
    entry.event === "STAGE_STARTED" &&
    auditBlockField(entry.block, "Workflow") === "single-stage:requirements-analysis"
  );
  if (!start) throw new Error("The isolated requirements attempt has no start boundary");
  return start.shard;
}

function seedSingleSummaryQuestions(): void {
  const dir = join(seededRecordDir(project), "inception", "requirements-analysis");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "requirements-analysis-questions.md"),
    "# Questions\n\n## Consolidated Summary Confirmation\n\n" +
      "- Looks correct\n- Request changes\n\n[Answer]: Looks correct\n",
  );
}

function reportSingleRequirements(): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [
      ORCHESTRATE,
      "report",
      "--project-dir", project,
      "--single",
      "--stage", "requirements-analysis",
      "--result", "approved",
    ],
    {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: project,
      encoding: "utf-8",
      env: {
        ...process.env,
        AWS_AIDLC_DEFAULT_SCOPE: undefined,
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: undefined,
      },
    },
  );
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function swarmDirective(): Record<string, unknown> {
  project = createOrchestrationTestProject();
  writeFileSync(
    seededStateFile(project),
    `# AI-DLC State Tracking

## Project Information
- **Project**: protocol module swarm test
- **Project Type**: Greenfield
- **Scope**: feature
- **Construction Autonomy Mode**: autonomous
- **Skeleton Stance**: off
- **State Version**: 8

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`,
  );
  seedBoltDagBatches(project, [["alpha"]]);
  const result = runOrchestrateNext(ORCHESTRATE, project, [], {
    cwd: project,
    env: { ...process.env, AWS_AIDLC_DEFAULT_SCOPE: undefined },
  });
  expect(result.status).toBe(0);
  expect(result.directive?.kind).toBe("invoke-swarm");
  return result.directive as Record<string, unknown>;
}

describe("t302 conditional protocol modules", () => {
  test("conditional module files exist in core and every generated harness tree", () => {
    for (const module of MODULES) {
      expect(
        existsSync(
          join(
            REPO_ROOT,
            "core",
            "aidlc-common",
            "protocols",
            `stage-protocol-${module}.md`,
          ),
        ),
      ).toBe(true);
      for (const harness of HARNESS_MATRIX) {
        expect(
          existsSync(
            join(
              harness.engineRoot,
              "aidlc-common",
              "protocols",
              `stage-protocol-${module}.md`,
            ),
          ),
        ).toBe(true);
      }
    }
  });

  test("classic requirements-analysis keeps the advisory reviewer, learnings, and sensors", () => {
    const directive = directiveFor("requirements-analysis", "classic");
    expect(moduleList(directive)).toEqual(["reviewer", "reviewer-repair", "learnings", "sensors"]);
    expect(directive.reviewer).toBe("aidlc-product-lead-agent");
    expect(directive.review_class).toBe("advisory");
    expect(directive.sensors_applicable).toEqual(["required-sections", "upstream-coverage"]);
    expect(directive.ceremony).toEqual({
      sensors: "on",
      learnings: "on",
      summary_confirmation: "off",
      plan_approval: "on",
      collaborators: "off",
    });
  });

  // bugfix declares learnings and summary confirmation off in its own
  // frontmatter: no "Anything to add for next time?" ritual and no summary to
  // confirm, while sensors, the advisory reviewer, and plan approval stay.
  test("bugfix requirements-analysis keeps the advisory reviewer and sensors, without learnings", () => {
    const directive = directiveFor("requirements-analysis", "bugfix");
    expect(moduleList(directive)).toEqual(["reviewer", "reviewer-repair", "sensors"]);
    expect(directive.review_class).toBe("advisory");
    expect(directive.sensors_applicable).toEqual(["required-sections", "upstream-coverage"]);
    expect(directive.ceremony).toEqual({
      sensors: "on", learnings: "off", summary_confirmation: "off", plan_approval: "on", collaborators: "off",
    });
  });

  test("kill switches omit learnings and sensors while retaining the classic advisory reviewer", () => {
    const directive = directiveFor("requirements-analysis", "classic", false, {
      AIDLC_DISABLE_SENSORS: "1",
      AIDLC_DISABLE_LEARNINGS: "1",
    });
    expect(moduleList(directive)).toEqual(["reviewer", "reviewer-repair"]);
    expect(directive.reviewer).toBe("aidlc-product-lead-agent");
    expect(directive.review_class).toBe("advisory");
    expect(directive.sensors_applicable).toEqual([]);
    expect(directive.ceremony).toEqual({
      sensors: "off", learnings: "off", summary_confirmation: "off", plan_approval: "on", collaborators: "off",
    });
  });

  test("feature requirements-analysis retains active sensor bindings", () => {
    const directive = directiveFor("requirements-analysis", "feature");
    expect(directive.sensors_applicable).toEqual([
      "required-sections",
      "upstream-coverage",
    ]);
    expect(moduleList(directive)).toContain("learnings");
    expect(moduleList(directive)).toContain("summary");
    expect(moduleList(directive)).toContain("sensors");
  });

  // The summary confirmation and the sensor rules come with their ceremony.
  test("summary and sensors are named only when their ceremony is on", () => {
    const express = moduleList(directiveFor("requirements-analysis", "express"));
    expect(express).not.toContain("summary");
    expect(express).not.toContain("sensors");
    const classic = moduleList(directiveFor("requirements-analysis", "classic"));
    expect(classic).not.toContain("summary");
    expect(classic).toContain("sensors");
  });

  test.each([
    { scope: "classic", mainScope: "feature", confirmation: "off", outcome: "done" },
    { scope: "feature", mainScope: "classic", confirmation: "on", outcome: "error" },
  ])("isolated summary policy follows $scope rather than the main workflow", ({
    scope, mainScope, confirmation, outcome,
  }) => {
    const directive = directiveFor("requirements-analysis", scope, true);
    expect(directive.ceremony).toMatchObject({ summary_confirmation: confirmation });
    seedSingleSummaryQuestions();
    // Keep the attempt in the same intent ledger while main-workflow policy changes.
    const shard = singleRequirementsAuditShard();
    const state = readFileSync(seededStateFile(project), "utf-8")
      .replace(`- **Scope**: ${scope}`, `- **Scope**: ${mainScope}`);
    writeFileSync(seededStateFile(project), state);
    const auditBefore = readFileSync(shard, "utf-8");

    const result = reportSingleRequirements();

    expect(result.kind, JSON.stringify(result)).toBe(outcome);
    expect(readFileSync(seededStateFile(project), "utf-8")).toBe(state);
    const auditAfter = readFileSync(shard, "utf-8");
    if (outcome === "done") {
      expect(auditAfter.slice(auditBefore.length)).toContain("**Event**: STAGE_COMPLETED");
      expect(auditAfter.slice(auditBefore.length)).toContain("**Workflow**: single-stage:requirements-analysis");
    } else {
      expect(result.message).toContain("consolidated summary confirmation");
      expect(auditAfter).toBe(auditBefore);
    }
  });

  test("isolated summary policy rejects a different scope while an attempt is open", () => {
    directiveFor("requirements-analysis", "classic");
    const shard = singleRequirementsAuditShard();
    const audit = readFileSync(shard, "utf-8");
    const options = {
      cwd: project,
      env: { ...process.env, AWS_AIDLC_DEFAULT_SCOPE: undefined },
    };

    const changed = runOrchestrateNext(
      ORCHESTRATE,
      project,
      ["--stage", "requirements-analysis", "--single", "--scope", "feature"],
      options,
    );

    expect(changed.directive?.kind, JSON.stringify(changed.directive)).toBe("error");
    expect(readFileSync(shard, "utf-8")).toBe(audit);
    expect(existsSync(seededStateFile(project))).toBe(false);

    const resumed = runOrchestrateNext(
      ORCHESTRATE,
      project,
      ["--stage", "requirements-analysis", "--single", "--scope", "classic"],
      options,
    );

    expect(resumed.directive?.kind, JSON.stringify(resumed.directive)).toBe("run-stage");
    expect(resumed.directive?.ceremony).toMatchObject({ summary_confirmation: "off" });
    expect(readFileSync(shard, "utf-8")).toBe(audit);
    expect(existsSync(seededStateFile(project))).toBe(false);
  });

  test("isolated summary policy remains on for legacy attempts without Scope", () => {
    directiveFor("requirements-analysis", "classic", true);
    seedSingleSummaryQuestions();
    const state = readFileSync(seededStateFile(project), "utf-8");
    const shard = singleRequirementsAuditShard();
    const audit = readFileSync(shard, "utf-8")
      .replace(/^(?:- )?\*\*Scope\*\*:[^\n]*\n/gm, "");
    writeFileSync(shard, audit);

    const result = reportSingleRequirements();

    expect(result.kind, JSON.stringify(result)).toBe("error");
    expect(result.message).toContain("consolidated summary confirmation");
    expect(readFileSync(shard, "utf-8")).toBe(audit);
    expect(readFileSync(seededStateFile(project), "utf-8")).toBe(state);
  });

  // Express declares every ceremony off in its own frontmatter, so the learnings
  // module is absent here as well as the reviewer: review_cap none drops the
  // reviewer, `learnings: off` drops the ritual. Classic still carries it, which
  // the next test pins, so this is the scope's own word rather than a global.
  test("express code-generation omits reviewer and the learnings ritual", () => {
    const modules = moduleList(directiveFor("code-generation", "express"));
    expect(modules).toEqual(["ensemble", "construction", "loopback"]);
    expect(modules).not.toContain("reviewer");
    expect(modules).not.toContain("learnings");
  });

  test("user-stories mob lists the reviewer, ensemble, and learnings", () => {
    const directive = directiveFor("user-stories", "classic");
    expect(moduleList(directive)).toEqual(["reviewer", "reviewer-repair", "ensemble", "learnings", "sensors"]);
    expect(directive.review_class).toBe("advisory");
  });

  test("classic code-generation lists the reviewer, ensemble, construction, loopback, and learnings", () => {
    const directive = directiveFor("code-generation", "classic");
    expect(moduleList(directive)).toEqual(["reviewer", "reviewer-repair", "ensemble", "construction", "loopback", "learnings", "sensors"]);
    expect(directive.review_class).toBe("advisory");
  });

  test("feature inline stage includes learnings without an ordinary reviewer", () => {
    const directive = directiveFor("market-research", "feature");
    expect(moduleList(directive)).toEqual(["learnings", "summary", "sensors"]);
    expect(directive.reviewer).toBeUndefined();
    expect(directive.ceremony).toEqual({
      sensors: "on",
      learnings: "on",
      summary_confirmation: "on",
      plan_approval: "on",
      collaborators: "off",
    });
  });

  test("invoke-swarm lists the reviewer with its Unit and repair parts, construction, checkpoint, loopback, and swarm", () => {
    expect(moduleList(swarmDirective())).toEqual([
      "reviewer",
      "reviewer-unit",
      "reviewer-repair",
      "construction",
      "checkpoint",
      "loopback",
      "swarm",
      "sensors",
    ]);
  });

  // A step reads only the Construction branches it can take: the checkpoint
  // module comes with a checkpoint, the loop-back with Code Generation and
  // Build and Test, the contribution rules with dispatched support agents.
  test("build-and-test lists loopback; an inline design stage lists no branch module", () => {
    expect(moduleList(directiveFor("build-and-test", "classic"))).toEqual(["construction", "loopback", "learnings", "sensors"]);
    const design = moduleList(directiveFor("functional-design", "classic"));
    expect(design).toContain("construction");
    for (const module of ["checkpoint", "loopback", "wave", "collaborators"]) expect(design).not.toContain(module);
  });

  // The repair loop, re-dispatch context and stale-receipt recovery come with a
  // review that can repair: an adversarial one or Guard Policy strict. A
  // first advisory pass or its revision under relaxed or off reads none of them.
  test("an adversarial review names reviewer-repair", () => {
    const adversarial = directiveFor("functional-design", "feature");
    expect(adversarial.review_class).toBe("adversarial");
    expect(moduleList(adversarial)).toContain("reviewer-repair");
  });

  test("an advisory review names reviewer-repair under Guard Policy strict only", () => {
    const reviewStep = (mark: string, policy: string): Record<string, unknown> => {
      if (project) cleanupTestProject(project);
      project = createOrchestrationTestProject();
      seedStateFile(project, "state-mid-inception.md");
      writeFileSync(
        seededStateFile(project),
        readFileSync(seededStateFile(project), "utf-8")
          .replace("- **Scope**: bugfix", "- **Scope**: feature")
          .replace(/^- \*\*Change Control\*\*:.*$/m, `- **Guard Policy**: ${policy}`)
          .replace("- [-] requirements-analysis", `- ${mark} requirements-analysis`),
      );
      const result = runOrchestrateNext(ORCHESTRATE, project, [], {
        cwd: project,
        env: { ...process.env, AWS_AIDLC_DEFAULT_SCOPE: undefined },
      });
      expect(result.directive?.kind, JSON.stringify(result.directive)).toBe("run-stage");
      expect(result.directive?.stage).toBe("requirements-analysis");
      expect(result.directive?.review_class).toBe("advisory");
      return result.directive as Record<string, unknown>;
    };
    const first = moduleList(reviewStep("[-]", "off (from scope feature)"));
    expect(first).toContain("reviewer");
    expect(first).not.toContain("reviewer-repair");
    expect(first).not.toContain("reviewer-unit");
    expect(moduleList(reviewStep("[R]", "off (from scope feature)"))).not.toContain("reviewer-repair");
    expect(moduleList(reviewStep("[-]", "strict (set by you)"))).toContain("reviewer-repair");
  });

  test("collaborators comes only with support agents a stage dispatches", () => {
    expect(moduleList(directiveFor("practices-discovery", "classic"))).toEqual(["ensemble", "learnings", "sensors"]);
    expect(moduleList(directiveFor("practices-discovery", "enterprise"))).toContain("collaborators");
    expect(moduleList(directiveFor("user-stories", "enterprise"))).toContain("collaborators");
    expect(moduleList(directiveFor("reverse-engineering", "enterprise"))).toContain("collaborators");
    expect(moduleList(directiveFor("reverse-engineering", "classic"))).not.toContain("collaborators");
  });
});

// The learnings step asks only about a correction the person made:
// the questions `surface` printed, each with its three choices, and their pick
// is the only thing asked of them (no diary-heading pick after a Yes).
describe("t302 learnings: the one question after a correction", () => {
  const learnings = readFileSync(
    join(import.meta.dir, "../../core/aidlc-common/protocols/stage-protocol-learnings.md"),
    "utf8",
  );

  test("the agent asks the questions surface printed, and routes the heading itself", () => {
    expect(learnings).toContain("3. **Ask the structured questions `surface` printed.**");
    expect(learnings).toContain("Ask each as its own structured question with every option it lists, also when there is only one");
    expect(learnings).toContain("never fold one into another");
    expect(learnings).toContain("--options '|Yes, for this project|Yes, for the team|No' --question-kind learnings-note");
    expect(learnings).toContain("The person never picks a heading or a diary heading");
    expect(learnings).not.toContain("pick one of the four diary headings");
    expect(learnings).not.toContain("Keep none of these");
    expect(learnings).toContain("Otherwise the step asks nothing");
  });
});

// Each branch's text lives in the one module the engine names for it, in core
// and in every shipped tree, so a step that names the module gets it and a
// step that does not reads none of it.
describe("t302 construction branches live in their own modules", () => {
  const MOVED: Array<[string, string]> = [
    ["checkpoint", "### Checkpoint verification and approval"],
    ["loopback", "### Build-and-Test failure loop-back (3.6 \u2192 3.5)"],
    ["wave", "**Per-unit batch waves (optional, stage-major only).**"],
    ["swarm", "### 12b. Autonomous Code Generation Plan Contract"],
    ["collaborators", "### Collaborator contribution files (ensemble topologies)"],
    ["reviewer-unit", "**Reviewer read scope.**"],
    ["reviewer-repair", "**On an `adversarial` review**, branch on the verdict:"],
    ["swarm", "If an autonomous Unit invalidates its one recovery receipt"],
    // A re-review runs on the step already held (Request Changes, a review the
    // person asks for), so its context stays with the reviewer module.
    ["reviewer", "aidlc-review-brief.ts context --stage"],
    ["reviewer", "`Prior findings:` followed by the review-context output verbatim"],
    ["reviewer", "The reviewer also re-runs on the Part 0 revision path"],
    ["summary", "Before presenting it, append or update a dedicated **Consolidated Summary Confirmation**"],
    ["sensors", "A stage's `sensors:` frontmatter list is its complete set of imported checks."],
    ["sensors", "--decision \"Blocking gate sensor failure\""],
    ["loopback", "**Autonomous failure loop-back**"],
    ["loopback", "**Gated failure loop-back**"],
  ];
  const roots = [join(REPO_ROOT, "core"), ...HARNESS_MATRIX.map((harness) => harness.engineRoot)];
  test.each(roots)("each moved section is in exactly one protocol file under %s", (root) => {
    const dir = join(root, "aidlc-common", "protocols");
    const files = readdirSync(dir).filter((file) => file.endsWith(".md"));
    for (const [module, heading] of MOVED) {
      const holders = files.filter((file) => readFileSync(join(dir, file), "utf-8").includes(heading));
      expect(holders, heading).toEqual([`stage-protocol-${module}.md`]);
    }
    const construction = readFileSync(join(dir, "stage-protocol-construction.md"), "utf-8");
    expect(construction).not.toContain("Non-executable future-state");
    // The swarm module's bindings carry the retry-discard line; the reviewer
    // module does not repeat it.
    const reviewer = readFileSync(join(dir, "stage-protocol-reviewer.md"), "utf-8");
    expect(reviewer).not.toContain("because the work changed again after its re-check");
    // Text the engine already does or says, and pointers protocol_note carries.
    const main = readFileSync(join(dir, "stage-protocol.md"), "utf-8");
    for (const cut of [
      "### Conditional construction protocol",
      "### Conditional Construction question protocol",
      "### Conditional ensemble protocol",
      "## Conditional ensemble return protocol",
      "### Conditional reviewer protocol",
      "### Plan and question file location",
      "Example (reduced-scope)",
      "### Knowledge loading order",
      "**Stage advancement** is engine-internal",
      "Stop-hook error delivery retains 32",
      "**Enforcement:** State file updates happen automatically",
    ]) expect(main, cut).not.toContain(cut);
  });
});

// A tool line that sends the agent to a moved part names the file it is in.
describe("t302 tool lines name the module a moved part lives in", () => {
  test("the swarm retry line and the reviewer dispatch-record warning name their modules", () => {
    const log = readFileSync(join(REPO_ROOT, "core", "tools", "aidlc-log.ts"), "utf-8");
    expect(log).toContain("use the retry-discard SAY line in stage-protocol-swarm.md.");
    expect(log).not.toContain("retry-discard SAY line in stage-protocol-reviewer.md");
    const hook = readFileSync(join(REPO_ROOT, "core", "hooks", "aidlc-reviewer-scope.ts"), "utf-8");
    expect(hook).toContain("write the stage-protocol-reviewer-unit.md dispatch record before invoking a per-unit reviewer");
  });
});
