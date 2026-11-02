import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function block(ts: string, event: string | null, fields: Record<string, string> = {}, heading = "Entry"): string {
  const lines = [`## ${heading}`, `**Timestamp**: ${ts}`];
  if (event) lines.push(`**Event**: ${event}`);
  for (const [k, v] of Object.entries(fields)) lines.push(`**${k}**: ${v}`);
  return `\n${lines.join("\n")}\n\n---\n`;
}
export const AUDIT_HEADER = "# AI-DLC Audit Log\n";

export interface FixtureOpts { audit?: string; extraShard?: string; state?: string; withLedger?: boolean; questions?: Record<string, string>; directive?: object | null; engineDirective?: object }

export const STATE_MD = `# AI-DLC State Tracking
## Project Information
- **Project**: Synthetic demo
- **Scope**: demo-scope
- **Start Date**: 2026-08-11T21:46:00Z
## Scope Configuration
- **Depth**: Standard
## Stage Progress
- [x] workspace-scaffold — EXECUTE
- [x] intent-capture — EXECUTE
- [ ] market-research — SKIP
- [x] feasibility — EXECUTE
- [-] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] code-generation — EXECUTE
## Current Status
- **Current Stage**: functional-design
- **Status**: Running
`;

export const GRAPH = [
  { slug: "workspace-scaffold", name: "Workspace Scaffold", phase: "initialization", lead_agent: "orchestrator", number: 1 },
  { slug: "intent-capture", name: "Intent Capture & Framing", phase: "ideation", lead_agent: "aidlc-product-agent", number: 2 },
  { slug: "market-research", name: "Market Research", phase: "ideation", lead_agent: "aidlc-product-agent", number: 3 },
  { slug: "feasibility", name: "Feasibility & Constraints", phase: "ideation", lead_agent: "aidlc-architect-agent", number: 4 },
  { slug: "functional-design", name: "Functional Design", phase: "construction", lead_agent: "aidlc-architect-agent", number: 5 },
  { slug: "nfr-requirements", name: "NFR Requirements", phase: "construction", lead_agent: "aidlc-architect-agent", number: 6 },
  { slug: "code-generation", name: "Code Generation", phase: "construction", lead_agent: "aidlc-developer-agent", number: 7 },
];

export const DEFAULT_AUDIT = AUDIT_HEADER
  + block("2026-08-11T21:46:00Z", "STAGE_STARTED", { Stage: "intent-capture" })
  + block("2026-08-11T22:08:12Z", "REVIEW_COMPLETED", { Stage: "intent-capture", Verdict: "READY", Reviewer: "aidlc-product-lead-agent", Iteration: "1" })
  + block("2026-08-11T22:27:00Z", "WORKFLOW_PARKED", { Stage: "intent-capture" })
  + block("2026-08-12T16:50:00Z", "WORKFLOW_UNPARKED", {})
  + block("2026-08-12T16:54:00Z", "STAGE_JUMPED", { Direction: "backward", Target: "intent-capture" })
  + block("2026-08-12T16:54:00Z", "STAGE_STARTED", { Stage: "intent-capture" })
  + block("2026-08-12T17:13:18Z", "GATE_APPROVED", { Stage: "intent-capture", "User Input": "Approve" })
  + block("2026-08-12T17:13:18Z", "STAGE_COMPLETED", { Stage: "intent-capture", "Tokens In": "58502812", "Tokens Out": "105238" })
  + block("2026-08-12T17:13:20Z", "STAGE_STARTED", { Stage: "feasibility" })
  + block("2026-08-12T17:39:00Z", "GATE_APPROVED", { Stage: "feasibility" })
  + block("2026-08-12T17:39:00Z", "STAGE_COMPLETED", { Stage: "feasibility" })
  + block("2026-08-12T22:22:00Z", "STAGE_STARTED", { Stage: "functional-design" })
  + block("2026-08-12T22:34:00Z", "UNIT_STARTED", { Stage: "functional-design", Unit: "alpha" })
  + block("2026-08-12T22:57:00Z", "REVIEW_COMPLETED", { Stage: "functional-design", Unit: "alpha", Verdict: "READY" })
  + block("2026-08-12T22:57:00Z", "UNIT_COMPLETED", { Stage: "functional-design", Unit: "alpha" })
  + block("2026-08-13T18:27:00Z", "REVIEW_COMPLETED", { Stage: "code-generation", Unit: "alpha", Verdict: "READY" })
  + block("2026-08-13T23:19:33Z", "UNIT_STARTED", { Stage: "code-generation", Unit: "beta" })
  + block("2026-08-13T23:20:00Z", "ARTIFACT_CREATED", { File: "/Users/someone/elsewhere/proj/aidlc/spaces/default/intents/260811-demo/construction/beta/code-generation/code-generation-plan.md", Tool: "Write" });

export async function makeWorkspace(o: FixtureOpts = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cc-ws-"));
  const rec = join(root, "aidlc/spaces/default/intents/260811-demo");
  await mkdir(join(rec, "audit"), { recursive: true });
  await mkdir(join(root, ".claude/tools/data"), { recursive: true });
  await writeFile(join(root, ".claude/tools/data/stage-graph.json"), JSON.stringify(GRAPH));
  await writeFile(join(root, "aidlc/spaces/default/intents/intents.json"), JSON.stringify([{ uuid: "u-1", slug: "demo", dirName: "260811-demo", scope: "demo-scope", status: "in-flight" }]));
  await writeFile(join(rec, "aidlc-state.md"), o.state ?? STATE_MD);
  await writeFile(join(rec, "audit/hosta-aaaaaaaaaaaa.md"), o.audit ?? DEFAULT_AUDIT);
  if (o.extraShard) await writeFile(join(rec, "audit/hostb-bbbbbbbbbbbb.md"), o.extraShard);
  if (o.directive !== null) await writeFile(join(rec, ".aidlc-active-directive.json"), JSON.stringify(o.directive ?? { version: 1, stage: "code-generation", unit: "beta" }));
  if (o.engineDirective) { await mkdir(join(rec, ".aidlc-engine"), { recursive: true }); await writeFile(join(rec, ".aidlc-engine/active-directive.json"), JSON.stringify(o.engineDirective)); }
  for (const [rel, body] of Object.entries(o.questions ?? {})) { await mkdir(join(rec, rel, ".."), { recursive: true }); await writeFile(join(rec, rel), body); }
  await mkdir(join(rec, "construction/beta/code-generation"), { recursive: true });
  await writeFile(join(rec, "construction/beta/code-generation/code-generation-plan.md"), "# Plan\n");
  await mkdir(join(root, "aidlc/spaces/default/memory"), { recursive: true });
  await writeFile(join(root, "aidlc/spaces/default/memory/project.md"), "## Corrections\n- Never invent a metric (learned 2026-08-12) <!-- cid:intent-capture:c7 -->\n- Ask the blocking question first (learned 2026-08-12) <!-- cid:feasibility:c4 -->\n");
  if (o.withLedger !== false) {
    await mkdir(join(root, "aidlc/.aidlc-sessions"), { recursive: true });
    const t = (i: number, out: number) => ({ tokens: { input: i, output: out, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 }, usd: 1 });
    await writeFile(join(root, "aidlc/.aidlc-sessions/usage-ledger.json"), JSON.stringify({ schemaVersion: 3, workflows: { "intent:u-1": { totals: t(1000, 10), byStage: { "intent-capture": { totals: t(600, 6) }, "functional-design": { totals: t(400, 4) } }, byModel: { "opus-5": t(1000, 10) }, byAgent: { main: t(1000, 10) } } } }));
  }
  return root;
}
