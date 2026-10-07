/**
 * The guard matrix: what a person meets when files change under approved
 * work, for each Guard Policy, review cap and plan approval setting. Each cell
 * drives classic with two Units (or the same stages as a composed scope or a
 * plugin's scope) through the real engine (tests/harness/scope-run.ts, no
 * model), makes one change at the point a person really makes it, and follows
 * every refusal's named step.
 *
 * What a person gets:
 * - Guard Policy off never stops them: no refusal, no fresh review asked for,
 *   no question asked again. At most a recorded CHANGE_ACCEPTED and a notice.
 * - With the policy on (relaxed or strict), at most one question about the
 *   change, and the way out it offers works.
 * - Every refusal names a step and that step works; a refusal that comes back
 *   after its step is a deadlock.
 * - Every decision recorded as theirs is backed by a turn they sent.
 *
 * Each guard rule keeps its owner test; these runs check what the person
 * meets across a whole run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { REPO_ROOT } from "./fixtures.ts";
import {
  activeRecord,
  type AgentStandIn,
  auditEvents,
  type Directive,
  expectedStages,
  field,
  PLAIN_ANSWERS,
  runScope,
  type ScopeRun,
  ScopeRunDeadlock,
  scopeRunProblems,
  type ScopeRunOptions,
  ScopeRunStuck,
  SCOPE_RUN_TIMEOUT_MS,
  cleanupScopeProjects,
  scopeScratchDir,
  sourceStages,
} from "./scope-run.ts";

export type GuardPolicy = "off" | "relaxed" | "strict";
export type ReviewCap = "none" | "advisory" | "adversarial";

export interface GuardCell {
  policy: GuardPolicy;
  review: ReviewCap;
  plan: "on" | "off";
}

/** The changes, each made where a person makes it. */
export const GUARD_CHANGES = {
  /** Unit 2's work edits a file Unit 1 made and the person approved, and claims it. */
  "later-unit-edit": "Unit 2 edits Unit 1's approved file and claims it",
  /** The same edit, left out of Unit 2's manifest. */
  "later-unit-edit-unclaimed": "Unit 2 edits Unit 1's approved file without claiming it",
  /** The person tidies Unit 1's source by hand after approving it. */
  "hand-edit-source": "the person hand-edits Unit 1's approved source",
  /** The person adds a line to the approved requirements before the next stage. */
  "hand-edit-requirements": "the person hand-edits the approved requirements",
  /** The person edits the code plan while its approval waits. */
  "plan-edit": "the person edits the plan while its approval waits",
  /** A pulled commit changes the requirements while Unit 2 generates. */
  pull: "a pulled commit changes the requirements mid-stage",
  /** The person reverts Unit 1's commit before Build and Test. */
  revert: "the person reverts Unit 1's approved commit",
  /** The person asks for a second review at Unit 2's checkpoint. */
  "second-review": "the person asks for a second review after one cycle",
  /** The person stops between Units, the engine is updated, and they resume. */
  "engine-update": "resume after the engine version changes",
  /** While Unit 2's code plan waits, the person asks for Unit 1 to be reviewed again. */
  "review-while-plan-waits": "the person asks for a review of Unit 1 while Unit 2's plan waits",
  /** While Unit 2 builds, its agent edits Unit 1's functional design. */
  "doc-edit-agent": "Unit 2's agent edits Unit 1's functional design",
  /** While Unit 2 builds, the person edits Unit 1's functional design by hand. */
  "doc-edit-hand": "the person hand-edits Unit 1's functional design",
  /** While Unit 2 builds, its agent edits Unit 1's approved code plan. */
  "plan-edit-after-approval-agent": "Unit 2's agent edits Unit 1's approved code plan",
  /** While Unit 2 builds, the person edits Unit 1's approved code plan by hand. */
  "plan-edit-after-approval-hand": "the person hand-edits Unit 1's approved code plan",
  /** While Unit 2 builds, Unit 1's functional design is deleted: it has to be made again. */
  "doc-delete": "Unit 1's functional design is deleted",
} as const;
export type GuardChange = keyof typeof GUARD_CHANGES | "none";

/** Stages classic runs that the matrix leaves out: the cells need Requirements, two Units, their code and Build and Test. */
export const MATRIX_SKIP = [
  "practices-discovery", "user-stories", "refined-mockups", "domain-design", "contract-design",
  "delivery-planning", "functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
];

