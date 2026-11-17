// covers: file:tools/aidlc-model-policy.ts, function:isModelId, function:presetsChangeNothing, function:applyModelPolicyToProjection, function:modelPolicySurfaceDrift, function:sessionModelsDetail, function:kiroAgentPinsAdded, function:kiroAgentPinsNote, function:kiroIdeAgentFileModels, file:tools/aidlc-kiro-session.ts, function:checkKiroAgentModels, function:kiroAgentModelLines, function:kiroAgentModelDoctorFindings, file:tools/aidlc-doctor.ts, function:kiroAgentModelDoctorChecks
//
// On Kiro (kiro-ide) a delegated agent runs on its own `model` and
// `effortLevel` (Kiro CLI 2.31.1 on its v3 engine, Kiro IDE 1.3.0), so
// `aidlc config models --agent <name>` writes that agent's model and effort
// into its Kiro agent file, on every release. A preset or group effort has no
// per-agent Kiro surface. A config run that is not a models change and writes
// such a line for the first time (an effort recorded for another tool, which
// every tool shares) says so with the command that takes it out.
//
// Kiro runs an agent whose model the account does not offer on the chat's
// model and says nothing (Kiro CLI 3.3.0, Kiro IDE 1.4.178), so `config
// models`, its --check and doctor name an agent model Kiro CLI's model list
// does not have, or say they could not check; none of them stops.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { kiroAgentModelDoctorChecks } from "../../core/tools/aidlc-doctor.ts";
import { renderReviewCopy } from "../../core/tools/aidlc-kiro-review-copy.ts";
import * as policy from "../../core/tools/aidlc-model-policy.ts";
import type { ModelPolicyRecord } from "../../core/tools/aidlc-model-policy.ts";
import { normalizeSettingsModels, projectSettingsPath } from "../../core/tools/aidlc-settings.ts";

const KIRO_IDE_RELEASE = join(REPO_ROOT, "dist-release", "kiro-ide");
const REVIEWER = "architecture-reviewer";
const REVIEWER_FILE = "aidlc-architecture-reviewer-agent.md";
const pinned: ModelPolicyRecord = {
  schemaVersion: 1,
  agents: { [REVIEWER]: { model: "gpt-5.6-terra", effort: "high" } },
};

const temporary: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

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

describe("what kiro-ide takes", () => {
  test("one agent's own model and effort, never a preset or group effort, so setup asks for none", () => {
    expect(policy.HARNESS_HONESTY["kiro-ide"]).toMatchObject({ model: true, effort: true, groupEffort: false });
    expect(policy.sessionSetsAgentModels("kiro-ide")).toBe(false);
    expect(policy.presetsChangeNothing("kiro-ide")).toBe(true);
    expect(policy.presetsChangeNothing("kiro")).toBe(false);
    expect(policy.presetsChangeNothing("claude")).toBe(false);
    expect(policy.presetsChangeNothing("cursor")).toBe(true);
    expect(policy.sessionModelsDetail("kiro-ide", { schemaVersion: 1, preset: "thorough" })).toBe(
      "every agent uses your Kiro session's model and effort unless a model or effort is set for that agent; the recorded thorough preset does not apply here",
    );
  });

  test("an agent's own model and effort apply; a preset's effort does not reach it", () => {
    expect(policy.resolveModelPolicy(pinned, REVIEWER, "balanced", "kiro-ide"))
      .toMatchObject({ model: "gpt-5.6-terra", effort: "high", unexpressed: [] });
    const modelOnly = policy.resolveModelPolicy(
      { schemaVersion: 1, preset: "thorough", agents: { [REVIEWER]: { model: "gpt-5.6-terra" } } },
      REVIEWER,
      "balanced",
      "kiro-ide",
    );
    expect(modelOnly.model).toBe("gpt-5.6-terra");
    expect(modelOnly.effort).toBeUndefined();
    expect(modelOnly.unexpressed).toEqual(["effort"]);
  });
});

