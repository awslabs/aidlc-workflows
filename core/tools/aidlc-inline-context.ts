// The inline context roster: the persona and shipped knowledge files the
// conductor must read for a stage. The orchestrator names them in a run-stage
// directive's inline_context_paths; doctor probes the same roster against
// ignore rules that would deny those reads, so both answer from one source.

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { GraphStage } from "./aidlc-graph.ts";
import { errorMessage, isPluginEnabled, toPosix } from "./aidlc-lib.ts";

// Walk a knowledge directory into path-roster entries. Knowledge remains
// path-loaded until the future retrieval layer lands. We do a cheap read
// preflight so an unreadable file produces an actionable warning instead of a
// path the conductor cannot use.
function assertReadableUtf8(path: string): void {
  const bytes = readFileSync(path);
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// `preflight` throws for a file the roster must skip. The engine's default reads
// it as UTF-8; doctor passes a stat-only check so it never reads a checkout's
// files (a symlink to a FIFO or /dev/zero would block or exhaust memory).
export function markdownFilesUnder(
  absDir: string,
  relativeDir: string,
  warnings: string[],
  preflight: (path: string) => void = assertReadableUtf8,
): Array<{ abs: string; rel: string }> {
  if (!existsSync(absDir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch (e) {
    warnings.push(
      `Warning: optional persona/knowledge directory "${toPosix(relativeDir)}" is unreadable (${errorMessage(e)}). ` +
        "Fix the directory or its permissions; this stage will continue without that context.",
    );
    return [];
  }
  const files: Array<{ abs: string; rel: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absPath = join(absDir, entry.name);
    const relativePath = toPosix(join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      files.push(...markdownFilesUnder(absPath, relativePath, warnings, preflight));
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name.endsWith(".md")
    ) {
      try {
        preflight(absPath);
      } catch (e) {
        warnings.push(
          `Warning: optional persona/knowledge file "${relativePath}" is unreadable or invalid UTF-8 (${errorMessage(e)}). ` +
            "Fix the file, encoding, or permissions; this stage will continue without that context.",
        );
        continue;
      }
      files.push({ abs: absPath, rel: relativePath });
    }
  }
  return files;
}

// The agents whose persona + knowledge the CONDUCTOR itself must hold for a
// stage: lead + supports on inline stages, lead only on a mob (supports are
// dispatched), none on fully-dispatched subagent/pipeline topologies. Shared
// by the roster builder and the deliver-once derivation so both agree on
// "who is inline here".
export function inlineAgentsFor(node: GraphStage): string[] {
  const inlineAgents = node.mode === "inline"
    ? [node.lead_agent, ...(node.support_agents ?? [])]
    : node.mode === "mob"
      ? [node.lead_agent]
      : [];
  return [...new Set(inlineAgents)].filter((agent) => agent !== "orchestrator");
}

// Conductor-owned context is a concrete file roster, not an instruction inferred
// from lead/support names. Inline stages load lead + supports; mob stages keep the
// lead inline but dispatch every support, so only the lead belongs in this roster.
// Fully-dispatched subagent/pipeline stages carry no inline context.
//
// Returns {abs, rel, agent} entries: `rel` is the display path the directive
// names, `abs` where the file lives, `agent` the roster member the file
// belongs to (null for the aidlc-shared tree, which belongs to every agent) -
// the deliver-once derivation filters on it. inlineContextPaths below is the
// path-only projection the directive's roster field carries.
export type InlineContextEntry = { abs: string; rel: string; agent: string | null };
type PluginKnowledgeOwners = ReadonlyMap<string, ReadonlySet<string>>;

// Minimal scopes still load every active-space rule, persona, stage file,
// consume, and user/team knowledge file. The only pruning here is shipped
// framework knowledge whose subject belongs to another stage. Standard and
// Comprehensive depth keep the full historical roster.
const MINIMAL_INLINE_KNOWLEDGE: Readonly<
  Record<string, Readonly<Record<string, ReadonlySet<string>>>>
> = {
  "intent-capture": {
    "aidlc-shared": new Set([
      "ai-dlc-principles.md",
      "rules-reading.md",
      "verification.md",
    ]),
    "aidlc-product-agent": new Set([
      "requirements-elicitation.md",
      "requirements-guide.md",
    ]),
    "aidlc-architect-agent": new Set(["architecture-guide.md"]),
  },
  "requirements-analysis": {
    "aidlc-shared": new Set([
      "ai-dlc-principles.md",
      "brownfield.md",
      "rules-reading.md",
      "verification.md",
    ]),
    "aidlc-product-agent": new Set([
      "requirements-elicitation.md",
      "requirements-guide.md",
    ]),
  },
};

const SHIPPED_INLINE_KNOWLEDGE: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  "aidlc-shared": new Set([
    "ai-dlc-principles.md",
    "audit-format.md",
    "brownfield.md",
    "knowledge-readme-template.md",
    "memory-template.md",
    "rules-reading.md",
    "state-template.md",
    "verification.md",
    "worktree-info-schema.md",
  ]),
  "aidlc-product-agent": new Set([
    "functional-design-guide.md",
    "market-research-methods.md",
    "prioritization-frameworks.md",
    "product-guide.md",
    "requirements-elicitation.md",
    "requirements-guide.md",
    "user-story-patterns.md",
  ]),
  "aidlc-architect-agent": new Set([
    "adr-template.md",
    "architecture-guide.md",
    "architecture-patterns.md",
    "ddd-patterns.md",
    "nfr-design-guide.md",
    "nfr-design-patterns.md",
  ]),
};

function pluginKnowledgeOwners(
  harnessRoot: string,
  warnings: string[],
): PluginKnowledgeOwners {
  const dataDir = join(harnessRoot, "tools", "data");
  if (!existsSync(dataDir)) return new Map();
  const owners = new Map<string, Set<string>>();
  let files: string[];
  try {
    files = readdirSync(dataDir)
      .filter((name) =>
        name.startsWith("plugin-files-") && name.endsWith(".json")
      )
      .sort();
  } catch (e) {
    warnings.push(
      `Warning: plugin knowledge ownership data "${toPosix(dataDir)}" is unreadable (${errorMessage(e)}). ` +
        "Minimal context will continue without plugin provenance.",
    );
    return owners;
  }
  for (const name of files) {
    const path = join(dataDir, name);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        schema_version?: unknown;
        plugin?: unknown;
        knowledge?: unknown;
      };
      if (
        parsed.schema_version !== 1 ||
        typeof parsed.plugin !== "string" ||
        !Array.isArray(parsed.knowledge)
      ) {
        throw new Error("expected schema_version 1, plugin, and knowledge[]");
      }
      for (const value of parsed.knowledge) {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.startsWith("/") ||
          value.split("/").includes("..")
        ) {
          throw new Error("knowledge paths must be relative path segments");
        }
        const rel = toPosix(join("knowledge", value));
        const pathOwners = owners.get(rel) ?? new Set<string>();
        pathOwners.add(parsed.plugin);
        owners.set(rel, pathOwners);
      }
    } catch (e) {
      warnings.push(
        `Warning: plugin knowledge ownership file "${toPosix(path)}" is invalid (${errorMessage(e)}). ` +
          "Re-run plugin composition before relying on Minimal context pruning.",
      );
    }
  }
  return owners;
}

