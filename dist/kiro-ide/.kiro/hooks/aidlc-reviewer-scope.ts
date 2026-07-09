// PreToolUse hook: deterministic enforcement of the per-unit reviewer
// read-scope bound (stage-protocol 12a).
//
// The prose bound says a reviewer dispatched for one unit must not read other
// units' construction/<other-unit>/ content through any tool - not by opening
// files, and not via grep, glob, or shell patterns that span sibling unit
// paths. Field transcripts showed prose losing that contest: a diligent
// reviewer swept siblings through recursive greps with cross-unit globs, and
// per-unit review cost grew superlinearly with unit count. Per the framework
// layering (determinism belongs in tools and hooks, knowledge in agents,
// judgement with humans), this hook is the bound's deterministic twin.
//
// This is the framework's SECOND flow-altering hook (the Stop hook is the
// first). Its contract is the harness-native PreToolUse block: print a reason
// to stderr and exit 2 to refuse the tool call, exit 0 to allow. The refusal
// is scoped tightly - one agent, one dispatch window, sibling-unit targets
// only - and the reason text redirects the reviewer to the contract paths it
// was already passed, so a blocked call is a recoverable nudge, not a halt.
//
// How the hook knows a review is in flight: the conductor writes a dispatch
// record (reviewerDispatchPath, `<record>/.aidlc-reviewer-dispatch.json`) at
// 12a step 1 before invoking a per-unit reviewer, and deletes it at step 3
// when the verdict is read. The record carries {reviewer, stage, unit,
// exempt[]} - the facts no harness payload delivers. Identity comes from the
// harness: Claude Code and Codex put the active subagent's name in the
// payload's agent_type (absent on main-session calls; probe-verified on
// both), and the Kiro CLI adapter asserts scoped registration instead (it
// wires this hook inside the reviewer agents' own JSON configs, so every
// call arriving through that registration IS the reviewer's). Kiro IDE
// ships no registration: its hook payloads carry no tool inputs, so a
// pre-tool matcher has nothing to inspect there.
//
// Fail-open everywhere: no record, a stale record (mtime beyond
// REVIEWER_DISPATCH_TTL_MS - janitored like the compose marker), malformed
// stdin or record JSON, an unknown tool, a non-reviewer agent, or any throw
// allows the call. The deterministic off-switch
// AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1 disables enforcement entirely (the
// documented escape hatch for false-positive storms, mirroring the
// human-presence guard's off-switch). Every genuine block emits a
// REVIEWER_SCOPE_BLOCKED audit event so the run's record shows when the
// bound bit; audit failures never change the decision.

import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import {
  auditFilePath,
  type ClaudeCodeHookInput,
  errorMessage,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  recordHookDrop,
  resolveProjectDirFromHook,
  REVIEWER_DISPATCH_TTL_MS,
  reviewerDispatchPath,
  toPosix,
} from "../tools/aidlc-lib.ts";

const HOOK_NAME = "reviewer-scope";

// --- The pure matcher --------------------------------------------------------
//
// Everything below up to the main section is side-effect free and exported so
// the decision table is unit-testable without a live session. The hook body
// only wires stdin, the dispatch record, and the exit code around it.

/** The conductor-written dispatch record (12a step 1). */
export interface ReviewerDispatch {
  /** Agent name of the dispatched reviewer, e.g. aidlc-architecture-reviewer-agent. */
  reviewer: string;
  /** Stage slug the review belongs to, e.g. nfr-requirements. */
  stage: string;
  /** The unit under review - the one construction/<unit>/ subtree in scope. */
  unit: string;
  /** Resolved paths the reviewer may touch beyond the current unit: the
   *  directive.consumes contracts, the stage file, the Q&A file, and (when the
   *  current unit's design explicitly names an integration point) that one
   *  owning file. Only entries containing a construction/ component matter to
   *  the matcher - everything outside construction/ is never blocked. */
  exempt: string[];
}

/** The matcher's verdict. `target` names the offending path or token. */
export interface ScopeVerdict {
  block: boolean;
  target?: string;
}

// Glob metacharacters. A sibling segment carrying any of these spans units
// (a `construction/*/` glob is a sibling read, not a search).
const WILDCARD_RE = /[*?[\]{}]/;

