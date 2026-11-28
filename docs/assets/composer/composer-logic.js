// Pure logic behind the Interactive composer page: no DOM, no fetch.
//
// The page (composer.js) and the unit test (tests/unit/t4024-docs-composer.test.ts)
// both import this file, so what the browser shows is exactly what the test
// pins against the engine. The data it reads is generated from core/ by
// scripts/docs-composer-data.ts.
//
// Each rule below mirrors one engine function, named next to it; the test
// compares the two for every stock scope.

/** The settings a scope starts with, as the form shows them. */
export function scopeDefaults(data, scopeName) {
  const scope = findScope(data, scopeName);
  const ceremony = {};
  for (const { key } of data.flags.ceremony) ceremony[key] = scope.ceremony[key];
  const grid = {};
  for (const stage of data.stages) grid[stage.slug] = scope.stages[stage.slug] === "EXECUTE";
  return {
    scope: scope.name,
    projectType: "detect",
    guardPolicy: scope.guardPolicy,
    depth: scope.depth,
    testStrategy: null,
    review: null,
    ceremony,
    grid,
    description: "",
  };
}

export function findScope(data, scopeName) {
  const scope = data.scopes.find((candidate) => candidate.name === scopeName);
  if (!scope) throw new Error(`Unknown scope "${scopeName}".`);
  return scope;
}

/** The test strategy a run gets when none is set: the scope's own, else the
 *  depth (aidlc-utility.ts: `scopeDef.testStrategy ?? effectiveDepth`). */
export function defaultTestStrategy(data, state) {
  return findScope(data, state.scope).testStrategy ?? state.depth;
}

/** The review ceiling with no override: the scope's cap, else none (stages run
 *  as declared, which is what `adversarial` means as a ceiling). */
export function defaultReview(data, state) {
  return findScope(data, state.scope).reviewCap ?? "adversarial";
}

export function effectiveTestStrategy(data, state) {
  return state.testStrategy ?? defaultTestStrategy(data, state);
}

export function effectiveReview(data, state) {
  return state.review ?? defaultReview(data, state);
}

function isInitialization(stage) {
  return stage.phase === "initialization";
}

/** The stages the person changed against the scope (planChangesBetween in
 *  aidlc-lib.ts), in stage order. Initialization stages never change. */
export function planChanges(data, state) {
  const scope = findScope(data, state.scope);
  const skip = [];
  const add = [];
  for (const stage of data.stages) {
    if (isInitialization(stage)) continue;
    const base = scope.stages[stage.slug] === "EXECUTE";
    const wanted = state.grid[stage.slug] === true;
    if (base && !wanted) skip.push(stage.slug);
    if (!base && wanted) add.push(stage.slug);
  }
  return { skip, add };
}

/** The plan as a {slug: EXECUTE|SKIP} grid, as planWithChanges builds it. */
export function planGrid(data, state) {
  const scope = findScope(data, state.scope);
  const grid = {};
  for (const stage of data.stages) {
    grid[stage.slug] = isInitialization(stage)
      ? scope.stages[stage.slug]
      : state.grid[stage.slug] === true ? "EXECUTE" : "SKIP";
  }
  return grid;
}

function scopeGrid(data, scopeName) {
  return { ...findScope(data, scopeName).stages };
}

function projectTypeOf(state) {
  return state.projectType === "greenfield" || state.projectType === "brownfield" ? state.projectType : undefined;
}

/** The grid as creation runs it: a new project skips Reverse Engineering
 *  (asCreated in aidlc-graph.ts). */
export function asCreated(grid, projectType) {
  return projectType === "greenfield" && grid["reverse-engineering"] === "EXECUTE"
    ? { ...grid, "reverse-engineering": "SKIP" }
    : grid;
}

/** Stage, gate and per-class review counts (gridCostSummary in aidlc-lib.ts
 *  for stages and gates; resolveReviewClass for reviews). */