describe("writing kiro-ide agent files", () => {
  test("the pinned agent's file gets a quoted model and effortLevel and nothing else changes", () => {
    const root = projection();
    const before = agentFiles(root);
    const cli = readFileSync(join(root, ".kiro", "settings", "cli.json"), "utf-8");
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null);
    const after = agentFiles(root);
    const fm = frontmatter(after[REVIEWER_FILE]);
    expect(fm).toMatch(/^model: "gpt-5\.6-terra"$/m);
    expect(fm).toMatch(/^effortLevel: high$/m);
    expect(fm).not.toMatch(/^effort:/m);
    for (const [name, text] of Object.entries(before)) {
      if (name !== REVIEWER_FILE) expect(after[name], name).toBe(text);
    }
    expect(readFileSync(join(root, ".kiro", "settings", "cli.json"), "utf-8")).toBe(cli);
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", pinned)).toEqual([]);
  });

  test("an agent with nothing set loses a model line added by hand, as on Claude Code", () => {
    const root = projection();
    const path = join(root, ".kiro", "agents", "aidlc-developer-agent.md");
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\n---\n/, "\nmodel: claude-sonnet-5.5\n---\n"));
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null);
    expect(frontmatter(readFileSync(path, "utf-8"))).not.toMatch(/^model:/m);
    expect(readFileSync(path, "utf-8")).toBe(readFileSync(join(KIRO_IDE_RELEASE, ".kiro", "agents", "aidlc-developer-agent.md"), "utf-8"));
  });

  test("a model id YAML would read as null, a number or a mapping is written quoted and reads back as the id", () => {
    for (const id of ["null", "gpt:", "1.5"]) {
      const value: ModelPolicyRecord = { schemaVersion: 1, agents: { [REVIEWER]: { model: id } } };
      const root = projection();
      policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", value, null);
      expect(frontmatter(agentFiles(root)[REVIEWER_FILE])).toContain(`model: ${JSON.stringify(id)}`);
      expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", value), id).toEqual([]);
    }
  });

  test("the shared Markdown writer takes an effortLevel line out only of a Kiro agent file", () => {
    const text = "---\nname: x\neffortLevel: low\n---\nBody\n";
    expect(policy.writeMarkdownAgentSurface(text, { model: "m" })).toContain("effortLevel: low");
    expect(policy.writeMarkdownAgentSurface(text, { model: "m" }, { effortKey: "effortLevel" })).not.toContain("effortLevel: low");
  });

  test("an edited effortLevel reads as drift", () => {
    const root = projection();
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null);
    const path = join(root, ".kiro", "agents", REVIEWER_FILE);
    writeFileSync(path, readFileSync(path, "utf-8").replace("effortLevel: high", "effortLevel: low"));
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", pinned)).toContain(`${REVIEWER}: effort low != high`);
  });

  test("a recorded preset and group effort write nothing and are no drift", () => {
    const root = projection();
    const before = agentFiles(root);
    const shared: ModelPolicyRecord = { schemaVersion: 1, preset: "thorough", groups: { reviewing: { effort: "max" } } };
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", shared, null);
    expect(agentFiles(root)).toEqual(before);
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", shared)).toEqual([]);
  });

  test("the agents whose staged file gains a model or effort are named with the values it gains", () => {
    const project = projection();
    const staged = projection();
    policy.applyModelPolicyToProjection(staged, ".kiro", "kiro-ide", pinned, null);
    expect(policy.kiroAgentPinsAdded(project, staged, ".kiro")).toEqual([
      { agent: REVIEWER, path: `.kiro/agents/${REVIEWER_FILE}`, model: "gpt-5.6-terra", effort: "high" },
    ]);
    policy.applyModelPolicyToProjection(project, ".kiro", "kiro-ide", { schemaVersion: 1, agents: { [REVIEWER]: { model: "gpt-5.6-terra" } } }, null);
    expect(policy.kiroAgentPinsAdded(project, staged, ".kiro")).toEqual([
      { agent: REVIEWER, path: `.kiro/agents/${REVIEWER_FILE}`, effort: "high" },
    ]);
    policy.applyModelPolicyToProjection(project, ".kiro", "kiro-ide", pinned, null);
    expect(policy.kiroAgentPinsAdded(project, staged, ".kiro")).toEqual([]);
  });

  test("a review's reviewer copy keeps the reviewer's model and effortLevel", () => {
    const root = projection();
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null);
    const copy = renderReviewCopy(
      readFileSync(join(root, ".kiro", "agents", REVIEWER_FILE), "utf-8"),
      "aidlc-scoped-review-0123456789ab",
      "aidlc/spaces/default/intents/i1",
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
    const root = projection();
    const shared: ModelPolicyRecord = { schemaVersion: 1, preset: "thorough", agents: pinned.agents };
    expect(policy.modelPolicyDoctorIssues(join(root, ".kiro"), "kiro-ide", shared)).toEqual([]);
    const tiers = policy.readAgentTiers(join(root, ".kiro"));
    expect(policy.harnessHonestyNotes(shared, tiers, "kiro-ide", null)).toEqual([
      "Kiro takes a model and an effort set for one agent; a preset or group effort is kept for other tools and changes nothing in Kiro.",
    ]);
  });

  test("a recorded model id that is not one plain token is kept readable, never written, and named in a note", () => {
    for (const recorded of ["gpt-5.6-terra\ntools: [\"shell\"]", "#gpt", "\"gpt", "gpt\u0085x"]) {
      const value: ModelPolicyRecord = { schemaVersion: 1, agents: { [REVIEWER]: { model: recorded } } };
      expect(normalizeSettingsModels({ schemaVersion: 1, agents: { [REVIEWER]: { model: { "kiro-ide": recorded } } } }))
        .not.toBeNull();
      const resolved = policy.resolveModelPolicy(value, REVIEWER, "balanced", "kiro-ide");
      expect(resolved.model, JSON.stringify(recorded)).toBeUndefined();
      expect(resolved.unexpressed).toEqual(["model"]);
      const root = projection();
      const before = agentFiles(root)[REVIEWER_FILE];
      policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", value, null);
      expect(agentFiles(root)[REVIEWER_FILE], JSON.stringify(recorded)).toBe(before);
    }
    const tiers = policy.readAgentTiers(join(projection(), ".kiro"));
    expect(policy.harnessHonestyNotes({ schemaVersion: 1, agents: { [REVIEWER]: { model: "#gpt" } } }, tiers, "kiro-ide", null))
      .toContain(
        `The model id recorded for ${REVIEWER} is not one plain id, so it is not written; set it again with \`aidlc config models --agent ${REVIEWER} --model <id>\`.`,
      );
    expect(policy.isModelId("claude-opus-4-8[1m]")).toBe(true);
    expect(policy.isModelId("arn:aws:bedrock:us-east-1::foundation-model/x")).toBe(true);
  });
});

