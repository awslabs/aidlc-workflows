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
export const LEDGER_VERSION = 4 as const;
const LEGACY_LEDGER_VERSION = 1;
const PREVIOUS_LEDGER_VERSION = 2;
// Version 3 added archivedDecisions; version 4 adds nextReview (/aida full) and
// the full-requested event. Both are verified under their own canonical shape.
const VERSION_3 = 3;
const MAX_REASON_LENGTH = 500;
const MAX_LEDGER_BYTES = 200_000;
// The writer compacts to this before publishing so the reader's cap is never hit.
const TARGET_LEDGER_BYTES = 150_000;
const MAX_FINDINGS = 200;
const MAX_ARCHIVED_DECISIONS = 200;
const MAX_EVENTS = 1000;
const MAX_COMMANDS_PER_COMMENT = 20;

export type Priority = "P0" | "P1" | "P2" | "P3";
export type DiffSide = "LEFT" | "RIGHT";
export type LedgerStatus = "open" | "resolved" | "accepted" | "rejected";
export type CommandKind = "accept" | "reject" | "reopen" | "status" | "full";

export interface LedgerAnchor {
  kind: "line" | "position" | "file" | "quote";
  path?: string;
  side?: DiffSide;
  line?: number;
  // quote anchors: the length of the trimmed quote, so presence can be checked
  // against current PR metadata without storing the quote itself.
  length?: number;
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
  | "suppressed"
  | "full-requested";

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
  // Decided entries moved out of the active capacity window. They retain their
  // ids, fingerprints, and maintainer decisions so a restatement can still
  // inherit or reopen the exact decision.
  archivedDecisions?: LedgerFinding[];
  events: LedgerEvent[];
  review?: LedgerReview;
  // A maintainer's request (/aida full) that the next review cover the full head
  // instead of the incremental scope. Consumed by the review that honors it.
  nextReview?: NextReviewRequest;
}

export interface NextReviewRequest {
  scope: "full";
  by: string;
  at: string;
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
  // The judge's explicit identification of an existing ledger entry. Only an
  // explicit id lets a finding inherit that entry's maintainer decision.
  ledgerId?: string;
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
  // Subset of resolvedIds closed on the judge's explicit disposition.
  resolvedByJudgeIds: string[];
  // Open entries the judge neither restated nor disposed of.
  undisposedIds: string[];
  // Blocking entries the judge declared resolved while their cited code and
  // files are unchanged: kept open and retained until a maintainer accepts.
  unverifiedResolutionIds: string[];
}

export type LedgerDispositions = ReadonlyMap<string, "resolved" | "still-open">;

// Files the current head changed since the last review (incremental scope), or
// null when that set is unknown (a full review: first review, rewritten history,
// /aida full). Unknown is never evidence of a change.
export type ChangedFiles = ReadonlySet<string> | null;

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
  const trimmed = quote.trim();
  return { kind: "quote", length: trimmed.length, sha256: sha256(`quote\0${trimmed}`) };
}

// Anchors written before their evaluation existed (a migrated v1 anchor, a
// position without its line, a quote without its length). They identify a
// finding but can never be evaluated at a head.
export const isLegacyAnchor = (anchor: LedgerAnchor): boolean =>
  (anchor.kind === "position" && anchor.line === undefined) ||
  (anchor.kind === "quote" && anchor.length === undefined);

// The fallback when a cited line has no readable text. Its presence at a head is
// unknowable, so it identifies a finding but never retains one.
export function positionAnchor(path: string, line: number, side: DiffSide): LedgerAnchor {
  return { kind: "position", path, side, line, sha256: sha256(`position\0${path}\0${line}\0${side}`) };
}

// --- validation ---------------------------------------------------------------

const STATUSES: readonly LedgerStatus[] = ["open", "resolved", "accepted", "rejected"];
const PRIORITIES: readonly Priority[] = ["P0", "P1", "P2", "P3"];
const EVENT_KINDS: readonly LedgerEventKind[] = [
  "opened", "seen", "resolved", "accepted", "rejected", "reopened", "suppressed", "full-requested",
];

