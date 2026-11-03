// Remote repository URLs (saved in config, not read until phase 2). Pure: shared by the server and the UI.
/** https://…, ssh://… or scp-style git@host:path — no whitespace anywhere. */
export const REPO_RE = /^(https:\/\/[^\s]+|ssh:\/\/[^\s]+|git@[^\s:@]+:[^\s]+)$/;
export const MAX_REPOS = 200;
const MAX_REPO_LEN = 2048;
/**
 * True when the URL carries credentials: any userinfo on https:// (`https://tok@…`, `https://u:p@…`), or a
 * `:password` in ssh:// userinfo. `git@host:path` and `ssh://git@host/path` carry a user name only, so they pass.
 */
export function repoCredentials(s: string): boolean {
  const m = /^(https|ssh):\/\/([^/?#]*)/.exec(s); if (!m) return false;
  const at = m[2]!.lastIndexOf("@"); if (at < 0) return false;
  return m[1] === "https" ? true : m[2]!.slice(0, at).includes(":");
}
const shapeOk = (s: string) => s.length <= MAX_REPO_LEN && REPO_RE.test(s);
export const isRepoUrl = (s: string) => shapeOk(s) && !repoCredentials(s);
/** Why a URL cannot be saved (shown under the add field), or null when it can. */
export function repoUrlProblem(s: string): string | null {
  if (!shapeOk(s)) return "Use an https://, ssh:// or git@host:path URL";
  if (repoCredentials(s)) return "Remove credentials from the URL - credentials are never saved in settings";
  return null;
}

export type RepoHost = "GitHub" | "GitLab" | "Bitbucket" | "Azure DevOps" | "Git";
/** The host of a repo URL ("" when it has none we can read). */
function hostOf(url: string): string {
  const scp = /^git@([^\s:]+):/.exec(url); if (scp) return scp[1]!.toLowerCase();
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}
const is = (h: string, d: string) => h === d || h.endsWith(`.${d}`);
/** A display label for the URL's host; anything unrecognised is plain "Git". */
export function repoHost(url: string): RepoHost {
  const h = hostOf(url);
  if (is(h, "github.com")) return "GitHub";
  if (is(h, "gitlab.com")) return "GitLab";
  if (is(h, "bitbucket.org")) return "Bitbucket";
  if (is(h, "dev.azure.com") || is(h, "visualstudio.com")) return "Azure DevOps";
  return "Git";
}

/** Well-formed URLs only, first occurrence kept, at most MAX_REPOS. */
export function cleanRepos(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === "string" && isRepoUrl(x) && !out.includes(x)) { out.push(x); if (out.length >= MAX_REPOS) break; }
  return out;
}
