// ai-pr-ledger.ts — the AIDA findings ledger and its `/aida` maintainer commands.
//
// The ledger is one bot-owned PR comment (found by LEDGER_MARKER) that AIDA reads
// before every review and rewrites after every publication. It gives findings a
// durable identity across heads (exact content-hash anchors, not titles) and gives
// maintainers a verified write channel: `/aida accept|reject|reopen|status`.
//
// Trust model: repository write permission, checked through the collaborators
// permission API on every command, is the only authority. Decisions enter the
// ledger only through this script after that check; the reviewing model never
// treats text it reads as a decision. The rendered comment carries a digest of
// its JSON; a hand edit is detected, its decisions are reset before ANY further
// use (review or command), and only an explicit command recreates them.

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
const MAX_COMMANDS_PER_COMMENT = 20;

export type Priority = "P0" | "P1" | "P2" | "P3";
export type DiffSide = "LEFT" | "RIGHT";
export type LedgerStatus = "open" | "resolved" | "accepted" | "rejected";
export type CommandKind = "accept" | "reject" | "reopen" | "status";

export interface LedgerAnchor {
  kind: "line" | "file" | "quote";
  path?: string;
  side?: DiffSide;
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

export type LedgerEventKind =
  | "opened"
  | "seen"
  | "resolved"
  | "accepted"
  | "rejected"
  | "reopened"
  | "suppressed";

export interface LedgerEvent {
  at: string;
  kind: LedgerEventKind;
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
  ids: string[];
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
  restatedAccepted: Array<T & { ledgerId: string }>;
  suppressed: Array<T & { ledgerId: string; decision: LedgerDecision }>;
  reopenedIds: string[];
  retained: LedgerFinding[];
  resolvedIds: string[];
}

export type AnchorPresence = (anchor: LedgerAnchor) => boolean | null;

// --- helpers ------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(ledger: Ledger): string {
  return JSON.stringify(ledger, null, 2);
}

export function rank(priority: Priority): number {
  return Number(priority.slice(1));
}

export function isBlocking(priority: Priority): boolean {
  return priority === "P0" || priority === "P1";
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
  return { version: LEDGER_VERSION, pullRequest, nextId: 1, findings: [], events: [] };
}

// Anchors hash the EXACT line bytes (only a trailing carriage return is dropped,
// so CRLF and LF checkouts agree). Indentation and spacing changes therefore
// change the anchor: a decision is bound to the code as reviewed, not to a
// whitespace-insensitive approximation of it.
export function lineAnchor(path: string, side: DiffSide, lineText: string): LedgerAnchor {
  const exact = lineText.endsWith("\r") ? lineText.slice(0, -1) : lineText;
  return { kind: "line", path, side, sha256: sha256(`line\0${path}\0${side}\0${exact}`) };
}

export function fileAnchor(path: string, contentSha256: string): LedgerAnchor {
  return { kind: "file", path, sha256: sha256(`file\0${path}\0${contentSha256}`) };
}

export function quoteAnchor(quote: string): LedgerAnchor {
  return { kind: "quote", sha256: sha256(`quote\0${quote.trim()}`) };
}

export function positionAnchor(path: string, line: number, side: DiffSide): LedgerAnchor {
  return { kind: "line", path, side, sha256: sha256(`position\0${path}\0${line}\0${side}`) };
}

// --- validation ---------------------------------------------------------------

const STATUSES: readonly LedgerStatus[] = ["open", "resolved", "accepted", "rejected"];
const PRIORITIES: readonly Priority[] = ["P0", "P1", "P2", "P3"];
const EVENT_KINDS: readonly LedgerEventKind[] = [
  "opened", "seen", "resolved", "accepted", "rejected", "reopened", "suppressed",
];