// The commands a person runs, on a project installed from the stable release.
describe("an agent's model and effort through config", () => {
  function project() {
    const dir = temp("aidlc-kiro-agent-models-proj-");
    mkdirSync(join(dir, ".git"));
    const machine = temp("aidlc-kiro-agent-models-m-");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
      // A refresh reads the release files from here.
      AIDLC_RUNTIME_ROOT: join(REPO_ROOT, "dist-release"),
    };
    const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
      const result = spawnSync(process.execPath, [join(REPO_ROOT, "core", "tools", "aidlc-init.ts"), ...args], {
        cwd: dir,
        env: { ...env, ...extra },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      return { status: result.status, out: `${result.stdout}${result.stderr}`, stdout: result.stdout };
    };
    const install = run(["config", "--project-dir", dir, "--from", KIRO_IDE_RELEASE, "--harness", "kiro", "--mcp", "none", "--yes"]);
    expect(install.status, install.out).toBe(0);
    const agent = (file: string) => frontmatter(readFileSync(join(dir, ".kiro", "agents", file), "utf-8"));
    const models = (...args: string[]) => run(["config", "models", "--project-dir", dir, ...args]);
    // Kiro CLI's model list, through the test seam that stands in for kiro-cli.
    const listed = (list: string[] | null, ...args: string[]) =>
      run(["config", "models", "--project-dir", dir, ...args], {
        AIDLC_TEST_KIRO_SESSION_JSON: JSON.stringify({ models: list?.map((id) => ({ model_id: id })) ?? null }),
      });
    return { dir, run, models, listed, agent };
  }

  const KIRO_LIST = ["auto", "claude-opus-5.5", "gpt-5.6-terra"];
  const notListed = (model: string) =>
    `${REVIEWER}'s model ${model} is not in Kiro CLI's model list (\`kiro-cli chat --list-models\`); Kiro runs an agent whose model it does not offer on your chat's model.`;

  test("an agent model Kiro CLI does not list is recorded and named, again on a repeat and by --check; a listed one is not", () => {
    const p = project();
    const set = p.listed(KIRO_LIST, "--project", "--agent", REVIEWER, "--model", "gpt-9-imaginary", "--effort", "high", "--yes");
    expect(set.status, set.out).toBe(0);
    expect(p.agent(REVIEWER_FILE)).toMatch(/^model: "gpt-9-imaginary"$/m);
    expect(set.out).toContain(`  Note: ${notListed("gpt-9-imaginary")}\n`);
    const again = p.listed(KIRO_LIST, "--project", "--agent", REVIEWER, "--model", "gpt-9-imaginary", "--yes");
    expect(again.status, again.out).toBe(0);
    expect(again.out).toContain("model policy unchanged");
    expect(again.out).toContain(`  Note: ${notListed("gpt-9-imaginary")}\n`);
    // Quiet output prints no notes, so the line comes as a warning.
    const quiet = p.listed(KIRO_LIST, "--project", "--agent", REVIEWER, "--model", "gpt-9-imaginary", "--yes", "--quiet");
    expect(quiet.stdout).toBe(`model policy unchanged\nWarning: ${notListed("gpt-9-imaginary")}\n`);
    const check = p.listed(KIRO_LIST, "--check");
    expect(check.status, check.out).toBe(0);
    expect(check.out).toContain("model policy is reflected on kiro");
    expect(check.out).toContain(`  Note: ${notListed("gpt-9-imaginary")}\n`);
    const json = JSON.parse(p.listed(KIRO_LIST, "--check", "--json").stdout) as { ok: boolean; data: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.data.agentModels).toEqual({ checked: true, notOffered: [{ agent: REVIEWER, model: "gpt-9-imaginary" }] });
    expect(json.data.notes).toEqual([notListed("gpt-9-imaginary")]);
    // A file that no longer matches the record is still drift, and its model is still named.
    const file = join(p.dir, ".kiro", "agents", REVIEWER_FILE);
    writeFileSync(file, readFileSync(file, "utf-8").replace(/^effortLevel: high$/m, "effortLevel: low"));
    const drift = p.listed(KIRO_LIST, "--check");
    expect(drift.status, drift.out).toBe(1);
    expect(drift.out).toContain("model policy drift");
    expect(drift.out).toContain(`  Note: ${notListed("gpt-9-imaginary")}\n`);
    const fixed = p.listed(KIRO_LIST, "--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--effort", "high", "--yes");
    expect(fixed.status, fixed.out).toBe(0);
    expect(fixed.out).not.toContain("Kiro CLI's model list");
    const clean = p.listed(KIRO_LIST, "--check", "--json");
    expect((JSON.parse(clean.stdout) as { data: Record<string, unknown> }).data.agentModels)
      .toEqual({ checked: true, notOffered: [] });
    // An id AI-DLC does not print is compared as Kiro listed it, and named without its text.
    const odd = p.listed([...KIRO_LIST, "claude-x[1m]"], "--project", "--agent", REVIEWER, "--model", "claude-x[1m]", "--yes");
    expect(odd.status, odd.out).toBe(0);
    expect(odd.out).not.toContain("Kiro CLI's model list");
    const oddMissing = p.listed(KIRO_LIST, "--project", "--agent", REVIEWER, "--model", "claude-x[1m]", "--yes");
    expect(oddMissing.status, oddMissing.out).toBe(0);
    expect(oddMissing.out).toContain(`  Note: ${notListed("a model id AI-DLC does not print")}\n`);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("with no kiro-cli, or a Kiro that does not answer, the model is recorded and the run says it could not check", () => {
    const p = project();
    const noCli = p.run(
      ["config", "models", "--project-dir", p.dir, "--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes"],
      { AIDLC_TEST_NAME: "t-kiro-agent-models" },
    );
    expect(noCli.status, noCli.out).toBe(0);
    expect(p.agent(REVIEWER_FILE)).toMatch(/^model: "gpt-5\.6-terra"$/m);
    expect(noCli.out).toContain(
      `Could not check ${REVIEWER}'s model gpt-5.6-terra against Kiro CLI's model list (kiro-cli not found); Kiro runs an agent whose model it does not offer on your chat's model.`,
    );
    const silent = p.listed(null, "--project", "--agent", "architect", "--model", "claude-opus-5.5", "--yes", "--quiet");
    expect(silent.status, silent.out).toBe(0);
    expect(silent.stdout).toContain(
      "\nWarning: Could not check architect's model claude-opus-5.5 against Kiro CLI's model list (Kiro did not answer); ",
    );
    // An effort alone sets no model, so nothing is checked.
    const effort = p.listed(null, "--project", "--agent", "developer", "--effort", "high", "--yes");
    expect(effort.status, effort.out).toBe(0);
    expect(effort.out).not.toContain("Kiro CLI's model list");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("doctor names an agent model Kiro CLI does not list, or says it could not check", () => {
    const p = project();
    expect(p.listed(KIRO_LIST, "--project", "--agent", REVIEWER, "--model", "gpt-9-imaginary", "--yes").status).toBe(0);
    const saved = process.env.AIDLC_TEST_KIRO_SESSION_JSON;
    try {
      process.env.AIDLC_TEST_KIRO_SESSION_JSON = JSON.stringify({ models: KIRO_LIST.map((id) => ({ model_id: id })) });
      const [row] = kiroAgentModelDoctorChecks(p.dir);
      expect(row).toMatchObject({
        pass: false,
        severity: "warn",
        label: `Agent ${REVIEWER}'s model gpt-9-imaginary is not in Kiro CLI's model list; Kiro runs an agent whose model it does not offer on your chat's model`,
      });
      expect(row.fix).toMatch(
        new RegExp(
          `^run \`[^\`]* config models --agent ${REVIEWER} --model <id>\` with a model from \`kiro-cli chat --list-models\`; \`[^\`]* config models --show\` shows where its model is set$`,
        ),
      );
      process.env.AIDLC_TEST_KIRO_SESSION_JSON = JSON.stringify({ models: null });
      expect(kiroAgentModelDoctorChecks(p.dir)).toEqual([
        { pass: true, label: "Agent models: not checked against Kiro CLI's model list (Kiro did not answer)" },
      ]);
    } finally {
      if (saved === undefined) delete process.env.AIDLC_TEST_KIRO_SESSION_JSON;
      else process.env.AIDLC_TEST_KIRO_SESSION_JSON = saved;
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("on a stable release, one agent's model and effort are written, kept by a later config run, and --check agrees", () => {
    const p = project();
    // A record the dropped preview switch left behind changes nothing.
    const harnessData = join(p.dir, ".kiro", "tools", "data", "harness.json");
    writeFileSync(
      harnessData,
      `${JSON.stringify({ ...JSON.parse(readFileSync(harnessData, "utf-8")), previewFeatures: { "agent-models": "off" } }, null, 2)}\n`,
    );
    const pin = p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--effort", "high", "--yes");
    expect(pin.status, pin.out).toBe(0);
    expect(p.agent(REVIEWER_FILE)).toMatch(/^model: "gpt-5\.6-terra"$/m);
    expect(p.agent(REVIEWER_FILE)).toMatch(/^effortLevel: high$/m);
    const again = p.run(["config", "--project-dir", p.dir, "--yes"]);
    expect(again.status, again.out).toBe(0);
    expect(again.out).not.toContain("Kiro now runs");
    expect(p.agent(REVIEWER_FILE)).toMatch(/^effortLevel: high$/m);
    const check = p.models("--check");
    expect(check.status, check.out).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("an effort recorded earlier reaches Kiro on the next config run, which says so once with its undo", () => {
    const p = project();
    // As a teammate on another tool records it, with nothing written on Kiro.
    const settings = projectSettingsPath(p.dir);
    const current = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf-8")) as Record<string, unknown> : {};
    writeFileSync(settings, `${JSON.stringify({ schemaVersion: 1, ...current, models: { schemaVersion: 1, agents: { developer: { effort: "low" } } } }, null, 2)}\n`);
    const drift = p.models("--check");
    expect(drift.status).not.toBe(0);
    expect(drift.out).toContain("developer: effort inherit != low");
    const dry = p.run(["config", "--project-dir", p.dir, "--dry-run"]);
    expect(dry.out.replace(/\s+/g, " ")).toContain("Kiro will run developer on effort low");
    const refresh = p.run(["config", "--project-dir", p.dir, "--yes"]);
    expect(refresh.status, refresh.out).toBe(0);
    const said = refresh.out.replace(/\s+/g, " ");
    expect(said).toContain(
      "Kiro now runs developer on effort low, as set for that agent with config models (an agent's effort is shared with your other tools); `",
    );
    expect(said).toMatch(/; `[^`]*config models --show --harness kiro( --project-dir \S+)?` shows where each is set\./);
    expect(p.agent("aidlc-developer-agent.md")).toMatch(/^effortLevel: low$/m);
    expect(p.models("--check").status).toBe(0);
    const again = p.run(["config", "--project-dir", p.dir, "--yes"]);
    expect(again.out).not.toContain("Kiro now runs");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("a models change names what it writes that it does not set itself: another agent's setting, or the same agent's other one", () => {
    const p = project();
    const settings = projectSettingsPath(p.dir);
    const current = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf-8")) as Record<string, unknown> : {};
    writeFileSync(settings, `${JSON.stringify({ schemaVersion: 1, ...current, models: { schemaVersion: 1, agents: { developer: { effort: "low" } } } }, null, 2)}\n`);
    const pin = p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes");
    expect(pin.status, pin.out).toBe(0);
    const said = pin.out.replace(/\s+/g, " ");
    expect(said).toContain("Kiro now runs developer on effort low, as set for that agent with config models");
    expect(said).not.toContain(`Kiro now runs ${REVIEWER}`);
    expect(p.agent("aidlc-developer-agent.md")).toMatch(/^effortLevel: low$/m);
    // The reviewer's effort recorded before, its model set now: the effort is the one to name.
    writeFileSync(settings, `${JSON.stringify({ schemaVersion: 1, ...current, models: { schemaVersion: 1, agents: { [REVIEWER]: { effort: "low" } } } }, null, 2)}\n`);
    const again = p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes");
    expect(again.status, again.out).toBe(0);
    expect(again.out.replace(/\s+/g, " ")).toContain(`Kiro now runs ${REVIEWER} on effort low, as set for that agent`);
    expect(again.out).not.toContain("on model gpt-5.6-terra");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("Kiro added beside another harness names its tree in the --show command", () => {
    const dir = temp("aidlc-kiro-agent-models-two-");
    mkdirSync(join(dir, ".git"));
    const machine = temp("aidlc-kiro-agent-models-m-");
    const env = {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
      AIDLC_RUNTIME_ROOT: join(REPO_ROOT, "dist-release"),
    };
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [join(REPO_ROOT, "core", "tools", "aidlc-init.ts"), ...args], {
        cwd: dir,
        env,
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    };
    const claude = run(["config", "--project-dir", dir, "--from", join(REPO_ROOT, "dist-release", "claude"), "--harness", "claude", "--mcp", "none", "--yes"]);
    expect(claude.status, claude.out).toBe(0);
    writeFileSync(projectSettingsPath(dir), `${JSON.stringify({ schemaVersion: 1, models: { schemaVersion: 1, agents: { developer: { effort: "low" } } } }, null, 2)}\n`);
    const kiro = run(["config", "--project-dir", dir, "--from", KIRO_IDE_RELEASE, "--harness", "kiro", "--mcp", "none", "--yes"]);
    expect(kiro.status, kiro.out).toBe(0);
    const said = kiro.out.replace(/\s+/g, " ");
    expect(said).toContain("Kiro now runs developer on effort low");
    expect(said).toMatch(/`[^`]*config models --show --harness kiro( --project-dir \S+)?` shows where each is set\./);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("the same model again puts back lines the agent file lost, and names another agent's value it writes too", () => {
    const p = project();
    expect(p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes").status).toBe(0);
    const path = join(p.dir, ".kiro", "agents", REVIEWER_FILE);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^model: .*\n/m, ""));
    // A teammate's effort for the developer, recorded since, that Kiro has not taken yet.
    const settings = projectSettingsPath(p.dir);
    const recorded = JSON.parse(readFileSync(settings, "utf-8")) as { models: { agents: Record<string, unknown> } };
    recorded.models.agents.developer = { effort: "low" };
    writeFileSync(settings, `${JSON.stringify(recorded, null, 2)}\n`);
    const again = p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes");
    expect(again.status, again.out).toBe(0);
    expect(p.agent(REVIEWER_FILE)).toMatch(/^model: "gpt-5\.6-terra"$/m);
    expect(again.out.replace(/\s+/g, " ")).toContain(
      `Kiro now runs ${REVIEWER} on model gpt-5.6-terra, and developer on effort low, as set for those agents`,
    );
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("config preview is not a section", () => {
    const p = project();
    const refused = p.run(["config", "preview", "--project-dir", p.dir]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain('unknown config section "preview"');
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a model id with a line break is refused before anything is recorded", () => {
    const p = project();
    const refused = p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra\neffortLevel: max", "--yes");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("--model takes one model id as your tool names it");
    const settings = projectSettingsPath(p.dir);
    const recorded = existsSync(settings) ? (JSON.parse(readFileSync(settings, "utf-8")) as { models?: unknown }) : {};
    expect(recorded.models).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
