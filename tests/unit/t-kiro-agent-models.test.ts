// covers: file:tools/aidlc-model-policy.ts, function:isModelId, function:modelHarnessHonesty, function:presetsChangeNothing, function:kiroAgentModelsChoice, function:applyModelPolicyToProjection, function:modelPolicySurfaceDrift, function:sessionModelsDetail
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

// A tree on a preview release, and one on a stable release, with no recorded choice.
const PREVIEW = { version: "2.11.1-preview.20261015.1" };
const STABLE = { version: "2.11.0" };
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

  test("with it off, a preview build names the switch and a stable build does not mention it", () => {
    const off =
      "AI-DLC does not write a model or effort into its Kiro agent files, so every agent runs on your chat's model and effort (Kiro IDE's model picker, or Kiro CLI's session model); a model or effort set here is kept for other tools and changes nothing in Kiro.";
    expect(policy.modelHarnessHonesty("kiro-ide", STABLE).message).toBe(off);
    expect(policy.modelHarnessHonesty("kiro-ide", PREVIEW).message).toBe(
      `${off} In this preview build, turning agent-models on applies a model and effort set for one agent.`,
    );
    featureOn();
    expect(policy.modelHarnessHonesty("kiro-ide", STABLE).message).toBe(off);
  });

  test("a recorded choice decides on a preview release: on without the switch, off with it; a stable release ignores it", () => {
    expect(policy.kiroAgentModelsOn({ ...PREVIEW, agentModels: "on" })).toBe(true);
    featureOn();
    expect(policy.kiroAgentModelsOn({ ...PREVIEW, agentModels: "off" })).toBe(false);
    expect(policy.kiroAgentModelsOn({ ...PREVIEW, agentModels: null })).toBe(true);
    expect(policy.kiroAgentModelsOn({ ...STABLE, agentModels: "on" })).toBe(false);
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
    expect(fm).toMatch(/^model: "gpt-5\.6-terra"$/m);
    expect(fm).toMatch(/^effortLevel: high$/m);
    expect(fm).not.toMatch(/^effort:/m);
    for (const [name, text] of Object.entries(before)) {
      if (name === REVIEWER_FILE) continue;
      expect(after[name], name).toBe(text);
    }
    expect(cliSettings(root)).toBe(cli);
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", pinned, PREVIEW)).toEqual([]);
  });

  test("with the feature off the agent files are left as they are, the person's own lines too, and --check reads none", () => {
    const root = projection();
    const path = join(root, ".kiro", "agents", REVIEWER_FILE);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\n---\n/, "\nmodel: claude-sonnet-5.5\n---\n"));
    const before = agentFiles(root);
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, STABLE);
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, { ...PREVIEW, agentModels: "off" });
    expect(agentFiles(root)).toEqual(before);
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", null, STABLE)).toEqual([]);
  });

  test("the run that turns it off takes the lines out, and later runs leave a line the person adds", () => {
    featureOn();
    const root = projection();
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, PREVIEW);
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, { ...PREVIEW, agentModels: "off" }, true);
    const path = join(root, ".kiro", "agents", REVIEWER_FILE);
    expect(frontmatter(readFileSync(path, "utf-8"))).not.toMatch(/^(model|effortLevel):/m);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\n---\n/, "\nmodel: claude-sonnet-5.5\n---\n"));
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, { ...PREVIEW, agentModels: "off" });
    expect(frontmatter(readFileSync(path, "utf-8"))).toMatch(/^model: claude-sonnet-5\.5$/m);
  });

  test("a model id YAML would read as null, a number or a mapping is written quoted and reads back as the id", () => {
    featureOn();
    for (const id of ["null", "gpt:", "1.5"]) {
      const value: ModelPolicyRecord = { schemaVersion: 1, agents: { [REVIEWER]: { model: id } } };
      const root = projection();
      policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", value, null, PREVIEW);
      expect(frontmatter(agentFiles(root)[REVIEWER_FILE])).toContain(`model: ${JSON.stringify(id)}`);
      expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", value, PREVIEW), id).toEqual([]);
    }
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

  test("the choice a config run records: the flag, then the record, then the switch on a preview release", () => {
    expect(policy.kiroAgentModelsChoice("on", "off", PREVIEW.version)).toBe("off");
    expect(policy.kiroAgentModelsChoice("off", undefined, PREVIEW.version)).toBe("off");
    expect(policy.kiroAgentModelsChoice(undefined, undefined, PREVIEW.version)).toBeNull();
    featureOn();
    expect(policy.kiroAgentModelsChoice(undefined, undefined, PREVIEW.version)).toBe("on");
    expect(policy.kiroAgentModelsChoice(undefined, undefined, STABLE.version)).toBeNull();
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
    expect(fm).toMatch(/^model: "gpt-5\.6-terra"$/m);
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
  test("a recorded model id that is not one plain token is kept readable but never written into a Kiro agent file", () => {
    featureOn();
    for (const recorded of ["gpt-5.6-terra\ntools: [\"shell\"]", "#gpt", "\"gpt", "gpt\u0085x"]) {
      const value: ModelPolicyRecord = { schemaVersion: 1, agents: { [REVIEWER]: { model: recorded } } };
      expect(normalizeSettingsModels({ schemaVersion: 1, agents: { [REVIEWER]: { model: { "kiro-ide": recorded } } } }))
        .not.toBeNull();
      const resolved = policy.resolveModelPolicy(value, REVIEWER, "balanced", "kiro-ide", null, PREVIEW);
      expect(resolved.model, JSON.stringify(recorded)).toBeUndefined();
      expect(resolved.unexpressed).toEqual(["model"]);
      const root = projection();
      const before = agentFiles(root)[REVIEWER_FILE];
      policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", value, null, PREVIEW);
      expect(agentFiles(root)[REVIEWER_FILE], JSON.stringify(recorded)).toBe(before);
    }
    const tiers = policy.readAgentTiers(join(projection(), ".kiro"));
    expect(
      policy.harnessHonestyNotes({ schemaVersion: 1, agents: { [REVIEWER]: { model: "#gpt" } } }, tiers, "kiro-ide", null, PREVIEW),
    ).toContain(
      `The model id recorded for ${REVIEWER} is not one plain id, so it is not written; set it again with \`aidlc config models --agent ${REVIEWER} --model <id>\`.`,
    );
    expect(policy.isModelId("claude-opus-4-8[1m]")).toBe(true);
    expect(policy.isModelId("arn:aws:bedrock:us-east-1::foundation-model/x")).toBe(true);
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
    expect(`${refused.stdout}${refused.stderr}`).toContain("--model takes one model id as your tool names it");
    const settings = projectSettingsPath(project);
    const recorded = existsSync(settings) ? (JSON.parse(readFileSync(settings, "utf-8")) as { models?: unknown }) : {};
    expect(recorded.models).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

// The commands a person runs, on a project installed from a preview release
// (the release tree with a preview version stamped in).
describe("the agent-models choice through config", () => {
  const previewVersion = "2.11.1-preview.20261016.1";
  function previewRuntime(): string {
    const runtime = temp("aidlc-kiro-agent-models-runtime-");
    cpSync(KIRO_IDE_RELEASE, join(runtime, "kiro-ide"), { recursive: true });
    const stamp = join(runtime, "kiro-ide", ".kiro", "tools", "data", "aidlc-stamp.json");
    writeFileSync(stamp, readFileSync(stamp, "utf-8").replace(/"frameworkVersion": "[^"]+"/, `"frameworkVersion": "${previewVersion}"`));
    const versionFile = join(runtime, "kiro-ide", ".kiro", "tools", "aidlc-version.ts");
    writeFileSync(versionFile, readFileSync(versionFile, "utf-8").replace(/AIDLC_VERSION = "[^"]+"/, `AIDLC_VERSION = "${previewVersion}"`));
    return runtime;
  }
  function project(runtime: string) {
    const dir = temp("aidlc-kiro-agent-models-proj-");
    mkdirSync(join(dir, ".git"));
    const machine = temp("aidlc-kiro-agent-models-m-");
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
      AIDLC_RUNTIME_ROOT: runtime,
    };
    delete base[FEATURE_ENV];
    const run = (args: string[], switchOn = false) => {
      const result = spawnSync(process.execPath, [join(REPO_ROOT, "core", "tools", "aidlc-init.ts"), ...args], {
        cwd: dir,
        env: switchOn ? { ...base, [FEATURE_ENV]: "agent-models" } : base,
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    };
    const install = run(["config", "--project-dir", dir, "--from", join(runtime, "kiro-ide"), "--harness", "kiro-ide", "--mcp", "none", "--yes"]);
    expect(install.status, install.out).toBe(0);
    const reviewer = () => frontmatter(readFileSync(join(dir, ".kiro", "agents", REVIEWER_FILE), "utf-8"));
    const choice = () =>
      (JSON.parse(readFileSync(join(dir, ".kiro", "tools", "data", "harness.json"), "utf-8")) as Record<string, unknown>).agentModels;
    return { dir, run, reviewer, choice };
  }

  test("a pin made with the switch on is recorded and survives a later config run without it", () => {
    const p = project(previewRuntime());
    const pin = p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--effort", "high", "--yes"], true);
    expect(pin.status, pin.out).toBe(0);
    expect(p.choice()).toBe("on");
    expect(p.reviewer()).toMatch(/^model: "gpt-5\.6-terra"$/m);
    const other = p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", "developer", "--effort", "low", "--yes"]);
    expect(other.status, other.out).toBe(0);
    expect(p.reviewer()).toMatch(/^effortLevel: high$/m);
    const check = p.run(["config", "models", "--project-dir", p.dir, "--check"]);
    expect(check.status, check.out).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("off beats the switch, says once what it takes out, and on puts it back", () => {
    const p = project(previewRuntime());
    expect(p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes"], true).status).toBe(0);
    const dry = p.run(["config", "models", "--project-dir", p.dir, "--agent-models", "off", "--dry-run"], true);
    expect(dry.out).toContain("Kiro agent models: on -> off in .kiro/tools/data/harness.json");
    expect(p.reviewer()).toMatch(/^model: "gpt-5\.6-terra"$/m);
    const off = p.run(["config", "models", "--project-dir", p.dir, "--agent-models", "off", "--yes"], true);
    expect(off.status, off.out).toBe(0);
    expect(off.out).toContain("Kiro takes it at each agent's next dispatch. To undo: ");
    expect(off.out).toContain("config models --agent-models on --yes");
    expect(p.choice()).toBe("off");
    expect(p.reviewer()).not.toMatch(/^model:/m);
    expect(p.run(["config", "--project-dir", p.dir, "--yes"], true).status).toBe(0);
    expect(p.reviewer()).not.toMatch(/^model:/m);
    const on = p.run(["config", "models", "--project-dir", p.dir, "--agent-models", "on", "--yes"]);
    expect(on.status, on.out).toBe(0);
    expect(p.choice()).toBe("on");
    expect(p.reviewer()).toMatch(/^model: "gpt-5\.6-terra"$/m);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 3);

  test("the same pin again with the switch on records it and writes the lines a stable-time pin left unwritten", () => {
    const p = project(previewRuntime());
    expect(p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", REVIEWER, "--effort", "high", "--yes"]).status).toBe(0);
    expect(p.reviewer()).not.toMatch(/^effortLevel:/m);
    const again = p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", REVIEWER, "--effort", "high", "--yes"], true);
    expect(again.status, again.out).toBe(0);
    expect(p.choice()).toBe("on");
    expect(p.reviewer()).toMatch(/^effortLevel: high$/m);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("the switch with a policy flag says the switch line, the JSON names it, and an unchanged pin under a preset stays unchanged", () => {
    const p = project(previewRuntime());
    expect(p.run(["config", "models", "--project-dir", p.dir, "--project", "--preset", "balanced", "--yes"]).status).toBe(0);
    const both = p.run([
      "config", "models", "--project-dir", p.dir, "--project", "--agent-models", "on", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes", "--json",
    ]);
    expect(both.status, both.out).toBe(0);
    const payload = JSON.parse(both.out.trim().split("\n").at(-1) ?? "{}") as { data?: { models?: { agentModels?: string; summaries?: string[] } } };
    expect(payload.data?.models?.agentModels).toBe("on");
    expect(payload.data?.models?.summaries?.[0]).toContain("Kiro agent models: not set -> on in .kiro/tools/data/harness.json");
    const again = p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes"]);
    expect(again.out).toContain("model policy unchanged");
    const bare = temp("aidlc-kiro-agent-models-bare-");
    const refused = p.run(["config", "models", "--project-dir", bare, "--agent-models", "on", "--preset", "balanced", "--global", "--dry-run"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("--agent-models applies to an installed Kiro (kiro-ide) project");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("off on a project where it was never on leaves the person's own lines, and its line says no agent file changes", () => {
    const p = project(previewRuntime());
    const path = join(p.dir, ".kiro", "agents", REVIEWER_FILE);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\n---\n/, "\nmodel: claude-sonnet-5.5\n---\n"));
    const off = p.run(["config", "models", "--project-dir", p.dir, "--agent-models", "off", "--yes"]);
    expect(off.status, off.out).toBe(0);
    expect(off.out).toContain("Kiro agent models: not set -> off in .kiro/tools/data/harness.json; the agent files do not change.");
    expect(p.reviewer()).toMatch(/^model: claude-sonnet-5\.5$/m);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("with the variable set but nothing recorded, off still leaves the person's line, and on says what it writes", () => {
    const p = project(previewRuntime());
    const path = join(p.dir, ".kiro", "agents", REVIEWER_FILE);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\n---\n/, "\nmodel: claude-sonnet-5.5\n---\n"));
    const off = p.run(["config", "models", "--project-dir", p.dir, "--agent-models", "off", "--yes"], true);
    expect(off.status, off.out).toBe(0);
    expect(off.out).toContain("the agent files do not change.");
    expect(p.reviewer()).toMatch(/^model: claude-sonnet-5\.5$/m);
    const on = p.run(["config", "models", "--project-dir", p.dir, "--agent-models", "on", "--yes"], true);
    expect(on.out).toContain("Kiro takes it at each agent's next dispatch. To undo: ");
    expect(on.out).toContain("--agent-models off --yes");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("a run that records the choice from the switch says so", () => {
    const p = project(previewRuntime());
    const pin = p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes"], true);
    expect(pin.status, pin.out).toBe(0);
    expect(pin.out).toContain("Recorded agent-models on for this project, because AIDLC_PREVIEW_FEATURES names it");
    expect(p.run(["config", "models", "--project-dir", p.dir, "--check"]).status).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("a project on a stable release writes and records nothing with the switch on, and refuses --agent-models", () => {
    const p = project(join(REPO_ROOT, "dist-release"));
    const pin = p.run(["config", "models", "--project-dir", p.dir, "--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes"], true);
    expect(pin.status, pin.out).toBe(0);
    expect(p.reviewer()).not.toMatch(/^model:/m);
    expect(p.choice()).toBeUndefined();
    const refused = p.run(["config", "models", "--project-dir", p.dir, "--agent-models", "on", "--yes"], true);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("--agent-models needs this project on a preview release of AI-DLC");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);
});
