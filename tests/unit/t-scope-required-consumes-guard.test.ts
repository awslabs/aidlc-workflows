// covers:
//
// A stage's dependencies are declared twice: `requires_stage:` (ordering) and
// `consumes:` with `required: true` (the artifact it must be handed). Once a scope
// is compiled the two are not reconciled, so a scope that skips stages can leave a
// `required: true` input with no reachable producer. Nothing fails loudly at runtime:
// the ordering check passes, the artifact is absent, and `upstream-coverage` is
// advisory-only, so the approval gate still opens.
//
// This guard freezes the currently-known set. It does not assert the set is empty —
// resolving those cases is a semantics decision (see the tracking issue). It fails
// when a NEW unsatisfiable pair appears, or when a baselined pair is fixed and the
// baseline is not trimmed.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const STAGES_DIR = join(REPO_ROOT, "core", "aidlc-common", "stages");

type Stage = {
  slug: string;
  produces: string[];
  requiresStage: string[];
  scopes: string[];
  requiredConsumes: string[];
};

function listBlock(body: string, key: string): string[] {
  const m = body.match(new RegExp(`\\n${key}:\\n((?:  - .*\\n)+)`));
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^-\s*/, "").trim());
}

function requiredConsumes(body: string): string[] {
  const m = body.match(/\nconsumes:\n((?:  .*\n)+)/);
  if (!m) return [];
  const out: string[] = [];
  let current: string | null = null;
  for (const line of m[1].split("\n")) {
    const artifact = line.match(/^\s*-\s*artifact:\s*(\S+)/);
    if (artifact) {
      current = artifact[1];
      continue;
    }
    if (current && /required:\s*true/.test(line)) {
      out.push(current);
      current = null;
    }
  }
  return out;
}

function loadStages(): Stage[] {
  const stages: Stage[] = [];
  for (const phase of readdirSync(STAGES_DIR)) {
    const phaseDir = join(STAGES_DIR, phase);
    for (const file of readdirSync(phaseDir)) {
      if (!file.endsWith(".md")) continue;
      const body = readFileSync(join(phaseDir, file), "utf8");
      const slug = body.match(/^slug:\s*(\S+)/m)?.[1];
      if (!slug) continue;
      stages.push({
        slug,
        produces: listBlock(body, "produces"),
        requiresStage: listBlock(body, "requires_stage"),
        scopes: listBlock(body, "scopes"),
        requiredConsumes: requiredConsumes(body),
      });
    }
  }
  return stages;
}

/** Stages reachable from `slug` through requires_stage, restricted to `inScope`. */
function closure(slug: string, bySlug: Map<string, Stage>, inScope: Set<string>): Set<string> {
  const seen = new Set<string>();
  const walk = (s: string) => {
    for (const parent of bySlug.get(s)?.requiresStage ?? []) {
      if (!inScope.has(parent) || seen.has(parent)) continue;
      seen.add(parent);
      walk(parent);
    }
  };
  walk(slug);
  return seen;
}

function unsatisfiablePairs(): string[] {
  const stages = loadStages();
  const bySlug = new Map(stages.map((s) => [s.slug, s]));
  const producers = new Map<string, string[]>();
  for (const stage of stages) {
    for (const artifact of stage.produces) {
      producers.set(artifact, [...(producers.get(artifact) ?? []), stage.slug]);
    }
  }

  const found: string[] = [];
  const allScopes = [...new Set(stages.flatMap((s) => s.scopes))].sort();
  for (const scope of allScopes) {
    const inScope = new Set(stages.filter((s) => s.scopes.includes(scope)).map((s) => s.slug));
    for (const slug of [...inScope].sort()) {
      const reachable = closure(slug, bySlug, inScope);
      for (const artifact of bySlug.get(slug)?.requiredConsumes ?? []) {
        const makers = producers.get(artifact) ?? [];
        if (makers.length === 0) continue; // supplied from outside the workflow
        if (makers.some((m) => reachable.has(m))) continue;
        found.push(`${scope}/${slug}/${artifact}`);
      }
    }
  }
  return found.sort();
}

