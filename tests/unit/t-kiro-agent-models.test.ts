// covers: file:tools/aidlc-model-policy.ts, function:isModelId, function:modelHarnessHonesty, function:presetsChangeNothing, function:kiroAgentModelsDropped, function:applyModelPolicyToProjection, function:modelPolicySurfaceDrift, function:sessionModelsDetail
//
// On Kiro (kiro-ide) a delegated agent runs on its own `model` and
// `effortLevel` (Kiro CLI 2.31.1 on its v3 engine, Kiro IDE 1.3.0). With the
// agent-models preview feature on, `aidlc config models --agent <name>` writes
// that agent's model and effort into its Kiro agent file; without it the row
// keeps every agent on the session's model and effort, as before. A preset or
// group effort has no per-agent Kiro surface either way.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { renderReviewCopy } from "../../core/tools/aidlc-kiro-review-copy.ts";
import * as policy from "../../core/tools/aidlc-model-policy.ts";
import type { ModelPolicyRecord } from "../../core/tools/aidlc-model-policy.ts";
import { normalizeSettingsModels, projectSettingsPath } from "../../core/tools/aidlc-settings.ts";

const PREVIEW = "2.11.1-preview.20261015.1";
const STABLE = "2.11.0";
const FEATURE_ENV = "AIDLC_PREVIEW_FEATURES";
const KIRO_IDE_RELEASE = join(REPO_ROOT, "dist-release", "kiro-ide");
const REVIEWER = "architecture-reviewer";
const REVIEWER_FILE = "aidlc-architecture-reviewer-agent.md";
const pinned: ModelPolicyRecord = {
  schemaVersion: 1,
  agents: { [REVIEWER]: { model: "gpt-5.6-terra", effort: "high" } },
};

const temporary: string[] = [];
const savedFeatures = process.env[FEATURE_ENV];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function featureOn(): void {
  process.env[FEATURE_ENV] = "agent-models";
}

afterEach(() => {
  if (savedFeatures === undefined) delete process.env[FEATURE_ENV];
  else process.env[FEATURE_ENV] = savedFeatures;
});

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

// A kiro-ide projection: the release tree as setup stages it.
function projection(): string {
  const root = temp("aidlc-kiro-agent-models-");
  cpSync(KIRO_IDE_RELEASE, root, { recursive: true });
  return root;
}

function agentFiles(root: string): Record<string, string> {
  const dir = join(root, ".kiro", "agents");
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name), "utf-8")]));
}

function frontmatter(text: string): string {
  return text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
}

function cliSettings(root: string): string {
  return readFileSync(join(root, ".kiro", "settings", "cli.json"), "utf-8");
}

describe("the agent-models switch", () => {
  test("only a preview build with agent-models named lets kiro-ide pin one agent's model and effort", () => {
    featureOn();
    expect(policy.modelHarnessHonesty("kiro-ide", PREVIEW)).toMatchObject({ model: true, effort: true, groupEffort: false });
    expect(policy.modelHarnessHonesty("kiro-ide", STABLE)).toMatchObject({ model: false, effort: false });
    expect(policy.modelHarnessHonesty("kiro", PREVIEW)).toBe(policy.HARNESS_HONESTY.kiro);
    process.env[FEATURE_ENV] = "reviewer-read-scope";
    expect(policy.modelHarnessHonesty("kiro-ide", PREVIEW)).toMatchObject({ model: false, effort: false });
  });

  test("with it on, a preset still changes nothing on kiro-ide, so setup asks for none", () => {
    featureOn();
    expect(policy.sessionSetsAgentModels("kiro-ide", PREVIEW)).toBe(false);
    expect(policy.presetsChangeNothing("kiro-ide", PREVIEW)).toBe(true);
    // The other rows read the same as the stable kiro-ide row.
    expect(policy.presetsChangeNothing("kiro-ide", STABLE)).toBe(true);
    expect(policy.presetsChangeNothing("kiro", PREVIEW)).toBe(false);
    expect(policy.presetsChangeNothing("claude", PREVIEW)).toBe(false);
    expect(policy.presetsChangeNothing("cursor", PREVIEW)).toBe(true);
  });

  test("the setup sentence names one agent's model and effort as the lever, and a preset as not applying", () => {
    featureOn();
    expect(policy.sessionModelsDetail("kiro-ide", { schemaVersion: 1, preset: "thorough" }, PREVIEW)).toBe(
      "every agent uses your Kiro session's model and effort unless a model or effort is set for that agent; the recorded thorough preset does not apply here",
    );
    expect(policy.sessionModelsDetail("kiro-ide", null, STABLE)).toBe("every agent uses your Kiro session's model and effort");
  });
});

