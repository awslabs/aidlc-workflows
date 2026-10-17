// covers: subcommand:aidlc-utility:doctor, subcommand:aidlc-utility:plugin-sync

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_RUNTIME_CASE_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
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
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import {
  buildPluginProjection,
  composePluginFixture,
  copyHarnessInstall,
} from "../harness/plugin-kit.ts";

const BUN = process.execPath;
const TIMEOUT_MS = NATIVE_FIXTURE_SETUP_TIMEOUT_MS;
const PLUGIN = "test-pro";
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function graph(project: string): Array<{ slug?: string }> {
  return JSON.parse(
    readFileSync(join(project, ".claude", "tools", "data", "stage-graph.json"), "utf-8"),
  );
}

function runDoctor(project: string, executable?: string) {
  return spawnSync(
    executable ?? BUN,
    [
      ...(executable ? [] : [join(project, ".claude", "tools", "aidlc-utility.ts")]),
      "doctor", "--verbose",
    ],
    {
      cwd: project,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_RUNTIME_CASE_TIMEOUT_MS),
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        AIDLC_HARNESS_DIR: ".claude",
        ...(executable ? { PATH: dirname(executable) } : {}),
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

  test.each(["copy", "native"])("%s: reinstall fails doctor until its emitted sync commands repair it", (channel) => {
    const project = join(tmp, `reinstall-${channel}`);
    composePluginFixture({
      plugin: PLUGIN,
      harness: "claude",
      projectDir: project,
      pluginBuilt,
    });
    expect(graph(project).some((stage) => stage.slug === "test-pro-integration")).toBe(true);
    expect(graph(project).some((stage) => stage.slug === "test-pro-full-suite")).toBe(true);

    copyHarnessInstall("claude", project);
    let executable: string | undefined;
    if (channel === "native") {
      const nativeRoot = join(REPO_ROOT, "dist-release", "claude");
      cpSync(nativeRoot, project, { recursive: true });
      const binDir = join(tmp, "bin");
      mkdirSync(binDir, { recursive: true });
      executable = join(binDir, process.platform === "win32" ? "aidlc.exe" : "aidlc");
      const built = spawnSync(BUN, [
        "build", "--compile", join(nativeRoot, ".claude", "tools", "aidlc.ts"),
        "--outfile", executable,
      ], { encoding: "utf-8", timeout: TIMEOUT_MS - 5_000 });
      expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
    }
    expect(graph(project).some((stage) => stage.slug === "test-pro-integration")).toBe(false);

    const broken = runDoctor(project, executable);
    const brokenOut = `${broken.stdout ?? ""}${broken.stderr ?? ""}`;
    expect(broken.status).toBe(1);
    expect(brokenOut).toContain("Composed plugin surface:");
    expect(brokenOut).toContain("test-pro");
    // The reinstall also reset the persona test-pro contributes to; doctor
    // names it as an agent, not a stage.
    expect(brokenOut).toContain("test-pro: agent aidlc-quality-agent");
    expect(brokenOut).toContain("test-pro: stage build-and-test");
    expect(brokenOut).toContain("/aidlc plugin sync");
    expect(brokenOut).toContain("Uncompiled stage files:");
    expect(brokenOut).toContain("plugin-owned files");

    // Follow the repair command printed by each affected doctor row. A
    // source scan can reject Bun yet still accept an unregistered CLI route.
    const commands = [...brokenOut.matchAll(/\(or `([^`]+)` with the plugin root environment set\)/g)]
      .map((match) => match[1]);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      const [launcher, ...argv] = command.split(/\s+/);
      expect(launcher).toBe(executable ? "aidlc" : "bun");
      const synced = spawnSync(executable ?? BUN, argv, {
        cwd: project,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          AIDLC_HARNESS_DIR: ".claude",
          AIDLC_PLUGIN_ROOT: pluginBuilt,
          ...(executable ? { PATH: dirname(executable) } : {}),
        },
      });
      expect(synced.status, `${synced.stdout}\n${synced.stderr}`).toBe(0);
    }
    const repaired = runDoctor(project, executable);
    // The standalone native binary has no machine installation and this PATH
    // intentionally omits Git. Verify the repaired project rows independently
    // of those machine/tool diagnostics; keep the copy fixture's full check.
    if (!executable) {
      expect(repaired.status, `${repaired.stdout}\n${repaired.stderr}`).toBe(0);
    }
    expect(repaired.stdout).toContain(
      "Composed plugin surface: all enabled plugin stages and recorded contributions are present",
    );
    expect(repaired.stdout).toContain(
      "Uncompiled stage files: 0 stage files missing from the compiled graph",
    );
    expect(graph(project).some((stage) => stage.slug === "test-pro-integration")).toBe(true);
    expect(graph(project).some((stage) => stage.slug === "test-pro-full-suite")).toBe(true);
  });

  // An upgrade can put the shipped core stage back over the composed one and
  // keep everything else (a copy of the new runtime over the project), or leave
  // the fragments that share an anchor nested (an earlier release's refresh
  // merge). The plugin's stamp and files are unchanged, so only its recorded
  // additions tell sync to compose it again. A person's edit inside a fragment,
  // when it is the plugin's only gap, does not: sync leaves it and doctor keeps
  // naming it.
  function syncPlugin(project: string): number {
    const synced = spawnSync(BUN, [join(project, ".claude", "tools", "aidlc.ts"), "engine", "plugin", "sync", "--json"], {
      cwd: project,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_RUNTIME_CASE_TIMEOUT_MS),
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        AIDLC_HARNESS_DIR: ".claude",
        AIDLC_PLUGIN_ROOT: pluginBuilt,
      },
    });
    expect(synced.status, `${synced.stdout}\n${synced.stderr}`).toBe(0);
    return (JSON.parse(synced.stdout) as { data: { operations: number } }).data.operations;
  }

  // The row and the fix line under it, which names each gap.
  function surfaceRow(project: string): string {
    const doctor = runDoctor(project);
    const lines = `${doctor.stdout}${doctor.stderr}`.split("\n");
    const at = lines.findIndex((line) => line.includes("Composed plugin surface"));
    expect(at).toBeGreaterThanOrEqual(0);
    return lines.slice(at, lines[at + 1]?.trim().startsWith("fix:") ? at + 2 : at + 1).join("\n");
  }

  const PRESENT = "Composed plugin surface: all enabled plugin stages and recorded contributions are present";

  // Composed and synced, so sync's own records say current: one more sync does nothing.
  function composedProject(name: string): string {
    const project = join(tmp, name);
    composePluginFixture({ plugin: PLUGIN, harness: "claude", projectDir: project, pluginBuilt });
    syncPlugin(project);
    expect(syncPlugin(project)).toBe(0);
    expect(surfaceRow(project)).toContain(PRESENT);
    return project;
  }

  test("sync composes again a plugin whose additions an upgrade wrote over", () => {
    const project = composedProject("upgrade-overwrote");
    const stage = stagePath(project, "construction", "build-and-test");
    const composed = readFileSync(stage, "utf-8");
    cpSync(join(REPO_ROOT, "dist", "claude", ".claude", "aidlc-common", "stages", "construction", "build-and-test.md"), stage);
    expect(surfaceRow(project)).toContain("test-pro: stage build-and-test");

    expect(syncPlugin(project)).toBeGreaterThan(0);
    expect(surfaceRow(project)).toContain(PRESENT);
    expect(readFileSync(stage, "utf-8")).toBe(composed);
    expect(syncPlugin(project)).toBe(0);
  });

  test("sync composes again a plugin whose fragments an earlier refresh nested", () => {
    const project = composedProject("upgrade-nested");
    const stage = stagePath(project, "construction", "build-and-test");
    const composed = readFileSync(stage, "utf-8");
    const opens = [...composed.matchAll(/<!-- plugin:test-pro:after-step:8:(\d+):([0-9a-f]+) -->/g)];
    expect(opens.length).toBeGreaterThanOrEqual(2);
    const [first, second] = opens;
    const close = `<!-- /plugin:test-pro:after-step:8:${second[1]}:${second[2]} -->`;
    const end = composed.indexOf(close) + close.length;
    const block = composed.slice(second.index, end);
    const without = composed.slice(0, second.index) + composed.slice(end);
    const at = without.indexOf(first[0]) + first[0].length;
    writeFileSync(stage, `${without.slice(0, at)}\n${block}${without.slice(at)}`);
    expect(surfaceRow(project)).toContain(`fragments=[after-step:8@${first[1]}:${first[2]}]`);

    expect(syncPlugin(project)).toBeGreaterThan(0);
    expect(surfaceRow(project)).toContain(PRESENT);
    const repaired = readFileSync(stage, "utf-8");
    expect(repaired.indexOf(second[0])).toBeGreaterThan(
      repaired.indexOf(`<!-- /plugin:test-pro:after-step:8:${first[1]}:${first[2]} -->`),
    );
  });

  test("sync leaves a person's edit inside a fragment, and doctor names it", () => {
    const project = composedProject("edited-fragment");
    const stage = stagePath(project, "construction", "build-and-test");
    const composed = readFileSync(stage, "utf-8");
    const heading = "### Step 8c (test-pro): API positive + negative";
    expect(composed).toContain(heading);
    const edited = composed.replace(heading, `${heading} (our team's wording)`);
    writeFileSync(stage, edited);
    expect(surfaceRow(project)).toContain("test-pro: stage build-and-test");

    expect(syncPlugin(project)).toBe(0);
    expect(readFileSync(stage, "utf-8")).toBe(edited);
    expect(surfaceRow(project)).toContain("test-pro: stage build-and-test");
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