function validateAnchor(value: unknown, label: string): LedgerAnchor {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.kind !== "line" && value.kind !== "file" && value.kind !== "quote") {
    throw new Error(`${label}.kind is invalid`);
  }
  if (!/^[0-9a-f]{64}$/.test(text(value.sha256))) throw new Error(`${label}.sha256 is invalid`);
  if (value.path !== undefined && (typeof value.path !== "string" || value.path.length === 0)) {
    throw new Error(`${label}.path must be a non-empty string`);
  }
  if (value.side !== undefined && value.side !== "LEFT" && value.side !== "RIGHT") {
    throw new Error(`${label}.side is invalid`);
  }
  // Fixed key order (kind, path, side, sha256) so the digest of a parsed ledger
  // matches the digest of a freshly constructed one.
  return {
    kind: value.kind,
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(value.side === "LEFT" || value.side === "RIGHT" ? { side: value.side } : {}),
    sha256: text(value.sha256),
  };
}

function validateSeen(value: unknown, label: string): { head: string; at: string } {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (!/^[0-9a-f]{40}$/.test(text(value.head))) throw new Error(`${label}.head is invalid`);
  if (text(value.at).length === 0) throw new Error(`${label}.at is required`);
  return { head: text(value.head), at: text(value.at) };
}

function validateDecision(value: unknown, label: string): LedgerDecision {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const decision: LedgerDecision = { by: text(value.by), at: text(value.at), reason: text(value.reason) };
  if (decision.by.length === 0 || decision.at.length === 0) throw new Error(`${label} requires by and at`);
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
  if (!Number.isInteger(value.nextId) || Number(value.nextId) < 1) throw new Error("ledger.nextId is invalid");
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
    if (!PRIORITIES.includes(entry.priority as Priority)) throw new Error(`${label}.priority is invalid`);
    if (!STATUSES.includes(entry.status as LedgerStatus)) throw new Error(`${label}.status is invalid`);
    if (!Array.isArray(entry.anchors) || entry.anchors.length === 0) {
      throw new Error(`${label}.anchors must be non-empty`);
    }
    const finding: LedgerFinding = {
      id,
      priority: entry.priority as Priority,
      category: text(entry.category),
      title: text(entry.title).slice(0, 160),
      anchors: entry.anchors.map((anchor, anchorIndex) => validateAnchor(anchor, `${label}.anchors[${anchorIndex}]`)),
      status: entry.status as LedgerStatus,
      firstSeen: validateSeen(entry.firstSeen, `${label}.firstSeen`),
      lastSeen: validateSeen(entry.lastSeen, `${label}.lastSeen`),
    };
    if (finding.title.length === 0) throw new Error(`${label}.title is required`);
    if (entry.decision !== undefined) finding.decision = validateDecision(entry.decision, `${label}.decision`);
    if ((finding.status === "accepted" || finding.status === "rejected") && !finding.decision) {
      throw new Error(`${label} ${finding.status} requires a decision`);
    }
    if (finding.status === "rejected" && isBlocking(finding.priority)) {
      throw new Error(`${label} is ${finding.priority}: blocking findings cannot be rejected`);
    }
    return finding;
  });
  const events = value.events.map((entry, index): LedgerEvent => {
    const label = `ledger.events[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object`);
    if (!EVENT_KINDS.includes(entry.kind as LedgerEventKind)) throw new Error(`${label}.kind is invalid`);
    const event: LedgerEvent = { at: text(entry.at), kind: entry.kind as LedgerEventKind, by: text(entry.by) };
    if (event.at.length === 0 || event.by.length === 0) throw new Error(`${label} requires at and by`);
    if (typeof entry.id === "string") event.id = entry.id;
    if (typeof entry.head === "string") event.head = entry.head;
    if (typeof entry.reason === "string") event.reason = entry.reason.slice(0, MAX_REASON_LENGTH);
    if (typeof entry.commentId === "number") event.commentId = entry.commentId;
    return event;
  });
  const maxId = findings.reduce((max, finding) => Math.max(max, Number(finding.id.slice(1))), 0);
  if (Number(value.nextId) <= maxId) throw new Error("ledger.nextId must exceed every finding id");
  return { version: LEDGER_VERSION, pullRequest: Number(value.pullRequest), nextId: Number(value.nextId), findings, events };
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

