// Shared AIDLC plugin projection engine.
//
// The repository packager passes manifest-derived PluginTarget records directly.
// The shipped build CLI reads the same records from bundled
// tools/data/plugin-targets.json. This module therefore contains projection
// behavior but no framework-checkout or harness-manifest dependency.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  assertPluginContentHasNoSymlinks,
  assertSupportedPluginContributionPaths,
  scanPluginFiles,
  walkPluginFiles,
} from "./aidlc-plugin-validate.ts";
import { runWithOwnerStampedLock } from "./aidlc-lib.ts";

export type PluginTargetKind = "store" | "kiro" | "kiro-ide" | "cursor";

export interface PluginTarget {
  harnessName: string;
  manifestDir: string;
  harnessLeaf: string;
  kind: PluginTargetKind;
  installRoots: string[];
}

export type PluginTargetTable = Record<string, PluginTarget>;

export interface BuildPluginProjectionOptions {
  pluginRoot: string;
  target: PluginTarget;
  outDir: string;
  outputBoundary?: string;
  templateHooksDir: string;
  reviewerAgents?: Iterable<string>;
  lockTimeoutMs?: number;
}

export interface PluginProjectionResult {
  pluginName: string;
  harness: string;
  outDir: string;
  files: string[];
}

export const PLUGIN_PROJECTION_MARKER = ".aidlc-plugin-projection.json";
const PLUGIN_PROJECTION_MARKER_SCHEMA = 1;
const PLUGIN_PROJECTION_PRODUCER = "aidlc-plugin-build";
const PLUGIN_BUILD_LOCK_TIMEOUT_MS = 30_000;
const PLUGIN_BUILD_LOCK_RETRY_MS = 25;

const CONTENT_DIRS = [
  "stages",
  "sensors",
  "tools",
  "contributions",
  "scopes",
  "agents",
  "knowledge",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function canonicalOutputPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  try {
    existing = realpathSync.native(existing);
  } catch {
    // resolve() is still a stable fallback when no ancestor can be realpathed.
  }
  return join(existing, ...missing);
}

export function pluginBuildLockPath(outDir: string): string {
  const key = createHash("sha256")
    .update(canonicalOutputPath(outDir))
    .digest("hex");
  return join(tmpdir(), "aidlc-plugin-build-locks", key);
}

function withPluginBuildOutputLock<T>(
  outDir: string,
  timeoutMs: number,
  action: () => T,
): T {
  const lockDir = pluginBuildLockPath(outDir);
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });
  const result = runWithOwnerStampedLock(
    lockDir,
    Math.max(0, Math.floor(timeoutMs / PLUGIN_BUILD_LOCK_RETRY_MS)),
    PLUGIN_BUILD_LOCK_RETRY_MS,
    action,
  );
  if (!result.acquired) {
    throw new Error(
      `could not acquire plugin build output lock "${lockDir}" within ${timeoutMs}ms`,
    );
  }
  return result.value;
}

