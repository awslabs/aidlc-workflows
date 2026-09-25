# Customization

AI-DLC is designed to adapt to your team's needs. This chapter covers settings overrides, scope configuration, stage customization, statusline, and tool permissions.

> **Harness-specific config.** The harness-neutral customizations — scope
> configuration, stage depth, knowledge, and rules — apply on every harness. The
> mechanism-level config in this chapter (`settings.json` / `settings.local.json`,
> the statusline command, `$CLAUDE_PROJECT_DIR`, tool-permission blocks) is
> **Claude Code-specific**. Kiro CLI configures the equivalents in
> `.kiro/settings/cli.json` + its agent config; Kiro IDE uses agent Markdown
> `tools:` and `permissions.rules`. Codex uses `.codex/config.toml`
> + Starlark rules, Cursor in `.cursor/hooks.json` + `.cursor/cli.json`
> (permissions only), opencode in the project-root `opencode.json`, and Copilot
> in `.github/hooks/aidlc.json` (hook wiring) + `~/.copilot/config.json`
> (folder trust) — see
> [Running on Kiro CLI](harnesses/kiro-cli.md),
> [Running on Kiro IDE](harnesses/kiro-ide.md),
> [Running on Codex CLI](harnesses/codex-cli.md),
> [AI-DLC on Cursor](harnesses/cursor.md),
> [AI-DLC on opencode](harnesses/opencode.md), and
> [AI-DLC on GitHub Copilot](harnesses/copilot.md) for each harness's surfaces.

---

## Settings Overrides (`settings.local.json`)

The shared `.claude/settings.json` ships with the framework and is committed to version control. AI-DLC preserves project-owned additions, but its `companyAnnouncements`, `permissions`, `statusLine`, and `hooks` entries remain baseline-owned. To override settings for your local environment without affecting the team, create a personal overrides file:

```bash
cp .claude/settings.local.json.example .claude/settings.local.json
```

This file is listed in `.gitignore` so your personal changes are never committed. Use it to:

- Override model selection (e.g., switch to a different Opus or Sonnet model ID)
- Set environment variables for your local setup
- Adjust tool permissions for your security requirements

---

## Agent Models and Effort (Tiers)

Shipped agents are authored with a `tier:` (`judgment` | `balanced` | `templated`) that the build projects into each harness's native model/effort keys. With no recorded model policy, judgment and templated agents inherit the session model and effort. Balanced reviewers use Sonnet at medium effort on Claude Code, while Codex and opencode inherit the session model and apply their medium reasoning setting. On Kiro, Cursor, and Copilot all tiers inherit the session model and effort. See [Agent System](../reference/05-agent-system.md) for the full projection table.

The first-run wizard defaults to the `balanced` **preset**, which is distinct
from the reviewer **tier**: it records medium effort for all three groups.
Select a preset with `aidlc config models --preset balanced --project --yes`:

| Preset | Deciding | Reviewing | Writing up |
|--------|----------|-----------|------------|
| `thorough` | session effort | `xhigh` | session effort |
| `balanced` | `medium` | `medium` | `medium` |
| `minimal` | `medium` | `medium` | `low` |

