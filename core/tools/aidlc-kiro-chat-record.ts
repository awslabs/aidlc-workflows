// Kiro's own chat record (Kiro IDE and Kiro CLI v3 alike):
// ~/.kiro/sessions/<workspace id>/<session id>/messages.jsonl (and the chat's
// session.json beside it), found by the session id alone, so the workspace hash
// (which follows how the folder path is spelled on Windows) is never computed.
// Read only; nothing here writes in Kiro's home.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const KIRO_SESSION_DIR_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export function kiroChatRecordPaths(sessionId: string | undefined, file = "messages.jsonl"): string[] {
  if (!sessionId || !KIRO_SESSION_DIR_RE.test(sessionId)) return [];
  const root = join(homedir(), ".kiro", "sessions");
  try {
    return readdirSync(root).map((workspace) => join(root, workspace, sessionId, file)).filter(existsSync);
  } catch {
    return [];
  }
}

// Kiro IDE's agent menu names for the session.json `agentMode` of its built-in
// agents that ask the person to approve each command (Kiro IDE 1.4.51).
const DEFAULT_AGENTS: Readonly<Record<string, string>> = { vibe: "Default", "default-v2": "Default v2" };

/**
 * The agent menu's name for this chat's agent when its session.json says one
 * of Kiro IDE's Default agents; "" for any other agent, no readable record, or
 * when the person chose Always allow for `command`: Kiro keeps that choice in
 * ~/.kiro/workspace-roots/<workspace id>/ (This workspace; the chat record's
 * workspace id) or ~/.kiro/settings/ (All workspaces).
 */
export function kiroDefaultAgentName(sessionId: string | undefined, command: string): string {
  const [record] = kiroChatRecordPaths(sessionId, "session.json");
  if (record === undefined) return "";
  let mode: unknown;
  try {
    mode = (JSON.parse(readFileSync(record, "utf-8")) as { agentMode?: unknown }).agentMode;
  } catch {
    return "";
  }
  if (typeof mode !== "string" || !Object.hasOwn(DEFAULT_AGENTS, mode)) return "";
  const kiro = join(homedir(), ".kiro");
  const ruleDirs = [join(kiro, "workspace-roots", basename(dirname(dirname(record)))), join(kiro, "settings")];
  return ruleDirs.some((dir) => kiroAlwaysAllows(dir, command)) ? "" : DEFAULT_AGENTS[mode];
}

// A plain Always allow, as Kiro writes it in permissions.yaml (or .json):
// `{capability: shell, effect: allow, match: ["aidlc *"]}`, `*` standing for
// any text. A rule with anything more, or a file that cannot be read, is not.
function kiroAlwaysAllows(dir: string, command: string): boolean {
  for (const file of ["permissions.yaml", "permissions.json"]) {
    let rules: unknown;
    try {
      const text = readFileSync(join(dir, file), "utf-8");
      rules = ((file.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text)) as { rules?: unknown } | null)?.rules;
    } catch {
      continue;
    }
    if (!Array.isArray(rules)) continue;
    for (const rule of rules as Array<Record<string, unknown> | null>) {
      if (rule === null || typeof rule !== "object" || rule.capability !== "shell" || rule.effect !== "allow") continue;
      if (Object.keys(rule).some((key) => !["capability", "effect", "match"].includes(key))) continue;
      if (!Array.isArray(rule.match)) continue;
      if (rule.match.some((pattern) => typeof pattern === "string" && globMatches(pattern, command))) return true;
    }
  }
  return false;
}

function globMatches(pattern: string, text: string): boolean {
  const parts = pattern.split("*").map((part) => part.replace(/[\\^$.|?+()[\]{}]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`, "s").test(text);
}
