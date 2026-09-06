// harness/devin/emit.ts — the Devin per-shell emission plugin.
//
// The unified packager copies core/ → dist/devin/.devin/ and runs graph compile +
// runner-gen there. This emit() then produces the three surfaces the generic
// projection cannot:
//
//   1. .devin/hooks.v1.json — Devin's hook config. Devin uses Claude Code's JSON
//      SHAPE (event → [{matcher, hooks:[{type, command, timeout}]}]) but its own
//      lowercase snake_case TOOL NAMES, and a different event set. In
//      hooks.v1.json specifically the hooks object IS the whole file — no "hooks"
//      wrapper key.
//
//   2. .devin/hooks/aidlc-devin-adapter.ts — the tool-name translator. Devin's
//      stdin/stdout envelopes and its "exit 2 blocks, reason on stderr" convention
//      already match Claude Code exactly, so the core hook BODIES need no change.
//      What they do need is Claude's PascalCase tool names, because three of them
//      compare tool_name INTERNALLY rather than relying on the matcher:
//        aidlc-review-freeze.ts            toolName === "Bash"
//        aidlc-reviewer-scope.ts           "Grep" / "Glob" / a 10-name allowlist
//        aidlc-state-transition-guard.ts   parsed.tool_name !== "Bash"
//      Fixing only the matchers would leave those three LOADED, MATCHING and
//      SILENTLY NO-OP — enforcement that looks installed and does nothing.
//
//   3. A build-time ASSERTION that every persona subagent carries a Devin-valid
//      `model:`. This used to REWRITE the model (patching tierFlavor "claude"'s
//      `model: inherit` to `opus`), which bypassed the shared tier table in
//      core/tools/aidlc-tiers.ts and meant devin's model dial moved independently
//      of every other harness. Devin is now a real tier column
//      (tierFlavor "devin"), so the packager projects the model like everyone
//      else and this only VERIFIES the result - a projection that ever emitted a
//      non-Devin alias, or omitted the key, fails the build instead of silently
//      downshifting judgment work to Devin's default subagent model.
//
// EVENTS DEVIN DOES NOT HAVE — recorded so the gap is greppable in the harness,
// not only in a design doc:
//   SubagentStop -> NO EQUIVALENT. aidlc-log-subagent cannot fire per subagent;
//                   PostToolUse on run_subagent is unreliable for BACKGROUNDED
//                   subagents (the parent's tool call has already returned).
//   PreCompact    -> Devin has PostCompaction only, firing AFTER a successful
//                   compaction, so validate-state runs post hoc and cannot veto.
//   Notification  -> NO EQUIVALENT.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmitContext } from "../../scripts/manifest-types.ts";

// Devin's documented matchable tool names (docs.devin.ai/cli/extensibility/hooks/
// lifecycle-hooks). Kept as a constant so the hooks.v1.json matchers below and the
// harness test can be checked against one list.
export const DEVIN_TOOL_NAMES = [
  "read", "write", "edit", "apply_patch", "notebook_read", "notebook_edit",
  "grep", "glob",
  "exec", "get_output", "write_to_process", "kill_shell",
  "webfetch",
  "todo_write", "exit_plan_mode",
  "skill",
  "run_subagent", "read_subagent",
  "request_scope",
  "mcp_list_servers", "mcp_list_tools", "mcp_call_tool", "mcp_read_resource",
] as const;

// Devin model names accepted by a subagent/skill `model:` field
// (docs.devin.ai/cli/models). "inherit" is NOT one of them.
const DEVIN_MODELS = ["opus", "sonnet", "swe", "codex", "gemini"] as const;

type HookCmd = { type: "command"; command: string; timeout: number };
type HookGroup = { matcher?: string; hooks: HookCmd[] };

