import { useEffect, useRef, useState } from "react";
import type { Config } from "../api";
import { applyTheme } from "./ThemeSwitch";
import "./linked-views.css";

export const portfolioUrl = /^https?:\/\//.test(import.meta.env.VITE_PORTFOLIO_URL ?? "")
  ? import.meta.env.VITE_PORTFOLIO_URL! : null;
const themes = ["light", "dark", "auto"] as const;
const validReturn = (value: string | null) => !!value?.startsWith("#view=") && value.length <= 4096;
const key = portfolioUrl ? `cc.portfolio.return:${new URL(portfolioUrl).origin}` : "";
const readReturn = () => {
  try { const value = sessionStorage.getItem(key); return validReturn(value) ? value : null; }
  catch { return null; }
};

/** Optional navigation between the independently running apps. */
export function useLinkedViews(theme: Config["theme"], onTheme: (theme: Config["theme"]) => void) {
  const headerRef = useRef<HTMLElement>(null);
  const received = useRef(false);
  const [returnHash, setReturnHash] = useState(readReturn);
  useEffect(() => {
    if (!portfolioUrl || received.current) return;
    received.current = true;
    const source = new URL(location.href);
    const nextTheme = source.searchParams.get("cc_theme");
    const nextReturn = source.searchParams.get("cc_return");
    if (validReturn(nextReturn)) {
      setReturnHash(nextReturn);
      try { sessionStorage.setItem(key, nextReturn!); } catch {}
    }
    if (source.searchParams.has("cc_theme") || source.searchParams.has("cc_return")) {
      source.searchParams.delete("cc_theme"); source.searchParams.delete("cc_return");
      history.replaceState(null, "", source);
    }
    if (themes.includes(nextTheme as Config["theme"])) {
      applyTheme(nextTheme as Config["theme"]);
      onTheme(nextTheme as Config["theme"]);
    }
  }, [onTheme]);
  useEffect(() => {
    if (!portfolioUrl || !headerRef.current) return;
    const root = document.documentElement;
    const previous = root.style.getPropertyValue("--topbar-h");
    const observer = new ResizeObserver(([entry]) => {
      if (entry) root.style.setProperty("--topbar-h", `${Math.ceil(entry.target.getBoundingClientRect().height)}px`);
    });
    observer.observe(headerRef.current);
    return () => { observer.disconnect(); previous ? root.style.setProperty("--topbar-h", previous) : root.style.removeProperty("--topbar-h"); };
  }, []);
  let href = portfolioUrl;
  if (href) {
    const target = new URL(href);
    if (returnHash) target.hash = returnHash;
    target.searchParams.set("cc_theme", theme);
    target.searchParams.set("cc_return", location.hash || "#/");
    href = target.href;
  }
  return { headerRef, href };
}

export function ViewSwitch({ href }: { href: string }) {
  return <nav className="cc-view-switch" aria-label="Application view">
    <a href={location.hash || "#/"} aria-current="page">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 6-5 6 5 6m8-12 5 6-5 6m-3-15-2 18"/></svg>Engineering
    </a>
    <a href={href} title="Portfolio · committed repository checkpoints">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h6v6H3zm12 0h6v6h-6zM3 15h6v6H3zm12 0h6v6h-6z"/></svg>Portfolio
    </a>
  </nav>;
}
