# Review UI and HTML Artifacts

This chapter is the implementation reference for the local Review UI, its
engine handoff, browser question submissions, and the optional HTML artifact
format. For the operator workflow, see [Review in the
Browser](../guide/18-review-in-the-browser.md).

## Architecture and authority boundary

Three components meet at files under the active intent:

```text
session-start hook ── ensures ──> review daemon
                                     │ reads state/manifests/artifacts
                                     │ writes feedback, answers, decisions
                                     │ reads responses/history/workflow records
                                     ▼
                                  browser
                                     │
engine report <── ingests files ─────┘
   │ publishes pointers, manifests, snapshots, responses
   │ emits audit rows and owns gate transition
   ▼
conductor presents the terminal gate
```

- `aidlc-session-start.ts` ensures the daemon is alive when
  `AIDLC_REVIEW_UI=1`. It never mints an open link or adds a link to session
  context. Failure is swallowed and recorded as a hook drop, so Review UI
  availability cannot break the workflow.
- `aidlc-orchestrate.ts report` is the mutating publication and review-input
  ingestion seam. `awaiting-approval` and `revised` publish the current review;
  `approved` and `rejected` consume pending feedback and decisions with the
  terminal decision.
  Read-only `next` and hook probes never mint capabilities.
- `aidlc-review-ui.ts` serves one project, reads workflow state through
  `aidlc-lib.ts`, renders artifacts, and writes append-only feedback, answer,
  or decision submissions. It never advances state, approves a gate, rejects a
  gate, or edits a questions file. A saved answer or decision is a human act
  observed by framework code, so alongside the submission the daemon appends a
  `HUMAN_TURN` row (`Mode: browser`, `Source: review-ui`, `Submission: <file>`)
  under the audit lock — the same standing as the `UserPromptSubmit` seam — and
  touches the human-turn marker. `AIDLC_UNATTENDED=1` withholds the row exactly
  as it does for prompts.
- `aidlc-log.ts answers-apply` is the only browser-answer path that mutates
  `*-questions.md`. It runs under the audit lock and the same human-turn
  discipline as the ordinary `answer` command; the daemon's `HUMAN_TURN` row
  satisfies that discipline, so no terminal keystroke is required after Save.
- `aidlc-log.ts answers-wait` is the read-only "continue when Save happens"
  seam for harnesses whose Stop hook cannot hold a turn: it blocks until an
  unconsumed submission exists for the questions file (exit 0) or its timeout
  passes (exit 3), and mints nothing.
- The Claude Code Stop hook (`aidlc-continue-workflow.ts`) holds the conductor's
  turn during a browser question round until an answer submission lands, then
  supplies the `answers-apply` command. At an `awaiting-approval` browser gate,
  it similarly holds until `decision-NNN.json` lands and supplies the exact
  `report --result approved|rejected` command. A fresh terminal prompt releases
  the gate hold. Both waits use `AIDLC_REVIEW_WAIT_SECONDS` (default 1200;
  `settings.json` grants the hook 1500) and expire to the plain allow. Other
  harnesses may use the read-only `answers-wait` or `decision-wait` commands.

The browser decision is an append-only pre-answer to the terminal-complete
approval gate. It converges on the same `report` command; the daemon never
changes workflow state itself.

## On-disk protocol

All project-relative paths use POSIX separators on the wire. `<record>` is the
active intent's record directory and `<stage-dir>` is its current stage
directory (or a per-Unit Construction stage directory).

### Daemon home

The default daemon root is `~/.aidlc/review-ui/`; `AIDLC_REVIEW_HOME` overrides
it. `<project-id>` is the first 16 hexadecimal characters of the SHA-256 digest
of the project's real path.

#### `<review-home>/<project-id>/server.json`

Private daemon discovery record. The project directory is `0700`; this file is
`0600` because it contains the bearer token.

```json
{
  "version": 1,
  "pid": 48102,
  "host": "127.0.0.1",
  "port": 4765,
  "url": "http://localhost:4765/",
  "token": "<64 lowercase hex characters>",
  "project_dir": "/absolute/project",
  "project_id": "6d31c4f71292d34a",
  "started_at": "2026-09-03T10:00:00.000Z",
  "heartbeat_at": "2026-09-03T10:00:30.000Z",
  "idle_minutes": 240
}
```

`url` is a tokenless origin, safe to print. `heartbeat_at` is rewritten every 30
seconds; synchronous readers require a live PID and a heartbeat no older than
four intervals. `GET /api/health` is the authoritative asynchronous liveness
check. Clean shutdown removes `server.json`.

`server.log` beside it receives detached daemon stdout and stderr.

#### `<review-home>/<project-id>/nonces/<32-hex nonce>`

A `0600` file whose body is the ISO expiration time. It is a single-use,
30-minute capability: successful `GET /open/<nonce>` deletes the file before
setting the session cookie. Expired nonces are swept when a new one is minted.

### Agent runs

#### `<record>/.review-ui/run.json` and `run-log.jsonl`

