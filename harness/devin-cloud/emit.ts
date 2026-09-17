// harness/devin-cloud/emit.ts — the Devin Cloud per-shell emission plugin.
//
// The packager copies core/ → dist/devin-cloud/.aidlc/ and runs graph compile
// there; emit() then produces the surfaces that are structural code, not
// declarative data — following the copilot/codex idiom:
//   - .agents/skills/ — the COMPLETE skill tree (orchestrator + generated
//     stage/scope runners + session skills). Devin Cloud discovers committed
//     skills ONLY at .agents/skills/<name>/SKILL.md (documented), so the
//     standard <harnessDir>/skills/ runner-gen step is skipped in the manifest.
//   - AGENTS.md skill-path rewrite — the onboarding skeleton names skills
//     under <harnessDir>/skills/; Cloud never reads that path, so the emitted
//     file points at .agents/skills/ instead (the one permitted transform
//     class, same as copilot's .github/skills/ rewrite).
//
// NO hook wiring is emitted anywhere: Devin Cloud sessions have no repo-local
// hook transport. Enforcement is cooperative — the orchestrator invokes the
// engine tools directly and the doctor reports missing gate checkpoints.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { EmitContext } from "../../scripts/manifest-types.ts";

export default function emit(ctx: EmitContext): void {
  const { coreRoot, harnessRoot, distRoot, harnessDir, substituteToken } = ctx;
  const SKILLS_DST = join(distRoot, ".agents", "skills");

  // Compose runner-gen's render fns under the manifest harnessDir, loading the
  // module FROM THE ASSEMBLED DIST TREE (graph compile already wrote
  // tools/data/stage-graph.json there; core/ carries no compiled JSON).
  process.env.AIDLC_HARNESS_DIR = harnessDir;
  process.env.AIDLC_HARNESS_NAME = "devin-cloud";
  const gen = require(join(distRoot, harnessDir, "tools", "aidlc-runner-gen.ts")) as {
    runnableStages: () => Array<{ slug: string }>;
    renderStageRunner: (node: { slug: string }) => string;
    renderInitRunner: () => string;
    renderComposeRunner: () => string;
    defaultScopeBatch: (
      discovered?: Record<string, { name: string; description: string }>,
    ) => string[];
    discoverScopes: () => Record<string, { name: string; description: string }>;
    renderRunner: (scope: string, description: string) => string;
  };

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  }

  const emissions: Array<{ path: string; content: () => string }> = [];

  // The packager rendered AGENTS.md (onboarding) before emit runs; its skeleton
  // names skills under <harnessDir>/skills/, but Cloud discovers skills ONLY at
  // .agents/skills/. Rewrite the path family in place.
  const agentsMdPath = join(distRoot, "AGENTS.md");
  if (existsSync(agentsMdPath)) {
    emissions.push({
      path: agentsMdPath,
      content: () => {
        let value = readFileSync(agentsMdPath, "utf-8").replaceAll(
          `${harnessDir}/skills/`,
          ".agents/skills/",
        );
        // Two hook-transport bullets in the shared template are false on
        // Cloud: nothing runs hooks automatically. The hook-permissions line
        // is replaced by the cooperative-enforcement note; the structure
        // bullet is reworded so the projected hooks/ dir is described as
        // engine scripts invoked explicitly, never as a host wiring.
        value = value.replace(
          /\n- \*\*Hook permissions\*\*:[^\n]*\n/,
          "\n- **No host hooks**: Devin Cloud has no repo-local hook transport — no tool call is intercepted. Enforcement is cooperative: engine calls verify state at each transition and `--doctor` scans the audit trail for bypassed gate checkpoints.\n",
        );
        value = value.replace(
          /- \*\*Hooks\*\*: `\.aidlc\/hooks\/`:[^\n]*/,
          "- **Engine scripts**: `.aidlc/hooks/` — engine-side scripts the conductor invokes explicitly (for example `aidlc-session-start.ts`, run once at session start to mint the AIDLC session record). Nothing runs them automatically on this harness. All framework files prefixed `aidlc-*.ts`.",
        );
        return value;
      },
    });
  }

  // (a) authored orchestrator skill + its question annex — token-substituted
  // from harness/devin-cloud/skills/aidlc/.
  for (const f of ["SKILL.md", "question-rendering.md"]) {
    emissions.push({
      path: join(SKILLS_DST, "aidlc", f),
      content: () =>
        substituteToken(readFileSync(join(harnessRoot, "skills", "aidlc", f), "utf-8")),
    });
  }

  // (b) stage runners + init + compose, generated.
  for (const node of gen.runnableStages()) {
    emissions.push({
      path: join(SKILLS_DST, `aidlc-${node.slug}`, "SKILL.md"),
      content: () => gen.renderStageRunner(node),
    });
  }
  emissions.push({
    path: join(SKILLS_DST, "aidlc-init", "SKILL.md"),
    content: () => gen.renderInitRunner(),
  });
  emissions.push({
    path: join(SKILLS_DST, "aidlc-compose", "SKILL.md"),
    content: () => gen.renderComposeRunner(),
  });

  // (c) default-batch scope runners.
  const scopes = gen.discoverScopes();
  for (const scope of gen.defaultScopeBatch(scopes).filter((s) => s in scopes)) {
    emissions.push({
      path: join(SKILLS_DST, `aidlc-${scope}`, "SKILL.md"),
      content: () => gen.renderRunner(scope, scopes[scope].description),
    });
  }

  // (d) standalone core skills — copied with token substitution.
  for (const skill of ["aidlc-session-cost", "aidlc-replay", "aidlc-outcomes-pack", "aidlc-knowledge"]) {
    const srcDir = join(coreRoot, "skills", skill);
    if (!existsSync(srcDir)) continue;
    for (const file of walk(srcDir)) {
      const rel = relative(srcDir, file);
      emissions.push({
        path: join(SKILLS_DST, skill, rel),
        content: () => substituteToken(readFileSync(file, "utf-8")),
      });
    }
  }

  // Clean-sweep the emitted tree so a removed runner cannot linger. In --check
  // mode the packager supplies an isolated distRoot and compares the complete
  // generated tree with the independently generated counterpart.
  rmSync(SKILLS_DST, { recursive: true, force: true });
  for (const { path, content } of emissions) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content(), "utf-8");
  }
}
