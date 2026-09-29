// covers: function:validateScopeSettings, function:scopeSettingsOffList,
// function:ceremonyOffList, function:scopeSettingsOf,
// function:composerProposalErrors, function:creationSettingsFor,
// function:killSwitchAdvisories, function:resolveReviewClass,
// function:storedReviewOverride, function:scopeReviewLevel,
// subcommand:aidlc-graph:validate-grid, subcommand:aidlc-utility:config-get,
// subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:intent-create
//
// t349 - the composer's scope settings. A front/report proposal carries the four
// scope-file settings (sensors, learnings, summary_confirmation, review_cap)
// beside its grid; the validator checks each against the words the scope loader
// accepts, echoes the accepted set in key order, and names what it switches off
// in summary.off. A routed final run (--matched <stock> or --custom) requires
// the settings and a Guard Policy. A matched proposal writes no scope file, so
// the settings it changes apply to this piece of work only: --matched keeps the
// stock grid, accepts any value (a per-work review level replaces the scope's
// ceiling), and echoes the typed creation settings, which reach the new
// workflow without writing a scope. A custom scope file declaring the values is
// honored by the resolvers. Mid-workflow, settings requests are typed values
// the conductor applies without a gate, full reviews change no stages, a kill
// switch is reported and never searched for, and next refuses any value
// outside the allowed words, so no command text can ride along.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  composerProposalErrors,
  killSwitchAdvisories,
  creationSettingsFor,
  nearestStockScopes,
  SCOPE_SETTING_KEYS,
  scopeSettingsOf,
  validateScopeSettings,
} from "../../core/tools/aidlc-graph.ts";
import {
  CEREMONY_ENV,
  CEREMONY_KEYS,
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
  removeWorkspaceRecord,
  runOrchestrateNext,
  seedAidlcMemory,
  seedStateFile,
  seededRecordDir,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const GRAPH_TOOL = join(AIDLC_SRC, "tools", "aidlc-graph.ts");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
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
const STOCK_ON = { sensors: "on", learnings: "on", summary_confirmation: "on", review_cap: "adversarial" } as const;
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

function runValidateGrid(proj: string, proposal: unknown, extra: string[] = []) {
  const proposalPath = join(proj, "proposal.json");
  writeFileSync(proposalPath, JSON.stringify(proposal), "utf-8");
  const result = spawnSync(
    BUN,
    [GRAPH_TOOL, "validate-grid", "--proposal", proposalPath, ...extra, "--project-dir", proj],
    { encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj } },
  );
  return { rc: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function stockGrid(scope: string): Record<string, "EXECUTE" | "SKIP"> {
  return withEnvAndFreshCaches(POLICY_ENV, () => loadScopeMapping()[scope].stages);
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

describe("t349 (3) stock values", () => {
  test("scopeSettingsOf reads declared values and fills the resolver defaults", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(scopeSettingsOf("express")).toEqual({
        sensors: "off", learnings: "off", summary_confirmation: "off", review_cap: "none",
      });
      // feature declares no review_cap, so the cap reads as adversarial (no cap).
      expect(scopeSettingsOf("feature")).toEqual(STOCK_ON);
      expect(scopeSettingsOf("bugfix")?.review_cap).toBe("advisory");
      expect(scopeSettingsOf("no-such-scope")).toBeNull();
    });
  });
});

