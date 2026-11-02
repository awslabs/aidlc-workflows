// `location` is absent when components are rendered on the server in tests.
const token = typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("t") ?? "";
export async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { "x-cc-token": token } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json() as Promise<T>;
}
export async function put(path: string, body: unknown): Promise<void> {
  const r = await fetch(path, { method: "PUT", headers: { "x-cc-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
}
export async function post<T>(path: string): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "x-cc-token": token } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json() as Promise<T>;
}
export const streamUrl = () => `/api/stream?t=${encodeURIComponent(token)}`;
export const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Mirrors server/config.ts `Config` (the server validates every PUT). */
export interface Config { version: 1; roots: string[]; pins: string[]; hidden: string[]; repos: string[]; theme: "light" | "dark" | "auto"; settings?: { scanTranscripts: boolean } }