describe("resolving one agent's model and effort on kiro-ide", () => {
  test("an agent's own model and effort apply; a preset's effort does not reach it", () => {
    featureOn();
    const own = policy.resolveModelPolicy(pinned, REVIEWER, "balanced", "kiro-ide", null, PREVIEW);
    expect(own).toMatchObject({ model: "gpt-5.6-terra", effort: "high", unexpressed: [] });
    const modelOnly = policy.resolveModelPolicy(
      { schemaVersion: 1, preset: "thorough", agents: { [REVIEWER]: { model: "gpt-5.6-terra" } } },
      REVIEWER,
      "balanced",
      "kiro-ide",
      null,
      PREVIEW,
    );
    expect(modelOnly.model).toBe("gpt-5.6-terra");
    expect(modelOnly.effort).toBeUndefined();
    expect(modelOnly.unexpressed).toEqual(["effort"]);
    const stable = policy.resolveModelPolicy(pinned, REVIEWER, "balanced", "kiro-ide", null, STABLE);
    expect(stable.model).toBeUndefined();
    expect(stable.unexpressed).toEqual(["model", "effort"]);
  });
});

describe("writing kiro-ide agent files", () => {
  test("with the switch on, the pinned agent's file gets model and effortLevel and nothing else changes", () => {
    featureOn();
    const root = projection();
    const before = agentFiles(root);
    const cli = cliSettings(root);
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, PREVIEW);
    const after = agentFiles(root);
    const fm = frontmatter(after[REVIEWER_FILE]);
    expect(fm).toMatch(/^model: gpt-5\.6-terra$/m);
    expect(fm).toMatch(/^effortLevel: high$/m);
    expect(fm).not.toMatch(/^effort:/m);
    for (const [name, text] of Object.entries(before)) {
      if (name === REVIEWER_FILE) continue;
      expect(after[name], name).toBe(text);
    }
    expect(cliSettings(root)).toBe(cli);
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", pinned, PREVIEW)).toEqual([]);
  });

  test("without the switch nothing is written, and a line left behind reads as drift", () => {
    const root = projection();
    const before = agentFiles(root);
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, STABLE);
    expect(agentFiles(root)).toEqual(before);
    const path = join(root, ".kiro", "agents", REVIEWER_FILE);
    writeFileSync(path, before[REVIEWER_FILE].replace(/\n---\n/, "\nmodel: gpt-5.6-terra\n---\n"));
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", null, STABLE)).toContain(
      `${REVIEWER}: model gpt-5.6-terra != inherit`,
    );
  });

  test("an edited effortLevel reads as drift with the switch on", () => {
    featureOn();
    const root = projection();
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, PREVIEW);
    const path = join(root, ".kiro", "agents", REVIEWER_FILE);
    writeFileSync(path, readFileSync(path, "utf-8").replace("effortLevel: high", "effortLevel: low"));
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", pinned, PREVIEW)).toContain(
      `${REVIEWER}: effort low != high`,
    );
  });

  test("a refresh without the switch names the agents whose model and effort it takes out", () => {
    featureOn();
    const project = projection();
    policy.applyModelPolicyToProjection(project, ".kiro", "kiro-ide", pinned, null, PREVIEW);
    const staged = projection();
    policy.applyModelPolicyToProjection(staged, ".kiro", "kiro-ide", pinned, null, STABLE);
    expect(policy.kiroAgentModelsDropped(join(project, ".kiro", "agents"), join(staged, ".kiro", "agents"), pinned))
      .toEqual([REVIEWER]);
    expect(policy.kiroAgentModelsDropped(join(staged, ".kiro", "agents"), join(staged, ".kiro", "agents"), pinned))
      .toEqual([]);
  });

  test("an agent the person added keeps its own model line, and the refresh does not name it", () => {
    const project = projection();
    const staged = projection();
    const own = "aidlc-my-helper-agent.md";
    writeFileSync(
      join(project, ".kiro", "agents", own),
      "---\nname: aidlc-my-helper-agent\ndescription: mine\nmodel: gpt-5.6-luna\n---\n\nHelp.\n",
    );
    const mine: ModelPolicyRecord = { schemaVersion: 1, agents: { "my-helper": { model: "gpt-5.6-luna" } } };
    expect(policy.kiroAgentModelsDropped(join(project, ".kiro", "agents"), join(staged, ".kiro", "agents"), mine))
      .toEqual([]);
  });

  test("a review's reviewer copy keeps the reviewer's model and effortLevel", () => {
    featureOn();
    const root = projection();
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, PREVIEW);
    const copy = renderReviewCopy(
      readFileSync(join(root, ".kiro", "agents", REVIEWER_FILE), "utf-8"),
      "aidlc-review-0123456789ab",
      "alpha",
    );
    expect(copy).not.toBeNull();
    const fm = frontmatter(copy ?? "");
    expect(fm).toMatch(/^model: gpt-5\.6-terra$/m);
    expect(fm).toMatch(/^effortLevel: high$/m);
  });
});