// Path-shaped tools contribute their path fields; Bash contributes the whole
// command string; Glob/Grep contribute their pattern/glob fields (which are
// path-shaped) plus their search-root path. Grep's `pattern` field is the
// CONTENT regex, deliberately not scanned: matching file content is not a
// file access, and scanning it would block a legitimate grep of the current
// unit for text that merely mentions a sibling path.
function candidateStrings(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): Array<{ text: string; kind: "path" | "command" }> {
  const ti = toolInput ?? {};
  const out: Array<{ text: string; kind: "path" | "command" }> = [];
  const push = (v: unknown, kind: "path" | "command") => {
    if (typeof v === "string" && v.length > 0) out.push({ text: v, kind });
  };
  switch (toolName) {
    case "Bash":
      push(ti.command, "command");
      break;
    case "Read":
    case "Edit":
    case "Write":
      push(ti.file_path, "path");
      push(ti.path, "path");
      if (Array.isArray(ti.paths)) for (const p of ti.paths) push(p, "path");
      break;
    case "Glob":
      push(ti.pattern, "command");
      push(ti.path, "path");
      break;
    case "Grep":
      push(ti.glob, "command");
      push(ti.path, "path");
      break;
    default:
      break;
  }
  return out;
}

// Split a path into components, dropping empty and "." segments and
// COLLAPSING ".." against its parent. Without the collapse,
// construction/U03/../U01/design.md would be judged on U03 (the first
// segment after construction/) and allowed even though the filesystem
// resolves it into sibling U01. A leading ".." with no parent to consume is
// kept as-is (it climbs above the visible string; the sweep/wildcard rules
// in judgeOccurrence apply to whatever remains).
function normalizedComps(p: string): string[] {
  const out: string[] = [];
  for (const c of toPosix(p).split("/")) {
    if (c.length === 0 || c === ".") continue;
    if (c === ".." && out.length > 0 && out[out.length - 1] !== "..") {
      out.pop();
      continue;
    }
    out.push(c);
  }
  return out;
}

// The construction/-suffix of an exempt entry, component-normalized, or null
// when the entry never enters construction/ (those entries are irrelevant to
// the matcher - non-construction paths are always allowed).
function exemptSuffixOf(entry: string): string | null {
  const comps = normalizedComps(entry);
  const i = comps.indexOf("construction");
  if (i === -1) return null;
  return comps.slice(i).join("/");
}

// Judge one construction/ occurrence: the first path segment after the
// construction component decides. Current unit -> allow; wildcard or missing
// (a sweep root) -> block; a concrete sibling -> allow only on an exact
// exempt-suffix match (the single owning file of a named integration point),
// else block. Exactness is deliberate: browsing an exempt file's parent
// directory is still a sibling browse.
function judgeOccurrence(
  suffixComps: string[],
  unit: string,
  exemptSuffixes: ReadonlySet<string>,
): boolean {
  const seg = suffixComps[1];
  if (seg === undefined || seg.length === 0) return true; // bare construction/ sweep root
  if (seg === unit) return false; // the dispatched unit
  if (WILDCARD_RE.test(seg)) return true; // a pattern spanning siblings
  return !exemptSuffixes.has(suffixComps.join("/"));
}

/**
 * The reviewer read-scope decision. Pure: no I/O, no environment.
 * Returns block=true with the offending target when the tool call reaches
 * into a sibling unit's construction/ subtree (or spans siblings via a
 * wildcard) and the target is not on the exempt list.
 */