The daemon's agent run for one intent (`aidlc-review-ui-runs.ts`): `{version:
1, run_id, space, intent, backend: "claude", session_id, pid, state, started_at,
updated_at, turns, last_stop_reason, error}` with `state` one of `starting`,
`running`, `waiting` (a permission or question waits on the human), `idle` (the
turn ended; the session is alive), `ended`, `failed`. The log is one JSON event
per line (`turn`, `text`, `tool`, `permission`, `question`, `note`, `error`),
the last 400 of which `/api/run` serves.

The runner drives the agent over the **Agent Client Protocol** (JSON-RPC 2.0,
newline-delimited, on the agent's stdio; `aidlc-review-ui-acp.ts`). The
installed harness (`harness.json` `name`) selects a profile in `ACP_BACKENDS`:

| Backend (harnesses) | Command | Requirement | First prompt | Human asks arrive as |
|---|---|---|---|---|
| `claude` (claude) | `claude-agent-acp` on PATH, else `bunx @agentclientprotocol/claude-agent-acp@0.75.1`; `CLAUDE_CODE_EXECUTABLE` in the env | `claude` | `/aidlc` | `elicitation/create` (form; the adapter's AskUserQuestion) |
| `kiro` (kiro, kiro-ide) | `kiro-cli acp --agent aidlc` | `kiro-cli` | `/aidlc` | prose; the turn ends |
| `codex` (codex) | `codex-acp` on PATH, else `bunx @agentclientprotocol/codex-acp@1.10.0` | `codex` or `~/.codex` | `$aidlc` | prose; the turn ends |
| `cursor` (cursor) | `cursor-agent acp` / `agent acp` | the Cursor CLI | `/aidlc` | `cursor/ask_question`, `cursor/create_plan` |
| `opencode` (opencode) | `opencode acp` | `opencode` | `/aidlc` | prose; the turn ends |
| `copilot` (copilot) | `copilot --acp` | `copilot` | `/aidlc` | prose; the turn ends |

`AIDLC_ACP_<BACKEND>_COMMAND` replaces the command line (whitespace-split) and
skips the requirement; the runner is off when the requirement is missing or
`AIDLC_REVIEW_RUNNER=0`. All six answer `initialize` with protocol version 1 and
advertise `loadSession` (verified live here for Claude, Kiro CLI 2.13, Codex
1.10, opencode 1.18). The daemon advertises form elicitation and answers exactly
these inbound requests — `session/request_permission`, `elicitation/create`,
and Cursor's two blocking extension methods (mapped onto the same form-question
shape, answers mapped back to option ids / accepted-rejected) — refusing every
other server→client request with `-32601` so the agent never blocks on an
unanswered one. Permission options are read in both spellings
(`optionId`/`name` per the spec, `id`/`label` as kiro-cli sends). Session start sets `AIDLC_REVIEW_RUN=<space>/<record>`
in the agent's environment; the SessionStart hook binds that session to the
named record (`reviewRunTarget`), so `next` in it resolves to the intent
regardless of the cursor. The first prompt is `/aidlc`. When a turn ends and a
browser round lands afterwards (answers saved, gate decided), the daemon sends
the same continuation the Stop hook would have injected
(`browserAnswersContinuation` / `browserDecisionContinuation` in
`aidlc-review-ui-shared.ts`); while the hook is holding the turn it sends
nothing. When a turn ends on a *prepared* question round (a harness whose Stop
seam cannot hold the turn), the daemon opens the round (`openQuestionsRound`) -
it is now the process that waits for the browser - so the form shows instead of
the preparing spinner. `POST /api/run/prompt` with `text` is the reply path for
an agent that asked in prose. A live run keeps the daemon from idling out; on
restart, a run whose session is alive is re-attached with `session/load`.

**Runs per intent.** After `session/new` the daemon waits up to 8 s for
`aidlc/.aidlc-sessions/<acp session id>.binding.json` to name the run's intent
(the SessionStart hook writes it from `AIDLC_REVIEW_RUN`; on every harness
verified so far the hook's session id is the ACP session id). A bound run
isolates its tools from the shared active-intent cursor, so several bound runs
coexist, one per intent (`run.json` `bound: true`). An unbound run - Codex
through `codex-acp`, whose bundled Codex does not fire the project hooks - is
refused while any other run is live and refuses any other Start while it is live
(`RunManager.busyReason`). Every read and write route takes `?intent=&space=`
(`selectionFromUrl`) so the tab operates on the intent it views; without them the
active intent applies, as before.

**Session effort.** `POST /api/intents` and `POST /api/run/prompt` accept
`session_effort` (`low|medium|high|xhigh`; `run.json` `session_effort`). The
profile says how it is applied (`effort`): Claude as `session/set_config_option`
`{configId: "effort"}` after `session/new` and after `session/load`; Kiro as
`kiro-cli acp --effort <level>` at launch. Backends without an `effort` control
ignore it (`RunView.effort_control` false; the composer hides the dial). The
workflow payload's `runner_default_effort` names what an unpinned session runs at
and the file that says so - Claude's `effortLevel` from `.claude/settings.local.json`
over `.claude/settings.json` over `~/.claude/settings.json` (`claudeDefaultSessionEffort`),
Kiro's single `chat.modelDefaults` `output_config.effort` in `.kiro/settings/cli.json`
(`kiroDefaultSessionEffort`); null when no file names one, and the composer's
option reads *default (model default)*.

**Agent effort is project policy.** The workflow payload carries
`models_policy` (`modelsPolicyView` in `aidlc-review-ui-workflow.ts`): the
installed harness, the recorded preset (or `shipped_defaults`), each group's
agents and effective effort (`"inherit"` when the session's applies), per-agent
exceptions, and the harness honesty note when the policy asks for something the
harness drops - resolved with `resolveModelPolicy` from `aidlc config models`'
recorded settings and the shipped agent tiers, exactly as `config models --show`
does. `models_command` names the command that changes it; `recorded` gives what
each settings layer (`global`, `project`, `local`) holds, and `efforts` the
vocabulary. There is no per-intent effort: a run's agents use the project
policy, and only the session effort is chosen at Start. Settings
(`settings.js`, the rail's bottom cog) shows the default effort read-only and edits the
policy through `POST /api/models-policy`, which runs the public
`aidlc config models` command - `--preset`, `--<group>-effort`,
`--agent --effort [--model]`, or `--reset`, with `--project` or `--local` and
`--yes` - the binary when compiled, the dispatcher file under bun, always with
`--project-dir`. The daemon never writes the settings or agent files itself.

**Nudge (daemon-side forwarding loop).** When a turn ends with no pending input,
the pointer at `none`, and the state file's Current Stage still `[-]` in
progress, the daemon re-prompts with the resume prompt after 3 s, at most twice
(`NUDGE_CAP`, the interactive Stop hook's ceiling); any human action - Continue,
Reply, an answer, a permission decision - resets the count and drops a scheduled
nudge. A pointer on any human moment (`prepared`, `questions`, `confirming`,
`awaiting-approval`, `revising`, `approved`) is never nudged.

**Vendored adapters.** `aidlc ui vendor-agent` runs
`bun install --omit=optional` of the profile's `vendorPackage` into
`<toolsDir>/vendor/acp/` (`manifest.json` records backend, package, time);
`resolveAcpLaunch` prefers `vendor/acp/node_modules/.bin/<vendorBin>` over PATH
and `bunx`. Optional dependencies are the adapters' bundled agent binaries (the
Claude SDK's ~190 MB native build), which the runner never uses because it
points the adapter at the harness CLI. Every shipped `.gitignore` re-includes
`<harnessDir>/tools/vendor/acp/node_modules` under the blanket `node_modules`
rule.

**Launcher.** `aidlc ui start [--project-dir]` (the public `ui` command of the
`aidlc` dispatcher, routed to `aidlc-review-ui.ts`) is `ensureReviewUiDaemon`
with `AIDLC_REVIEW_UI=1` forced (the same detached spawn the SessionStart hook
uses), then prints the URL and the runner's availability and opens the tab.

**Verification status per backend.** Live end to end: Claude (questions, gate,
Plan Approval card, code generation), Kiro CLI 2.13 (questions, gate, Plan
Approval by Reply, code generation), Codex 0.149 via `codex-acp` 1.10 (questions
through `answers-wait`, answers applied; its session does not bind, so it runs
alone). Handshake only: opencode 1.18 (`initialize`, `session/new`, `/aidlc`
advertised). Scripted agent only: Cursor (`agent acp`, the two extension asks)
and Copilot (`copilot --acp`) - neither CLI was available with credentials where
this was built; their profiles follow the published documentation and t364/t365
exercise the bridges against the fixture.

### Pending intent requests

#### `aidlc/spaces/<space>/intents/pending-intents.json`

An intent asked for in the browser before any session has picked it up. Not a
record: `{version: 1, requests: [{id, text, scope|null, effort|null, created_at,
source: "review-ui"}]}`, written by the daemon under the workspace lock and
gitignored. `/api/workflow` merges each request into `intents` with
`status: "requested"` and `needs: {kind: "request"}`. The engine's `next`, with
no state file and nothing typed, takes the oldest request as the typed text (and
its scope as `--scope`): an explicit scope reaches the creation print directly,
a null scope takes the Branch 8 inference asks, and `createPrintDirective`
threads `--request <id>` (by id on pickup, by exact text when the conductor
reaches creation through the compose or confirm asks). `next` stays read-only;
`intent-create` removes the envelope only after the record exists.

### Record pointer

#### `<record>/.review-ui/current.json`

The human round: the one record of what the human does now and what ends it,
written by the tool that makes each transition and read by the daemon, the Stop
hook and `--status` - none of them re-derives it from the stage files. `state`
is `questions` (a browser question round is published; `ends_with: "answers"`),
`confirming` (the consolidated-summary confirmation is open in the terminal;
`ends_with: "confirmation"`), `awaiting-approval` (`ends_with: "decision"`),
`revising`, `approved`, or `none`. Writers: `aidlc-html.ts check --guide`
publishes `questions` when the explainer passes for the current stage
(carrying `questions_file`, `questions_sha256` and `guide`; a questions file
that no longer matches the digest is not published); `aidlc-log.ts
answers-apply` closes it; `aidlc-log.ts decision --checkpoint
summary-confirmation` publishes `confirming` and the matching `answer` closes
it; `report` publishes the gate states as before. `GET /api/state` projects the
record as `phase` (`preparing | questions | confirming | reviewing | revising |
working | done | idle`) plus `questions.submitted` and `decision_sent`, and
`POST /api/answers` refuses (409) a round that is not published.

```json
{
  "version": 1,
  "state": "awaiting-approval",
  "ends_with": "decision",
  "stage": "requirements-analysis",
  "unit": null,
  "stage_dir": "aidlc/spaces/default/intents/260903-example/inception/requirements-analysis",
  "revision": 0,
  "updated_at": "2026-09-03T10:00:00.000Z",
  "open": {
    "url": "http://localhost:4765/open/0123456789abcdef0123456789abcdef",
    "nonce": "0123456789abcdef0123456789abcdef",
    "expires_at": "2026-09-03T10:30:00.000Z"
  }
}
```

`state` is `awaiting-approval`, `revising`, `approved`, or `none`; `stage`,
`unit`, and `stage_dir` may be null. `report` stores a newly minted `open` value
when a daemon is live. Directive emission includes that URL only while it is
unexpired and its nonce file still exists; otherwise it emits the tokenless
origin and tells the user to run `/aidlc --status`.

### Stage review directory

#### `<stage-dir>/.review-ui/manifest.json`

```json
{
  "version": 1,
  "stage": "requirements-analysis",
  "phase": "inception",
  "unit": null,
  "revision": 0,
  "opened_at": "2026-09-03T10:00:00.000Z",
  "artifacts": [
    {
      "name": "requirements",
      "path": "aidlc/spaces/default/intents/260903-example/inception/requirements-analysis/requirements.html",
      "format": "html",
      "kind": "document",
      "sha256": "<hex digest or null>",
      "exists": true
    }
  ],
  "review_artifact": "aidlc/spaces/default/intents/260903-example/inception/requirements-analysis/requirements.html",
  "questions_file": "aidlc/spaces/default/intents/260903-example/inception/requirements-analysis/requirements-analysis-questions.md",
  "guide": null
}
```

`artifacts` follows engine-resolved `produces` placement rather than reconstructing
paths in the daemon. `format` is `md` or `html`; `kind` is `document`, `visual`,
or `machine`. A missing artifact remains represented with `exists: false` and
`sha256: null`. `questions_file` is null when absent. The manifest's `guide`
field remains null; M3 derives the optional `<slug>-questions-guide.html` from
the active questions stage and exposes it through `GET /api/state.questions`,
independently of the held review manifest. That pointer carries `ready`
(explainer present and passing) and `preparing` (open answers, no passing
explainer - absent or failing); the client renders a form only when `ready`,
and the workflow payload counts a round as needing the human only when its
`questions.guide` is true.

#### `<stage-dir>/.review-ui/snapshots/r<N>/<basename>`

A byte-for-byte copy of every existing declared artifact when revision `N`
opens. Revision 0 is the first gate. Snapshot basenames drive the revision and
diff endpoints; `.review-ui/` itself is excluded from the record tree.

#### `<stage-dir>/.review-ui/feedback-NNN.md`

Daemon-written, append-only review feedback. `NNN` begins at `001` and grows to
four or more digits rather than wrapping.

````markdown
---
aidlc_review_feedback: 1
stage: requirements-analysis
unit: null
revision: 0
created: 2026-09-03T10:00:00Z
decision_hint: request-changes
---
# Review feedback: requirements-analysis (revision 0)

## requirements.html

### Comment · a1 — Functional requirements › FR3 (element: main > section:nth-of-type(2))
> the export must finish within 5 minutes

Make this 2 minutes; the SLA changed.

### Edit (unified diff) · a2
```diff
--- a/requirements.html
+++ b/requirements.html
@@ ...
```

## General notes

Free text.
````

Every remark heading carries a stable id (`· a1`, `· a2`, …) assigned by the
serializer (client-supplied ids are kept when unique). A reply to an earlier
thread adds `· reply to aN` after the id — `### Comment · a9 · reply to a7 —
Functional requirements › FR2` — from the annotation's optional `reply_to`
field; `/api/remarks` surfaces it as `reply_to` so the Threads panel nests the
follow-up under its parent and the agent answers it within that thread.

Artifact sections use the artifact basename. Remark headings are `Comment`,
`Delete`, `Looks good`, `Label`, or `Edit (unified diff)`, followed by a stable
id such as `· a1`; the UI calls `Edit (unified diff)` a **Suggestion**. A remark
may also carry a heading breadcrumb, approximate line range, and (for HTML) a
CSS element path. Suggestions contain the daemon-computed unified diff.
`decision_hint` is `approve`, `request-changes`, or `none`; it accompanies the
feedback but the separate decision submission is the browser gate pre-answer.

#### `<stage-dir>/.review-ui/answers-NNN.json`

Browser question submission:

```json
{
  "version": 1,
  "questions_file": "aidlc/spaces/default/intents/260903-example/inception/requirements-analysis/requirements-analysis-questions.md",
  "source_sha256": "<digest of questions file shown in the form>",
  "created": "2026-09-03T10:05:00Z",
  "answers": [
    { "id": "Q1", "labels": ["B"], "note": "Prefer the lower-risk rollout." },
    { "id": "Q2", "labels": ["X"], "other": "Regional pilot" }
  ]
}
```

Each answer names a visible `Q<n>`. `labels` contains existing option letters;
`X` requires non-empty `other` text, and `other` without `X` is refused.
Single-select questions accept at most one label. `note` is discussion input,
not an answer. The daemon validates the IDs, letters, cardinality, and current
source digest before writing the file.

#### `<stage-dir>/.review-ui/decision-NNN.json`

Browser approval submission. The daemon accepts it only while the exact current
pointer is `awaiting-approval`; stage, Unit, and revision mismatches return 409.

```json
{
  "version": 1,
  "stage": "requirements-analysis",
  "unit": null,
  "revision": 1,
  "decision": "request-changes",
  "notes": "Clarify the retention limit.",
  "feedback_file": "feedback-002.md",
  "created": "2026-09-05T10:05:00Z"
}
```
`decision` is `approve` or `request-changes`; `notes` and `feedback_file` are
nullable. `feedback_file` names the latest pending feedback file for the same
stage, Unit, and revision when annotations or a general note produced one;
otherwise it is null. `report` consumes the decision with result
`decision-applied`; rejection uses nonblank `notes` when `--reason` is omitted.

#### `<stage-dir>/.review-ui/responses-NNN.md`

Record-first agent replies to browser remarks. A revised gate's completion
message includes the same **Feedback addressed** list, and `report --result
revised --responses <file>` copies the validated file here:

```markdown
# Feedback addressed: requirements-analysis (revision 0)

