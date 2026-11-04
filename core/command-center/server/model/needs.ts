import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { contain } from "../paths";
import type { AuditEvent, NeedItem } from "../types";
import { parseQuestions } from "../parse/questions";
export async function deriveNeeds(recordDir: string, events: AuditEvent[], current: { stage: string | null; unit: string | null }, phaseDirOf: (stage: string) => string, directive?: { stage: string | null; unit: string | null; kind: string | null; askType?: string | null; mtime: string | null }, aidlcRoot = resolve(recordDir, "../../../..")): Promise<NeedItem[]> {
  const needs: NeedItem[] = [];
  // open gates: STAGE_AWAITING_APPROVAL closed by a later GATE_* (unit-tolerant) or stage progression
  let open: AuditEvent[] = [];
  const stageOf = (e: AuditEvent) => e.fields.Stage ?? e.fields["Stage slug"] ?? "";
  for (const e of events) {
    const st = stageOf(e);
    if (e.event === "STAGE_AWAITING_APPROVAL") open.push(e);
    else if (e.event === "GATE_APPROVED" || e.event === "GATE_REJECTED") {
      open = open.filter((o) => !(stageOf(o) === st && (!o.fields.Unit || !e.fields.Unit || o.fields.Unit === e.fields.Unit)));
    } else if (e.event === "STAGE_COMPLETED" || e.event === "STAGE_STARTED") {
      open = open.filter((o) => stageOf(o) !== st);
    } else if (e.event === "STAGE_JUMPED") {
      const targets = [e.fields.Stage, e.fields["Stage slug"], e.fields.Target];
      open = open.filter((o) => !targets.includes(stageOf(o)));
    }
  }
  for (const e of open) needs.push({ kind: "gate", stage: stageOf(e), unit: e.fields.Unit ?? null, since: e.ts, detail: "Gate open - approval needed" });
  if (current.stage) {
    const rel = current.unit ? join("construction", current.unit, current.stage) : join(phaseDirOf(current.stage), current.stage);
    // Contained in <root>/aidlc: a symlinked questions file escaping the workspace is treated as absent.
    const qf = await contain(aidlcRoot, join(recordDir, rel, `${current.stage}-questions.md`));
    const f = qf ? Bun.file(qf) : null;
    if (qf && f && await f.exists()) {
      const q = parseQuestions(await f.text());
      const blank = q.questions.filter((x) => x.answer === null);
      if (blank.length) needs.push({ kind: "question", stage: current.stage, unit: current.unit, since: new Date((await stat(qf)).mtimeMs).toISOString().replace(/\.\d+Z$/, "Z"), detail: `${blank.length} question${blank.length > 1 ? "s" : ""} waiting` });
    }
  }
  // Plan Approval is an ask whose ask_type says so; classify it before generic asks.
  const dk = directive?.kind === "ask" && directive.askType === "plan-approval" ? "plan" : directive?.kind === "ask" ? "question" : directive?.kind === "present-gate" ? "gate" : null;
  if (directive && dk && directive.stage && !needs.some((n) => n.kind === dk && n.stage === directive.stage && n.unit === directive.unit)) {
    needs.push({ kind: dk, stage: directive.stage, unit: directive.unit, since: directive.mtime, detail: dk === "question" ? "Agent is asking a question" : dk === "gate" ? "Gate presented - approval needed" : "Plan awaiting approval" });
  }
  return needs;
}