function cmd(sub: string, timeout = 30): HookCmd {
  // Relative path, no $VAR: Devin sets DEVIN_PROJECT_DIR (never
  // CLAUDE_PROJECT_DIR), and the adapter normalises it to AIDLC_PROJECT_DIR for
  // the core hook bodies. Keeping the command relative means the package works
  // regardless of which env var the host exports.
  return { type: "command", command: `bun .devin/hooks/aidlc-devin-adapter.ts ${sub}`, timeout };
}

function hooksConfig(): Record<string, HookGroup[]> {
  // Devin-name matchers, derived from what the CORE hook bodies actually inspect
  // rather than hand-listed per hook. Claude ships ONE matcher string for the
  // three PreToolUse guards below -
  //   "Read|NotebookRead|Edit|MultiEdit|Write|NotebookEdit|LS|Glob|Grep|Bash"
  // - so devin shares one too, mapped through the adapter's TOOL_MAP. Narrowing
  // any of the three to just the shell tool is a SILENT enforcement hole: the
  // hook loads and matches, and simply never sees the write it was meant to stop
  // (review-freeze-command.ts:1023 gates on WRITE_TOOLS, and
  // plan-approval-guard.ts:95 carries its own WRITE_TOOLS set).
  const edits = "^(write|edit|apply_patch|notebook_edit)$";
  // Every tool that reads or mutates the workspace, plus the shell. Feeds
  // state-transition-guard, reviewer-scope and review-freeze.
  const guarded = "^(read|notebook_read|edit|apply_patch|write|notebook_edit|glob|grep|exec)$";
  // The mutation floor for plan approval: Claude adds Task|Agent to its write
  // set; on Devin delegation is run_subagent/read_subagent, and exit_plan_mode
  // is the plan-exit seam.
  const planFloor =
    "^(write|edit|apply_patch|notebook_edit|exec|run_subagent|read_subagent|exit_plan_mode)$";
  return {
    SessionStart: [{ hooks: [cmd("session-start")] }],
    SessionEnd: [{ hooks: [cmd("session-end")] }],
    UserPromptSubmit: [{ hooks: [cmd("record-human-turn")] }],
    // record-human-turn is deliberately NOT twinned onto PostToolUse the way
    // Claude twins it onto AskUserQuestion. Devin's changelog (v3000.3.22) states
    // that skipping questions in an `ask_user_question` no longer blocks progress -
    // so PostToolUse fires on a SKIPPED question, and twinning the mint there
    // would write HUMAN_TURN for a question no human answered, into an
    // append-only ledger. Claude's twin is safe only because AskUserQuestion has
    // no silent-skip path. See question-rendering.md: devin renders questions as
    // prose and mints presence from the human's typed reply instead.
    PreToolUse: [
      { matcher: "", hooks: [cmd("deliver-stage-rules")] },
      { matcher: guarded, hooks: [cmd("state-transition-guard")] },
      { matcher: guarded, hooks: [cmd("reviewer-scope")] },
      { matcher: guarded, hooks: [cmd("review-freeze")] },
      { matcher: planFloor, hooks: [cmd("plan-approval-guard")] },
    ],
    PostToolUse: [
      { matcher: edits, hooks: [cmd("audit-and-sensors", 60)] },
      { matcher: edits, hooks: [cmd("run-sensors", 60)] },
      // The pairing is NOT interchangeable, and getting it backwards is silent:
      // sync-workflow-state gates on `tool_input.status === "in_progress"` plus an
      // activeForm ending in [slug] -- i.e. a PLAN-UPDATE payload (Claude's
      // TaskUpdate, Codex's update_plan, Devin's todo_write). rebuild-stage-graph
      // gates on `tool_input.command` -- i.e. a SHELL payload (Claude's Bash,
      // Devin's exec). Cross-wire them and both hooks load, match, and return 0:
      // runtime-graph.json never recompiles after a transition and Current Stage
      // never auto-syncs. Matches docs/reference/06-hooks-and-tools.md and
      // harness/codex/emit.ts.
      { matcher: "^todo_write$", hooks: [cmd("sync-workflow-state")] },
      { matcher: "^exec$", hooks: [cmd("rebuild-stage-graph")] },
      // No SubagentStop on Devin; PostToolUse on run_subagent is the nearest seam.
      // Foreground delegates are covered, backgrounded ones are not.
      //
      // read_subagent MUST NOT be in this matcher. aidlc-log-subagent.ts appends
      // SUBAGENT_COMPLETED unconditionally -- there is no dedupe and no per-delegate
      // key -- so every additional invocation is another event in an append-only
      // ledger. read_subagent is also a POLL: an agent may read one backgrounded
      // delegate any number of times, and the payload carries no agent_type, so each
      // read logged a second completion attributed to "unknown". Measured before this
      // was narrowed: one delegate produced THREE SUBAGENT_COMPLETED events (one
      // correct, two "unknown"). Auditing a backgrounded delegate needs a real
      // completion signal, not a read.
      { matcher: "^run_subagent$", hooks: [cmd("log-subagent")] },
    ],
    // PreCompact has no Devin equivalent; PostCompaction is the nearest seam and
    // fires after the fact.
    PostCompaction: [{ hooks: [cmd("validate-state")] }],
    // Stop CAN block via {"decision":"block","reason":...}, so the forwarding-loop
    // gate survives on Devin.
    Stop: [{ hooks: [cmd("continue-workflow")] }],
  };
}