- a1: applied — Reduced the export SLA to two minutes.
- a2: kept — The existing retry bound is required by the deployment contract.
- a3: answered — The regional exception is documented under Constraints.
```

The heading stage and current pre-revise revision must match the revised report. Each nonblank body
line is `- aN: applied|kept|answered — <nonblank text>` (the separator may also
be a hyphen, en dash, or colon); remark ids are
unique in the file and must exist in that stage and Unit's feedback files. The
daemon projects entries as `{remark_id,status,text,revision,file}` so the
Threads panel can join them to the original remarks.

#### `<stage-dir>/.review-ui/consumed.json`

Shared engine/log-tool receipt for feedback, answer, and decision submissions:

```json
{
  "version": 1,
  "entries": [
    {
      "file": "feedback-001.md",
      "sha256": "<digest>",
      "consumed_at": "2026-09-03T10:10:00.000Z",
      "result": "rejected"
    },
    {
      "file": "answers-001.json",
      "sha256": "<digest>",
      "consumed_at": "2026-09-03T10:08:00.000Z",
      "result": "answers-applied"
    },
    {
      "file": "decision-001.json",
      "sha256": "<digest>",
      "consumed_at": "2026-09-05T10:10:00.000Z",
      "result": "decision-applied"
    }
  ]
}
```

Feedback results are `approved` or `rejected`; browser answers use
`answers-applied`; browser decisions use `decision-applied`. Identity is the
`(file, sha256)` pair.

The canonical `<stage-dir>/<slug>-questions.md` and optional
`<stage-dir>/<slug>-questions-guide.html` remain ordinary stage artifacts, not
files owned by `.review-ui/`. The guide is self-contained HTML with one
`data-aidlc-question="Q<n>"` section per question and a
`data-aidlc-recommend="<letter>"` recommendation.

## HTTP and WebSocket API

Except where noted, all routes require either the `aidlc_review` cookie or
`X-AIDLC-Token: <server.json token>`. JSON errors use `{ "error": "..." }`.
Project-relative `path` parameters are resolved beneath `<project>/aidlc/`,
reject `..`, reject symlink escapes, and return 403 on confinement failure.

| Method and route | Authentication | Response / effect |
|---|---|---|
| `GET /open/<nonce>` | Single-use nonce | Consume nonce, set `aidlc_review=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`, then 302 to `/`; invalid/used/expired is a 403 page naming the consumed-link case |
| `GET /` | Cookie, or a trusted browser navigation | Browser app shell. Without a cookie, a user-initiated top-level navigation (Fetch Metadata `Sec-Fetch-Site: none`/`same-origin`, `navigate`, `document`, matching `Host`) is served and sets the cookie — unless `AIDLC_REVIEW_STRICT=1`; anything else receives a 403 page naming the no-session case. Every cookie-authenticated response re-issues the cookie (sliding 12 h window) |
| `GET /assets/<file>` | None | Static app asset with fixed MIME type |
| `GET /api/health` | None | `{ok, project_id, pid, version}` |
| `GET /api/state` | Cookie/header | Active project, space, intent, record, current pointer and manifest, current stage/status/revision, HTML setting, and live question pointer/readiness |
| `GET /api/workflow?intent=<slug>&space=<name>` | Cookie/header | Selected workspace and intent projection: `{space,spaces,intent,intents,scope,depth,phase,stages_total,stages_done,phases,agent_status,daemon}`. Each intent has `{slug,status,scope,depth,phase,current_stage,needs,updated_at}`; phases contain scope status and stages with state, reason/condition, gate/revision, questions, artifacts, and memory. `intent` and `space` select a read-only record without changing the terminal cursor |
| `GET /api/tree?intent=` | Cookie/header | Recursive selected-record entries `{path,type,size,mtime}` for reviewable files only: `aidlc-state.md`, `project-description.json`, `audit/`, and every dot-directory (`.review-ui/`, `.aidlc-sensors/`, …) are omitted |
| `GET /api/artifact?path=&intent=` | Cookie/header | Markdown source metadata or HTML sandbox metadata. The rebuilt document view uses this route for authored HTML |
| `GET /api/render?path=&intent=` | Cookie/header | Markdown `{path,format:"md",sha256,mtime,source,blocks:[{index,line_start,line_end,html}],headings:[{level,text,id,block}]}`. Blocks are rendered and sanitized server-side; the client inlines their `html` into the document surface |
| `GET /api/raw?path=&intent=` | Cookie/header | Full artifact document for the sandbox path. Authored HTML stays authored; Markdown remains supported for compatibility. The trusted bridge and artifact CSP are applied |
| `GET /api/history?stage_dir=&intent=` | Cookie/header | `{entries:[{kind:"revision"|"feedback"|"answers"|"decision"|"responses",revision?,file,at,by:"agent"|"you",summary,chars_delta?}]}` newest first |
| `GET /api/responses?stage_dir=&intent=` | Cookie/header | `{entries:[{remark_id,status:"applied"|"kept"|"answered",text,revision,file}]}` from `responses-NNN.md` |
| `GET /api/remarks?stage_dir=&intent=` | Cookie/header | `{entries:[{file,revision,decision_hint,created,consumed,remarks:[{id,kind,artifact,heading_path,quote,body,diff}]}]}` from numbered feedback files |
| `POST /api/feedback` | Cookie/header | Validate active stage/unit/revision and annotation schema, write `feedback-NNN.md`, return `{file,path}` |
| `GET /api/snapshots?stage_dir=&intent=` | Cookie/header | `{revisions:[0,1,...]}` |
| `GET /api/snapshot?stage_dir=&revision=&file=&intent=` | Cookie/header | `{source}` from one saved revision |
| `GET /api/diff?path=&from=&to=current\|<revision>&intent=` | Cookie/header | `{hunks,unified}` for selected manifest artifact revisions |
| `GET /api/export?path=&intent=` | Cookie/header | Self-contained HTML attachment |
| `GET /api/questions?path=&intent=` | Cookie/header | Parsed questions, answers, notes, confirmation flags, and source digest for the selected current question target |
| `POST /api/answers` | Cookie/header | Active intent only. Validate submission/digest, write `answers-NNN.json`, return `{file}`; stale digest is 409 `{error:"questions file changed; reload"}` |
| `GET /api/intents/propose?text=` | Cookie/header | `{scope, source: "keyword"\|"default"}` — what the composer would choose: the engine's keyword inference (`inferScopeFromText`), else the selection-aware default scope |
| `POST /api/intents` | Cookie/header | Body `{text, space?, scope?: <name>\|null, label?, session_effort?: low\|medium\|high\|xhigh}`. With a runner and a `scope`: runs `intent-create --space --scope --arguments --label` (the record, state, and audit the conductor would create), starts an agent run bound to it, returns 201 `{intent, space, run_id, mode:"running"}`; 409 while another run is live; `mode:"created"` with `error` when the record exists but the agent did not start. Otherwise records a pending request in `aidlc/spaces/<space>/intents/pending-intents.json` under the workspace lock, 201 `{id, space, created_at, mode:"requested"}`. Unknown workflow/effort 400, unknown workspace 404 |
| `GET /api/run?intent=` | Cookie/header | `{run, pending, events, available, start_prompt, requirement}` — the intent's agent run (`run.json`), the inputs waiting on the human, the last 400 log events, the harness's resume prompt, and what the machine lacks when `available` is false; `run: null` when it never ran |
| `POST /api/run/prompt` | Cookie/header | `{intent, text?}` — send a prompt (default: the harness's resume prompt) to an idle run — Continue, or a Reply to an agent that asked in prose; with no live run, start one (201). 409 while a turn is live |
| `POST /api/run/permission` | Cookie/header | `{intent, id, option_id}` — answer a pending permission with one of its advertised options |
| `POST /api/run/question` | Cookie/header | `{intent, id, action: "accept"\|"decline"\|"cancel", content?}` — answer a pending form question; `content` keys are the schema's properties |
| `POST /api/run/cancel` | Cookie/header | `{intent}` — `session/cancel` the live turn (pending inputs resolve cancelled); an idle run is closed |
| `DELETE /api/intents?id=` | Cookie/header | Withdraws a pending request; 404 when none |
| `POST /api/spaces` | Cookie/header | Body `{name}` (lowercase letters, digits, dashes). Runs the same `space-create` move as the terminal; 409 when it exists |
| `POST /api/models-policy` | Cookie/header | Body `{scope: project\|local, action: preset\|group\|agent\|reset, preset?, group?, effort?, agent?, model?}`. Runs `aidlc config models` with the matching flags and `--yes`; 400 for an unknown scope, preset, group, effort, agent name, or model id (nothing written); returns `{ok, scope, change, notes, models_policy}` with the refreshed view |
| `POST /api/decision` | Cookie/header | Active intent only. Exact body `{stage,unit,revision,decision:"approve"|"request-changes",notes?}`; validate exact current target and `awaiting-approval`, write `decision-NNN.json`, append browser `HUMAN_TURN`, return `{file}`. Stale or closed gates return 409 |
| `WS /ws` | Cookie plus exact own `Origin` | Server pushes `{type:"state"}` after watched record changes |

The selected-record read routes — `/api/workflow`, `/api/tree`, `/api/artifact`,
`/api/render`, `/api/raw`, `/api/questions`, `/api/history`, `/api/responses`,
`/api/remarks`, `/api/snapshots`, `/api/snapshot`, `/api/diff`, and `/api/export`
— accept optional `intent=`; workflow selection additionally accepts `space=`.
`/api/state` always describes the active intent. The three write routes always
target the active intent, so browsing a completed or inactive intent cannot
write into it.

Within `/api/workflow`, `phases` contains
`{name,skipped_by_scope,skipped_count?,stages}`. A stage is
`{slug,name,phase,state,reason?,condition?,decided_at?,revision?,gate?,questions?,artifacts,memory?}`,
where `state` is `done|current|skipped|next|conditional|pending`, `gate` is
`awaiting-approval|revising|approved|null`, questions are
`{file,answered,total,open,guide}`, and artifacts are
`{name,path,exists,format,kind,revision,threads,produces}`. `agent_status` is
`idle|writing|revising|waiting`; `daemon` is `{version,port}`.

`GET /api/state` adds
`questions: {file, guide, stage, stage_dir} | null` whenever the state-derived
current non-Unit stage's questions file exists, independently of gate state or
the review manifest. Here `file` is the project-relative questions path and
`guide` is the optional project-relative explainer path. Per-Unit questions
return null in M3. `GET /api/questions` returns:

```json
{
  "path": "<project-relative questions path>",
  "sha256": "<hex>",
  "stage": "requirements-analysis",
  "questions": [
    {
      "id": "Q1",
      "title": "Q1: Rollout",
      "prompt": "Which rollout should we use?",
      "options": [{ "letter": "A", "text": "Global" }],
      "multi": false,
      "answer": null,
      "note": null,
      "confirmation": false
    }
  ]
}
```

The consolidated-summary confirmation is represented with
`confirmation: true` and is not answerable in the browser.

The rebuilt Markdown path uses `GET /api/render`: the server splits the source
into top-level blocks, renders each block with `Bun.markdown`, removes blocked
tags, event handlers, and unsafe URL values, and returns sanitized HTML plus
source line bounds and heading metadata. The ES-module client inlines those
blocks into the privileged document surface and retains the Markdown `source`
only to create suggestions; it never writes the artifact. `POST /api/render-fragment`
`{ source }` renders one suggested block through the same sanitizer so the
client can show a pending edit in place as tracked changes (a word diff of the
two renderings' visible text, inserted spans wrapped in `<ins>`, removed text
re-inserted as `<del>`); it reads no files and takes the same token.

Authored HTML follows a different trust path. `GET /api/artifact` supplies its
`raw_url`, `/api/raw` applies CSP
`default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src
'unsafe-inline' 'self'; font-src data:; frame-ancestors 'self'`, and the app
embeds it in an iframe sandboxed with `allow-scripts` and no
`allow-same-origin`. The bridge emits `aidlc-anchor` only from trusted selection
or Alt-click events. The parent accepts messages only from the current frame and
validates the bounded selection, heading path, and CSS path. Thus authored HTML
never executes in the app document.

The app shell uses its own CSP:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.

### Front-end modules and store

The browser is an ES-module app loaded by `<script type="module"
src="/assets/app.js">`. The shell is divided by ownership around a toggleable
workflow panel, central view, and one optional right slot:

- `app.js` boots the modules, loads `/api/state` and `/api/workflow`, and turns
  WebSocket invalidations into a refresh.
- `api.js` owns authenticated JSON/text requests, URL construction, session
  renewal, and the live socket.
- `store.js` is the shared contract. It holds `state`, `workflow`, `view`, the
  selected right `panel`, workflow-panel visibility, pending `annotations`, the
  rendered `document`, current `selection`, agent `responses`, focused thread,
  and connection state. `set`, `on`, and `emit` are the only module bus.
- `shell.js` owns the **Inbox · Workflow · Search** rail, per-view header, Inbox,
  and `⌘K` palette; `workflow.js` owns the intent popover, stage tree, panel
  footer, all-files view, and stage overview.
- `document.js` owns Markdown block rendering, gutter bubbles, selection `+`,
  in-place suggestions, contextual Markdown toolbar, outline data, authored
  HTML iframe, and read-only past artifacts.
- `threads.js` owns pending and sent thread cards, decision submission, and
  `/api/remarks` plus `/api/responses`; `history.js` owns the History/Diff and
  Outline right-slot views; `questions.js` owns live and answered rounds.

The persistent DOM regions are `#rail`, `#panel`, `#header`, `#main`, `#slot`,
`#notice`, `#paused-overlay`, and `#search`. `store.view.kind` is `artifact`,
`questions`, `overview`, `inbox`, or `empty`; `store.panel` is `threads`,
`history`, `outline`, or null. Pending annotations are stored in
`sessionStorage` under the current stage, Unit, and revision and leave the
browser only when a decision posts them to `/api/feedback`.

