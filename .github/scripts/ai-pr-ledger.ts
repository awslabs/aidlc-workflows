// ai-pr-ledger.ts — the AIDA findings ledger and its `/aida` maintainer commands.
//
// The ledger is one bot-owned PR comment (found by LEDGER_MARKER) that AIDA reads
// before every review and rewrites after every publication. It gives findings a
// durable identity across heads (content-hash anchors, not titles) and gives
// maintainers a verified write channel: `/aida accept|reject|reopen|status|full`.
//
// Trust model: repository write permission, checked through the collaborators
// permission API on every command, is the only authority. Decisions enter the
// ledger only through this script after that check; the reviewing model never
// treats text it reads as a decision. The rendered comment carries a digest of
// its JSON so a hand edit is detected and its decisions are not honored until a
// verified command restates them.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export const LEDGER_MARKER = "<!-- aida-ledger v1";
export const LEDGER_VERSION = 1 as const;
const MAX_REASON_LENGTH = 500;
const MAX_LEDGER_BYTES = 200_000;
const MAX_FINDINGS = 200;
const MAX_EVENTS = 1000;

export type Priority = "P0" | "P1" | "P2" | "P3";
export type LedgerStatus = "open" | "resolved" | "accepted" | "rejected";
export type LedgerMode = "follow-up" | "full";
export type CommandKind = "accept" | "reject" | "reopen" | "status" | "full";

export interface LedgerAnchor {
  kind: "line" | "file" | "quote";
  path?: string;
  sha256: string;
}

export interface LedgerDecision {
  by: string;
  at: string;
  reason: string;
  commentId?: number;
}

export interface LedgerFinding {
  id: string;
  priority: Priority;
  category: string;
  title: string;
  anchors: LedgerAnchor[];
  status: LedgerStatus;
  firstSeen: { head: string; at: string };
  lastSeen: { head: string; at: string };
  decision?: LedgerDecision;
}

export interface LedgerEvent {
  at: string;
  kind:
    | "opened"
    | "seen"
    | "resolved"
    | "accepted"
    | "rejected"
    | "reopened"
    | "suppressed"
    | "full-requested"
    | "full-consumed";
  by: string;
  id?: string;
  head?: string;
  reason?: string;
  commentId?: number;
}

export interface Ledger {
  version: typeof LEDGER_VERSION;
  pullRequest: number;
  nextId: number;
  mode: LedgerMode;
  findings: LedgerFinding[];
  events: LedgerEvent[];
}

export interface LoadedLedger {
  ledger: Ledger;
  commentId: number | null;
  tampered: boolean;
}

export interface LedgerCommand {
  kind: CommandKind;
  id?: string;
  reason?: string;
}

export interface ReviewFindingInput {
  priority: Priority;
  category: string;
  title: string;
  anchors: LedgerAnchor[];
}

export interface ReconcileResult<T extends ReviewFindingInput> {
  ledger: Ledger;
  kept: Array<T & { ledgerId: string }>;
  accepted: Array<T & { ledgerId: string; decision: LedgerDecision }>;
  suppressed: Array<T & { ledgerId: string; decision: LedgerDecision }>;
  resolvedIds: string[];
}

// --- helpers ------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(ledger: Ledger): string {
  return JSON.stringify(ledger, null, 2);
}

// The digest covers the normalized ledger (validateLedger rebuilds every object
// with a fixed key order), so the writer and every later reader hash the same
// bytes regardless of how the in-memory object was assembled.
export function ledgerDigest(ledger: Ledger): string {
  return sha256(canonicalJson(validateLedger(ledger)));
}

