import { join } from "node:path";
import type { CatalogStage, PhaseKey } from "../types";
import { contain } from "../paths";
const HARNESS_DIRS = [".claude", ".kiro", ".codex", ".cursor", ".aidlc", ".opencode", ".github"];
const PHASES: PhaseKey[] = ["initialization", "ideation", "inception", "construction", "operation"];
export async function loadCatalog(projectRoot: string): Promise<{ stages: CatalogStage[]; source: string | null }> {
  for (const h of HARNESS_DIRS) {
    const p = join(projectRoot, h, "tools/data/stage-graph.json");
    const real = await contain(projectRoot, p); if (!real) continue; // absent, or resolves outside the workspace
    const f = Bun.file(real);
    try {
      const raw = JSON.parse(await f.text()) as { slug: string; name?: string; phase?: string; lead_agent?: string; number?: number }[];
      return { source: p, stages: raw.map((s, i) => ({ slug: s.slug, name: s.name ?? s.slug, phase: (PHASES as string[]).includes(s.phase ?? "") ? (s.phase as PhaseKey) : "unknown", lead: (s.lead_agent ?? "orchestrator").replace(/^aidlc-|-agent$/g, ""), order: s.number ?? i })) };
    } catch { /* malformed: try next */ }
  }
  return { stages: [], source: null };
}
export function phaseOf(stages: CatalogStage[], slug: string): PhaseKey { return stages.find((s) => s.slug === slug)?.phase ?? "unknown"; }
