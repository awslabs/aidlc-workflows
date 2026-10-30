# Reading the signals in `safe.json`

What each part means, what usually goes with it, and what to tell the person. Field names are the keys
in `safe.json`. A value such as `<custom-stage-1>` is a name that is not AI-DLC's own (a plugin's or the
team's stage, agent, sensor or hook, a value someone typed); `local/labels.json` says what each stands for,
for you to understand the run — keep the label in the report.

## `trees` — which AI-DLC is installed in the project

- `row`: `kiro-ide` = "Kiro" (Kiro IDE and Kiro CLI on its v3 engine — the row does not tell which; the Kiro transcript's
  `tool` label does: `kiro (v3: Kiro CLI)` / `kiro (v3: Kiro IDE)`), `kiro` = "Kiro CLI (V2)", `claude`,
  `codex`, `copilot`, `cursor`, `opencode`.
- `stampVersion` vs `buildVersion`: a build made from AI-DLC's `main` stamps the plain release number,
  so report both. A `-preview.` build id means a nightly preview.
- `channel`: `native` (installed with the AI-DLC installer, command `aidlc`) or `copy` (files copied into
  the project, run by Bun from the tree's own `tools/aidlc.ts`).
- `kiroEngine`: `chat.agentEngine` in the project's Kiro settings file (`settings/cli.json` in its Kiro folder). `v3` expected for `kiro-ide`. `kiro`
  with `v3` is a known mismatch (the legacy row on the new engine).

## Kiro engine: configured vs. what ran

Three values, read side by side:
- configured in the project: `trees[].kiroEngine`;
- configured in the home folder: `environment.kiroHomeEngine.agentEngine` (`file: false` = no Kiro settings file in the home folder);
- what actually ran: `transcripts[].engine` — `v3` when the logs came from Kiro's v3 store, `v2` from the v2 store.

Which configured value decides has changed across Kiro CLI versions (no `--agent-engine` flag; default `v2`):
- 2.21.1: the project file overrides the home one (measured, kiro-codex-harness).
- 2.33.1: `chat.agentEngine` comes **only from the home file**; a project value is ignored (measured 2026-10-22:
  project `v3` alone → v2 session; home `v3` + project `v2` → v3 session). Other project keys such as
  `chat.modelDefaults` still apply. The change is reported at 2.33.0; between 2.21.1 and 2.33.1 is not measured.

So read the winner off the Kiro CLI version of the run, and say which file that makes responsible. Report all
three values either way. When the row and the engine that ran disagree (`kiro` row, `engine: "v3"`), that is the
finding, whichever file caused it; on a recent CLI a project value that differs from what ran is expected, not a
fault. A run on v3 with neither file saying `v3` means a flag (`--agent-engine v3`) or a setting this skill does
not read.

Known trap: AI-DLC's Kiro tree ships a project `cli.json` with `chat.agentEngine: "v3"` and
`chat.defaultAgent: "aidlc"`. On Kiro CLI 2.33.1 the agent applies and the engine does not, so a plain
`kiro-cli chat` without `v3` in the home file runs AI-DLC's agent on v2 (`kiro-cli (v2)` transcript, `agents`
`aidlc`, `kiroHomeEngine.agentEngine` not `v3`). Name it as such. The engine settings above are Kiro CLI's;
Kiro IDE sessions land in the v3 store.

## `environment.tools` — the AI tools' versions

- Keys: `kiro-ide`, `kiro-cli`, `claude`, `codex`, `copilot`. Only the tools in `toolsUsed` (the ones this run's
  chat logs came from) are looked up; the others read `version: null` because they were not looked for, not
  because they are missing. Only the used ones belong in the report.
- `source`: `path` (`--version` of the command on PATH), `known-location` (a usual install folder the
  skill's shell PATH missed), `app` (Kiro IDE's `resources/app/package.json`), `person` (the person read it
  off the screen; set-version.ts). For a used tool, `version: null` = not found. A value is the version number
  alone (`2.1.3`).
