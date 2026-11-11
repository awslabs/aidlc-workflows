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

/**
 * How full this chat got in its first turn on the work (the highest figure Kiro
 * recorded in that turn), and the model Kiro names for the chat: a new chat that
 * picks the work up on the same model starts about that full. The first turn is
 * the first one with a figure at or after `since` (this chat's first turn on the
 * work); a turn Kiro summarized part way counts at its figure before the summary.
 * The figure is a share of the window of the model that ran the turn, so it
 * counts only when the record names that model and the model now, the same: a
 * chat switched with /model since would start a new chat on another window.
 * Kiro CLI's default engine saves each turn's figures and model in
 * ~/.kiro/sessions/cli/<session id>.json. Kiro CLI v3 and Kiro IDE put the
 * figures in `contextUsage` rows that carry the turn's `executionId`; the model
 * that ran it is in Kiro's own `context_snapshot_` note before the turn ("The
 * current model is <model>.", written at a chat's first prompt and after each
 * summary), and the model now in the session.json beside, with the model that
 * note last named. `auto` names no model: Kiro picks it. Kiro keeps no record
 * of the other models a person can pick. Read only; null when nothing is known.
 */
export function kiroFirstTurnFill(
  sessionId: string | undefined,
  since: number | null,
): { percent: number; model: string | null } | null {
  if (!sessionId || !KIRO_SESSION_DIR_RE.test(sessionId) || since === null) return null;
  try {
    const chat = JSON.parse(readFileSync(join(homedir(), ".kiro", "sessions", "cli", `${sessionId}.json`), "utf-8"));
    const state = recordField(chat, "session_state");
    const turns = recordField(recordField(state, "conversation_metadata"), "user_turn_metadatas");
    if (Array.isArray(turns)) {
      for (const turn of turns) {
        if (!(Date.parse(String(recordField(turn, "end_timestamp"))) >= since)) continue;
        const figures = [recordField(turn, "context_usage_percentage"), recordField(turn, "final_context_usage_percentage")]
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        if (figures.length === 0) return null;
        const now = recordField(recordField(recordField(state, "rts_model_state"), "model_info"), "model_id") ??
          recordField(recordField(recordField(state, "conversation_metadata"), "last_context_usage"), "model_id");
        if (typeof now !== "string" || !now || recordField(turn, "model") !== now) return null;
        return { percent: Math.max(...figures), model: modelName(now) };
      }
    }
  } catch {
    // Not a chat of Kiro CLI's default engine, or not readable now.
  }
  for (const path of kiroChatRecordPaths(sessionId)) {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    let turn: string | null = null;
    let percent: number | null = null;
    let noted: string | null = null;
    let ranOn: string | null = null;
    for (const line of text.split("\n")) {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = recordField(row, "payload");
      if (turn === null && recordField(payload, "type") === "agent_note") {
        const id = recordField(row, "id");
        const content = recordField(payload, "content");
        if (typeof id === "string" && id.startsWith("context_snapshot_") && typeof content === "string") {
          noted = /^The current model is (.+)\.$/m.exec(content.replaceAll("\r", ""))?.[1] ?? null;
        }
        continue;
      }
      if (recordField(payload, "type") !== "session_metadata" || recordField(payload, "key") !== "contextUsage") continue;
      const figure = recordField(recordField(payload, "value"), "usagePercentage");
      const execution = recordField(payload, "executionId");
      if (typeof figure !== "number" || !Number.isFinite(figure) || typeof execution !== "string") continue;
      if (turn === null) {
        if (!(Date.parse(String(recordField(row, "timestamp"))) >= since)) continue;
        turn = execution;
        ranOn = noted;
      } else if (execution !== turn) {
        break;
      }
      percent = Math.max(percent ?? figure, figure);
    }
    if (percent === null) continue;
    let session: unknown;
    try {
      session = JSON.parse(readFileSync(join(dirname(path), "session.json"), "utf-8"));
    } catch {
      return null;
    }
    const now = recordField(session, "modelId");
    const told = recordField(session, "contextSnapshotModelDisplay");
    if (
      ranOn === null || typeof now !== "string" || recordField(told, "modelId") !== now ||
      recordField(told, "display") !== ranOn
    ) return null;
    return { percent, model: modelName(now) };
  }
  return null;
}

function recordField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

