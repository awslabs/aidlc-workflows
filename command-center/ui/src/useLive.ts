import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { HomePayload, StoryEvent } from "../../../core/command-center/server/types";
import { get, streamUrl } from "./api";

export type IntentDelta = { ws: string; key: string; newEvents: StoryEvent[]; reset: boolean; lastEventTs: string | null };
/**
 * What an intent subscriber receives: an incremental `delta`, or a `resync` meaning "your copy may be stale —
 * refetch". Resyncs are sent on every reconnect (no ws/key: applies to every intent) and on an audit `reset`.
 */
export type IntentSignal = ({ type: "delta" } & IntentDelta) | { type: "resync"; ws?: string; key?: string };
export type FeedItem = StoryEvent & { ws: string; key: string; id: string };
export interface Live {
  home: HomePayload | null;
  /** The SSE stream is open. */
  connected: boolean;
  /** At least one connection attempt has finished (so "Disconnected" is a fact, not a guess). */
  tried: boolean;
  /** When the stream was last seen down (ms epoch); relative timers freeze here while disconnected. */
  downSince: number;
  lastMsgAt: number;
  feed: FeedItem[];
  /** The server's per-workspace change detection (`watch` messages): "poll" when file watching failed. */
  watchModes: Record<string, "watch" | "poll">;
  /** Re-fetches `/api/home` (used after a config change). */
  refresh: () => Promise<void>;
  subscribeIntent: (ws: string, key: string, cb: (s: IntentSignal) => void) => () => void;
}

const MAX_FEED = 50;
let seq = 0;

export function useLive(): Live {
  const [home, setHome] = useState<HomePayload | null>(null);
  const [connected, setConnected] = useState(false);
  const [tried, setTried] = useState(false);
  const [downSince, setDownSince] = useState(Date.now());
  const [lastMsgAt, setLast] = useState(Date.now());
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [watchModes, setWatchModes] = useState<Record<string, "watch" | "poll">>({});
  const subs = useRef(new Set<(s: IntentSignal) => void>());
  // Generation guard: every home source (fetch or SSE payload) takes a ticket when it starts; a result is applied
  // only if its ticket is newer than the last applied one, so a slow older fetch never overwrites a newer payload.
  const ticket = useRef(0);
  const applied = useRef(0);
  const apply = useCallback((t: number, h: HomePayload) => { if (t > applied.current) { applied.current = t; setHome(h); } }, []);
  const refresh = useCallback(async () => {
    const t = ++ticket.current;
    try { apply(t, await get<HomePayload>("/api/home")); } catch { /* keep the last good payload */ }
  }, [apply]);
  const notify = (s: IntentSignal) => subs.current.forEach((cb) => cb(s));

  useEffect(() => {
    void refresh();
    let es: EventSource | null = null; let retry = 1000; let stopped = false; let timer: ReturnType<typeof setTimeout> | null = null;
    let hellos = 0;
    let up = false;
    const setUp = (v: boolean) => { if (up && !v) setDownSince(Date.now()); up = v; setConnected(v); setTried(true); };
    const open = () => {
      if (stopped) return;
      es = new EventSource(streamUrl());
      es.onopen = () => { setUp(true); retry = 1000; setLast(Date.now()); void refresh(); };
      es.onerror = () => {
        // A 204 (stream not available) or a dropped connection: close and retry with backoff.
        setUp(false); es?.close(); es = null;
        if (!stopped) { timer = setTimeout(open, retry); retry = Math.min(retry * 2, 15000); }
      };
      es.onmessage = (m) => {
        setLast(Date.now());
        let d: { type?: string; [k: string]: unknown };
        try { d = JSON.parse(m.data); } catch { return; }
        if (d.type === "hello") {
          setUp(true);
          // A reconnect: anything may have happened while we were away.
          if (hellos++ > 0) { void refresh(); notify({ type: "resync" }); }
          return;
        }
        if (d.type === "watch") {
          const { ws, mode } = d as { ws?: unknown; mode?: unknown };
          if (typeof ws === "string" && (mode === "watch" || mode === "poll")) setWatchModes((m) => (m[ws] === mode ? m : { ...m, [ws]: mode }));
          return;
        }
        if (d.type === "home") { if (d.payload) apply(++ticket.current, d.payload as HomePayload); else void refresh(); return; }
        if (d.type === "intent") {
          const delta = d as unknown as IntentDelta;
          if (delta.reset) {
            // The audit was truncated/rewritten: these are not "new" events, so keep them out of the feed.
            void refresh(); notify({ type: "resync", ws: delta.ws, key: delta.key }); return;
          }
          const items = (delta.newEvents ?? []).map((e) => ({ ...e, ws: delta.ws, key: delta.key, id: `${delta.ws}::${delta.key}::${e.ts}::${seq++}` }));
          if (items.length) setFeed((f) => [...items.reverse(), ...f].slice(0, MAX_FEED));
          notify({ type: "delta", ...delta });
        }
      };
    };
    open();
    return () => { stopped = true; if (timer) clearTimeout(timer); es?.close(); };
  }, [refresh, apply]);

  const subscribeIntent = useCallback((ws: string, key: string, cb: (s: IntentSignal) => void) => {
    const f = (s: IntentSignal) => { if (s.ws === undefined || (s.ws === ws && s.key === key)) cb(s); };
    subs.current.add(f);
    return () => { subs.current.delete(f); };
  }, []);

  return { home, connected, tried, downSince, lastMsgAt, feed, watchModes, refresh, subscribeIntent };
}

export const LiveContext = createContext<Live | null>(null);
export function useLiveCtx(): Live {
  const l = useContext(LiveContext);
  if (!l) throw new Error("LiveContext missing");
  return l;
}

/** Re-renders every `ms` so relative times ("2s ago") stay true. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/**
 * The clock live timers should use. While disconnected it is frozen at the moment the stream dropped, and
 * `frozen` is true so callers render "≥ <value>" — the true wait is at least that, but we cannot see further.
 */
export function useLiveClock(): { now: number; frozen: boolean } {
  const { connected, downSince } = useLiveCtx();
  const tick = useNow(1000);
  return connected ? { now: tick, frozen: false } : { now: downSince, frozen: true };
}
