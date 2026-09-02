import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  activeModelGroups,
  applyModelPolicyToProjection,
  harnessHonestyNotes,
  MODEL_PRESETS,
  modelPolicyDoctorIssues,
  modelPolicySurfaceDrift,
  readAgentTiers,
  resolveModelPolicy,
  writeCodexAgentSurface,
  writeKiroAgentSurface,
  writeKiroCliSurface,
  writeMarkdownAgentSurface,
  type ModelPolicyRecord,
} from "../../core/tools/aidlc-model-policy.ts";
import { modelsPolicyCheck } from "../../core/tools/aidlc-doctor.ts";
import {
  invalidateSettingsCache,
  modelPolicyForHarness,
  projectSettingsPath,
  resolveAidlcSettings,
} from "../../core/tools/aidlc-settings.ts";

const BUN = process.execPath;
const INIT = join(REPO_ROOT, "core", "tools", "aidlc-init.ts");
const DISPATCHER = join(REPO_ROOT, "core", "tools", "aidlc.ts");
const DIST = join(REPO_ROOT, "dist");
const DIST_RELEASE = join(REPO_ROOT, "dist-release");
const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [INIT, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function install(harness: string): string {
  const project = temp(`aidlc-t293-${harness}-`);
  mkdirSync(join(project, ".git"));
  const result = run([
    "config",
    "--project-dir",
    project,
    "--from",
    join(DIST_RELEASE, harness),
    "--harness",
    harness,
    "--mcp",
    "none",
    "--yes",
  ], project);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return project;
}

function runtimeEnv(): NodeJS.ProcessEnv {
  return { AIDLC_RUNTIME_ROOT: DIST_RELEASE };
}

function harnessData(project: string, harnessDir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(project, harnessDir, "tools", "data", "harness.json"), "utf-8"),
  ) as Record<string, unknown>;
}

function projectSettings(project: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(projectSettingsPath(project), "utf-8"),
  ) as Record<string, unknown>;
}

function resolvedPolicy(project: string, harness: "claude" | "kiro") {
  invalidateSettingsCache();
  return modelPolicyForHarness(resolveAidlcSettings(project).models, harness);
}

