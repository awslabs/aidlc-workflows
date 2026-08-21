// harness/opencode/emit.ts — the opencode per-shell emission plugin.
//
// The unified packager copies core/ → dist/opencode/.aidlc/ and runs graph
// compile + runner-gen there, then calls this emit() for the .opencode/ shell —
// the ONLY dir opencode itself reads (live-verified on 1.17.18):
//   - .opencode/agents/aidlc-*-agent.md — the 14 personas as native opencode
//     subagents: core frontmatter with the `tier:` line projected to the
//     opencode-native `model:`/`variant:` keys plus an added `mode: subagent`
//     (so none registers as a primary agent), body token-substituted → .aidlc.
//   - .opencode/command/aidlc.md — the user-invoked /aidlc entry (authored).
//   - .opencode/plugin/aidlc-opencode-adapter.ts — the hook adapter (authored;
//     opencode auto-discovers plugins from .opencode/plugin/).
//
// WHY the engine is NOT inside .opencode/: opencode auto-imports every *.ts
// under .opencode/tools/ and .opencode/tool/ as custom tool definitions, and
// importing a CLI-style script (top-level argv dispatch, process.exit) crashes
// the session (live-reproduced). The engine tree therefore ships at .aidlc/,
// which opencode never scans; the shipped opencode.json registers
// `skills.paths: [".aidlc/skills"]` for skill discovery there.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmitContext } from "../../scripts/manifest-types.ts";
import { absorbReviewerKnowledge } from "../../scripts/agent-knowledge.ts";
import { projectTier } from "../../core/tools/aidlc-tiers.ts";

// Rewrite a core persona .md into its opencode-native subagent twin. The
// frontmatter tier becomes model/variant plus mode, the core Task denial
// becomes opencode's native permission map, and a core `maxTurns:` cap is
// renamed to opencode's native `steps:` key (per-agent step cap, opencode
// >= 1.0.134; at the cap opencode forces a final TEXT-ONLY turn - the agent
// can return a summary but cannot make tool calls, so the persona's Turn
// Budget prose still carries the write-early instruction). Unknown disallowed
// tools fail the build instead of silently landing in opencode's inert
// options bag.
function emitSubagentMd(raw: string, srcPath: string, tierCap: EmitContext["tierCap"]): string {
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error(`${srcPath}: agent .md has no closed frontmatter block.`);
  const fm = m[1];
  const tierMatch = fm.match(/^tier:\s*(\S+)\s*$/m);
  if (!tierMatch) throw new Error(`${srcPath}: agent frontmatter has no tier: line.`);
  const disallowedMatch = fm.match(/^disallowedTools:\s*(.*?)\s*$/m);
  if (disallowedMatch && !/\bTask\b/i.test(disallowedMatch[1])) {
    throw new Error(
      `${srcPath}: opencode emission cannot project disallowedTools: ${disallowedMatch[1]}.`,
    );
  }
  const proj = projectTier(tierMatch[1], "opencode", tierCap); // throws on unknown tier
  const lines: string[] = [];
  if (proj.model !== null) lines.push(`model: ${proj.model}`);
  if (proj.variant !== null) lines.push(`variant: ${proj.variant}`);
  lines.push("mode: subagent");
  if (disallowedMatch) lines.push("permission:", "  task: deny");
  const newFm = fm
    .split(/\r?\n/)
    .flatMap((line) => {
      if (/^disallowedTools:/.test(line)) return [];
      // Core's harness-neutral turn cap -> opencode's native per-agent key.
      const maxTurns = line.match(/^maxTurns:\s*(\d+)\s*$/);
      if (maxTurns) return [`steps: ${maxTurns[1]}`];
      return /^tier:/.test(line) ? lines : [line];
    })
    .join("\n");
  return (
    raw
      .replace(m[0], () => `---\n${newFm}\n---\n`)
      // Keep persona prose consistent with the renamed frontmatter key: the
      // harness-neutral body cites its own cap as `maxTurns: <n>`; on this
      // roster that key is `steps: <n>`.
      .replace(/`maxTurns: (\d+)`/g, "`steps: $1`")
  );
}