export function openBlockingCount(ledger: Ledger): number {
  return ledger.findings.filter(finding => finding.status === "open" && isBlocking(finding.priority)).length;
}

export function renderLedgerComment(input: Ledger, tampered = false): string {
  const ledger = validateLedger(input);
  const digest = ledgerDigest(ledger);
  const lines = [`${LEDGER_MARKER} digest=${digest} -->`, "## AIDA findings ledger", ""];
  if (tampered) {
    lines.push(
      "> ⚠️ This comment was edited outside AIDA. Decisions recorded by that edit were reset (an unreadable edit resets the whole ledger); restate them with `/aida` commands.",
      "",
    );
  }
  if (ledger.findings.length === 0) {
    lines.push("No findings recorded yet.", "");
  } else {
    lines.push("| ID | Sev | Status | Title | Decided by |", "|----|-----|--------|-------|------------|");
    for (const finding of ledger.findings) {
      const decided = finding.decision
        ? `@${escapeCell(finding.decision.by)} · ${finding.decision.at.slice(0, 10)}${
          finding.decision.reason ? ` · *${escapeCell(finding.decision.reason)}*` : ""
        }`
        : finding.status === "resolved"
          ? `AIDA · ${finding.lastSeen.head.slice(0, 8)}`
          : "—";
      lines.push(`| ${finding.id} | ${finding.priority} | ${STATUS_LABEL[finding.status]} | ${escapeCell(finding.title)} | ${decided} |`);
    }
    lines.push("");
  }
  lines.push(
    `Open blocking findings (P0/P1): **${openBlockingCount(ledger)}**. Accepted and rejected findings never count toward the next action.`,
    "",
    "Maintainer commands (repository write access) — put them on the first lines of a comment, one per line, several ids per line allowed:",
    "`/aida accept F# [F#…] <reason>` · `/aida reject F# [F#…] <reason>` · `/aida reopen F# [F#…]` · `/aida status`",
    "P0 and P1 findings can be accepted (visible, risk owned by the maintainer) but not rejected. A comment is applied all-or-nothing.",
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
  return { ledger, tampered: !digestMatch || digestMatch[1] !== ledgerDigest(ledger) };
}

// --- decisions ----------------------------------------------------------------

export interface CommandActor {
  login: string;
  at: string;
  commentId?: number;
}

function pushEvent(ledger: Ledger, event: LedgerEvent): void {
  ledger.events.push(event);
  if (ledger.events.length > MAX_EVENTS) ledger.events = ledger.events.slice(ledger.events.length - MAX_EVENTS);
}

// Decisions written by a hand edit were never verified. Reset them so nothing
// downstream — a review or an unrelated command — can authenticate them.
export function resetUnverifiedDecisions(ledger: Ledger, at: string): string[] {
  const reset: string[] = [];
  for (const entry of ledger.findings) {
    if (entry.status !== "accepted" && entry.status !== "rejected") continue;
    entry.status = "open";
    delete entry.decision;
    pushEvent(ledger, { at, kind: "reopened", by: "aida", id: entry.id, reason: "unverified ledger edit" });
    reset.push(entry.id);
  }
  return reset;
}

// Commands are the leading block of a comment: consecutive non-blank lines that
// each start with `/aida`. Parsing stops at the first other line, so a command
// quoted or discussed lower in the comment never fires. A line may name several
// findings; the reason is everything after the last id.
export function parseCommands(body: string): LedgerCommand[] {
  const commands: LedgerCommand[] = [];
  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (commands.length === 0) continue;
      break;
    }
    const match = /^\/aida\s+(accept|reject|reopen|status)\b(.*)$/.exec(line);
    if (!match) break;
    const kind = match[1] as CommandKind;
    const rest = match[2].trim();
    const ids: string[] = [];
    let remainder = rest;
    for (;;) {
      const idMatch = /^(F[1-9][0-9]*)(?:\s+|$)/.exec(remainder);
      if (!idMatch) break;
      ids.push(idMatch[1]);
      remainder = remainder.slice(idMatch[0].length);
    }
    const command: LedgerCommand = { kind, ids: [...new Set(ids)] };
    if (remainder.trim().length > 0) command.reason = remainder.trim().slice(0, MAX_REASON_LENGTH);
    commands.push(command);
    if (commands.length > MAX_COMMANDS_PER_COMMENT) throw new Error(`more than ${MAX_COMMANDS_PER_COMMENT} commands in one comment`);
  }
  return commands;
}

