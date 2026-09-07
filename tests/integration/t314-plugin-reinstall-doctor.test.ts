// covers: subcommand:aidlc-utility:doctor, subcommand:aidlc-utility:plugin-sync

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
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
import {
  buildPluginProjection,
  composePluginFixture,
  copyHarnessInstall,
} from "../harness/plugin-kit.ts";

const BUN = process.execPath;
const TIMEOUT_MS = 60_000;
const PLUGIN = "test-pro";
setDefaultTimeout(TIMEOUT_MS);

function graph(project: string): Array<{ slug?: string }> {
  return JSON.parse(
    readFileSync(join(project, ".claude", "tools", "data", "stage-graph.json"), "utf-8"),
  );
}

function runDoctor(project: string) {
  return spawnSync(
    BUN,
    [join(project, ".claude", "tools", "aidlc-utility.ts"), "doctor"],
    {
      cwd: project,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        AIDLC_HARNESS_DIR: ".claude",
      },
    },
  );
}

function sidecarPath(project: string, plugin = PLUGIN): string {
  return join(project, ".claude", "tools", "data", `plugin-contrib-${plugin}.json`);
}

function stagePath(project: string, phase: string, slug: string): string {
  return join(project, ".claude", "aidlc-common", "stages", phase, `${slug}.md`);
}

function buildProseOnlyPlugin(source: string, destination: string, plugin: string): void {
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, ".claude-plugin"), join(destination, ".claude-plugin"), {
    recursive: true,
  });
  cpSync(join(source, "hooks"), join(destination, "hooks"), { recursive: true });
  const manifestPath = join(destination, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.name = plugin;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const contributionPath = join(
    destination,
    "contributions",
    "construction",
    "build-and-test.md",
  );
  mkdirSync(join(contributionPath, ".."), { recursive: true });
  writeFileSync(
    contributionPath,
    [
      "---",
      "target: build-and-test",
      `plugin: ${plugin}`,
      "fragments:",
      "  - anchor: end-of-steps",
      "    order: 910",
      "---",
      "",
      "## fragment: end-of-steps",
      "",
      "### Prose-only verification",
      "",
      "This fragment exists only to verify persisted composition provenance.",
      "",
    ].join("\n"),
  );
}

