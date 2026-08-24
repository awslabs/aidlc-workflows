// Shared AIDLC plugin projection engine.
//
// The repository packager passes manifest-derived PluginTarget records directly.
// The shipped build CLI reads the same records from bundled
// tools/data/plugin-targets.json. This module therefore contains projection
// behavior but no framework-checkout or harness-manifest dependency.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type PluginTargetKind = "store" | "kiro" | "kiro-ide" | "cursor";

export interface PluginTarget {
  harnessName: string;
  manifestDir: string;
  harnessLeaf: string;
  kind: PluginTargetKind;
}

export type PluginTargetTable = Record<string, PluginTarget>;

export interface BuildPluginProjectionOptions {
  pluginRoot: string;
  target: PluginTarget;
  outDir: string;
  templateHooksDir: string;
  reviewerAgents?: Iterable<string>;
}

export interface PluginProjectionResult {
  pluginName: string;
  harness: string;
  outDir: string;
  files: string[];
}

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

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
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
    };
  }
  return out;
}

export function pluginReviewerAgents(pluginRoot: string): Set<string> {
  const reviewers = new Set<string>();
  for (const file of walk(join(pluginRoot, "stages")).filter((path) =>
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
    for (const file of walk(sourceDir)) {
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
        if (target.kind === "cursor") {
          projected = projectCursorPluginAgent(projected, file);
        }
        content = Buffer.from(projected, "utf-8");
      }
      writeFileSync(outPath, content);
    }
  }
}

export function assertPluginBuildOutput(
  outDir: string,
  target: PluginTarget,
  force = false,
): void {
  const outArg = outDir.replace(/[/\\]+$/, "") || outDir;
  const resolvedOut = isAbsolute(outArg)
    ? outArg
    : resolve(process.cwd(), outArg);
  let outLstat: ReturnType<typeof lstatSync> | null = null;
  try {
    outLstat = lstatSync(resolvedOut);
  } catch {
    outLstat = null;
  }
  if (outLstat?.isSymbolicLink()) {
    throw new Error(
      `refusing to build into "${outDir}" - it is a symlink; point at a real directory path.`,
    );
  }
  if (!existsSync(resolvedOut)) return;
  if (!statSync(resolvedOut).isDirectory()) {
    throw new Error(
      `refusing to build into "${outDir}" - it is a file, not a directory.`,
    );
  }
  if (readdirSync(resolvedOut).length === 0 || force) return;
  let priorProjection = false;
  try {
    const manifest = JSON.parse(
      readFileSync(
        join(resolvedOut, target.manifestDir, "plugin.json"),
        "utf-8",
      ),
    ) as { name?: unknown };
    priorProjection =
      typeof manifest.name === "string" &&
      manifest.name.startsWith("aidlc-");
  } catch {
    priorProjection = false;
  }
  if (!priorProjection) {
    throw new Error(
      `refusing to build into non-empty "${outDir}" - it is not a prior AIDLC plugin projection ` +
        `(no ${target.manifestDir}/plugin.json with an aidlc- name). Point at a fresh/empty directory.`,
    );
  }
}

export function buildPluginProjection(
  options: BuildPluginProjectionOptions,
): PluginProjectionResult {
  const pluginRoot = resolve(options.pluginRoot);
  const outDir = resolve(options.outDir);
  const manifest = readPluginManifest(pluginRoot);
  const pluginName = pluginNameFromManifest(pluginRoot, manifest);
  const version = manifest.version || "0.0.1";
  const author = manifest.author || { name: "AIDLC" };
  const description = manifest.description || "";
  const reviewers = new Set(
    options.reviewerAgents ?? pluginReviewerAgents(pluginRoot),
  );

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

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
    files: walk(outDir).map((file) =>
      relative(outDir, file).split(sep).join("/"),
    ),
  };
}
