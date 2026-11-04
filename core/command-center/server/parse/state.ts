import type { PlanRow } from "../types";
const FIELD = /^- \*\*([^*]+)\*\*:\s*(.*)$/;
const PLAN = /^- \[(.)\] ([a-z0-9-]+)\s+—\s+(EXECUTE|SKIP)\b/;
export function parseState(md: string): { fields: Record<string, string>; plan: PlanRow[] } {
  const fields: Record<string, string> = {}; const plan: PlanRow[] = [];
  for (const line of md.split(/\r?\n/)) {
    const p = line.match(PLAN);
    if (p) { plan.push({ slug: p[2]!, mark: p[1]!, disposition: p[3] as "EXECUTE" | "SKIP" }); continue; }
    const f = line.match(FIELD);
    if (f && !(f[1]! in fields)) fields[f[1]!.trim()] = f[2]!.trim();
  }
  return { fields, plan };
}