describe("t293 model policy resolution", () => {
  test("all four precedence layers report provenance", () => {
    const session = resolveModelPolicy(null, "architect", "judgment", "codex");
    expect(session).toEqual(expect.objectContaining({
      layer: "session-inherit",
    }));
    expect(session.model).toBeUndefined();
    expect(session.effort).toBeUndefined();

    const writingUp = resolveModelPolicy(null, "delivery", "templated", "claude");
    expect(writingUp).toEqual(expect.objectContaining({
      layer: "shipped-tier-default",
      model: "inherit",
    }));
    expect(writingUp.effort).toBeUndefined();

    const writingUpCodex = resolveModelPolicy(null, "delivery", "templated", "codex");
    expect(writingUpCodex).toEqual(expect.objectContaining({
      layer: "session-inherit",
    }));
    expect(writingUpCodex.model).toBeUndefined();
    expect(writingUpCodex.effort).toBeUndefined();

    const shipped = resolveModelPolicy(null, "product-lead", "balanced", "claude");
    expect(shipped).toEqual(expect.objectContaining({
      layer: "shipped-tier-default",
      model: "sonnet",
      effort: "medium",
    }));

    const groupPolicy: ModelPolicyRecord = {
      schemaVersion: 1,
      groups: { reviewing: { effort: "xhigh" } },
    };
    const group = resolveModelPolicy(
      groupPolicy,
      "product-lead",
      "balanced",
      "claude",
    );
    expect(group).toEqual(expect.objectContaining({
      layer: "group-dial",
      model: "sonnet",
      effort: "xhigh",
    }));

    const agentPolicy: ModelPolicyRecord = {
      schemaVersion: 1,
      groups: { reviewing: { effort: "xhigh" } },
      agents: {
        "product-lead": { model: "vendor/raw-model", effort: "low" },
      },
    };
    const agent = resolveModelPolicy(
      agentPolicy,
      "product-lead",
      "balanced",
      "claude",
    );
    expect(agent).toEqual(expect.objectContaining({
      layer: "agent-exception",
      model: "vendor/raw-model",
      effort: "low",
    }));
  });

  test("presets are frozen group-only bundles and explicit groups override them", () => {
    expect(Object.isFrozen(MODEL_PRESETS)).toBe(true);
    expect(Object.keys(MODEL_PRESETS)).toEqual(["thorough", "balanced", "minimal"]);
    for (const preset of Object.values(MODEL_PRESETS)) {
      expect(Object.isFrozen(preset.groups)).toBe(true);
      expect(preset).not.toHaveProperty("model");
      expect(preset.groups).not.toHaveProperty("deciding");
      for (const group of Object.values(preset.groups)) {
        expect(Object.isFrozen(group)).toBe(true);
        expect(Object.keys(group)).toEqual(["effort"]);
      }
    }
    expect(MODEL_PRESETS.thorough.groups).toEqual({
      reviewing: { effort: "xhigh" },
    });
    expect(MODEL_PRESETS.balanced.groups).toEqual({
      reviewing: { effort: "medium" },
    });
    expect(MODEL_PRESETS.minimal.groups).toEqual({
      reviewing: { effort: "medium" },
      "writing-up": { effort: "low" },
    });
    expect(activeModelGroups({
      schemaVersion: 1,
      preset: "thorough",
      groups: { reviewing: { effort: "medium" } },
    })).toEqual({ reviewing: { effort: "medium" } });
  });

  test("per-agent raw models work and harness effort vocabularies clamp down", () => {
    const policy: ModelPolicyRecord = {
      schemaVersion: 1,
      agents: { architect: { model: "raw/model-id", effort: "max" } },
    };
    expect(resolveModelPolicy(policy, "architect", "judgment", "claude"))
      .toEqual(expect.objectContaining({
        model: "raw/model-id",
        effort: "max",
        layer: "agent-exception",
      }));
    expect(resolveModelPolicy(policy, "architect", "judgment", "codex"))
      .toEqual(expect.objectContaining({
        effort: "xhigh",
        clampedEffort: { from: "max", to: "xhigh" },
      }));
    expect(resolveModelPolicy({
      schemaVersion: 1,
      agents: { architect: { effort: "xhigh" } },
    }, "architect", "judgment", "opencode"))
      .toEqual(expect.objectContaining({
        effort: "high",
        clampedEffort: { from: "xhigh", to: "high" },
      }));
  });

  test("harness honesty identifies inexpressible policy without inventing a fallback", () => {
    const groupPolicy: ModelPolicyRecord = {
      schemaVersion: 1,
      groups: { reviewing: { effort: "xhigh" } },
    };
    const kiro = resolveModelPolicy(
      groupPolicy,
      "product-lead",
      "balanced",
      "kiro",
    );
    expect(kiro.effort).toBeUndefined();
    expect(kiro.unexpressed).toContain("effort");

    const ide = resolveModelPolicy({
      schemaVersion: 1,
      agents: { architect: { model: "raw/model", effort: "high" } },
    }, "architect", "judgment", "kiro-ide");
    expect(ide.model).toBeUndefined();
    expect(ide.effort).toBeUndefined();
    expect(ide.unexpressed.sort()).toEqual(["effort", "model"]);

    const cursor = resolveModelPolicy({
      schemaVersion: 1,
      agents: { architect: { model: "raw/model", effort: "high" } },
    }, "architect", "judgment", "cursor");
    expect(cursor.unexpressed.sort()).toEqual(["effort", "model"]);
    expect(
      harnessHonestyNotes(groupPolicy, { "product-lead": "balanced" }, "kiro"),
    ).toEqual([
      "Kiro CLI cannot express group effort dials today; a per-agent model exception can carry effort through chat.modelDefaults.",
    ]);
  });

  test("empty policy writers preserve current shipped surface bytes", () => {
    const claudePath = join(
      DIST,
      "claude",
      ".claude",
      "agents",
      "aidlc-product-lead-agent.md",
    );
    const claude = readFileSync(claudePath, "utf-8");
    expect(writeMarkdownAgentSurface(
      claude,
      resolveModelPolicy(null, "product-lead", "balanced", "claude"),
    )).toBe(claude);

    const codexPath = join(
      DIST,
      "codex",
      ".codex",
      "agents",
      "aidlc-product-lead-agent.toml",
    );
    const codex = readFileSync(codexPath, "utf-8");
    expect(writeCodexAgentSurface(
      codex,
      resolveModelPolicy(null, "product-lead", "balanced", "codex"),
    )).toBe(codex);

    const opencodePath = join(
      DIST,
      "opencode",
      ".opencode",
      "agents",
      "aidlc-product-lead-agent.md",
    );
    const opencode = readFileSync(opencodePath, "utf-8");
    expect(writeMarkdownAgentSurface(
      opencode,
      resolveModelPolicy(null, "product-lead", "balanced", "opencode"),
      { effortKey: "variant", insertBeforeKeys: ["mode"] },
    )).toBe(opencode);

    const kiroPath = join(
      DIST,
      "kiro",
      ".kiro",
      "agents",
      "aidlc-architect-agent.json",
    );
    const kiro = readFileSync(kiroPath, "utf-8");
    expect(writeKiroAgentSurface(
      kiro,
      resolveModelPolicy(null, "architect", "judgment", "kiro"),
    )).toBe(kiro);

    const cliPath = join(DIST, "kiro", ".kiro", "settings", "cli.json");
    const cli = readFileSync(cliPath, "utf-8");
    expect(writeKiroCliSurface(cli)).toBe(cli);
    const collapsed = JSON.parse(writeKiroCliSurface(cli, [{
      model: "claude-opus-4.8",
      effort: "max",
    }])) as Record<string, Record<string, { output_config?: { effort?: string } }>>;
    expect(
      collapsed["chat.modelDefaults"]["claude-opus-4.8"].output_config?.effort,
    ).toBe("max");
  });

  test("agent-tiers data ships identically in every harness", () => {
    const roots: Array<[string, string]> = [
      ["claude", ".claude"],
      ["codex", ".codex"],
      ["copilot", ".aidlc"],
      ["cursor", ".cursor"],
      ["kiro", ".kiro"],
      ["kiro-ide", ".kiro"],
      ["opencode", ".aidlc"],
    ];
    for (const [harness, dir] of roots) {
      const tiers = readAgentTiers(join(DIST, harness, dir));
      expect(Object.keys(tiers)).toHaveLength(14);
      expect(Object.values(tiers).filter((tier) => tier === "judgment")).toHaveLength(9);
      expect(Object.values(tiers).filter((tier) => tier === "balanced")).toHaveLength(2);
      expect(Object.values(tiers).filter((tier) => tier === "templated")).toHaveLength(3);
    }
  });
});