## Authentication model

The daemon creates a random 256-bit bearer token on each start. The token exists
only in the private `server.json` record and the browser's `HttpOnly` cookie; it
is never placed in a printed URL, HTML, JavaScript, directive, or audit row.
Every API route and the WebSocket require it (cookie, or `X-AIDLC-Token` for
tooling and tests); WebSocket upgrades also require the exact daemon origin.

### First hop: browser-navigation trust (default)

The bare origin (`http://localhost:<port>/`) opens directly. For an
unauthenticated `GET /` the daemon trusts the browser's own Fetch Metadata for a
user-initiated top-level navigation — `Sec-Fetch-Site: none` (typed URL,
bookmark, reload, `open` from the terminal) or `same-origin`, with
`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, and a `Host` naming this
daemon (the advertised host or a literal loopback spelling with the bound port).
It serves the app shell and sets the session cookie on that response. A page on
another site cannot produce those headers: its navigations arrive as
`cross-site`, a `fetch()` is not a document navigation, and a DNS-rebinding
attempt carries a foreign `Host` — all answer the 403 page. Requests without
Fetch Metadata (browsers older than Safari 16.4, `curl`) fail closed to the
link path below. A non-browser process on the same machine could forge the
headers, but it runs as the same user and can already read the project files;
the token still protects every write and every API read from cross-site pages.

Consequently the URL to print is the origin itself: `/aidlc --status`,
`/aidlc --doctor`, the gate's `**Browser:**` line, the daemon's `open`/auto-open,
and `directive.review_ui.url` all name it, and no nonce is minted.

### First hop: single-use links (`AIDLC_REVIEW_STRICT=1`)

On shared multi-user hosts set `AIDLC_REVIEW_STRICT=1` in the harness
environment (the daemon and the CLI both read it). The bare origin then never
opens; a browser first has to follow a single-use `/open/<nonce>` link (30 min)
that exchanges the nonce for the cookie. Only human-invoked or mutating callers
mint one — every `aidlc-orchestrate report` result, `/aidlc --status`,
`/aidlc --doctor`, and the daemon's own `open` and auto-open paths.
`orchestrate next`, directive replay, Stop-hook probes, and session-start are
read-only and do not mint; a directive prints the stored link only while it is
fresh and unused. `/open/<nonce>` links keep working in the default mode too.

### Session lifetime

The cookie carries a 12 h `Max-Age` that every cookie-authenticated response
renews, so a tab in use never lapses; a tab idle for 12 h does. The token is
regenerated on every daemon start, which invalidates every earlier cookie — the
daemon's lifetime (bounded by the idle exit) is the absolute session bound. On a
401 the app reloads itself once: that reload is a trusted navigation, so the tab
is back with a fresh cookie and no human action. If the reload still lands
signed out (strict mode, or no Fetch Metadata) the app shows a `/aidlc --status`
prompt instead of looping; when the daemon is unreachable it shows a
daemon-stopped notice.

### Directive shape

```json
{
  "review_ui": {
    "origin": "http://localhost:4765/",
    "url": "http://localhost:4765/"
  }
}
```

`origin` is present whenever the daemon is alive. By default `url` equals
`origin`; in strict mode `url` is `http://localhost:4765/open/<nonce>` and is
present only while that stored link is fresh and unused.

