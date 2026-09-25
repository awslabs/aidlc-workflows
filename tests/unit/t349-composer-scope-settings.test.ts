// covers: function:validateScopeSettings, function:scopeSettingsOffList,
// function:ceremonyOffList, function:scopeSettingsOf,
// function:stockSettingsAdvisory, subcommand:aidlc-graph:validate-grid
//
// t349 - the composer's scope settings. A front/report proposal carries the four
// scope-file settings (sensors, learnings, summary_confirmation, review_cap)
// beside its grid; the validator checks each against the words the scope loader
// accepts, echoes the accepted set in key order, and names what it switches off
// in summary.off, advising when a grid identical to a stock scope's carries
// values none of those scopes declare. A custom scope file declaring those
// values, as the composer's Step 10 writes it, is then honored by the resolvers
// the runtime reads, and its off list agrees with the one the gate showed.
// Mid-workflow the settings are per-intent switches: the route never offers
// --review as a way to lift a scope's review cap (an override only lowers), and
// a settings-only request presents no gate and runs no recompose.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCOPE_SETTING_KEYS,
  scopeSettingsOf,
  stockSettingsAdvisory,
  validateScopeSettings,
} from "../../core/tools/aidlc-graph.ts";
import {
  ceremonyOffList,
  ceremonyPolicyValues,
  loadScopeMapping,
  loadScopeMetadataAll,
  resolveCeremony,
  resolveReviewClass,
  scopeSettingsOffList,
} from "../../core/tools/aidlc-lib.ts";
import { assertComposedScopeSettings } from "../harness/composed-scope.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedAidlcMemory,
  seedStateFile,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const GRAPH_TOOL = join(AIDLC_SRC, "tools", "aidlc-graph.ts");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const POLICY_ENV = {
  AIDLC_HARNESS_DIR: ".claude",
  AIDLC_SCOPE_MAPPING: undefined,
  AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
  AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
  AIDLC_SCOPES_DIR: join(REPO_ROOT, "core", "scopes"),
  AIDLC_DISABLE_SENSORS: "0",
  AIDLC_DISABLE_LEARNINGS: "0",
  AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
};
const QUICK_FIX = {
  sensors: "off",
  learnings: "off",
  summary_confirmation: "on",
  review_cap: "none",
} as const;
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function project(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  return proj;
}

function runValidateGrid(proj: string, proposal: unknown) {
  const proposalPath = join(proj, "proposal.json");
  writeFileSync(proposalPath, JSON.stringify(proposal), "utf-8");
  const result = spawnSync(
    BUN,
    [GRAPH_TOOL, "validate-grid", "--proposal", proposalPath, "--project-dir", proj],
    { encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj } },
  );
  return { rc: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function featureGrid(): Record<string, "EXECUTE" | "SKIP"> {
  return withEnvAndFreshCaches(POLICY_ENV, () => loadScopeMapping().feature.stages);
}

describe("t349 (1) validateScopeSettings checks the four settings", () => {
  test("a full valid set passes and is rebuilt in key order", () => {
    const shuffled = { review_cap: "advisory", summary_confirmation: "off", learnings: "on", sensors: "off" };
    const checked = validateScopeSettings(shuffled);
    expect(checked.errors).toEqual([]);
    expect(checked.settings).toEqual({
      sensors: "off",
      learnings: "on",
      summary_confirmation: "off",
      review_cap: "advisory",
    });
    expect(Object.keys(checked.settings ?? {})).toEqual([...SCOPE_SETTING_KEYS]);
    for (const cap of ["adversarial", "advisory", "none"]) {
      expect(validateScopeSettings({ ...QUICK_FIX, review_cap: cap }).errors, cap).toEqual([]);
    }
  });

  test("anything but an object is refused with one error", () => {
    for (const raw of [null, "off", 3, ["sensors"]]) {
      expect(validateScopeSettings(raw), JSON.stringify(raw)).toEqual({
        settings: null,
        errors: ["Scope settings must be an object naming sensors, learnings, summary_confirmation, review_cap."],
      });
    }
  });

  test("unknown keys, missing keys, and words the loader would reject are each named", () => {
    const checked = validateScopeSettings({ sensors: "On", learnings: false, review: "none" });
    expect(checked.settings).toBeNull();
    expect(checked.errors).toEqual([
      'Scope settings name unknown key "review" (expected sensors, learnings, summary_confirmation, review_cap).',
      "Scope settings are missing summary_confirmation, review_cap. Name all four.",
      'Scope setting sensors must be one of: on, off (got "On").',
      "Scope setting learnings must be one of: on, off (got false).",
    ]);
    expect(validateScopeSettings({ ...QUICK_FIX, review_cap: "light" }).errors).toEqual([
      'Scope setting review_cap must be one of: adversarial, advisory, none (got "light").',
    ]);
  });
});

describe("t349 (2) the off list is the same whether it comes from settings or a scope", () => {
  test("labels follow the fixed order, and only a none cap drops reviewers", () => {
    expect(scopeSettingsOffList("none", { sensors: "off", learnings: "off", summary_confirmation: "off" }))
      .toEqual(["reviewers", "sensors", "learnings ritual", "summary confirmation"]);
    expect(scopeSettingsOffList("advisory", { sensors: "on", learnings: "off", summary_confirmation: "on" }))
      .toEqual(["learnings ritual"]);
    expect(scopeSettingsOffList(undefined, { sensors: "on", learnings: "on", summary_confirmation: "on" }))
      .toEqual([]);
  });

  test("ceremonyOffList for every stock scope reads its own review_cap through the shared helper", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const metadata = loadScopeMetadataAll();
      for (const scope of Object.keys(metadata)) {
        const policy = ceremonyPolicyValues(scope, "");
        expect(ceremonyOffList(scope, policy), scope).toEqual(
          scopeSettingsOffList(metadata[scope].reviewCap, policy),
        );
      }
      expect(ceremonyOffList("express", ceremonyPolicyValues("express", ""))).toEqual([
        "reviewers", "sensors", "learnings ritual", "summary confirmation",
      ]);
    });
  });
});

