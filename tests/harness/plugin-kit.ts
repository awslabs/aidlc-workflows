// Framework-agnostic helpers for validating, building, composing, and driving
// AIDLC plugins. This module intentionally has no bun:test dependency.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  frontmatterBlock,
  parseStageFrontmatter,
  scalarField,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  type PluginValidationRule,
  validatePluginRoot,
} from "../../dist/claude/.claude/tools/aidlc-plugin-validate.ts";
import type { DriveOptions } from "./sdk-drive.ts";
import { driveAidlc } from "./sdk-drive.ts";
import type { AcpDriveOptions } from "./kiro-acp-drive.ts";
import { driveKiroAcp } from "./kiro-acp-drive.ts";
import {
  type ExecResult,
  execCodex,
  runCopilot,
  runCursor,
  runOpencode,
} from "./exec-drive.ts";
import { REPO_ROOT } from "./fixtures.ts";
import {
  harnessByName,
  type ShippedHarnessName,
} from "./harness-matrix.ts";

const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const BUN = process.execPath;
const TIMEOUT_MS = 60_000;

export function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdownFiles(path));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

export function stageBodyAfterFrontmatter(raw: string): string {
  return raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)?.[1] ?? "";
}

export function assertNonEmptyStageBody(file: string): void {
  const body = stageBodyAfterFrontmatter(readFileSync(file, "utf-8"));
  if (body.trim().length === 0) {
    throw new Error(
      `${file}: stage body is empty - the stage is behaviorally dead; did a transform drop everything after the closing ---?`,
    );
  }
}

export function buildPluginProjection(
  plugin: string,
  harness: ShippedHarnessName,
  outDir: string,
): string {
  const build = spawnSync(
    BUN,
    [PACKAGE_TS, "plugin", "build", plugin, harness, outDir],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
    },
  );
  if (build.status !== 0) {
    throw new Error(
      `plugin build failed for ${plugin}/${harness}: ${build.stderr}`,
    );
  }
  return outDir;
}

export function copyHarnessInstall(
  harness: ShippedHarnessName,
  projectDir: string,
): string {
  mkdirSync(projectDir, { recursive: true });
  cpSync(harnessByName(harness).distRoot, projectDir, { recursive: true });
  return projectDir;
}

export function readPluginDropLogs(projectDir: string): string {
  const healthDir = join(
    projectDir,
    "aidlc",
    "spaces",
    "default",
    "intents",
    ".aidlc-hooks-health",
  );
  if (!existsSync(healthDir)) return "";
  return readdirSync(healthDir)
    .filter(
      (file) =>
        file.startsWith("plugin-compose") && file.endsWith(".drops"),
    )
    .sort()
    .map((file) => readFileSync(join(healthDir, file), "utf-8"))
    .join("");
}

export interface ComposePluginFixtureOptions {
  plugin: string;
  harness: ShippedHarnessName;
  projectDir?: string;
  pluginBuilt?: string;
  copyInstall?: boolean;
  env?: NodeJS.ProcessEnv;
  beforeCompose?: (fixture: {
    projectDir: string;
    pluginBuilt: string;
  }) => void;
}

export interface ComposedPluginFixture {
  projectDir: string;
  pluginBuilt: string;
  dropLogs: string;
  composeStdout: string;
  composeStderr: string;
}

function cursorCompose(
  projectDir: string,
  pluginBuilt: string,
  envOverrides: NodeJS.ProcessEnv | undefined,
): { stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.PLUGIN_ROOT;
  delete env.AIDLC_PLUGIN_ROOT;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CURSOR_PROJECT_DIR;
  delete env.AIDLC_PROJECT_DIR;
  env.AIDLC_HARNESS_DIR = ".cursor";
  // Empty PATH forces the launcher's bundled compose fallback (no installed
  // aidlc binary); pass env.PATH via overrides to exercise the installed-
  // binary branch.
  env.PATH = "";
  Object.assign(env, envOverrides);

  const compose = spawnSync(
    BUN,
    [join(pluginBuilt, "hooks", "aidlc-plugin-compose.ts"), ".cursor"],
    {
      cwd: pluginBuilt,
      input: JSON.stringify({
        hook_event_name: "sessionStart",
        workspace_roots: [projectDir],
      }),
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
      env,
    },
  );
  if (compose.status !== 0) {
    throw new Error(`cursor compose failed: ${compose.stderr}`);
  }
  return { stdout: compose.stdout ?? "", stderr: compose.stderr ?? "" };
}

