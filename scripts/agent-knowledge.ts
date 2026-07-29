// scripts/agent-knowledge.ts - build-time absorption of reviewer knowledge
// into reviewer agent bodies.
//
// The two review-only agents (product-lead, architecture-reviewer) are always
// DISPATCHED (§12a), never inline, so their context is whatever the harness
// builds from the agent definition: the .md body everywhere, plus a
// `resources` preload on Kiro CLI only. Their `knowledge/<agent>/reviewing.md`
// checklist used to reach them only if they chose to read it at runtime - the
// same prose-only, non-deterministically-skipped delivery as the
// rules_in_context defect (the sibling surface in the same report). The
// deterministic channel for a dispatched agent is its definition body, so the
// packager absorbs each reviewer's knowledge files into its .md body at build
// time. The knowledge file stays the single hand-authored source of truth;
// the absorbed copy is generated, like everything else in dist/.
//
// The reviewer set is DERIVED from stage frontmatter (`reviewer:` lines), not
// hardcoded: a future stage naming a new reviewer agent automatically gets
// that agent's knowledge absorbed.
//
// Used by scripts/package.ts (the declarative projection: Claude, Kiro,
// Kiro IDE, and the opencode .aidlc copies) AND by the codex/opencode emit.ts
// plugins (which read core/agents/*.md directly, bypassing the packager's
// transform).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

// Walk core and owned-plugin stages and collect every frontmatter `reviewer:`
// value. Cached per coreRoot - the packager calls this once per projected
// agent file.
const reviewerSetCache = new Map<string, Set<string>>();

export function reviewerAgentSet(coreRoot: string): Set<string> {
  const cached = reviewerSetCache.get(coreRoot);
  if (cached) return cached;
  const set = new Set<string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        const m = readFileSync(full, "utf-8").match(/^reviewer:\s*(\S+)\s*$/m);
        if (m) set.add(m[1]);
      }
    }
  };
  walk(join(coreRoot, "aidlc-common", "stages"));
  const pluginsRoot = join(dirname(coreRoot), "plugins");
  if (existsSync(pluginsRoot)) {
    for (const plugin of readdirSync(pluginsRoot).sort()) {
      walk(join(pluginsRoot, plugin, "stages"));
    }
  }
  reviewerSetCache.set(coreRoot, set);
  return set;
}

// Append the agent's knowledge/<agent>/*.md files (sorted) to an agent .md
// body. Returns the input unchanged for non-reviewer agents and when the
// knowledge dir is absent/empty. The header names the authored source so a
// reader of the generated file knows where to edit. The absorbed text is
// token-free by construction (the knowledge files carry no {{HARNESS_DIR}}
// token today; if one appears, the caller's ordering - absorb BEFORE token
// substitution - resolves it like any core prose).
export function absorbReviewerKnowledge(
  content: string,
  agentName: string,
  coreRoot: string,
  sourceRoot: string = coreRoot,
): string {
  if (!reviewerAgentSet(coreRoot).has(agentName)) return content;
  const knowledgeDir = join(sourceRoot, "knowledge", agentName);
  if (!existsSync(knowledgeDir)) return content;
  const files = readdirSync(knowledgeDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length === 0) return content;
  const sections = files.map((f) => {
    const text = readFileSync(join(knowledgeDir, f), "utf-8").trim();
    return (
      `<!-- Absorbed at build time from knowledge/${agentName}/${f} - ` +
      `edit that file, not this generated copy. -->\n\n${text}`
    );
  });
  return `${content.trimEnd()}\n\n---\n\n${sections.join("\n\n---\n\n")}\n`;
}

// The agent slug for a projected agents/*.md path, or null when the path is
// not an agent persona file. Shared so the packager transform and the emit
// plugins gate absorption identically.
export function agentNameFromPath(srcPath: string): string | null {
  const posixPath = srcPath.split(sep).join("/");
  if (!posixPath.includes("/agents/") || !posixPath.endsWith("-agent.md")) {
    return null;
  }
  return posixPath.split("/").pop()?.replace(/\.md$/, "") ?? null;
}
