// Generates the data behind the docs site's Interactive composer page
// (docs/guide/05-1-interactive-composer.md): every stock scope with its
// default stage grid and settings, every stage with the metadata the page's
// readouts walk, and the values each start flag takes.
//
// Everything is read from the hand-authored source in core/ through the
// engine's own loaders (compileStageGraph, loadScopeMetadata, the flag
// tables), so the page follows any scope, stage or flag change with no
// manual edit. The output is gitignored: the docs deploy workflow
// (.github/workflows/docs.yml) runs this right before `zensical build`, and a
// local preview runs it once before `zensical serve`.
//
// Usage: bun scripts/docs-composer-data.ts [outFile]
//        (default: docs/assets/composer/composer-data.json)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compileStageGraph, type GraphStage } from "../core/tools/aidlc-graph.ts";
import {
  CEREMONY_FIELDS,
  CEREMONY_FLAGS,
  CEREMONY_KEYS,
  CEREMONY_SETTINGS,
  GUARD_POLICY_VALUES,
  loadScopeMetadata,
  NEXT_FLAGS,
} from "../core/tools/aidlc-lib.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";

type Action = "EXECUTE" | "SKIP";

export interface ComposerStage {
  slug: string;
  number: string;
  name: string;
  phase: string;
  produces: string[];
  consumes: Array<{ artifact: string; required: boolean; conditional_on?: string }>;
  /** The stage's declared review class, or null when it has no reviewer. */
  reviewClass: "adversarial" | "advisory" | null;
}

export interface ComposerScope {
  name: string;
  description: string;
  depth: string;
  /** The scope's own test strategy, or null when it follows depth. */
  testStrategy: string | null;
  /** The scope's review cap, or null when stages run as declared. */
  reviewCap: string | null;
  guardPolicy: string;
  existingCode: boolean;
  ceremony: Record<string, string>;
  stages: Record<string, Action>;
}

export interface ComposerData {
  version: string;
  phases: Array<{ slug: string; label: string }>;
  flags: {
    depth: string[];
    testStrategy: string[];
    review: string[];
    guardPolicy: string[];
    projectType: string[];
    ceremony: Array<{ key: string; flag: string; label: string }>;
    ceremonyValues: string[];
  };
  stages: ComposerStage[];
  scopes: ComposerScope[];
}

const PHASE_ORDER = ["initialization", "ideation", "inception", "construction", "operation"];

function words(flag: string): string[] {
  const shape = NEXT_FLAGS.get(flag);
  if (shape?.value !== "words" || shape.words === undefined) {
    throw new Error(`Start flag ${flag} is not a fixed-word flag in NEXT_FLAGS; the composer cannot offer its values.`);
  }
  return [...shape.words];
}

function stageOrder(a: { number: string }, b: { number: string }): number {
  const [aMajor, aMinor] = a.number.split(".").map(Number);
  const [bMajor, bMinor] = b.number.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

export function buildComposerData(): ComposerData {
  const compiled = compileStageGraph();
  const graph = (JSON.parse(compiled.json) as GraphStage[]).slice().sort(stageOrder);
  const grid = JSON.parse(compiled.gridJson) as Record<string, { stages: Record<string, Action> }>;
  const metadata = loadScopeMetadata();

  const stages: ComposerStage[] = graph.map((stage) => ({
    slug: stage.slug,
    number: stage.number,
    name: stage.name,
    phase: stage.phase,
    produces: [...(stage.produces ?? [])],
    consumes: (stage.consumes ?? []).map((consume) => ({
      artifact: consume.artifact,
      required: consume.required,
      ...(consume.conditional_on ? { conditional_on: consume.conditional_on } : {}),
    })),
    // The engine reads a reviewer-bearing stage with no declared class as
    // adversarial (`node.review_class ?? "adversarial"` in aidlc-orchestrate.ts).
    reviewClass: stage.reviewer ? (stage.review_class ?? "adversarial") : null,
  }));

  const scopes: ComposerScope[] = Object.values(metadata)
    .filter((meta) => grid[meta.name] !== undefined)
    .map((meta) => {
      const ceremony: Record<string, string> = {};
      for (const key of CEREMONY_KEYS) ceremony[key] = meta.ceremony?.[key] ?? "on";
      const column: Record<string, Action> = {};
      for (const stage of stages) column[stage.slug] = grid[meta.name].stages[stage.slug] === "EXECUTE" ? "EXECUTE" : "SKIP";
      return {
        name: meta.name,
        description: meta.description,
        depth: meta.depth.toLowerCase(),
        testStrategy: meta.testStrategy ? meta.testStrategy.toLowerCase() : null,
        reviewCap: meta.reviewCap ?? null,
        // Absent means strict (resolveGuardPolicy).
        guardPolicy: meta.guardPolicy ?? "strict",
        existingCode: meta.existingCode === true,
        ceremony,
        stages: column,
      };
    })
    // Longest plan first, so the list reads from the full lifecycle down.
    .sort((a, b) => {
      const runs = (scope: ComposerScope) => Object.values(scope.stages).filter((action) => action === "EXECUTE").length;
      return runs(b) - runs(a) || a.name.localeCompare(b.name);
    });

  const phases = PHASE_ORDER.filter((phase) => stages.some((stage) => stage.phase === phase))
    .concat([...new Set(stages.map((stage) => stage.phase))].filter((phase) => !PHASE_ORDER.includes(phase)))
    .map((slug) => ({ slug, label: slug.charAt(0).toUpperCase() + slug.slice(1) }));

  return {
    version: AIDLC_VERSION,
    phases,
    flags: {
      depth: words("--depth"),
      testStrategy: words("--test-strategy"),
      review: words("--review"),
      guardPolicy: [...GUARD_POLICY_VALUES],
      projectType: words("--project-type"),
      ceremony: CEREMONY_KEYS.map((key) => ({ key, flag: CEREMONY_FLAGS[key], label: CEREMONY_FIELDS[key] })),
      ceremonyValues: [...CEREMONY_SETTINGS],
    },
    stages,
    scopes,
  };
}

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? "docs/assets/composer/composer-data.json");
  const data = buildComposerData();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Wrote ${out}: ${data.scopes.length} scopes, ${data.stages.length} stages (AI-DLC ${data.version}).`);
}