- `versionsMissing`: used tools with no version at all — not in the chat log, not found now. Ask for these
  (SKILL.md step 4).
- These are versions **now**. The version at the time of the run is `transcripts[].toolVersions` when the tool
  writes one into its log (Claude Code, Codex). Prefer it; when it differs from the version now, give both — the
  person upgraded after the run. Kiro writes none, so a Kiro version is always "measured at collection".

## `audit` — AI-DLC's own record

- `counts`: events in the window. A normal run has many `ARTIFACT_*`, `SENSOR_*`, `HUMAN_TURN`, `GATE_APPROVED`.
- `problems`: the events that point at trouble.

| Event | What the person saw | Often together with |
|---|---|---|
| `ERROR_LOGGED` (Tool = an AI-DLC tool) | the assistant ran an AI-DLC step that failed, often retried | `same-error-repeated` in `absence`, tool errors in the chat log |
| `PLAN_APPROVAL_BLOCKED` | "can't write code before the plan is approved" | refusals of `plan-approval-guard` in the chat log |
| `REVIEW_FREEZE_BLOCKED` | a write was refused because a review was ready | `review-freeze` refusals |
| `REVIEWER_SCOPE_BLOCKED` | the reviewer was stopped reading another Unit | — |
| `GUARD_DISABLED`, `GUARD_STOOD_ASIDE` | a safety check was off or stepped aside | `guardsOff` in `intents[]` |
| `GATE_REJECTED`, `STAGE_REVISING` | the person asked for changes (normal), many in a row = struggle | revision count |
| `STAGE_JUMPED`, `STAGE_SKIPPED` | a redo or skip | — |
| `SENSOR_FAILED`, `SENSOR_BUDGET_OVERRIDE` | a check found problems / ran out of time | later `SENSOR_PASSED` = fixed |
| `BOLT_FAILED`, `SWARM_*`, `MERGE_DISPATCH_FALLBACK` | building a Unit failed or fell back | — |
| `QUESTION_UNANSWERED` | a question box came back empty | — |
| `SESSION_COMPACTED` | the chat ran out of context and was compacted | re-asked questions after it |
| `MEMORY_EMPTY`, `PRACTICES_SECTION_EMPTY` | advisory: nothing to reuse yet | usually not an issue |

- `absence`: signals made from what is missing.
  - An approval gate still open is not one of these: doctor says it, by the engine's own reading of the
    record (its `gate-unresolved` finding, and the "Approval gate pending" line in `local/doctor-stdout.txt`).
  - `no-human-turn-recorded` — gates moved but no reply of the person was recorded (hooks not running).
  - `same-error-repeated xN` — the same AI-DLC step failed N times.

## `intents[]` — where each workflow stands

`currentStage`, `inProgress`, `status` (`Running` / `Completed` / `Archived`), `stages` (`x` done, `-` in
progress, `?` waiting for the person, `R` revising, `S` skipped, `todo`). A workflow stuck on `?` for a
long time = waiting on an approval that may not be visible. `guardPolicy`, `guardsOff`, `planApproval` show
lowered checks.

## `hooks` — whether AI-DLC's hooks ran

- `last`: last heartbeat per hook. Missing hooks, or heartbeats far older than the last audit event,
  mean the hooks stopped running (doctor `hooks-never-fired`, `hook-heartbeat-frozen`).
- `drops`: failures a hook swallowed, reason cut at the first colon. `degraded: true` = half applied.

## `sessionsFolder`