export function emptyLedger(pullRequest: number): Ledger {
  if (!Number.isInteger(pullRequest) || pullRequest < 1) {
    throw new Error("pull request number must be a positive integer");
  }
  return {
    version: LEDGER_VERSION,
    pullRequest,
    nextId: 1,
    mode: "follow-up",
    findings: [],
    events: [],
  };
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function lineAnchor(path: string, lineText: string): LedgerAnchor {
  return { kind: "line", path, sha256: sha256(`line\0${path}\0${normalizeLine(lineText)}`) };
}

export function fileAnchor(path: string): LedgerAnchor {
  return { kind: "file", path, sha256: sha256(`file\0${path}`) };
}

export function quoteAnchor(quote: string): LedgerAnchor {
  return { kind: "quote", sha256: sha256(`quote\0${normalizeLine(quote)}`) };
}

export function positionAnchor(path: string, line: number, side: string): LedgerAnchor {
  return { kind: "line", path, sha256: sha256(`position\0${path}\0${line}\0${side}`) };
}

// --- validation ---------------------------------------------------------------

const STATUSES: readonly LedgerStatus[] = ["open", "resolved", "accepted", "rejected"];
const PRIORITIES: readonly Priority[] = ["P0", "P1", "P2", "P3"];

function validateAnchor(value: unknown, label: string): LedgerAnchor {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.kind !== "line" && value.kind !== "file" && value.kind !== "quote") {
    throw new Error(`${label}.kind is invalid`);
  }
  if (!/^[0-9a-f]{64}$/.test(text(value.sha256))) throw new Error(`${label}.sha256 is invalid`);
  if (value.path !== undefined && (typeof value.path !== "string" || value.path.length === 0)) {
    throw new Error(`${label}.path must be a non-empty string`);
  }
  return value.path === undefined
    ? { kind: value.kind, sha256: text(value.sha256) }
    : { kind: value.kind, path: value.path, sha256: text(value.sha256) };
}

function validateSeen(value: unknown, label: string): { head: string; at: string } {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (!/^[0-9a-f]{40}$/.test(text(value.head))) throw new Error(`${label}.head is invalid`);
  if (text(value.at).length === 0) throw new Error(`${label}.at is required`);
  return { head: text(value.head), at: text(value.at) };
}

function validateDecision(value: unknown, label: string): LedgerDecision {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const decision: LedgerDecision = {
    by: text(value.by),
    at: text(value.at),
    reason: text(value.reason),
  };
  if (decision.by.length === 0 || decision.at.length === 0) {
    throw new Error(`${label} requires by and at`);
  }
  if (decision.reason.length > MAX_REASON_LENGTH) throw new Error(`${label}.reason is too long`);
  if (typeof value.commentId === "number" && Number.isInteger(value.commentId)) {
    decision.commentId = value.commentId;
  }
  return decision;
}

