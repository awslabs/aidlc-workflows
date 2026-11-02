import { useMemo, useState, type ReactNode } from "react";
import type { AuditEvent } from "../../../../core/command-center/server/types";
import { fmtTime, phaseName } from "../format";
import { inScope, lensVersion, openArtifact, phaseOf, useLens, type XLensProps } from "./common";
import { inline } from "./markdown";

interface Question { id: string; title: string; prompt: string; options: { key: string; text: string }[]; answer: string | null; answers: string[]; answerText: string | null }
interface Group { stage: string; unit: string | null; file: string; when: string | null; context: string[]; questions: Question[]; gate: (AuditEvent & { kind: "gate" | "plan" }) | null }
/** One question an agent asked in a batch: every option it offered, and which of them the recorded answer chose. */
interface DecisionQuestion { id: string; title: string; options: string[]; answer: string[] | null; answerRaw: string | null }
interface AgentDecision {
  ts: string; stage: string | null; unit: string | null; decision: string; answerText: string | null;
  /** Pieces of the recorded answer no question took; `unresolved`: an answer exists that is no single ask's; */
  unassigned?: string[]; unresolved?: boolean;
  /** …and those answers themselves, carried once per run of asks so they are shown without being attributed. */
  strayAnswers?: string[]; questions: DecisionQuestion[];
}
export interface DecisionsPayload { groups: Group[]; agentDecisions: AgentDecision[] }

const WaitPill = () => <span className="chip" style={{ background: "var(--waitbg)", color: "var(--wait)", borderColor: "var(--wait)", fontWeight: 600 }}>? Waiting on you</span>;
/** What a person actually typed, shown verbatim because no option could be marked for it with any certainty. */
const Recorded = ({ label, text }: { label: string; text: string }) =>
  <div className="opt" style={{ borderStyle: "dashed" }} title="Recorded verbatim: it could not be matched to an option with certainty"><span><i>{label}:</i> {inline(text)}</span></div>;

type Chip = "all" | "questions" | "gates" | "plans" | "agent" | "other";

/** The audit entry that closed a questions file: a gate verdict or a plan approval. */
function Closer({ g }: { g: NonNullable<Group["gate"]> }) {
  const f = g.fields; const when = <span className="dim" title={g.ts}> · {fmtTime(g.ts)}</span>;
  if (g.kind === "plan") {
    const over = g.event === "PLAN_APPROVAL_OVERRIDDEN";
    return <div className="q" style={{ borderLeft: `3px solid var(--${over ? "wait" : "ok"})` }}><b className={over ? "wait" : "ok"}>◇ {over ? "Plan approval overridden" : "Plan approved"}</b>{f.Decision || f["User Input"] ? <span className="dim"> — {f.Decision ?? f["User Input"]}</span> : null}{when}</div>;
  }
  if (g.event === "GATE_REJECTED") return <div className="q" style={{ borderLeft: "3px solid var(--bad)" }}><b className="bad">↺ Rejected</b>{f.Feedback ? <> — {f.Feedback}</> : <span className="dim"> — no feedback recorded</span>}{when}</div>;
  const said = f["User Input"] && !/^approve$/i.test(f["User Input"].trim()) ? f["User Input"] : null;
  return <div className="q" style={{ borderLeft: "3px solid var(--ok)" }}><b className="ok">◆ Approved by you</b>{said ? <span className="dim"> — “{said}”</span> : null}{when}</div>;
}