// All-or-nothing: every command in the comment must be valid before any is kept.
export function applyCommands(
  ledger: Ledger,
  commands: LedgerCommand[],
  actor: CommandActor,
): { ledger: Ledger; messages: string[] } {
  if (commands.length === 0) throw new Error("no command to apply");
  const next: Ledger = structuredClone(ledger);
  const messages: string[] = [];
  const event = (kind: LedgerEventKind, extra: Partial<LedgerEvent>): void => {
    const entry: LedgerEvent = { at: actor.at, kind, by: actor.login, ...extra };
    if (actor.commentId !== undefined) entry.commentId = actor.commentId;
    pushEvent(next, entry);
  };
  commands.forEach((command, index) => {
    const where = commands.length > 1 ? `line ${index + 1}: ` : "";
    if (command.kind === "status") {
      if (command.ids.length > 0 || command.reason) throw new Error(`${where}/aida status takes no arguments`);
      messages.push("Ledger re-rendered.");
      return;
    }
    if (command.ids.length === 0) throw new Error(`${where}/aida ${command.kind} requires at least one finding id such as F1`);
    if (command.kind !== "reopen" && !command.reason) {
      throw new Error(`${where}/aida ${command.kind} ${command.ids.join(" ")} requires a reason after the id(s)`);
    }
    for (const id of command.ids) {
      const finding = next.findings.find(entry => entry.id === id);
      if (!finding) throw new Error(`${where}unknown finding ${id}`);
      if (command.kind === "reopen") {
        if (finding.status === "open") throw new Error(`${where}${id} is already open`);
        finding.status = "open";
        delete finding.decision;
        event("reopened", { id });
        messages.push(`${id} reopened.`);
        continue;
      }
      if (command.kind === "reject" && isBlocking(finding.priority)) {
        throw new Error(`${where}${id} is ${finding.priority}: blocking findings can be accepted (risk owned by you), not rejected`);
      }
      if (finding.status === "resolved") throw new Error(`${where}${id} is already resolved`);
      const decision: LedgerDecision = { by: actor.login, at: actor.at, reason: command.reason ?? "" };
      if (actor.commentId !== undefined) decision.commentId = actor.commentId;
      finding.status = command.kind === "accept" ? "accepted" : "rejected";
      finding.decision = decision;
      event(finding.status, { id, reason: command.reason });
      messages.push(`${id} ${finding.status} by @${actor.login}: ${command.reason}`);
    }
  });
  return { ledger: next, messages };
}

// --- reconciliation ---------------------------------------------------------

function anchorSet(anchors: LedgerAnchor[]): Set<string> {
  return new Set(anchors.map(anchor => anchor.sha256));
}

function coveredBy(anchors: LedgerAnchor[], known: Set<string>): boolean {
  return anchors.every(anchor => known.has(anchor.sha256));
}