The supported deployment uses the default loopback bind. A non-loopback
`AIDLC_REVIEW_HOST` is outside the supported LAN-sharing posture; remote use is
through an SSH tunnel.

## Engine publication and `report` ingestion

With `AIDLC_REVIEW_UI` unset, publication, directive fields, prose lines, and
record-side files are absent. With it set:

- `report --result awaiting-approval` publishes the manifest, snapshots, and an
  `awaiting-approval` pointer.
- `report --result revised --responses <file>` validates the optional responses
  heading, current revision, line grammar, unique remark ids, and that every id
  exists in feedback for the same stage and Unit. After the `revise` transition
  commits, it copies the file as `responses-NNN.md`, appends
  `REVIEW_UI_RESPONSES` with `Stage`, optional `Unit`, `Revision`, `File`, and
  `Remarks`, then publishes the revised manifest, snapshot, and
  `awaiting-approval` pointer.
- `POST /api/decision` writes an append-only browser pre-answer. The Stop hook
  turns it into the ordinary `report` command; `report` consumes it only after
  the transition commits, recording `decision-applied`. On rejection, decision
  `notes` supply `--reason` when no terminal reason was provided.
- `report --result rejected --reason <terminal text>` reads all pending feedback
  in sequence order and appends `## Browser review feedback` plus each filename
  and body verbatim to the rejection reason. It records `GATE_REJECTED`, then
  one `REVIEW_UI_FEEDBACK` row (`Stage`, optional `Unit`, `Revision`,
  `Result: rejected`, `Files`, `Digest`), marks feedback and the matching
  decision consumed, and writes a `revising` pointer.