describe("t349 (4) validate-grid carries the settings with the grid", () => {
  test("accepted settings are echoed and fill summary.off", () => {
    const proj = project();
    const ok = runValidateGrid(proj, { stages: stockGrid("feature"), scopeSettings: QUICK_FIX });
    expect(ok.rc, ok.stderr).toBe(0);
    const result = JSON.parse(ok.stdout);
    expect(result.valid).toBe(true);
    expect(result.scope_settings).toEqual(QUICK_FIX);
    expect(result.summary.off).toEqual(["reviewers", "sensors", "learnings ritual"]);
    expect(result.advisories).toEqual([]);
  });

  test("a proposal without settings validates as before", () => {
    const proj = project();
    const bare = runValidateGrid(proj, { stages: stockGrid("bugfix") });
    expect(bare.rc, bare.stderr).toBe(0);
    const result = JSON.parse(bare.stdout);
    expect(result.scope_settings).toBeUndefined();
    expect(result.summary.off).toEqual([]);
  });

  test("rejected settings fail the grid and are not echoed", () => {
    const proj = project();
    const bad = runValidateGrid(proj, {
      stages: stockGrid("feature"),
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

describe("t349 (5) a matched plan applies its changes to this piece of work only", () => {
  const given = { scopeSettings: true, guardPolicy: true };

  test("composerProposalErrors requires the settings and a Guard Policy on either route", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const nearest = nearestStockScopes(loadScopeMapping().feature.stages);
      expect(composerProposalErrors(null, { scopeSettings: false, guardPolicy: false }, null, nearest)).toEqual([
        "A custom proposal must carry scopeSettings (sensors, learnings, summary_confirmation, review_cap).",
        "A custom proposal must carry a Guard Policy (--guard-policy or a guardPolicy member).",
      ]);
      expect(composerProposalErrors(null, given, "off", nearest)).toEqual([]);
    });
  });

  test("matched keeps the stock grid and Guard Policy and takes any setting, reviews up included", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const featureNearest = nearestStockScopes(loadScopeMapping().feature.stages);
      expect(composerProposalErrors("feature", given, "relaxed", featureNearest)).toEqual([]);
      expect(composerProposalErrors("feature", given, "strict", featureNearest)).toEqual([]);
      expect(composerProposalErrors("feature", given, "off", featureNearest)).toEqual([
        'Stock scope "feature" defaults Guard Policy to relaxed, but the proposal shows off. Show relaxed (or strict, which creation applies), or propose it as custom.',
      ]);
      // Settings no longer bind a matched plan (the CLI test below covers reviews
      // above bugfix's cap); only the grid and the Guard Policy do.
      const bugfixNearest = nearestStockScopes(loadScopeMapping().bugfix.stages);
      expect(composerProposalErrors("bugfix", given, "relaxed", bugfixNearest)).toEqual([]);
      const [grid] = composerProposalErrors("express", given, "off", featureNearest);
      expect(grid).toStartWith('A matched proposal carries stock scope "express"\'s grid verbatim; this grid differs on ');
      expect(composerProposalErrors("nope", given, "relaxed", featureNearest)).toEqual([
        '--matched names "nope", which is not a stock scope.',
      ]);
    });
  });

  test("creationSettingsFor names exactly the values that differ, as typed words", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(creationSettingsFor("feature", { ...STOCK_ON })).toEqual({});
      expect(creationSettingsFor("feature", { ...QUICK_FIX })).toEqual({ sensors: "off", learnings: "off", review: "none" });
      // bugfix already caps at advisory, so advisory is no change; learnings off is.
      expect(creationSettingsFor("bugfix", { ...STOCK_ON, learnings: "off", review_cap: "advisory" })).toEqual({ learnings: "off" });
      // Up from the cap is a change too.
      expect(creationSettingsFor("bugfix", { ...STOCK_ON })).toEqual({ review: "adversarial" });
      expect(creationSettingsFor("express", { ...QUICK_FIX, sensors: "on" })).toEqual({ sensors: "on", summary_confirmation: "on" });
    });
  });

  test("the CLI echoes the route and typed creation settings, and refuses a double route", () => {
    const proj = project();
    const ok = runValidateGrid(proj, { stages: stockGrid("feature"), scopeSettings: QUICK_FIX, guardPolicy: "relaxed" }, ["--matched", "feature"]);
    expect(ok.rc, ok.stdout + ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({
      valid: true,
      routing: "matched",
      matched_scope: "feature",
      creation_settings: { sensors: "off", learnings: "off", review: "none" },
    });
    const up = runValidateGrid(proj, { stages: stockGrid("bugfix"), scopeSettings: STOCK_ON, guardPolicy: "relaxed" }, ["--matched", "bugfix"]);
    expect(up.rc, up.stdout + up.stderr).toBe(0);
    expect(JSON.parse(up.stdout)).toMatchObject({ routing: "matched", creation_settings: { review: "adversarial" } });
    const lowered = runValidateGrid(proj, { stages: stockGrid("bugfix"), scopeSettings: { ...STOCK_ON, review_cap: "advisory" }, guardPolicy: "off" }, ["--matched", "bugfix"]);
    expect(lowered.rc).toBe(1);
    const refused = JSON.parse(lowered.stdout);
    expect(refused.routing).toBeUndefined();
    expect(refused.creation_settings).toBeUndefined();
    const custom = runValidateGrid(proj, { stages: stockGrid("bugfix"), scopeSettings: STOCK_ON, guardPolicy: "relaxed", depth: "Minimal" }, ["--custom"]);
    expect(custom.rc, custom.stdout + custom.stderr).toBe(0);
    // A custom plan runs on the nearest stock scope that carries its Guard
    // Policy, and its settings are measured against that base.
    expect(JSON.parse(custom.stdout)).toMatchObject({
      valid: true,
      routing: "custom",
      base_scope: "bugfix",
      plan_changes: { skip: [], add: [] },
      creation_settings: { review: "adversarial" },
    });
    const both = runValidateGrid(proj, { stages: stockGrid("feature"), scopeSettings: STOCK_ON }, ["--matched", "feature", "--custom"]);
    expect(both.rc).toBe(1);
    expect(both.stderr).toContain("validate-grid: pass --matched <stock-scope> or --custom, not both.");
    const bare = runValidateGrid(proj, { stages: stockGrid("feature") }, ["--matched"]);
    expect(bare.rc).toBe(1);
    expect(bare.stderr).toContain("validate-grid: --matched requires <stock-scope>.");
  });

  test("the creation flags reach the new workflow, and no scope file is written", () => {
    // An empty workspace, the way t198 makes one: no intent yet, so next creates one.
    const proj = createTestProject();
    tempDirs.push(proj);
    removeWorkspaceRecord(proj);
    // The conductor appends creationFlags after --scope; next carries them into creation.
    const next = runOrchestrateNext(ORCH, proj, ["--scope", "bugfix", "--learnings", "off", "--review", "adversarial", "--", "fix the token bug"], {
      cwd: proj,
      env: process.env,
    });
    const line = next.out.split("\n").find((entry) => entry.trim().startsWith("{"));
    const message = String((JSON.parse(line ?? "{}") as { message?: unknown }).message);
    expect(message).toContain("--learnings off");
    expect(message).toContain("--review adversarial");
    const created = spawnSync(BUN, [UTIL, "intent-create", "--scope", "bugfix", "--learnings", "off", "--review", "adversarial", "--project-dir", proj], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    expect(created.status, created.stdout + created.stderr).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const state = readFileSync(join(intents, record, "aidlc-state.md"), "utf-8");
    expect(state).toContain("- **Scope**: bugfix");
    expect(state).toContain("- **Learnings**: off (set by a command)");
    expect(state).toContain("- **Review Override**: adversarial");
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(resolveCeremony("learnings", "bugfix", state).value).toBe("off");
      // Full reviews on stock bugfix, without changing its scope or stages.
      expect(resolveReviewClass("adversarial", "bugfix", state)).toBe("adversarial");
    });
    // Stock bugfix itself is untouched and no composed scope was written.
    expect(existsSync(join(proj, "aidlc", "scopes")) ? readdirSync(join(proj, "aidlc", "scopes")) : []).toEqual([]);
  });
});

