import { basename, join } from "node:path";
import type { Found } from "../discovery";
import type { CatalogStage, HomePayload, IntentModel, IntentSummary, PhaseKey, WorkspaceSummary } from "../types";
import { listIntents } from "../parse/registry";
import { loadCatalog } from "../parse/stage-graph";
import { parseLearnings } from "../parse/learnings";
import { buildIntent } from "./intent";
import { contain } from "../paths";
import { cachedHealth, healthCounts, type HealthOpts } from "../health";
const PHASES: PhaseKey[] = ["initialization", "ideation", "inception", "construction", "operation"];
export function summarize(m: IntentModel): IntentSummary {
  const { events: _e, stages, hiddenCounts: _h, ...rest } = m;
  return { ...rest, phases: PHASES.map((key) => { const s = stages.filter((x) => x.phase === key); return { key, done: s.filter((x) => x.state === "done").length, planned: s.filter((x) => x.planned).length, skipped: s.filter((x) => !x.planned).length }; }) };
}
async function rules(root: string, space: string) {
  const dir = join(root, "aidlc/spaces", space, "memory"); const files: Record<string, string> = {};
  for (const f of ["org.md", "team.md", "project.md"]) {
    const p = await contain(join(root, "aidlc"), join(dir, f)); if (!p) continue;
    try { files[f] = await Bun.file(p).text(); } catch { /* none */ }
  }
  return parseLearnings(files);
}
/** `health`: options for the "Needs fixing" counts; omitted, the counts are computed with every opt-in off. */
export async function buildHome(found: Found[], now = new Date(), health: HealthOpts = {}): Promise<HomePayload> {
  const workspaces: WorkspaceSummary[] = [];
  for (const f of found) {
    const base: WorkspaceSummary = { path: f.path, label: basename(f.path), origin: f.origin, root: f.root, status: "ok", problem: null, intents: [], rulesLearned: 0, sampleRule: null };
    if (!f.exists) { workspaces.push({ ...base, status: "missing", problem: "Folder not found" }); continue; }
    const cat = await loadCatalog(f.path); const refs = await listIntents(f.path);
    if (!refs.length) { workspaces.push({ ...base, status: "empty", problem: "Initialized, no intents yet" }); continue; }
    const intents: IntentSummary[] = []; let partial = false;
    for (const r of refs) { try { intents.push(summarize(await buildIntent(f.path, r, cat.stages, now))); } catch { partial = true; } }
    const rl = await rules(f.path, refs[0]!.space);
    workspaces.push({ ...base, status: partial ? "partial" : "ok", problem: partial ? "Some intents could not be read" : cat.source ? null : "No stage graph found - phases unknown", intents, rulesLearned: rl.length, sampleRule: rl[0]?.text ?? null });
  }
  const needs = workspaces.flatMap((w) => w.intents.flatMap((i) => i.needs.map((n) => ({ ...n, intent: `${w.path}::${i.key}`, intentName: i.name })))).sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  let counts: HomePayload["health"];
  try { counts = healthCounts(await cachedHealth(found, now, health)); } catch (e) { console.error("[command-center] health counts could not be built:", e); }
  return { workspaces, needs, generatedAt: now.toISOString(), ...(counts ? { health: counts } : {}) };
}
export type { CatalogStage };