/**
 * Assert the packager's tier projection produced a Devin-valid `model:`.
 *
 * Devin's documented subagent frontmatter keys are name/description/model/
 * allowed-tools/max-nesting. There is no effort key and no session-inherit
 * sentinel, and per docs.devin.ai/cli/subagents a profile whose `model:` is
 * ABSENT falls back to the default subagent model - explicitly "not the
 * parent's model", routed to SWE-1.6 by default. So on Devin an omitted model
 * is not "inherit", it is a silent downshift.
 *
 * TIER_PROJECTIONS.devin therefore types `model` as a non-nullable string and
 * pins judgment to `opus`. This function is the belt to that braces: it never
 * edits the file, it only refuses to ship a projection that broke the contract.
 */
function assertDevinModel(raw: string, srcPath: string): void {
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error(`${srcPath}: agent .md has no closed frontmatter block.`);
  const modelMatch = m[1].match(/^model:\s*(\S+)\s*$/m);
  if (!modelMatch) {
    throw new Error(
      `${srcPath}: no model: line after the tier projection. A Devin subagent ` +
        `profile without model: runs on the DEFAULT SUBAGENT MODEL, not the session ` +
        `model, so judgment work would silently downshift. Check ` +
        `TIER_PROJECTIONS.devin in core/tools/aidlc-tiers.ts.`,
    );
  }
  const model = modelMatch[1];
  if (!(DEVIN_MODELS as readonly string[]).includes(model)) {
    throw new Error(
      `${srcPath}: model "${model}" is not a Devin alias ` +
        `(${DEVIN_MODELS.join(", ")}). Check TIER_PROJECTIONS.devin.`,
    );
  }
}

