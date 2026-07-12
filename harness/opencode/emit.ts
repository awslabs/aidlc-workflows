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
import { dirname, join, relative } from "node:path";
import type { EmitContext, EmitResult } from "../../scripts/manifest-types.ts";
import { projectTier } from "../../core/tools/aidlc-tiers.ts";

// Rewrite a core persona .md into its opencode-native subagent twin: the
// frontmatter `tier: <t>` line becomes the projected `model:`/`variant:` keys
// (omitted when null — the inherit-by-omission contract) followed by
// `mode: subagent`. Everything else (name, display_name, description,
// disallowedTools — opencode routes unknown keys into `options` silently) and
// the body pass through. Mirrors the packager's projectTierFrontmatter shape.
function emitSubagentMd(raw: string, srcPath: string, tierCap: EmitContext["tierCap"]): string {
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error(`${srcPath}: agent .md has no closed frontmatter block.`);
  const fm = m[1];
  const tierMatch = fm.match(/^tier:\s*(\S+)\s*$/m);
  if (!tierMatch) throw new Error(`${srcPath}: agent frontmatter has no tier: line.`);
  const proj = projectTier(tierMatch[1], "opencode", tierCap); // throws on unknown tier
  const lines: string[] = [];
  if (proj.model !== null) lines.push(`model: ${proj.model}`);
  if (proj.variant !== null) lines.push(`variant: ${proj.variant}`);
  lines.push("mode: subagent");
  const newFm = fm
    .split(/\r?\n/)
    .flatMap((line) => (/^tier:/.test(line) ? lines : [line]))
    .join("\n");
  return raw.replace(m[0], () => `---\n${newFm}\n---\n`);
}

export default function emit(ctx: EmitContext): EmitResult {
  const { coreRoot, harnessRoot, distRoot, substituteToken, tierCap } = ctx;
  const SHELL = join(distRoot, ".opencode");

  const emissions: Array<{ path: string; content: () => string }> = [];

  // Persona subagents from core/agents/*.md (tier-projected, body → .aidlc).
  const agentsDir = join(coreRoot, "agents");
  for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md")).sort()) {
    emissions.push({
      path: join(SHELL, "agents", f),
      content: () =>
        substituteToken(emitSubagentMd(readFileSync(join(agentsDir, f), "utf-8"), join(agentsDir, f), tierCap)),
    });
  }

  // Authored shell surfaces, copied with token substitution on the .md.
  emissions.push({
    path: join(SHELL, "command", "aidlc.md"),
    content: () => substituteToken(readFileSync(join(harnessRoot, "command", "aidlc.md"), "utf-8")),
  });
  emissions.push({
    path: join(SHELL, "plugin", "aidlc-opencode-adapter.ts"),
    content: () => readFileSync(join(harnessRoot, "plugin", "aidlc-opencode-adapter.ts"), "utf-8"),
  });

  const written: string[] = [];
  const problems: string[] = [];
  if (ctx.check) {
    for (const { path, content } of emissions) {
      const want = content();
      if (!existsSync(path)) problems.push(`MISSING emission: ${relative(distRoot, path)}`);
      else if (readFileSync(path, "utf-8") !== want) problems.push(`DIFFERS emission: ${relative(distRoot, path)}`);
      written.push(path);
    }
  } else {
    // Clean-sweep the shell so a removed persona/command doesn't linger.
    rmSync(SHELL, { recursive: true, force: true });
    for (const { path, content } of emissions) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content(), "utf-8");
      written.push(path);
    }
  }
  return { written, problems };
}