- `report --result approved` emits the same feedback audit event with
  `Result: approved`, marks pending feedback and the matching decision consumed,
  and returns combined feedback bodies as `approval_notes`. Those notes are
  downstream guidance, not a request to revise the approved artifact.

Feedback bodies are not reinterpreted or normalized by the engine. The digest
is SHA-256 over their concatenated bodies.

`directive.protocol_modules` includes:

- `html` when the intent's `HTML Artifacts` state field is `on`; the conductor
  reads `aidlc-common/protocols/stage-protocol-html.md` before authoring.
- `guide` when `review_ui` is present; the conductor reads
  `aidlc-common/protocols/stage-protocol-guide.md` for the browser-explainer
  interaction mode and HTML shape.

The protocol modules are conditional context, not feature detection by the
agent. The engine chooses them from deterministic state and daemon availability.

## Artifact vocabulary and resolution

`core/tools/aidlc-artifact-vocabulary.ts` assigns every core produced artifact
one `ARTIFACT_KIND` value:

- `document`: human-readable prose,
- `visual`: human-readable design/diagram output, or
- `machine`: anything parsed, promoted, configured, or used as a form.

Questions, traceability, evidence, team practices, generated configuration,
results, and Reverse Engineering / CodeKB outputs are machine artifacts. When a
classification is uncertain, use `machine`; native format is the fail-safe.

A graph node always carries `html_capable: string[]`. The compiler computes it
as the node's `produces` entries whose kinds are `document` or `visual`, only in
`ideation` or `inception`, minus the stage's optional `html_exclude`. A list
excludes named produced artifacts; literal `"*"` excludes the stage. An unknown
core produced artifact in an eligible phase fails graph compilation with:

```text
unclassified artifact "<name>" produced by <slug>: add it to ARTIFACT_KIND in core/tools/aidlc-artifact-vocabulary.ts
```

Plugin artifacts default to machine unless the plugin manifest declares an
artifact kind.

Format resolution is strict:

```text
HTML Artifacts is on AND artifact is in compiled html_capable union → .html
otherwise                                                       → .md/native
```

There is no existence fallback and no ambient format state. Each operation
derives an immutable `ArtifactFormats` value once and passes it through every
artifact lookup. `artifactFormatsFromState(stateContent)` uses the caller's
atomic state snapshot and the compiled `html_capable` union; `readStateFile()`
only reads and returns `aidlc-state.md` and has no format side effects.
`resolveArtifactInstances(..., { stateContent })` gives that supplied snapshot
precedence, while calls without one derive formats from the owning project.

When only project identity is available,
`artifactFormatsForProject(projectDir, intent?, space?)` reads that project's
state and derives the same per-call context. This keeps concurrent and
multi-intent operations isolated while preserving Markdown byte behavior when
HTML Artifacts is off or absent. If the stage graph is unreadable, an `on`
intent resolves to Markdown and emits a warning rather than failing the state
read. The gate guard enforces the outcome regardless of prose: an HTML-capable
artifact that exists only as its `.md` twin refuses `gate-start`/`approve`.