function validateAnchor(value: unknown, label: string): LedgerAnchor {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.kind !== "line" && value.kind !== "position" && value.kind !== "file" && value.kind !== "quote") {
    throw new Error(`${label}.kind is invalid`);
  }
  if (value.line !== undefined && (!Number.isInteger(value.line) || Number(value.line) < 1)) {
    throw new Error(`${label}.line must be a positive integer`);
  }
  if (value.length !== undefined && (!Number.isInteger(value.length) || Number(value.length) < 1)) {
    throw new Error(`${label}.length must be a positive integer`);
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
    ...(typeof value.length === "number" ? { length: value.length } : {}),
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
  if ([...decision.reason].length > MAX_REASON_LENGTH) throw new Error(`${label}.reason is too long`);
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
  const validateFinding = (entry: unknown, label: string, archived: boolean): LedgerFinding => {
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
    if (archived && finding.status !== "accepted" && finding.status !== "rejected") {
      throw new Error(`${label} must be an accepted or rejected decision`);
    }
    return finding;
  };
  const findings = value.findings.map((entry, index) =>
    validateFinding(entry, `ledger.findings[${index}]`, false));
  if (
    value.archivedDecisions !== undefined &&
    (!Array.isArray(value.archivedDecisions) || value.archivedDecisions.length > MAX_ARCHIVED_DECISIONS)
  ) {
    throw new Error("ledger.archivedDecisions must be a bounded array");
  }
  const archivedDecisions = Array.isArray(value.archivedDecisions)
    ? value.archivedDecisions.map((entry, index) =>
      validateFinding(entry, `ledger.archivedDecisions[${index}]`, true))
    : [];
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
  const allFindings = [...findings, ...archivedDecisions];
  const maxId = allFindings.reduce((max, finding) => Math.max(max, Number(finding.id.slice(1))), 0);
  if (Number(value.nextId) <= maxId) throw new Error("ledger.nextId must exceed every finding id");
  const ledger: Ledger = {
    version: LEDGER_VERSION,
    pullRequest: Number(value.pullRequest),
    nextId: Number(value.nextId),
    findings,
    ...(archivedDecisions.length > 0 ? { archivedDecisions } : {}),
    events,
  };
  if (value.review !== undefined) ledger.review = validateReview(value.review);
  if (value.nextReview !== undefined) {
    const next = value.nextReview;
    if (!isRecord(next) || next.scope !== "full" || text(next.by).length === 0 || text(next.at).length === 0) {
      throw new Error("ledger.nextReview is invalid");
    }
    ledger.nextReview = { scope: "full", by: text(next.by), at: text(next.at) };
  }
  return ledger;
}

// A version-3 ledger cannot carry version-4 fields; it is verified under the
// version-3 canonical shape and upgraded without touching any decision.
function migrateVersion3Ledger(value: unknown): { ledger: Ledger; digest: string } {
  if (!isRecord(value) || value.version !== VERSION_3) throw new Error("not a version-3 ledger");
  if (value.nextReview !== undefined) throw new Error("version-3 ledger cannot contain a next-review request");
  if (Array.isArray(value.events) && value.events.some(event => isRecord(event) && event.kind === "full-requested")) {
    throw new Error("version-3 ledger cannot contain full-requested events");
  }
  const ledger = validateLedger({ ...value, version: LEDGER_VERSION });
  const { version: _version, nextReview: _next, ...rest } = ledger;
  return { ledger, digest: sha256(JSON.stringify({ version: VERSION_3, ...rest }, null, 2)) };
}