export function readPluginTargets(path: string): PluginTargetTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `cannot read plugin target table ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainRecord(parsed)) {
    throw new Error(`plugin target table ${path} must be a JSON object`);
  }
  const out: PluginTargetTable = {};
  for (const [harness, value] of Object.entries(parsed)) {
    if (
      !isPlainRecord(value) ||
      typeof value.harnessName !== "string" ||
      typeof value.manifestDir !== "string" ||
      typeof value.harnessLeaf !== "string" ||
      !Array.isArray(value.installRoots) ||
      value.installRoots.some((item) => typeof item !== "string") ||
      (value.kind !== "store" &&
        value.kind !== "kiro" &&
        value.kind !== "kiro-ide" &&
        value.kind !== "cursor")
    ) {
      throw new Error(
        `plugin target table ${path} has an invalid entry for "${harness}"`,
      );
    }
    out[harness] = {
      harnessName: value.harnessName,
      manifestDir: value.manifestDir,
      harnessLeaf: value.harnessLeaf,
      kind: value.kind,
      installRoots: [...value.installRoots],
    };
  }
  return out;
}

export function pluginReviewerAgents(pluginRoot: string): Set<string> {
  const reviewers = new Set<string>();
  for (const file of walkPluginFiles(join(pluginRoot, "stages")).filter((path) =>
    path.endsWith(".md"),
  )) {
    const match = readFileSync(file, "utf-8").match(
      /^reviewer:\s*(\S+)\s*$/m,
    );
    if (match) reviewers.add(match[1]);
  }
  return reviewers;
}

function absorbPluginReviewerKnowledge(
  content: string,
  agentName: string,
  pluginRoot: string,
  reviewers: ReadonlySet<string>,
): string {
  if (!reviewers.has(agentName)) return content;
  const knowledgeDir = join(pluginRoot, "knowledge", agentName);
  if (!existsSync(knowledgeDir)) return content;
  const files = readdirSync(knowledgeDir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  if (files.length === 0) return content;
  const sections = files.map((file) => {
    const text = readFileSync(join(knowledgeDir, file), "utf-8").trim();
    return (
      `<!-- Absorbed at build time from knowledge/${agentName}/${file} - ` +
      `edit that file, not this generated copy. -->\n\n${text}`
    );
  });
  return `${content.trimEnd()}\n\n---\n\n${sections.join("\n\n---\n\n")}\n`;
}

function injectDelegatedKnowledgePreflight(
  content: string,
  agentName: string,
  harnessDir: string,
): string {
  const marker = "<!-- aidlc-delegated-knowledge-preflight -->";
  if (content.includes(marker)) return content;
  const block =
    `${marker}\n` +
    `**Delegated knowledge preflight (mandatory):** Before substantive work, ` +
    `ensure every readable Markdown file under these directories is loaded, in order: ` +
    `\`${harnessDir}/knowledge/aidlc-shared/\`, ` +
    `\`${harnessDir}/knowledge/${agentName}/\`, ` +
    `\`aidlc/spaces/<active-space>/knowledge/aidlc-shared/\`, then ` +
    `\`aidlc/spaces/<active-space>/knowledge/${agentName}/\`. ` +
    `A native resource preload satisfies this requirement; otherwise read the files now. ` +
    `The dispatch brief supplies rules and artifact paths separately.`;
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!frontmatter) return `${block}\n\n${content.trimStart()}`;
  return (
    content.slice(0, frontmatter[0].length) +
    `${block}\n\n` +
    content.slice(frontmatter[0].length)
  );
}

function projectCursorPluginAgent(
  source: string,
  sourcePath: string,
): string {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    throw new Error(
      `${sourcePath}: plugin agent has no closed frontmatter block.`,
    );
  }
  const frontmatter = match[1]
    .split(/\r?\n/)
    .filter((line) => !/^(?:model|tier|effort|variant):/.test(line))
    .join("\n");
  return source
    .replace(match[0], () => `---\n${frontmatter}\n---\n`)
    .replaceAll("{{HARNESS_DIR}}", ".cursor");
}

function readPluginManifest(pluginRoot: string): Record<string, unknown> {
  const manifestPath = join(
    pluginRoot,
    ".aidlc-plugin",
    "plugin.json",
  );
  try {
    const parsed = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as unknown;
    if (!isPlainRecord(parsed)) {
      throw new Error("manifest root must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `${pluginRoot}: cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}. Fix the manifest JSON.`,
    );
  }
}

function pluginNameFromManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): string {
  if (typeof manifest.name === "string" && manifest.name.trim()) {
    return manifest.name.trim();
  }
  return basename(pluginRoot);
}

