import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "../App";
import type { Config } from "../api";
import { intentHash, phaseName } from "../format";
import { useLiveCtx } from "../useLive";
import { ThemeSwitch } from "./ThemeSwitch";
import { portfolioUrl, useLinkedViews, ViewSwitch } from "./LinkedViews";

interface Props { route: Route; config: Config | null; onTheme: (t: Config["theme"]) => void; onSettings: () => void; onToast: (m: string) => void }

export function Header({ route, config, onTheme, onSettings, onToast }: Props) {
  const { home } = useLiveCtx();
  const linked = useLinkedViews(config?.theme ?? "auto", onTheme);
  const n = home?.needs.length ?? 0;
  const fix = home?.health?.needsFixing ?? null;
  const latest = useMemo(() => {
    const all = (home?.workspaces ?? []).flatMap((w) => w.intents);
    return all.sort((a, b) => (b.lastEventTs ?? "").localeCompare(a.lastEventTs ?? ""))[0] ?? null;
  }, [home]);
  const navigation = (
      <nav className="nav" aria-label="Engineering page navigation">
        <a className={route.view === "home" ? "on" : ""} href="#/">Home</a>
        <a className={route.view === "health" ? "on" : ""} href="#/health" title={fix === null ? "What needs fixing across all workspaces" : fix ? `${fix} open hard stop${fix === 1 ? "" : "s"}, failure${fix === 1 ? "" : "s"} or repeated refusal${fix === 1 ? "" : "s"}` : "Nothing needs fixing"}>
          Health{fix !== null && <span className={`hbadge${fix ? "" : " zero"}`}>{fix ? <><span aria-hidden>✗</span> {fix}</> : <span aria-hidden>✓</span>}</span>}
        </a>
        {latest
          ? <a className={route.view === "intent" && route.lens === "learnings" ? "on" : ""} href={intentHash(latest.workspace, latest.key, "learnings")} title="Learnings of the most recently active intent">Learnings</a>
          : <button type="button" className="navbtn" disabled title="No intents yet">Learnings</button>}
        <button type="button" className="navbtn" onClick={onSettings}>Workspaces</button>
        {!portfolioUrl && <button type="button" className="navbtn" onClick={() => onToast("Leadership view — phase 2")} title="phase 2">Leadership <span className="chip" style={{ marginLeft: 4 }}>soon</span></button>}
      </nav>
  );
  const top = (
    <div className="top">
      <a className="brand" href="#/" style={{ color: "inherit", textDecoration: "none" }}>
        <div className="logo">AI</div>
        <div><div className="nm1">AI-DLC Command Center</div><div className="nm2">Engineering view · local</div></div>
      </a>
      {linked.href ? <ViewSwitch href={linked.href} /> : navigation}
      <div className="grow" />
      <Search />
      <a className={`needpill${n ? "" : " zero"}`} href="#/" style={{ textDecoration: "none" }} title={n ? "Open gates, question batches and plan approvals across all intents" : "No open gates, questions or plan approvals"}>
        {n ? `◆ ${n} needs you` : "Nothing needs you"}
      </a>
      <ThemeSwitch value={config?.theme ?? "auto"} onChange={onTheme} />
      <button className="iconbtn" type="button" title="Workspaces & settings" aria-label="Workspaces & settings" onClick={onSettings}>⚙</button>
    </div>
  );
  return linked.href
    ? <header className="cc-linked-header" ref={linked.headerRef}>{top}<div className="cc-page-nav">{navigation}</div></header>
    : top;
}

interface Hit { id: string; name: string; sub: string; why: string | null; hash: string }

function Search() {
  const { home } = useLiveCtx();
  const [qv, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); input.current?.select(); setOpen(true); } };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);

  const hits = useMemo<Hit[]>(() => {
    const s = qv.trim().toLowerCase();
    const out: Hit[] = [];
    for (const w of home?.workspaces ?? []) for (const i of w.intents) {
      const stages = [i.current.stage, ...i.needs.map((x) => x.stage)].filter((x): x is string => !!x);
      const units = i.units.map((u) => u.name);
      let why: string | null = null;
      if (s) {
        if (i.name.toLowerCase().includes(s) || (i.title ?? "").toLowerCase().includes(s)) why = null;
        else { const st = stages.find((x) => x.toLowerCase().includes(s)); const un = units.find((x) => x.toLowerCase().includes(s));
          if (st) why = `stage ${st}`; else if (un) why = `unit ${un}`; else continue; }
      }
      out.push({ id: `${w.path}::${i.key}`, name: i.name, sub: `${w.label} · ${phaseName(i.current.phase)}${i.current.stage ? ` · ${i.current.stage}` : ""}`, why, hash: intentHash(w.path, i.key) });
    }
    return out.slice(0, 8);
  }, [home, qv]);

  const go = (h: Hit | undefined) => { if (!h) return; location.hash = h.hash; setOpen(false); setQ(""); input.current?.blur(); };

  return (
    <div className="search cc-search" onClick={() => input.current?.focus()}>
      ⌕
      <input ref={input} value={qv} placeholder="Search intents, stages, decisions…" aria-label="Search intents and stages"
        onChange={(e) => { setQ(e.target.value); setSel(0); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((x) => Math.min(x + 1, hits.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((x) => Math.max(x - 1, 0)); }
          else if (e.key === "Enter") go(hits[sel]);
          else if (e.key === "Escape") { setOpen(false); input.current?.blur(); }
        }} />
      <kbd>⌘K</kbd>
      {open && (
        <div className="cc-results" role="listbox">
          {hits.length ? hits.map((h, ix) => (
            <div key={h.id} role="option" aria-selected={ix === sel} className={`cc-hit${ix === sel ? " sel" : ""}`} onMouseDown={(e) => { e.preventDefault(); go(h); }} onMouseEnter={() => setSel(ix)}>
              <b>{h.name}</b>{h.why && <span className="chip" style={{ marginLeft: 6 }}>{h.why}</span>}
              <div className="dim mono">{h.sub}</div>
            </div>
          )) : <div className="cc-hit dim">{home ? "No matching intents or stages." : "Loading…"}</div>}
        </div>
      )}
    </div>
  );
}