Intent creation seeds `- **HTML Artifacts**: on` only when
`AIDLC_HTML_ARTIFACTS=1`; otherwise it writes `off`. An absent field on an old
intent reads as off. `/aidlc --html-artifacts on|off` refuses if any capable
artifact already exists in either extension or any stage is `[?]` / `[R]`; it
names every blocker and does not convert files.

## HTML authoring and review appendix

`stage-protocol-html.md` requires a self-contained document with:

- `<!doctype html>`, `<html lang>`, `<meta charset>`, a descriptive `<title>`,
  and exact `aidlc-artifact` / `aidlc-stage` metadata;
- `<section data-aidlc="summary">` as the first body element;
- the resolved Markdown template's H2 set and order mapped to semantic sections;
- no external fetches, parent paths, forms with actions, iframes, objects, or
  embeds; and
- semantic, accessible, deterministic source whose content remains meaningful
  without script.

Inline style, SVG, and optional-enhancement script are legal. The author must
reserve `<section data-aidlc="review">` for the reviewer.

For an HTML `review_artifact`, `stage-protocol-reviewer.md` appends this form
immediately before the closing body tags, never the Markdown form and never both:

```html
<section data-aidlc="review">
  <h2>Review</h2>
  <p><strong>Verdict:</strong> READY|NOT-READY</p>
  <p><strong>Reviewer:</strong> &lt;directive.reviewer&gt;</p>
  <p><strong>Iteration:</strong> &lt;n&gt;</p>
  <p><strong>Request Challenge:</strong> &lt;reviewChallenge&gt;</p>
</section>
```

It must be the final body element. The same source/artifact fingerprint and
review-receipt rules apply to Markdown and HTML.

## `aidlc-html.ts`

The dependency-free HTML utility is both importable and executable:

| Command | Contract |
|---|---|
| `bun <harnessDir>/tools/aidlc-html.ts text <file>` | Print Markdown verbatim or deterministic Markdown projected from HTML (headings, paragraphs, lists, tables, code, links, images, SVG labels); omit scripts/styles/templates/head |
| `bun <harnessDir>/tools/aidlc-html.ts check <file> [--name <artifact>] [--stage <slug>]` | Validate the document metadata, leading summary, offline references, prohibited embeds/forms, and terminal review section; findings one per line, exit 1 on failure |
| `bun <harnessDir>/tools/aidlc-html.ts check --guide <file> --questions <md>` | Apply the base HTML checks plus the questions-explainer contract: matching ordered `Q<n>` sections, IDs, and one valid recommendation per answerable question. Findings are actionable: a question whose options the parser cannot read is reported once (`Q1 has no parsable options … options must be bare lines "A. text"…`) instead of once per recommendation; an out-of-range letter names the offered letters; an empty `data-aidlc-recommend` is called out; the summary finding points at the scaffold. It also applies the questions-file invariants `answers-apply` enforces after a save — each `Q<n>` heading once (a duplicate is reported, never merged into the first), parsable options, exactly one `[Answer]:` line, and an `X. Other (please specify)` option — so a file the apply step would refuse fails here, before the round is published |
| `bun <harnessDir>/tools/aidlc-html.ts scaffold --guide <questions.md> [--out <file>] [--depth minimal\|standard] [--stage <slug>]` | Emit a guide skeleton that already satisfies `check --guide`: head identity (stage from the `<slug>-questions.md` filename), the summary section, and one section per `Q<n>` with the real option letters and texts in the trade-off rows and an empty `data-aidlc-recommend` to fill. `--depth minimal` keeps only **Why now** and **Recommendation** per question |
| `bun <harnessDir>/tools/aidlc-html.ts export <file> [--out <path>]` | Render Markdown or inline authored HTML's sibling assets into a self-contained HTML document |

`readArtifactText(path)` is the shared deterministic projection used by the
required-sections, upstream-coverage, and claim-sources sensors.

### `html-shape` sensor

`core/sensors/aidlc-html-shape.md` declares a gate-fired, advisory,
`document-shape` sensor. Ideation and Inception stages import the bare id
`html-shape` (Reverse Engineering does not). At gate time,
`aidlc-sensor-html-shape.ts` scans every `.html` sibling in the fired stage
directory and applies `checkHtmlArtifact`. It passes with reason
`no HTML outputs` when the stage has none, so Markdown intents do not acquire a
new failure mode. Findings name the file and violated rule.

## HTML questions explainer contract

The questions file's option lines are the contract every reader shares — the
guide check, the browser form (`parseQuestionsMarkdown`), and `answers-apply`:
a bare `<LETTER>. <text>` line at column 0 under a `## Q<n>. <title>` heading.
A Markdown bullet (`- A. …`), a numbered item, or an indented letter is prose to
all three. The conductor starts from `aidlc-html.ts scaffold --guide` so the
structure is right before any prose is written, and the daemon publishes the
round to the browser only once the guide passes the check — the human never
sees an unfilled scaffold, a form without its recommendations, or prose
arriving underneath them. `check --guide` therefore also fails on empty
paragraphs, an empty summary, empty trade-off cells, and empty
`data-aidlc-recommend` values. At Minimal depth a question
section carries only **Why now** and **Recommendation**; Standard and
Comprehensive add the trade-off table and **Related decisions**.

`<slug>-questions-guide.html` satisfies the base HTML artifact contract and uses
metadata artifact name `<slug>-questions-guide` and stage `<slug>`. Its body
starts with a one-paragraph `data-aidlc="summary"` section, followed in questions
file order by one section per ordinary `Q<n>` question. The consolidated-summary
confirmation has no `Q<n>` id and is excluded:

```html
<section data-aidlc-question="Q1" id="Q1">
  <h2>Q1: question title</h2>
  <h3>Why now</h3>
  <p>What depends on this decision.</p>
  <h3>Trade-offs</h3>
  <table><!-- Option | You get | You give up | Cost / risk --></table>
  <h3>Recommendation</h3>
  <p data-aidlc-recommend="B">Rationale.</p>
  <h3>Related decisions</h3>
  <p>Prior answer with its record path, or None found.</p>
</section>
```

The guide bridge sends at most 200 `^Q\d+$` to `^[A-Z]$` recommendations. The
parent validates them and only preselects a currently unanswered question.

## `answers-apply`

The mutating command is:

```bash
bun <harnessDir>/tools/aidlc-log.ts answers-apply \
  --stage <slug> --questions-file <path> [--unit <unit>] [--project-dir <path>]
```

It is flag-independent: submissions can be applied whenever they exist, even if
the current process does not have `AIDLC_REVIEW_UI=1`.

The companion wait is:

```bash
bun <harnessDir>/tools/aidlc-log.ts answers-wait \
  --stage <slug> --questions-file <path> [--unit <unit>] [--timeout <seconds>] [--project-dir <path>]
```

It prints `{ready: true, files, questions_file}` and exits 0 as soon as an
unconsumed submission for that questions file exists (a directory watcher wakes
it; a 1 s poll is the guarantee), or `{ready: false, …, waited_seconds}` with
exit 3 after `--timeout` (default 540 s, under the 10-minute ceiling most shell
tools impose) so the caller simply waits again. It consumes and mints nothing.

Under the audit lock it:

1. finds unconsumed `answers-*.json` files in sequence order; later submissions
   override earlier submissions for the same question;
2. verifies every submission's `source_sha256` still equals the questions file;
   one mismatch refuses the whole batch and consumes nothing;
