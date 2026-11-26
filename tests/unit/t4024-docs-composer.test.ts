// covers: function:validateGrid, function:gridCostSummary, function:planWithChanges, function:resolveReviewClass, function:readNextLine, function:loadScopeMapping
//
// t4024 - the docs site's Interactive composer (docs/guide/05-1-interactive-composer.md)
// says what the engine does.
//
// The page builds a `/aidlc` start line and counts what it runs, from two
// pieces: data generated from core/ (scripts/docs-composer-data.ts) and pure
// rules in docs/assets/composer/composer-logic.js, which the browser runs as is.
// This test imports both and holds them against the engine itself, for every
// stock scope, every single-stage change, every project type and every review
// setting:
//
//   - the generated grid and settings equal the scope mapping the engine loads;
//   - the line's --skip/--add are accepted by planWithChanges and give the grid
//     the page counts;
//   - stage and gate counts equal gridCostSummary of the grid as created;
//   - review counts equal resolveReviewClass per running reviewer stage;
//   - the missing inputs equal validateGrid's off-path inputs, less the ones
//     the stock scope already leaves unmade;
//   - readNextLine reads every line the page builds as `exact`.
//
// Nothing is hardcoded: both sides read the shipped graph, so a scope, stage or
// flag change moves both together, and a rule change in either one fails here.
//
// Mechanism: in-process imports (unit tier, no LLM). Engine functions come from
// the packaged dist/claude tools, as in t190 and t213.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildComposerData, type ComposerData } from "../../scripts/docs-composer-data.ts";
import {
  gridCostSummary,
  loadScopeMapping,
  planWithChanges,
  readNextLine,
  readNextTokens,
  resolveReviewClass,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { validateGrid } from "../../dist/claude/.claude/tools/aidlc-graph.ts";

type Grid = Record<string, "EXECUTE" | "SKIP">;
interface ComposerState {
  scope: string;
  projectType: "detect" | "greenfield" | "brownfield";
  guardPolicy: string;
  depth: string;
  testStrategy: string | null;
  review: string | null;
  ceremony: Record<string, string>;
  grid: Record<string, boolean>;
  description: string;
}
interface Gap { stage: string; artifact: string; producers: string[] }
interface ComposerLogic {
  scopeDefaults(data: ComposerData, scope: string): ComposerState;
  planChanges(data: ComposerData, state: ComposerState): { skip: string[]; add: string[] };
  planGrid(data: ComposerData, state: ComposerState): Grid;
  asCreated(grid: Grid, projectType?: string): Grid;
  planSummary(data: ComposerData, state: ComposerState): {
    total: number; execute: number; skip: number; gates: number;
    reviews: { adversarial: number; advisory: number };
  };
  lostInputs(data: ComposerData, state: ComposerState): Gap[];
  effectiveReview(data: ComposerData, state: ComposerState): string;
  buildCommand(data: ComposerData, state: ComposerState): string;
  commandArgv(data: ComposerData, state: ComposerState): string[];
}

// A non-literal specifier: the page's logic is plain browser JavaScript, typed
// here by the interface above rather than by a declaration file.
const LOGIC_PATH = join(import.meta.dir, "..", "..", "docs", "assets", "composer", "composer-logic.js");
const logic = (await import(LOGIC_PATH)) as ComposerLogic;
const data = buildComposerData();

const PROJECT_TYPES = ["detect", "greenfield", "brownfield"] as const;

function engineProjectType(state: ComposerState): "greenfield" | "brownfield" | undefined {
  return state.projectType === "detect" ? undefined : state.projectType;
}

/** Every state worth checking for one scope: its defaults, and each
 *  non-initialization stage flipped on its own, under each project type. */
function statesFor(scope: string): ComposerState[] {
  const states: ComposerState[] = [];
  for (const projectType of PROJECT_TYPES) {
    const base = { ...logic.scopeDefaults(data, scope), projectType };
    states.push(base);
    for (const stage of data.stages) {
      if (stage.phase === "initialization") continue;
      states.push({ ...base, grid: { ...base.grid, [stage.slug]: !base.grid[stage.slug] } });
    }
  }
  return states;
}

/** The engine's off-path required inputs for a grid, as "stage artifact" keys. */
function engineUnmade(grid: Grid, projectType: "greenfield" | "brownfield" | undefined): Set<string> {
  const result = validateGrid(grid, projectType ? { projectType } : undefined);
  const keys = new Set<string>();
  for (const message of [...result.errors, ...result.advisories]) {
    const match = message.match(/^Stage "([^"]+)" requires artifact "([^"]+)"/);
    if (match) keys.add(`${match[1]} ${match[2]}`);
  }
  return keys;
}

/** How the engine reads a line the page built: `exact` only when readNextLine
 *  acts on it as written AND every token before the description is a start
 *  flag or its value, with the description the one word of the person's own.
 *  (readNextLine alone reads a misspelt single-dash flag as a word.) */
function engineReading(argv: string[]): string {
  const kind = readNextLine(argv).kind;
  if (kind !== "exact") return kind;
  const tokens = readNextTokens(argv).tokens;
  const words = tokens.filter((token) => token.role === "word").map((token) => token.token);
  const other = tokens.filter((token) => token.role !== "word" && token.role !== "flag");
  if (other.length > 0) return `not a start flag: ${other.map((token) => token.token).join(" ")}`;
  if (words.length !== 1 || words[0] !== argv[argv.length - 1]) return `stray words: ${words.join(" | ")}`;
  return "exact";
}

describe("t4024 - Interactive composer data matches the engine's scopes", () => {
  const mapping = loadScopeMapping();

  test("every stock scope is offered, with the engine's stage grid and depth", () => {
    expect(data.scopes.map((scope) => scope.name).sort()).toEqual(Object.keys(mapping).sort());
    for (const scope of data.scopes) {
      const engine = mapping[scope.name];
      expect(scope.depth).toBe(engine.depth.toLowerCase());
      for (const stage of data.stages) {
        expect(`${scope.name} ${stage.slug} ${scope.stages[stage.slug]}`)
          .toBe(`${scope.name} ${stage.slug} ${engine.stages[stage.slug] === "EXECUTE" ? "EXECUTE" : "SKIP"}`);
      }
    }
  });

  test("a scope's own settings make the bare line", () => {
    for (const scope of data.scopes) {
      const state = logic.scopeDefaults(data, scope.name);
      expect(logic.buildCommand(data, state)).toBe(`/aidlc --scope ${scope.name} "<what to build>"`);
      expect(logic.planChanges(data, state)).toEqual({ skip: [], add: [] });
    }
  });
});

describe("t4024 - Interactive composer counts what the engine runs", () => {
  for (const scope of data.scopes) {
    test(`${scope.name}: stage changes, counts and missing inputs match the engine`, () => {
      const baseUnmade = new Map<string, Set<string>>();
      for (const state of statesFor(scope.name)) {
        const label = `${scope.name} ${state.projectType} ${JSON.stringify(logic.planChanges(data, state))}`;
        const changes = logic.planChanges(data, state);

        // The line's stage changes are ones the engine takes, and give the page's grid.
        const applied = planWithChanges(scope.name, changes);
        expect(`${label} ${applied.errors.join(" | ")}`).toBe(`${label} `);
        expect(applied.stages).toEqual(logic.planGrid(data, state));

        // Stages and gates, counted as creation runs the grid.
        const projectType = engineProjectType(state);
        const created = logic.asCreated(applied.stages, projectType);
        const engine = gridCostSummary(created);
        const page = logic.planSummary(data, state);
        expect({ label, execute: page.execute, gates: page.gates, total: page.total })
          .toEqual({ label, execute: engine.execute, gates: engine.gates, total: engine.total });

        // Missing inputs: the engine's off-path inputs the stock scope does not
        // already leave unmade.
        const key = projectType ?? "detect";
        if (!baseUnmade.has(key)) {
          baseUnmade.set(key, engineUnmade(logic.asCreated({ ...scope.stages }, undefined), projectType));
        }
        const base = baseUnmade.get(key) ?? new Set<string>();
        const expected = [...engineUnmade(applied.stages, projectType)].filter((gap) => !base.has(gap)).sort();
        const lost = logic.lostInputs(data, state).map((gap) => `${gap.stage} ${gap.artifact}`).sort();
        expect({ label, lost }).toEqual({ label, lost: expected });

        // The line itself is one the engine reads as written.
        expect({ label, reading: engineReading(logic.commandArgv(data, state)) })
          .toEqual({ label, reading: "exact" });
      }
    });
  }
});

describe("t4024 - Interactive composer review counts and settings lines", () => {
  test("review counts follow resolveReviewClass for every scope and review setting", () => {
    for (const scope of data.scopes) {
      for (const review of [null, ...data.flags.review]) {
        const state = { ...logic.scopeDefaults(data, scope.name), review };
        const stateContent = review === null ? null : `- **Review Override**: ${review}\n`;
        const grid = logic.planGrid(data, state);
        const expected = { adversarial: 0, advisory: 0 };
        for (const stage of data.stages) {
          if (grid[stage.slug] !== "EXECUTE" || stage.reviewClass === null) continue;
          const effective = resolveReviewClass(stage.reviewClass, scope.name, stateContent);
          if (effective === "adversarial" || effective === "advisory") expected[effective]++;
        }
        expect({ scope: scope.name, review, reviews: logic.planSummary(data, state).reviews })
          .toEqual({ scope: scope.name, review, reviews: expected });
      }
    }
  });

  test("every setting the form offers makes a line the engine reads as written", () => {
    for (const scope of data.scopes) {
      const base = logic.scopeDefaults(data, scope.name);
      const variants: ComposerState[] = [
        ...data.flags.guardPolicy.map((guardPolicy) => ({ ...base, guardPolicy })),
        ...data.flags.depth.map((depth) => ({ ...base, depth })),
        ...data.flags.testStrategy.map((testStrategy) => ({ ...base, testStrategy })),
        ...data.flags.review.map((review) => ({ ...base, review })),
        ...PROJECT_TYPES.map((projectType) => ({ ...base, projectType })),
        ...data.flags.ceremony.flatMap(({ key }) =>
          data.flags.ceremonyValues.map((value) => ({ ...base, ceremony: { ...base.ceremony, [key]: value } }))),
        { ...base, description: 'Add "CSV" export --skip nothing' },
      ];
      for (const state of variants) {
        const line = logic.buildCommand(data, state);
        expect({ line, reading: engineReading(logic.commandArgv(data, state)) }).toEqual({ line, reading: "exact" });
      }
    }
  });

  test("a setting appears on the line only when it differs from the scope", () => {
    const state = logic.scopeDefaults(data, "bugfix");
    const scope = data.scopes.find((s) => s.name === "bugfix");
    if (!scope) throw new Error("bugfix scope missing");
    const other = data.flags.depth.find((depth) => depth !== scope.depth) ?? scope.depth;
    expect(logic.buildCommand(data, { ...state, depth: other })).toContain(`--depth ${other}`);
    // With no explicit test strategy, the strategy follows the depth and stays off the line.
    expect(logic.buildCommand(data, { ...state, depth: other })).not.toContain("--test-strategy");
    expect(logic.buildCommand(data, { ...state, review: logic.effectiveReview(data, state) })).not.toContain("--review");
  });
});