function selectShippedInlineKnowledge(
  files: Array<{ abs: string; rel: string }>,
  stage: string,
  owner: string,
  depth: string | null,
  harnessRoot: string,
  pluginOwners: PluginKnowledgeOwners,
): Array<{ abs: string; rel: string }> {
  if (depth?.trim().toLowerCase() !== "minimal") return files;
  const selected = MINIMAL_INLINE_KNOWLEDGE[stage]?.[owner];
  if (!selected) return files;
  const shipped = SHIPPED_INLINE_KNOWLEDGE[owner];
  return files.filter((file) => {
    const harnessRelative = toPosix(relative(harnessRoot, file.abs));
    const pathOwners = pluginOwners.get(harnessRelative);
    if (pathOwners) {
      return [...pathOwners].some((plugin) => isPluginEnabled(plugin));
    }
    const ownerRelative = toPosix(relative(
      join(harnessRoot, "knowledge", owner),
      file.abs,
    ));
    return shipped?.has(ownerRelative) !== true ||
      selected.has(ownerRelative);
  });
}

// The persona and shipped knowledge files the conductor must hold for a stage,
// under an explicit harness root: `harnessRoot` is where the files live and
// `harnessPrefix` the display prefix a directive names them by. Depth "minimal"
// prunes shipped knowledge that belongs to another stage; any other depth keeps
// the full roster. The orchestrator adds user/team knowledge on top.
export function shippedInlineContextEntries(
  node: GraphStage,
  harnessRoot: string,
  harnessPrefix: string,
  warnings: string[] = [],
  depth: string | null = null,
  preflight: (path: string) => void = assertReadableUtf8,
): InlineContextEntry[] {
  const agents = inlineAgentsFor(node);
  if (agents.length === 0) return [];
  const entries: InlineContextEntry[] = [];
  const pluginOwners = pluginKnowledgeOwners(harnessRoot, warnings);

  for (const agent of agents) {
    const persona = join(harnessRoot, "agents", `${agent}.md`);
    const rel = toPosix(join(harnessPrefix, "agents", `${agent}.md`));
    if (!existsSync(persona)) {
      warnings.push(
        `Warning: optional persona/knowledge file "${rel}" is missing. ` +
          "Restore the file; this stage will continue without that context.",
      );
      continue;
    }
    try {
      preflight(persona);
    } catch (e) {
      warnings.push(
        `Warning: optional persona/knowledge file "${rel}" is unreadable or invalid UTF-8 (${errorMessage(e)}). ` +
          "Fix the file, encoding, or permissions; this stage will continue without that context.",
      );
      continue;
    }
    entries.push({
      abs: persona,
      rel,
      agent,
    });
  }
  entries.push(
    ...selectShippedInlineKnowledge(
      markdownFilesUnder(
        join(harnessRoot, "knowledge", "aidlc-shared"),
        join(harnessPrefix, "knowledge", "aidlc-shared"),
        warnings,
        preflight,
      ),
      node.slug,
      "aidlc-shared",
      depth,
      harnessRoot,
      pluginOwners,
    ).map((f) => ({ ...f, agent: null })),
  );
  for (const agent of agents) {
    entries.push(
      ...selectShippedInlineKnowledge(
        markdownFilesUnder(
          join(harnessRoot, "knowledge", agent),
          join(harnessPrefix, "knowledge", agent),
          warnings,
          preflight,
        ),
        node.slug,
        agent,
        depth,
        harnessRoot,
        pluginOwners,
      ).map((f) => ({ ...f, agent })),
    );
  }

  return entries;
}
