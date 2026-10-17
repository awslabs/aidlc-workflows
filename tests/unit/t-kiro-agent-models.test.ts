// covers: file:tools/aidlc-model-policy.ts, function:isModelId, function:modelHarnessHonesty, function:presetsChangeNothing, function:kiroAgentModelsOn, function:kiroAgentModelsOffInPreview, function:installedModelBuild, function:applyModelPolicyToProjection, function:modelPolicySurfaceDrift, function:sessionModelsDetail, function:preparePreviewSection, function:validatePreviewArgs, function:showPreviewFeatures, function:previewSwitchLine
//
// On Kiro (kiro-ide) a delegated agent runs on its own `model` and
// `effortLevel` (Kiro CLI 2.31.1 on its v3 engine, Kiro IDE 1.3.0). On a
// project on a preview release that turned agent-models on
// (`aidlc config preview agent-models on`, recorded in its harness.json),
// `aidlc config models --agent <name>` writes that agent's model and effort
// into its Kiro agent file. Off, or on a stable release, config neither writes
// nor checks those lines. A preset or group effort has no per-agent Kiro
// surface. `config preview` is also the switch of the reviewer read-scope
// preview feature, which only records.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { previewSwitchLine } from "../../core/tools/aidlc-init.ts";
import { renderReviewCopy } from "../../core/tools/aidlc-kiro-review-copy.ts";
import * as policy from "../../core/tools/aidlc-model-policy.ts";
import type { ModelPolicyRecord } from "../../core/tools/aidlc-model-policy.ts";
import { normalizeSettingsModels, projectSettingsPath } from "../../core/tools/aidlc-settings.ts";

// A tree on a preview release with nothing recorded, one that turned it on,
// and one on a stable release.
const PREVIEW = { version: "2.11.1-preview.20261015.1" };
const ON = { ...PREVIEW, agentModels: "on" as const };
const STABLE = { version: "2.11.0" };
const KIRO_IDE_RELEASE = join(REPO_ROOT, "dist-release", "kiro-ide");
const REVIEWER = "architecture-reviewer";
const REVIEWER_FILE = "aidlc-architecture-reviewer-agent.md";
const pinned: ModelPolicyRecord = {
  schemaVersion: 1,
  agents: { [REVIEWER]: { model: "gpt-5.6-terra", effort: "high" } },
};
const OFF_LINE =
  "AI-DLC does not write a model or effort into its Kiro agent files, so every agent runs on your chat's model and effort (Kiro IDE's model picker, or Kiro CLI's session model); a model or effort set here is kept for other tools and changes nothing in Kiro.";

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

function withOwnModelLine(path: string): void {
  writeFileSync(path, readFileSync(path, "utf-8").replace(/\n---\n/, "\nmodel: claude-sonnet-5.5\n---\n"));
}