// A model id as Kiro shows it in /model, said in the person's line only when it
// is one plainly; `auto` is Kiro picking, so it names none.
function modelName(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) && value.toLowerCase() !== "auto"
    ? value
    : null;
}

// Kiro's names for the session.json `agentMode` of its built-in agents, which
// leave each command to Kiro's approval: Kiro IDE's agent menu (Kiro IDE
// 1.4.51); Kiro CLI 3.2.0 on its v3 engine writes `vibe` for its Default too.
const DEFAULT_AGENTS: Readonly<Record<string, string>> = { vibe: "Default", "default-v2": "Default v2" };

/**
 * The name of this chat's agent when its session.json says one of Kiro's
 * Default agents; "" for any other agent, no readable record, or when Kiro
 * does not ask the person about `command`: they chose Always allow for it, or
 * Approve for me is on. Kiro keeps an Always allow in
 * ~/.kiro/workspace-roots/<workspace id>/ (This workspace; the chat record's
 * workspace id) or ~/.kiro/settings/ (All workspaces). Kiro IDE 1.4.154 keeps
 * Approve for me in the chat's session.json (`approveForMe`, true only in that
 * mode), which then decides. Kiro CLI 3.2.0's session.json has no such field:
 * its approve for me is the workspace's `policies: [approve-for-me]`.
 */
export function kiroDefaultAgentName(sessionId: string | undefined, command: string): string {
  const [record] = kiroChatRecordPaths(sessionId, "session.json");
  if (record === undefined) return "";
  let session: unknown;
  try {
    session = JSON.parse(readFileSync(record, "utf-8"));
  } catch {
    return "";
  }
  const mode = recordField(session, "agentMode");
  if (typeof mode !== "string" || !Object.hasOwn(DEFAULT_AGENTS, mode)) return "";
  const approveForMe = recordField(session, "approveForMe");
  if (approveForMe === true) return "";
  const kiro = join(homedir(), ".kiro");
  const workspace = join(kiro, "workspace-roots", basename(dirname(dirname(record))));
  if (typeof approveForMe !== "boolean" && kiroPoliciesApproveForMe([workspace]) === true) return "";
  return [workspace, join(kiro, "settings")].some((dir) => kiroAlwaysAllows(dir, command)) ? "" : DEFAULT_AGENTS[mode];
}

// Kiro's permissions.yaml (or .json) in `dir`: its parsed value, or that there
// is none or it cannot be read.
function readKiroPermissions(dir: string, file: string): { value: unknown } | "missing" | "unreadable" {
  const path = join(dir, file);
  if (!existsSync(path)) return "missing";
  try {
    const text = readFileSync(path, "utf-8");
    return { value: file.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text) };
  } catch {
    return "unreadable";
  }
}

// The same file's parsed value; null when there is none or it cannot be read.
function kiroPermissions(dir: string, file: string): unknown {
  const read = readKiroPermissions(dir, file);
  return typeof read === "object" ? read.value : null;
}

// Whether Kiro CLI's permission files in `dirs` list its approve for me, as its
// /permissions writes it: `policies: [approve-for-me]`, beside rules or none.
// true when one lists it; null when none does and a file there cannot be read;
// false otherwise. Each caller passes the folders it reads (the hook its chat's
// workspace, the issue report the person's own settings too); the issue report
// imports this from the installed tools, so it keeps no copy.
export function kiroPoliciesApproveForMe(dirs: readonly string[]): boolean | null {
  let unreadable = false;
  for (const dir of dirs) {
    for (const file of ["permissions.yaml", "permissions.json"]) {
      const read = readKiroPermissions(dir, file);
      if (read === "unreadable") unreadable = true;
      if (typeof read !== "object") continue;
      const policies = recordField(read.value, "policies");
      if (Array.isArray(policies) && policies.includes("approve-for-me")) return true;
    }
  }
  return unreadable ? null : false;
}

// A plain Always allow, as Kiro writes it in permissions.yaml (or .json):
// `{capability: shell, effect: allow, match: ["aidlc *"]}`, `*` standing for
// any text. A rule with anything more, or a file that cannot be read, is not.
function kiroAlwaysAllows(dir: string, command: string): boolean {
  for (const file of ["permissions.yaml", "permissions.json"]) {
    const rules = recordField(kiroPermissions(dir, file), "rules");
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
