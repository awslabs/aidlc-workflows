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
// its JSON; an edited comment fails verification and is refused (fail closed):
// nothing downstream ever treats unverified state as authenticated.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export const LEDGER_MARKER = "<!-- aida-ledger";
export const LEDGER_VERSION = 2 as const;
const LEGACY_LEDGER_VERSION = 1;
const MAX_REASON_LENGTH = 500;
const MAX_LEDGER_BYTES = 200_000;
// The writer compacts to this before publishing so the reader's cap is never hit.
const TARGET_LEDGER_BYTES = 150_000;
const MAX_FINDINGS = 200;
const MAX_EVENTS = 1000;
const MAX_COMMANDS_PER_COMMENT = 20;

export type Priority = "P0" | "P1" | "P2" | "P3";
export type DiffSide = "LEFT" | "RIGHT";
export type LedgerStatus = "open" | "resolved" | "accepted" | "rejected";
export type CommandKind = "accept" | "reject" | "reopen" | "status";

export interface LedgerAnchor {
  kind: "line" | "position" | "file" | "quote";
  path?: string;
  side?: DiffSide;
  line?: number;
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

// The verdict AIDA published for a head, kept so a later /aida command can
// re-derive the decision under the SAME invariants without rerunning models.
export interface LedgerReview {
  head: string;
  readiness: number;
  risk: number;
  decision: "merge" | "change";
}

export interface Ledger {
  version: typeof LEDGER_VERSION;
  pullRequest: number;
  nextId: number;
  findings: LedgerFinding[];
  events: LedgerEvent[];
  review?: LedgerReview;
}

export interface LoadedLedger {
  ledger: Ledger;
  commentId: number | null;
  // The digest string the comment carried when read; the compare-and-swap on
  // publication refuses to overwrite a comment that no longer carries it.
  digest: string | null;
  // true when the comment held a version-1 ledger: its anchors cannot be
  // evaluated against any head and its decisions were reset on migration.
  migrated: boolean;
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
  // `priority` on a kept entry is the ledger's effective priority: a restatement
  // never lowers an open finding's priority.
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

// The fallback when a cited line has no readable text. Its presence at a head is
// unknowable, so it identifies a finding but never retains one.
export function positionAnchor(path: string, line: number, side: DiffSide): LedgerAnchor {
  return { kind: "position", path, side, line, sha256: sha256(`position\0${path}\0${line}\0${side}`) };
}

// --- validation ---------------------------------------------------------------

const STATUSES: readonly LedgerStatus[] = ["open", "resolved", "accepted", "rejected"];
const PRIORITIES: readonly Priority[] = ["P0", "P1", "P2", "P3"];
const EVENT_KINDS: readonly LedgerEventKind[] = [
  "opened", "seen", "resolved", "accepted", "rejected", "reopened", "suppressed",
];

function validateAnchor(value: unknown, label: string): LedgerAnchor {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.kind !== "line" && value.kind !== "position" && value.kind !== "file" && value.kind !== "quote") {
    throw new Error(`${label}.kind is invalid`);
  }
  if (value.line !== undefined && (!Number.isInteger(value.line) || Number(value.line) < 1)) {
    throw new Error(`${label}.line must be a positive integer`);
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
    ...(typeof value.line === "number" ? { line: value.line } : {}),
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
  const ledger: Ledger = { version: LEDGER_VERSION, pullRequest: Number(value.pullRequest), nextId: Number(value.nextId), findings, events };
  if (value.review !== undefined) ledger.review = validateReview(value.review);
  return ledger;
}

function validateReview(value: unknown): LedgerReview {
  if (!isRecord(value)) throw new Error("ledger.review must be an object");
  if (!/^[0-9a-f]{40}$/.test(text(value.head))) throw new Error("ledger.review.head is invalid");
  const score = (name: "readiness" | "risk"): number => {
    const raw = value[name];
    if (!Number.isInteger(raw) || Number(raw) < 1 || Number(raw) > 5) throw new Error(`ledger.review.${name} must be 1..5`);
    return Number(raw);
  };
  if (value.decision !== "merge" && value.decision !== "change") throw new Error("ledger.review.decision is invalid");
  return { head: text(value.head), readiness: score("readiness"), risk: score("risk"), decision: value.decision };
}

// Migration of a version-1 ledger. Findings and ids survive so nothing is
// renumbered. Version-1 anchors (side-less, whitespace-normalized hashes) cannot
// be evaluated against any head: they become position anchors, which identify
// a finding but never retain one, so the next review resolves the ones the judge
// no longer reports. Decisions cannot be authenticated under the new digest and
// are reset. Any hash or shape change to the ledger MUST bump LEDGER_VERSION and
// extend this function in the same commit.
export function migrateLegacyLedger(value: unknown, at: string): Ledger {
  if (!isRecord(value) || value.version !== LEGACY_LEDGER_VERSION || !Array.isArray(value.findings)) {
    throw new Error("not a version-1 ledger");
  }
  const findings = value.findings.map(entry => {
    if (!isRecord(entry) || !Array.isArray(entry.anchors)) return entry;
    const anchors = entry.anchors.map(anchor =>
      isRecord(anchor)
        ? { kind: "position", ...(typeof anchor.path === "string" ? { path: anchor.path } : {}), sha256: anchor.sha256 }
        : anchor,
    );
    return { ...entry, anchors };
  });
  const ledger = validateLedger({ ...value, version: LEDGER_VERSION, findings, review: undefined });
  resetDecisions(ledger, at, "ledger schema migration");
  return ledger;
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

// Keeps the serialized ledger under the reader's budget. History goes first
// (oldest events), then the oldest resolved findings; open, accepted and rejected
// findings and ids are never dropped. Earlier review bodies keep the full record.
export function compactLedger(input: Ledger, budget = TARGET_LEDGER_BYTES): Ledger {
  const ledger = structuredClone(input);
  const size = (): number => Buffer.byteLength(canonicalJson(ledger), "utf8");
  while (size() > budget && ledger.events.length > 0) {
    ledger.events.splice(0, Math.max(1, Math.floor(ledger.events.length / 10)));
  }
  while (size() > budget) {
    const index = ledger.findings.findIndex(entry => entry.status === "resolved");
    if (index === -1) break;
    ledger.findings.splice(index, 1);
  }
  if (size() > MAX_LEDGER_BYTES) throw new Error("ledger cannot be compacted under the size budget");
  return ledger;
}

export function renderLedgerComment(input: Ledger, migrated = false): string {
  const ledger = compactLedger(validateLedger(input));
  const digest = ledgerDigest(ledger);
  const lines = [`${LEDGER_MARKER} v${LEDGER_VERSION} digest=${digest} -->`, "## AIDA findings ledger", ""];
  if (migrated) {
    lines.push(
      "> ℹ️ Migrated from ledger schema v1. Earlier decisions were reset; restate them with `/aida` commands. Findings recorded under the old schema resolve once a review no longer reports them.",
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
    "Do not edit this comment: AIDA verifies its digest and refuses to run on an edited ledger. To start over, delete it.",
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

// Returns null for a comment that is not a ledger. Throws for a ledger comment
// that cannot be trusted (unreadable JSON, invalid shape, digest mismatch): the
// caller fails closed rather than acting on unverified state. A version-1
// ledger is migrated instead of verified; `digest` is the marker's digest as
// read, for the publish-time compare-and-swap.
export function parseLedgerComment(
  body: string,
  at = new Date().toISOString(),
): { ledger: Ledger; migrated: boolean; digest: string | null } | null {
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
  const digest = digestMatch ? digestMatch[1] : null;
  if (isRecord(parsed) && parsed.version === LEGACY_LEDGER_VERSION) {
    return { ledger: migrateLegacyLedger(parsed, at), migrated: true, digest };
  }
  const ledger = validateLedger(parsed);
  if (digest !== ledgerDigest(ledger)) throw new Error("ledger comment was edited outside AIDA (digest mismatch)");
  return { ledger, migrated: false, digest };
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

// Reopens every decided finding (used by schema migration, where decisions can
// no longer be authenticated). Only an explicit /aida command recreates them.
export function resetDecisions(ledger: Ledger, at: string, reason: string): string[] {
  const reset: string[] = [];
  for (const entry of ledger.findings) {
    if (entry.status !== "accepted" && entry.status !== "rejected") continue;
    entry.status = "open";
    delete entry.decision;
    pushEvent(ledger, { at, kind: "reopened", by: "aida", id: entry.id, reason });
    reset.push(entry.id);
  }
  return reset;
}

// The one decision rule shared by the review (after ledger decisions apply) and
// by a later /aida command (without rerunning models). Mirrors the validator's
// invariants: merge needs no open blocker and readiness >= 4, risk <= 2; a
// stored `change` flips to merge only when no open finding remains at all.
export function deriveDecision(
  stored: "merge" | "change",
  openBlocking: number,
  openAny: number,
  readiness: number,
  risk: number,
): "merge" | "change" {
  if (openBlocking > 0) return "change";
  const scoresPermitMerge = readiness >= 4 && risk <= 2;
  if (stored === "merge") return scoresPermitMerge ? "merge" : "change";
  return openAny === 0 && scoresPermitMerge ? "merge" : "change";
}

export interface LedgerVerdict {
  head: string;
  decision: "merge" | "change";
  openBlocking: number;
}

// The effective verdict for the head AIDA last reviewed, from persisted state
// alone: the open findings that were reported or retained at that head plus the
// stored scores and decision.
export function ledgerVerdict(ledger: Ledger): LedgerVerdict | null {
  const review = ledger.review;
  if (!review) return null;
  // Every open finding counts, whatever head last saw it: a finding the judge was
  // told not to restate (accepted) and a maintainer then reopens is open at this
  // head even though no review has restated it yet.
  const open = ledger.findings.filter(entry => entry.status === "open");
  const openBlocking = open.filter(entry => isBlocking(entry.priority)).length;
  return {
    head: review.head,
    openBlocking,
    decision: deriveDecision(review.decision, openBlocking, open.length, review.readiness, review.risk),
  };
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
  const matchedIds = new Set<string>();
  const push = (kind: LedgerEventKind, id: string, extra: Partial<LedgerEvent> = {}): void => {
    pushEvent(ledger, { at, kind, by: "aida", id, head, ...extra });
  };

  for (const finding of findings) {
    const hashes = anchorSet(finding.anchors);
    // Identity is a defect fingerprint: the same category AND at least one shared
    // exact anchor. A different category on the same lines is a different
    // finding and never inherits another finding's decision.
    const match = ledger.findings.find(
      entry =>
        entry.status !== "resolved" &&
        !matchedIds.has(entry.id) &&
        entry.category === finding.category &&
        entry.anchors.some(anchor => hashes.has(anchor.sha256)),
    );
    if (!match) {
      const id = `F${ledger.nextId}`;
      ledger.nextId += 1;
      ledger.findings.push({
        id, priority: finding.priority, category: finding.category, title: finding.title,
        anchors: finding.anchors, status: "open", firstSeen: { head, at }, lastSeen: { head, at },
      });
      push("opened", id);
      matchedIds.add(id);
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
    // A restatement never lowers an open finding's priority: the ledger keeps the
    // higher one (and its title). Only changed code or a maintainer decision
    // retires a blocker.
    if (rank(finding.priority) <= rank(match.priority)) {
      match.priority = finding.priority;
      match.title = finding.title;
    }
    result.kept.push({ ...finding, priority: match.priority, ledgerId: match.id });
  }

  for (const entry of ledger.findings) {
    if (entry.status !== "open" || matchedIds.has(entry.id)) continue;
    // Retention needs positive presence. An open finding the judge did not
    // restate is retained (verdict-bearing when blocking) only while at least
    // one of its anchors is provably still at the head. Otherwise it resolves:
    // either the cited code is gone, or nothing about it can be evaluated (a
    // deleted line, a position, a quote, a migrated anchor) and the judge, who
    // read the head, no longer reports it. Unknown never means retained forever.
    const verdicts = entry.anchors.map(anchor => presentAtHead(anchor));
    if (verdicts.some(verdict => verdict === true)) {
      if (!isBlocking(entry.priority)) continue;
      entry.lastSeen = { head, at };
      push("seen", entry.id, { reason: "retained: not restated, cited code unchanged" });
      result.retained.push(structuredClone(entry));
      continue;
    }
    entry.status = "resolved";
    entry.lastSeen = { head, at };
    push("resolved", entry.id, {
      reason: verdicts.every(verdict => verdict === false) ? "cited code is gone" : "not restated; cited code not evaluable at this head",
    });
    result.resolvedIds.push(entry.id);
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
// gone (including a file that no longer exists at the head); null: unknown
// (deleted-line, position, and quote anchors cannot be evaluated from head
// contents).
export function headContainsAnchor(contextDir: string, anchor: LedgerAnchor): boolean | null {
  if (!anchor.path || anchor.kind === "position" || anchor.kind === "quote") return null;
  if (anchor.kind === "line" && anchor.side !== "RIGHT") return null;
  const target = confined(resolve(contextDir, "head"), anchor.path);
  if (!target) return null;
  if (!existsSync(target)) return false;
  const path = anchor.path;
  if (anchor.kind === "file") return fileAnchor(path, sha256(readFileSync(target))).sha256 === anchor.sha256;
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

export function loadLedgerComment(
  repository: string,
  pullRequest: number,
  ghExecutable = "gh",
  at = new Date().toISOString(),
): LoadedLedger {
  assertRepository(repository);
  const pages = ghJson(["api", "--paginate", "--slurp", `repos/${repository}/issues/${pullRequest}/comments`], ghExecutable);
  const comments = Array.isArray(pages) ? pages.flat() : [];
  for (const comment of comments) {
    if (!isRecord(comment) || !isRecord(comment.user) || comment.user.login !== "github-actions[bot]") continue;
    const body = text(comment.body);
    if (!body.startsWith(LEDGER_MARKER)) continue;
    const commentId = typeof comment.id === "number" ? comment.id : null;
    let parsed: ReturnType<typeof parseLedgerComment>;
    try {
      parsed = parseLedgerComment(body, at);
    } catch (error) {
      // Fail closed. An edited or unreadable ledger is never replaced by a guess
      // (an empty ledger would advertise zero blockers). A maintainer restores
      // the body from the comment's edit history or deletes the comment to start
      // a fresh ledger; earlier review bodies keep every finding ever reported.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `ledger comment ${commentId ?? "?"} on PR #${pullRequest} cannot be used (${reason}). Restore its body from the comment's edit history, or delete the comment to start a fresh ledger. Nothing was changed.`,
      );
    }
    if (!parsed || parsed.ledger.pullRequest !== pullRequest) continue;
    return { ledger: parsed.ledger, commentId, digest: parsed.digest, migrated: parsed.migrated };
  }
  return { ledger: emptyLedger(pullRequest), commentId: null, digest: null, migrated: false };
}

export class LedgerConflictError extends Error {}

// Compare-and-swap: when `expectedDigest` is given, the comment is re-read right
// before the write and the write is refused (LedgerConflictError) if its marker
// no longer carries that digest, i.e. another writer got there first. Callers
// retry from a fresh read.
export function publishLedgerComment(
  repository: string,
  pullRequest: number,
  ledger: Ledger,
  commentId: number | null,
  migrated = false,
  ghExecutable = "gh",
  expectedDigest: string | null = null,
): number {
  assertRepository(repository);
  const payload = `${JSON.stringify({ body: renderLedgerComment(ledger, migrated) })}\n`;
  if (commentId === null) {
    const created = ghJson(["api", "--method", "POST", `repos/${repository}/issues/${pullRequest}/comments`, "--input", "-"], ghExecutable, payload);
    if (!isRecord(created) || typeof created.id !== "number") throw new Error("ledger comment creation returned no id");
    return created.id;
  }
  if (expectedDigest !== null) {
    const current = ghJson(["api", `repos/${repository}/issues/comments/${commentId}`], ghExecutable);
    const marker = isRecord(current) ? text(current.body).split("\n")[0] : "";
    const match = /digest=([0-9a-f]{64})/.exec(marker);
    if (!match || match[1] !== expectedDigest) throw new LedgerConflictError("ledger comment changed since it was read");
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
  // The re-derived verdict for the last reviewed head when a command changed
  // state; null for status-only comments and for anything not applied.
  refresh: LedgerVerdict | null;
}

const PUBLISH_ATTEMPTS = 3;

export function runCommand(
  repository: string, pullRequest: number, commentId: number, actorLogin: string,
  now = new Date().toISOString(), ghExecutable = "gh",
): CommandOutcome {
  assertRepository(repository);
  const comment = ghJson(["api", `repos/${repository}/issues/comments/${commentId}`], ghExecutable);
  if (!isRecord(comment) || !isRecord(comment.user)) throw new Error("comment is unreadable");
  if (comment.user.login !== actorLogin) throw new Error("comment author does not match the event actor");
  if (comment.user.type === "Bot") return { status: "ignored", message: "bot author", openBlocking: null, refresh: null };
  let commands: LedgerCommand[];
  try {
    commands = parseCommands(text(comment.body));
  } catch (error) {
    react(repository, commentId, "confused", ghExecutable);
    return { status: "rejected", message: error instanceof Error ? error.message : String(error), openBlocking: null, refresh: null };
  }
  if (commands.length === 0) return { status: "ignored", message: "not a command", openBlocking: null, refresh: null };
  if (!actorHasWrite(repository, actorLogin, ghExecutable)) {
    react(repository, commentId, "-1", ghExecutable);
    return { status: "denied", message: `${actorLogin} lacks write permission`, openBlocking: null, refresh: null };
  }
  for (let attempt = 1; ; attempt++) {
    const loaded = loadLedgerComment(repository, pullRequest, ghExecutable, now);
    let applied: { ledger: Ledger; messages: string[] };
    try {
      applied = applyCommands(structuredClone(loaded.ledger), commands, { login: actorLogin, at: now, commentId });
    } catch (error) {
      react(repository, commentId, "confused", ghExecutable);
      const message = error instanceof Error ? error.message : String(error);
      ghJson(
        ["api", "--method", "POST", `repos/${repository}/issues/${pullRequest}/comments`, "--input", "-"],
        ghExecutable,
        `${JSON.stringify({ body: `@${actorLogin} ${message}.\n\n${USAGE}` })}\n`,
      );
      return { status: "rejected", message, openBlocking: null, refresh: null };
    }
    try {
      publishLedgerComment(repository, pullRequest, applied.ledger, loaded.commentId, loaded.migrated, ghExecutable, loaded.digest);
    } catch (error) {
      if (error instanceof LedgerConflictError && attempt < PUBLISH_ATTEMPTS) continue;
      throw error;
    }
    react(repository, commentId, "+1", ghExecutable);
    const changed = commands.some(command => command.kind !== "status");
    return {
      status: "applied",
      message: applied.messages.join(" "),
      openBlocking: openBlockingCount(applied.ledger),
      refresh: changed ? ledgerVerdict(applied.ledger) : null,
    };
  }
}

// --- CLI ----------------------------------------------------------------------

function argValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) throw new Error(`missing ${name}`);
  return args[index + 1];
}

// The ledger file passed between workflow steps: the ledger plus two transport
// fields — `migrated` (render the migration note) and `expectedDigest` (the
// live comment's digest when it was read, for the compare-and-swap).
export interface LedgerFile {
  ledger: Ledger;
  migrated: boolean;
  expectedDigest: string | null;
}

export function readLedgerFile(path: string): LedgerFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const migrated = parsed.migrated === true;
  const expectedDigest = typeof parsed.expectedDigest === "string" ? parsed.expectedDigest : null;
  delete parsed.migrated;
  delete parsed.expectedDigest;
  return { ledger: validateLedger(parsed), migrated, expectedDigest };
}

export function writeLedgerFile(path: string, ledger: Ledger, migrated: boolean, expectedDigest: string | null): void {
  writeFileSync(path, `${JSON.stringify({ ...ledger, migrated, expectedDigest }, null, 2)}\n`);
}

export const LEDGER_CONFLICT_EXIT = 3;

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "fetch") {
    const loaded = loadLedgerComment(argValue(args, "--repo"), Number(argValue(args, "--pr")));
    writeLedgerFile(argValue(args, "--output"), loaded.ledger, loaded.migrated, loaded.digest);
    process.stdout.write(`${loaded.commentId === null ? "new" : `comment ${loaded.commentId}`} migrated=${loaded.migrated}\n`);
    return;
  }
  if (command === "merge") {
    // Compare-and-swap input for publication: the review's pre-review snapshot
    // merged with the live comment, so maintainer decisions made while the
    // models ran are applied before the verdict is published.
    const snapshot = readLedgerFile(argValue(args, "--input"));
    const live = loadLedgerComment(argValue(args, "--repo"), Number(argValue(args, "--pr")));
    const merged = mergeLedgers(snapshot.ledger, live.ledger);
    writeLedgerFile(argValue(args, "--output"), merged, snapshot.migrated || live.migrated, live.digest);
    process.stdout.write(`${ledgerDigest(merged) === ledgerDigest(snapshot.ledger) ? "unchanged" : "changed"}\n`);
    return;
  }
  if (command === "publish") {
    const repository = argValue(args, "--repo");
    const pullRequest = Number(argValue(args, "--pr"));
    const input = readLedgerFile(argValue(args, "--input"));
    const existing = loadLedgerComment(repository, pullRequest);
    try {
      const id = publishLedgerComment(repository, pullRequest, input.ledger, existing.commentId, input.migrated, "gh", input.expectedDigest);
      process.stdout.write(`comment ${id}\n`);
    } catch (error) {
      if (!(error instanceof LedgerConflictError)) throw error;
      process.stderr.write("::notice::ai-pr-ledger publish: the ledger comment changed since it was read\n");
      process.exit(LEDGER_CONFLICT_EXIT);
    }
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