`openQuestions`, `unboundApprovals` (approval asks never answered), `kiroIdePending` (Kiro IDE tool calls
waiting), `transcriptCursors` (`count` and `tools`: how many chat logs AI-DLC's usage ledger followed, and from which
tool — 0 on Claude Code or Codex means AI-DLC's token count did not see this run).

## `transcripts[]` — the AI tool's own log for this project

- `aidlcHookBlocks`: refusals by AI-DLC hooks the model saw, by hook (Claude Code, Codex text). Many of the
  same hook in a short time = a refusal loop; check whether `audit` has matching `*_BLOCKED` rows — if
  not, it is the known gap (refusals that write no audit row).
- `denials`: the tool itself refused (`user-rejected` = the person said no, `automode-blocked`,
  `agent-profile-deny` on Kiro = an agent permission rule, `policy-denied` on Codex = its automatic approval
  review rejected the command).
- `toolErrors` (on Codex also a call that failed before it ran: it could not start, a patch did not apply, the
  arguments did not parse), `repeats` (the same call with the same input 3+ times — a loop or re-reading),
  `approvalPrompts` (Kiro: how many times the person was asked to approve a tool — "why is it asking again?"),
  `questionsAsked` (Claude Code question boxes), `stopFeedback` (AI-DLC's Stop hook kept the turn going).
- `aidlcCommands`: which AI-DLC steps the assistant ran and how often. `orchestrate next` far more often
  than stages moved = the run kept trying to advance.
- `subagents` (Kiro): dispatches per agent, and model/effort from Kiro's log when it is still there.
- Counted per session, as the run was: `toolVersions` (Claude Code, Codex), `models` and `efforts` of the main
  agent, `agents` (Kiro: `aidlc` = AI-DLC's agent; anything else, such as `vibe` or `kiro_default`, means the
  session did not run AI-DLC's agent; `custom` = an agent the person made, name withheld), `approvalModes` (Claude `permissionMode`, Codex `approval_policy`, Kiro
  `autopilot on/off` — read with `approvalPrompts` and `denials` when the complaint is about approvals),
  `engine` (above). A Kiro `models` value `auto` means Kiro chose the model per turn.
- `timeline`: times of refusals, denials and approval prompts — use it to line up with `audit`.

## `replies` — did each typed reply reach AI-DLC?

Each reply the person typed (after AI-DLC's first `HUMAN_TURN` in the window; a subagent's copied history
left out) is matched to a `HUMAN_TURN` within 10 s. `notRecorded` lists the ones with none — time and flags,
never the text. This is the check behind "Your answer didn't reach AI-DLC" / "no new human reply" refusals:
line each `notRecorded` time up with the next `ERROR_LOGGED` that says so.

- Codex adds `inRunningTurn` (the reply went into a turn that was still running — typed in the seconds
  after the question, before Codex ended the turn; no new turn started) and `sameAsBeforeInTurn` (the same
  text as the reply before it in that turn). Both true on every miss is the 10-18 pattern: AI-DLC's prompt
  hook did not record a reply folded into the running turn. Say it plainly ("a reply sent within a few
  seconds of the question was not recorded"). Workaround for the person: wait a few seconds after the
  question appears before replying.
- A miss with `inRunningTurn: false` is a different problem (hook not running, a host that runs no hooks):
  look at `hooks` and `doctor` instead.

## `doctor`

`findings`: AI-DLC's own diagnosis ids — `gate-unresolved`, `state-audit-drift`, `stage-state-audit-drift`,
`current-stage-not-started`, `runtime-graph-stale`, `runtime-graph-missing`, `hooks-never-fired`,
`hook-heartbeat-frozen`, `hook-degraded`, `plan-marker-malformed`, `ensemble-evidence-missing`, plus
warning-level checks (e.g. `runtime-hook-path`, `update`). Warnings about the machine setup are worth one
line in "Environment"; they are rarely the issue itself.
No finding means AI-DLC's own install and records look right, not that the AI tool could do its work: doctor
does not check whether the tool's own sandbox can run commands or write files. When the tool's log shows its
commands failing (`toolErrors`), say so even with no doctor finding.

## `knownGaps`

Copy them into "Not checked". Do not claim the report is complete.