/** One question from a questions file. A "(select all that apply)" answer marks every key it names. */
export function Card({ q, open, onToggle }: { q: Question; open: boolean; onToggle: () => void }) {
  const keys = q.answers?.length ? q.answers : q.answer ? [q.answer] : [];
  const chosen = q.options.filter((o) => keys.includes(o.key));
  const waiting = q.answer === null;
  const pill = waiting ? <WaitPill /> : null;
  const title = <b>{q.id}{q.title ? ` — ${q.title}` : ""}</b>;
  const otherText = (o: { key: string; text: string }) => (keys.includes(o.key) && o.key === "X" && q.answerText ? q.answerText : null);
  if (!open) {
    return (
      <div className="q">
        <div className="qh" role="button" tabIndex={0} aria-expanded={false} onClick={onToggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
          <span>{title} &nbsp;{waiting ? pill
            : chosen.length ? <><span className="ok">✓ {chosen.map((o) => o.key).join(", ")}</span> {inline(chosen.map((o) => otherText(o) ?? o.text).join(" · "))}</>
            : <span className="wait" title="The [Answer] does not match any listed option">answer “{q.answer}” (not a listed option)</span>}</span>
          <span className="dim" style={{ flex: "none" }}>{waiting ? `${q.options.length} options ▾` : `+${Math.max(0, q.options.length - chosen.length)} other options ▾`}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="q">
      <div className="qh" role="button" tabIndex={0} aria-expanded onClick={onToggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <span>{title}</span><span className="row" style={{ flex: "none" }}>{pill}<span className="dim mono">{q.options.length} options ▴</span></span>
      </div>
      {q.prompt && <div className="dim" style={{ fontSize: ".88rem", margin: "4px 0 6px" }}>{inline(q.prompt)}</div>}
      {q.options.map((o) => {
        const sel = keys.includes(o.key); const free = otherText(o);
        return (
          <div key={o.key} className={`opt${sel ? " sel" : ""}`}>
            <span className="k">{o.key}</span>
            <span>{inline(o.text)}{free && <><br /><span title="Free-text answer recorded in the questions file">“{inline(free)}”</span></>}</span>
            {sel && <span className="tag">✓ CHOSEN</span>}
          </div>
        );
      })}
      {!waiting && !chosen.length && <div className="opt sel"><span className="k">{q.answer}</span><span>{q.answerText ? inline(q.answerText) : <span className="dim">The recorded answer is not one of the listed options.</span>}</span><span className="tag">✓ CHOSEN</span></div>}
      {/* Free text recorded beside a listed option (`[Answer]: A, B — both apply`) is shown too, never dropped. */}
      {!waiting && chosen.length > 0 && q.answerText && !chosen.some((o) => otherText(o) !== null) && <Recorded label="Recorded answer" text={q.answerText} />}
    </div>
  );
}

/**
 * One DECISION_RECORDED as a card: the label the agent used, every option it offered (per question when it batched
 * several), and the chosen ones marked. Whatever could not be matched to an option — a whole answer that named no
 * question, a piece that named none, a caveat the options do not cover — is shown verbatim instead.
 */
export function AgentCard({ d }: { d: AgentDecision }) {
  const batched = d.questions.length > 1 || !!d.questions[0]?.id;
  // Some (or all) of the answer reached no question: show the whole recorded answer, which includes any loose pieces.
  const whole = d.answerText !== null && d.questions.some((q) => q.answerRaw === null) ? d.answerText : null;
  const loose = whole === null ? d.unassigned ?? [] : [];
  return (
    <div className="q">
      <div className="qh" style={{ cursor: "default" }}>
        <span><b>✎ {inline(d.decision)}</b></span>
        <span className="row" style={{ flex: "none" }}>{d.answerText === null ? <WaitPill /> : null}<span className="dim mono" title={d.ts}>{fmtTime(d.ts)}</span></span>
      </div>
      {d.questions.map((q, i) => (
        <div key={q.id || i} style={batched ? { marginTop: 8 } : undefined}>
          {batched && <div style={{ fontWeight: 600 }}>{q.id}{q.title ? ` — ${q.title}` : ""}</div>}
          {q.options.length
            ? q.options.map((o, j) => {
              const sel = q.answer?.includes(o) ?? false;
              return <div key={j} className={`opt${sel ? " sel" : ""}`}><span>{inline(o)}</span>{sel && <span className="tag">✓ CHOSEN</span>}</div>;
            })
            : <div className="faint" style={{ fontSize: ".88rem" }}>— no options recorded with this decision</div>}
          {q.answer === null && q.answerRaw !== null && <Recorded label="Recorded answer" text={q.answerRaw} />}
        </div>
      ))}
      {whole !== null && <Recorded label="Recorded answer" text={whole} />}
      {/* Keyed by position: two recorded lines can carry the very same text, and both have to show. */}
      {loose.map((p, i) => <Recorded key={`loose${i}`} label="Also recorded" text={p} />)}
      {(d.strayAnswers ?? []).map((p, i) => <Recorded key={`stray${i}`} label="Recorded, not matched to a specific ask" text={p} />)}
      {d.unresolved === true
        ? <div className="faint" style={{ fontSize: ".84rem", marginTop: 4 }}>— an answer was recorded for this stage, but it could not be matched to this ask</div>
        : d.answerText === null && <div className="faint" style={{ fontSize: ".84rem", marginTop: 4 }}>— no answer recorded for this decision yet</div>}
    </div>
  );
}

/** Questions files (stage · unit) with every option, the chosen one marked; gates and plan approvals close each group. */
export function Decisions({ model: m, ws, filter }: XLensProps) {
  const { data, err } = useLens<DecisionsPayload>("decisions", ws, m.key, lensVersion(m));
  const [chip, setChip] = useState<Chip>("all");
  const [exp, setExp] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [showAgent, setShowAgent] = useState(false);

  // Files still waiting on you lead (they have no answer time yet); the rest keep the server's newest-answered-first order.
  const groups = useMemo(() => {
    const gs = (data?.groups ?? []).filter((g) => inScope(m.stages, filter, g.stage, g.unit));
    const waits = (g: Group) => g.questions.some((x) => x.answer === null);
    return [...gs.filter(waits), ...gs.filter((g) => !waits(g))];
  }, [data, m.stages, filter]);
  const agent = useMemo(() => (data?.agentDecisions ?? []).filter((d) => inScope(m.stages, filter, d.stage, d.unit)), [data, m.stages, filter]);
  if (!data) return <div className="dim" data-loaded={err ? "error" : undefined}>{err ? `Could not load decisions — ${err}.` : "Loading decisions…"}</div>;

  const nQ = groups.reduce((a, g) => a + g.questions.length, 0);
  const nGates = groups.filter((g) => g.gate?.kind === "gate").length;
  const nPlans = groups.filter((g) => g.gate?.kind === "plan").length;
  const nOther = groups.reduce((a, g) => a + g.questions.filter((q) => q.answer === "X").length, 0);
  const nWait = groups.reduce((a, g) => a + g.questions.filter((q) => q.answer === null).length, 0);
  const chips: [Chip, string, number | null][] = [["all", "All", null], ["questions", "? Questions", nQ], ["gates", "◆ Gates", nGates], ["plans", "◇ Plan approvals", nPlans], ["agent", "✎ Agent decisions", agent.length], ["other", "“Other” answers only", nOther]];

  const label = (g: { stage: string | null; unit: string | null }) => `${phaseName(phaseOf(m.stages, g.stage))} · ${g.stage ?? "no stage"}${g.unit ? ` · unit ${g.unit}` : ""}`;
  const isOpen = (gi: number, g: Group, q: Question, qi: number) => {
    const k = `${g.file}#${q.id}`;
    if (exp[k] !== undefined) return exp[k]!;
    if (chip === "other") return true;
    return !collapsed && gi === 0 && qi < 2;
  };
  const toggle = (g: Group, q: Question, now: boolean) => setExp((e) => ({ ...e, [`${g.file}#${q.id}`]: !now }));

  const showQ = chip === "all" || chip === "questions" || chip === "other";
  const shown = chip === "gates" ? groups.filter((g) => g.gate?.kind === "gate") : chip === "plans" ? groups.filter((g) => g.gate?.kind === "plan")
    : chip === "other" ? groups.filter((g) => g.questions.some((q) => q.answer === "X")) : chip === "agent" ? [] : groups;

  // Newest ask first, with a stage · unit heading whenever it changes — the same shape as the file-backed groups.
  const agentCards = (() => {
    const out: ReactNode[] = []; let head: string | null = null;
    [...agent].reverse().forEach((d, i) => {
      const l = d.stage ? label(d) : "no stage recorded";
      if (l !== head) { out.push(<div key={`h${i}`} className="grp"><span>{l}</span></div>); head = l; }
      out.push(<AgentCard key={`d${i}`} d={d} />);
    });
    return <>{out}</>;
  })();

  return (
    <div data-loaded="">
      <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        {chips.map(([c, t, n]) => <button key={c} type="button" className={`chip clk${chip === c ? " on" : ""}`} aria-pressed={chip === c} onClick={() => setChip(c)}>{t}{n !== null ? ` ${n}` : ""}</button>)}
        <span className="grow" />
        {nWait > 0 && <span className="wait" style={{ fontWeight: 600 }}>? {nWait} waiting on you</span>}
        {showQ && <button type="button" className="linkbtn" onClick={() => { setExp({}); setCollapsed(true); }}>Collapse to answers</button>}
      </div>
      {chip === "agent" ? (agent.length ? agentCards : <div className="dim">No DECISION_RECORDED entries in this scope.</div>) : null}
      {chip !== "agent" && !shown.length && <div className="dim">{groups.length ? "Nothing in this scope matches this filter." : "No questions files in this scope."}</div>}
      {shown.map((g, gi) => {
        const qs = chip === "other" ? g.questions.filter((q) => q.answer === "X") : g.questions;
        return (
          <div key={g.file}>
            <div className="grp">
              <span>{label(g)}</span>
              <span>{g.questions.length} question{g.questions.length === 1 ? "" : "s"} · {g.when ? <span title={`Last QUESTION_ANSWERED for this stage${g.unit ? " and unit" : ""}: ${g.when}`}>{fmtTime(g.when)}</span> : <span title="No QUESTION_ANSWERED entry for this stage in the audit">answer time not recorded</span>} · <button type="button" className="linkbtn" style={{ textTransform: "inherit", letterSpacing: "inherit" }} title={g.file} onClick={() => openArtifact(ws, m.key, g.file)}>open file ↗</button></span>
            </div>
            {showQ && g.context.length > 0 && (
              <div className="carry">▸ <b>Context already decided — carried forward, not re-asked</b>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{g.context.map((c, i) => <li key={i}>{inline(c)}</li>)}</ul>
              </div>
            )}
            {showQ && qs.map((q, qi) => { const open = isOpen(gi, g, q, qi); return <Card key={q.id + qi} q={q} open={open} onToggle={() => toggle(g, q, open)} />; })}
            {showQ && !g.questions.length && <div className="dim" style={{ fontSize: ".88rem", marginBottom: 8 }}>This questions file holds no numbered question headings (<span className="mono">## Question 1</span> or <span className="mono">## Q1</span>).</div>}
            {chip !== "other" && (g.gate ? <Closer g={g.gate} /> : <div className="faint" style={{ fontSize: ".84rem", marginBottom: 8 }}>— no gate or plan approval recorded for this {g.unit ? "unit step" : "stage"}</div>)}
          </div>
        );
      })}
      {chip === "all" && agent.length > 0 && (
        <>
          <div className="grp"><span>✎ Agent decisions · {agent.length}</span><button type="button" className="linkbtn" style={{ textTransform: "inherit", letterSpacing: "inherit" }} aria-expanded={showAgent} onClick={() => setShowAgent((s) => !s)}>{showAgent ? "collapse ▴" : "expand ▾"}</button></div>
          {showAgent && agentCards}
        </>
      )}
    </div>
  );
}