// Known unsatisfiable pairs as of the commit that introduced this guard.
// Format: <scope>/<stage>/<required artifact>
const BASELINE = [
  "bugfix/code-generation/requirements",
  "bugfix/code-generation/unit-of-work",
  "bugfix/deployment-execution/build-test-results",
  "bugfix/deployment-execution/environment-inventory",
  "bugfix/deployment-pipeline/ci-config",
  "bugfix/deployment-pipeline/cicd-pipeline",
  "bugfix/deployment-pipeline/infrastructure-specification",
  "bugfix/deployment-pipeline/quality-gates",
  "classic/refined-mockups/user-flow",
  "classic/refined-mockups/wireframes",
  "express/code-generation/requirements",
  "express/code-generation/unit-of-work",
  "express/deployment-execution/build-test-results",
  "express/deployment-execution/environment-inventory",
  "express/deployment-pipeline/ci-config",
  "express/deployment-pipeline/cicd-pipeline",
  "express/deployment-pipeline/infrastructure-specification",
  "express/deployment-pipeline/quality-gates",
  "express/observability-setup/infrastructure-specification",
  "express/observability-setup/monitoring-design",
  "express/observability-setup/performance-design",
  "express/observability-setup/reliability-design",
  "express/observability-setup/security-design",
  "infra/ci-pipeline/build-and-test-summary",
  "infra/ci-pipeline/build-test-results",
  "infra/ci-pipeline/code-summary",
  "infra/deployment-execution/build-test-results",
  "infra/infrastructure-design/components",
  "infra/infrastructure-design/functional-spec",
  "infra/nfr-design/functional-spec",
  "infra/nfr-requirements/functional-spec",
  "infra/nfr-requirements/requirements",
  "infra/nfr-requirements/rules",
  "mvp/refined-mockups/user-flow",
  "mvp/refined-mockups/wireframes",
  "poc/code-generation/requirements",
  "poc/code-generation/unit-of-work",
  "refactor/code-generation/requirements",
  "refactor/code-generation/unit-of-work",
  "refactor/deployment-execution/build-test-results",
  "refactor/deployment-execution/environment-inventory",
  "refactor/deployment-pipeline/ci-config",
  "refactor/deployment-pipeline/cicd-pipeline",
  "refactor/deployment-pipeline/infrastructure-specification",
  "refactor/deployment-pipeline/quality-gates",
  "refactor/functional-design/components",
  "refactor/functional-design/requirements",
  "refactor/functional-design/unit-of-work",
  "security-patch/code-generation/requirements",
  "security-patch/code-generation/unit-of-work",
  "security-patch/deployment-execution/build-test-results",
  "security-patch/deployment-execution/environment-inventory",
  "security-patch/deployment-pipeline/ci-config",
  "security-patch/deployment-pipeline/cicd-pipeline",
  "security-patch/deployment-pipeline/infrastructure-specification",
  "security-patch/deployment-pipeline/quality-gates",
  "security-patch/nfr-requirements/functional-spec",
  "security-patch/nfr-requirements/requirements",
  "security-patch/nfr-requirements/rules",
  "workshop/refined-mockups/user-flow",
  "workshop/refined-mockups/wireframes",
].sort();

describe("scope-compiled required consumes guard", () => {
  test("feature and enterprise satisfy every required input", () => {
    const offenders = unsatisfiablePairs().filter(
      (p) => p.startsWith("feature/") || p.startsWith("enterprise/"),
    );
    expect(offenders).toEqual([]);
  });

  test("no new unsatisfiable required input appears", () => {
    const actual = unsatisfiablePairs();
    const added = actual.filter((p) => !BASELINE.includes(p));
    expect(added).toEqual([]);
  });

  test("baseline has no stale entries", () => {
    const actual = unsatisfiablePairs();
    const fixed = BASELINE.filter((p) => !actual.includes(p));
    expect(fixed).toEqual([]);
  });
});
