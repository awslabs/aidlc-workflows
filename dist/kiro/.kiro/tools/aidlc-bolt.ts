// aidlc-bolt.ts — Construction-phase bolt lifecycle
//
// A bolt is one execution of stages 3.1-3.5 for a Unit (or small group of
// dependency-linked Units). This tool owns BOLT_STARTED, BOLT_COMPLETED,
// BOLT_FAILED, and AUTONOMY_MODE_SET emissions — separated from aidlc-state
// to keep Construction-phase specifics out of the general state tool.
// `abort` reuses BOLT_FAILED with a `Reason: aborted` field rather than
// adding a new event type — keeps the audit count stable and uses field
// taxonomy for sub-classification per the project pattern.
//
// AUTONOMY_MODE_SET also updates the Construction Autonomy Mode field in
// aidlc-state.md atomically with its audit emission.
//
// Per-Bolt worktree lifecycle integration. The CLI surface mirrors the
// lifecycle's three terminal states:
//   start --worktree  — fork state + audit + runtime-graph fragment on
//                       Bolt start (delegates to state-fork + audit-fork +
//                       fragment-fork; no duplicate writes)
//   complete --merge  — merge state + audit + runtime-graph fragment
//                       back to main on success
//   abort  --discard  — explicit user-driven abort; optional discard tear-down
// The fail subcommand is unchanged in behaviour: code-gen returned an error,
// halt-and-ask preserves the worktree by default. abort is the user's
// explicit "I want this gone" verb.
//
// Runtime-graph fragment-fork / fragment-merge complete the fork/merge
// triad alongside state and audit. The fragment file lives at
// <wt>/aidlc-docs/runtime-graph.json (gitignored, mirrors main). No new
// audit events for the fragment lifecycle — it rides on the existing
// STATE_FORKED + AUDIT_FORKED (fork) and STATE_MERGED + AUDIT_MERGED
// (merge) boundaries.
//
// Atomicity per the practices-promote / handleSetAutonomy precedent:
// validate inputs FIRST, emit primary audit event AFTER validation passes,
// THEN delegate to state-fork / audit-fork subprocess CLIs (which emit
// their own events inside withAuditLock). Never duplicate state mutations
// the sibling primitives already own (Bolt Refs, Worktree Path) — this is
// the t48 emitter-pairing rule.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  emitError,
  errorMessage,
  getField,
  relativeRecordDir,
  readStateFile,
  resolveProjectDir,
  setFieldStrict,
  setOrInsertField,
  worktreePath,
  worktreeStateFilePath,
  writeStateFile,
} from "./aidlc-lib.js";
import { compiledExecutable } from "./aidlc-runtime-paths.ts";

function emitAudit(
  pd: string,
  eventType: string,
  fields: Record<string, string>,
  intent?: string,
  space?: string
): void {
  appendAuditEntry(eventType, fields, pd, intent, space);
}

// The intent/space/repo SELECTOR re-serialised for a delegated sibling spawn. A
// Bolt pair (start --worktree / complete --merge) must propagate the SAME selector
// to every fork/merge primitive so they all target ONE intent end-to-end (vision
// §5). The --repo dimension (P7) likewise rides along so a delegated git op
// (aidlc-worktree discard on abort --discard) anchors to the same sibling repo the
// fork used. Returns [] when no flag is present -> the primitives default-resolve
// (the active cursor / inferred lone repo), today's behaviour.
function selectorArgs(flags: Record<string, string>): string[] {
  const out: string[] = [];
  if (flags.intent) out.push("--intent", flags.intent);
  if (flags.space) out.push("--space", flags.space);
  if (flags.repo) out.push("--repo", flags.repo);
  return out;
}

// --- Flag parsing ---

// Boolean flags carry no value. Filter them out before parseFlags so the
// strict value-required scan doesn't reject them. The --worktree / --merge
// / --discard flags drive the per-Bolt lifecycle integration.
const BOOLEAN_FLAGS = new Set(["--worktree", "--merge", "--discard"]);

function splitBooleanFlags(args: string[]): { booleans: Set<string>; rest: string[] } {
  const booleans = new Set<string>();
  const rest: string[] = [];
  for (const a of args) {
    if (BOOLEAN_FLAGS.has(a)) {
      booleans.add(a.slice(2));
    } else {
      rest.push(a);
    }
  }
  return { booleans, rest };
}