export function validateLedger(value: unknown): Ledger {
  if (!isRecord(value)) throw new Error("ledger must be an object");
  if (value.version !== LEDGER_VERSION) throw new Error("ledger version is unsupported");
  if (!Number.isInteger(value.pullRequest) || Number(value.pullRequest) < 1) {
    throw new Error("ledger.pullRequest is invalid");
  }
  if (!Number.isInteger(value.nextId) || Number(value.nextId) < 1) {
    throw new Error("ledger.nextId is invalid");
  }
  if (value.mode !== "follow-up" && value.mode !== "full") throw new Error("ledger.mode is invalid");
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) {
    throw new Error("ledger.findings must be a bounded array");
  }
  if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS) {
    throw new Error("ledger.events must be a bounded array");
  }
  const seenIds = new Set<string>();
  const findings = value.findings.map((entry, index): LedgerFinding => {
    const label = `ledger.findings[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object`);
    const id = text(entry.id);
    if (!/^F[1-9][0-9]*$/.test(id)) throw new Error(`${label}.id is invalid`);
    if (seenIds.has(id)) throw new Error(`${label}.id is duplicated`);
    seenIds.add(id);
    if (!PRIORITIES.includes(entry.priority as Priority)) {
      throw new Error(`${label}.priority is invalid`);
    }
    if (!STATUSES.includes(entry.status as LedgerStatus)) {
      throw new Error(`${label}.status is invalid`);
    }
    if (!Array.isArray(entry.anchors) || entry.anchors.length === 0) {
      throw new Error(`${label}.anchors must be non-empty`);
    }
    const finding: LedgerFinding = {
      id,
      priority: entry.priority as Priority,
      category: text(entry.category),
      title: text(entry.title).slice(0, 160),
      anchors: entry.anchors.map((anchor, anchorIndex) =>
        validateAnchor(anchor, `${label}.anchors[${anchorIndex}]`),
      ),
      status: entry.status as LedgerStatus,
      firstSeen: validateSeen(entry.firstSeen, `${label}.firstSeen`),
      lastSeen: validateSeen(entry.lastSeen, `${label}.lastSeen`),
    };
    if (finding.title.length === 0) throw new Error(`${label}.title is required`);
    if (entry.decision !== undefined) {
      finding.decision = validateDecision(entry.decision, `${label}.decision`);
    }
    if ((finding.status === "accepted" || finding.status === "rejected") && !finding.decision) {
      throw new Error(`${label} ${finding.status} requires a decision`);
    }
    return finding;
  });
  const events = value.events.map((entry, index): LedgerEvent => {
    const label = `ledger.events[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object`);
    const kinds: LedgerEvent["kind"][] = [
      "opened", "seen", "resolved", "accepted", "rejected", "reopened",
      "suppressed", "full-requested", "full-consumed",
    ];
    if (!kinds.includes(entry.kind as LedgerEvent["kind"])) {
      throw new Error(`${label}.kind is invalid`);
    }
    const event: LedgerEvent = { at: text(entry.at), kind: entry.kind as LedgerEvent["kind"], by: text(entry.by) };
    if (event.at.length === 0 || event.by.length === 0) throw new Error(`${label} requires at and by`);
    if (typeof entry.id === "string") event.id = entry.id;
    if (typeof entry.head === "string") event.head = entry.head;
    if (typeof entry.reason === "string") event.reason = entry.reason.slice(0, MAX_REASON_LENGTH);
    if (typeof entry.commentId === "number") event.commentId = entry.commentId;
    return event;
  });
  const maxId = findings.reduce((max, finding) => Math.max(max, Number(finding.id.slice(1))), 0);
  if (Number(value.nextId) <= maxId) throw new Error("ledger.nextId must exceed every finding id");
  return {
    version: LEDGER_VERSION,
    pullRequest: Number(value.pullRequest),
    nextId: Number(value.nextId),
    mode: value.mode,
    findings,
    events,
  };
}

// --- comment rendering + parsing ---------------------------------------------

function escapeCell(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "\\|");
}

const STATUS_LABEL: Record<LedgerStatus, string> = {
  open: "🔴 open",
  resolved: "✅ resolved",
  accepted: "🟡 accepted",
  rejected: "⚪ rejected",
};