export const MATRIX_UNITS = ["core", "extra"];

/** Changes to a Unit's documents: their cells walk Functional Design too. */
export const DOCUMENT_CHANGES: ReadonlySet<GuardChange> = new Set<GuardChange>([
  "doc-edit-agent", "doc-edit-hand", "plan-edit-after-approval-agent", "plan-edit-after-approval-hand", "doc-delete",
]);

/** The stages a change's cells leave out. */
export function matrixSkip(change: GuardChange): string[] {
  return DOCUMENT_CHANGES.has(change) ? MATRIX_SKIP.filter((s) => s !== "functional-design") : MATRIX_SKIP;
}

/** Changes to the first Unit's reviewed source after its review. */
const REVIEWED_SOURCE_CHANGES = new Set<GuardChange>(["later-unit-edit", "later-unit-edit-unclaimed", "hand-edit-source", "revert"]);

/** Stand-in hooks that make one change. Each fires once. */
export function changeHooks(change: GuardChange): Partial<ScopeRunOptions> {
  let done = false;
  const once = (when: boolean, act: () => void) => {
    if (!when || done) return;
    done = true;
    act();
  };
  const appendBy = (agent: AgentStandIn, path: string, line: string) =>
    appendFileSync(join(agent.host.proj, path), `${line}\n`);
  const git = (agent: AgentStandIn, ...args: string[]) =>
    execFileSync("git", args, { cwd: agent.host.proj, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  // Unit 1's functional design: the first document its Functional Design wrote.
  const design = (agent: AgentStandIn) => {
    const path = docOf(agent);
    if (!path) agent.fail(`Functional Design wrote no document for ${MATRIX_UNITS[0]}`);
    return path;
  };
  const corePlan = (agent: AgentStandIn) => {
    const plan = agent.plans.get(MATRIX_UNITS[0]);
    if (!plan) agent.fail(`no approved code plan for ${MATRIX_UNITS[0]}`);
    return plan;
  };
  // An edit while Unit 2 builds: the agent's goes through its Write tool, the person's does not.
  const whileExtraBuilds = (edit: (agent: AgentStandIn) => void) => ({
    onCode: (unit: string, agent: AgentStandIn) => {
      once(unit === MATRIX_UNITS[1], () => edit(agent));
      return [];
    },
  });
  const agentAppends = (agent: AgentStandIn, path: string, line: string) =>
    agent.host.write(path, `${readFileSync(join(agent.host.proj, path), "utf-8")}${line}\n`);
  const requirements = (agent: AgentStandIn) => {
    const ra = agent.worked.find((d) => d.stage === "requirements-analysis");
    const path = ((ra?.produces as string[] | undefined) ?? []).find((p) => p.endsWith("requirements.md"));
    if (!path) agent.fail("Requirements Analysis wrote no requirements.md");
    return path;
  };
  switch (change) {
    case "none":
      return {};
    case "later-unit-edit":
    case "later-unit-edit-unclaimed":
      return {
        onCode: (unit, agent) => {
          if (unit !== "extra") return [];
          const core = readFileSync(join(agent.host.proj, "src/core.ts"), "utf-8");
          agent.host.write("src/core.ts", `${core}export const coreTwice = (): number => 84;\n`);
          return change === "later-unit-edit" ? ["src/core.ts"] : [];
        },
      };
    case "hand-edit-source":
      return {
        afterCheckpoint: (unit, _kind, agent) => once(unit === "core", () => appendBy(agent, "src/core.ts", "// tidied by hand")),
      };
    case "hand-edit-requirements":
      return {
        afterApproval: (stage, agent) => {
          once(stage === "requirements-analysis", () => appendBy(agent, requirements(agent), "\n- Also log each call."));
          return undefined;
        },
      };
    case "plan-edit":
      return {
        beforePlanAnswer: (unit, agent) => once(true, () => {
          const plan = agent.plans.get(unit ?? MATRIX_UNITS[0]) ?? [...agent.plans.values()][0];
          if (!plan) agent.fail("no code plan to edit");
          appendBy(agent, plan, "- [ ] Step 3: Add a README line for the function");
        }),
      };
    case "pull":
      return {
        onCode: (unit, agent) => {
          once(unit === "extra", () => {
            const path = requirements(agent);
            appendBy(agent, path, "\n- Return 42 within 10 ms.");
            git(agent, "add", "--", path);
            git(agent, "-c", "user.name=teammate", "-c", "user.email=teammate@example.com", "commit", "-q", "-m", "pulled from main");
          });
          return [];
        },
      };
    case "revert": {
      let coreCommit = "";
      const commit = (agent: AgentStandIn, message: string, paths: string[]) => {
        git(agent, "add", "--", ...paths);
        git(agent, "-c", "user.name=person", "-c", "user.email=person@example.com", "commit", "-q", "-m", message);
        return git(agent, "rev-parse", "HEAD");
      };
      return {
        afterCheckpoint: (unit, _kind, agent) => {
          if (unit === "core" && !coreCommit) coreCommit = commit(agent, "core", ["src/core.ts", "test/core.test.ts"]);
          once(unit === "extra" && coreCommit !== "", () => {
            git(agent, "-c", "user.name=person", "-c", "user.email=person@example.com", "revert", "--no-edit", coreCommit);
          });
        },
      };
    }
    case "second-review": {
      let asked = false;
      return {
        answers: {
          checkpoint: (unit, kind) => {
            if (unit !== "extra" || asked) return PLAIN_ANSWERS.checkpoint(unit, kind);
            asked = true;
            return "Have it reviewed once more before I approve";
          },
        },
      };
    }
    case "review-while-plan-waits":
      return {
        beforePlanAnswer: (_unit, agent) => once(agent.plans.size >= 2, () => {
          agent.person.say("before I approve the plan, have the reviewer look at Unit 1 again");
          agent.reviewAgain("code-generation", MATRIX_UNITS[0]);
        }),
      };
    case "doc-edit-agent":
      return whileExtraBuilds((agent) => agentAppends(agent, design(agent), "\n- Extra also reads the core total."));
    case "doc-edit-hand":
      return whileExtraBuilds((agent) => appendBy(agent, design(agent), "\n- Note from the person: keep totals in cents."));
    case "plan-edit-after-approval-agent":
      return whileExtraBuilds((agent) => agentAppends(agent, corePlan(agent), "- [x] Step 3: Note how extra uses core"));
    case "plan-edit-after-approval-hand":
      return whileExtraBuilds((agent) => appendBy(agent, corePlan(agent), "- [x] Step 3: Note added by hand"));
    case "doc-delete":
      return whileExtraBuilds((agent) => rmSync(join(agent.host.proj, design(agent))));
    case "engine-update":
      return {
        afterCheckpoint: (unit, _kind, agent) => once(unit === "core", () => agent.stopForTheDay(() => updateEngine(agent.host.proj))),
      };
    default:
      throw new Error(`no guard change ${JSON.stringify(change)}`);
  }
}

/** An engine update while no one is in the work: a new version and changed stage text. */
export function updateEngine(proj: string): void {
  const version = join(proj, ".claude", "tools", "aidlc-version.ts");
  const text = readFileSync(version, "utf-8");
  const bumped = text.replace(/AIDLC_VERSION = "(\d+)\.(\d+)\.(\d+)"/, (_, a, b) => `AIDLC_VERSION = "${a}.${Number(b) + 1}.0"`);
  if (bumped === text) throw new Error(`no version to bump in ${version}`);
  writeFileSync(version, bumped);
  for (const stage of ["construction/code-generation.md", "construction/build-and-test.md"]) {
    appendFileSync(join(proj, ".claude", "aidlc-common", "stages", stage), "\n<!-- updated wording -->\n");
  }
}

/** Unit 1's functional design, as its Functional Design wrote it. */
export function docOf(agent: AgentStandIn): string {
  const fd = agent.worked.find((d) => d.stage === "functional-design" && d.unit === MATRIX_UNITS[0]);
  return ((fd?.produces as string[] | undefined) ?? []).find((p) => p.endsWith(".md") && !p.endsWith("-questions.md")) ?? "";
}

export function cellFlags(cell: GuardCell, change: GuardChange = "none"): string[] {
  return ["--skip", matrixSkip(change).join(","), "--guard-policy", cell.policy, "--review", cell.review, "--plan-approval", cell.plan];
}

export interface CellRun {
  cell: GuardCell;
  change: GuardChange;
  composed?: ComposedScope;
  shipped?: boolean;
  run?: ScopeRun;
  stuck?: ScopeRunStuck;
  /** The Guard Policy in force when the change landed (the person may have switched it). */
  policyAtChange: GuardPolicy;
}

export interface CellOptions {
  /** The person switches Guard Policy off after Requirements Analysis. */
  personSwitchesOff?: boolean;
  /** Run a composed scope instead of classic with the matrix's skips. */
  composed?: ComposedScope;
  /** Run classic as it ships: every stage, its own switches, nothing typed. */
  shipped?: boolean;
  /** Fire the guard on every Bash and Write, as Claude Code does (on for changes the guard holds). */
  fullHost?: boolean;
  /**
   * After Units Generation the person asks to build stage by stage, so the
   * design stage runs as waves; with `thenUnits`, once its gate is approved
   * they ask for one Unit at a time again, so each Unit gets its checkpoint.
   */
  stageMajor?: boolean;
  thenUnits?: boolean;
}

/** A scope that does not ship: its file, its stages, and how it gets into the project (a composer's grid by default). */
export interface ComposedScope {
  name: string;
  text: string;
  stages: string[];
  install?: (proj: string) => void;
  /** The scope names no Guard Policy: the cell checks whatever the engine resolved for it. */
  policyFromEngine?: boolean;
}

/**
 * The matrix base as a composed scope: Requirements, two Units, their code and
 * Build and Test, with the given Guard Policy and review cap in its frontmatter.
 */
export function composedCell(name: string, policy: GuardPolicy, review: ReviewCap): ComposedScope {
  const stages = expectedStages("classic", false).filter((s) => !MATRIX_SKIP.includes(s));
  const text = `---
name: ${name}
depth: Standard
keywords: []
description: Requirements, two Units, their code and Build and Test
skeleton: off
review_cap: ${review}
guard_policy: ${policy}
---

# ${name} scope

Standard depth, composed for one piece of work. It pins the requirements, splits
the work into Units, builds each Unit and runs Build and Test. Nothing else runs.
`;
  return { name, text, stages };
}

/** The core stages a plugin puts under its own scope, by phase. */
const PLUGIN_STAGES: Record<string, string> = {
  "requirements-analysis": "inception",
  "units-generation": "inception",
  "code-generation": "construction",
  "build-and-test": "construction",
};

/**
 * The matrix base as a plugin's scope: a synthetic plugin (never a shipped
 * one) whose scope file names the plugin, and whose contributions put
 * Requirements, Units Generation, Code Generation and Build and Test under it
 * (`adds.scopes`). Its compose hook installs it, as Claude Code runs it.
 * With no `policy`, the scope names no Guard Policy.
 */
export function pluginCell(plugin: string, policy: GuardPolicy | null, review: ReviewCap): ComposedScope {
  const stages = expectedStages("classic", false).filter((s) => !MATRIX_SKIP.includes(s));
  const text = [
    "---", `name: ${plugin}`, `plugin: ${plugin}`, "depth: Standard", "keywords: []",
    "description: Requirements, two Units, their code and Build and Test", "skeleton: off",
    `review_cap: ${review}`, ...(policy ? [`guard_policy: ${policy}`] : []), "---", "",
    `# ${plugin} scope`, "", "A team's own flow, shipped in their plugin.", "",
  ].join("\n");
  const install = (proj: string) => {
    const root = scopeScratchDir(`plugin-${plugin}-`);
    const built = join(REPO_ROOT, "dist", "plugins", "test-pro", "claude");
    cpSync(join(built, ".claude-plugin"), join(root, ".claude-plugin"), { recursive: true });
    cpSync(join(built, "hooks"), join(root, "hooks"), { recursive: true });
    const manifest = join(root, ".claude-plugin", "plugin.json");
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf-8")), name: `aidlc-${plugin}` }));
    mkdirSync(join(root, "scopes"), { recursive: true });
    writeFileSync(join(root, "scopes", `${plugin}.md`), text);
    for (const [stage, phase] of Object.entries(PLUGIN_STAGES)) {
      mkdirSync(join(root, "contributions", phase), { recursive: true });
      writeFileSync(join(root, "contributions", phase, `${stage}.md`),
        ["---", `target: ${stage}`, `plugin: ${plugin}`, "adds:", "  scopes:", `    - ${plugin}`, "---", ""].join("\n"));
    }
    const compose = spawnSync(process.execPath, [join(root, "hooks", "compose.ts")], {
      cwd: proj, encoding: "utf-8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".claude" },
    });
    if (compose.status !== 0) throw new Error(`compose of ${plugin} failed: ${compose.stdout}${compose.stderr}`);
    const grid = JSON.parse(readFileSync(join(proj, ".claude", "tools", "data", "scope-grid.json"), "utf-8")) as
      Record<string, { stages: Record<string, string> } | undefined>;
    const routed = Object.entries(grid[plugin]?.stages ?? {}).filter(([, v]) => v === "EXECUTE").map(([slug]) => slug);
    if (JSON.stringify(routed) !== JSON.stringify(stages)) {
      throw new Error(`${plugin}'s scope routes ${JSON.stringify(routed)}, not ${JSON.stringify(stages)}`);
    }
  };
  return { name: plugin, text, stages, install, policyFromEngine: policy === null };
}

/** Install a composed scope the way the composer leaves it: the scope file, its grid column, then a compile. */
export function installComposed(proj: string, scope: ComposedScope): string {
  const file = join(proj, ".claude", "scopes", `aidlc-${scope.name}.md`);
  writeFileSync(file, scope.text);
  const gridPath = join(proj, ".claude", "tools", "data", "scope-grid.json");
  const grid = JSON.parse(readFileSync(gridPath, "utf-8")) as Record<string, { stages: Record<string, string> }>;
  grid[scope.name] = {
    stages: Object.fromEntries(sourceStages().map((s) => [s.slug, scope.stages.includes(s.slug) ? "EXECUTE" : "SKIP"])),
  };
  writeFileSync(gridPath, `${JSON.stringify(grid, null, 2)}\n`);
  const compile = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc-graph.ts"), "compile"], {
    cwd: proj, encoding: "utf-8",
  });
  if (compile.status !== 0) throw new Error(`compile after composing ${scope.name} failed: ${compile.stdout}${compile.stderr}`);
  return file;
}