// Spawn a sibling tool (same project-dir) and return {ok, stdout, stderr}.
// Used by --worktree / --merge / --discard branches to delegate to
// state-fork / audit-fork / worktree-discard subcommands. 30s timeout
// matches the merge-dispatch budget; on timeout, signal === "SIGTERM"
// distinguishes the timeout case from an exit-code failure.
function spawnSibling(
  pd: string,
  toolName:
    | "aidlc-state.ts"
    | "aidlc-audit.ts"
    | "aidlc-worktree.ts"
    | "aidlc-runtime.ts",
  subargs: string[]
): { ok: boolean; stdout: string; stderr: string; signal: string | null; status: number | null } {
  const executable = compiledExecutable();
  let command: string[];
  if (executable) {
    const noun = toolName.replace(/^aidlc-/, "").replace(/\.ts$/, "");
    if (noun === "audit") {
      const [verb, ...rest] = subargs;
      const publicVerb = verb === "audit-fork"
        ? "fork"
        : verb === "audit-merge" ? "merge" : verb;
      command = [executable, "audit", publicVerb, ...rest, "--project-dir", pd];
    } else {
      command = [executable, noun, ...subargs, "--project-dir", pd];
    }
  } else {
    command = [
      process.execPath,
      fileURLToPath(new URL(`./${toolName}`, import.meta.url)),
      "--project-dir",
      pd,
      ...subargs,
    ];
  }
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf-8",
    cwd: pd,
    timeout: 30_000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    signal: result.signal,
    status: result.status,
  };
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    if (i + 1 >= args.length) {
      error(`${a} expects a value, got end of arguments.`);
    }
    const val = args[i + 1];
    if (val.startsWith("--")) {
      error(`${a} expects a value, got another flag: "${val}". Did you forget the value?`);
    }
    flags[a.slice(2)] = val;
    i++;
  }
  return flags;
}