function migratePreviousLedger(value: unknown): { ledger: Ledger; digest: string } {
  if (!isRecord(value) || value.version !== PREVIOUS_LEDGER_VERSION) {
    throw new Error("not a version-2 ledger");
  }
  if (value.archivedDecisions !== undefined) {
    throw new Error("version-2 ledger cannot contain archived decisions");
  }
  const ledger = validateLedger({ ...value, version: LEDGER_VERSION });
  const previous = {
    version: PREVIOUS_LEDGER_VERSION,
    pullRequest: ledger.pullRequest,
    nextId: ledger.nextId,
    findings: ledger.findings,
    events: ledger.events,
    ...(ledger.review ? { review: ledger.review } : {}),
  };
  return {
    ledger,
    digest: sha256(JSON.stringify(previous, null, 2)),
  };
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

// Keeps the serialized ledger under the reader's budget. History goes first,
// then resolved findings. Maintainer decisions are authoritative for the
// lifetime of the ledger and are never discarded; if they alone exceed the
// hard limit, publication fails closed.
export function compactLedger(input: Ledger, budget = TARGET_LEDGER_BYTES): Ledger {
  const ledger = structuredClone(input);
  const size = (): number => Buffer.byteLength(canonicalJson(ledger), "utf8");
  while (size() > budget && ledger.events.length > 0) {
    ledger.events.splice(0, Math.max(1, Math.floor(ledger.events.length / 10)));
  }
  while (size() > budget || ledger.findings.length > MAX_FINDINGS) {
    const resolvedIndex = ledger.findings.findIndex(
      entry => entry.status === "resolved",
    );
    if (resolvedIndex === -1) break;
    ledger.findings.splice(resolvedIndex, 1);
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
  if ((ledger.archivedDecisions?.length ?? 0) > 0) {
    lines.push(
      `Archived maintainer decisions: **${ledger.archivedDecisions?.length ?? 0}**. Their ids and exact evidence remain active in \`ledger.json\`.`,
      "",
    );
  }
  lines.push(
    `Open blocking findings (P0/P1): **${openBlockingCount(ledger)}**. Accepted and rejected findings never count toward the next action.`,
    ...(ledger.nextReview ? [`Next review: **full head**, requested by @${escapeCell(ledger.nextReview.by)}.`] : []),
    "",
    "Maintainer commands (repository write access) — put them on the first lines of a comment, one per line, several ids per line allowed:",
    "`/aida accept F# [F#…] <reason>` · `/aida reject F# [F#…] <reason>` · `/aida reopen F# [F#…]` · `/aida status` · `/aida full` (next review covers the whole head)",
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
// ledger is migrated instead of verified. Version 2 is verified under its
// original canonical shape and then upgraded without resetting decisions.
// `digest` is the marker's digest as read, for the publish-time compare-and-swap.
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
  if (isRecord(parsed) && parsed.version === PREVIOUS_LEDGER_VERSION) {
    const previous = migratePreviousLedger(parsed);
    if (digest !== previous.digest) throw new Error("ledger comment was edited outside AIDA (digest mismatch)");
    return { ledger: previous.ledger, migrated: false, digest };
  }
  if (isRecord(parsed) && parsed.version === VERSION_3) {
    const previous = migrateVersion3Ledger(parsed);
    if (digest !== previous.digest) throw new Error("ledger comment was edited outside AIDA (digest mismatch)");
    return { ledger: previous.ledger, migrated: false, digest };
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
  const archived = ledger.archivedDecisions ?? [];
  for (const entry of [...ledger.findings, ...archived]) {
    if (entry.status !== "accepted" && entry.status !== "rejected") continue;
    entry.status = "open";
    delete entry.decision;
    pushEvent(ledger, { at, kind: "reopened", by: "aida", id: entry.id, reason });
    reset.push(entry.id);
  }
  if (archived.length > 0) {
    ledger.findings.push(...archived);
    delete ledger.archivedDecisions;
  }
  return reset;
}

// The one decision rule, shared by the validator, the review after ledger
// decisions apply, and a later /aida command: the next action follows finding
// severity alone. Any open P0/P1 means author/change; otherwise the PR is ready
// for the maintainer's merge decision. Readiness and risk explain the
// assessment; they never decide.
export function deriveDecision(openBlocking: number): "merge" | "change" {
  return openBlocking > 0 ? "change" : "merge";
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
    decision: deriveDecision(openBlocking),
  };
}

// Commands are the leading block of a comment: consecutive non-blank lines that
// each start with `/aida`. Parsing stops at the first other line, so a command
// quoted or discussed lower in the comment never fires. A line may name several
// findings; the reason is everything after the last id.
export function parseCommands(body: string): LedgerCommand[] {
  const commands: LedgerCommand[] = [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    const where = `line ${index + 1}: `;
    if (line.length === 0) {
      if (commands.length === 0) continue;
      break;
    }
    // Prose ends the command block. A `/aida` line that is not a valid command
    // is a usage error for the whole comment (all-or-nothing), never prose.
    if (!line.startsWith("/aida")) break;
    const match = /^\/aida\s+(accept|reject|reopen|status|full)\b(.*)$/.exec(line);
    if (!match) {
      throw new Error(`${where}unrecognized command; commands are accept, reject, reopen, status, full`);
    }
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
    const reason = remainder.trim();
    const reasonLength = [...reason].length;
    if (reasonLength > MAX_REASON_LENGTH) {
      throw new Error(`${where}the reason is ${reasonLength} characters; the limit is ${MAX_REASON_LENGTH}`);
    }
    if (reason.length > 0) command.reason = reason;
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
    if (command.kind === "full") {
      if (command.ids.length > 0 || command.reason) throw new Error(`${where}/aida full takes no arguments`);
      next.nextReview = { scope: "full", by: actor.login, at: actor.at };
      event("full-requested", {});
      messages.push(`The next review covers the full head, requested by @${actor.login}.`);
      return;
    }
    if (command.ids.length === 0) throw new Error(`${where}/aida ${command.kind} requires at least one finding id such as F1`);
    if (command.kind !== "reopen" && !command.reason) {
      throw new Error(`${where}/aida ${command.kind} ${command.ids.join(" ")} requires a reason after the id(s)`);
    }
    for (const id of command.ids) {
      const activeIndex = next.findings.findIndex(entry => entry.id === id);
      const archivedIndex = next.archivedDecisions?.findIndex(entry => entry.id === id) ?? -1;
      const finding = activeIndex >= 0
        ? next.findings[activeIndex]
        : archivedIndex >= 0
          ? next.archivedDecisions?.[archivedIndex]
          : undefined;
      if (!finding) throw new Error(`${where}unknown finding ${id}`);
      if (command.kind === "reopen") {
        if (finding.status === "open") throw new Error(`${where}${id} is already open`);
        if (finding.status === "resolved") {
          throw new Error(`${where}${id} is resolved: reopen reverses an accept or reject; a review re-establishes a finding that still applies`);
        }
        if (archivedIndex >= 0) {
          next.archivedDecisions?.splice(archivedIndex, 1);
          if (next.archivedDecisions?.length === 0) delete next.archivedDecisions;
          makeRoom(next);
          next.findings.push(finding);
        }
        finding.status = "open";
        delete finding.decision;
        event("reopened", { id });
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
    }
    const ids = command.ids.join(", ");
    messages.push(
      command.kind === "reopen"
        ? `${ids} reopened by @${actor.login}.`
        : `${ids} ${command.kind === "accept" ? "accepted" : "rejected"} by @${actor.login}: ${command.reason}`,
    );
  });
  return { ledger: next, messages };
}

// --- reconciliation ---------------------------------------------------------

// Frees one active slot. Resolved entries are already historical and go first.
// If every active entry is decided, the oldest decision moves to the archive
// so its id, evidence, and maintainer decision remain authoritative.
const makeRoom = (ledger: Ledger): void => {
  while (ledger.findings.length >= MAX_FINDINGS) {
    const resolvedIndex = ledger.findings.findIndex(
      entry => entry.status === "resolved",
    );
    if (resolvedIndex >= 0) {
      ledger.findings.splice(resolvedIndex, 1);
      continue;
    }
    const decidedIndex = ledger.findings.findIndex(
      entry => entry.status === "accepted" || entry.status === "rejected",
    );
    if (decidedIndex === -1) {
      throw new Error(`the ledger holds ${MAX_FINDINGS} open findings; accept, reject, or fix some before new ones can be recorded`);
    }
    if ((ledger.archivedDecisions?.length ?? 0) >= MAX_ARCHIVED_DECISIONS) {
      throw new Error(`the ledger archive holds ${MAX_ARCHIVED_DECISIONS} decisions; no authoritative decision can be discarded`);
    }
    const [archived] = ledger.findings.splice(decidedIndex, 1);
    const archive = ledger.archivedDecisions ??= [];
    archive.push(archived);
  }
};

function anchorSet(anchors: LedgerAnchor[]): Set<string> {
  return new Set(anchors.map(anchor => anchor.sha256));
}

function findingFingerprint(
  finding: Pick<ReviewFindingInput, "category" | "anchors">,
): string {
  return `${finding.category}\0${[...anchorSet(finding.anchors)].sort().join("\0")}`;
}

function upgradeAnchors(existing: LedgerAnchor[], current: LedgerAnchor[]): void {
  for (const anchor of current) {
    const index = existing.findIndex(known => known.sha256 === anchor.sha256);
    if (index === -1) {
      existing.push(anchor);
    } else if (isLegacyAnchor(existing[index]) && !isLegacyAnchor(anchor)) {
      existing[index] = anchor;
    }
  }
}

export function reconcileLedger<T extends ReviewFindingInput>(
  loaded: LoadedLedger,
  findings: T[],
  head: string,
  at: string,
  presentAtHead: AnchorPresence,
  dispositions: LedgerDispositions = new Map(),
  changedFiles: ChangedFiles = null,
): ReconcileResult<T> {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("head must be a 40-character SHA");
  const ledger: Ledger = structuredClone(loaded.ledger);
  const result: ReconcileResult<T> = {
    ledger, kept: [], restatedAccepted: [], suppressed: [], reopenedIds: [], retained: [], resolvedIds: [], resolvedByJudgeIds: [], undisposedIds: [], unverifiedResolutionIds: [],
  };
  const matchedIds = new Set<string>();
  const push = (kind: LedgerEventKind, id: string, extra: Partial<LedgerEvent> = {}): void => {
    pushEvent(ledger, { at, kind, by: "aida", id, head, ...extra });
  };

  // Pass 1: match restated findings. New findings are collected and inserted
  // after the omitted pass, so a head that fixes old findings frees their slots
  // before capacity is enforced.
  const pendingByFingerprint = new Map<string, T>();
  // Explicit bindings are matched first so an implicit fingerprint match can
  // never consume an entry another finding names by id; the published order is
  // restored to the judge's (P0 through P3) at the end.
  const order = new Map<T, number>(findings.map((finding, index) => [finding, index]));
  const keptOrder: number[] = [];
  const pendingOrder = new Map<string, number>();
  const ordered = [...findings.filter(finding => finding.ledgerId), ...findings.filter(finding => !finding.ledgerId)];
  for (const finding of ordered) {
    const hashes = anchorSet(finding.anchors);
    // Model output is influenced by PR content, so it can identify OPEN entries
    // only. Accepted and rejected state is never inherited from a judge-selected
    // id; those decisions persist through omission and rendering, while any
    // reported defect on the same evidence is recorded independently.
    // An explicit id (a disposition's restatement) binds an open entry outright:
    // after a partial fix the same defect legitimately moves to new lines and
    // new wording, and the worst case of a wrong id is a defect that stays
    // visible under an older id. Without an id, the fingerprint (same category
    // and a shared exact anchor) must be unambiguous.
    const compatible = (entry: LedgerFinding): boolean =>
      entry.category === finding.category && entry.anchors.some(anchor => hashes.has(anchor.sha256));
    const compatibleOpen = ledger.findings.filter(
      entry => entry.status === "open" && !matchedIds.has(entry.id) && compatible(entry),
    );
    const requestedOpenId = finding.ledgerId;
    const explicit = requestedOpenId
      ? ledger.findings.find(entry => entry.id === requestedOpenId && entry.status === "open" && !matchedIds.has(entry.id))
      : undefined;
    const match = explicit ?? (compatibleOpen.length === 1 ? compatibleOpen[0] : undefined);
    if (!match && !finding.ledgerId) {
      // An untagged finding whose fingerprint agrees with an entry another
      // finding already restated by id is a duplicate restatement: fold its
      // anchors into that entry instead of allocating a second identity.
      const bound = ledger.findings.find(entry => entry.status === "open" && matchedIds.has(entry.id) && compatible(entry));
      if (bound) {
        const known = anchorSet(bound.anchors);
        for (const anchor of finding.anchors) if (!known.has(anchor.sha256)) bound.anchors.push(anchor);
        // A duplicate never lowers, but may raise, the entry: the highest
        // priority reported for the defect wins, in the ledger and in the
        // published restatement.
        if (rank(finding.priority) < rank(bound.priority)) {
          bound.priority = finding.priority;
          bound.title = finding.title;
          // The higher-severity duplicate is the one worth publishing: its whole
          // payload (evidence, problem, impact, correction) replaces the softer
          // restatement under the same id.
          const index = result.kept.findIndex(entry => entry.ledgerId === bound.id);
          if (index !== -1) result.kept[index] = { ...finding, priority: finding.priority, ledgerId: bound.id };
        }
        continue;
      }
    }
    if (!match) {
      const fingerprint = findingFingerprint(finding);
      const duplicate = pendingByFingerprint.get(fingerprint);
      pendingOrder.set(fingerprint, Math.min(pendingOrder.get(fingerprint) ?? Number.MAX_SAFE_INTEGER, order.get(finding) ?? Number.MAX_SAFE_INTEGER));
      if (!duplicate) {
        pendingByFingerprint.set(fingerprint, structuredClone(finding));
      } else {
        upgradeAnchors(duplicate.anchors, finding.anchors);
        if (rank(finding.priority) < rank(duplicate.priority)) {
          duplicate.priority = finding.priority;
          duplicate.title = finding.title;
        }
      }
      continue;
    }
    matchedIds.add(match.id);
    match.lastSeen = { head, at };
    upgradeAnchors(match.anchors, finding.anchors);
    push("seen", match.id);
    // A restatement never lowers an open finding's priority: the ledger keeps the
    // higher one (and its title). Only changed code or a maintainer decision
    // retires a blocker.
    if (rank(finding.priority) <= rank(match.priority)) {
      match.priority = finding.priority;
      match.title = finding.title;
    }
    result.kept.push({ ...finding, priority: match.priority, ledgerId: match.id });
    keptOrder.push(order.get(finding) ?? Number.MAX_SAFE_INTEGER);
  }

  // Pass 2: open findings the judge did not restate. An explicit disposition
  // decides first: `resolved` closes the entry at this head (auditable, even if
  // the exact cited lines are unchanged: a fix can live elsewhere); `still-open`
  // keeps it verdict-bearing. Without a disposition, presence decides as before.
  for (const entry of ledger.findings) {
    if (entry.status !== "open" || matchedIds.has(entry.id)) continue;
    const disposition = dispositions.get(entry.id);
    if (disposition === "resolved") {
      // The judge's word alone never retires a blocker whose cited code and
      // files the author did not touch: model output is PR-influenced. A
      // blocker resolves on a disposition only with deterministic evidence that
      // the author acted — a cited line gone, or a cited file changed since the
      // last review. Advisory entries follow the judge.
      const verdicts = entry.anchors.map(anchor => presentAtHead(anchor));
      const gone = verdicts.some(verdict => verdict === false);
      const touched = changedFiles !== null && entry.anchors.some(anchor => anchor.path !== undefined && changedFiles.has(anchor.path));
      if (isBlocking(entry.priority) && !gone && !touched) {
        entry.lastSeen = { head, at };
        push("seen", entry.id, { reason: "retained: declared corrected by the judge, but cited code and files are unchanged; a maintainer may accept" });
        result.retained.push(structuredClone(entry));
        result.unverifiedResolutionIds.push(entry.id);
        continue;
      }
      entry.status = "resolved";
      entry.lastSeen = { head, at };
      push("resolved", entry.id, {
        reason: gone
          ? "declared corrected by the judge; a cited line is gone"
          : touched
            ? "declared corrected by the judge; cited files changed since the last review"
            : "declared corrected by the judge (advisory: no change evidence required)",
      });
      result.resolvedIds.push(entry.id);
      result.resolvedByJudgeIds.push(entry.id);
      continue;
    }
    if (disposition === "still-open") {
      // Retained whatever the priority: the judge said it still holds. Only
      // blocking entries bear on the verdict.
      entry.lastSeen = { head, at };
      push("seen", entry.id, { reason: "retained: still open per the judge, not restated" });
      result.retained.push(structuredClone(entry));
      continue;
    }
    result.undisposedIds.push(entry.id);
    // An open finding the judge did not restate resolves only when its cited
    // condition is positively gone (every anchor false), or when none of its
    // anchors can ever be evaluated (all legacy: migrated, or written before
    // evaluation existed). Otherwise it is retained: present anchors mean the
    // code is unchanged; an unknown verdict on an evaluable anchor is not
    // evidence of a fix, and a model omission never closes a blocker.
    const evaluated = entry.anchors.map(anchor => ({ anchor, verdict: presentAtHead(anchor) }));
    const evaluable = evaluated.filter(item => !isLegacyAnchor(item.anchor));
    const present = evaluable.some(item => item.verdict === true);
    const unknown = evaluable.some(item => item.verdict === null);
    const allEvaluableGone = evaluable.length > 0 && evaluable.every(item => item.verdict === false);
    const legacyOnly = evaluable.length === 0;
    if (present || unknown) {
      if (!isBlocking(entry.priority)) continue;
      entry.lastSeen = { head, at };
      push("seen", entry.id, {
        reason: present
          ? "retained: not restated, cited code unchanged"
          : "retained: not restated, presence could not be evaluated",
      });
      result.retained.push(structuredClone(entry));
      continue;
    }
    entry.status = "resolved";
    entry.lastSeen = { head, at };
    push("resolved", entry.id, {
      reason: allEvaluableGone
        ? "cited code is gone"
        : legacyOnly
          ? "not restated; legacy anchors cannot be evaluated"
          : "cited code is gone",
    });
    result.resolvedIds.push(entry.id);
  }

  // Pass 3: new findings, once the reconciled ledger knows what it can free.
  for (const [fingerprint, finding] of pendingByFingerprint) {
    makeRoom(ledger);
    const id = `F${ledger.nextId}`;
    ledger.nextId += 1;
    ledger.findings.push({
      id, priority: finding.priority, category: finding.category, title: finding.title,
      anchors: finding.anchors, status: "open", firstSeen: { head, at }, lastSeen: { head, at },
    });
    push("opened", id);
    matchedIds.add(id);
    result.kept.push({ ...finding, ledgerId: id });
    keptOrder.push(pendingOrder.get(fingerprint) ?? Number.MAX_SAFE_INTEGER);
  }
  // Publish P0 through P3 by EFFECTIVE priority (a restatement may have been
  // raised to the ledger's), with the judge's order as the tie-breaker.
  result.kept = result.kept
    .map((entry, index) => ({ entry, position: keptOrder[index] }))
    .sort((left, right) => rank(left.entry.priority) - rank(right.entry.priority) || left.position - right.position)
    .map(item => item.entry);
  return result;
}

// Accepted risks are rendered from persisted state, not from a restatement the
// judge is told not to make. An accepted entry whose anchors are positively gone
// is omitted (the code it covered no longer exists).
export function acceptedRisks(ledger: Ledger, presentAtHead: AnchorPresence): LedgerFinding[] {
  return [...ledger.findings, ...(ledger.archivedDecisions ?? [])].filter(entry => {
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
  const entries = (ledger: Ledger): LedgerFinding[] =>
    [...ledger.findings, ...(ledger.archivedDecisions ?? [])];
  const remove = (ledger: Ledger, id: string): void => {
    const activeIndex = ledger.findings.findIndex(entry => entry.id === id);
    if (activeIndex >= 0) ledger.findings.splice(activeIndex, 1);
    const archivedIndex = ledger.archivedDecisions?.findIndex(entry => entry.id === id) ?? -1;
    if (archivedIndex >= 0) ledger.archivedDecisions?.splice(archivedIndex, 1);
    if (ledger.archivedDecisions?.length === 0) delete ledger.archivedDecisions;
  };
  const insertLike = (ledger: Ledger, source: Ledger, entry: LedgerFinding): void => {
    const sourceArchived = source.archivedDecisions?.some(candidate => candidate.id === entry.id) ?? false;
    if (sourceArchived) {
      const archive = ledger.archivedDecisions ??= [];
      if (archive.length >= MAX_ARCHIVED_DECISIONS) {
        throw new Error(`the ledger archive holds ${MAX_ARCHIVED_DECISIONS} decisions; no authoritative decision can be discarded`);
      }
      archive.push(structuredClone(entry));
    } else {
      makeRoom(ledger);
      ledger.findings.push(structuredClone(entry));
    }
  };
  const latestMaintainerAction = (ledger: Ledger, id: string): string => {
    let latest = "";
    for (const event of ledger.events) {
      if (event.id !== id || event.by === "aida") continue;
      if (event.kind !== "accepted" && event.kind !== "rejected" && event.kind !== "reopened") continue;
      if (event.at > latest) latest = event.at;
    }
    return latest;
  };
  for (const liveEntry of entries(live)) {
    const own = entries(merged).find(entry => entry.id === liveEntry.id);
    if (!own) {
      insertLike(merged, live, liveEntry);
      continue;
    }
    if (latestMaintainerAction(live, liveEntry.id) > latestMaintainerAction(base, liveEntry.id)) {
      remove(merged, liveEntry.id);
      insertLike(merged, live, liveEntry);
    }
  }
  if (live.nextReview && !merged.nextReview) merged.nextReview = structuredClone(live.nextReview);
  const seenEvents = new Set(merged.events.map(event => JSON.stringify(event)));
  for (const event of live.events) {
    const key = JSON.stringify(event);
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    merged.events.push(structuredClone(event));
  }
  merged.events.sort((left, right) => left.at.localeCompare(right.at));
  if (merged.events.length > MAX_EVENTS) merged.events = merged.events.slice(merged.events.length - MAX_EVENTS);
  merged.nextId = Math.max(
    base.nextId,
    live.nextId,
    ...entries(merged).map(entry => Number(entry.id.slice(1)) + 1),
  );
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

interface ManifestFile {
  path: string;
  previousPath?: string;
  added: Array<{ start: number; end: number }>;
  deleted: Array<{ start: number; end: number }>;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function manifestFiles(contextDir: string): ManifestFile[] {
  const manifest = readJson(resolve(contextDir, "changed-files.json"));
  if (!isRecord(manifest) || !Array.isArray(manifest.files)) return [];
  return manifest.files.filter(isRecord).map(file => ({
    path: text(file.path),
    ...(typeof file.previousPath === "string" ? { previousPath: file.previousPath } : {}),
    added: Array.isArray(file.added) ? (file.added as ManifestFile["added"]) : [],
    deleted: Array.isArray(file.deleted) ? (file.deleted as ManifestFile["deleted"]) : [],
  }));
}

function inRanges(line: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some(range => line >= range.start && line <= range.end);
}

// Evaluates an anchor against the immutable review context of the current head:
//   line/RIGHT    the exact line is still in the head snapshot of the file
//   line/LEFT     the exact base line is still deleted by the current diff
//                 (base tree + deleted ranges in changed-files.json)
//   position      the cited line number is still inside the diff ranges
//   quote         the quoted text still occurs in the PR title or body (pr.json)
//   file          the file's content hash is unchanged
// true: still present; false: positively gone (including a file that no longer
// exists at the head or a path no longer in the diff); null: cannot be evaluated
// (legacy anchors, escaped paths, missing context files).
export function headContainsAnchor(contextDir: string, anchor: LedgerAnchor, repoDir = process.cwd()): boolean | null {
  if (isLegacyAnchor(anchor)) return null;
  if (anchor.kind === "quote") {
    const metadata = readJson(resolve(contextDir, "pr.json"));
    if (!isRecord(metadata) || anchor.length === undefined) return null;
    const length = anchor.length;
    for (const source of [text(metadata.title), text(metadata.body)]) {
      for (let start = 0; start + length <= source.length; start++) {
        if (quoteAnchor(source.slice(start, start + length)).sha256 === anchor.sha256) return true;
      }
    }
    return false;
  }
  if (!anchor.path) return null;
  const path = anchor.path;
  if (anchor.kind === "position") {
    if (anchor.line === undefined || anchor.side === undefined) return null;
    if (!existsSync(resolve(contextDir, "changed-files.json"))) return null;
    const files = manifestFiles(contextDir);
    const file = files.find(entry => (anchor.side === "RIGHT" ? entry.path : (entry.previousPath ?? entry.path)) === path);
    return file ? inRanges(anchor.line, anchor.side === "RIGHT" ? file.added : file.deleted) : false;
  }
  if (anchor.kind === "line" && anchor.side === "LEFT") {
    if (!existsSync(resolve(contextDir, "changed-files.json"))) return null;
    const target = confined(resolve(repoDir), path);
    if (!target) return null;
    const file = manifestFiles(contextDir).find(entry => (entry.previousPath ?? entry.path) === path);
    if (!file || !existsSync(target)) return false;
    const lines = readFileSync(target, "utf8").split("\n");
    return lines.some((lineText, index) => inRanges(index + 1, file.deleted) && lineAnchor(path, "LEFT", lineText).sha256 === anchor.sha256);
  }
  if (anchor.kind === "line" && anchor.side !== "RIGHT") return null;
  const target = confined(resolve(contextDir, "head"), path);
  if (!target) return null;
  if (!existsSync(target)) return false;
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

const USAGE = `Usage: put commands on the first lines of a comment, one per line — \`/aida accept F# [F#…] <reason>\`, \`/aida reject F# [F#…] <reason>\`, \`/aida reopen F# [F#…]\`, \`/aida status\`, \`/aida full\`. Reasons are limited to ${MAX_REASON_LENGTH} characters. Nothing was applied.`;

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
  if (!actorHasWrite(repository, actorLogin, ghExecutable)) {
    react(repository, commentId, "-1", ghExecutable);
    return { status: "denied", message: `${actorLogin} lacks write permission`, openBlocking: null, refresh: null };
  }
  const rejectCommand = (error: unknown): CommandOutcome => {
    react(repository, commentId, "confused", ghExecutable);
    const message = error instanceof Error ? error.message : String(error);
    const reply = `@${actorLogin} ${message}.\n\n${USAGE}`;
    ghJson(
      ["api", "--method", "POST", `repos/${repository}/issues/${pullRequest}/comments`, "--input", "-"],
      ghExecutable,
      `${JSON.stringify({ body: reply })}\n`,
    );
    return { status: "rejected", message, openBlocking: null, refresh: null };
  };
  let commands: LedgerCommand[];
  try {
    commands = parseCommands(text(comment.body));
  } catch (error) {
    return rejectCommand(error);
  }
  if (commands.length === 0) return { status: "ignored", message: "not a command", openBlocking: null, refresh: null };
  for (let attempt = 1; ; attempt++) {
    const loaded = loadLedgerComment(repository, pullRequest, ghExecutable, now);
    let applied: { ledger: Ledger; messages: string[] };
    try {
      applied = applyCommands(structuredClone(loaded.ledger), commands, { login: actorLogin, at: now, commentId });
    } catch (error) {
      return rejectCommand(error);
    }
    try {
      publishLedgerComment(repository, pullRequest, applied.ledger, loaded.commentId, loaded.migrated, ghExecutable, loaded.digest);
    } catch (error) {
      if (error instanceof LedgerConflictError && attempt < PUBLISH_ATTEMPTS) continue;
      throw error;
    }
    react(repository, commentId, "+1", ghExecutable);
    const changed = commands.some(command => command.kind !== "status" && command.kind !== "full");
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
      process.stdout.write(`comment ${id} digest=${ledgerDigest(compactLedger(input.ledger))}\n`);
    } catch (error) {
      if (!(error instanceof LedgerConflictError)) throw error;
      process.stderr.write("::notice::ai-pr-ledger publish: the ledger comment changed since it was read\n");
      process.exit(LEDGER_CONFLICT_EXIT);
    }
    return;
  }
  if (command === "verdict") {
    // The live ledger's effective verdict for the head it last reviewed, plus the
    // comment's digest, so a publisher can tell whether a command landed after
    // its own write.
    const live = loadLedgerComment(argValue(args, "--repo"), Number(argValue(args, "--pr")));
    const verdict = ledgerVerdict(live.ledger);
    process.stdout.write(`${JSON.stringify({ ...(verdict ?? { head: null, decision: null, openBlocking: null }), digest: live.digest })}\n`);
    return;
  }
  if (command === "command") {
    const outcome = runCommand(argValue(args, "--repo"), Number(argValue(args, "--pr")), Number(argValue(args, "--comment-id")), argValue(args, "--actor"));
    if (args.includes("--state-output")) writeFileSync(argValue(args, "--state-output"), `${JSON.stringify(outcome)}\n`);
    process.stdout.write(`${outcome.status}: ${outcome.message}\n`);
    return;
  }
  throw new Error("usage: ai-pr-ledger.ts fetch|merge|publish|verdict|command");
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