describe("t314 doctor detects plugin composition erased by an engine reinstall", () => {
  let tmp: string;
  let pluginBuilt: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-t314-"));
    pluginBuilt = join(tmp, "plugin", "claude");
    buildPluginProjection(PLUGIN, "claude", pluginBuilt);
  }, TIMEOUT_MS);

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("reinstall fails doctor until the plugin is composed again", () => {
    const project = join(tmp, "reinstall");
    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
    });
    expect(graph(project).some((stage) => stage.slug === "test-pro-integration")).toBe(true);
    expect(graph(project).some((stage) => stage.slug === "test-pro-full-suite")).toBe(true);

    copyHarnessInstall("claude", project);
    expect(graph(project).some((stage) => stage.slug === "test-pro-integration")).toBe(false);

    const broken = runDoctor(project);
    const brokenOut = `${broken.stdout ?? ""}${broken.stderr ?? ""}`;
    expect(broken.status).toBe(1);
    expect(brokenOut).toContain("Composed plugin surface:");
    expect(brokenOut).toContain("test-pro");
    expect(brokenOut).toContain("/aidlc plugin sync");
    expect(brokenOut).toContain("Uncompiled stage files:");
    expect(brokenOut).toContain("plugin-owned files");

    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
      copyInstall: false,
    });
    const repaired = runDoctor(project);
    expect(repaired.status).toBe(0);
    expect(repaired.stdout).toContain(
      "Composed plugin surface: all enabled plugin stages and recorded contributions are present",
    );
  });

  test("a stale contribution sidecar fails doctor even when plugin stages remain compiled", () => {
    const project = join(tmp, "stale-sidecar");
    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
    });
    expect(graph(project).some((stage) => stage.slug === "test-pro-integration")).toBe(true);

    cpSync(
      join(
        process.cwd(),
        "dist",
        "claude",
        ".claude",
        "aidlc-common",
        "stages",
        "construction",
        "build-and-test.md",
      ),
      join(
        project,
        ".claude",
        "aidlc-common",
        "stages",
        "construction",
        "build-and-test.md",
      ),
    );

    const broken = runDoctor(project);
    const brokenOut = `${broken.stdout ?? ""}${broken.stderr ?? ""}`;
    expect(broken.status).toBe(1);
    expect(brokenOut).toContain("Composed plugin surface:");
    expect(brokenOut).toContain("test-pro: stage build-and-test");
    expect(brokenOut).toContain("missing produces=");
    expect(brokenOut).toContain("/aidlc plugin sync");

    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
      copyInstall: false,
    });
    expect(runDoctor(project).status).toBe(0);
  });

  test("consume provenance verifies full semantics and accepts legacy strings", () => {
    const project = join(tmp, "consume-contract");
    const contractPlugin = join(tmp, "plugin", "consume-contract");
    cpSync(pluginBuilt, contractPlugin, { recursive: true });
    const contribution = join(
      contractPlugin,
      "contributions",
      "construction",
      "build-and-test.md",
    );
    const contributionBody = readFileSync(contribution, "utf-8");
    const withConditional = contributionBody.replace(
      "    - artifact: test-pro-test-harness-design\n      required: false",
      "    - artifact: test-pro-test-harness-design\n      required: false\n      conditional_on: brownfield",
    );
    expect(withConditional).not.toBe(contributionBody);
    writeFileSync(contribution, withConditional);

    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt: contractPlugin,
    });

    const sidecar = sidecarPath(project);
    const manifest = JSON.parse(readFileSync(sidecar, "utf-8"));
    expect(manifest["build-and-test"]?.consumes).toEqual([
      {
        artifact: "test-pro-test-harness-design",
        required: false,
        conditional_on: "brownfield",
      },
      { artifact: "test-pro-testability-requirements", required: false },
    ]);
    expect(runDoctor(project).status).toBe(0);

    const target = stagePath(project, "construction", "build-and-test");
    const composed = readFileSync(target, "utf-8");
    const changedRequired = composed.replace(
      "  - artifact: test-pro-test-harness-design\n    required: false",
      "  - artifact: test-pro-test-harness-design\n    required: true",
    );
    expect(changedRequired).not.toBe(composed);
    writeFileSync(target, changedRequired);
    const requiredMismatch = runDoctor(project);
    expect(requiredMismatch.status).toBe(1);
    expect(`${requiredMismatch.stdout}${requiredMismatch.stderr}`).toContain(
      "test-pro-test-harness-design(required=false, conditional_on=brownfield)",
    );

    const changedCondition = composed.replace(
      "    conditional_on: brownfield",
      "    conditional_on: greenfield",
    );
    expect(changedCondition).not.toBe(composed);
    writeFileSync(target, changedCondition);
    const conditionMismatch = runDoctor(project);
    expect(conditionMismatch.status).toBe(1);
    expect(`${conditionMismatch.stdout}${conditionMismatch.stderr}`).toContain(
      "test-pro-test-harness-design(required=false, conditional_on=brownfield)",
    );

    writeFileSync(target, composed);
    manifest["build-and-test"].consumes = manifest["build-and-test"].consumes.map(
      (entry: { artifact: string }) => entry.artifact,
    );
    writeFileSync(sidecar, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(runDoctor(project).status).toBe(0);
  });

  test("unreadable and malformed contribution sidecars fail closed", () => {
    const project = join(tmp, "invalid-sidecars");
    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
    });
    const sidecar = sidecarPath(project);

    writeFileSync(sidecar, "{ not-json\n");
    const unreadable = runDoctor(project);
    const unreadableOut = `${unreadable.stdout ?? ""}${unreadable.stderr ?? ""}`;
    expect(unreadable.status).toBe(1);
    expect(unreadableOut).toContain("Composed plugin surface:");
    expect(unreadableOut).toContain("contribution sidecar");
    expect(unreadableOut).toContain("unreadable or invalid");
    expect(unreadableOut).toContain("/aidlc plugin sync");

    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
      copyInstall: false,
    });
    expect(readFileSync(sidecar, "utf-8")).toBe("{ not-json\n");
    expect(runDoctor(project).status).toBe(1);

    writeFileSync(
      sidecar,
      `${JSON.stringify({ "build-and-test": { produces: "not-an-array" } }, null, 2)}\n`,
    );
    const malformed = runDoctor(project);
    const malformedOut = `${malformed.stdout ?? ""}${malformed.stderr ?? ""}`;
    expect(malformed.status).toBe(1);
    expect(malformedOut).toContain("target build-and-test is invalid");
    expect(malformedOut).toContain("produces must be an array");
    expect(malformedOut).toContain("/aidlc plugin sync");
  });

  test("a contribution sidecar targeting a removed stage fails closed", () => {
    const project = join(tmp, "removed-target");
    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
    });
    writeFileSync(
      sidecarPath(project),
      `${JSON.stringify({ "removed-stage": { produces: ["ghost-output"] } }, null, 2)}\n`,
    );

    const broken = runDoctor(project);
    const brokenOut = `${broken.stdout ?? ""}${broken.stderr ?? ""}`;
    expect(broken.status).toBe(1);
    expect(brokenOut).toContain("target removed-stage has no installed stage source");
    expect(brokenOut).toContain("/aidlc plugin sync");
  });

  test("a prose-only plugin leaves provenance that detects an erased fragment", () => {
    const plugin = "prose-only";
    const prosePlugin = join(tmp, "plugin", plugin);
    const project = join(tmp, "prose-only");
    buildProseOnlyPlugin(pluginBuilt, prosePlugin, plugin);
    composePluginFixture({
      plugin,
      harness: "claude",
      projectDir: project,
      pluginBuilt: prosePlugin,
    });

    const sidecar = sidecarPath(project, plugin);
    const target = stagePath(project, "construction", "build-and-test");
    const composed = readFileSync(target, "utf-8");
    const manifest = JSON.parse(readFileSync(sidecar, "utf-8"));
    const fragments = manifest["build-and-test"]?.fragments;
    expect(fragments).toHaveLength(1);
    expect(composed).toContain("Prose-only verification");

    copyHarnessInstall("claude", project);
    expect(existsSync(sidecar)).toBe(true);
    expect(readFileSync(target, "utf-8")).not.toContain("Prose-only verification");

    const broken = runDoctor(project);
    const brokenOut = `${broken.stdout ?? ""}${broken.stderr ?? ""}`;
    expect(broken.status).toBe(1);
    expect(brokenOut).toContain("prose-only: stage build-and-test");
    expect(brokenOut).toContain("missing fragments=[end-of-steps@910:");
    expect(brokenOut).toContain("/aidlc plugin sync");

    composePluginFixture({
      plugin,
      harness: "claude",
      projectDir: project,
      pluginBuilt: prosePlugin,
      copyInstall: false,
    });
    expect(runDoctor(project).status).toBe(0);
  });
});