/** Drive one cell with one change, following every refusal's named step. */
export function runCell(cell: GuardCell, change: GuardChange, options: CellOptions = {}): CellRun {
  const hooks = changeHooks(change);
  const afterRequirements = hooks.afterApproval;
  let switched = false;
  const afterApproval = options.personSwitchesOff
    ? (stage: string, agent: AgentStandIn): Directive | undefined => {
      const then = afterRequirements?.(stage, agent);
      if (stage !== "requirements-analysis" || switched) return then;
      switched = true;
      const answer = agent.personTypes("/aidlc --guard-policy off");
      if (answer.kind === "print" && agent.actOnPrint(answer)) return agent.personTypes("/aidlc");
      return then;
    }
    : afterRequirements;
  // Stage by stage: the person asks once Units Generation is approved, and the agent sets it.
  const beforeWaves = afterApproval;
  const afterAnyApproval = options.stageMajor
    ? (stage: string, agent: AgentStandIn): Directive | undefined => {
      const then = beforeWaves?.(stage, agent);
      const walk = (mode: string, words: string) => {
        agent.person.say(words);
        const set = agent.host.bash(`bun .claude/tools/aidlc-state.ts set-construction-iteration ${mode}`);
        if (set.status !== 0) agent.fail(`${mode} was refused: ${set.stderr || set.stdout}`);
      };
      if (stage === "units-generation") walk("stage-major", "build it stage by stage: every Unit through each stage before the next");
      if (stage === "functional-design" && options.thenUnits) walk("unit-major", "now build one Unit at a time");
      return then;
    }
    : afterApproval;
  const policyAtChange: GuardPolicy = options.personSwitchesOff ? "off" : cell.policy;
  const result: CellRun = { cell, change, policyAtChange, composed: options.composed, shipped: options.shipped };
  const composed = options.composed;
  // The scope's own file, for what it declares, before it is installed.
  const scopeFile = composed ? join(scopeScratchDir("guard-cell-"), `aidlc-${composed.name}.md`) : undefined;
  if (composed && scopeFile) writeFileSync(scopeFile, composed.text);
  try {
    result.run = runScope(composed?.name ?? "classic", {
      // A composed scope carries its own switches; the plan approval axis is still typed.
      flags: composed ? ["--plan-approval", cell.plan] : options.shipped ? [] : cellFlags(cell, change),
      units: MATRIX_UNITS,
      followRefusals: true,
      fullHost: options.fullHost ?? change === "review-while-plan-waits",
      ...hooks,
      afterApproval: afterAnyApproval,
      ...(composed
        ? { scopeFile, prepare: (proj: string) => void (composed.install ?? ((p: string) => installComposed(p, composed)))(proj) }
        : {}),
    });
  } catch (error) {
    if (!(error instanceof ScopeRunStuck)) throw error;
    result.stuck = error;
    result.run = error.run;
  }
  return result;
}