export function renderLedgerComment(input: Ledger, tampered = false): string {
  const ledger = validateLedger(input);
  const digest = ledgerDigest(ledger);
  const lines = [
    `${LEDGER_MARKER} digest=${digest} -->`,
    "## AIDA findings ledger",
    "",
  ];
  if (tampered) {
    lines.push(
      "> ⚠️ This comment was edited outside AIDA. Decisions recorded by that edit are not honored; restate them with `/aida` commands.",
      "",
    );
  }
  const open = ledger.findings.filter(finding => finding.status === "open");
  const blocking = open.filter(finding => finding.priority === "P0" || finding.priority === "P1");
  if (ledger.findings.length === 0) {
    lines.push("No findings recorded yet.", "");
  } else {
    lines.push(
      "| ID | Sev | Status | Title | Decided by |",
      "|----|-----|--------|-------|------------|",
    );
    for (const finding of ledger.findings) {
      const decided = finding.decision
        ? `@${escapeCell(finding.decision.by)} · ${finding.decision.at.slice(0, 10)}${
          finding.decision.reason ? ` · *${escapeCell(finding.decision.reason)}*` : ""
        }`
        : finding.status === "resolved"
          ? `AIDA · ${finding.lastSeen.head.slice(0, 8)}`
          : "—";
      lines.push(
        `| ${finding.id} | ${finding.priority} | ${STATUS_LABEL[finding.status]} | ${escapeCell(finding.title)} | ${decided} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    `Open blocking findings (P0/P1): **${blocking.length}**. Accepted and rejected findings never count toward the next action.`,
    ledger.mode === "full"
      ? "Next review: **full** (requested by a maintainer)."
      : "Next review: follow-up.",
    "",
    "Maintainer commands (repository write access): `/aida accept F# <reason>` · `/aida reject F# <reason>` · `/aida reopen F#` · `/aida status` · `/aida full`",
    "P0 and P1 findings can be accepted (visible, risk owned by the maintainer) but not rejected.",
    "",
    "<details><summary>ledger.json</summary>",
    "",
    "```json",
    canonicalJson(ledger),
    "```",
    "</details>",
  );
  return lines.join("\n");
}

export function parseLedgerComment(body: string): { ledger: Ledger; tampered: boolean } | null {
  const markerLine = body.split("\n").find(line => line.startsWith(LEDGER_MARKER));
  if (!markerLine) return null;
  const digestMatch = /digest=([0-9a-f]{64})/.exec(markerLine);
  const start = body.indexOf("```json\n");
  const end = body.lastIndexOf("\n```");
  if (start === -1 || end === -1 || end <= start) throw new Error("ledger comment has no JSON block");
  const raw = body.slice(start + "```json\n".length, end);
  if (Buffer.byteLength(raw, "utf8") > MAX_LEDGER_BYTES) throw new Error("ledger JSON is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ledger JSON is malformed");
  }
  const ledger = validateLedger(parsed);
  const tampered = !digestMatch || digestMatch[1] !== ledgerDigest(ledger);
  return { ledger, tampered };
}

// --- commands -----------------------------------------------------------------

export function parseCommand(body: string): LedgerCommand | null {
  const firstLine = body.replace(/\r\n/g, "\n").split("\n")[0].trim();
  const match = /^\/aida\s+(accept|reject|reopen|status|full)(?:\s+(F[1-9][0-9]*))?(?:\s+([\s\S]*))?$/.exec(firstLine);
  if (!match) return null;
  const kind = match[1] as CommandKind;
  const command: LedgerCommand = { kind };
  if (match[2]) command.id = match[2];
  if (match[3]) command.reason = match[3].trim().slice(0, MAX_REASON_LENGTH);
  return command;
}

export interface CommandActor {
  login: string;
  at: string;
  commentId?: number;
}

export function applyCommand(
  ledger: Ledger,
  command: LedgerCommand,
  actor: CommandActor,
): { ledger: Ledger; message: string } {
  const next: Ledger = structuredClone(ledger);
  const event = (kind: LedgerEvent["kind"], extra: Partial<LedgerEvent> = {}): void => {
    const entry: LedgerEvent = { at: actor.at, kind, by: actor.login, ...extra };
    if (actor.commentId !== undefined) entry.commentId = actor.commentId;
    next.events.push(entry);
  };
  if (command.kind === "status") {
    return { ledger: next, message: "Ledger re-rendered." };
  }
  if (command.kind === "full") {
    next.mode = "full";
    event("full-requested");
    return { ledger: next, message: "The next AIDA review will inspect the complete PR." };
  }
  if (!command.id) throw new Error(`/aida ${command.kind} requires a finding id such as F1`);
  const finding = next.findings.find(entry => entry.id === command.id);
  if (!finding) throw new Error(`Unknown finding ${command.id}`);
  if (command.kind === "reopen") {
    if (finding.status === "open") throw new Error(`${finding.id} is already open`);
    finding.status = "open";
    delete finding.decision;
    event("reopened", { id: finding.id });
    return { ledger: next, message: `${finding.id} reopened.` };
  }
  if (!command.reason) throw new Error(`/aida ${command.kind} ${command.id} requires a reason`);
  if (command.kind === "reject" && (finding.priority === "P0" || finding.priority === "P1")) {
    throw new Error(
      `${finding.id} is ${finding.priority}: blocking findings can be accepted (risk owned by you), not rejected`,
    );
  }
  if (finding.status === "resolved") throw new Error(`${finding.id} is already resolved`);
  const decision: LedgerDecision = { by: actor.login, at: actor.at, reason: command.reason };
  if (actor.commentId !== undefined) decision.commentId = actor.commentId;
  finding.status = command.kind === "accept" ? "accepted" : "rejected";
  finding.decision = decision;
  event(command.kind === "accept" ? "accepted" : "rejected", { id: finding.id, reason: command.reason });
  return {
    ledger: next,
    message: `${finding.id} ${finding.status} by @${actor.login}: ${command.reason}`,
  };
}

// --- reconciliation ---------------------------------------------------------

function anchorSet(anchors: LedgerAnchor[]): Set<string> {
  return new Set(anchors.map(anchor => anchor.sha256));
}

function intersects(left: LedgerAnchor[], right: Set<string>): boolean {
  return left.some(anchor => right.has(anchor.sha256));
}

export function reconcileLedger<T extends ReviewFindingInput>(
  loaded: LoadedLedger,
  findings: T[],
  head: string,
  at: string,
  anchorPresentAtHead: (anchor: LedgerAnchor) => boolean | null,
): ReconcileResult<T> {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("head must be a 40-character SHA");
  const ledger: Ledger = structuredClone(loaded.ledger);
  const honorDecisions = !loaded.tampered;
  const result: ReconcileResult<T> = {
    ledger,
    kept: [],
    accepted: [],
    suppressed: [],
    resolvedIds: [],
  };
  const matchedIds = new Set<string>();
  const push = (kind: LedgerEvent["kind"], id: string, extra: Partial<LedgerEvent> = {}): void => {
    ledger.events.push({ at, kind, by: "aida", id, head, ...extra });
  };
  if (loaded.tampered) {
    // Decisions written by a hand edit were never verified. Reset them so the
    // republished ledger is trustworthy; a verified command can restate them.
    for (const entry of ledger.findings) {
      if (entry.status !== "accepted" && entry.status !== "rejected") continue;
      entry.status = "open";
      delete entry.decision;
      push("reopened", entry.id, { reason: "unverified ledger edit" });
    }
  }

  for (const finding of findings) {
    const hashes = anchorSet(finding.anchors);
    const match = ledger.findings.find(
      entry => entry.status !== "resolved" && !matchedIds.has(entry.id) && intersects(entry.anchors, hashes),
    );
    if (!match) {
      const id = `F${ledger.nextId}`;
      ledger.nextId += 1;
      ledger.findings.push({
        id,
        priority: finding.priority,
        category: finding.category,
        title: finding.title,
        anchors: finding.anchors,
        status: "open",
        firstSeen: { head, at },
        lastSeen: { head, at },
      });
      push("opened", id);
      result.kept.push({ ...finding, ledgerId: id });
      continue;
    }
    matchedIds.add(match.id);
    match.lastSeen = { head, at };
    match.priority = finding.priority;
    match.title = finding.title;
    const known = anchorSet(match.anchors);
    for (const anchor of finding.anchors) {
      if (!known.has(anchor.sha256)) match.anchors.push(anchor);
    }
    if (honorDecisions && match.status === "rejected" && match.decision) {
      push("suppressed", match.id);
      result.suppressed.push({ ...finding, ledgerId: match.id, decision: match.decision });
      continue;
    }
    if (honorDecisions && match.status === "accepted" && match.decision) {
      push("seen", match.id);
      result.accepted.push({ ...finding, ledgerId: match.id, decision: match.decision });
      continue;
    }
    push("seen", match.id);
    result.kept.push({ ...finding, ledgerId: match.id });
  }

  for (const entry of ledger.findings) {
    if (entry.status !== "open" || matchedIds.has(entry.id)) continue;
    // Conservative closure: a finding the judge did not restate is resolved only
    // when every anchored line is provably gone from the head. An unchanged
    // anchor means the model may simply have omitted it, so it stays open.
    const verdicts = entry.anchors.map(anchor => anchorPresentAtHead(anchor));
    if (verdicts.length > 0 && verdicts.every(verdict => verdict === false)) {
      entry.status = "resolved";
      entry.lastSeen = { head, at };
      push("resolved", entry.id);
      result.resolvedIds.push(entry.id);
    }
  }

  if (ledger.mode === "full") {
    ledger.mode = "follow-up";
    ledger.events.push({ at, kind: "full-consumed", by: "aida", head });
  }
  if (ledger.events.length > MAX_EVENTS) {
    ledger.events = ledger.events.slice(ledger.events.length - MAX_EVENTS);
  }
  return result;
}

// --- head content lookup (for anchors) ---------------------------------------

export function readContextLine(
  contextDir: string,
  repoDir: string,
  path: string,
  line: number,
  side: "LEFT" | "RIGHT",
): string | null {
  const rootFor = side === "RIGHT" ? resolve(contextDir, "head") : resolve(repoDir);
  const target = resolve(rootFor, path);
  if (!target.startsWith(`${rootFor}${sep}`)) return null;
  if (!existsSync(target)) return null;
  const lines = readFileSync(target, "utf8").split("\n");
  if (line < 1 || line > lines.length) return null;
  return lines[line - 1];
}

export function headContainsAnchor(contextDir: string, anchor: LedgerAnchor): boolean | null {
  if (anchor.kind !== "line" || !anchor.path) return null;
  const root = resolve(contextDir, "head");
  const target = resolve(root, anchor.path);
  if (!target.startsWith(`${root}${sep}`)) return null;
  if (!existsSync(target)) return null;
  const path = anchor.path;
  return readFileSync(target, "utf8")
    .split("\n")
    .some(lineText => lineAnchor(path, lineText).sha256 === anchor.sha256);
}

// --- GitHub I/O ---------------------------------------------------------------

function ghJson(args: string[], ghExecutable: string, input?: string): unknown {
  const raw = execFileSync(ghExecutable, args, {
    encoding: "utf8",
    input,
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  return raw.trim().length === 0 ? null : JSON.parse(raw);
}

function assertRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must use owner/name format");
  }
}

export function loadLedgerComment(
  repository: string,
  pullRequest: number,
  ghExecutable = "gh",
): LoadedLedger {
  assertRepository(repository);
  const pages = ghJson(
    ["api", "--paginate", "--slurp", `repos/${repository}/issues/${pullRequest}/comments`],
    ghExecutable,
  );
  const comments = Array.isArray(pages) ? pages.flat() : [];
  for (const comment of comments) {
    if (!isRecord(comment) || !isRecord(comment.user)) continue;
    if (comment.user.login !== "github-actions[bot]") continue;
    const body = text(comment.body);
    if (!body.startsWith(LEDGER_MARKER)) continue;
    const parsed = parseLedgerComment(body);
    if (!parsed) continue;
    if (parsed.ledger.pullRequest !== pullRequest) continue;
    return {
      ledger: parsed.ledger,
      commentId: typeof comment.id === "number" ? comment.id : null,
      tampered: parsed.tampered,
    };
  }
  return { ledger: emptyLedger(pullRequest), commentId: null, tampered: false };
}

export function publishLedgerComment(
  repository: string,
  pullRequest: number,
  ledger: Ledger,
  commentId: number | null,
  tampered = false,
  ghExecutable = "gh",
): number {
  assertRepository(repository);
  const body = renderLedgerComment(ledger, tampered);
  const payload = `${JSON.stringify({ body })}\n`;
  if (commentId === null) {
    const created = ghJson(
      ["api", "--method", "POST", `repos/${repository}/issues/${pullRequest}/comments`, "--input", "-"],
      ghExecutable,
      payload,
    );
    if (!isRecord(created) || typeof created.id !== "number") {
      throw new Error("ledger comment creation returned no id");
    }
    return created.id;
  }
  ghJson(
    ["api", "--method", "PATCH", `repos/${repository}/issues/comments/${commentId}`, "--input", "-"],
    ghExecutable,
    payload,
  );
  return commentId;
}

export function actorHasWrite(repository: string, login: string, ghExecutable = "gh"): boolean {
  assertRepository(repository);
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return false;
  try {
    const response = ghJson(
      ["api", `repos/${repository}/collaborators/${login}/permission`],
      ghExecutable,
    );
    const permission = isRecord(response) ? text(response.permission) : "";
    return permission === "admin" || permission === "maintain" || permission === "write";
  } catch {
    return false;
  }
}

function react(
  repository: string,
  commentId: number,
  content: "+1" | "-1" | "confused",
  ghExecutable: string,
): void {
  try {
    ghJson(
      ["api", "--method", "POST", `repos/${repository}/issues/comments/${commentId}/reactions`, "--input", "-"],
      ghExecutable,
      `${JSON.stringify({ content })}\n`,
    );
  } catch {
    // reactions are feedback only
  }
}

export function runCommand(
  repository: string,
  pullRequest: number,
  commentId: number,
  actorLogin: string,
  now = new Date().toISOString(),
  ghExecutable = "gh",
): string {
  assertRepository(repository);
  const comment = ghJson(["api", `repos/${repository}/issues/comments/${commentId}`], ghExecutable);
  if (!isRecord(comment) || !isRecord(comment.user)) throw new Error("comment is unreadable");
  if (comment.user.login !== actorLogin) throw new Error("comment author does not match the event actor");
  if (comment.user.type === "Bot") return "ignored: bot author";
  const command = parseCommand(text(comment.body));
  if (!command) return "ignored: not a command";
  if (!actorHasWrite(repository, actorLogin, ghExecutable)) {
    react(repository, commentId, "-1", ghExecutable);
    return `denied: ${actorLogin} lacks write permission`;
  }
  const loaded = loadLedgerComment(repository, pullRequest, ghExecutable);
  let applied: { ledger: Ledger; message: string };
  try {
    applied = applyCommand(loaded.ledger, command, { login: actorLogin, at: now, commentId });
  } catch (error) {
    react(repository, commentId, "confused", ghExecutable);
    const message = error instanceof Error ? error.message : String(error);
    ghJson(
      ["api", "--method", "POST", `repos/${repository}/issues/${pullRequest}/comments`, "--input", "-"],
      ghExecutable,
      `${JSON.stringify({ body: `@${actorLogin} ${message}.\n\nUsage: \`/aida accept F# <reason>\`, \`/aida reject F# <reason>\`, \`/aida reopen F#\`, \`/aida status\`, \`/aida full\`.` })}\n`,
    );
    return `rejected: ${message}`;
  }
  // A verified command re-establishes a trusted ledger even after a hand edit.
  publishLedgerComment(repository, pullRequest, applied.ledger, loaded.commentId, false, ghExecutable);
  react(repository, commentId, "+1", ghExecutable);
  return `applied: ${applied.message}`;
}

// --- CLI ----------------------------------------------------------------------

function argValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) throw new Error(`missing ${name}`);
  return args[index + 1];
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "fetch") {
    const loaded = loadLedgerComment(argValue(args, "--repo"), Number(argValue(args, "--pr")));
    writeFileSync(
      argValue(args, "--output"),
      `${JSON.stringify({ ...loaded.ledger, tampered: loaded.tampered }, null, 2)}\n`,
    );
    process.stdout.write(`${loaded.commentId === null ? "new" : `comment ${loaded.commentId}`} tampered=${loaded.tampered}\n`);
    return;
  }
  if (command === "publish") {
    const repository = argValue(args, "--repo");
    const pullRequest = Number(argValue(args, "--pr"));
    const parsed = JSON.parse(readFileSync(argValue(args, "--input"), "utf8")) as Record<string, unknown>;
    const tampered = parsed.tampered === true;
    delete parsed.tampered;
    const ledger = validateLedger(parsed);
    const existing = loadLedgerComment(repository, pullRequest);
    const id = publishLedgerComment(repository, pullRequest, ledger, existing.commentId, tampered);
    process.stdout.write(`comment ${id}\n`);
    return;
  }
  if (command === "command") {
    const result = runCommand(
      argValue(args, "--repo"),
      Number(argValue(args, "--pr")),
      Number(argValue(args, "--comment-id")),
      argValue(args, "--actor"),
    );
    process.stdout.write(`${result}\n`);
    return;
  }
  throw new Error("usage: ai-pr-ledger.ts fetch|publish|command");
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::ai-pr-ledger ${message.replace(/[\r\n]/g, " ").slice(0, 1000)}\n`);
    process.exit(1);
  }
}