// --- Subcommand: start ---
// Usage: aidlc-bolt start --name <bolt-names> --batch <n>
//                         [--walking-skeleton true|false]
//                         [--worktree --slug <kebab-slug>] [--repo <name>]
//
// --name accepts a single bolt name or comma-separated list for a parallel batch.
//
// --repo (P7): the sibling repo the Bolt operates in. start does no git itself
// (the worktree was created by aidlc-worktree create), but --repo rides the
// selector to every delegated primitive so the whole Bolt pair targets one repo.
//
// --worktree: after BOLT_STARTED, delegates to `aidlc-state.ts fork` and
// `aidlc-audit.ts audit-fork` to fork state and audit into the Bolt's
// worktree. Requires --slug for the kebab-case Bolt slug (per SKILL.md
// slug-derivation rule). Single-bolt only — csv batch with --worktree is
// rejected. Per-Bolt parallel batches issue N start --worktree calls, one
// per slug.
function handleStart(args: string[]): void {
  const { booleans, rest } = splitBooleanFlags(args);
  const flags = parseFlags(rest);
  if (!flags.name) error("Missing --name <bolt-name or csv>");
  if (!flags.batch) error("Missing --batch <batch-number>");
  if (!/^[1-9][0-9]*$/.test(flags.batch)) {
    error(`Invalid --batch: "${flags.batch}". Must be a positive integer.`);
  }

  const pd = resolveProjectDir(projectDir);
  const walkingSkeleton = flags["walking-skeleton"] === "true";
  const useWorktree = booleans.has("worktree");

  if (useWorktree) {
    if (!flags.slug) {
      error("--worktree requires --slug <kebab-slug>");
    }
    if (flags.name.includes(",")) {
      error(
        `--worktree requires a single bolt name; got csv: "${flags.name}". Issue one start --worktree per bolt.`
      );
    }
  }

  // Validate state-file shape FIRST. setFieldStrict-equivalent: read state
  // and confirm we can find it; if not, fail before any audit emit so a
  // missing state file doesn't leave an orphan BOLT_STARTED.
  if (useWorktree) {
    try {
      readStateFile(pd);
    } catch (e) {
      failJson("start-worktree", flags.slug, "state-read-failed", errorMessage(e));
    }
  }

  // Audit-first within validated context: emit BOLT_STARTED only after
  // shape checks pass. The state-fork / audit-fork primitives below emit
  // their own STATE_FORKED / AUDIT_FORKED rows inside withAuditLock — we
  // must not duplicate that here (per t48 emitter-pairing check).
  try {
    const fields: Record<string, string> = {
      "Bolt names": flags.name,
      "Batch number": flags.batch,
      "Walking skeleton": String(walkingSkeleton),
    };
    if (useWorktree) {
      fields["Bolt slug"] = flags.slug;
    }
    emitAudit(pd, "BOLT_STARTED", fields, flags.intent, flags.space);
  } catch (e) {
    if (useWorktree) {
      failJson("start-worktree", flags.slug, "audit-emit-failed", errorMessage(e));
    }
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  if (!useWorktree) {
    console.log(
      JSON.stringify({
        emitted: "BOLT_STARTED",
        bolt_names: flags.name,
        batch: flags.batch,
        walking_skeleton: walkingSkeleton,
      })
    );
    return;
  }

  // --worktree path: delegate to state-fork (emits STATE_FORKED inside
  // withAuditLock; manages Bolt Refs append on main; writes worktree state
  // file). On failure, BOLT_STARTED is already in audit — emit BOLT_FAILED
  // recovery row so audit reflects the real outcome and doctor can
  // reconcile.
  const stateForkResult = spawnSibling(pd, "aidlc-state.ts", [
    "fork",
    "--slug",
    flags.slug,
    ...selectorArgs(flags),
  ]);
  if (!stateForkResult.ok) {
    const reason =
      stateForkResult.signal === "SIGTERM" ? "state-fork-timeout" : "state-fork-failed";
    failBolt(pd, flags.name, flags.slug, reason, stateForkResult.stderr || stateForkResult.stdout);
    failJson(
      "start-worktree",
      flags.slug,
      reason,
      `aidlc-state fork --slug ${flags.slug} exited ${stateForkResult.status}: ${stateForkResult.stderr || stateForkResult.stdout || "(no output)"}`
    );
  }

  // Audit-fork primitive. Emits AUDIT_FORKED audit-of-intent.
  const auditForkResult = spawnSibling(pd, "aidlc-audit.ts", [
    "audit-fork",
    "--slug",
    flags.slug,
    ...selectorArgs(flags),
  ]);
  if (!auditForkResult.ok) {
    const reason =
      auditForkResult.signal === "SIGTERM" ? "audit-fork-timeout" : "audit-fork-failed";
    failBolt(pd, flags.name, flags.slug, reason, auditForkResult.stderr || auditForkResult.stdout);
    failJson(
      "start-worktree",
      flags.slug,
      reason,
      `aidlc-audit audit-fork --slug ${flags.slug} exited ${auditForkResult.status}: ${auditForkResult.stderr || auditForkResult.stdout || "(no output)"}`
    );
  }

  // Fragment-fork primitive. Byte-copies main runtime-graph.json into
  // the worktree's fragment path; one-shot guard. No audit emit — the
  // fragment lifecycle rides on the existing STATE_FORKED + AUDIT_FORKED
  // boundary.
  const fragmentForkResult = spawnSibling(pd, "aidlc-runtime.ts", [
    "fragment-fork",
    "--slug",
    flags.slug,
    ...selectorArgs(flags),
  ]);
  if (!fragmentForkResult.ok) {
    const reason =
      fragmentForkResult.signal === "SIGTERM"
        ? "fragment-fork-timeout"
        : "fragment-fork-failed";
    failBolt(
      pd,
      flags.name,
      flags.slug,
      reason,
      fragmentForkResult.stderr || fragmentForkResult.stdout
    );
    failJson(
      "start-worktree",
      flags.slug,
      reason,
      `aidlc-runtime fragment-fork --slug ${flags.slug} exited ${fragmentForkResult.status}: ${fragmentForkResult.stderr || fragmentForkResult.stdout || "(no output)"}`
    );
  }

  console.log(
    JSON.stringify({
      emitted: "BOLT_STARTED",
      bolt_names: flags.name,
      batch: flags.batch,
      walking_skeleton: walkingSkeleton,
      slug: flags.slug,
      forked: ["STATE_FORKED", "AUDIT_FORKED", "RUNTIME_GRAPH_FORKED"],
    })
  );
}

// --- Subcommand: complete ---
// Usage: aidlc-bolt complete --name <bolt-names> --batch <n>
//                            [--merge --slug <kebab-slug>]
//
// --merge: after BOLT_COMPLETED, delegates to `aidlc-state.ts merge` and
// `aidlc-audit.ts audit-merge` to
// consolidate state + audit back to main. Runs BEFORE SKILL.md Step 6.5's
// git-merge dispatch so AIDLC metadata consolidates first. Single-bolt
// only — csv batch with --merge is rejected.
function handleComplete(args: string[]): void {
  const { booleans, rest } = splitBooleanFlags(args);
  const flags = parseFlags(rest);
  if (!flags.name) error("Missing --name <bolt-name or csv>");
  if (!flags.batch) error("Missing --batch <batch-number>");
  if (!/^[1-9][0-9]*$/.test(flags.batch)) {
    error(`Invalid --batch: "${flags.batch}". Must be a positive integer.`);
  }

  const pd = resolveProjectDir(projectDir);
  const useMerge = booleans.has("merge");

  if (useMerge) {
    if (!flags.slug) {
      error("--merge requires --slug <kebab-slug>");
    }
    if (flags.name.includes(",")) {
      error(
        `--merge requires a single bolt name; got csv: "${flags.name}". Issue one complete --merge per bolt.`
      );
    }
    // HOLD-MERGE invariant enforcement.
    // SKILL.md U5's multi-failure halt-and-ask sequence sets `Merge-Held: true`
    // on each successful Bolt's per-Bolt forked state file before rendering
    // any failed-sibling AUQ. This refusal pins that invariant in tooling so
    // an orchestrator that forgets the prose contract cannot land a merge
    // mid-AUQ-sequence. Refusal is non-zero exit + stderr; the orchestrator
    // must call `aidlc-bolt release-merge --slug <slug>` once the AUQ
    // sequence resolves before retrying complete --merge.
    if (isMergeHeld(pd, flags.slug, flags.intent, flags.space)) {
      failJson(
        "complete-merge",
        flags.slug,
        "merge-held",
        `Merge held by HOLD-MERGE invariant; resolve the failed-sibling halt-and-ask sequence and run \`aidlc-bolt release-merge --slug ${flags.slug}\` before retrying.`
      );
    }
  }

  try {
    const fields: Record<string, string> = {
      "Bolt names": flags.name,
      "Batch number": flags.batch,
    };
    if (useMerge) {
      fields["Bolt slug"] = flags.slug;
    }
    emitAudit(pd, "BOLT_COMPLETED", fields, flags.intent, flags.space);
  } catch (e) {
    if (useMerge) {
      failJson("complete-merge", flags.slug, "audit-emit-failed", errorMessage(e));
    }
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  if (!useMerge) {
    console.log(
      JSON.stringify({ emitted: "BOLT_COMPLETED", bolt_names: flags.name, batch: flags.batch })
    );
    return;
  }

  // Delegate to state-merge (emits STATE_MERGED inside withAuditLock;
  // removes slug from main's Bolt Refs; merges per-field rules from worktree).
  const stateMergeResult = spawnSibling(pd, "aidlc-state.ts", [
    "merge",
    "--slug",
    flags.slug,
    ...selectorArgs(flags),
  ]);
  if (!stateMergeResult.ok) {
    const reason =
      stateMergeResult.signal === "SIGTERM" ? "state-merge-timeout" : "state-merge-failed";
    failBolt(pd, flags.name, flags.slug, reason, stateMergeResult.stderr || stateMergeResult.stdout);
    failJson(
      "complete-merge",
      flags.slug,
      reason,
      `aidlc-state merge --slug ${flags.slug} exited ${stateMergeResult.status}: ${stateMergeResult.stderr || stateMergeResult.stdout || "(no output)"}`
    );
  }

  // Audit-merge primitive. Emits AUDIT_MERGED after appending the
  // worktree's post-fork delta to main audit.
  const auditMergeResult = spawnSibling(pd, "aidlc-audit.ts", [
    "audit-merge",
    "--slug",
    flags.slug,
    ...selectorArgs(flags),
  ]);
  if (!auditMergeResult.ok) {
    const reason =
      auditMergeResult.signal === "SIGTERM" ? "audit-merge-timeout" : "audit-merge-failed";
    failBolt(pd, flags.name, flags.slug, reason, auditMergeResult.stderr || auditMergeResult.stdout);
    failJson(
      "complete-merge",
      flags.slug,
      reason,
      `aidlc-audit audit-merge --slug ${flags.slug} exited ${auditMergeResult.status}: ${auditMergeResult.stderr || auditMergeResult.stdout || "(no output)"}`
    );
  }

  // Fragment-merge primitive. Removes the worktree's runtime-graph.json
  // fragment. Idempotent — fragment-absent is a clean no-op. The post-Bash
  // hook fires after this Bash invocation returns, sees AUDIT_MERGED in
  // the last 3 audit blocks (per aidlc-runtime-compile.ts:87), and rebuilds
  // main runtime-graph with instances[] populated for this slug.
  const fragmentMergeResult = spawnSibling(pd, "aidlc-runtime.ts", [
    "fragment-merge",
    "--slug",
    flags.slug,
    ...selectorArgs(flags),
  ]);
  if (!fragmentMergeResult.ok) {
    const reason =
      fragmentMergeResult.signal === "SIGTERM"
        ? "fragment-merge-timeout"
        : "fragment-merge-failed";
    failBolt(
      pd,
      flags.name,
      flags.slug,
      reason,
      fragmentMergeResult.stderr || fragmentMergeResult.stdout
    );
    failJson(
      "complete-merge",
      flags.slug,
      reason,
      `aidlc-runtime fragment-merge --slug ${flags.slug} exited ${fragmentMergeResult.status}: ${fragmentMergeResult.stderr || fragmentMergeResult.stdout || "(no output)"}`
    );
  }

  console.log(
    JSON.stringify({
      emitted: "BOLT_COMPLETED",
      bolt_names: flags.name,
      batch: flags.batch,
      slug: flags.slug,
      merged: ["STATE_MERGED", "AUDIT_MERGED", "RUNTIME_GRAPH_MERGED"],
    })
  );
}

// --- Subcommand: fail ---
// Usage: aidlc-bolt fail --name <failed-bolt> --error <summary>
//                        [--slug <kebab-slug>] [--succeeded-siblings <csv>]
//
// `--slug` is optional but should be passed by halt-and-ask flows so
// downstream `aidlc-worktree info --slug` can correlate the failed Bolt
// with its WORKTREE_CREATED audit entry. `--name` is the human-prose Bolt
// name; `--slug` is the kebab-case derivative threaded through worktree
// commands.
function handleFail(args: string[]): void {
  const flags = parseFlags(args);
  if (!flags.name) error("Missing --name <failed-bolt>");
  if (!flags.error) error("Missing --error <summary>");

  const pd = resolveProjectDir(projectDir);
  const fields: Record<string, string> = {
    "Failed Bolt": flags.name,
    "Error summary": flags.error,
  };
  if (flags.slug) {
    fields["Bolt slug"] = flags.slug;
  }
  if (flags["succeeded-siblings"]) {
    fields["Succeeded siblings"] = flags["succeeded-siblings"];
  }

  try {
    emitAudit(pd, "BOLT_FAILED", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(
    JSON.stringify({ emitted: "BOLT_FAILED", failed_bolt: flags.name, error: flags.error })
  );
}

// --- Subcommand: abort ---
// Usage: aidlc-bolt abort --name <bolt-name> --slug <kebab-slug> --reason <text>
//                         [--discard]
//
// Explicit user-driven abort (Issue 75 US-1 line 51). Emits BOLT_FAILED with
// `Reason: aborted` for sub-classification — keeps the audit count stable
// vs adding a new BOLT_ABORTED event type. Distinct from `fail` (which is
// emitted by the orchestrator when code-gen returns failure).
//
// Default behaviour preserves the worktree directory for inspection. With
// --discard, calls aidlc-worktree discard --slug <slug> to tear it down
// (audit-of-intent: WORKTREE_DISCARDED emits before tear-down inside the
// discard subprocess; on discard failure, halt without state damage).
function handleAbort(args: string[]): void {
  const { booleans, rest } = splitBooleanFlags(args);
  const flags = parseFlags(rest);
  if (!flags.name) error("Missing --name <bolt-name>");
  if (!flags.slug) error("Missing --slug <kebab-slug>");
  if (!flags.reason) error("Missing --reason <text>");

  const pd = resolveProjectDir(projectDir);
  const useDiscard = booleans.has("discard");

  // Discard-FIRST when --discard set, audit-AFTER. If we emitted BOLT_FAILED
  // (Reason: aborted) before discard and discard then timed out / errored,
  // the audit would claim the Bolt was aborted-and-cleaned-up while the
  // worktree directory still existed on disk and the slug remained in main's
  // Bolt Refs (cleared by aidlc-worktree discard's WORKTREE_DISCARDED path).
  // Caught by post-ship 4-agent review (adversarial agent BLOCKER finding).
  // Default path (no --discard) preserves the worktree per US-1 AC line 51,
  // so emit-before-noop is safe and the ordering only matters for --discard.
  if (useDiscard) {
    const result = spawnSibling(pd, "aidlc-worktree.ts", [
      "discard",
      "--slug",
      flags.slug,
      ...selectorArgs(flags),
    ]);
    if (!result.ok) {
      const reason = result.signal === "SIGTERM" ? "discard-timeout" : "discard-failed";
      failJson(
        "abort-discard",
        flags.slug,
        reason,
        `aidlc-worktree discard --slug ${flags.slug} exited ${result.status}: ${result.stderr || result.stdout || "(no output)"}`
      );
    }
  }

  // Audit emission AFTER discard side-effect lands successfully (or no
  // side-effect requested). On audit emit failure here, the worktree is
  // already gone (if --discard) but the audit row is missing — this is
  // recoverable drift that doctor reconciles via the worktree's local
  // audit if it survived, or by orphan-worktree detection if not.
  try {
    emitAudit(pd, "BOLT_FAILED", {
      "Failed Bolt": flags.name,
      "Bolt slug": flags.slug,
      "Error summary": `aborted: ${flags.reason}`,
      Reason: "aborted",
    }, flags.intent, flags.space);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(
    JSON.stringify({
      emitted: "BOLT_FAILED",
      reason: "aborted",
      failed_bolt: flags.name,
      slug: flags.slug,
      discarded: useDiscard,
    })
  );
}

// --- Subcommand: hold-merge / release-merge ---
// Usage: aidlc-bolt hold-merge --slug <slug>
//        aidlc-bolt release-merge --slug <slug>
//
// HOLD-MERGE invariant tooling. Sets / clears the `Merge-Held` field in
// the per-Bolt forked state file at
// `<projectDir>/.aidlc/worktrees/bolt-<slug>/aidlc-docs/aidlc-state.md`.
// Idempotent — re-running hold-merge on an already-held Bolt or
// release-merge on an unheld Bolt succeeds without error. The field is
// inserted under `## Project Information` on first hold-merge so the
// current state template does not need a bump for this optional marker.
// Reads are via `isMergeHeld` below; checked in `complete --merge` to
// refuse mid-AUQ merges and exposed via `aidlc-worktree info` for
// resume-path checks.
//
// No audit emission — Merge-Held is internal coordination state, not a
// user-visible event. The audit row that matters for doctor is the
// BOLT_FAILED that opens the multi-failure sequence and the BOLT_COMPLETED
// that closes each survivor's merge once the hold lifts.
//
// Future doctor extension: orphan Merge-Held detection. Walk per-Bolt
// forked state for `Merge-Held: true`, cross-check parent batch's
// BOLT_FAILED resolution status, flag if all siblings resolved (succeeded
// retry / skipped / aborted) but `release-merge` never ran. Needs a
// workshop-resume false-positive guard — `merge_held: true` is legitimate
// mid-resume. Reads forked-state files and builds a parent-batch
// resolution graph.
function handleHoldMerge(args: string[]): void {
  const flags = parseFlags(args);
  if (!flags.slug) error("Missing --slug <kebab-slug>");
  const pd = resolveProjectDir(projectDir);
  setMergeHeld(pd, flags.slug, true, flags.intent, flags.space);
  console.log(JSON.stringify({ slug: flags.slug, merge_held: true }));
}

function handleReleaseMerge(args: string[]): void {
  const flags = parseFlags(args);
  if (!flags.slug) error("Missing --slug <kebab-slug>");
  const pd = resolveProjectDir(projectDir);
  setMergeHeld(pd, flags.slug, false, flags.intent, flags.space);
  console.log(JSON.stringify({ slug: flags.slug, merge_held: false }));
}

// Resolve the per-Bolt forked state file path for `slug`. Returns null when
// the worktree directory or state file is absent (a missing forked state
// file is treated as "not held" — the caller proceeds without refusal).
function forkedStateFilePath(
  pd: string,
  slug: string,
  intent?: string,
  space?: string,
): string | null {
  const wtPath = worktreePath(pd, slug);
  // Pin the worktree mirror to the SAME record the state fork wrote (null ->
  // flat legacy mirror, today's behaviour).
  const recordPrefix = relativeRecordDir(pd, intent, space);
  const wtStatePath = worktreeStateFilePath(wtPath, recordPrefix);
  if (!existsSync(wtStatePath)) return null;
  return wtStatePath;
}

function isMergeHeld(pd: string, slug: string, intent?: string, space?: string): boolean {
  const path = forkedStateFilePath(pd, slug, intent, space);
  if (!path) return false;
  const content = readFileSync(path, "utf-8");
  const value = getField(content, "Merge-Held");
  return value === "true";
}

function setMergeHeld(pd: string, slug: string, held: boolean, intent?: string, space?: string): void {
  const path = forkedStateFilePath(pd, slug, intent, space);
  if (!path) {
    error(
      `No per-Bolt forked state file for slug "${slug}" — was \`aidlc-bolt start --worktree --slug ${slug}\` run?`
    );
  }
  const content = readFileSync(path, "utf-8");
  const updated = setOrInsertField(
    content,
    "## Project Information",
    "Merge-Held",
    held ? "true" : "false",
  );
  writeFileSync(path, updated, "utf-8");
}

// --- Subcommand: dispatch-event ---
// Usage: aidlc-bolt dispatch-event --event MERGE_DISPATCH_INVOKED --slug <slug>
//                                  --practices-excerpt <text>
//        aidlc-bolt dispatch-event --event MERGE_DISPATCH_RETURNED --slug <slug>
//                                  --strategy <squash|merge|rebase>
//                                  --target <branch> --confidence <0-1>
//                                  --notes <text>
//        aidlc-bolt dispatch-event --event MERGE_DISPATCH_FALLBACK --slug <slug>
//                                  --reason <enum> --defaults <text>
//
// Wires the three MERGE_DISPATCH_* events by emitting via
// `appendAuditEntry` per event variant. Orchestrator (SKILL.md per-Bolt
// loop) brackets each aidlc-pipeline-deploy-agent dispatch: pre-call INVOKED,
// post-call RETURNED on successful parse, FALLBACK on timeout/malformed-YAML.
//
// Emit-only contract: no state mutation, no spawn. Pure audit emission so
// doctor can reconcile orphan INVOKED rows (slug + timestamp window).
//
// t48 emitter-pairing requires LITERAL `appendAuditEntry("EVENT_NAME")` per
// case branch — Map indirection on the --event flag breaks the grep at
// tests/feature/t48-audit-event-emitters.sh:46-57. Three cases, three literal
// emit calls.
function handleDispatchEvent(args: string[]): void {
  const flags = parseFlags(args);
  if (!flags.event) error("Missing --event <MERGE_DISPATCH_INVOKED|MERGE_DISPATCH_RETURNED|MERGE_DISPATCH_FALLBACK>");
  if (!flags.slug) error("Missing --slug <kebab-slug>");

  const pd = resolveProjectDir(projectDir);

  // Per-variant flag validation + literal emit. Fields populate per the
  // schema at audit-format.md:147-149.
  switch (flags.event) {
    case "MERGE_DISPATCH_INVOKED": {
      if (!flags["practices-excerpt"]) {
        error("MERGE_DISPATCH_INVOKED requires --practices-excerpt <text>");
      }
      const fields: Record<string, string> = {
        "Bolt slug": flags.slug,
        "Practices section excerpt": flags["practices-excerpt"],
      };
      try {
        emitAudit(pd, "MERGE_DISPATCH_INVOKED", fields);
      } catch (e) {
        error(`Audit emission failed: ${errorMessage(e)}`);
      }
      console.log(JSON.stringify({ emitted: "MERGE_DISPATCH_INVOKED", slug: flags.slug }));
      return;
    }
    case "MERGE_DISPATCH_RETURNED": {
      if (!flags.strategy) error("MERGE_DISPATCH_RETURNED requires --strategy <squash|merge|rebase>");
      if (!["squash", "merge", "rebase"].includes(flags.strategy)) {
        error(`Invalid --strategy: ${flags.strategy}. Must be squash, merge, or rebase.`);
      }
      if (!flags.target) error("MERGE_DISPATCH_RETURNED requires --target <branch>");
      if (!flags.confidence) error("MERGE_DISPATCH_RETURNED requires --confidence <0-1>");
      const conf = parseFloat(flags.confidence);
      if (Number.isNaN(conf) || conf < 0 || conf > 1) {
        error(`Invalid --confidence: ${flags.confidence}. Must be a number in [0, 1].`);
      }
      if (!flags.notes) error("MERGE_DISPATCH_RETURNED requires --notes <text>");
      const fields: Record<string, string> = {
        "Bolt slug": flags.slug,
        Strategy: flags.strategy,
        "Target branch": flags.target,
        Confidence: flags.confidence,
        Notes: flags.notes,
      };
      try {
        emitAudit(pd, "MERGE_DISPATCH_RETURNED", fields);
      } catch (e) {
        error(`Audit emission failed: ${errorMessage(e)}`);
      }
      console.log(JSON.stringify({ emitted: "MERGE_DISPATCH_RETURNED", slug: flags.slug }));
      return;
    }
    case "MERGE_DISPATCH_FALLBACK": {
      if (!flags.reason) error("MERGE_DISPATCH_FALLBACK requires --reason <enum>");
      if (!flags.defaults) error("MERGE_DISPATCH_FALLBACK requires --defaults <text>");
      const fields: Record<string, string> = {
        "Bolt slug": flags.slug,
        "Fallback reason": flags.reason,
        "Defaults applied": flags.defaults,
      };
      try {
        emitAudit(pd, "MERGE_DISPATCH_FALLBACK", fields);
      } catch (e) {
        error(`Audit emission failed: ${errorMessage(e)}`);
      }
      console.log(JSON.stringify({ emitted: "MERGE_DISPATCH_FALLBACK", slug: flags.slug }));
      return;
    }
    default:
      error(
        `Invalid --event: ${flags.event}. Must be MERGE_DISPATCH_INVOKED, MERGE_DISPATCH_RETURNED, or MERGE_DISPATCH_FALLBACK.`
      );
  }
}

// --- Subcommand: set-autonomy ---
// Usage: aidlc-bolt set-autonomy --mode autonomous|gated
//
// Emits AUTONOMY_MODE_SET AND updates the Construction Autonomy Mode field
// in aidlc-state.md atomically (audit-first).
function handleSetAutonomy(args: string[]): void {
  const flags = parseFlags(args);
  if (!flags.mode) error("Missing --mode <autonomous|gated>");
  if (!["autonomous", "gated"].includes(flags.mode)) {
    error(`Invalid --mode: ${flags.mode}. Must be 'autonomous' or 'gated'.`);
  }

  const pd = resolveProjectDir(projectDir);

  // Validate state-file shape BEFORE emitting audit. setFieldStrict throws if
  // the field is absent (v4 state files or hand-edited files). If we emitted
  // audit first and the field was missing, we'd leave an orphan
  // AUTONOMY_MODE_SET in audit.md with no corresponding state mutation —
  // exactly the t59-class drift the refactor aims to prevent.
  const content = readStateFile(pd);
  let updated: string;
  try {
    updated = setFieldStrict(content, "Construction Autonomy Mode", flags.mode);
  } catch (e) {
    error(`State update failed: ${errorMessage(e)}`);
  }

  // Now audit-first: emit audit before writing the mutated state.
  try {
    emitAudit(pd, "AUTONOMY_MODE_SET", {
      Mode: flags.mode,
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, updated);

  console.log(
    JSON.stringify({
      emitted: "AUTONOMY_MODE_SET",
      mode: flags.mode,
      state_updated: true,
    })
  );
}

// --- CLI entry point ---

let projectDir: string | undefined;

export function main(argv: string[]): void {
  const rawArgs = argv;

  const filteredArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--project-dir" && i + 1 < rawArgs.length) {
      projectDir = rawArgs[i + 1];
      i++;
    } else {
      filteredArgs.push(rawArgs[i]);
    }
  }

  const subcommand = filteredArgs[0];

  try {
    switch (subcommand) {
      case "start":
        handleStart(filteredArgs.slice(1));
        break;
      case "complete":
        handleComplete(filteredArgs.slice(1));
        break;
      case "fail":
        handleFail(filteredArgs.slice(1));
        break;
      case "abort":
        handleAbort(filteredArgs.slice(1));
        break;
      case "set-autonomy":
        handleSetAutonomy(filteredArgs.slice(1));
        break;
      case "dispatch-event":
        handleDispatchEvent(filteredArgs.slice(1));
        break;
      case "hold-merge":
        handleHoldMerge(filteredArgs.slice(1));
        break;
      case "release-merge":
        handleReleaseMerge(filteredArgs.slice(1));
        break;
      default:
        error(
          `Unknown subcommand: ${subcommand}. Valid: start, complete, fail, abort, set-autonomy, dispatch-event, hold-merge, release-merge`
        );
    }
  } catch (e) {
    error(errorMessage(e));
  }
}

function error(msg: string): never {
  const pd = resolveProjectDir(projectDir);
  const command = `aidlc-bolt ${process.argv.slice(2).join(" ")}`.trim();
  emitError(pd, "aidlc-bolt", command, msg);
}

// Emit BOLT_FAILED for partial-progress recovery in --worktree / --merge
// flows. Best-effort: a failure in the audit emit itself shouldn't mask the
// original error reason, so swallow and let failJson surface the cause.
function failBolt(
  pd: string,
  name: string,
  slug: string,
  reasonEnum: string,
  detail: string
): void {
  try {
    emitAudit(pd, "BOLT_FAILED", {
      "Failed Bolt": name,
      "Bolt slug": slug,
      "Error summary": `${reasonEnum}: ${detail}`,
    });
  } catch {
    /* noop — original error will surface via failJson next */
  }
}

// Print failure-envelope shape and exit non-zero. Distinct from error() above
// (which calls emitError → ERROR_LOGGED audit). This shape is consumed by
// the orchestrator's halt-and-ask prose to render machine-readable failure.
function failJson(
  stage:
    | "start-worktree"
    | "complete-merge"
    | "abort-discard"
    | "hold-merge"
    | "release-merge",
  slug: string,
  reasonEnum: string,
  detail: string
): never {
  const envelope = {
    ok: false,
    slug,
    stage,
    reason: reasonEnum,
    detail,
  };
  console.log(JSON.stringify(envelope));
  process.exit(1);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