export function reconcileLedger<T extends ReviewFindingInput>(
  loaded: LoadedLedger,
  findings: T[],
  head: string,
  at: string,
  presentAtHead: AnchorPresence,
): ReconcileResult<T> {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("head must be a 40-character SHA");
  const ledger: Ledger = structuredClone(loaded.ledger);
  const result: ReconcileResult<T> = {
    ledger, kept: [], restatedAccepted: [], suppressed: [], reopenedIds: [], retained: [], resolvedIds: [],
  };
  if (loaded.tampered) resetUnverifiedDecisions(ledger, at);
  const matchedIds = new Set<string>();
  const push = (kind: LedgerEventKind, id: string, extra: Partial<LedgerEvent> = {}): void => {
    pushEvent(ledger, { at, kind, by: "aida", id, head, ...extra });
  };

  for (const finding of findings) {
    const hashes = anchorSet(finding.anchors);
    const match = ledger.findings.find(
      entry => entry.status !== "resolved" && !matchedIds.has(entry.id) && entry.anchors.some(anchor => hashes.has(anchor.sha256)),
    );
    if (!match) {
      const id = `F${ledger.nextId}`;
      ledger.nextId += 1;
      ledger.findings.push({
        id, priority: finding.priority, category: finding.category, title: finding.title,
        anchors: finding.anchors, status: "open", firstSeen: { head, at }, lastSeen: { head, at },
      });
      push("opened", id);
      result.kept.push({ ...finding, ledgerId: id });
      continue;
    }
    matchedIds.add(match.id);
    match.lastSeen = { head, at };
    const known = anchorSet(match.anchors);
    // A decision covers exactly the evidence and severity it was made on. New
    // cited lines or a higher priority are new evidence: the decision is
    // reopened rather than stretched over it.
    const decided = match.status === "accepted" || match.status === "rejected";
    const expanded = !coveredBy(finding.anchors, known);
    const escalated = rank(finding.priority) < rank(match.priority);
    if (decided && match.decision && !expanded && !escalated) {
      if (match.status === "rejected") {
        push("suppressed", match.id);
        result.suppressed.push({ ...finding, ledgerId: match.id, decision: match.decision });
      } else {
        push("seen", match.id);
        result.restatedAccepted.push({ ...finding, ledgerId: match.id });
      }
      continue;
    }
    if (decided) {
      match.status = "open";
      delete match.decision;
      push("reopened", match.id, { reason: expanded ? "new evidence: cited lines expanded" : "new evidence: priority escalated" });
      result.reopenedIds.push(match.id);
    } else {
      push("seen", match.id);
    }
    for (const anchor of finding.anchors) if (!known.has(anchor.sha256)) match.anchors.push(anchor);
    match.priority = finding.priority;
    match.title = finding.title;
    match.category = finding.category;
    result.kept.push({ ...finding, ledgerId: match.id });
  }

  for (const entry of ledger.findings) {
    if (entry.status !== "open" || matchedIds.has(entry.id)) continue;
    // Conservative closure: an open finding the judge did not restate is resolved
    // only when every anchor is positively gone from the head. Unknown presence
    // (deleted lines, fallback positions, metadata quotes) never resolves it. An
    // unresolved open blocker stays verdict-bearing: it is retained.
    const verdicts = entry.anchors.map(anchor => presentAtHead(anchor));
    if (verdicts.length > 0 && verdicts.every(verdict => verdict === false)) {
      entry.status = "resolved";
      entry.lastSeen = { head, at };
      push("resolved", entry.id);
      result.resolvedIds.push(entry.id);
    } else if (isBlocking(entry.priority)) {
      result.retained.push(structuredClone(entry));
    }
  }
  return result;
}

// Accepted risks are rendered from persisted state, not from a restatement the
// judge is told not to make. An accepted entry whose anchors are positively gone
// is omitted (the code it covered no longer exists).
export function acceptedRisks(ledger: Ledger, presentAtHead: AnchorPresence): LedgerFinding[] {
  return ledger.findings.filter(entry => {
    if (entry.status !== "accepted") return false;
    const verdicts = entry.anchors.map(anchor => presentAtHead(anchor));
    return !(verdicts.length > 0 && verdicts.every(verdict => verdict === false));
  }).map(entry => structuredClone(entry));
}