describe("t349 (6) a kill switch wins over an on setting, at the gate and mid-workflow", () => {
  const ALL_ON = { sensors: "on", learnings: "on", summary_confirmation: "on", review_cap: "adversarial" } as const;
  const switches = (on: string[]) =>
    Object.fromEntries(CEREMONY_KEYS.map((key) => [CEREMONY_ENV[key], on.includes(key) ? "1" : "0"]));

  test("killSwitchAdvisories names each on ceremony a switch forces off, and nothing else", () => {
    expect(killSwitchAdvisories({ ...ALL_ON }, switches([]))).toEqual([]);
    expect(killSwitchAdvisories({ ...ALL_ON }, switches(["sensors"]))).toEqual([
      "sensors is on in these settings, but AIDLC_DISABLE_SENSORS forces it off on this machine; " +
        "the scope still stores on, and the ceremony runs once that switch is cleared.",
    ]);
    const all = killSwitchAdvisories({ ...ALL_ON }, switches([...CEREMONY_KEYS]));
    expect(all.map((line) => line.split(" ")[0])).toEqual([...CEREMONY_KEYS]);
    // An off setting is already off: the switch changes nothing the gate shows.
    expect(killSwitchAdvisories({ ...QUICK_FIX }, switches([...CEREMONY_KEYS]))).toEqual([
      "summary_confirmation is on in these settings, but AIDLC_DISABLE_SUMMARY_CONFIRMATION forces it off on this machine; " +
        "the scope still stores on, and the ceremony runs once that switch is cleared.",
    ]);
  });

  test("validate-grid reports the switch beside a routed proposal", () => {
    const proj = project();
    writeFileSync(join(proj, "p.json"), JSON.stringify({ stages: stockGrid("feature"), scopeSettings: ALL_ON, guardPolicy: "relaxed", depth: "standard" }));
    const run = spawnSync(BUN, [
      GRAPH_TOOL, "validate-grid", "--proposal", join(proj, "p.json"), "--custom", "--project-dir", proj,
    ], { encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...switches(["learnings"]) } });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const advisories: string[] = JSON.parse(run.stdout).advisories;
    expect(advisories.filter((line) => line.includes("forces it off on this machine"))).toEqual([
      "learnings is on in these settings, but AIDLC_DISABLE_LEARNINGS forces it off on this machine; " +
        "the scope still stores on, and the ceremony runs once that switch is cleared.",
    ]);
  });

  test("mid-workflow, an on switch is recorded but the kill switch keeps each ceremony off", () => {
    const flags: Record<string, string> = {
      sensors: "sensors",
      learnings: "learnings",
      summary_confirmation: "summary-confirmation",
    };
    for (const key of CEREMONY_KEYS) {
      const proj = project();
      seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
      const env = { ...process.env, CLAUDE_PROJECT_DIR: proj, ...switches([key]) };
      const set = spawnSync(BUN, [UTIL, "config-change", `--${flags[key]}`, "on", "--project-dir", proj], { encoding: "utf-8", env });
      expect(set.status, key + set.stdout + set.stderr).toBe(0);
      const got = spawnSync(BUN, [UTIL, "config-get", flags[key], "--project-dir", proj], { encoding: "utf-8", env });
      expect(got.status, key + got.stdout + got.stderr).toBe(0);
      // This is the reading the composer and conductor take before reporting a kill switch.
      expect(got.stdout.trim(), key).toBe(`off (from env ${CEREMONY_ENV[key]})`);
    }
  });
});