describe("the doctor and the notes on kiro-ide", () => {
  test("a shared preset is not a problem here, and the note names what Kiro takes", () => {
    featureOn();
    const root = projection();
    const shared: ModelPolicyRecord = { schemaVersion: 1, preset: "thorough", agents: pinned.agents };
    expect(policy.modelPolicyDoctorIssues(join(root, ".kiro"), "kiro-ide", shared, PREVIEW)).toEqual([]);
    const tiers = policy.readAgentTiers(join(root, ".kiro"));
    expect(policy.harnessHonestyNotes(shared, tiers, "kiro-ide", null, PREVIEW)).toEqual([
      "Kiro takes a model and an effort set for one agent; a preset or group effort is kept for other tools and changes nothing in Kiro.",
    ]);
  });
});

describe("the --model value", () => {
  test("a recorded model id with a line break is refused where settings and policy are read", () => {
    const injected = "gpt-5.6-terra\ntools: [\"shell\"]";
    expect(() => normalizeSettingsModels({ schemaVersion: 1, agents: { [REVIEWER]: { model: { "kiro-ide": injected } } } }))
      .toThrow("must be one model ID with no spaces");
    expect(() => policy.normalizeModelPolicy({ schemaVersion: 1, agents: { [REVIEWER]: { model: injected } } }))
      .toThrow("must be one model id with no spaces");
  });

  test("a model id with a space is refused before anything is recorded", () => {
    const project = temp("aidlc-kiro-agent-models-project-");
    mkdirSync(join(project, ".git"));
    const machine = temp("aidlc-kiro-agent-models-machine-");
    const env = {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
      AIDLC_RUNTIME_ROOT: join(REPO_ROOT, "dist-release"),
    };
    const init = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [init, ...args], {
        cwd: project,
        env,
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
    const install = run([
      "config", "--project-dir", project, "--from", KIRO_IDE_RELEASE, "--harness", "kiro-ide", "--mcp", "none", "--yes",
    ]);
    expect(install.status, `${install.stdout}${install.stderr}`).toBe(0);
    const refused = run([
      "config", "models", "--project-dir", project, "--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra\neffortLevel: max", "--yes",
    ]);
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("--model takes one model id with no spaces");
    const settings = projectSettingsPath(project);
    const recorded = existsSync(settings) ? (JSON.parse(readFileSync(settings, "utf-8")) as { models?: unknown }) : {};
    expect(recorded.models).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