Presets set effort only, never model IDs. Per-agent exceptions override group
dials, which override shipped tier defaults. Kiro CLI/IDE, Cursor, and Copilot
cannot express these group effort dials; the policy is recorded and reported
as unexpressed rather than written as inert keys. See
[Model Policy](18-install-and-lifecycle.md#model-policy) for profiles, overrides,
and the upgrade path.

To change ONE agent's behavior in your installed copy, edit the projected value directly — for example, set `model: opus` in a Claude agent's `.claude/agents/aidlc-*-agent.md` frontmatter. On Kiro the surface depends on the harness: on Kiro CLI add a `"model"` field to the agent's `.kiro/agents/aidlc-*-agent.json`, and on Kiro IDE set a `model:` line in the agent's `.kiro/agents/aidlc-*-agent.md` frontmatter (the agent JSON files are CLI-only — the IDE reads the `.md` frontmatter when spawning). In both cases use a model ID enabled on your install; Kiro agents ship without a model pin so they inherit the session model by default. The edit survives until `aidlc config` refreshes that framework-owned file or you manually replace it from the same versioned `runtime/<harness>/` release payload. To cap EVERY agent when building your own distribution from source, set a `tier_cap:` in `core/memory/org.md`/`project.md` frontmatter or run the packager with `AIDLC_TIER_CAP=<tier>` — both are pack-time knobs on `bun scripts/package.ts`, not runtime settings.

---

## Per-Project Default Scope

When every workflow in a project should start at the same scope, set `AWS_AIDLC_DEFAULT_SCOPE` in the `env` block of `.claude/settings.json` (the shipped file already has this set to `classic`, matching the framework's hard-coded fallback — set it to `feature` to run the full lifecycle by default):

```json
{
  "env": {
    "AWS_AIDLC_DEFAULT_SCOPE": "feature"
  }
}
```

The shipped `env` block contains only the AI-DLC scope default. Provider and
model settings remain owned by Claude Code and the user.

With this set, implicit scope resolution uses `feature`. Alternatively, record a project default with `aidlc config flags --default-scope feature --project --yes` (or `--local` for this checkout). The real `AWS_AIDLC_DEFAULT_SCOPE` environment variable wins over the recorded flag; the shipped settings env entry therefore remains authoritative until you change or remove that entry. Once the intent's `aidlc-state.md` exists (under its record dir), its scope is authoritative and changes to the implicit default do not alter an in-flight workflow.

**Precedence (highest to lowest):**

1. Explicit CLI flag: `/aidlc feature` or `/aidlc --scope bugfix` wins.
2. Keyword detection in freeform text: `/aidlc fix the login bug` still maps to `bugfix`. Users can override the detected scope at the existing confirmation prompt.
3. The real `AWS_AIDLC_DEFAULT_SCOPE` environment variable, including the value supplied by `.claude/settings.json`.
4. The recorded `aidlc config flags --default-scope` value (local settings override shared project settings).
5. `classic` — the framework fallback used by unmatched-freeform resolution,
   `/aidlc-init`, and direct `intent-create` calls without `--scope`.

**Valid values:** `enterprise`, `feature`, `mvp`, `poc`, `bugfix`, `refactor`, `infra`, `security-patch`, `classic`, `workshop`, `express`. An invalid value errors at invocation time with a clear message. Teams can define additional scopes by dropping a `.claude/scopes/aidlc-<name>.md` file and tagging the member stages' `scopes:` lists — see [Contributing: Adding a Scope](../reference/11-contributing.md#adding-a-scope). Teams can also define additional agents in `.claude/agents/` — see [Contributing: Adding an Agent](../reference/11-contributing.md#adding-an-agent).

**Verifying the config:** run `/aidlc --doctor` to confirm the configured default scope is valid (environment and recorded defaults share this check):

```
✓  AWS_AIDLC_DEFAULT_SCOPE=classic (valid)
```

**Init notice:** when the env default is applied, the orchestrator prints a one-line notice at workflow start (`Using scope=<value> from AWS_AIDLC_DEFAULT_SCOPE (.claude/settings.json)`) so the scope source is visible at the moment it takes effect.

Why only scope and not depth or test-strategy? Each scope declares a depth, and test strategy inherits that depth unless the scope overrides it. `classic` therefore starts at Standard/Standard, `workshop` at Standard/Minimal, and `express` at Minimal/Minimal. If you need to override either, pass `--depth` or `--test-strategy` on the CLI.

**Sensitive values:** `.claude/settings.json` is committed to version control. Don't put secrets, credentials, or personal overrides here — use `.claude/settings.local.json` (gitignored) for anything sensitive.

---

## Scope Configuration

Scopes control which stages execute and at what depth and test strategy. AI-DLC provides 11 named scopes; the full table (EXECUTE/total stage counts, default depth, test strategy, and use case for each) is the single source in [Scopes, Depth, and Test Strategy § The 11 Core Scopes](05-scopes-and-depth.md#the-11-core-scopes). This section covers *configuring* and overriding them.

### Choosing a scope

Specify explicitly or let the orchestrator auto-detect:

```
/aidlc enterprise       # Explicit scope
/aidlc Build a payments API  # No keyword: offers composition; resolver fallback is "classic"
/aidlc Fix the login bug     # Auto-detects "bugfix"
```

### Overriding at runtime

You can override scope at any time during a workflow:

- **At any approval gate**: request a different scope or depth
- **Via utility command**: `/aidlc --scope enterprise` changes the active scope
- **Stage inclusion**: at approval gates in Ideation and Inception, you can add a previously skipped stage back into the workflow

---

## Intent Configuration

The seven intent settings are `depth`, `test-strategy`, `review`,
`guard-policy`, `sensors`, `learnings`, and `summary-confirmation`, in that
order. Four more keys, `guard.plan-approval`, `guard.review-freeze`,
`guard.state-transition`, and `guard.reviewer-scope`, switch one guard off or
back on for a single piece of work. The CLI routes share one atomic setter,
`config-change`; when a typed command lowers a guard, the human-turn hook
validates and applies its companion intent settings in the same transaction.
Mix the settings in one command rather than chaining separate updates:

```
/aidlc --depth standard --test-strategy minimal --review advisory --guard-policy relaxed --sensors off --learnings on --summary-confirmation off
/aidlc config set guard-policy strict --sensors on --learnings on
/aidlc --scope bugfix --review none --guard-policy relaxed --sensors off
```

The native equivalent is `aidlc engine config set <key> <value>` followed by
the remaining `--key value` flags. `config get <key>` accepts all eleven keys,
and `config list` (optionally `--json`) returns all eleven, including effective
values and sources for Guard Policy, the four switchable fences, and the ceremonies:

```
/aidlc config get guard-policy
/aidlc config get guard.plan-approval
/aidlc config get summary-confirmation
/aidlc config list --json
```

Typed `config set`, `get`, and `list` requests execute during dispatch and
return the command's actual output before the turn finishes. A refused setting
returns its error; successful settings do not advance the workflow. Guard
lowering still belongs to the human-turn hook.

The additional read-only `guard.human-presence` lookup reports `on (default)` or `off (env AIDLC_SKIP_HUMAN_PRESENCE_GUARD)`; it is not a per-work setting and is not included in `config list`.

`config-change` accepts only those setting flags and `--intent`, `--space`,
`--project-dir` selectors, with at least one setting required. For example:

```bash
bun .claude/tools/aidlc-utility.ts config-change --guard-policy relaxed --sensors off --intent login-fix --space platform --project-dir /work/shop
```

The typed forms `/aidlc config set guard-policy relaxed --intent <name> --space <name>`
and `/aidlc --guard-policy relaxed --intent <name> --space <name> ...` make the
human-turn hook apply the switch at prompt time to that intent and space.
The trailing `...` in the flags form stands for an optional task description.
A nonexistent named intent is refused; without a state file, create the piece
of work and type the switch again.

Selectors target the same intent for state, memory policy, and audit without
switching the active cursors. All supplied values are validated before mutation;
invalid values or unknown flags refuse the whole update, naming the offending
flag. A memory-enforced strict policy refuses an explicit `relaxed` or `off`
Guard Policy setting together with every companion setting and scope change.
Explicit strict and unrelated settings remain allowed. One lock covers the state read, shared
applier, complete audit batch, and single state write; an audit failure leaves
state untouched. `Last Updated` changes only for a real stored change, including
a provenance change. Repeating the same stored choice is a no-op.

Scope changes accept the same flags and use the same applier. A
same-as-current scope still applies supplied settings. Scope-owned Guard Policy
follows a stricter new default but preserves the current value when the new
default is lower; ceremony rows still track the new scope defaults. Explicit
human overrides and absent legacy rows are preserved. Memory continues to
control the effective policy. Explicit flags record human provenance and obey
the same lowering requirement as `config-change`. `review adversarial` clears the `Review Override` field to an
empty string, so stage declarations and scope review caps still apply.

### Ceremony Switches

Scopes own three independent ceremony defaults. Each accepts `on` or `off`.
Every shipped scope now declares all three explicitly rather than relying on a
default; a scope file that omits one still falls back to `on`. Classic sets
sensors and learnings to `on` and summary confirmation to `off`. Express is the
only shipped scope with all three off.

| Scope key | Per-intent flag | Global kill switch | What off removes |
|-----------|-----------------|--------------------|------------------|
| `sensors` | `/aidlc --sensors on\|off` | `AIDLC_DISABLE_SENSORS=1` | Sensor runs and their gate checks |
| `learnings` | `/aidlc --learnings on\|off` | `AIDLC_DISABLE_LEARNINGS=1` | Stage learnings read/write ritual |
| `summary_confirmation` | `/aidlc --summary-confirmation on\|off` | `AIDLC_DISABLE_SUMMARY_CONFIRMATION=1` | The separate pre-output summary-confirmation checkpoint |

Precedence is global kill switch (`1`) → valid intent field → scope default →
`on`. Kill switches can also be recorded with `aidlc config flags --bypass <NAME>`.
New intents store `Sensors`, `Learnings`, and `Summary Confirmation` after
`Guard Policy` in `aidlc-state.md`, each with a source label such as
`on (from scope classic)`. A flag changes the label to `set by you` and
records `CEREMONY_SET`. `/aidlc --status` shows the effective value and source.
Changing scope updates scope-sourced settings while keeping your overrides;
an absent or malformed field falls back to the scope instead of blocking the run.

These switches do not remove approval gates, Plan Approval, human-turn
authority, audit, or team cross-unit write protection. Classic turns off
walking-skeleton ceremony and caps gated-flow reviews at advisory; explicit autonomy retains
the single pre-merge review.

An isolated `--single` attempt uses its selected scope's policy rather than
the main intent's ceremony overrides. That scope is recorded on the synthetic
stage-start event and remains fixed through completion; resume with a different
scope is refused. Legacy isolated starts without a recorded scope retain
summary confirmation and do not enforce this scope comparison.

### Guard Policy

Guard Policy is one setting with three values, `strict`, `relaxed`, and `off`. It decides how far the framework's guards stand aside for the piece of work you are on. It covers two things: what happens when something you already approved turns out to have changed underneath, and how hard the five fences hold against work nobody asked for.

**When an approved input changed.** The source files moved after you approved a code plan, a reviewed document was edited after its review, or an output was saved without the current summary confirmation.

- `strict` reopens the approval. The run stops with one plain sentence naming what changed (for example `2 files changed since this plan was approved: src/api.ts, src/db.ts. Look them over and approve the plan again to continue.`) and asks you again.
- `relaxed` and `off` keep going. The change is recorded once in the audit trail as a `CHANGE_ACCEPTED` row, you hear one line about it (`... Continuing (Guard Policy: relaxed or off). Say 'review the plan again' to reopen approval.`), and the run continues. Nothing is deleted: the approval and its evidence stay exactly as they were.

**How hard the fences hold.** `strict` leaves all five fences up. `relaxed` lowers plan approval and review freeze. `off` lowers those two plus state transition and reviewer read scope. No value lowers human presence or claimed-checkout Unit write ownership. A lowered fence still writes an audit row every time it lets something through.

**When the plan itself changes after approval.** For the same Unit or stage target and attempt, edits to the plan, test instructions, or Testing Contract continue without mandatory reapproval when the plan-approval fence is lowered by `relaxed`, `off`, or `guard.plan-approval off`. If that fence is on (`strict` by default, or explicit `guard.plan-approval on`), those edits reopen approval. The same rule covers updates after Testing Posture, scope, test strategy, or project type changes within the same intent, target, and attempt: refresh the contract and instructions as needed, and continue while the fence stays lowered. The effective fence setting decides; `/aidlc --status` shows it. You can still ask to review the plan again.

Initial Plan Approval and other gates remain required. A lowered fence does not mean the edited content was approved: your original answer and approval evidence remain a record of what you actually approved. No reviewer's verdict is changed, no evidence is deleted, and an agent can never answer for you.

The conductor still asks required approval questions, but does not add a reapproval stop for content changes that a lowered plan-approval fence permits.

Existing delegated workers follow their verified parent intent's live
plan-approval setting. Lowering or raising it applies on their next check;
you do not need to recreate workers to apply that setting.

#### Defaults per scope

| Scope | Default |
|-------|---------|
| enterprise, security-patch, infra | strict |
| poc, express, classic, bugfix, feature, mvp, refactor, workshop | relaxed |

No shipped scope defaults to `off`; it is something you ask for. A composed scope stores the value the composer proposed and you approved at its gate as `guard_policy: <value>`; a matched stock scope retains its own default and no scope file is written.

Intent creation reads Guard Policy from that scope file. The conductor passes `--guard-policy` only for `strict`. If you flip a matched scope's Guard Policy at the compose gate, the proposal becomes a custom scope declaring that value, and the intent takes it at creation. The composer never changes an in-flight intent's value.

#### The three places to set it

1. **The scope file.** `guard_policy: strict | relaxed | off` in `scopes/aidlc-<name>.md` is the value every new intent on that scope starts with. Every shipped scope declares it; a scope file that declares none starts strict.
2. **Memory.** A `## Guard Policy` section with one line, `Mode: strict`, in `aidlc/spaces/<space>/memory/org.md`, `team.md`, or `project.md` holds strict for everyone on the repo. It wins over the scope default and per-intent values. An explicit `--guard-policy relaxed`, `--guard-policy off`, or `/aidlc config set guard.<fence> off` is refused with a sentence naming the memory file, and none of the command's companion settings or scope change is applied. Turning a fence `on` remains allowed. `Mode: relaxed`, `Mode: off`, or an empty section changes nothing; any other value is a validation error naming the file and the three allowed values.
3. **The intent.** When you type `/aidlc --guard-policy relaxed|off`, `/aidlc config set guard-policy relaxed|off`, or the confirmation words `guard policy relaxed|off`, the human-turn hook applies the switch at prompt time to the selected piece of work and records the audit row (`/aidlc --status` shows it as `Guard Policy: relaxed (set by you)`). A typed command that includes other intent settings validates every value first and applies all of them under the same lock; a malformed command or invalid companion changes nothing. The conductor runs `next` and relays the stand-aside line or the `AIDLC Guard Policy: ...` hook context on harnesses that inject it; it does not run the lowering setter itself. A message of `guard policy strict` or another plain-words request for strict runs `config-change --guard-policy <strict|relaxed|off>` with `strict` at once, prints its output verbatim, and stops. Other plain-words requests for relaxed or off get the exact command for you to type (`/aidlc --guard-policy relaxed` or `/aidlc --guard-policy off`, with `$aidlc` on Codex). If this Kiro IDE build delivers no prompt text, active work cannot be lowered: update Kiro IDE or start new work from a lower-default scope. Changing scope can raise a scope-owned policy automatically, but a lower scope default leaves the stricter value in place until you type the lowering switch. Naming a scope's own default at creation records the scope's value. A sole retired `Change Control: relaxed|off` field is normalized automatically without changing its value or writing a policy audit row.

#### Where the value lives

The resolved value is written to the intent's `aidlc-state.md` at creation as `- **Guard Policy**: <value> (from scope <name>)`, rewritten by the flag, typed confirmation words, or a plain-chat request for strict, and read by value only. Because the state file is committed with the intent, the value survives sessions and teammates see the same one; a memory edit that changes the effective value for a running intent is recorded as a `GUARD_POLICY_SET` row naming the memory file the next time a governed check runs. An intent created before this field existed stays `strict (not set)` until you set it; an invalid field is unavailable until `/aidlc --guard-policy` with one of the three values repairs it. The next intent starts from its scope's default again.

If a state file carries both `Guard Policy` and the retired `Change Control` with
different policy words, strict applies and status shows
`strict (from conflicting state lines)`; memory-held strict still takes precedence.
If both agree, the `Guard Policy` line is used. Any write of the policy line removes
the retired line, leaving one setting. Until a conflict is resolved, `next` carries
this notice with `<a>` and `<b>` replaced by the raw line values:

> Guard Policy: this piece of work carries both `Guard Policy: <a>` and the retired `Change Control: <b>`, so strict applies until you choose. Say 'guard policy strict', 'guard policy relaxed', or 'guard policy off' to keep one line; this notice repeats until you do.

#### This setting used to be called Change Control

Every old spelling still works in this release and is removed in the next minor version: the scope key `change_control`, the state field `Change Control`, the memory heading `## Change Control`, the flag `--change-control`, and the config key `change-control`. Typing the retired flag or config key prints one line naming the new spellings; a retired scope key or memory heading is read without comment. Nothing writes an old name again: any write of the policy line removes the retired `Change Control` line, whether it was the only line or appeared beside `Guard Policy`. The `CHANGE_CONTROL_SET` audit event stays readable in older ledgers; new rows are `GUARD_POLICY_SET`.

While a piece of work carries only the retired `Change Control: relaxed` or `Change Control: off` line, every `/aidlc` run carries a notice in the directive's `change_notices`; displaying this notice does not automatically rewrite the line. For example: `Guard Policy: relaxed was carried over from this piece of work's retired Change Control line. Under Guard Policy, relaxed now also lowers the plan-approval and review-freeze fences for work nobody directed, and every pass is recorded in the audit trail. Say 'guard policy relaxed' to keep it, or 'guard policy strict' to raise them again; this notice repeats until you choose.` Type `/aidlc config set guard-policy relaxed` or `guard policy relaxed` to have the human-turn hook keep that value and rewrite the line as `Guard Policy`, or request strict to have the conductor raise the fences through the setter; either write stops the notice. A retired strict line alone gets no notice and is rewritten the next time any Guard Policy setting is written.

### The five fences

A fence is a guard that refuses an action nothing asked for: no step the workflow is currently running calls for it. Four fences can be switched off for one piece of work and switched back on; human presence is the key holder and has no per-work switch.

| Fence | What it refuses | Per-work switch | Machine-wide kill switch |
|-------|-----------------|------------|--------------------------|
| Plan approval | code before an approved plan | `guard.plan-approval` | `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` |
| Review freeze | edits to reviewed content after a review receipt | `guard.review-freeze` | `AIDLC_DISABLE_REVIEW_FREEZE_HOOK=1` |
| State transition | direct lifecycle commands in place of the workflow's own | `guard.state-transition` | none |
| Reviewer read scope | a dispatched reviewer reading or searching sibling Unit content | `guard.reviewer-scope` | `AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1` |
| Human presence | an approval or an answer with no real human turn behind it | none: the key holder has no in-band switch | `AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` |

```
/aidlc config set guard.plan-approval off
/aidlc config set guard.plan-approval on
```

Lowering a fence or the policy word from chat is the person's move: type `/aidlc config set guard.<fence> off`, `/aidlc --guard-policy relaxed|off`, or the confirmation words `guard policy relaxed|off`, choosing one value. The human-turn hook applies the switch at prompt time to the piece of work selected by `--intent <name>` and `--space <name>`, or by the hook payload session's workflow selection when those selectors are omitted, and writes the state and audit row. It reports `AIDLC Guard Policy: ...` as hook context on harnesses that inject it. A nonexistent named intent is refused; without a state file, create the piece of work and type the switch again. No switch is saved for later, and an unrelated reply opens nothing.

The CLI setters do not lower from chat on their own and perform no switch-authority session lookup. Hooks run on Windows too, so the typed switch works on every harness that forwards the prompt. An already-off fence or an identical policy word already marked `set by you` needs no key because the CLI update is a no-op.

When a guard question offers "turn the check off for this piece of work", choosing it runs nothing: the choice tells you the command to type (`/aidlc config set guard.<fence> off`), and typing it is the move. On Codex the skill is `$aidlc`, and its refusals say so.

What counts as typing the switch: a message that begins with `/aidlc` (or `$aidlc`, or `aidlc`) and carries the flags first, such as `/aidlc --guard-policy relaxed`, `/aidlc --guard-policy off --guard.state-transition off`, or `/aidlc --guard-policy relaxed build the auth service` (the description follows the flags and is not read); `config set guard-policy relaxed|off` or `config set guard.<fence> off` after the same command head, followed only by optional `--intent <name>` and `--space <name>` pairs, each at most once and in either order; or the confirmation words `guard policy relaxed|off` on their own. Any other extra token in the config form applies no switch. Case and a trailing period do not matter. A question or remark that mentions a switch is not a switch: `/aidlc why was config set guard.plan-approval off suggested?` changes nothing, and neither does a flag placed after the description.

Direct `intent create --guard-policy relaxed|off` from chat is refused when the value differs from the selected scope's default: create the piece of work, then have the person type the switch. Direct `scope change --guard-policy relaxed|off` follows the same lowering rule as `config-change`; an implicit lower scope default preserves the running workflow's stricter value. `AIDLC_UNATTENDED=1` suppresses prompt-time application and refuses CLI lowering. After memory-strict and unattended checks, `fenceKeyBypassed` is the only way a CLI setter lowers without the person's prompt through the fixture or harness-launch presence bypass, not an inline environment assignment. The session-start hook keeps its `presence-bypass-<session>` stamp in the Plan Approval runtime directory for an attended harness launched with `AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1`.

Model tools cannot invoke hooks or write `aidlc/.aidlc-sessions/` or any `.aidlc-plan-approval/` directory, as enforced by the [state-transition guard](../reference/06-hooks-and-tools.md#pretooluse-aidlc-state-transition-guardts).

If a memory file holds Guard Policy strict, `/aidlc config set guard.<fence> off` is refused with a sentence naming that file; edit its `Mode: strict` line to change it for everyone on the repo. Turning a fence `on` remains allowed.

Memory-held strict also overrides a fence you lowered earlier. The persisted `Guards Off` entry stays in the intent, but `/aidlc --status` then shows `on (guard policy strict (from <layer>.md))` for that fence; the entry takes effect again only after the memory line no longer holds strict. A machine-wide kill switch still takes precedence.

Switching one off writes `- **Guards Off**: plan-approval (set by you)` into `aidlc-state.md` and one `GUARD_DISABLED` audit row; switching it back on removes it from that list and writes `GUARD_RESTORED`. Setting `on` also raises a policy-lowered fence, records `- **Guards On**: plan-approval (set by you)`, and writes `GUARD_RESTORED`. The lines name only the four switchable fences; a persisted human-presence entry is ignored. `/aidlc --status` prints a `Fences:` line with all five and where each setting came from. Precedence is the machine-wide kill switch, then per-work off unless memory holds strict, then per-work on, then the Guard Policy word, then on by default.

The reviewer-scope setting governs the dispatched reviewer's read/search bound. A checkout stamped as owning one team Unit still cannot write another Unit's `construction/` subtree; that ownership boundary is not switchable by Guard Policy, a per-work fence setting, or `AIDLC_DISABLE_REVIEWER_SCOPE_HOOK`.

The human-turn hook applies only the switch you type; it does not infer one from a general request or from the fact that you replied. A switchable fence's main-session refusal names its switch, so opening it is one deliberate move rather than a guess about your intent. A CLI setter that would turn Plan Approval off says:

> Turning the plan-approval check off is the person's move: they type `/aidlc config set guard.plan-approval off` and the harness applies it as they say it. This command does not lower a fence on its own.

A CLI setter that would change the policy to `relaxed` says:

> Setting Guard Policy relaxed lowers fences and is the person's move: they type `/aidlc --guard-policy relaxed` and the harness applies it as they say it. This command does not lower fences on its own.

Creation with an explicit `relaxed` flag says:

> Creating this intent with Guard Policy relaxed would lower fences. Create it, then have the person type `/aidlc --guard-policy relaxed`; the harness applies it as they say it. A scope default applies without asking.

Other fence names and `off` use the corresponding name or value; unattended runs append the driver guidance. Memory-held strict refuses before applying a switch or checking a bypass and instead names the memory file to edit. A human-presence refusal names no switch: `This needs a fresh human turn: wait for the person to reply, then record it again.`

Human presence is the strictest of the five. It is what makes your approval yours, so neither Guard Policy nor a per-work setting lowers it: only the machine-wide `AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` does. `AIDLC_UNATTENDED=1` separately withholds human-turn minting; it does not lower the fence.

### Who asked for this: the authority chain

Every action a guard sees is classified before anything is decided. Is it covered by a recorded human turn, by the workflow's own instruction, or by neither? This classification records who was working; it is separate from the human-turn hook applying the person's typed switch.

- **Your grant.** A message you sent after the workflow last told the agent what to do. It classifies the conductor and agents dispatched for that turn until the workflow issues its next instruction; it does not authorize a fence or policy change.
- **The workflow's instruction.** The stage the engine currently has in force. It covers the work that instruction asks for, whoever does it, including an approval still pending inside it. It does not cover the loop skipping one of its own steps, which is exactly what a fence notices.
- **Neither.** Something outside the instruction with nothing from you since: the narrowest cover, and the one an unreadable signal falls back to.

The question is never who is typing. A developer agent acts on the conductor's word and the conductor acts on yours, so authority flows down the chain: when the conductor dispatches an agent, the authority in force at that moment is stamped on the dispatch and the agent inherits it. An agent can never mint a grant for itself, and an unreadable signal narrows what is covered rather than widening it. The signals are ones the framework already keeps: the turn markers under `.aidlc-engine/` that record your last prompt against the workflow's last advancing command, the counters on the active-directive marker, and the dispatch stamp on the in-flight agent ledger.

This classification never lowers a fence or substitutes for the person's typed switch. Its job is the evidence trail: every time a lowered fence lets something through, the audit row names the authority in force, so a reader can see who was working when it happened. A changed input under `strict` is asked about at the governed boundary regardless of this classification.

### What you see when a guard decides

- **It stands aside.** One line names what lowered the fence, and the work continues: `Continuing past the plan-approval check because it is off for this piece of work (guard policy relaxed (from scope classic)). Recorded in the audit trail: dispatch of aidlc-developer-agent`. One `GUARD_STOOD_ASIDE` row records the fence, the authority in force, how a grant was proven, and whether the actor was the main session or a dispatched agent. You are never asked "are you sure": the fence is already off.

  On Claude Code the hook emits one JSON `systemMessage`, which Claude Code shows to you as a hook message; the model does not see it, and the `GUARD_STOOD_ASIDE` row is the record. On Codex, opencode, and Kiro CLI you see the plain hook line. On Kiro IDE you do not: the IDE hands a hook's output to the agent only at session start and at prompt submit, so a stand-aside there is silent and the audit row is the only record of it. Every hook refusal reason is already invisible on that harness for the same reason. The row is written only when the intent already has an audit trail, so on Kiro IDE against a brand-new project with no ledger yet a stand-aside leaves neither the line nor the row. If you want to know what a lowered fence let through, read the `GUARD_STOOD_ASIDE` rows in the intent's `audit/` shards rather than relying on having seen the line.
- **It holds.** When memory does not hold Guard Policy strict, a switchable fence's main-session refusal says what is missing and adds one sentence naming the way through: `If you meant to do this now, turn the check off for this piece of work with /aidlc config set guard.plan-approval off. It is recorded, and it comes back on for the next piece of work.` When memory holds strict, the refusal names the memory file instead of offering a switch. Human presence instead asks for a fresh human turn and never advertises a switch.
  Dispatched agents never see the switch sentence; their refusals redirect them to the main session.
- **It asks.** Under `strict`, an input that changed after you approved something is asked about once, naming what changed.

---

## Stage Customization

Each stage is a self-contained `.md` file in `.claude/aidlc-common/stages/[phase]/`. Stage files specify:

- **Metadata** — Stage number, phase, execution mode, lead/support agents
- **Inputs** — Prior artifacts to load
- **Steps** — Numbered execution sequence
- **Outputs** — Artifacts to produce
- **Completion** — Approval gate pattern

To modify a stage's behavior, edit its stage file directly. All stages reference the stage protocol for shared patterns (approval gates, question format, state tracking).

### Depth levels

Each scope has a default depth that controls artifact detail:

| Depth | Description |
|-------|-------------|
| **Minimal** | Brief artifacts, targeted analysis, no optional content |
| **Standard** | Balanced detail, covers primary and secondary concerns |
| **Comprehensive** | Full detail, extensive analysis, all optional content included |

You can override depth at any approval gate by requesting a different level.

---

## Statusline (Claude Code only)

On **Claude Code**, this implementation displays a statusline in the terminal status bar showing workflow progress. The other harnesses have no statusline — they surface workflow position through `/aidlc --status` (Kiro, Cursor, opencode) and the `update_plan` task-progress item plus `$aidlc --status` (Codex):

```
[AIDLC] IDEATION [▓▓▓▓▓░░░░░] 4/7 > Intent Capture -- Product Agent
```

This shows, in order: current phase, phase progress (as a bar and a ratio — both scoped to the current phase), stage display name, and lead agent. Context usage appears on the right (e.g., `ctx:15%`), color-coded as the remaining context drops. When the Claude usage ledger has data, `↑<in> ↓<out> $<usd>` follows for the active workflow and current transcript/session only; prior workflows and sessions are excluded. Setting `AIDLC_DISABLE_USAGE_TRACKING=1` turns usage tracking off entirely and removes this segment.

The `$<usd>` value is a local estimate priced from **public list prices**, not a bill. When Amazon Bedrock is the recorded provider (`CLAUDE_CODE_USE_BEDROCK=1`), what Bedrock actually charges depends on your inference profile, region, service tier, and any negotiated or subscription pricing, so the figure may not match your invoice. Most of the token volume in a long workflow is cache reads — billed, at the reduced cache-read rate — so the counts and the estimate grow steadily; that is real usage, not inflation. To price new usage at your own rates, point `AIDLC_MODEL_RATES` at a rates file (see [Rate table and overrides](../reference/06-hooks-and-tools.md#rate-table-and-overrides)); totals already recorded keep the rates they were priced at. If you'd rather not show the estimate — while presenting, screen-sharing, or recording — set `AIDLC_DISABLE_USAGE_TRACKING=1` (see [Troubleshooting](15-troubleshooting.md#statusline-shows-a-cost-segment-you-dont-want-or-usage-tracking-concerns)).

### Configuration

The statusline is configured in `.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "bun \"$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts\" engine statusline"
}
```

### Customizing the format

Edit `.claude/hooks/aidlc-statusline.ts` directly. The output format is defined in the `main()` function near the end of the file. The hook reads phase, stage, and agent from `aidlc-state.md`, maps stage slugs to display names, and builds both the unicode progress bar and the `n/m` ratio from the same phase-local checkbox parse.

### Disabling the statusline

Remove the `statusLine` block from `settings.json`. The terminal status bar
reverts to Claude Code's default. Because `statusLine` is a shipped key, the
next `aidlc config` release refresh reports a conflict; run
`aidlc config --force` to restore the shipped entry.

---

## Tool Permissions

The `permissions.allow` list in `.claude/settings.json` pre-approves Claude Code tools so workflows run without per-call permission prompts:

```json
"permissions": {
  "allow": [
    "Read", "Edit", "Write",
    "Bash(bun .claude/tools/*)",
    "Bash(date -u *)",
    "Glob", "Grep", "Task", "WebSearch"
  ]
}
```

The copy channel pre-approves `Bash(bun .claude/tools/*)`; the native release rewrites that entry to `Bash(aidlc engine *)`. `Bash(date -u *)` covers the timestamps the protocol asks the conductor to take. There is no bare `Bash`: Claude Code matches every subcommand of a compound command on its own and strips only a fixed set of known-safe environment variables, so an engine command stays pre-approved only when it runs bare. A `cd ... &&` prefix, an absolute `$CLAUDE_PROJECT_DIR` path, a `VAR=1` prefix, a pipe into `jq`, or a `$(...)` capture all prompt. A project's own build and test commands sit outside the list and prompt once; answering "Yes, and don't ask again" saves a rule for them in `.claude/settings.local.json`.

### How permissions work

- **Project-wide ceiling**: The `settings.json` allow list is the maximum set of tools available
- **Claude Code agents inherit the full session toolset** by default; `disallowedTools: Task` blocks nested subagent spawning on this harness
- **Optional per-agent narrowing**: An agent can be narrowed by adding a `tools:` allowlist to its frontmatter — omit it to inherit everything. Listing `tools:` drops inherited MCP tools unless the fully-qualified `mcp__<server>__<tool>` ids are also listed

### Expanding permissions

Only add tools to the allow list if you create custom stages that need additional capabilities.

### Narrowing permissions

Remove tools from the allow list to require manual approval for each use. Note that removing `Task` causes the four dispatched stages (2.1 Reverse Engineering pipeline, 2.2 Practices Discovery subagent, 2.4 User Stories mob, 3.5 Code Generation subagent) to prompt for permission on each delegation. Workspace detection (0.2) runs deterministically inside `aidlc-utility intent-create` — it does not use `Task`.

---

## Extending AI-DLC

The settings, scopes, depth, and stage edits above cover day-to-day tuning of a workflow you run. When you want to reshape the framework itself for your team — add a stage, add an agent, define a scope, teach a standing rule, wire a deterministic check, or add domain knowledge — that's a distinct job with its own guide: the **[Harness Engineer Guide](../harness-engineering/00-overview.md)**.

The dividing line is data versus code. Everything in that guide is a Markdown file with YAML frontmatter or a JSON config that the framework reads — no TypeScript edits. Where to go for each extension:

| You want to… | Start at |
|--------------|----------|
| Edit what a stage does, or add a new stage | [Anatomy of a Stage](../harness-engineering/01-anatomy-of-a-stage.md), [Adding a Stage](../harness-engineering/02-adding-a-stage.md) |
| Add or modify an agent | [Adding an Agent](../harness-engineering/03-adding-an-agent.md) |
| Define or tune a scope | [Scopes](../harness-engineering/04-scopes.md) |
| Teach a standing rule, or operate the learning loop | [Rules and the Learning Loop](../harness-engineering/05-rules-and-the-loop.md) |
| Wire a deterministic check (sensor) into a stage | [Sensors](../harness-engineering/06-sensors.md) |
| Add team domain knowledge | [Team Knowledge](../harness-engineering/07-team-knowledge.md) |

If your change is to the framework's *code* — the orchestrator, a hook, a CLI tool, the compile pipeline — that's the [Developer Reference](../reference/00-overview.md).

---

## Knowledge and Rules

For details on the two-tier knowledge system and the rule/learning-loop system, see:

- [Knowledge](08-knowledge.md) — Team knowledge directories and methodology reference files
- [Rules and the Learning Loop](09-rules-and-the-learning-loop.md) — Behavioral rules and the self-learning flow

---

## Next Steps

- [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) — Full scope-to-stage mapping
- [Agents](06-agents.md) — Agent permissions and capabilities
- [Troubleshooting](15-troubleshooting.md) — Statusline issues, hook configuration
- [Glossary](glossary.md) — Definitions for scope, depth, guardrail, knowledge