// Deterministic merge for the publish-time compare-and-swap. A maintainer action
// (accept / reject / reopen by a non-AIDA actor) that the live ledger records for
// a finding and the review's copy does not is newer than the review's snapshot:
// the live status and decision win for that finding. Everything else is the
// review's. Events are unioned; ids never renumber.
export function mergeLedgers(base: Ledger, live: Ledger): Ledger {
  const merged: Ledger = structuredClone(base);
  const latestMaintainerAction = (ledger: Ledger, id: string): string => {
    let latest = "";
    for (const event of ledger.events) {
      if (event.id !== id || event.by === "aida") continue;
      if (event.kind !== "accepted" && event.kind !== "rejected" && event.kind !== "reopened") continue;
      if (event.at > latest) latest = event.at;
    }
    return latest;
  };
  for (const liveEntry of live.findings) {
    const own = merged.findings.find(entry => entry.id === liveEntry.id);
    if (!own) {
      merged.findings.push(structuredClone(liveEntry));
      continue;
    }
    if (latestMaintainerAction(live, liveEntry.id) > latestMaintainerAction(base, liveEntry.id)) {
      own.status = liveEntry.status;
      if (liveEntry.decision) own.decision = structuredClone(liveEntry.decision);
      else delete own.decision;
    }
  }
  const seenEvents = new Set(merged.events.map(event => JSON.stringify(event)));
  for (const event of live.events) {
    const key = JSON.stringify(event);
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    merged.events.push(structuredClone(event));
  }
  merged.events.sort((left, right) => left.at.localeCompare(right.at));
  if (merged.events.length > MAX_EVENTS) merged.events = merged.events.slice(merged.events.length - MAX_EVENTS);
  merged.nextId = Math.max(base.nextId, live.nextId, ...merged.findings.map(entry => Number(entry.id.slice(1)) + 1));
  return validateLedger(merged);
}

// --- head content lookup (for anchors) ---------------------------------------

function confined(root: string, path: string): string | null {
  const target = resolve(root, path);
  return target.startsWith(`${root}${sep}`) ? target : null;
}

export function readContextLine(contextDir: string, repoDir: string, path: string, line: number, side: DiffSide): string | null {
  const root = side === "RIGHT" ? resolve(contextDir, "head") : resolve(repoDir);
  const target = confined(root, path);
  if (!target || !existsSync(target)) return null;
  const lines = readFileSync(target, "utf8").split("\n");
  if (line < 1 || line > lines.length) return null;
  return lines[line - 1];
}

export function headFileSha256(contextDir: string, path: string): string | null {
  const target = confined(resolve(contextDir, "head"), path);
  if (!target || !existsSync(target)) return null;
  return sha256(readFileSync(target));
}

// true: the anchored content is still present at the head; false: positively
// gone; null: unknown (deleted-line, fallback-position, and metadata anchors are
// never resolved from head contents alone).
export function headContainsAnchor(contextDir: string, anchor: LedgerAnchor): boolean | null {
  if (!anchor.path) return null;
  if (anchor.kind === "file") {
    const current = headFileSha256(contextDir, anchor.path);
    if (current === null) return null;
    return fileAnchor(anchor.path, current).sha256 === anchor.sha256;
  }
  if (anchor.kind !== "line" || anchor.side !== "RIGHT") return null;
  const target = confined(resolve(contextDir, "head"), anchor.path);
  if (!target || !existsSync(target)) return null;
  const path = anchor.path;
  return readFileSync(target, "utf8").split("\n").some(lineText => lineAnchor(path, "RIGHT", lineText).sha256 === anchor.sha256);
}

// --- GitHub I/O ---------------------------------------------------------------