function copyHookTemplates(
  pluginRoot: string,
  outDir: string,
  templateHooksDir: string,
  target: PluginTarget,
): void {
  const hooksDir = join(outDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const vendoredCompose = join(pluginRoot, "hooks", "compose.ts");
  const referenceCompose = join(templateHooksDir, "compose.ts");
  if (
    existsSync(vendoredCompose) &&
    !readFileSync(vendoredCompose).equals(readFileSync(referenceCompose))
  ) {
    throw new Error(
      `${vendoredCompose} differs from bundled compose template ${referenceCompose}`,
    );
  }
  for (const file of readdirSync(templateHooksDir).sort()) {
    if (
      file === "aidlc-plugin-compose.ts" &&
      target.kind !== "cursor" &&
      target.kind !== "kiro-ide"
    ) {
      continue;
    }
    const source =
      file === "compose.ts" && existsSync(vendoredCompose)
        ? vendoredCompose
        : join(templateHooksDir, file);
    cpSync(source, join(hooksDir, file));
  }
}

function composeCommand(target: PluginTarget): string {
  const rootExpr =
    target.harnessName === "claude"
      ? `\${CLAUDE_PLUGIN_ROOT}`
      : `\${PLUGIN_ROOT}`;
  if (target.kind === "cursor") {
    return `bun ./hooks/aidlc-plugin-compose.ts ${target.harnessLeaf}`;
  }
  if (target.kind === "kiro-ide") {
    return (
      `bun ./hooks/aidlc-plugin-compose.ts ${target.harnessLeaf} ` +
      target.harnessName
    );
  }
  const composePath = `${rootExpr}/hooks/compose.ts`;
  const aidlcExpr =
    "AIDLC=$(command -v aidlc 2>/dev/null || true); " +
    `[ -n "$AIDLC" ] && { AIDLC_HARNESS_DIR=${target.harnessLeaf} ` +
    `AIDLC_HARNESS_NAME=${target.harnessName} "$AIDLC" plugin sync && exit 0; }; `;
  const bunExpr =
    "BUN=$(command -v bun 2>/dev/null || true); " +
    '[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"; ' +
    '[ -z "$BUN" ] && { echo "aidlc plugin compose: aidlc and bun not found, skipping" >&2; exit 0; }';
  return (
    `sh -c '${aidlcExpr}${bunExpr}; AIDLC_HARNESS_DIR=${target.harnessLeaf} ` +
    `AIDLC_HARNESS_NAME=${target.harnessName} "$BUN" "${composePath}"'`
  );
}

function writeHookWiring(
  pluginName: string,
  outDir: string,
  target: PluginTarget,
): void {
  const command = composeCommand(target);
  if (target.kind === "kiro") return;
  if (target.kind === "kiro-ide") {
    const hooksDir = join(outDir, target.harnessLeaf, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, `aidlc-${pluginName}-compose.json`),
      `${JSON.stringify(
        {
          version: "v1",
          hooks: [
            {
              name: `aidlc-${pluginName}-compose`,
              trigger: "SessionStart",
              description: `Composes the ${pluginName} AIDLC plugin at session start.`,
              action: { type: "command", command },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (target.kind === "cursor") {
    writeFileSync(
      join(outDir, "hooks", "hooks.json"),
      `${JSON.stringify(
        {
          version: 1,
          hooks: { sessionStart: [{ command }] },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  writeFileSync(
    join(outDir, "hooks", "hooks.json"),
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command,
                  statusMessage: `AIDLC ${pluginName}: composing plugin`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
}

function copyPluginContent(
  pluginRoot: string,
  outDir: string,
  target: PluginTarget,
  reviewers: ReadonlySet<string>,
): void {
  for (const dir of CONTENT_DIRS) {
    const sourceDir = join(pluginRoot, dir);
    if (!existsSync(sourceDir)) continue;
    for (const file of walkPluginFiles(sourceDir)) {
      const outputDir =
        target.kind === "cursor" && dir === "agents"
          ? join(outDir, "aidlc", "agents")
          : join(outDir, dir);
      const outPath = join(outputDir, relative(sourceDir, file));
      mkdirSync(dirname(outPath), { recursive: true });
      let content = readFileSync(file);
      if (dir === "agents" && file.endsWith("-agent.md")) {
        let projected = absorbPluginReviewerKnowledge(
          content.toString("utf-8"),
          basename(file, ".md"),
          pluginRoot,
          reviewers,
        );
        projected = injectDelegatedKnowledgePreflight(
          projected,
          basename(file, ".md"),
          target.harnessLeaf,
        );
        if (target.kind === "cursor") {
          projected = projectCursorPluginAgent(projected, file);
        }
        content = Buffer.from(projected, "utf-8");
      }
      writeFileSync(outPath, content);
    }
  }
}

function assertBuildPathHasNoSymlinks(
  outDir: string,
  resolvedOut: string,
  outputBoundary: string,
): void {
  const boundary = resolve(outputBoundary);
  const boundaryRelative = relative(boundary, resolvedOut);
  if (
    isAbsolute(boundaryRelative) ||
    boundaryRelative === ".." ||
    boundaryRelative.startsWith(`..${sep}`)
  ) {
    throw new Error(
      `refusing to build into "${outDir}" - output escapes trusted boundary "${boundary}".`,
    );
  }

  let current = boundary;
  for (const segment of boundaryRelative
    .split(sep)
    .filter(Boolean)) {
    current = join(current, segment);
    let currentStat: ReturnType<typeof lstatSync>;
    try {
      currentStat = lstatSync(current);
    } catch {
      return;
    }
    if (!currentStat.isSymbolicLink()) continue;
    if (current === resolvedOut) {
      throw new Error(
        `refusing to build into "${outDir}" - it is a symlink; point at a real directory path.`,
      );
    }
    throw new Error(
      `refusing to build into "${outDir}" - parent path component "${current}" is a symlink; point at a real directory path.`,
    );
  }

  const linked = scanPluginFiles(resolvedOut).symlinks[0];
  if (!linked) return;
  if (linked === resolvedOut) {
    throw new Error(
      `refusing to build into "${outDir}" - it is a symlink; point at a real directory path.`,
    );
  }
  throw new Error(
    `refusing to build into "${outDir}" - existing output contains symlink "${linked}"; remove the link before rebuilding.`,
  );
}

export function assertPluginBuildOutput(
  outDir: string,
  target: PluginTarget,
  pluginName: string,
  outputBoundary = outDir,
): void {
  const outArg = outDir.replace(/[/\\]+$/, "") || outDir;
  const resolvedOut = isAbsolute(outArg)
    ? outArg
    : resolve(process.cwd(), outArg);
  assertBuildPathHasNoSymlinks(
    outDir,
    resolvedOut,
    outputBoundary,
  );
  if (!existsSync(resolvedOut)) return;
  if (!statSync(resolvedOut).isDirectory()) {
    throw new Error(
      `refusing to build into "${outDir}" - it is a file, not a directory.`,
    );
  }
  if (readdirSync(resolvedOut).length === 0) return;
  const markerPath = join(resolvedOut, PLUGIN_PROJECTION_MARKER);
  let marker: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as unknown;
    marker = isPlainRecord(parsed) ? parsed : null;
  } catch {
    marker = null;
  }
  if (
    !marker ||
    marker.schema !== PLUGIN_PROJECTION_MARKER_SCHEMA ||
    marker.producer !== PLUGIN_PROJECTION_PRODUCER ||
    typeof marker.plugin !== "string" ||
    typeof marker.harness !== "string"
  ) {
    throw new Error(
      `refusing to build into non-empty "${outDir}" - it has no valid ${PLUGIN_PROJECTION_MARKER} ownership marker. ` +
        "Point at a fresh/empty directory.",
    );
  }
  if (
    marker.plugin !== pluginName ||
    marker.harness !== target.harnessName
  ) {
    throw new Error(
      `refusing to replace "${outDir}" - its ${PLUGIN_PROJECTION_MARKER} belongs to ` +
        `plugin "${marker.plugin}" for harness "${marker.harness}", not plugin "${pluginName}" ` +
        `for harness "${target.harnessName}".`,
    );
  }
}

export function buildPluginProjection(
  options: BuildPluginProjectionOptions,
): PluginProjectionResult {
  const pluginRoot = resolve(options.pluginRoot);
  const outDir = resolve(options.outDir);
  assertBuildPathHasNoSymlinks(
    options.outDir,
    outDir,
    options.outputBoundary ?? outDir,
  );
  assertPluginContentHasNoSymlinks(pluginRoot);
  const manifest = readPluginManifest(pluginRoot);
  const pluginName = pluginNameFromManifest(pluginRoot, manifest);
  assertSupportedPluginContributionPaths(manifest);
  const version = manifest.version || "0.0.1";
  const author = manifest.author || { name: "AIDLC" };
  const description = manifest.description || "";
  const reviewers = new Set(
    options.reviewerAgents ?? pluginReviewerAgents(pluginRoot),
  );

  return withPluginBuildOutputLock(
    outDir,
    options.lockTimeoutMs ?? PLUGIN_BUILD_LOCK_TIMEOUT_MS,
    () => {
      assertPluginBuildOutput(
        options.outDir,
        options.target,
        pluginName,
        options.outputBoundary ?? outDir,
      );

      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, PLUGIN_PROJECTION_MARKER),
        `${JSON.stringify(
          {
            schema: PLUGIN_PROJECTION_MARKER_SCHEMA,
            producer: PLUGIN_PROJECTION_PRODUCER,
            plugin: pluginName,
            harness: options.target.harnessName,
          },
          null,
          2,
        )}\n`,
      );

      const hostManifestDir = join(outDir, options.target.manifestDir);
      mkdirSync(hostManifestDir, { recursive: true });
      writeFileSync(
        join(hostManifestDir, "plugin.json"),
        `${JSON.stringify(
          {
            name: `aidlc-${pluginName}`,
            version,
            description,
            author,
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(hostManifestDir, "marketplace.json"),
        `${JSON.stringify(
          {
            name: "aidlc-plugins",
            owner: author,
            description: "AIDLC plugin catalogue.",
            plugins: [
              {
                name: `aidlc-${pluginName}`,
                source: ".",
                version,
                description,
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      copyHookTemplates(
        pluginRoot,
        outDir,
        options.templateHooksDir,
        options.target,
      );
      writeHookWiring(pluginName, outDir, options.target);
      copyPluginContent(pluginRoot, outDir, options.target, reviewers);

      return {
        pluginName,
        harness: options.target.harnessName,
        outDir,
        files: walkPluginFiles(outDir).map((file) =>
          relative(outDir, file).split(sep).join("/"),
        ),
      };
    },
  );
}
