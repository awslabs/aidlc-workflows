import { join } from "node:path";
import type { Recorded, Tokens } from "../types";
type LT = { tokens?: { input?: number; output?: number; cacheRead?: number; cacheCreate5m?: number; cacheCreate1h?: number } };
const tok = (t?: LT): Tokens => ({ input: t?.tokens?.input ?? 0, output: t?.tokens?.output ?? 0, cacheRead: t?.tokens?.cacheRead ?? 0, cacheWrite: (t?.tokens?.cacheCreate5m ?? 0) + (t?.tokens?.cacheCreate1h ?? 0) });
const map = (o?: Record<string, LT>) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, tok(v)]));
export async function readLedgerTokens(projectRoot: string, uuid: string | null): Promise<Recorded<{ totals: Tokens; byStage: Record<string, Tokens>; byModel: Record<string, Tokens>; byAgent: Record<string, Tokens> }>> {
  const f = Bun.file(join(projectRoot, "aidlc/.aidlc-sessions/usage-ledger.json"));
  if (!(await f.exists())) return { recorded: false, reason: "This harness records no token usage (no usage ledger)." };
  try {
    const l = JSON.parse(await f.text());
    const w = uuid ? l.workflows?.[`intent:${uuid}`] : undefined;
    if (!w) return { recorded: false, reason: "No token entry for this intent in the usage ledger." };
    const byStage = Object.fromEntries(Object.entries(w.byStage ?? {}).map(([k, v]) => [k, tok((v as { totals: LT }).totals)]));
    return { recorded: true, value: { totals: tok(w.totals), byStage, byModel: map(w.byModel), byAgent: map(w.byAgent) } };
  } catch { return { recorded: false, reason: "Usage ledger could not be read." }; }
}
