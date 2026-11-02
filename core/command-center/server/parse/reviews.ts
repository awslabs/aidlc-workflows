import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
export interface Finding { severity: string; location: string; finding: string; status: string | null }
export interface ReviewRecord { stage: string; unit: string | null; iteration: number; reviewer: string; verdict: string; findings: Finding[]; recordedAt: string | null }
export function parseEmbeddedReview(md: string): { verdict: string; reviewer: string | null; iteration: number | null; findings: Finding[] } | null {
  const heads = [...md.matchAll(/^## Review[ \t]*$/gm)];
  const last = heads[heads.length - 1]; if (!last) return null;
  const rest = md.slice(last.index! + last[0].length);
  const next = rest.search(/^## /m);
  const sec = next < 0 ? rest : rest.slice(0, next);
  const get = (k: string) => sec.match(new RegExp(`\\*\\*${k}:?\\*\\*:?\\s*(.+)`))?.[1]?.trim() ?? null;
  const verdict = get("Verdict"); if (!verdict) return null;
  const findings: Finding[] = [];
  for (const row of sec.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l))) {
    const c = row.split("|").slice(1, -1).map((s) => s.trim());
    if (/^(NOT-)?RESOLVED$/i.test(c[2] ?? "")) findings.push({ severity: c[1] ?? "", location: "", finding: c[3] ?? "", status: c[2]!.toUpperCase() });
    else if (/^(Critical|Major|Minor)$/i.test(c[1] ?? "")) findings.push({ severity: c[1]!, location: c[2] ?? "", finding: c[3] ?? "", status: null });
  }
  const it = get("Iteration");
  return { verdict, reviewer: get("Reviewer"), iteration: it ? Number(it) : null, findings };
}
export async function readReviewRecords(recordDir: string): Promise<ReviewRecord[]> {
  const base = join(recordDir, ".aidlc-engine/reviews"); const out: ReviewRecord[] = [];
  async function walk(d: string): Promise<void> {
    let ents: Dirent[]; try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".json")) { // symlinked records are not followed
        try { const r = JSON.parse(await Bun.file(p).text()); out.push({ stage: r.stage, unit: r.unit ?? null, iteration: r.iteration ?? 0, reviewer: r.reviewer ?? "", verdict: r.verdict ?? "", recordedAt: r.recorded_at ?? null, findings: (r.findings ?? []).map((f: { severity?: string; location?: string; finding?: string; status?: string }) => ({ severity: f.severity ?? "", location: f.location ?? "", finding: f.finding ?? "", status: f.status ?? null })) }); } catch { /* skip */ }
      }
    }
  }
  await walk(base); return out;
}
