import { useCallback, useEffect, useRef, useState } from "react";
import type { IntentSummary, WorkspaceSummary } from "../../../core/command-center/server/types";
import { get, put, type Config } from "./api";
import { Header } from "./chrome/Header";
import { SetupDialog } from "./chrome/SetupDialog";
import { SubBar } from "./chrome/SubBar";
import { applyTheme } from "./chrome/ThemeSwitch";
import { HealthPage } from "./health/HealthPage";
import { Home } from "./home/Home";
import { LiveRail } from "./home/LiveRail";
import { IntentView } from "./intent/IntentView";
import { LiveContext, useLive } from "./useLive";

export type Route = { view: "home" } | { view: "health" } | { view: "intent"; ws: string; space: string; dir: string; lens: string | null };

export function parseHash(h: string): Route {
  if (/^#\/health\/?$/.test(h)) return { view: "health" };
  const m = /^#\/i\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/.exec(h);
  if (!m) return { view: "home" };
  try {
    return { view: "intent", ws: decodeURIComponent(m[1]!), space: decodeURIComponent(m[2]!), dir: decodeURIComponent(m[3]!), lens: m[4] ? decodeURIComponent(m[4]) : null };
  } catch { return { view: "home" }; }
}

/** `#/?settings=1` opens Workspaces & settings over Home (a shareable link; the smoke test uses it). */
export const wantsSettings = (h: string) => /^#\/?\?(?:.*&)?settings=1(?:&|$)/.test(h);

export function findIntent(ws: WorkspaceSummary[] | undefined, r: Route): { w: WorkspaceSummary; i: IntentSummary } | null {
  if (r.view !== "intent" || !ws) return null;
  const w = ws.find((x) => x.path === r.ws); const i = w?.intents.find((x) => x.space === r.space && x.dir === r.dir);
  return w && i ? { w, i } : null;
}

function favicon(needs: number): string {
  const dot = needs > 0 ? `<circle cx='25' cy='7' r='6' fill='%23e2a63c' stroke='white' stroke-width='2'/>` : "";
  return `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%231f6fb8'/><stop offset='1' stop-color='%236a4bc4'/></linearGradient></defs><rect x='2' y='2' width='28' height='28' rx='7' fill='url(%23g)'/><text x='16' y='21' font-family='sans-serif' font-size='12' font-weight='800' fill='white' text-anchor='middle'>AI</text>${dot}</svg>`;
}

export function App() {
  const live = useLive();
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [config, setConfig] = useState<Config | null>(null);
  const [setup, setSetup] = useState<{ open: boolean; first: boolean }>({ open: false, first: false });
  const [rail, setRail] = useState(() => localStorage.getItem("cc-rail") !== "0");
  const [toast, setToast] = useState<string | null>(null);
  /** A theme picked before /api/config answered; saved as soon as the config arrives. */
  const pendingTheme = useRef<Config["theme"] | null>(null);
  /** Replay instant of the focused intent (client-side: the view shows events ≤ this); cleared when the intent changes. */
  const [replay, setReplay] = useState<string | null>(null);
  const intentId = route.view === "intent" ? `${route.ws}\u0000${route.space}\u0000${route.dir}` : null;
  useEffect(() => { setReplay(null); }, [intentId]);

  useEffect(() => {
    const f = () => { setRoute(parseHash(location.hash)); if (wantsSettings(location.hash)) setSetup((s) => (s.open ? s : { open: true, first: false })); };
    addEventListener("hashchange", f); return () => removeEventListener("hashchange", f);
  }, []);
  useEffect(() => {
    get<Config>("/api/config").then((c) => {
      const t = pendingTheme.current; pendingTheme.current = null;
      if (t && t !== c.theme) { applyTheme(t); void saveConfigRef.current({ ...c, theme: t }); }
      else applyTheme(c.theme);
      setConfig(t ? { ...c, theme: t } : c);
      if (!c.roots.length && !c.pins.length) setSetup({ open: true, first: true });
      else if (wantsSettings(location.hash)) setSetup({ open: true, first: false });
    }).catch(() => {});
  }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2200); return () => clearTimeout(t); }, [toast]);

  const needs = live.home?.needs.length ?? 0;
  useEffect(() => {
    document.title = (needs ? `(${needs}) ` : "") + "AI-DLC Command Center";
    const link = document.getElementById("favicon") as HTMLLinkElement | null;
    if (link) link.href = favicon(needs);
  }, [needs]);

  /** Every config change is a whole-config PUT; the server validates and saves atomically. */
  const saveConfig = useCallback(async (next: Config): Promise<boolean> => {
    try { await put("/api/config", next); setConfig(next); await live.refresh(); return true; }
    catch (e) { setToast(`Could not save settings — ${(e as Error).message}`); return false; }
  }, [live.refresh]);

  const saveConfigRef = useRef(saveConfig); saveConfigRef.current = saveConfig;
  const onTheme = (t: Config["theme"]) => { if (config) void saveConfig({ ...config, theme: t }); else pendingTheme.current = t; };

  const toggleRail = () => setRail((r) => { localStorage.setItem("cc-rail", r ? "0" : "1"); return !r; });
  const focused = findIntent(live.home?.workspaces, route);

  return (
    <LiveContext.Provider value={live}>
      <div className={live.connected ? "cc-app" : "cc-app disconnected"}>
      <Header route={route} config={config} onTheme={onTheme} onSettings={() => setSetup({ open: true, first: false })} onToast={setToast} />
      <SubBar route={route} focused={focused} replay={route.view === "intent" ? replay : null} onToggleRail={toggleRail} />
      <div className="page">
        <div className="main">
          {route.view === "home"
            ? <Home config={config} saveConfig={saveConfig} />
            : route.view === "health" ? <HealthPage />
            : <IntentView key={intentId!} ws={route.ws} space={route.space} dir={route.dir} lensSlug={route.lens} focused={focused} replayAt={replay} onReplay={setReplay} />}
        </div>
        <div className={`rail${rail ? "" : " hide"}`}><LiveRail route={route} focused={focused} /></div>
      </div>
      {setup.open && config && <SetupDialog first={setup.first} config={config} saveConfig={saveConfig} onClose={() => setSetup({ open: false, first: false })} />}
      <div className={`toast${toast ? " show" : ""}`} role="status">{toast}</div>
      </div>
    </LiveContext.Provider>
  );
}