function ghJson(args: string[], ghExecutable: string, input?: string): unknown {
  const raw = execFileSync(ghExecutable, args, {
    encoding: "utf8", input, maxBuffer: Number.POSITIVE_INFINITY,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  return raw.trim().length === 0 ? null : JSON.parse(raw);
}

function assertRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("repository must use owner/name format");
}

export function loadLedgerComment(repository: string, pullRequest: number, ghExecutable = "gh"): LoadedLedger {
  assertRepository(repository);
  const pages = ghJson(["api", "--paginate", "--slurp", `repos/${repository}/issues/${pullRequest}/comments`], ghExecutable);
  const comments = Array.isArray(pages) ? pages.flat() : [];
  for (const comment of comments) {
    if (!isRecord(comment) || !isRecord(comment.user) || comment.user.login !== "github-actions[bot]") continue;
    const body = text(comment.body);
    if (!body.startsWith(LEDGER_MARKER)) continue;
    const commentId = typeof comment.id === "number" ? comment.id : null;
    let parsed: { ledger: Ledger; tampered: boolean } | null;
    try {
      parsed = parseLedgerComment(body);
    } catch {
      // A hand edit that left the JSON unreadable is still a tamper, not an
      // outage: start from an empty ledger flagged tampered so the review runs
      // and the republished comment says what happened. Prior review bodies
      // still hold every finding that was ever reported.
      return { ledger: emptyLedger(pullRequest), commentId, tampered: true };
    }
    if (!parsed || parsed.ledger.pullRequest !== pullRequest) continue;
    return { ledger: parsed.ledger, commentId, tampered: parsed.tampered };
  }
  return { ledger: emptyLedger(pullRequest), commentId: null, tampered: false };
}

export function publishLedgerComment(
  repository: string, pullRequest: number, ledger: Ledger, commentId: number | null, tampered = false, ghExecutable = "gh",
): number {
  assertRepository(repository);
  const payload = `${JSON.stringify({ body: renderLedgerComment(ledger, tampered) })}\n`;
  if (commentId === null) {
    const created = ghJson(["api", "--method", "POST", `repos/${repository}/issues/${pullRequest}/comments`, "--input", "-"], ghExecutable, payload);
    if (!isRecord(created) || typeof created.id !== "number") throw new Error("ledger comment creation returned no id");
    return created.id;
  }
  ghJson(["api", "--method", "PATCH", `repos/${repository}/issues/comments/${commentId}`, "--input", "-"], ghExecutable, payload);
  return commentId;
}

export function actorHasWrite(repository: string, login: string, ghExecutable = "gh"): boolean {
  assertRepository(repository);
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return false;
  try {
    const response = ghJson(["api", `repos/${repository}/collaborators/${login}/permission`], ghExecutable);
    const permission = isRecord(response) ? text(response.permission) : "";
    return permission === "admin" || permission === "maintain" || permission === "write";
  } catch {
    return false;
  }
}

function react(repository: string, commentId: number, content: "+1" | "-1" | "confused", ghExecutable: string): void {
  try {
    ghJson(["api", "--method", "POST", `repos/${repository}/issues/comments/${commentId}/reactions`, "--input", "-"], ghExecutable, `${JSON.stringify({ content })}\n`);
  } catch {
    // reactions are feedback only
  }
}

const USAGE = "Usage: put commands on the first lines of a comment, one per line — `/aida accept F# [F#…] <reason>`, `/aida reject F# [F#…] <reason>`, `/aida reopen F# [F#…]`, `/aida status`. Nothing was applied.";

export interface CommandOutcome {
  status: "applied" | "denied" | "ignored" | "rejected";
  message: string;
  openBlocking: number | null;
}

export function runCommand(
  repository: string, pullRequest: number, commentId: number, actorLogin: string,
  now = new Date().toISOString(), ghExecutable = "gh",
): CommandOutcome {
  assertRepository(repository);
  const comment = ghJson(["api", `repos/${repository}/issues/comments/${commentId}`], ghExecutable);
  if (!isRecord(comment) || !isRecord(comment.user)) throw new Error("comment is unreadable");
  if (comment.user.login !== actorLogin) throw new Error("comment author does not match the event actor");
  if (comment.user.type === "Bot") return { status: "ignored", message: "bot author", openBlocking: null };
  let commands: LedgerCommand[];
  try {
    commands = parseCommands(text(comment.body));
  } catch (error) {
    react(repository, commentId, "confused", ghExecutable);
    return { status: "rejected", message: error instanceof Error ? error.message : String(error), openBlocking: null };
  }
  if (commands.length === 0) return { status: "ignored", message: "not a command", openBlocking: null };
  if (!actorHasWrite(repository, actorLogin, ghExecutable)) {
    react(repository, commentId, "-1", ghExecutable);
    return { status: "denied", message: `${actorLogin} lacks write permission`, openBlocking: null };
  }
  const loaded = loadLedgerComment(repository, pullRequest, ghExecutable);
  const ledger = structuredClone(loaded.ledger);
  if (loaded.tampered) resetUnverifiedDecisions(ledger, now);
  let applied: { ledger: Ledger; messages: string[] };
  try {
    applied = applyCommands(ledger, commands, { login: actorLogin, at: now, commentId });
  } catch (error) {
    react(repository, commentId, "confused", ghExecutable);
    const message = error instanceof Error ? error.message : String(error);
    ghJson(
      ["api", "--method", "POST", `repos/${repository}/issues/${pullRequest}/comments`, "--input", "-"],
      ghExecutable,
      `${JSON.stringify({ body: `@${actorLogin} ${message}.\n\n${USAGE}` })}\n`,
    );
    return { status: "rejected", message, openBlocking: null };
  }
  publishLedgerComment(repository, pullRequest, applied.ledger, loaded.commentId, false, ghExecutable);
  react(repository, commentId, "+1", ghExecutable);
  return { status: "applied", message: applied.messages.join(" "), openBlocking: openBlockingCount(applied.ledger) };
}

// --- CLI ----------------------------------------------------------------------

function argValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) throw new Error(`missing ${name}`);
  return args[index + 1];
}