describe("t293 config models CLI", () => {
  test("all presets record and apply; balanced affirms defaults; economical is rejected", () => {
    const project = install("claude");
    const help = run([
      "config",
      "models",
      "--help",
    ], project, runtimeEnv());
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--preset <thorough|balanced|minimal>");
    expect(help.stdout).toContain(
      "balanced explicitly matches the shipped reviewing default",
    );
    const reviewer = join(
      project,
      ".claude",
      "agents",
      "aidlc-product-lead-agent.md",
    );
    const writer = join(
      project,
      ".claude",
      "agents",
      "aidlc-delivery-agent.md",
    );
    for (
      const [preset, reviewerEffort, writerEffort] of [
        ["thorough", "xhigh", null],
        ["balanced", "medium", null],
        ["minimal", "medium", "low"],
      ] as const
    ) {
      const applied = run([
        "config",
        "models",
        "--project-dir",
        project,
        "--project",
        "--preset",
        preset,
        "--yes",
      ], project, runtimeEnv());
      expect(applied.status, applied.stdout + applied.stderr).toBe(0);
      expect(projectSettings(project).models).toEqual({
        schemaVersion: 1,
        preset,
      });
      expect(harnessData(project, ".claude").models).toBeUndefined();
      expect(readFileSync(reviewer, "utf-8")).toContain(
        `effort: ${reviewerEffort}`,
      );
      const writerText = readFileSync(writer, "utf-8");
      if (writerEffort) expect(writerText).toContain(`effort: ${writerEffort}`);
      else expect(writerText).not.toMatch(/^effort:/m);
    }

    const balanced = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--preset",
      "balanced",
      "--yes",
    ], project, runtimeEnv());
    expect(balanced.status, balanced.stdout + balanced.stderr).toBe(0);
    const shown = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--show",
      "--json",
    ], project, runtimeEnv());
    const payload = JSON.parse(shown.stdout) as {
      data: {
        policy: { preset?: string };
        effective: Array<{ agent: string; layer: string; effort?: string }>;
      };
    };
    expect(payload.data.policy.preset).toBe("balanced");
    expect(payload.data.effective.find((item) => item.agent === "product-lead"))
      .toEqual(expect.objectContaining({
        layer: "group-dial",
        effort: "medium",
      }));

    for (const sourceFlag of ["--preset", "--from"]) {
      const rejected = run([
        "config",
        "models",
        "--project-dir",
        project,
        "--project",
        sourceFlag,
        "economical",
        "--yes",
      ], project, runtimeEnv());
      expect(rejected.status).toBe(2);
      expect(rejected.stdout + rejected.stderr).toContain(
        "thorough, balanced, minimal",
      );
    }
    expect(projectSettings(project).models).toEqual({
      schemaVersion: 1,
      preset: "balanced",
    });
  }, 60_000);

  test("show, JSON, check, drift, refresh carry-forward, profile derivation, agent exception, and reset", () => {
    const project = install("claude");
    const manifest = JSON.parse(
      readFileSync(
        join(project, ".claude", "tools", "data", "aidlc-manifest.json"),
        "utf-8",
      ),
    ) as { files: Record<string, string> };
    expect(manifest.files[".claude/tools/data/agent-tiers.json"]).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );

    const noChoice = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--yes",
    ], project, runtimeEnv());
    expect(noChoice.status).toBe(2);
    expect(noChoice.stdout).toContain("--yes confirms but never chooses a policy");

    const noConfirm = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--reviewing-effort",
      "xhigh",
    ], project, runtimeEnv());
    expect(noConfirm.status).toBe(2);
    expect(noConfirm.stdout).toContain("requires --yes");

    const applied = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--reviewing-effort",
      "xhigh",
      "--yes",
    ], project, runtimeEnv());
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(applied.stdout).toContain(
      "Reviewing   2 agents   sonnet/medium -> sonnet/xhigh (model unchanged)",
    );
    expect(applied.stdout).toContain(
      "Deepest review passes - built for correctness-critical work; reviews run slower and cost more.",
    );

    const shown = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--show",
    ], project, runtimeEnv());
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain("Preset: none (shipped defaults)");
    expect(shown.stdout).toContain(
      "All 14 agents inherit your session model and effort, except:",
    );
    expect(shown.stdout).toContain("Reviewing (2 agents): sonnet / xhigh");
    expect(shown.stdout).toContain(
      "Recorded override: group-dial; model shipped default, effort project.",
    );
    expect(shown.stdout).toContain("Recorded in:");
    expect(shown.stdout).toContain("Full per-agent list:");

    const shownJson = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--show",
      "--json",
    ], project, runtimeEnv());
    const showPayload = JSON.parse(shownJson.stdout) as {
      data: {
        effective: Array<{
          agent: string;
          layer: string;
          effort?: string;
          modelSource: string;
          effortSource: string;
        }>;
      };
    };
    expect(showPayload.data.effective.find((item) => item.agent === "product-lead"))
      .toEqual(expect.objectContaining({
        layer: "group-dial",
        effort: "xhigh",
        modelSource: "shipped default",
        effortSource: "project",
      }));

    expect(run([
      "config",
      "models",
      "--project-dir",
      project,
      "--check",
    ], project, runtimeEnv()).status).toBe(0);

    const reviewer = join(
      project,
      ".claude",
      "agents",
      "aidlc-product-lead-agent.md",
    );
    writeFileSync(
      reviewer,
      readFileSync(reviewer, "utf-8").replace("effort: xhigh", "effort: low"),
    );
    const drift = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--check",
    ], project, runtimeEnv());
    expect(drift.status).toBe(1);
    expect(drift.stdout).toContain("product-lead");
    writeFileSync(
      reviewer,
      readFileSync(reviewer, "utf-8").replace("effort: low", "effort: xhigh"),
    );

    const refresh = run([
      "config",
      "--project-dir",
      project,
      "--yes",
    ], project, runtimeEnv());
    expect(refresh.status, refresh.stdout + refresh.stderr).toBe(0);
    expect(readFileSync(reviewer, "utf-8")).toContain("effort: xhigh");

    const reset = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--reset",
      "--yes",
    ], project, runtimeEnv());
    expect(reset.status, reset.stdout + reset.stderr).toBe(0);
    expect(existsSync(projectSettingsPath(project))).toBe(false);
    expect(harnessData(project, ".claude").models).toBeUndefined();
    expect(readFileSync(reviewer, "utf-8")).toContain("effort: medium");

    const profile = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--from",
      "thorough",
      "--reviewing-effort",
      "medium",
      "--save-as",
      "my-profile",
      "--yes",
    ], project, runtimeEnv());
    expect(profile.status, profile.stdout + profile.stderr).toBe(0);
    const profilePolicy = projectSettings(project).models as {
      profiles: Record<string, unknown>;
    };
    expect(profilePolicy.profiles["my-profile"]).toEqual({
      groups: { reviewing: { effort: "medium" } },
    });
    expect(JSON.stringify(profilePolicy.profiles["my-profile"])).not.toContain("model");

    expect(run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--reset",
      "--yes",
    ], project, runtimeEnv()).status).toBe(0);
    const raw = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--agent",
      "architect",
      "--effort",
      "max",
      "--model",
      "vendor/raw-model",
      "--yes",
    ], project, runtimeEnv());
    expect(raw.status, raw.stdout + raw.stderr).toBe(0);
    const architect = readFileSync(
      join(project, ".claude", "agents", "aidlc-architect-agent.md"),
      "utf-8",
    );
    expect(architect).toContain("model: vendor/raw-model");
    expect(architect).toContain("effort: max");
    expect(run([
      "config",
      "models",
      "--project-dir",
      project,
      "--check",
    ], project, runtimeEnv()).status).toBe(0);
  }, 60_000);

  test("unknown config positionals are usage errors with no passthrough", () => {
    const project = temp("aidlc-t293-unknown-");
    mkdirSync(join(project, ".git"));
    const result = run([
      "config",
      "models-matrix",
      "--project-dir",
      project,
    ], project);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("unknown config section");
    expect(result.stdout).toContain(
      "valid sections: models, runtime, providers, trust, flags, project",
    );
    expect(existsSync(join(project, ".claude"))).toBe(false);
  });

  test("root config rejects unknown and section-only flags before scaffold", () => {
    for (const extra of [
      ["--bogus"],
      ["--show"],
      ["--project", "--preset", "minimal"],
    ]) {
      const project = temp("aidlc-t293-root-grammar-");
      mkdirSync(join(project, ".git"));
      const result = run([
        "config",
        "--project-dir",
        project,
        "--from",
        join(DIST_RELEASE, "claude"),
        "--harness",
        "claude",
        "--mcp",
        "none",
        ...extra,
        "--yes",
      ], project);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("config option");
      expect(existsSync(join(project, ".claude"))).toBe(false);
    }
  });

  test("misspelled config section help remains a usage error", () => {
    const result = spawnSync(BUN, [DISPATCHER, "config", "modles", "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("unknown config section");
  });

  test("model mutations inherit the active workflow refresh refusal", () => {
    const project = install("claude");
    const dirName = "active-model-policy";
    const intents = join(project, "aidlc", "spaces", "default", "intents");
    mkdirSync(join(intents, dirName), { recursive: true });
    writeFileSync(
      join(intents, "intents.json"),
      `${JSON.stringify([{
        uuid: "deadbeef-0000-4000-8000-000000000293",
        slug: "active-model-policy",
        dirName,
        scope: "feature",
        status: "in-flight",
      }], null, 2)}\n`,
    );
    writeFileSync(
      join(intents, dirName, "aidlc-state.md"),
      "# AI-DLC State Tracking\n\n## Current Status\n- **Status**: Running\n",
    );
    const result = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--reviewing-effort",
      "xhigh",
      "--yes",
    ], project, runtimeEnv());
    expect(result.status).toBe(4);
    expect(result.stdout).toContain("refusing to refresh while 1 workflow(s) are active");
    expect(existsSync(projectSettingsPath(project))).toBe(false);
    expect(harnessData(project, ".claude").models).toBeUndefined();
  }, 60_000);

  test("Kiro reports unsupported group effort and applies model-bound exceptions", () => {
    const project = install("kiro");
    const unsupported = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--reviewing-effort",
      "xhigh",
      "--yes",
    ], project, runtimeEnv());
    expect(unsupported.status, unsupported.stdout + unsupported.stderr).toBe(0);
    expect(unsupported.stdout).toContain(
      "Kiro CLI cannot express group effort dials today",
    );
    expect(unsupported.stdout).not.toContain("reviews run slower and cost more");
    const unsupportedPolicy = resolvedPolicy(project, "kiro");
    expect(
      modelPolicySurfaceDrift(project, ".kiro", "kiro", unsupportedPolicy).length,
    ).toBeGreaterThan(0);

    expect(run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--reset",
      "--yes",
    ], project, runtimeEnv()).status).toBe(0);
    const applied = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--project",
      "--agent",
      "architect",
      "--effort",
      "max",
      "--model",
      "vendor/kiro-model",
      "--yes",
    ], project, runtimeEnv());
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    const agent = JSON.parse(
      readFileSync(
        join(project, ".kiro", "agents", "aidlc-architect-agent.json"),
        "utf-8",
      ),
    ) as { model?: string };
    expect(agent.model).toBe("vendor/kiro-model");
    const cli = JSON.parse(
      readFileSync(join(project, ".kiro", "settings", "cli.json"), "utf-8"),
    ) as Record<string, Record<string, { output_config?: { effort?: string } }>>;
    expect(
      cli["chat.modelDefaults"]["vendor/kiro-model"].output_config?.effort,
    ).toBe("max");
    expect(modelPolicySurfaceDrift(
      project,
      ".kiro",
      "kiro",
      resolvedPolicy(project, "kiro"),
    )).toEqual([]);
  }, 60_000);
  test("global settings roll back when the coordinated project refresh cannot lock", () => {
    const project = install("claude");
    const machine = temp("aidlc-t293-global-rollback-");
    const env = {
      ...runtimeEnv(),
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    };
    const initial = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--global",
      "--preset",
      "minimal",
      "--yes",
    ], project, env);
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    const settingsPath = join(machine, "aidlc.settings.json");
    const priorSettings = readFileSync(settingsPath);
    const agentPath = join(project, ".claude", "agents", "aidlc-product-lead-agent.md");
    const priorAgent = readFileSync(agentPath);
    writeFileSync(
      join(project, ".aidlc-transaction.lock"),
      `${JSON.stringify({ pid: process.pid, staging: ".aidlc-txn-live" })}\n`,
    );

    const failed = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--global",
      "--preset",
      "thorough",
      "--yes",
    ], project, env);
    expect(failed.status).not.toBe(0);
    expect(readFileSync(settingsPath)).toEqual(priorSettings);
    expect(readFileSync(agentPath)).toEqual(priorAgent);
    rmSync(join(project, ".aidlc-transaction.lock"));
  }, 60_000);

  test("global rollback preserves a newer concurrent machine setting", () => {
    const project = install("claude");
    const machine = temp("aidlc-t293-global-rollback-race-");
    const settingsPath = join(machine, "aidlc.settings.json");
    const newer = `${JSON.stringify({
      schemaVersion: 1,
      flags: { schemaVersion: 1, swarm: true },
    }, null, 2)}\n`;
    writeFileSync(
      join(project, ".aidlc-transaction.lock"),
      `${JSON.stringify({ pid: process.pid, staging: ".aidlc-txn-live" })}\n`,
    );
    const failed = run([
      "config",
      "models",
      "--project-dir",
      project,
      "--global",
      "--preset",
      "thorough",
      "--yes",
    ], project, {
      ...runtimeEnv(),
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
      AIDLC_TEST_SETTINGS_ROLLBACK_INTERFERENCE: newer,
    });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(settingsPath, "utf-8")).toBe(newer);
    expect(`${failed.stdout}${failed.stderr}`).toContain("rollback was incomplete");
  }, 60_000);
});

