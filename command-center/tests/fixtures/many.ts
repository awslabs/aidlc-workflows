// Test-only: several synthetic workspaces holding 20 intents in every Home status (waiting, active, idle,
// ended, done, archived), timestamped relative to `now` so liveness is real when the smoke run screenshots them.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_HEADER, block, GRAPH } from "./make";

type Live = "active" | "idle" | "ended";
interface Spec { slug: string; done: number; skip?: string[]; unit?: string; gate?: boolean; live: Live; ago: number; status?: string; tokens?: number; title?: string }

const SLUGS = GRAPH.map((g) => g.slug);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

function stateMd(s: Spec, title: string): string {
  const plan = SLUGS.filter((x) => !s.skip?.includes(x));
  const cur = plan[s.done] ?? null;
  const rows = SLUGS.map((slug) => {
    if (s.skip?.includes(slug)) return `- [ ] ${slug} — SKIP`;
    const ix = plan.indexOf(slug);
    return `- [${ix < s.done ? "x" : slug === cur ? "-" : " "}] ${slug} — EXECUTE`;
  });
  return `# AI-DLC State Tracking\n## Project Information\n- **Project**: ${title}\n- **Scope**: synthetic\n## Stage Progress\n${rows.join("\n")}\n## Current Status\n- **Current Stage**: ${cur ?? plan.at(-1)}\n`;
}

function audit(s: Spec, now: number): string {
  const plan = SLUGS.filter((x) => !s.skip?.includes(x));
  const last = now - s.ago * 60_000;
  // Completed stages run two hours apart and finish at least an hour before the tail starts.
  let t = last - (2 * s.done + 2) * 2 * 3_600_000;
  const at = () => iso((t += 2 * 3_600_000));
  let out = AUDIT_HEADER;
  for (const slug of plan.slice(0, s.done)) { out += block(at(), "STAGE_STARTED", { Stage: slug }) + block(at(), "STAGE_COMPLETED", { Stage: slug }); }
  const cur = plan[s.done];
  const tail: [string, Record<string, string>][] = [];
  if (cur) {
    tail.push(["STAGE_STARTED", { Stage: cur }]);
    if (s.unit) tail.push(["UNIT_STARTED", { Stage: cur, Unit: s.unit }]);
    if (s.gate) tail.push(["STAGE_AWAITING_APPROVAL", { Stage: cur, ...(s.unit ? { Unit: s.unit } : {}) }]);
  }
  if (s.live === "ended") tail.push(["SESSION_ENDED", {}]);
  if (!tail.length) tail.push(["WORKFLOW_COMPLETED", {}]);
  // The tail ends exactly at `last`, one minute apart.
  tail.forEach(([ev, f], ix) => { out += block(iso(last - (tail.length - 1 - ix) * 60_000), ev, f); });
  return out;
}

async function workspace(parent: string, label: string, specs: Spec[], now: number): Promise<string> {
  const root = join(parent, label);
  await mkdir(join(root, ".claude/tools/data"), { recursive: true });
  await writeFile(join(root, ".claude/tools/data/stage-graph.json"), JSON.stringify(GRAPH));
  const intents = join(root, "aidlc/spaces/default/intents");
  const reg: object[] = []; const ledger: Record<string, object> = {};
  for (const [ix, s] of specs.entries()) {
    const dir = `2608${String(10 + ix).padStart(2, "0")}-${s.slug}`; const uuid = `${label}-${ix}`;
    reg.push({ uuid, slug: s.slug, dirName: dir, scope: "synthetic", status: s.status ?? "in-flight" });
    await mkdir(join(intents, dir, "audit"), { recursive: true });
    await writeFile(join(intents, dir, "aidlc-state.md"), stateMd(s, s.title ?? `Synthetic ${s.slug.replace(/-/g, " ")}`));
    await writeFile(join(intents, dir, "audit/hosta-aaaaaaaaaaaa.md"), audit(s, now));
    if (s.tokens) {
      const t = { tokens: { input: s.tokens, output: Math.round(s.tokens / 200), cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 }, usd: 0 };
      ledger[`intent:${uuid}`] = { totals: t, byStage: {}, byModel: { "model-a": t }, byAgent: { main: t } };
    }
  }
  await writeFile(join(intents, "intents.json"), JSON.stringify(reg));
  await mkdir(join(root, "aidlc/spaces/default/memory"), { recursive: true });
  await writeFile(join(root, "aidlc/spaces/default/memory/project.md"), "## Corrections\n- Name the owner of every open question (learned 2026-08-20) <!-- cid:feasibility:c1 -->\n");
  if (Object.keys(ledger).length) {
    await mkdir(join(root, "aidlc/.aidlc-sessions"), { recursive: true });
    await writeFile(join(root, "aidlc/.aidlc-sessions/usage-ledger.json"), JSON.stringify({ schemaVersion: 3, workflows: ledger }));
  }
  return root;
}

/** Three workspaces (8 + 7 + 5 = 20 intents) plus one pinned folder that no longer exists. Returns the pin list. */
export async function makeManyWorkspaces(now = Date.now()): Promise<string[]> {
  const parent = await mkdtemp(join(tmpdir(), "cc-many-"));
  const all = SLUGS.length;
  const a = await workspace(parent, "payments", [
    { slug: "refund-flow", done: 3, gate: true, live: "idle", ago: 42, tokens: 3_400_000 },
    { slug: "ledger-export", done: 4, unit: "exporter", live: "active", ago: 0, tokens: 12_800_000 },
    { slug: "card-vault", done: 5, unit: "tokenizer", gate: true, live: "idle", ago: 95 },
    { slug: "fx-rates", done: 2, skip: ["market-research"], live: "idle", ago: 300, tokens: 900_000 },
    { slug: "chargebacks", done: 1, live: "ended", ago: 1440 },
    { slug: "invoice-pdf", done: all - 1, skip: ["market-research"], live: "ended", ago: 4320, status: "complete", tokens: 22_100_000 },
    { slug: "payout-schedule", done: all, live: "ended", ago: 9000, status: "archived" },
    { slug: "tax-lines", done: 3, live: "idle", ago: 60 * 30 },
  ], now);
  const b = await workspace(parent, "search-ranking", [
    { slug: "query-rewrite", done: 4, unit: "parser", live: "active", ago: 0, tokens: 5_600_000 },
    { slug: "synonyms", done: 2, gate: true, live: "idle", ago: 12 },
    { slug: "click-model", done: 5, unit: "trainer", live: "idle", ago: 200 },
    { slug: "facet-counts", done: 1, live: "idle", ago: 20 },
    { slug: "spell-check", done: all - 1, skip: ["market-research"], live: "ended", ago: 2000, status: "complete" },
    { slug: "autocomplete", done: 3, live: "ended", ago: 700 },
    { slug: "ranking-eval", done: 6, unit: "harness", live: "active", ago: 1, tokens: 48_000_000 },
  ], now);
  const c = await workspace(parent, "onboarding", [
    { slug: "welcome-email", done: 2, live: "idle", ago: 400 },
    { slug: "sso-setup", done: 3, gate: true, live: "idle", ago: 180 },
    { slug: "profile-wizard", done: all - 1, skip: ["market-research"], live: "ended", ago: 5000, status: "complete" },
    { slug: "team-invites", done: 0, live: "idle", ago: 900 },
    { slug: "checklist", done: 4, unit: "ui", live: "ended", ago: 260 },
  ], now);
  return [a, b, c, join(parent, "moved-project")];
}