describe("the agent-models choice", () => {
  test("kiro-ide pins one agent's model and effort only on a preview release that recorded on", () => {
    expect(policy.modelHarnessHonesty("kiro-ide", ON)).toMatchObject({ model: true, effort: true, groupEffort: false });
    expect(policy.modelHarnessHonesty("kiro-ide", PREVIEW)).toMatchObject({ model: false, effort: false });
    expect(policy.modelHarnessHonesty("kiro-ide", { ...PREVIEW, agentModels: "off" })).toMatchObject({ model: false });
    expect(policy.modelHarnessHonesty("kiro-ide", { ...STABLE, agentModels: "on" })).toMatchObject({ model: false });
    expect(policy.modelHarnessHonesty("kiro", ON)).toBe(policy.HARNESS_HONESTY.kiro);
  });

  test("the variable other preview features use does not turn it on", () => {
    const saved = process.env.AIDLC_PREVIEW_FEATURES;
    process.env.AIDLC_PREVIEW_FEATURES = "agent-models";
    try {
      expect(policy.kiroAgentModelsOn(PREVIEW)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AIDLC_PREVIEW_FEATURES;
      else process.env.AIDLC_PREVIEW_FEATURES = saved;
    }
  });

  test("off, a preview release names how to turn it on and a stable release does not mention it", () => {
    expect(policy.modelHarnessHonesty("kiro-ide", STABLE).message).toBe(OFF_LINE);
    expect(policy.modelHarnessHonesty("kiro-ide", PREVIEW).message).toBe(
      `${OFF_LINE} In this preview build, turning agent-models on applies a model and effort set for one agent.`,
    );
    expect(policy.kiroAgentModelsOffInPreview(PREVIEW)).toBe(true);
    expect(policy.kiroAgentModelsOffInPreview(ON)).toBe(false);
    expect(policy.kiroAgentModelsOffInPreview(STABLE)).toBe(false);
  });

  test("on, a preset still changes nothing on kiro-ide, so setup asks for none", () => {
    expect(policy.sessionSetsAgentModels("kiro-ide", ON)).toBe(false);
    expect(policy.presetsChangeNothing("kiro-ide", ON)).toBe(true);
    expect(policy.presetsChangeNothing("kiro-ide", STABLE)).toBe(true);
    expect(policy.presetsChangeNothing("kiro", ON)).toBe(false);
    expect(policy.presetsChangeNothing("claude", ON)).toBe(false);
    expect(policy.presetsChangeNothing("cursor", ON)).toBe(true);
    expect(policy.sessionModelsDetail("kiro-ide", { schemaVersion: 1, preset: "thorough" }, ON)).toBe(
      "every agent uses your Kiro session's model and effort unless a model or effort is set for that agent; the recorded thorough preset does not apply here",
    );
    expect(policy.sessionModelsDetail("kiro-ide", null, STABLE)).toBe("every agent uses your Kiro session's model and effort");
  });

  test("an agent's own model and effort apply; a preset's effort does not reach it", () => {
    expect(policy.resolveModelPolicy(pinned, REVIEWER, "balanced", "kiro-ide", null, ON))
      .toMatchObject({ model: "gpt-5.6-terra", effort: "high", unexpressed: [] });
    const modelOnly = policy.resolveModelPolicy(
      { schemaVersion: 1, preset: "thorough", agents: { [REVIEWER]: { model: "gpt-5.6-terra" } } },
      REVIEWER,
      "balanced",
      "kiro-ide",
      null,
      ON,
    );
    expect(modelOnly.model).toBe("gpt-5.6-terra");
    expect(modelOnly.effort).toBeUndefined();
    expect(modelOnly.unexpressed).toEqual(["effort"]);
    expect(policy.resolveModelPolicy(pinned, REVIEWER, "balanced", "kiro-ide", null, STABLE).unexpressed)
      .toEqual(["model", "effort"]);
  });
});

describe("the switch line on a release a pin selects", () => {
  // The run says it for the release it sets up; before is the installed tree's.
  const dir = temp("aidlc-kiro-agent-models-line-");
  const tree = { distribution: "kiro-ide", harnessDir: ".kiro", root: join(dir, ".kiro") } as Parameters<typeof previewSwitchLine>[1];
  test("on from a stable tree onto a preview pin says it takes effect, with off as its undo", () => {
    const line = previewSwitchLine(dir, tree, "agent-models", null, false, "on", "2.11.0-preview.20261016.1", "2.11.0-preview.20261016.1");
    expect(line).toContain("Kiro takes it at each agent's next dispatch.");
    expect(line).not.toContain("nothing changes on this release");
    expect(line).toMatch(/To undo: \S.*config preview agent-models off --yes/);
  });
  test("off from a preview tree onto a stable pin names the steps back to a preview release", () => {
    const line = previewSwitchLine(dir, tree, "agent-models", "on", true, "off", "2.11.0", "2.11.0");
    expect(line).toContain("; it stops at each agent's next dispatch.");
    expect(line).not.toContain("Kiro takes it");
    expect(line).toMatch(/To undo: .*, then \S.*config preview agent-models on --yes/);
  });
  test("reviewer-read-scope off from a preview tree onto a stable pin says it stops", () => {
    const line = previewSwitchLine(dir, tree, "reviewer-read-scope", "on", true, "off", "2.11.0", "2.11.0");
    expect(line).toContain("; it stops from the next Unit review.");
    expect(line).not.toContain("it applies");
  });
  test("on that applied, run again onto another preview pin, offers no way back to it", () => {
    const line = previewSwitchLine(dir, tree, "agent-models", "on", true, "on", "2.11.0-preview.20261017.1", "2.11.0-preview.20261017.1");
    expect(line).not.toContain("To have it again");
    expect(line).not.toContain("To undo");
  });
});

describe("writing kiro-ide agent files", () => {
  test("on, the pinned agent's file gets a quoted model and effortLevel and nothing else changes", () => {
    const root = projection();
    const before = agentFiles(root);
    const cli = readFileSync(join(root, ".kiro", "settings", "cli.json"), "utf-8");
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, ON);
    const after = agentFiles(root);
    const fm = frontmatter(after[REVIEWER_FILE]);
    expect(fm).toMatch(/^model: "gpt-5\.6-terra"$/m);
    expect(fm).toMatch(/^effortLevel: high$/m);
    expect(fm).not.toMatch(/^effort:/m);
    for (const [name, text] of Object.entries(before)) {
      if (name !== REVIEWER_FILE) expect(after[name], name).toBe(text);
    }
    expect(readFileSync(join(root, ".kiro", "settings", "cli.json"), "utf-8")).toBe(cli);
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", pinned, ON)).toEqual([]);
  });

  test("off or on a stable release the agent files are left as they are, the person's own lines too, and --check reads none", () => {
    const root = projection();
    withOwnModelLine(join(root, ".kiro", "agents", REVIEWER_FILE));
    const before = agentFiles(root);
    for (const build of [STABLE, PREVIEW, { ...PREVIEW, agentModels: "off" as const }, { ...STABLE, agentModels: "on" as const }]) {
      policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, build);
      expect(agentFiles(root), JSON.stringify(build)).toEqual(before);
      expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", null, build)).toEqual([]);
    }
  });

  test("the run that turns it off takes the lines out, and later runs leave a line the person adds", () => {
    const root = projection();
    const path = join(root, ".kiro", "agents", REVIEWER_FILE);
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, ON);
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, { ...PREVIEW, agentModels: "off" }, true);
    expect(frontmatter(readFileSync(path, "utf-8"))).not.toMatch(/^(model|effortLevel):/m);
    withOwnModelLine(path);
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, { ...PREVIEW, agentModels: "off" });
    expect(frontmatter(readFileSync(path, "utf-8"))).toMatch(/^model: claude-sonnet-5\.5$/m);
  });

  test("a model id YAML would read as null, a number or a mapping is written quoted and reads back as the id", () => {
    for (const id of ["null", "gpt:", "1.5"]) {
      const value: ModelPolicyRecord = { schemaVersion: 1, agents: { [REVIEWER]: { model: id } } };
      const root = projection();
      policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", value, null, ON);
      expect(frontmatter(agentFiles(root)[REVIEWER_FILE])).toContain(`model: ${JSON.stringify(id)}`);
      expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", value, ON), id).toEqual([]);
    }
  });

  test("the shared Markdown writer takes an effortLevel line out only of a Kiro agent file", () => {
    const text = "---\nname: x\neffortLevel: low\n---\nBody\n";
    expect(policy.writeMarkdownAgentSurface(text, { model: "m" })).toContain("effortLevel: low");
    expect(policy.writeMarkdownAgentSurface(text, { model: "m" }, { effortKey: "effortLevel" })).not.toContain("effortLevel: low");
  });

  test("an edited effortLevel reads as drift while it is on", () => {
    const root = projection();
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, ON);
    const path = join(root, ".kiro", "agents", REVIEWER_FILE);
    writeFileSync(path, readFileSync(path, "utf-8").replace("effortLevel: high", "effortLevel: low"));
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", pinned, ON)).toContain(`${REVIEWER}: effort low != high`);
  });

  test("on, a recorded preset and group effort write nothing and are no drift", () => {
    const root = projection();
    const before = agentFiles(root);
    const shared: ModelPolicyRecord = { schemaVersion: 1, preset: "thorough", groups: { reviewing: { effort: "max" } } };
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", shared, null, ON);
    expect(agentFiles(root)).toEqual(before);
    expect(policy.modelPolicySurfaceDrift(root, ".kiro", "kiro-ide", shared, ON)).toEqual([]);
  });

  test("the take-out on a stable release takes the lines out and leaves the rest of the file", () => {
    const root = projection();
    const path = join(root, ".kiro", "agents", REVIEWER_FILE);
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, ON);
    writeFileSync(path, `${readFileSync(path, "utf-8")}\nA line of my own.\n`);
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, { ...STABLE, agentModels: "off" }, true);
    expect(frontmatter(readFileSync(path, "utf-8"))).not.toMatch(/^(model|effortLevel):/m);
    expect(readFileSync(path, "utf-8")).toContain("A line of my own.");
  });

  test("the choice is read from harness.json previewFeatures as on or off, nothing else", () => {
    const root = projection();
    const harness = join(root, ".kiro", "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(harness, "utf-8")) as Record<string, unknown>;
    for (const [value, read] of [["on", "on"], ["off", "off"], ["yes", null], [true, null]] as const) {
      writeFileSync(harness, JSON.stringify({ ...data, previewFeatures: { "agent-models": value } }));
      expect(policy.installedModelBuild(join(root, ".kiro")).agentModels).toBe(read);
    }
    writeFileSync(harness, JSON.stringify({ ...data, agentModels: "on" }));
    expect(policy.installedModelBuild(join(root, ".kiro")).agentModels).toBeNull();
  });

  test("a review's reviewer copy keeps the reviewer's model and effortLevel", () => {
    const root = projection();
    policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", pinned, null, ON);
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
    expect(policy.modelPolicyDoctorIssues(join(root, ".kiro"), "kiro-ide", shared, ON)).toEqual([]);
    const tiers = policy.readAgentTiers(join(root, ".kiro"));
    expect(policy.harnessHonestyNotes(shared, tiers, "kiro-ide", null, ON)).toEqual([
      "Kiro takes a model and an effort set for one agent; a preset or group effort is kept for other tools and changes nothing in Kiro.",
    ]);
  });

  test("a recorded model id that is not one plain token is kept readable, never written, and named in a note", () => {
    for (const recorded of ["gpt-5.6-terra\ntools: [\"shell\"]", "#gpt", "\"gpt", "gpt\u0085x"]) {
      const value: ModelPolicyRecord = { schemaVersion: 1, agents: { [REVIEWER]: { model: recorded } } };
      expect(normalizeSettingsModels({ schemaVersion: 1, agents: { [REVIEWER]: { model: { "kiro-ide": recorded } } } }))
        .not.toBeNull();
      const resolved = policy.resolveModelPolicy(value, REVIEWER, "balanced", "kiro-ide", null, ON);
      expect(resolved.model, JSON.stringify(recorded)).toBeUndefined();
      expect(resolved.unexpressed).toEqual(["model"]);
      const root = projection();
      const before = agentFiles(root)[REVIEWER_FILE];
      policy.applyModelPolicyToProjection(root, ".kiro", "kiro-ide", value, null, ON);
      expect(agentFiles(root)[REVIEWER_FILE], JSON.stringify(recorded)).toBe(before);
    }
    const tiers = policy.readAgentTiers(join(projection(), ".kiro"));
    expect(policy.harnessHonestyNotes({ schemaVersion: 1, agents: { [REVIEWER]: { model: "#gpt" } } }, tiers, "kiro-ide", null, ON))
      .toContain(
        `The model id recorded for ${REVIEWER} is not one plain id, so it is not written; set it again with \`aidlc config models --agent ${REVIEWER} --model <id>\`.`,
      );
    expect(policy.isModelId("claude-opus-4-8[1m]")).toBe(true);
    expect(policy.isModelId("arn:aws:bedrock:us-east-1::foundation-model/x")).toBe(true);
  });
});