describe("t349 (3) a grid identical to a stock scope's is checked against its settings", () => {
  const STOCK_ON = { sensors: "on", learnings: "on", summary_confirmation: "on", review_cap: "adversarial" } as const;

  test("scopeSettingsOf reads declared values and fills the resolver defaults", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(scopeSettingsOf("express")).toEqual({
        sensors: "off", learnings: "off", summary_confirmation: "off", review_cap: "none",
      });
      // feature declares no review_cap, so the cap reads as adversarial (no cap).
      expect(scopeSettingsOf("feature")).toEqual(STOCK_ON);
      expect(scopeSettingsOf("no-such-scope")).toBeNull();
    });
  });

  test("an advisory names every exact stock match only when none of them agrees", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const tie = [
        { scope: "enterprise", diff: 0 },
        { scope: "feature", diff: 0 },
        { scope: "express", diff: 7 },
      ];
      expect(stockSettingsAdvisory(STOCK_ON, tie)).toBeNull();
      expect(stockSettingsAdvisory(QUICK_FIX, tie)).toBe(
        "Scope settings match no stock scope with this exact grid (" +
          "enterprise: sensors on, learnings on, summary_confirmation on, review_cap adversarial; " +
          "feature: sensors on, learnings on, summary_confirmation on, review_cap adversarial). " +
          "A matched proposal carries its stock scope's values; keep different values only on a custom proposal.",
      );
      // No identical stock grid: nothing to compare, so a custom proposal is left alone.
      expect(stockSettingsAdvisory(QUICK_FIX, [{ scope: "express", diff: 7 }])).toBeNull();
    });
  });
});

describe("t349 (4) validate-grid carries the settings with the grid", () => {
  test("accepted settings are echoed, fill summary.off, and a stock-grid mismatch is advised", () => {
    const proj = project();
    const ok = runValidateGrid(proj, { stages: featureGrid(), scopeSettings: QUICK_FIX });
    expect(ok.rc, ok.stderr).toBe(0);
    const result = JSON.parse(ok.stdout);
    expect(result.valid).toBe(true);
    expect(result.scope_settings).toEqual(QUICK_FIX);
    expect(result.summary.off).toEqual(["reviewers", "sensors", "learnings ritual"]);
    expect(result.advisories.some((line: string) => line.startsWith("Scope settings match no stock scope"))).toBe(true);
    const stock = runValidateGrid(proj, {
      stages: featureGrid(),
      scopeSettings: { sensors: "on", learnings: "on", summary_confirmation: "on", review_cap: "adversarial" },
    });
    expect(stock.rc, stock.stderr).toBe(0);
    expect(JSON.parse(stock.stdout).advisories).toEqual([]);
  });

  test("a proposal without settings validates as before", () => {
    const proj = project();
    const bare = runValidateGrid(proj, { stages: featureGrid() });
    expect(bare.rc, bare.stderr).toBe(0);
    const result = JSON.parse(bare.stdout);
    expect(result.scope_settings).toBeUndefined();
    expect(result.summary.off).toEqual([]);
  });

  test("rejected settings fail the grid and are not echoed", () => {
    const proj = project();
    const bad = runValidateGrid(proj, {
      stages: featureGrid(),
      scopeSettings: { ...QUICK_FIX, sensors: "disabled" },
    });
    expect(bad.rc).toBe(1);
    const result = JSON.parse(bad.stdout);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Scope setting sensors must be one of: on, off (got "disabled").');
    expect(result.scope_settings).toBeUndefined();
    expect(result.summary.off).toEqual([]);
  });
});