export function evaluateReviewerScope(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  dispatch: Pick<ReviewerDispatch, "unit" | "exempt">,
): ScopeVerdict {
  const exemptSuffixes = new Set<string>();
  for (const e of dispatch.exempt) {
    const s = exemptSuffixOf(e);
    if (s !== null) exemptSuffixes.add(s);
  }

  for (const { text, kind } of candidateStrings(toolName, toolInput)) {
    if (kind === "path") {
      const comps = normalizedComps(text);
      for (let i = 0; i < comps.length; i++) {
        if (comps[i] !== "construction") continue;
        if (judgeOccurrence(comps.slice(i), dispatch.unit, exemptSuffixes)) {
          return { block: true, target: text };
        }
      }
    } else {
      // Command / pattern text, two token shapes:
      //   1. `construction/<...>` anywhere (quoted or not) - the token ends
      //      at whitespace, a quote, or a shell separator; glob characters
      //      stay in (they are what the wildcard rule inspects).
      //   2. A token ENDING in the bare `construction` component - `grep -rn
      //      x construction`, `find construction`, `ls ./construction`,
      //      `ls a/b/construction` - names the whole tree as a search root,
      //      the same sweep as `construction/`. This rule runs on the text
      //      with QUOTED SPANS REMOVED, so the word inside a content regex
      //      (`grep 'construction phase' ...`) stays content, not a path; an
      //      UNQUOTED single-word pattern (`grep construction file.md`) still
      //      blocks - a deliberate conservative trade, and the block reason
      //      tells the reviewer to quote the word and retry.
      // A shell variable in the unit segment (construction/$UNIT/...) blocks
      // CONSERVATIVELY: the matcher cannot resolve it, so it is judged as an
      // unexempted segment even when it would expand to the current unit -
      // the block reason tells the reviewer to use the literal unit name.
      for (const m of text.matchAll(/construction\/[^\s"'`;|&()]*/g)) {
        const token = m[0].replace(/[.,:]+$/, "");
        const suffixComps = normalizedComps(token);
        if (judgeOccurrence(suffixComps, dispatch.unit, exemptSuffixes)) {
          return { block: true, target: token };
        }
      }
      const unquoted = text.replace(/'[^']*'|"[^"]*"/g, " ");
      if (/(?:^|[\s;|&(=])(?:[^\s;|&()]*\/)?construction(?=[\s;|&)]|$)/.test(unquoted)) {
        // A bare sweep root is always a block (judgeOccurrence's seg-missing
        // rule); no exempt entry can whitelist reading every unit.
        return { block: true, target: "construction" };
      }
    }
  }
  return { block: false };
}

/** Parse + validate a dispatch record's JSON. Null on any shape miss. */
export function parseDispatchRecord(raw: string): ReviewerDispatch | null {
  try {
    const o: unknown = JSON.parse(raw);
    if (o === null || typeof o !== "object") return null;
    const r = o as Record<string, unknown>;
    if (typeof r.reviewer !== "string" || r.reviewer.length === 0) return null;
    if (typeof r.unit !== "string" || r.unit.length === 0) return null;
    if (typeof r.stage !== "string") return null;
    if (!Array.isArray(r.exempt) || !r.exempt.every((e) => typeof e === "string")) return null;
    return { reviewer: r.reviewer, stage: r.stage, unit: r.unit, exempt: r.exempt as string[] };
  } catch {
    return null;
  }
}

// The block reason handed back to the reviewer through the harness's
// PreToolUse error channel. Self-explaining and redirecting: it names the
// scope, the offending target, and the sanctioned alternative, so the
// reviewer self-corrects without retrying the same call.
export function blockReason(target: string, dispatch: ReviewerDispatch): string {
  return (
    `reviewer read-scope: "${target}" reaches into sibling units' construction/ paths. ` +
    `This review is scoped to unit ${dispatch.unit} plus the contract paths you were passed ` +
    `(the stage file, the Q&A file, and the resolved consumes paths - the shared inception ` +
    `contracts). Verify cross-unit claims against those passed contracts instead of reading ` +
    `sibling units. If this unit's design explicitly names an integration point in a sibling ` +
    `file, report that in your findings rather than opening it; only a file the conductor ` +
    `put on the dispatch exempt list is readable here. (If you meant to access the CURRENT ` +
    `unit, write the literal unit name - shell variables in the path cannot be verified and ` +
    `are refused; if you meant the WORD construction as search text, quote the pattern.)`
  );
}

// The two shipped review-only agents. Used ONLY for the advisory
// missing-record drop below (when one of these is active with no dispatch
// record and touches construction/ paths, the conductor likely forgot the 12a
// step-1 write); the dispatch record's reviewer field is the authoritative
// identity during enforcement.
const REVIEW_AGENT_RE = /^aidlc-(architecture-reviewer|product-lead)-agent$/;

// --- Main ---------------------------------------------------------------------

if (import.meta.main) {
  // Deterministic off-switch: enforcement disabled entirely.
  if (process.env.AIDLC_DISABLE_REVIEWER_SCOPE_HOOK === "1") process.exit(0);

  const projectDir = resolveProjectDirFromHook(import.meta.url);

  try {
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, `${HOOK_NAME}.last`), isoTimestamp(), "utf-8");
  } catch {
    // Heartbeat failure is non-fatal - never let it affect the decision.
  }

  // A TTY means no harness JSON is coming (test / debug contexts) - allow.
  if (process.stdin.isTTY) process.exit(0);

  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(await Bun.stdin.text());
    if (!isClaudeCodeHookInput(raw)) process.exit(0);
    parsed = raw;
  } catch {
    process.exit(0); // malformed stdin - fail open
  }

  const toolName = parsed.tool_name ?? "";
  const toolInput = parsed.tool_input;
  if (!["Read", "Edit", "Write", "Glob", "Grep", "Bash"].includes(toolName)) {
    process.exit(0);
  }

  const recordPath = reviewerDispatchPath(projectDir);
  if (!existsSync(recordPath)) {
    // No review in flight. One advisory: a review-only agent touching
    // construction/ paths with no dispatch record suggests the conductor
    // skipped the 12a step-1 write - surfaced via the doctor's drop counters,
    // never a block (the record is the only source of unit + exempt, so there
    // is nothing sound to enforce without it).
    try {
      const agent = parsed.agent_type ?? "";
      if (REVIEW_AGENT_RE.test(agent)) {
        const touchesConstruction = candidateStrings(toolName, toolInput).some((c) =>
          toPosix(c.text).includes("construction/"),
        );
        if (touchesConstruction) {
          recordHookDrop(
            projectDir,
            HOOK_NAME,
            `${agent} touched construction/ paths with no reviewer dispatch record; enforcement skipped (write the 12a step-1 dispatch record before invoking a per-unit reviewer)`,
          );
        }
      }
    } catch {
      // Advisory only.
    }
    process.exit(0);
  }

  let dispatch: ReviewerDispatch | null = null;
  try {
    const ageMs = Date.now() - statSync(recordPath).mtimeMs;
    if (ageMs > REVIEWER_DISPATCH_TTL_MS) {
      // Orphaned record (a session crashed between dispatch and verdict):
      // ignore it and best-effort janitor it so a stale window cannot keep
      // refusing sibling access indefinitely. Mirrors the compose marker.
      try {
        unlinkSync(recordPath);
      } catch {
        // Unlink failure is non-fatal - the staleness check already refused it.
      }
      recordHookDrop(
        projectDir,
        HOOK_NAME,
        "ignoring an orphaned reviewer dispatch record (older than the freshness window); cleaned it up",
      );
      process.exit(0);
    }
    dispatch = parseDispatchRecord(await Bun.file(recordPath).text());
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    process.exit(0); // unreadable record - fail open
  }
  if (dispatch === null) {
    recordHookDrop(projectDir, HOOK_NAME, "reviewer dispatch record is malformed; enforcement skipped");
    process.exit(0);
  }

  // Identity: enforce only for the dispatched reviewer. Claude Code and Codex
  // deliver the active subagent's name as agent_type (absent on main-session
  // calls). The Kiro CLI adapter instead asserts scoped_registration - it
  // registers this hook inside the reviewer agents' own JSON configs, so
  // every call arriving through that registration is the reviewer's. (Kiro
  // IDE ships no registration at all: its hook payloads carry no tool inputs,
  // so there is nothing to match on there.) Anything else - the conductor's
  // own calls, other subagents - passes through untouched.
  const agentType = parsed.agent_type ?? "";
  const scopedRegistration = parsed.scoped_registration === true;
  const isDispatchedReviewer =
    agentType.length > 0 ? agentType === dispatch.reviewer : scopedRegistration;
  if (!isDispatchedReviewer) process.exit(0);

  let verdict: ScopeVerdict;
  try {
    verdict = evaluateReviewerScope(toolName, toolInput, dispatch);
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    process.exit(0); // matcher failure - fail open
  }
  if (!verdict.block) process.exit(0);

  // Audit the refusal so the run's record shows when the bound bit.
  // Best-effort: an audit failure never changes the block decision.
  try {
    if (existsSync(auditFilePath(projectDir))) {
      appendAuditEntry(
        "REVIEWER_SCOPE_BLOCKED",
        {
          Tool: toolName,
          Target: verdict.target ?? "",
          Stage: dispatch.stage,
          Unit: dispatch.unit,
        },
        projectDir,
      );
    }
  } catch {
    // Advisory emission only.
  }

  process.stderr.write(`${blockReason(verdict.target ?? "", dispatch)}\n`);
  process.exit(2); // harness PreToolUse reject contract: exit 2 + stderr blocks
}