const stateField = (state: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(state)?.[1]?.trim() ?? null;

/** Questions put to the person more than once about the same thing. A learnings question rides along with the checkpoint it belongs to. */
export function askedAgain(agent: AgentStandIn, own: (key: string) => boolean = () => false): string[] {
  const seen = new Map<string, number>();
  for (const a of agent.asked) {
    if (a.what === "learnings" || a.what === "guard recovery") continue;
    const key = `${a.what} at ${a.stage}${a.unit ? ` for ${a.unit}` : ""}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  // One entry per extra presentation; a replay the person asked for is theirs, once.
  return [...seen.entries()].flatMap(([key, n]) => {
    const extra = n - 1 - (own(key) ? 1 : 0);
    return Array.from({ length: Math.max(0, extra) }, (_, i) => `${key} (asked ${i + 2} times)`);
  });
}

/** Everything the cell must show; an empty list is a pass. */
export function cellProblems(c: CellRun): string[] {
  if (c.stuck || !c.run) {
    const kind = c.stuck instanceof ScopeRunDeadlock ? "deadlock" : "stuck";
    return [`${kind}: ${String(c.stuck?.message).split("\n")[0].slice(0, 600)}`];
  }
  const run = c.run;
  const { agent } = run;
  const problems: string[] = [];
  const skip = matrixSkip(c.change);
  const stages = c.composed?.stages ??
    expectedStages("classic", false).filter((s) => c.shipped || !skip.includes(s));
  problems.push(...scopeRunProblems(run, { stages, skip: ["switches"] }).filter((p) =>
    // The person reverted Unit 1's code on purpose.
    !(c.change === "revert" && /the code for core is not at the project root/.test(p))));

  // The cell's switches reached the work.
  const state = readFileSync(activeRecord(run.proj).state, "utf-8");
  const policy = stateField(state, "Guard Policy") ?? "";
  if (c.composed?.policyFromEngine) {
    // The scope names none: check what the person meets under what the engine resolved.
    const resolved = /^(off|relaxed|strict)\b/.exec(policy)?.[1] as GuardPolicy | undefined;
    if (!resolved) problems.push(`state Guard Policy is ${JSON.stringify(policy)}`);
    else c.policyAtChange = resolved;
  } else if (!policy.startsWith(`${c.policyAtChange} `) && policy !== c.policyAtChange) {
    problems.push(`state Guard Policy is ${JSON.stringify(policy)}, the cell runs ${c.policyAtChange}`);
  }
  const plan = stateField(state, "Plan Approval") ?? "";
  if (!plan.startsWith(c.cell.plan)) problems.push(`state Plan Approval is ${JSON.stringify(plan)}, the cell runs ${c.cell.plan}`);
  for (const d of agent.directives.filter((d) => d.kind === "run-stage" && typeof d.reviewer === "string")) {
    if (c.cell.review === "none") problems.push(`review cap none, but ${String(d.stage)} named a reviewer`);
    if (c.cell.review === "advisory" && d.reviewer_max_iterations !== 1) {
      problems.push(`review cap advisory, but ${String(d.stage)} allows ${String(d.reviewer_max_iterations)} passes`);
    }
  }

  // The review the person asked for while the plan waited ran, then.
  if (c.change === "review-while-plan-waits") {
    const rows = auditEvents(run.proj);
    const done = rows.findIndex((e) => e.event === "REVIEW_COMPLETED" && field(e.block, "Unit") === MATRIX_UNITS[0] &&
      field(e.block, "Iteration") === "2");
    const extraPlan = rows.findIndex((e) => e.event === "PLAN_APPROVAL_RECORDED" && field(e.block, "Unit") === MATRIX_UNITS[1]);
    if (done === -1) problems.push(`the review of ${MATRIX_UNITS[0]} the person asked for never completed`);
    else if (extraPlan !== -1 && extraPlan < done) problems.push(`the review of ${MATRIX_UNITS[0]} ran only after the plan was approved`);
  }

  // What the person met because of the change.
  // The second review is asked for at Unit 2's checkpoint, so that checkpoint comes back once.
  const own = (key: string) => c.change === "second-review" && key === "unit checkpoint at code-generation for extra";
  const again = askedAgain(agent, own);
  const recoveries = agent.asked.filter((a) => a.what === "guard recovery").map((a) => `a guard-recovery question at ${a.stage}`);
  const refusals = agent.refusalsMet.map((r) => r.said.split("\n")[0].slice(0, 300));
  const repairs = [...agent.repaired].map((r) => `a fresh review before ${r.split(" ")[0]}'s checkpoint`);
  // A changed document never stops the work under relaxed either. A deleted
  // one has to be made again: that one stop is the only one it may cost.
  const offLike = c.policyAtChange === "off" || (DOCUMENT_CHANGES.has(c.change) && c.policyAtChange === "relaxed");
  const remake = c.change === "doc-delete" ? 1 : 0;
  if (c.change === "doc-delete" && c.run && !existsSync(join(c.run.proj, docOf(c.run.agent)))) {
    problems.push(`${MATRIX_UNITS[0]}'s functional design was never made again`);
  }
  if (offLike) {
    const label = `Guard Policy ${c.policyAtChange}`;
    for (const r of refusals.slice(remake)) problems.push(`${label}, yet the engine refused: ${r}`);
    for (const r of repairs) problems.push(`${label}, yet it asked for ${r}`);
    for (const a of [...again, ...recoveries].slice(remake)) problems.push(`${label}, yet the person was asked again: ${a}`);
  } else if (again.length + recoveries.length > 1 + remake) {
    problems.push(`the person was asked ${again.length + recoveries.length} times about one change: ${[...again, ...recoveries].join("; ")}`);
  }
  return problems;
}

/**
 * The record a change leaves: at most one CHANGE_ACCEPTED row per changed
 * piece of work, naming what changed, and at most one line for the person per
 * row; with no change, none.
 */
export function recordProblems(c: CellRun): string[] {
  if (!c.run) return [`the run stuck before its record could be read: ${String(c.stuck?.message).split("\n")[0].slice(0, 300)}`];
  const problems: string[] = [];
  const rows = auditEvents(c.run.proj).filter((e) => e.event === "CHANGE_ACCEPTED");
  const where = (e: { block: string }) => `${field(e.block, "Stage")}${field(e.block, "Unit") ? ` for ${field(e.block, "Unit")}` : ""}`;
  const lines = c.run.agent.notices;
  const policy = c.composed?.policyFromEngine ? resolvedPolicy(c) : c.policyAtChange;
  // No change, a second review the person asked for, or strict (which asks
  // for a fresh review instead of accepting the change): no row, no line.
  if (c.change === "none" || c.change === "second-review" || policy === "strict") {
    const why = c.change === "none" ? "nothing changed" : c.change === "second-review" ? "only a second review" : "under strict";
    for (const e of rows) problems.push(`${why}, yet CHANGE_ACCEPTED at ${where(e)} says ${JSON.stringify(field(e.block, "Details"))}`);
    for (const line of lines) problems.push(`${why}, yet the person was told: ${JSON.stringify(line)}`);
    return problems;
  }
  // A change to Unit 1's reviewed source under off or relaxed keeps its review
  // and leaves exactly one row and one line.
  if (REVIEWED_SOURCE_CHANGES.has(c.change) && c.cell.review !== "none") {
    if (rows.length !== 1 || field(rows[0].block, "Unit") !== MATRIX_UNITS[0]) {
      problems.push(`Unit 1's reviewed source changed: ${rows.length} CHANGE_ACCEPTED rows (${rows.map(where).join(", ")}), not one for ${MATRIX_UNITS[0]}`);
    }
    if (lines.length !== 1) problems.push(`Unit 1's reviewed source changed: ${lines.length} lines for the person, not one`);
  }
  const seen = new Map<string, number>();
  for (const e of rows) seen.set(where(e), (seen.get(where(e)) ?? 0) + 1);
  for (const [at, n] of seen) if (n > 1) problems.push(`one change, ${n} CHANGE_ACCEPTED rows at ${at}`);
  // With no review there is no source snapshot to name paths from; the row
  // may say so, and the person's line names the Unit instead.
  for (const e of rows.filter((e) => c.cell.review !== "none" && field(e.block, "Changed") === "(paths unavailable)")) {
    problems.push(`CHANGE_ACCEPTED at ${where(e)} names no changed path`);
  }
  if (lines.length > seen.size) problems.push(`${lines.length} change lines for ${seen.size} changed pieces of work: ${JSON.stringify(lines).slice(0, 400)}`);
  return problems;
}

/** The Guard Policy the run recorded in state ("off", "relaxed" or "strict"), or null when it stuck before one. */
export function resolvedPolicy(c: CellRun): string | null {
  if (!c.run) return null;
  const policy = stateField(readFileSync(activeRecord(c.run.proj).state, "utf-8"), "Guard Policy") ?? "";
  return /^(off|relaxed|strict)\b/.exec(policy)?.[1] ?? null;
}

/** The audit rows a change leaves, for a test that checks the record itself. */
export function changeRows(run: ScopeRun): { event: string; stage: string | null; unit: string | null }[] {
  return auditEvents(run.proj)
    .filter((e) => /^(CHANGE_ACCEPTED|GUARD_STOOD_ASIDE)$/.test(e.event))
    .map((e) => ({ event: e.event, stage: field(e.block, "Stage"), unit: field(e.block, "Unit") }));
}

export const cellName = (cell: GuardCell) => `Guard Policy ${cell.policy}, review ${cell.review}, plan approval ${cell.plan}`;

/** One cell of a matrix file: a change under one setting. */
export interface MatrixCase {
  cell: GuardCell;
  change: GuardChange;
  options?: CellOptions;
  /** What else sets the case apart in its name (a composed scope, the person's own switch). */
  label?: string;
  /** The engine block this case hits today: its test is a todo named after it. */
  blocked?: string;
  /** A block that only the record hits today: the record test is a todo named after it. */
  recordBlocked?: string;
}

export const caseName = (c: MatrixCase) => {
  const cell = c.options?.composed?.policyFromEngine
    ? `review ${c.cell.review}, plan approval ${c.cell.plan}`
    : cellName(c.cell);
  return `${GUARD_CHANGES[c.change as keyof typeof GUARD_CHANGES] ?? "nothing changes"}, ${cell}${c.label ? `, ${c.label}` : ""}`;
};

/**
 * A matrix file's tests: per case, what the person meets and what the record
 * keeps, from one run. A case blocked today is one todo named after its block,
 * with the real check as its body, so the fix turns it on.
 */
export function guardMatrixSuite(title: string, cases: MatrixCase[]): void {
  describe(title, () => {
    const runs = new Map<string, CellRun>();
    const runOf = (c: MatrixCase): CellRun => {
      const key = caseName(c);
      let run = runs.get(key);
      if (!run) {
        run = runCell(c.cell, c.change, c.options);
        runs.set(key, run);
        console.log(`guard matrix: ${key}: ${run.run?.ms ?? "stuck"} ms`);
      }
      return run;
    };
    afterAll(cleanupScopeProjects);
    for (const c of cases) {
      const name = caseName(c);
      if (c.blocked) {
        test.todo(`${name} (blocked by: ${c.blocked})`, () => {
          const run = runOf(c);
          expect(cellProblems(run)).toEqual([]);
          expect(recordProblems(run)).toEqual([]);
        }, SCOPE_RUN_TIMEOUT_MS);
        continue;
      }
      const off = (c.options?.personSwitchesOff ? "off" : c.cell.policy) === "off";
      const met = c.options?.composed?.policyFromEngine
        ? "the person meets what the resolved Guard Policy promises"
        : off ? "nothing refuses or asks the person again" : "the person is asked at most once about it";
      test(`${name}: ${met}, and the run reaches done`, () => {
        expect(cellProblems(runOf(c))).toEqual([]);
      }, SCOPE_RUN_TIMEOUT_MS);
      const record = c.change === "none"
        ? `${name}: the record shows no change`
        : `${name}: the record keeps at most one row and one line per changed Unit, naming what changed`;
      const check = () => expect(recordProblems(runOf(c))).toEqual([]);
      if (c.recordBlocked) test.todo(`${record} (blocked by: ${c.recordBlocked})`, check, SCOPE_RUN_TIMEOUT_MS);
      else test(record, check, SCOPE_RUN_TIMEOUT_MS);
    }
  });
}
