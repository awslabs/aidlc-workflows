// harness/devin/onboarding.fills.ts — Devin's fills for the shared onboarding
// skeleton (core/templates/onboarding.md), rendered to dist/devin/AGENTS.md.
//
// AGENTS.md is Devin's PRIMARY rules file, read automatically by Devin CLI and
// Devin Local. (Devin Cloud reads it too per the vendor docs, but this distribution
// makes no cloud claim — untested.) It is also ALWAYS-ON, and Devin CLI TRUNCATES
// an oversized always-on rule with a path hint rather than erroring (CLI changelog
// v2026.4.17-0 documents 32 KiB). So these fills stay tight.
//
// ⚠ TIGHT IS NOT ENOUGH TODAY: measured on 3000.6.7, the rendered 19,908-byte file
// IS truncated (15,309 is not), so the effective cap is about half the documented
// one. The t331 guard only checks the 32 KiB vendor ceiling. The bulk is not these
// fills but the shared core/templates/onboarding.md — every harness renders 18-19.4
// KB and Devin is the only one that truncates. See DEVIN-FACTS.md § 18.1.
//
// Devin has no equivalent of Claude Code's `companyAnnouncements` setting (which
// renders an orientation banner at session start), so the orientation a Claude user
// gets in a banner has to live here instead — it is the first thing the model reads.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",

  slots: {
    title_block: [
      "# AI-DLC — AI-Driven Development Life Cycle",
      "",
      "Run **`/aidlc`** to start or resume a workflow. Describe what to build and the scope is",
      "auto-detected.",
      "",
      "Every stage stops at an approval gate. Nothing advances without your decision.",
    ].join("\n"),

    prereq_bullets: [
      "- **bun**: required for the CLI tools and hook scripts (state, audit log, sensors,",
      "  orchestration). Install with `curl -fsSL https://bun.sh/install | bash`; on Windows",
      "  `npm install -g bun`. It must be on your PATH for **non-interactive** shells, so put the",
      "  export in `~/.zshenv` (zsh) or `~/.bashrc` (bash) — NOT `~/.zshrc`. Check with `which bun`.",
      "- **A git repository**: the workflow records state and uses worktrees for Construction.",
    ].join("\n"),

    prereq_bullets_tail: [
      "- **Permission prompts**: Devin scopes an `Exec` grant to the *wrapped program*, so",
      "  `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts` is approved separately from other",
      "  scripts. Expect several approvals on the first run; approving each once is enough.",
      "  `--permission-mode accept-edits` reduces prompting in a workspace you trust.",
      "- **Hooks**: wired in `{{HARNESS_DIR}}/hooks.v1.json`. Verify with `/hooks` in the",
      "  terminal, or **Open customizations** in Devin Desktop (`/hooks` is not available over",
      "  the IDE's agent protocol).",
    ].join("\n"),

    agents_note: [
      "Each persona carries an explicit `model:`. Devin runs a custom subagent profile on its",
      "*default subagent model* when `model:` is absent — not on the session model — so the tier",
      "is projected to an explicit model name at build time.",
      "",
      "**`ask_user_question` is withheld from Devin subagents**, so any stage where a persona",
      "must interrogate you runs INLINE in the root agent rather than being delegated.",
    ].join("\n"),

    structure_extra: [
      "- **Hook config**: `{{HARNESS_DIR}}/hooks.v1.json` — Devin's hook wiring. The hooks object",
      "  is the entire file (no wrapper key). A single adapter,",
      "  `{{HARNESS_DIR}}/hooks/aidlc-devin-adapter.ts`, translates Devin's lowercase tool names",
      "  (`exec`, `edit`, `run_subagent`) into the names the core hook bodies compare against,",
      "  then hands off unchanged — Devin's stdin/stdout envelopes and its \"exit 2 blocks, reason",
      "  on stderr\" convention already match.",
    ].join("\n"),

    // The METHOD INCLUDE. These @-prefixed lines are the surface
    // aidlc-includes.ts repoints on a space switch (same rewriter as Copilot's
    // AGENTS.md). Devin has NO documented @-import expansion, so unlike Claude
    // these lines are read as an instruction to OPEN the files, not as a host-level
    // include — hence the explicit "read these" framing. Keeping the @-shape is
    // what makes the space-switch repointer work.
    guide_pointer:
      "The Devin-specific guide (install, what differs, verification) is " +
      "`docs/guide/harnesses/devin.md`.",

    sections_before_resumption: [
      "## The AI-DLC method",
      "",
      "The method is authored once at the workspace root and is identical on every harness.",
      "**Read these before acting on a development request**, and re-read the phase file when a",
      "workflow enters a new phase:",
      "",
      "@aidlc/spaces/default/memory/org.md",
      "@aidlc/spaces/default/memory/team.md",
      "@aidlc/spaces/default/memory/project.md",
      "@aidlc/spaces/default/memory/phases/ideation.md",
      "@aidlc/spaces/default/memory/phases/inception.md",
      "@aidlc/spaces/default/memory/phases/construction.md",
      "@aidlc/spaces/default/memory/phases/operation.md",
      "",
      "Resolution is strict-additive: `org → team → project → phase → stage`. A narrower layer",
      "specialises a broader one; it never contradicts it.",
      "",
      "> Devin has no file-include mechanism inside a rule, so the lines above NAME the method",
      "> rather than embedding it — the agent must open them. An AI-DLC stage does not depend on",
      "> this: the engine resolves the same tree directly.",
    ].join("\n"),

    // The STANDARD section every other harness ships. devin previously carried a
    // 3-bullet "Known limits" instead, which is why it was the only harness whose
    // AGENTS.md had no `## What's different on this harness` heading. The limits
    // are folded in here rather than dropped.
    //
    // NOTE the placement: peers put this BEFORE the method include. devin keeps
    // the method pointer earlier (sections_before_resumption) on purpose - Devin
    // expands no @-imports, so the pointer is an instruction the agent must act
    // on, and it earns the more prominent slot.
    sections_after_resumption: [
      "## What's different on this harness",
      "",
      "This is the same AI-DLC core that ships to every harness — the same ordered steps, the same",
      "approval gates, the same written record — rendered onto Devin. On Devin:",
      "",
      "- **One install, two surfaces.** Devin CLI and Devin Desktop's \"Devin Local\" agent read the",
      "  same `.devin/` tree and this AGENTS.md. Cascade, the legacy agent in the same IDE, is not a",
      "  target, and Devin Cloud is untested — treat nothing here as a Cloud claim.",
      "- Approval gates and questions render as **numbered prose options**, so the human's next chat",
      "  message fires the trusted presence hook. Devin's `ask_user_question` picker returns answers",
      "  as a tool result and cannot satisfy that guard, so the PreToolUse guard denies it while a",
      "  workflow is running. The questions FILE with `[Answer]:` tags remains the source of truth.",
      "- Hooks ride the **AIDLC adapter** (`{{HARNESS_DIR}}/hooks/aidlc-devin-adapter.ts`, wired by",
      "  `{{HARNESS_DIR}}/hooks.v1.json`) across seven events. The PreToolUse guards **block**",
      "  natively (exit 2 with the reason on stderr), and the Stop hook blocks via",
      "  `{\"decision\":\"block\"}` — the same contract as Claude Code.",
      "- **Permissions** ship scoped in `{{HARNESS_DIR}}/config.json`: an `Exec` allowlist for the",
      "  framework's own `bun {{HARNESS_DIR}}/tools` and `bun {{HARNESS_DIR}}/hooks` commands. MERGE",
      "  it if you already have a config.json — your `read_config_from`, `mcpServers` and `hooks`",
      "  keys live in the same file. Do not reach for `--permission-mode accept-edits`; it",
      "  auto-approves every workspace edit, which is far broader than this install needs.",
      "- **Devin imports Claude Code's configuration by default, including its hooks**",
      "  (`read_config_from.claude`). So do NOT install this distribution into a project that also",
      "  carries the AI-DLC Claude Code install — both hook sets would load and every audit event",
      "  would be written twice. One harness per project.",
      "- **No per-subagent completion event.** Devin has no `SubagentStop`, so subagent completion is",
      "  recorded from `PostToolUse` on `run_subagent`/`read_subagent`. That covers foreground",
      "  delegates; a backgrounded one is not individually audited.",
      "- **Compaction is observed after the fact.** Devin has `PostCompaction` but no `PreCompact`,",
      "  so state validation runs *after* a compaction and cannot veto one. Nothing fires if a",
      "  compaction fails. In practice little is lost: that hook reads on-disk state, not the",
      "  conversation.",
      "- **Restricted Mode (Devin Desktop) disables every agent and hook, silently.** That is",
      "  indistinguishable from a broken install, so check it first when nothing fires.",
      "- There is **no statusline** on Devin; use `/aidlc --status` and the progress lines at gates.",
      "- **MCP servers**: none ship. Devin uses Claude Code's MCP shape, so configure your own in",
      "  `{{HARNESS_DIR}}/mcp_config.json` if you need them.",
      "- Construction swarm runs as **subagent fan-out only** (`AIDLC_USE_SWARM=1` is a loud no-op —",
      "  Devin has no Workflow tool).",
      "- A workflow's `aidlc/` workspace tree is harness-neutral, so a project can move between",
      "  harness installs.",
      "",
      "Where a hook is absent, gate discipline is a human responsibility.",
    ].join("\n"),

    gitignore_extra: "",
  },
};

export default fills;