function directCompose(
  harness: ShippedHarnessName,
  projectDir: string,
  pluginBuilt: string,
  envOverrides: NodeJS.ProcessEnv | undefined,
): { stdout: string; stderr: string } {
  const harnessDir = harnessByName(harness).manifest.harnessDir;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_HARNESS_DIR: harnessDir,
    AIDLC_HARNESS_NAME: harness,
  };
  if (harness === "claude" || harness === "codex" || harness === "kiro" || harness === "kiro-ide") {
    env.CLAUDE_PLUGIN_ROOT = pluginBuilt;
    env.CLAUDE_PROJECT_DIR = projectDir;
  } else {
    env.PLUGIN_ROOT = pluginBuilt;
    env.AIDLC_PROJECT_DIR = projectDir;
  }
  Object.assign(env, envOverrides);

  const compose = spawnSync(BUN, [join(pluginBuilt, "hooks", "compose.ts")], {
    cwd: projectDir,
    encoding: "utf-8",
    timeout: TIMEOUT_MS - 5_000,
    env,
  });
  if (compose.status !== 0) {
    throw new Error(`${harness} compose failed: ${compose.stderr}`);
  }
  return { stdout: compose.stdout ?? "", stderr: compose.stderr ?? "" };
}

export function composePluginFixture(
  options: ComposePluginFixtureOptions,
): ComposedPluginFixture {
  const scratchRoot = options.projectDir
    ? dirname(resolve(options.projectDir))
    : mkdtempSync(join(tmpdir(), `aidlc-plugin-${options.plugin}-`));
  const projectDir =
    options.projectDir ?? join(scratchRoot, `${options.harness}-project`);
  const pluginBuilt =
    options.pluginBuilt ??
    join(scratchRoot, `plugin-${options.plugin}-${options.harness}`);

  if (options.copyInstall !== false && options.harness === "cursor") {
    mkdirSync(projectDir, { recursive: true });
    const install = spawnSync(
      BUN,
      [join(harnessByName("cursor").distRoot, "install.ts"), projectDir],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: TIMEOUT_MS - 5_000,
      },
    );
    if (install.status !== 0) {
      throw new Error(`cursor install failed: ${install.stderr}`);
    }
  } else if (options.copyInstall !== false) {
    copyHarnessInstall(options.harness, projectDir);
  }

  if (!options.pluginBuilt) {
    buildPluginProjection(
      options.plugin,
      options.harness,
      pluginBuilt,
    );
  }
  options.beforeCompose?.({ projectDir, pluginBuilt });

  const compose =
    options.harness === "cursor"
      ? cursorCompose(projectDir, pluginBuilt, options.env)
      : directCompose(
          options.harness,
          projectDir,
          pluginBuilt,
          options.env,
        );
  return {
    projectDir,
    pluginBuilt,
    dropLogs: readPluginDropLogs(projectDir),
    composeStdout: compose.stdout,
    composeStderr: compose.stderr,
  };
}

export interface PluginValidationOptions {
  coreStagesDir?: string;
  coreAgentsDir?: string;
}

export type PluginFindingCode =
  | "manifest-missing"
  | "manifest-json"
  | "manifest-shape"
  | "manifest-name"
  | "stage-schema"
  | "stage-slug"
  | "plugin-owner"
  | "artifact-namespace"
  | "contribution-target"
  | "file-name"
  | "stage-body"
  | "scope-schema"
  | "agent-schema"
  | "duplicate-artifact-producer"
  | "tools-payload"
  | "compose-hook-stale"
  | "plugin-root";

export interface PluginContentFinding {
  code: PluginFindingCode;
  file: string;
  message: string;
}

function addFinding(
  findings: PluginContentFinding[],
  code: PluginFindingCode,
  file: string,
  message: string,
): void {
  findings.push({ code, file, message });
}