describe("t349 (7) a custom scope written with the approved settings runs with them", () => {
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
    // The live compose journey (t192) holds the scope saved from a composed plan to the same shape.
    expect(() => assertComposedScopeSettings(join(scopes, "aidlc-quick-fix.md"))).not.toThrow();
    const partial = join(scopes, "aidlc-partial.md");
    writeFileSync(partial, "---\nname: partial\ndepth: Minimal\nsensors: off\nlearnings: on\nsummary_confirmation: on\n---\n");
    expect(() => assertComposedScopeSettings(partial)).toThrow(
      `Composed scope ${partial} must declare review_cap: adversarial | advisory | none (found "")`,
    );
  });
});

describe("t349 (8) every composer surface names the settings contract", () => {
  const harnesses = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"];
  const skills = harnesses.map((harness) => `harness/${harness}/skills/aidlc/SKILL.md`);
  const surfaces = [
    "core/agents/aidlc-composer-agent.md",
    "core/knowledge/aidlc-composer-agent/composing.md",
    "core/tools/aidlc-orchestrate.ts",
    ...skills,
  ];
  const read = (surface: string) => readFileSync(join(REPO_ROOT, surface), "utf-8");

  test("the agent, its knowledge, the dispatch, and each SKILL.md name every key", () => {
    for (const surface of surfaces) {
      const text = read(surface);
      expect(text, surface).toContain("scopeSettings");
      for (const key of SCOPE_SETTING_KEYS) expect(text, `${surface} ${key}`).toContain(key);
    }
  });

  test("settings requests are applied, as typed values, never as command text", () => {
    for (const surface of surfaces) {
      const text = read(surface);
      // Mid-workflow requests come back as typed values the conductor applies.
      expect(text, surface).toContain("settingsChanges");
      expect(text, surface).not.toMatch(/settingsFlags|creationFlags|creation_flags|nearest_uncapped/);
      // A kill switch is reported in one line and never searched for.
      expect(text, surface).toContain("AIDLC_DISABLE_<NAME>");
      expect(text, surface).toMatch(/never look for/i);
      expect(text, surface).not.toContain("--review adversarial|advisory|none");
      expect(text, surface).not.toMatch(/until nothing is listed|lifts both limits|the shell or the harness settings/);
    }
    // A matched plan's changes ride its typed creation settings.
    for (const surface of ["core/agents/aidlc-composer-agent.md", "core/tools/aidlc-orchestrate.ts", ...skills]) {
      expect(read(surface), surface).toContain("creationSettings");
    }
    // The conductor builds each flag itself and never pastes composer text, and
    // settings the composer returns wait for the human's approval.
    for (const surface of ["core/tools/aidlc-orchestrate.ts", ...skills]) {
      expect(read(surface), surface).toContain("never paste composer text into a command");
      expect(read(surface), surface).toContain("Also suggested by the composer");
    }
    // A mixed approval lands the stage changes and the settings in one recompose write.
    for (const surface of skills) {
      expect(read(surface), surface).toContain("on Approve all run ONE recompose carrying the stage changes and the settings as its flags");
    }
    for (const surface of ["core/agents/aidlc-composer-agent.md", "core/knowledge/aidlc-composer-agent/composing.md"]) {
      expect(read(surface), surface).toMatch(/Never put command text/);
    }
  });

  test("the gate's edit option covers the whole plan, and the composer names its route", () => {
    for (const surface of skills) {
      const text = read(surface);
      expect(text, surface).toContain("Approve / Edit the plan / Reject");
      expect(text, surface).not.toContain("Edit the grid");
    }
    for (const surface of ["core/agents/aidlc-composer-agent.md", "core/knowledge/aidlc-composer-agent/composing.md"]) {
      const text = read(surface);
      expect(text, surface).toContain("--matched");
      expect(text, surface).toContain("--custom");
    }
  });
});