function readLedgerFile(path: string): { ledger: Ledger; tampered: boolean } {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const tampered = parsed.tampered === true;
  delete parsed.tampered;
  return { ledger: validateLedger(parsed), tampered };
}

function writeLedgerFile(path: string, ledger: Ledger, tampered: boolean): void {
  writeFileSync(path, `${JSON.stringify({ ...ledger, tampered }, null, 2)}\n`);
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "fetch") {
    const loaded = loadLedgerComment(argValue(args, "--repo"), Number(argValue(args, "--pr")));
    writeLedgerFile(argValue(args, "--output"), loaded.ledger, loaded.tampered);
    process.stdout.write(`${loaded.commentId === null ? "new" : `comment ${loaded.commentId}`} tampered=${loaded.tampered}\n`);
    return;
  }
  if (command === "merge") {
    // Compare-and-swap input for publication: the review's pre-review snapshot
    // merged with the live comment, so maintainer decisions made while the
    // models ran are applied before the verdict is published.
    const snapshot = readLedgerFile(argValue(args, "--input"));
    const live = loadLedgerComment(argValue(args, "--repo"), Number(argValue(args, "--pr")));
    const base = structuredClone(snapshot.ledger);
    if (snapshot.tampered) resetUnverifiedDecisions(base, new Date().toISOString());
    const liveLedger = structuredClone(live.ledger);
    if (live.tampered) resetUnverifiedDecisions(liveLedger, new Date().toISOString());
    const merged = mergeLedgers(base, liveLedger);
    writeLedgerFile(argValue(args, "--output"), merged, false);
    process.stdout.write(`${ledgerDigest(merged) === ledgerDigest(base) ? "unchanged" : "changed"}\n`);
    return;
  }
  if (command === "publish") {
    const repository = argValue(args, "--repo");
    const pullRequest = Number(argValue(args, "--pr"));
    const input = readLedgerFile(argValue(args, "--input"));
    const existing = loadLedgerComment(repository, pullRequest);
    const id = publishLedgerComment(repository, pullRequest, input.ledger, existing.commentId, false);
    process.stdout.write(`comment ${id}\n`);
    return;
  }
  if (command === "command") {
    const outcome = runCommand(argValue(args, "--repo"), Number(argValue(args, "--pr")), Number(argValue(args, "--comment-id")), argValue(args, "--actor"));
    if (args.includes("--state-output")) writeFileSync(argValue(args, "--state-output"), `${JSON.stringify(outcome)}\n`);
    process.stdout.write(`${outcome.status}: ${outcome.message}\n`);
    return;
  }
  throw new Error("usage: ai-pr-ledger.ts fetch|merge|publish|command");
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