export function pluginAgentRoster(
  pluginRoot: string,
  options: PluginValidationOptions = {},
): string[] {
  const coreAgentsDir =
    options.coreAgentsDir ??
    join(REPO_ROOT, "dist", "claude", ".claude", "agents");
  const coreSlugs = walkMarkdownFiles(coreAgentsDir).map((file) =>
    basename(file, ".md"),
  );
  const pluginSlugs = walkMarkdownFiles(join(pluginRoot, "agents")).map(
    (file) => basename(file, ".md"),
  );
  return [...new Set([...coreSlugs, ...pluginSlugs, "orchestrator"])].sort();
}

function nestedListField(
  frontmatter: string,
  parent: string,
  key: string,
): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const parentIndex = lines.indexOf(`${parent}:`);
  if (parentIndex < 0) return [];
  for (let index = parentIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line)) break;
    if (line === `  ${key}:`) {
      const values: string[] = [];
      for (let item = index + 1; item < lines.length; item += 1) {
        const itemLine = lines[item];
        const match = itemLine.match(/^\s{4}-\s+(.+?)\s*$/);
        if (match) {
          values.push(match[1].replace(/^["']|["']$/g, ""));
          continue;
        }
        if (itemLine.trim() !== "") break;
      }
      return values;
    }
  }
  return [];
}

function sharedFindingCode(rule: PluginValidationRule): PluginFindingCode {
  if (rule === "manifest-missing") return "manifest-missing";
  if (rule === "manifest-json") return "manifest-json";
  if (rule === "manifest-name") return "manifest-name";
  if (rule === "manifest-shape") return "manifest-shape";
  if (rule === "stage-frontmatter" || rule === "stage-schema") {
    return "stage-schema";
  }
  if (rule === "stage-filename") return "stage-slug";
  if (
    rule === "stage-owner" ||
    rule === "scope-owner" ||
    rule === "agent-owner"
  ) {
    return "plugin-owner";
  }
  if (
    rule === "scope-filename" ||
    rule === "scope-name" ||
    rule === "agent-filename" ||
    rule === "agent-name"
  ) {
    return "file-name";
  }
  if (
    rule === "scope-frontmatter" ||
    rule === "scope-depth" ||
    rule === "scope-keywords"
  ) {
    return "scope-schema";
  }
  if (rule === "agent-frontmatter") return "agent-schema";
  if (rule === "duplicate-artifact-producer") {
    return "duplicate-artifact-producer";
  }
  if (rule === "tools-payload") return "tools-payload";
  if (
    rule === "compose-hook-stale" ||
    rule === "compose-template-missing"
  ) {
    return "compose-hook-stale";
  }
  return "plugin-root";
}

export function validatePluginContent(
  pluginRoot: string,
  options: PluginValidationOptions = {},
): PluginContentFinding[] {
  const root = resolve(pluginRoot);
  const pluginName = basename(root);
  const findings: PluginContentFinding[] = [];

  const coreStagesDir =
    options.coreStagesDir ??
    join(
      REPO_ROOT,
      "dist",
      "claude",
      ".claude",
      "aidlc-common",
      "stages",
    );
  const coreStages = new Set(
    walkMarkdownFiles(coreStagesDir).map((file) => basename(file, ".md")),
  );
  const shared = validatePluginRoot(root, {
    stageContext: { agents: pluginAgentRoster(root, options) },
  });
  for (const finding of shared.errors) {
    addFinding(
      findings,
      sharedFindingCode(finding.rule),
      finding.file === "." ? root : join(root, finding.file),
      finding.message,
    );
  }

  for (const file of walkMarkdownFiles(join(root, "stages"))) {
    const raw = readFileSync(file, "utf-8");
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = parseStageFrontmatter(raw);
    } catch {
      // The shared validator already reports parse/schema failures.
    }
    const artifacts = parsed
      ? [
          ...(Array.isArray(parsed.produces) ? parsed.produces : []),
          ...(Array.isArray(parsed.optional_produces)
            ? parsed.optional_produces
            : []),
        ]
      : [];
    for (const artifact of artifacts) {
      if (
        typeof artifact === "string" &&
        !artifact.startsWith(`${pluginName}-`)
      ) {
        addFinding(
          findings,
          "artifact-namespace",
          file,
          `produced artifact "${artifact}" must start with "${pluginName}-"`,
        );
      }
    }
    try {
      assertNonEmptyStageBody(file);
    } catch (error) {
      addFinding(findings, "stage-body", file, String(error));
    }
  }

  for (const file of walkMarkdownFiles(join(root, "contributions"))) {
    const raw = readFileSync(file, "utf-8");
    const frontmatter = frontmatterBlock(raw) ?? "";
    const target = scalarField(frontmatter, "target");
    if (!target || !coreStages.has(target)) {
      addFinding(
        findings,
        "contribution-target",
        file,
        `target "${target}" does not resolve to a core stage slug`,
      );
    }
    if (scalarField(frontmatter, "plugin") !== pluginName) {
      addFinding(
        findings,
        "plugin-owner",
        file,
        `plugin field must equal "${pluginName}"`,
      );
    }
    for (const artifact of nestedListField(
      frontmatter,
      "adds",
      "produces",
    )) {
      if (!artifact.startsWith(`${pluginName}-`)) {
        addFinding(
          findings,
          "artifact-namespace",
          file,
          `produced artifact "${artifact}" must start with "${pluginName}-"`,
        );
      }
    }
  }
  return findings;
}