3. replaces or inserts `[Answer]: A, B` or `[Answer]: X — <other>` and the
   optional immediately following `[Note]: <text>` without altering other
   question sections;
4. requires a fresh `HUMAN_TURN` after the previous `QUESTION_ANSWERED`, then
   emits one `QUESTION_ANSWERED` row with `Stage`, optional `Unit`,
   `Mode: browser`, `Questions File`, answer count, submission filenames, and
   the new file digest; and
5. appends `answers-applied` entries to `consumed.json`, then prints
   `{applied, files, questions_file}`.

A stale submission exits 1 with
`answers-apply refused: <file> was recorded against an older questions file; ask
the human to reload and save again.` Notes remain discussion input for follow-up
analysis and never count as answers.

## `decision-wait` and `decision-apply`

```bash
bun <harnessDir>/tools/aidlc-log.ts decision-wait \
  --stage <slug> [--unit <unit>] [--timeout <seconds>] [--project-dir <path>]
bun <harnessDir>/tools/aidlc-log.ts decision-apply \
  --stage <slug> [--unit <unit>] [--project-dir <path>]
```

`decision-wait` is read-only: it prints `{ready:true,file}` and exits 0 for the
first unconsumed matching decision, or `{ready:false,waited_seconds}` and exits
3 on timeout (default 540 seconds). `decision-apply` is also read-only despite
its name: it prints the first pending decision JSON without changing state or
consumption. The conductor then runs the equivalent `report` command, which
alone owns the gate transition and `decision-applied` receipt.

## Stop hook browser holds

The Claude Code Stop hook holds a browser question round only when Review UI is
enabled, the daemon discovery record is alive, the current stage has both its
canonical questions file and sibling guide HTML, and an ordinary answer is
still blank. It watches for an unconsumed `answers-NNN.json`; on arrival it
blocks the stop once with the exact `answers-apply` command. Read errors and
timeout fail open to the ordinary terminal flow.

The approval hold is similarly conservative: the state checkbox and
`<record>/.review-ui/current.json` must both name the current stage at
`awaiting-approval`, the pointer must have a stage directory, the daemon must be
alive, and Review UI must be enabled. The hook waits for a matching unconsumed
`decision-NNN.json`. A browser decision blocks the stop once with the exact
`report --stage <slug> [--unit <unit>] --result approved|rejected --user-input
...` command; a newer terminal human-turn marker releases the wait, and timeout
falls back to the existing terminal gate.

Both holds use `AIDLC_REVIEW_WAIT_SECONDS`: 1200 seconds by default on Claude
Code and 0 elsewhere. `0` disables them. A harness that opts in must give its
Stop hook a longer timeout; the shipped Claude Code setting grants 1500 seconds.
Other harnesses can use the read-only `answers-wait` and `decision-wait`
commands instead.

## Environment variables

Boolean variables use the exact string `"1"` unless a row says otherwise.

| Variable | Default | Effect |
|---|---|---|
| `AIDLC_REVIEW_UI` | unset | `1` enables daemon startup, review publication, directive field, browser gate line, and feedback/questions UI; unset preserves legacy behavior |
| `AIDLC_REVIEW_PORT` | unset | TCP port. Unset: the first free port from 4765 to 4774, then ephemeral. `<n>` pins that port exactly (the daemon fails if it is taken); `0` asks the OS for an ephemeral port |
| `AIDLC_REVIEW_HOST` | `127.0.0.1` | Bind address. Loopback is always bound so the local address never changes; setting another address (a LAN IP) binds it **as well**, on the same port, sharing the token and cookie; `0.0.0.0`/`::` binds every interface (localhost is advertised, the interface addresses are listed as extras). `server.json` gains `hosts`/`urls` when more than one address is bound. Keep the default for the supported security posture — any extra address exposes the daemon to that network |
| `AIDLC_REVIEW_OPEN` | enabled | `0` disables automatic browser launch. Otherwise the daemon opens a browser when a gate opens (transition into awaiting-approval) or a browser question round begins (the `<slug>-questions-guide.html` explainer lands) and no review tab is present (no live WebSocket and no authenticated request within the last 10 s); never over `SSH_CONNECTION`. A connected tab is not duplicated; WebSocket `{type:"state"}` invalidations reload the state and workflow projections |
| `AIDLC_REVIEW_IDLE_MINUTES` | `240` | Exit after this many minutes with no WebSocket client and no observed state change |
| `AIDLC_REVIEW_STRICT` | unset | `1` disables browser-navigation trust for `GET /`: the bare origin never opens and every printed URL is a single-use `/open/<nonce>` link. For shared multi-user hosts. Set it in the harness environment so the daemon and the CLI agree |
| `AIDLC_REVIEW_WAIT_SECONDS` | `1200` on Claude Code, `0` elsewhere | How long the Stop hook holds a browser question round or an `awaiting-approval` browser gate waiting for `answers-NNN.json` or `decision-NNN.json`. A fresh terminal prompt releases the decision hold; timeout falls back to the ordinary terminal flow. Must stay below the hook's own timeout (`settings.json` grants 1500 s on Claude Code). `0` disables both holds |
| `AIDLC_REVIEW_HOME` | `~/.aidlc/review-ui` | Override private daemon discovery/log/nonce root; primarily useful for tests and isolated installations |
| `AIDLC_HTML_ARTIFACTS` | unset | `1` seeds new intents with `HTML Artifacts: on`; the state field, not the environment, controls the intent thereafter |
| `AIDLC_REVIEW_RUNNER` | enabled | `0` turns the daemon's agent runner off; Start then records a request for the terminal |
| `AIDLC_ACP_<BACKEND>_COMMAND` | unset | Command line that launches that backend's ACP agent (whitespace-split), replacing resolution and the requirement check: `AIDLC_ACP_CLAUDE_COMMAND`, `AIDLC_ACP_KIRO_COMMAND`, `AIDLC_ACP_CODEX_COMMAND`, `AIDLC_ACP_CURSOR_COMMAND`, `AIDLC_ACP_OPENCODE_COMMAND`, `AIDLC_ACP_COPILOT_COMMAND` |
| `AIDLC_REVIEW_TURN_MINUTES` | `240` | Ceiling on one agent turn; a turn still running after it is cancelled |
| `AIDLC_REVIEW_RUN` | set by the daemon | `<space>/<record>` on an agent session the daemon launched; the SessionStart hook binds the session to that record |

Auto-open is also suppressed when `SSH_CONNECTION` is present. The daemon opens
only on a supported desktop (`open`, `xdg-open`, or `cmd /c start`) and ignores
launcher failures.

## Non-goals and extension seams

- The browser never advances workflow state itself. A decision submission is an
  append-only pre-answer consumed by the ordinary terminal `report` seam.
- The browser does not write `*-questions.md`; `answers-apply` is the only
  browser-answer mutation seam.
- There is no supported LAN sharing mode, hosted collaboration server,
  user/account system, or multi-project daemon. Keep `AIDLC_REVIEW_HOST` on its
  default loopback address.
- There is no Markdown-to-HTML migration or extension fallback for an in-flight
  intent.
- A Plannotator adapter is not shipped. The stable extension seam is the
  append-only `feedback-NNN.md` contract: another trusted local UI may produce
  that exact format, after which normal `report` ingestion and audit behavior
  apply.