function projectActiveMemoryReferences(raw: string): string {
  return raw
    .replaceAll("aidlc/spaces/<active-space>/memory/", "aidlc/spaces/default/memory/")
    .replaceAll(".aidlc/rules/aidlc-org.md", "aidlc/spaces/default/memory/org.md")
    .replaceAll(".aidlc/rules/aidlc-team.md", "aidlc/spaces/default/memory/team.md")
    .replaceAll(".aidlc/rules/aidlc-project.md", "aidlc/spaces/default/memory/project.md")
    .replaceAll(".aidlc/rules/", "aidlc/spaces/default/memory/");
}

function embedShippedEntrypoints(raw: string, distRoot: string): string {
  const marker = "/* @aidlc-shipped-entrypoints@ */ []";
  const entries = ["hooks", "tools"].flatMap((dir) =>
    readdirSync(join(distRoot, ".aidlc", dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => `${dir}/${entry.name}`)
  ).sort();
  if (!raw.includes(marker)) {
    throw new Error("opencode adapter is missing its shipped-entrypoint emission marker.");
  }
  const rendered = JSON.stringify(entries, null, 2)
    .split("\n")
    .map((line, index) => index === 0 ? line : `  ${line}`)
    .join("\n");
  return raw.replace(
    marker,
    `/* @aidlc-shipped-entrypoints@ */ ${rendered}`,
  );
}

export default function emit(ctx: EmitContext): void {
  const { coreRoot, harnessRoot, distRoot, substituteToken, tierCap } = ctx;
  const SHELL = join(distRoot, ".opencode");
  const ACTIVE_MEMORY = join(distRoot, "aidlc", "spaces", "default", "memory");
  if (!existsSync(ACTIVE_MEMORY)) {
    throw new Error(`opencode emission requires the shipped memory tree at ${ACTIVE_MEMORY}.`);
  }

  const emissions: Array<{ path: string; content: () => string }> = [];

  // Persona subagents from core/agents/*.md (tier-projected, body → .aidlc).
  const agentsDir = join(coreRoot, "agents");
  for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md")).sort()) {
    emissions.push({
      path: join(SHELL, "agents", f),
      content: () => {
        // Reviewer knowledge absorption (scripts/agent-knowledge.ts) on the
        // raw core text - this emission reads core/agents/*.md directly, so
        // the packager's transform (which absorbs for the .aidlc twins)
        // never runs on it.
        const raw = absorbReviewerKnowledge(
          readFileSync(join(agentsDir, f), "utf-8"),
          f.replace(/\.md$/, ""),
          coreRoot,
        );
        const projected = substituteToken(
          emitSubagentMd(raw, join(agentsDir, f), tierCap),
        );
        return projectActiveMemoryReferences(projected);
      },
    });
    // The conductor reads this core-projected copy for inline persona framing.
    // It needs the same valid method path as the native subagent twin.
    const inlinePath = join(distRoot, ".aidlc", "agents", f);
    emissions.push({
      path: inlinePath,
      content: () => projectActiveMemoryReferences(readFileSync(inlinePath, "utf-8")),
    });
  }

  // Authored shell surfaces, copied with token substitution on the .md.
  emissions.push({
    path: join(SHELL, "command", "aidlc.md"),
    content: () => substituteToken(readFileSync(join(harnessRoot, "command", "aidlc.md"), "utf-8")),
  });
  emissions.push({
    path: join(SHELL, "plugin", "aidlc-opencode-adapter.ts"),
    content: () =>
      embedShippedEntrypoints(
        readFileSync(join(harnessRoot, "plugin", "aidlc-opencode-adapter.ts"), "utf-8"),
        distRoot,
      ),
  });

  // Clean-sweep the shell so a removed persona/command cannot linger. In
  // --check mode the packager supplies an isolated distRoot, then compares the
  // complete generated tree with the committed distribution.
  rmSync(SHELL, { recursive: true, force: true });
  for (const { path, content } of emissions) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content(), "utf-8");
  }
}