export function planSummary(data, state) {
  const grid = asCreated(planGrid(data, state), projectTypeOf(state));
  const ceiling = effectiveReview(data, state);
  const rank = { none: 0, advisory: 1, adversarial: 2 };
  let execute = 0;
  let gates = 0;
  const reviews = { adversarial: 0, advisory: 0 };
  for (const stage of data.stages) {
    if (grid[stage.slug] !== "EXECUTE") continue;
    execute++;
    if (!isInitialization(stage)) gates++;
    if (stage.reviewClass === null) continue;
    const effective = rank[ceiling] < rank[stage.reviewClass] ? ceiling : stage.reviewClass;
    if (effective !== "none") reviews[effective]++;
  }
  return { total: data.stages.length, execute, skip: data.stages.length - execute, gates, reviews };
}

/** Each required input a grid leaves unmade, in stage then consume order
 *  (unmadeInputs in aidlc-graph.ts). */
export function unmadeInputs(data, grid, projectType) {
  const onPath = new Set(data.stages.filter((stage) => grid[stage.slug] === "EXECUTE").map((stage) => stage.slug));
  const unmade = [];
  for (const stage of data.stages) {
    if (!onPath.has(stage.slug)) continue;
    for (const consume of stage.consumes) {
      if (!consume.required) continue;
      if (consume.conditional_on && projectType && consume.conditional_on !== projectType) continue;
      const producers = data.stages.filter((candidate) => candidate.produces.includes(consume.artifact));
      if (producers.some((producer) => onPath.has(producer.slug))) continue;
      unmade.push({ stage: stage.slug, artifact: consume.artifact, producers: producers.map((p) => p.slug) });
    }
  }
  return unmade;
}

/** The required inputs the person's own changes take away: unmade in the plan
 *  but made under the scope as it ships (a stock scope leaves some unmade by
 *  design, and those are not the person's doing). */
export function lostInputs(data, state) {
  const projectType = projectTypeOf(state);
  const key = (gap) => `${gap.stage} ${gap.artifact}`;
  const onBase = new Set(unmadeInputs(data, scopeGrid(data, state.scope), projectType).map(key));
  return unmadeInputs(data, planGrid(data, state), projectType).filter((gap) => !onBase.has(key(gap)));
}

/** Quote the person's description as one argument. The line is read by the
 *  agent, not a shell, so double quotes inside become single quotes. */
function quoteDescription(text) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return `"${trimmed === "" ? "<what to build>" : trimmed.replace(/"/g, "'")}"`;
}

/** The start line: the scope, then only the settings that differ from it. */
export function buildCommand(data, state) {
  const scope = findScope(data, state.scope);
  const parts = ["/aidlc", "--scope", scope.name];
  if (state.projectType === "greenfield" || state.projectType === "brownfield") {
    parts.push("--project-type", state.projectType);
  }
  if (state.guardPolicy !== scope.guardPolicy) parts.push("--guard-policy", state.guardPolicy);
  if (state.depth !== scope.depth) parts.push("--depth", state.depth);
  const testStrategy = effectiveTestStrategy(data, state);
  if (testStrategy !== defaultTestStrategy(data, state)) parts.push("--test-strategy", testStrategy);
  const review = effectiveReview(data, state);
  if (review !== defaultReview(data, state)) parts.push("--review", review);
  for (const { key, flag } of data.flags.ceremony) {
    if (state.ceremony[key] !== scope.ceremony[key]) parts.push(flag, state.ceremony[key]);
  }
  const { skip, add } = planChanges(data, state);
  if (skip.length > 0) parts.push("--skip", skip.join(","));
  if (add.length > 0) parts.push("--add", add.join(","));
  parts.push(quoteDescription(state.description ?? ""));
  return parts.join(" ");
}

/** The start line as argv, the way the engine receives it (the description
 *  is one argument). */
export function commandArgv(data, state) {
  const line = buildCommand(data, state);
  const quoted = line.indexOf(' "');
  const head = line.slice(0, quoted).split(" ").slice(1);
  const description = line.slice(quoted + 2, -1);
  return [...head, description];
}