describe("t349 (9) a review level set for the work replaces its scope's ceiling", () => {
  test("an override lifts or lowers the cap but never passes the stage's declaration", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const set = (level: string) => `- **Review Override**: ${level}\n`;
      expect(resolveReviewClass("adversarial", "express", set("adversarial"))).toBe("adversarial");
      expect(resolveReviewClass("adversarial", "bugfix", set("adversarial"))).toBe("adversarial");
      expect(resolveReviewClass("adversarial", "express", set("advisory"))).toBe("advisory");
      expect(resolveReviewClass("advisory", "bugfix", set("adversarial"))).toBe("advisory");
      expect(resolveReviewClass("adversarial", "feature", set("none"))).toBe("none");
      // No override: the scope's cap applies as before.
      expect(resolveReviewClass("adversarial", "bugfix", "")).toBe("advisory");
      expect(resolveReviewClass(undefined, "feature", set("adversarial"))).toBe("none");
    });
  });

  test("full reviews mid-workflow change the reviews and nothing else", () => {
    const proj = project();
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const statePath = join(seededRecordDir(proj), "aidlc-state.md");
    const env = { ...process.env, CLAUDE_PROJECT_DIR: proj };
    const run = (args: string[]) => {
      const res = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], { encoding: "utf-8", env });
      expect(res.status, `${args.join(" ")}: ${res.stdout}${res.stderr}`).toBe(0);
    };
    run(["scope-change", "--scope", "bugfix"]);
    const stages = (content: string) => content.split("\n").filter((line) => /^- \[.\] \S+ \u2014 (EXECUTE|SKIP)/.test(line));
    const before = readFileSync(statePath, "utf-8");
    run(["config-change", "--review", "adversarial"]);
    const after = readFileSync(statePath, "utf-8");
    expect(stages(after)).toEqual(stages(before));
    expect(after).toContain("- **Scope**: bugfix");
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(resolveReviewClass("adversarial", "bugfix", before)).toBe("advisory");
      expect(resolveReviewClass("adversarial", "bugfix", after)).toBe("adversarial");
    });
  });

  test("setting the scope's own level clears the override, so a later scope change follows the new scope", () => {
    const proj = project();
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const statePath = join(seededRecordDir(proj), "aidlc-state.md");
    const env = { ...process.env, CLAUDE_PROJECT_DIR: proj };
    const run = (args: string[]) => {
      const res = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], { encoding: "utf-8", env });
      expect(res.status, `${args.join(" ")}: ${res.stdout}${res.stderr}`).toBe(0);
      return `${res.stdout}`;
    };
    const override = () => /^- \*\*Review Override\*\*:[ \t]*(\S*)[ \t]*$/m.exec(readFileSync(statePath, "utf-8"))?.[1];
    run(["scope-change", "--scope", "bugfix", "--review", "none"]);
    expect(override()).toBe("none");
    // bugfix's own level is advisory: asking for it means back to normal.
    expect(run(["config-change", "--review", "advisory"])).toContain("Review override changed: none -> advisory (scope default)");
    expect(override()).toBe("");
    run(["scope-change", "--scope", "feature"]);
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(resolveReviewClass("adversarial", "feature", readFileSync(statePath, "utf-8"))).toBe("adversarial");
    });
    // On feature, adversarial is the scope's own level, so it clears too (the old reset still works there).
    run(["config-change", "--review", "none"]);
    run(["config-change", "--review", "adversarial"]);
    expect(override()).toBe("");
  });

  test("the creation preview follows a review level set at creation", () => {
    const preview = (args: string[]) => {
      const proj = createTestProject();
      tempDirs.push(proj);
      removeWorkspaceRecord(proj);
      const res = runOrchestrateNext(ORCH, proj, [...args, "--", "fix the token bug"], { cwd: proj, env: process.env });
      const line = res.out.split("\n").find((entry) => entry.trim().startsWith("{"));
      return String((JSON.parse(line ?? "{}") as { message?: unknown }).message);
    };
    expect(preview(["--scope", "express"])).toMatch(/no reviewers/);
    expect(preview(["--scope", "express", "--review", "adversarial"])).not.toMatch(/reviewers/);
    expect(preview(["--scope", "feature"])).not.toMatch(/reviewers/);
    expect(preview(["--scope", "feature", "--review", "none"])).toMatch(/no reviewers/);
  });

  test("next refuses any settings value outside the allowed words, so no command text rides along", () => {
    const proj = project();
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const hostile = ["off;touch /tmp/t349-pwn", "$(touch /tmp/t349-pwn)", "off --scope express", "on`id`"];
    for (const [flag, words] of [["--sensors", "<on|off>"], ["--learnings", "<on|off>"], ["--summary-confirmation", "<on|off>"], ["--review", "<adversarial|advisory|none>"]]) {
      for (const value of hostile) {
        const res = runOrchestrateNext(ORCH, proj, [flag, value], { cwd: proj, env: process.env });
        const line = res.out.split("\n").find((entry) => entry.trim().startsWith("{"));
        const directive = JSON.parse(line ?? "{}") as { kind?: unknown; message?: unknown };
        expect(directive.kind, `${flag} ${value}`).toBe("error");
        expect(String(directive.message)).toBe(`${flag} requires ${words}; received ${JSON.stringify(value)}.`);
      }
    }
    expect(existsSync("/tmp/t349-pwn")).toBe(false);
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

describe("t349 (10) the compose dispatch carries the settings contract", () => {
  test("front: the gate renders a Scope settings row and appends a matched plan's creation flags", () => {
    const proj = project();
    const message = composeMessage(proj, ["fix the token bug"]);
    expect(message).toContain("scopeSettingsRationale");
    expect(message).toContain('"Scope settings: sensors <sensors>, learnings <learnings>, summary confirmation <summary_confirmation>, reviews <review_cap> - <scopeSettingsRationale>"');
    expect(message).toContain("through its creationSettings, which you turn into creation flags after --scope <scopeName>");
    expect(message).toContain("never paste composer text into a command");
    expect(message).not.toContain("write no marker");
  });

  test("in-flight: settings are applied without a gate, and a settings-only request runs no recompose", () => {
    const proj = project();
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const message = composeMessage(proj, ["turn sensors off"]);
    expect(message).toContain("mode in-flight");
    // Settings the composer returns are shown for approval, never applied unasked.
    expect(message).toContain(
      'the composer returns it as settingsChanges, typed values you show on the approval gate under "Also suggested by the composer" and apply only when the human approves them',
    );
    expect(message).toContain("full reviews is --review adversarial and changes no stages");
    expect(message).toContain(
      "When the composer returns empty changes.skip and changes.add and no settingsChanges, write no marker, present no approval gate, and run no recompose: relay its answer and stop.",
    );
    expect(message).toContain(
      "When it returns only settingsChanges, write the marker and present them on the gate (Approve / Reject): on approve, delete the marker, then apply them by running next with the matching flags, which ends the turn; run no recompose.",
    );
    // A mixed approval lands the stage delta and the settings in one recompose
    // write, so neither half is lost.
    expect(message).toContain(
      "on Approve all, run ONE recompose carrying the stage delta and the settingsChanges as its matching flags, so both land in the same write",
    );
    expect(message).not.toContain("Scope settings: sensors <sensors>");
  });
});