export default function emit(ctx: EmitContext): void {
  const { coreRoot, harnessRoot, distRoot } = ctx;
  const TREE = join(distRoot, ".devin");

  // 1. hooks.v1.json — the hooks object IS the entire file (no wrapper key).
  const cfg = hooksConfig();
  for (const [event, groups] of Object.entries(cfg)) {
    for (const g of groups) {
      if (!g.matcher) continue;
      for (const tok of g.matcher.match(/[a-z_]+/g) ?? []) {
        if (!(DEVIN_TOOL_NAMES as readonly string[]).includes(tok)) {
          throw new Error(
            `devin emission: matcher for ${event} names "${tok}", which is not a documented ` +
              `Devin tool name. A matcher naming a Claude tool (Bash/Edit/Task) loads and ` +
              `never fires.`,
          );
        }
      }
    }
  }
  writeFileSync(join(TREE, "hooks.v1.json"), `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");

  // 2. the adapter (authored in harness/devin/hooks/).
  const adapterSrc = join(harnessRoot, "hooks", "aidlc-devin-adapter.ts");
  if (!existsSync(adapterSrc)) {
    throw new Error(`devin emission requires the authored adapter at ${adapterSrc}.`);
  }
  const adapterDst = join(TREE, "hooks", "aidlc-devin-adapter.ts");
  mkdirSync(dirname(adapterDst), { recursive: true });
  writeFileSync(adapterDst, readFileSync(adapterSrc, "utf-8"), "utf-8");

  // Every subcommand the config references must exist in the adapter, or a hook
  // fires into a no-op. Checked at BUILD time so it cannot ship broken.
  const adapterText = readFileSync(adapterSrc, "utf-8");
  for (const groups of Object.values(cfg)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const sub = h.command.split(" ").pop()!;
        if (!adapterText.includes(`"${sub}":`)) {
          throw new Error(`devin emission: adapter has no handler for subcommand "${sub}".`);
        }
      }
    }
  }

  // 3. Verify the tier projection on every persona subagent copy, and reconcile
  //    the reviewer turn cap with what Devin actually honours.
  //
  //    `maxTurns:` is NOT a documented Devin subagent frontmatter key (the set is
  //    name/description/model/allowed-tools/max-nesting), so it is silently
  //    ignored - `devin doctor` reports it as an unsupported key. The
  //    harness-neutral reviewer prose CITES it ("the `maxTurns: <n>` frontmatter
  //    above - keep the two numbers in sync"), which would leave devin shipping a
  //    dangling pointer to a key that does nothing. Codex hit the identical
  //    problem and rewrites the citation; do the same, and drop the inert key so
  //    nothing reads it as an enforced cap.
  const agentsDir = join(coreRoot, "agents");
  for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md")).sort()) {
    const dst = join(TREE, "agents", f);
    if (!existsSync(dst)) continue; // the packager owns the copy; skip if absent
    let body = readFileSync(dst, "utf-8");
    assertDevinModel(body, dst);
    // display_name / examples: core-authored persona keys. Devin's doctor flags
    // them as unsupported (CFG005), and it is tempting to drop them here - but
    // AI-DLC's OWN doctor requires display_name as a schema check. Dropping
    // regresses aidlc-utility.ts doctor with a real failure while trading it for
    // Devin's `ok=true` informational noise. So they ship, and the guide narrates
    // the expected CFG005 warnings so nothing reads as a shipped defect.
    // The reviewer personas ship a `maxTurns:` key + a prose citation of the
    // number. Devin honours no per-agent turn cap key, so drop the key and rewrite
    // the citation - same fix codex applies. Non-reviewer personas have no match,
    // so this is a no-op there.
    const capped = body.match(/^maxTurns:\s*(\d+)\s*$/m);
    if (capped) {
      body = body
        .split(/\r?\n/)
        .filter((line) => !/^maxTurns:\s*\d+\s*$/.test(line))
        .join("\n")
        .replace(
          /the `maxTurns: (\d+)` frontmatter above - keep the two numbers in sync/g,
          "the core persona's `maxTurns: $1` cap - Devin honours no per-agent turn " +
            "cap key, so this number is prose-only here and is a discipline you keep " +
            "yourself; update it by hand if the authored cap changes",
        );
    }
    // Persist whatever the frontmatter and maxTurns filters produced. The write
    // used to sit inside `if (capped)`, so a non-reviewer's frontmatter drop
    // silently didn't persist - the entire class of `display_name`/`examples`
    // warnings was hidden that way for the 12 non-reviewer personas.
    if (body !== readFileSync(dst, "utf-8")) writeFileSync(dst, body, "utf-8");
  }
}