describe("t349 (5) a custom scope written with the approved settings runs with them", () => {
  test("the resolvers read each value from the scope file and agree with the gate's off list", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    const scopes = join(proj, "scopes");
    mkdirSync(scopes);
    writeFileSync(join(scopes, "aidlc-quick-fix.md"), [
      "---",
      "name: quick-fix",
      "depth: Minimal",
      "keywords: []",
      "guard_policy: relaxed",
      ...SCOPE_SETTING_KEYS.map((key) => `${key}: ${QUICK_FIX[key]}`),
      "---",
      "",
      "Composed for a one-off fix: sensors, learnings, and stage reviewers are off.",
      "",
    ].join("\n"));
    withEnvAndFreshCaches({ ...POLICY_ENV, AIDLC_SCOPES_DIR: scopes }, () => {
      const meta = loadScopeMetadataAll()["quick-fix"];
      expect(meta.ceremony).toEqual({ sensors: "off", learnings: "off", summary_confirmation: "on" });
      expect(meta.reviewCap).toBe("none");
      expect(resolveCeremony("sensors", "quick-fix", "")).toMatchObject({ value: "off", source: "scope quick-fix" });
      expect(resolveCeremony("summary_confirmation", "quick-fix", "")).toMatchObject({
        value: "on",
        source: "scope quick-fix",
      });
      expect(resolveReviewClass("adversarial", "quick-fix")).toBe("none");
      const checked = validateScopeSettings(QUICK_FIX);
      expect(checked.settings).not.toBeNull();
      expect(ceremonyOffList("quick-fix", ceremonyPolicyValues("quick-fix", ""))).toEqual(
        scopeSettingsOffList(QUICK_FIX.review_cap, QUICK_FIX),
      );
    });
    // The live compose journey (t192) holds the composer's written file to the same shape.
    expect(() => assertComposedScopeSettings(join(scopes, "aidlc-quick-fix.md"))).not.toThrow();
    const partial = join(scopes, "aidlc-partial.md");
    writeFileSync(partial, "---\nname: partial\ndepth: Minimal\nsensors: off\nlearnings: on\nsummary_confirmation: on\n---\n");
    expect(() => assertComposedScopeSettings(partial)).toThrow(
      `Composed scope ${partial} must declare review_cap: adversarial | advisory | none (found "")`,
    );
  });
});

// The in-flight message the conductor receives for `next compose`, read the way t198 does.
function composeMessage(proj: string, args: string[]): string {
  const res = runOrchestrateNext(ORCH, proj, ["compose", ...args], { cwd: proj, env: process.env });
  const line = res.out.split("\n").find((entry) => entry.trim().startsWith("{"));
  if (line === undefined) throw new Error(`no directive in: ${res.out}`);
  const directive = JSON.parse(line) as { kind?: unknown; message?: unknown };
  expect(directive.kind).toBe("print");
  return String(directive.message);
}

describe("t349 (6) every composer surface names the settings contract", () => {
  const harnesses = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"];
  const surfaces = [
    "core/agents/aidlc-composer-agent.md",
    "core/knowledge/aidlc-composer-agent/composing.md",
    "core/tools/aidlc-orchestrate.ts",
    ...harnesses.map((harness) => `harness/${harness}/skills/aidlc/SKILL.md`),
  ];

  test("the agent, its knowledge, the dispatch, and each SKILL.md name every key", () => {
    for (const surface of surfaces) {
      const text = readFileSync(join(REPO_ROOT, surface), "utf-8");
      expect(text, surface).toContain("scopeSettings");
      for (const key of SCOPE_SETTING_KEYS) expect(text, `${surface} ${key}`).toContain(key);
    }
  });

  test("no surface offers --review as the way to raise reviews mid-workflow", () => {
    for (const surface of surfaces) {
      const text = readFileSync(join(REPO_ROOT, surface), "utf-8");
      expect(text, surface).not.toContain("--review adversarial|advisory|none");
      expect(text, surface).toMatch(/never lifts the running scope's `?review_cap`?/);
    }
  });
});

describe("t349 (7) mid-workflow, reviews only go down through the per-run switch", () => {
  test("an adversarial override never lifts a none or advisory cap; a lower override still lowers", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const raise = "- **Review Override**: adversarial\n";
      expect(resolveReviewClass("adversarial", "express", raise)).toBe("none");
      expect(resolveReviewClass("adversarial", "bugfix", raise)).toBe("advisory");
      expect(resolveReviewClass("adversarial", "feature", raise)).toBe("adversarial");
      expect(resolveReviewClass("adversarial", "feature", "- **Review Override**: none\n")).toBe("none");
    });
  });
});

describe("t349 (8) the compose dispatch carries the settings contract", () => {
  test("front: the gate renders a Scope settings row the human can flip", () => {
    const proj = project();
    const message = composeMessage(proj, ["fix the token bug"]);
    expect(message).toContain("scopeSettingsRationale");
    expect(message).toContain('"Scope settings: sensors <sensors>, learnings <learnings>, summary confirmation <summary_confirmation>, reviews <review_cap> - <scopeSettingsRationale>"');
    expect(message).not.toContain("write no marker");
  });

  test("in-flight: a settings-only request presents no gate and runs no recompose", () => {
    const proj = project();
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const message = composeMessage(proj, ["turn sensors off"]);
    expect(message).toContain("mode in-flight");
    expect(message).toContain(
      "When the composer returns empty changes.skip and changes.add (a settings-only request, or nothing earns a flip), write no marker, present no approval gate, and run no recompose",
    );
    expect(message).toContain("never lifts the running scope's review_cap");
    expect(message).not.toContain("Scope settings: sensors <sensors>");
  });
});