export type InvokableHarness =
  | "claude"
  | "kiro"
  | "codex"
  | "copilot"
  | "opencode"
  | "cursor";

const LIVE_GATES: Record<InvokableHarness, string> = {
  claude: "AIDLC_CLAUDE_SDK_LIVE",
  kiro: "AIDLC_KIRO_ACP_LIVE",
  codex: "AIDLC_CODEX_EXEC_LIVE",
  copilot: "AIDLC_COPILOT_EXEC_LIVE",
  opencode: "AIDLC_OPENCODE_RUN_LIVE",
  cursor: "AIDLC_CURSOR_RUN_LIVE",
};

/**
 * Return the opt-in environment variable for a live harness invocation.
 * An unset value means skip, not pass.
 */
export function liveGateFor(harness: InvokableHarness): string {
  return LIVE_GATES[harness];
}

export interface InvokeHarnessOptions {
  codexHome?: string;
  claude?: Omit<DriveOptions, "projectDir">;
  kiro?: Omit<AcpDriveOptions, "projectDir" | "prompt">;
  opencodeArgs?: string[];
}

export type HarnessInvocationResult =
  | {
      status: "skipped";
      harness: InvokableHarness;
      liveGate: string;
      reason: string;
    }
  | {
      status: "completed";
      harness: InvokableHarness;
      liveGate: string;
      result: unknown;
    };

export async function invokeHarness(
  workingDir: string,
  harness: InvokableHarness,
  prompt: string,
  options: InvokeHarnessOptions = {},
): Promise<HarnessInvocationResult> {
  const liveGate = liveGateFor(harness);
  if (process.env[liveGate] !== "1") {
    return {
      status: "skipped",
      harness,
      liveGate,
      reason: `${liveGate} is not set to 1`,
    };
  }

  let result:
    | Awaited<ReturnType<typeof driveAidlc>>
    | Awaited<ReturnType<typeof driveKiroAcp>>
    | ExecResult;
  switch (harness) {
    case "claude":
      result = await driveAidlc(prompt, {
        ...options.claude,
        projectDir: workingDir,
      });
      break;
    case "kiro":
      result = await driveKiroAcp({
        ...options.kiro,
        projectDir: workingDir,
        prompt,
      });
      break;
    case "codex": {
      const home = options.codexHome ?? process.env.CODEX_HOME;
      if (!home) {
        throw new Error(
          "codex invocation requires opts.codexHome or CODEX_HOME",
        );
      }
      result = execCodex(workingDir, home, prompt);
      break;
    }
    case "copilot":
      result = runCopilot(workingDir, prompt);
      break;
    case "opencode":
      result = runOpencode(
        workingDir,
        options.opencodeArgs ?? [prompt],
      );
      break;
    case "cursor":
      result = runCursor(workingDir, prompt);
      break;
  }
  return { status: "completed", harness, liveGate, result };
}