describe("t293 doctor model policy advisory", () => {
  test("doctor reports orphaned exceptions and inexpressible selected-harness policy", () => {
    const claudeProject = temp("aidlc-t293-doctor-claude-");
    cpSync(join(DIST, "claude"), claudeProject, { recursive: true });
    const claudeSettings = projectSettingsPath(claudeProject);
    writeFileSync(claudeSettings, `${JSON.stringify({
      schemaVersion: 1,
      models: {
        schemaVersion: 1,
        agents: { "removed-agent": { effort: "high" } },
      },
    }, null, 2)}\n`);
    invalidateSettingsCache(claudeSettings);
    expect(modelPolicyDoctorIssues(
      join(claudeProject, ".claude"),
      "claude",
      resolvedPolicy(claudeProject, "claude"),
    ))
      .toContain("orphaned agent exception: removed-agent");

    const cursorProject = temp("aidlc-t293-doctor-cursor-");
    cpSync(join(DIST, "cursor"), cursorProject, { recursive: true });
    const cursorSettings = projectSettingsPath(cursorProject);
    writeFileSync(cursorSettings, `${JSON.stringify({
      schemaVersion: 1,
      models: {
        schemaVersion: 1,
        agents: {
          architect: {
            model: { cursor: "vendor/raw" },
            effort: "high",
          },
        },
      },
    }, null, 2)}\n`);
    invalidateSettingsCache(cursorSettings);
    const check = modelsPolicyCheck(cursorProject, true);
    expect(check.pass).toBe(false);
    expect(check.severity).toBe("warn");
    expect(check.label).toContain("policy issue");
    expect(check.fix).toContain("not expressible on cursor");
  });
});

describe("t293 projection application", () => {
  test("applying an empty policy to a copied projection is byte-identical", () => {
    const root = temp("aidlc-t293-empty-policy-");
    cpSync(join(DIST, "claude"), root, { recursive: true });
    const before = readFileSync(
      join(root, ".claude", "agents", "aidlc-product-lead-agent.md"),
    );
    applyModelPolicyToProjection(root, ".claude", "claude", null);
    expect(
      readFileSync(join(root, ".claude", "agents", "aidlc-product-lead-agent.md")),
    ).toEqual(before);
  });
});