// The commands a person runs, on a project installed from a preview release
// (the release tree with a preview version stamped in, one that sorts below
// the stable release it is built from, so moving to that release is a refresh).
describe("the agent-models choice through config", () => {
  const previewVersion = "2.11.0-preview.20261016.1";
  const stableRelease = join(REPO_ROOT, "dist-release", "kiro-ide");
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"),
      AIDLC_BIN_DIR: join(machine, "bin"),
      AIDLC_RUNTIME_ROOT: runtime,
    };
    delete env.AIDLC_PREVIEW_FEATURES;
    const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
      const result = spawnSync(process.execPath, [join(REPO_ROOT, "core", "tools", "aidlc-init.ts"), ...args], {
        cwd: dir,
        env: { ...env, ...extra },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    };
    const install = run(["config", "--project-dir", dir, "--from", join(runtime, "kiro-ide"), "--harness", "kiro-ide", "--mcp", "none", "--yes"]);
    expect(install.status, install.out).toBe(0);
    const reviewerPath = join(dir, ".kiro", "agents", REVIEWER_FILE);
    const reviewer = () => frontmatter(readFileSync(reviewerPath, "utf-8"));
    const recorded = () =>
      (JSON.parse(readFileSync(join(dir, ".kiro", "tools", "data", "harness.json"), "utf-8")) as Record<string, unknown>)
        .previewFeatures as Record<string, string> | undefined;
    const choice = () => recorded()?.["agent-models"];
    const models = (...args: string[]) => run(["config", "models", "--project-dir", dir, ...args]);
    const preview = (...args: string[]) => run(["config", "preview", "--project-dir", dir, ...args]);
    return { dir, run, models, preview, reviewer, reviewerPath, recorded, choice };
  }
  const json = (out: string) => JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { data?: Record<string, unknown> };

  test("on is recorded, the pin is written and survives a later config run, and --check agrees", () => {
    const p = project(previewRuntime());
    const on = p.preview("agent-models", "on", "--yes");
    expect(on.status, on.out).toBe(0);
    expect(on.out).toContain(
      "Preview feature agent-models: not set -> on in .kiro/tools/data/harness.json; Kiro takes it at each agent's next dispatch. To undo: ",
    );
    expect(on.out).toContain("config preview agent-models off --yes");
    expect(p.choice()).toBe("on");
    const pin = p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--effort", "high", "--yes");
    expect(pin.status, pin.out).toBe(0);
    expect(p.reviewer()).toMatch(/^model: "gpt-5\.6-terra"$/m);
    expect(p.models("--project", "--agent", "developer", "--effort", "low", "--yes").status).toBe(0);
    expect(p.run(["config", "--project-dir", p.dir, "--yes"]).status).toBe(0);
    expect(p.reviewer()).toMatch(/^effortLevel: high$/m);
    const check = p.models("--check");
    expect(check.status, check.out).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("off takes AI-DLC's lines out once with its undo, stays off, and on puts them back", () => {
    const p = project(previewRuntime());
    expect(p.preview("agent-models", "on", "--yes").status).toBe(0);
    expect(p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes").status).toBe(0);
    const dry = p.preview("agent-models", "off", "--dry-run");
    expect(dry.out).toContain("Preview feature agent-models: on -> off in .kiro/tools/data/harness.json");
    expect(p.reviewer()).toMatch(/^model: "gpt-5\.6-terra"$/m);
    const off = p.preview("agent-models", "off", "--yes");
    expect(off.status, off.out).toBe(0);
    expect(off.out.split("config preview agent-models on --yes")).toHaveLength(2);
    expect(off.out.replace(/\s+/g, " ")).toContain(policy.KIRO_AGENT_MODELS_OFF_NOTE);
    expect(p.choice()).toBe("off");
    expect(p.reviewer()).not.toMatch(/^model:/m);
    withOwnModelLine(p.reviewerPath);
    expect(p.models("--project", "--agent", "developer", "--effort", "low", "--yes").status).toBe(0);
    expect(p.reviewer()).toMatch(/^model: claude-sonnet-5\.5$/m);
    writeFileSync(p.reviewerPath, readFileSync(p.reviewerPath, "utf-8").replace("model: claude-sonnet-5.5\n", ""));
    const on = p.preview("agent-models", "on", "--yes");
    expect(on.status, on.out).toBe(0);
    expect(p.reviewer()).toMatch(/^model: "gpt-5\.6-terra"$/m);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 3);

  test("off takes the lines out of an agent file the person changed and keeps the change", () => {
    const p = project(previewRuntime());
    expect(p.preview("agent-models", "on", "--yes").status).toBe(0);
    expect(p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes").status).toBe(0);
    writeFileSync(p.reviewerPath, `${readFileSync(p.reviewerPath, "utf-8")}\nA line of my own.\n`);
    const off = p.preview("agent-models", "off", "--yes");
    expect(off.status, off.out).toBe(0);
    expect(p.reviewer()).not.toMatch(/^(model|effortLevel):/m);
    expect(readFileSync(p.reviewerPath, "utf-8")).toContain("A line of my own.");
    expect(p.choice()).toBe("off");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("off where it was never on is already off, records nothing and leaves the person's line", () => {
    const p = project(previewRuntime());
    withOwnModelLine(p.reviewerPath);
    const off = p.preview("agent-models", "off", "--yes");
    expect(off.status, off.out).toBe(0);
    expect(off.out).toContain("agent-models is already off for this project");
    expect(p.reviewer()).toMatch(/^model: claude-sonnet-5\.5$/m);
    expect(p.recorded()).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("AIDLC_PREVIEW_FEATURES naming agent-models writes and records nothing", () => {
    const p = project(previewRuntime());
    const pin = p.run(
      ["config", "models", "--project-dir", p.dir, "--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes"],
      { AIDLC_PREVIEW_FEATURES: "agent-models" },
    );
    expect(pin.status, pin.out).toBe(0);
    expect(p.reviewer()).not.toMatch(/^model:/m);
    expect(p.choice()).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("the switch names itself in JSON, refuses a settings target with the reason, and models no longer takes it", () => {
    const p = project(previewRuntime());
    const on = p.preview("agent-models", "on", "--yes", "--json");
    expect(on.status, on.out).toBe(0);
    const models = json(on.out).data?.models as { preview?: unknown; summaries?: string[] } | undefined;
    expect(models?.preview).toEqual({ feature: "agent-models", choice: "on" });
    expect(models?.summaries?.[0]).toContain("Preview feature agent-models: not set -> on in .kiro/tools/data/harness.json");
    for (const target of ["--local", "--project", "--global"]) {
      const refused = p.preview("reviewer-read-scope", "on", target, "--yes");
      expect(refused.status, target).not.toBe(0);
      expect(refused.out).toContain(`${target} does not apply to config preview`);
    }
    expect(p.recorded()).toEqual({ "agent-models": "on" });
    const old = p.models("--agent-models", "off", "--yes");
    expect(old.status).not.toBe(0);
    expect(old.out).toContain("unknown models option --agent-models");
    expect(p.choice()).toBe("on");
    const download = p.preview("reviewer-read-scope", "on", "--download", "--dry-run");
    expect(download.status, download.out).toBe(0);
    expect(download.out).toContain("Preview feature reviewer-read-scope: not set -> on");
    expect(p.preview("--download").out).toContain("name the feature to change");
    const unknown = p.preview("agent-modles", "on", "--yes");
    expect(unknown.out).toContain('unknown preview feature "agent-modles"; preview features: agent-models, reviewer-read-scope');
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("reviewer-read-scope only records: the agent files stay as they are, and agent-models stays on", () => {
    const p = project(previewRuntime());
    expect(p.preview("agent-models", "on", "--yes").status).toBe(0);
    expect(p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes").status).toBe(0);
    const before = agentFiles(p.dir);
    const on = p.preview("reviewer-read-scope", "on", "--yes");
    expect(on.status, on.out).toBe(0);
    expect(on.out).toContain("Preview feature reviewer-read-scope: not set -> on in .kiro/tools/data/harness.json; it applies from the next Unit review.");
    expect(agentFiles(p.dir)).toEqual(before);
    expect(p.recorded()).toEqual({ "agent-models": "on", "reviewer-read-scope": "on" });
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("config preview and config models --show say what is recorded and what applies", () => {
    const p = project(previewRuntime());
    expect(p.preview("agent-models", "on", "--yes").status).toBe(0);
    const list = p.preview("--json");
    expect(list.status, list.out).toBe(0);
    expect(json(list.out).data?.features).toEqual([
      { harness: "kiro-ide", feature: "agent-models", recorded: "on", on: true, version: previewVersion, path: ".kiro/tools/data/harness.json" },
      { harness: "kiro-ide", feature: "reviewer-read-scope", recorded: null, on: false, version: previewVersion, path: ".kiro/tools/data/harness.json" },
    ]);
    const human = p.preview();
    expect(human.out).toContain("agent-models: on");
    expect(human.out).toContain("reviewer-read-scope: off (not set)");
    const show = p.models("--show", "--json");
    expect(json(show.out).data?.agentModels).toEqual({ recorded: "on", on: true });
    expect(p.models("--show").out).toContain("Agent models (preview): on");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("moving to a stable release replaces the agent files AI-DLC wrote and keeps the record; off clears it there", () => {
    const p = project(previewRuntime());
    expect(p.preview("agent-models", "on", "--yes").status).toBe(0);
    expect(p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes").status).toBe(0);
    expect(p.reviewer()).toMatch(/^model: "gpt-5\.6-terra"$/m);
    const stable = p.run(["config", "--project-dir", p.dir, "--from", stableRelease, "--yes"]);
    expect(stable.status, stable.out).toBe(0);
    expect(p.reviewer()).not.toMatch(/^(model|effortLevel):/m);
    expect(p.choice()).toBe("on");
    expect(p.models("--show").out).toContain("recorded on, which applies only on a preview release");
    const refused = p.preview("agent-models", "on", "--yes");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("agent-models needs this project on a preview release of AI-DLC; it is on 2.11.0");
    // Run through Bun, as a copied runtime runs, so the steps name a preview copy.
    expect(refused.out.replace(/\s+/g, " ")).toMatch(
      /install a preview release's copy runtime into this project \(Release Channels in the install guide\), then [^,]*config preview agent-models on --yes( --project-dir \S+)? $/,
    );
    // Recorded on with a pin to a preview release is not already on: the run sets the pin up first.
    writeFileSync(join(p.dir, ".aidlc-version"), `${previewVersion}\n`);
    const recordedPinned = p.preview("agent-models", "on", "--yes");
    expect(recordedPinned.out).not.toContain("already on");
    expect(recordedPinned.out).toContain(`this project is pinned to ${previewVersion}`);
    rmSync(join(p.dir, ".aidlc-version"));
    // The listing is laid out for the terminal, so a long line may wrap.
    const listed = p.preview().out.replace(/\s+/g, " ");
    expect(listed).toContain("agent-models: off (recorded on; this release is not a preview release)");
    expect(listed).toMatch(/config preview <feature> off --yes( --project-dir \S+)? clears one recorded on\./);
    expect(listed).not.toContain("Turn one on or off");
    // A model line the person adds on the stable release is theirs: off leaves it.
    const own = join(p.dir, ".kiro", "agents", "aidlc-developer-agent.md");
    withOwnModelLine(own);
    const off = p.preview("agent-models", "off", "--yes");
    expect(off.status, off.out).toBe(0);
    expect(readFileSync(own, "utf-8")).toMatch(/^model: claude-sonnet-5\.5$/m);
    expect(off.out).toContain("Preview feature agent-models: on -> off in .kiro/tools/data/harness.json; nothing changes on this release.");
    expect(off.out).not.toContain("To undo");
    // The way back is the steps to a preview release, as the refusal of on says.
    expect(off.out.replace(/\s+/g, " ")).toMatch(
      /To have it again: install a preview release's copy runtime into this project \(Release Channels in the install guide\), then [^,]*config preview agent-models on --yes/,
    );
    expect(off.out.replace(/\s+/g, " ")).not.toContain(policy.KIRO_AGENT_MODELS_OFF_NOTE);
    expect(p.choice()).toBe("off");
    expect(p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra", "--yes").status).toBe(0);
    expect(p.reviewer()).not.toMatch(/^model:/m);
    // A pin to a preview release is not refused from the stable tree: the run
    // sets the project up on the pin, which a copied runtime downloads first.
    writeFileSync(join(p.dir, ".aidlc-version"), `${previewVersion}\n`);
    const pinned = p.preview("agent-models", "on", "--yes");
    expect(pinned.out).toContain(`this project is pinned to ${previewVersion}`);
    expect(pinned.out).not.toContain("needs this project on a preview release");
    expect(pinned.out).toMatch(/fix: .*config preview .*agent-models on --yes --download/);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 4);

  test("a tree no preview feature works in lists none and offers no command", () => {
    const dir = temp("aidlc-kiro-agent-models-claude-");
    mkdirSync(join(dir, ".git"));
    const machine = temp("aidlc-kiro-agent-models-m-");
    const env = { ...process.env, AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"), AIDLC_BIN_DIR: join(machine, "bin") };
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [join(REPO_ROOT, "core", "tools", "aidlc-init.ts"), ...args], {
        cwd: dir,
        env,
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    };
    const install = run(["config", "--project-dir", dir, "--from", join(REPO_ROOT, "dist-release", "claude"), "--mcp", "none", "--yes"]);
    expect(install.status, install.out).toBe(0);
    const listed = run(["config", "preview", "--project-dir", dir]);
    expect(listed.status, listed.out).toBe(0);
    expect(listed.out).toContain("none for Claude Code");
    expect(listed.out).not.toContain("<feature>");
    const refused = run(["config", "preview", "--project-dir", dir, "agent-models", "on", "--yes"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("agent-models is a preview feature of kiro-ide projects; this one uses claude");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

  test("a model id with a line break is refused before anything is recorded", () => {
    const p = project(previewRuntime());
    const refused = p.models("--project", "--agent", REVIEWER, "--model", "gpt-5.6-terra\neffortLevel: max", "--yes");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("--model takes one model id as your tool names it");
    const settings = projectSettingsPath(p.dir);
    const recorded = existsSync(settings) ? (JSON.parse(readFileSync(settings, "utf-8")) as { models?: unknown }) : {};
    expect(recorded.models).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
