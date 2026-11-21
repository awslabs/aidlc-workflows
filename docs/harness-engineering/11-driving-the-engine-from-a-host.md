# Driving the Engine from an Outside Host

AI-DLC ships as one core rendered onto seven harness trees, and
[Porting to a New Harness](09-porting-to-a-new-harness.md) is the supported way
to add an eighth. This chapter is the other, narrower question: your program is
not a packed tree at all — it is a host with its own chat surface, its own
approval UI, its own process model — and it wants to run AI-DLC's workflow by
calling the installed engine as a subprocess.

That works, and the engine's gate authority is not lost by doing it. What is
lost is everything the host used to do for the engine: the prompt, the tool
calls and the turn end are what the engine's evidence is made of. This chapter
states exactly which of them you must deliver, which you may leave out, and the
text the engine answers with when a piece is missing.

Every statement below is a reading of the shipped code or of a page named
beside it; the field lists are the ones the code parses, not a proposed shape.

---

## The two integration shapes, and what each is promised

| Shape | You write | What it gets you | Stability |
|-------|-----------|------------------|-----------|
| **A harness port** | `harness/<name>/manifest.ts`, one adapter, your name in `core/`'s harness lists | A packed tree, `aidlc config --harness <name>`, a `distribution` stamp of your own, doctor arms | The contract [Porting to a New Harness](09-porting-to-a-new-harness.md) walks |
| **An outside host** (this page) | A process that shells out to the project's installed engine | The same routing, gates and audit, with your chat UI in place of the host's | No separate promise: the engine namespace is internals, the directive it prints is the contract |

### What the `engine` namespace promises — and what it does not

`aidlc engine --help` opens with its own header: **"Engine machinery -
generated harness surfaces only; not for human scripts"**
(`ENGINE_NAMESPACE_HELP` in `core/tools/aidlc.ts`). The namespace exists so the
generated per-harness surfaces have one stable target; it is not a published
API, and no document promises that a route keeps its arguments across releases.
Two things are stable enough to build on:

- **The directive.** Every directive is validated against the frozen contract
  in `aidlc-directive.ts` before it is printed, and a malformed directive exits
  non-zero rather than emitting a lie a caller would act on
  ([The Skill System](../reference/17-skill-system.md) §2). The eleven `kind`s
  and their allowed keys are that contract, including the `ask` payloads and
  the `guard-recovery` remedies.
- **The public command plane.** `config`, `doctor`, `version`, `update`, `use`
  and `uninstall` are the public top-level routes, and the orchestrate verbs
  `next`, `continue`, `report`, `park`, `team-board`, `unit` and `compose` are
  the ones the conductor itself runs
  ([CLI Commands](../guide/12-cli-commands.md)).

A host therefore pins a release. The project's `.aidlc-version` stamp against
the engine that serves it is doctor's **Project stamp** row
([CLI Commands](../guide/12-cli-commands.md#aidlc-doctor-health-check)); treat a mismatch there as
your integration's compatibility failure, because nothing else will catch a
route that moved.

If you want a versioned promise, the answer is the first row of the table: port
the harness. `aidlc config` refuses a `--harness` name that `modelHarness` does
not hold (`core/tools/aidlc-init.ts`), `harness.json`'s reader refuses a
distribution its `distribution` check does not know
(`core/tools/aidlc-config-diagnostics.ts`), and doctor picks its checks by
harness directory — three refusals that exist precisely because a name has to
be declared before it is stamped.

---

## The entry points

One process per call, JSON (or prose) on stdout, and exit status 0 when the call
succeeded (an error directive is a successful call; only a failure to run exits
non-zero). The route names below are `aidlc engine <noun> <verb>` in a native
install and `bun <harness-dir>/tools/<tool>.ts <verb>` in a source checkout
([Porting to a New Harness](09-porting-to-a-new-harness.md) §The shape names
the two invocation channels).

| Route | Tool | What the host uses it for |
|-------|------|---------------------------|
| `next [args]` | `aidlc-orchestrate.ts` | The routing step. Prints exactly one typed directive: `run-stage`, `load-steering`, `ask`, `print`, `parked`, `notice`, `done`, `invoke-swarm`, `error`. This is the whole loop — call it, act on the directive, call it again. |
| `continue <receipt>` | `aidlc-orchestrate.ts` | Answers a `load-steering` part: apply `rules_content`, then continue with the 8-character receipt printed at the top of the part. |
| `report --result <verdict>` | `aidlc-orchestrate.ts` | Records the outcome of a step. Accepted results: `approved`/`completed`/`complete`/`done` (one verdict, the engine picks the committing transition), `awaiting-approval`, `rejected`, `revised`, `resume`/`resumed`, `skipped`. |
| `park`, `wait`, `team-board` | `aidlc-orchestrate.ts` | Park at a stage boundary; bounded read-only wait for dispatched work; the read-only Team Construction query. |
| `intent create`, `intent switch <name>`, `intent list` | engine nouns | Create the intent a fresh workflow needs, and select one. |
| `log decision`, `log answer`, `log review` | `aidlc-log.ts` | Record a decision, an answer to an engine question, or a review verdict — the rows a gate's decision and its review evidence are made of. |
| `state get`, `state <verb>` | `aidlc-state.ts` | Read the state file and operate the stage checkboxes. Every gate check lives here, so a host that never calls it still cannot bypass one: `report` composes it. |
| `config get`, `config set` | `aidlc-init.ts` | Read and change the piece of work's settings. Lowering a fence still needs the person's turn on record. |
| `hook <name>` | `<harness-dir>/hooks/aidlc-<name>.ts` | Deliver one hook payload — see the next section. |
| `adapter <harness> <target>` | the named harness's adapter | What a generated surface calls. The harness set is a closed union (`AdapterHarness` in `core/tools/aidlc.ts`: `codex`, `copilot`, `cursor`, `kiro`, `kiro-ide`), so a new host gets no adapter name here without a port. |

Two conventions the routes share:

- **The project folder is resolved, not assumed.** `AIDLC_PROJECT_DIR` (absolute,
  or relative to the working directory) wins, then `CLAUDE_PROJECT_DIR`, then
  the tree the hook ships in, then the working directory
  (`resolveProjectDirFromHook` in `core/tools/aidlc-lib.ts`). A host that runs
  the engine from anywhere but the project must set `AIDLC_PROJECT_DIR`.
- **A directive is a contract, not prose.** Act on `kind`; when it is `ask`,
  show `question` with its `choices`, and run the `command` the picked choice
  carries. `numbered_prose_question` is the same question rendered for a chat
  surface that shows prose — that is the field a dashboard-sized host shows.

The orchestrate verbs are also top-level routes (`aidlc next`, `aidlc report`,
`aidlc park`, `aidlc team-board`, `aidlc unit ...`), the spelling the conductor
itself runs; `engine orchestrate <verb>` is the same tool behind the engine
namespace.

### Reading a `guard-recovery` ask

The ask a shut gate answers with is the engine's offer of ways on, and its
shape is frozen in `aidlc-directive.ts`:

- `kind: "ask"`, `ask_type: "guard-recovery"`, `response_route: "execute-remedy"`,
  `stage`, an optional `unit`, `reason_codes`, naming the code(s) the refusal
  reported, and `remedies`.
- Every remedy carries an `op` from the closed `GUARD_REMEDY_OPS` set, an
  `action`, `interaction` (`command`, `human-input` or `external-work`),
  `requiresHuman`, and `executableNow`. The validator refuses an unknown key, an
  `op` outside that set, a non-boolean `requiresHuman`, an `interaction` that
  disagrees with it, an `operation` that is not the remedy's own, a `command`
  with an unresolved placeholder, and `executableNow` that is not `true`; where
  a remedy carries an `operation`, `requiresHuman` must be `true` — "recovery
  reset requires human selection".
- **Route on `op` and `operation`, never on the sentence.** `label` and
  `description` are the person's words (`GUARD_REMEDY_WORDING` in
  `aidlc-lib.ts`) and `action` is the engine's own instruction; all three may be
  reworded between releases.
- `agent_work: true` marks the ask as the conductor's own work: it is never
  published to the person, and every remedy in it must be `external-work`.
- A terminal ask has a `state_signature` and no remedies — there is no
  authority-preserving way on, and `detail` carries the refusal for the
  conductor.

---

## Delivering a hook

`aidlc engine hook <name>` reads the payload as JSON on stdin and runs
`<harness-dir>/hooks/aidlc-<name>.ts`; the name is the file's stem without its
`aidlc-` prefix. The exit status is the host's answer:

| Exit | Meaning | What the engine writes |
|------|---------|------------------------|
| `0` | Allow, or observe-and-allow | Optional context on stdout in the `hookSpecificOutput` envelope the core uses |
| `2` | Refuse. The reason is on stderr | On a Claude tree, a `PreToolUse` refusal is also printed as `permissionDecision: "deny"` JSON, so a host that reads only stdout still sees it |
| `1` or another status | The hook is not answerable | `aidlc engine hook <name>: not available in this install` when the file is absent; `hook does not export run(input)` when the module is not a hook |

A missing or failing hook never blocks a tool call by itself: the contract is
that a host which cannot hard-block should not register the guard at all
([Porting to a New Harness](09-porting-to-a-new-harness.md) §Step 2).

**`record-human-turn` is the one exception to the one-process rule.** The
dispatcher keeps it out of its own importable process and runs it as a child
through an internal entry point, so project code cannot import a `run(input)`
and forge a prompt payload (`runHook` in `core/tools/aidlc.ts`). Invoke the
route; do not reimplement the mint.

---

## The events a host must deliver

The core hooks read one payload union, `ClaudeCodeHookInput` in
`core/tools/aidlc-lib.ts`: `hook_event_name`, `session_id`, `cwd`, `prompt`,
`tool_name`, `tool_input` (with `file_path`, `command`, `status`, `activeForm`),
`tool_response`, `reason`, `source`, `agent_type`, `agent_id`,
`last_assistant_message`. What each event buys:

| Event to deliver | Core hook | Payload the hook reads | What the host loses without it |
|---|---|---|---|
| `UserPromptSubmit` | `record-human-turn` | `hook_event_name: "UserPromptSubmit"`, `session_id`, `prompt` (any of `prompt`/`user_prompt`/`message`) | The `HUMAN_TURN` row every approval stands on, the message record a later `--message <id>` names, the gate words, the reply-to-an-engine-question rows, the hook heartbeat |
| `PostToolUse` on the question box | `record-human-turn` | `tool_name`, `tool_input` (the questions and their options), `tool_response` (the picks), `session_id` | The box's pick recorded as a choice; a question answered in your own UI reaches the engine only as words |
| `PreToolUse` | `guard-tool-call` — the group that runs `state-transition-guard`, `reviewer-scope`, `review-freeze`, `plan-approval-guard` in that order, in one process | `tool_name`, `tool_input`, `session_id`, `cwd` | Every deterministic refusal: writes into AI-DLC's records, a plan built before approval, a reviewer reaching a sibling Unit, a write that would void a review |
| `PostToolUse` on `Write`/`Edit` | `write-audit-log` | `tool_name`, `tool_input.file_path` | The `ARTIFACT_CREATED`/`ARTIFACT_UPDATED` rows a decision reads to know what a reply had already seen |
| `PostToolUse` on `Write`/`Edit` | `run-sensors` | `tool_input.file_path` (it does not consult `tool_name`) | Sensors when the work is written rather than at the gate |
| `PostToolUse` on `Bash` | `rebuild-stage-graph` | `tool_name: "Bash"`, `tool_input.command` | The runtime graph recompiled after a transition, and the engine's own error relay |
| `SubagentStart` / `SubagentStop` | `deliver-stage-rules`, `log-subagent` | `agent_type` (a dispatch hook also reads `subagent_type`, `agent`, `role`), `tool_name`, `tool_input`, `session_id` | Exact stage rules in a dispatched brief; the dispatch and completion rows a review verdict is measured against |
| `Stop` | `aidlc-continue-workflow` | `session_id`, `stop_hook_active` | Loop enforcement — irrelevant if your host owns the loop, which an outside host does |
| `SessionStart` | `session-start` | `session_id`, `source`, `transcript_path` | Resume context, the pre-workflow heartbeat, and the intent binding a chat gets at first contact |
| `SessionEnd` | `session-end` | `session_id`, `reason` | The `SESSION_ENDED` row, at the intent that session is bound to |
| `PreCompact` | `validate-state` | `session_id` | The state validation a compaction asks for |

Two payload conventions exist for a host that drives the engine on a person's
behalf, both read by `record-human-turn`:

- **`origin`** — `{ kind: "person", source?: "record" }` or
  `{ kind: "host", reason: "<why>", source: "record" }`. A turn your host made
  itself (a scheduled wake-up, a step brief, a replayed instruction) must be
  marked `host`: it is recorded as a `HOST_TURN` and spends no presence. Left
  unmarked, anything unknown is read as the person's — the engine's own choice,
  because dropping a real reply is worse than counting a synthetic one
  (`suppliedTurnOrigin`, `TurnOrigin` in `core/tools/aidlc-lib.ts`).
- **The envelope.** A host that delivers each turn as one string — its own
  context blocks, then a request header, then what the person typed — must end
  the person's part with the header
  `[CURRENT USER REQUEST -- respond to this]` (an em dash is read the same).
  The engine takes the text after the **last** header as the person's turn and
  nothing before it (`hostEnvelopeTurnText`). This is measured, not theoretical:
  a 34 KB Crew-dashboard prompt reached Kiro CLI 2.27 whole, and the reply
  `Approve Plan` never matched an offered option until the header was read. A
  prompt without the header is taken whole.

### Session identity, which every one of these rows is keyed by

The order is the one in
[Spaces and Intents](../guide/03-spaces-and-intents.md): the payload's
`session_id`, then `AIDLC_SESSION_OVERRIDE` inherited from the harness process,
then a variable the host sets in its agent's own shell (`CODEX_THREAD_ID`,
`CLAUDE_CODE_SESSION_ID` beside a live `CLAUDE_PID`, `KIRO_SESSION_ID`), then
the nearest live PID ancestry entry. For headless automation the documented
answer is to set **`AIDLC_SESSION_OVERRIDE` on the host process, not on each
command**, so every spawned tool inherits one identity. `validSessionId` only
accepts `[A-Za-z0-9._-]` (up to 180 characters); any other id is dropped and the
chain falls through. A `session_id` that cannot be tied to the chat is what
makes `--message <id>` unusable and leaves a gate standing on nothing.

---

## What the engine needs to open a gate

A gate is opened by evidence in the audit ledger, never by the call that asks
for it. The list, in the order the state tool checks it — every one is a
refusal code the same tool returns, and the remedy set is
`GUARD_REMEDY_OPS` in `core/tools/aidlc-lib.ts`
([State Machine](../reference/12-state-machine.md) §Guard admission and
recovery asks):

1. **A human turn.** `HUMAN_TURN` after the last decision that spent a reply
   (`MESSAGE_SPENDING_EVENTS`), and at a stage gate also after the stage's
   latest start, and after the gate was first shown unless the agent names the
   message it read the answer from with `--message <id>`. The order is
   chronological per clone, with the per-shard position as the same-second
   tiebreak. **This is the piece a host cannot synthesise.** Only the hook that
   saw the prompt writes the row; the public `append` CLI refuses it
   ([State Machine](../reference/12-state-machine.md) §Audit event taxonomy),
   and `aidlc engine hook record-human-turn` "does not authenticate who
   launched the dispatcher" — it records presence, not identity
   ([Hooks and Tools](../reference/06-hooks-and-tools.md)).
2. **The person's words, beside their pick.** `--user-input` is what the
   decision row keeps. A report of an approval with no choice passed is refused
   even when the turn exists.
3. **The stage's artifacts.** `REQUIRED_ARTIFACTS_MISSING`,
   `REQUIRED_SOURCE_WORK_MISSING`; a summary saved before the person's
   confirmation is `SUMMARY_ARTIFACT_UNAUTHORIZED`, and outputs written before
   the stage's questions were asked are `SUMMARY_QUESTIONS_MISSING`.
4. **Reviews, when the stage is reviewer-bearing.** A fresh terminal receipt
   covering the current bytes: `REVIEW_EVIDENCE_MISSING`, `SOURCE_REVIEW_STALE`,
   `REVIEW_BUDGET_EXHAUSTED`, and `REVIEW_FREEZE_ACTIVE` for a write that would
   void one.
5. **Blocking sensors.** The engine fires a stage's `fire_on: gate` blocking
   checks itself at the gate (`fireGateSensors` in `core/tools/aidlc-state.ts`),
   so a host needs no PostToolUse registration for the gate's own checks —
   omitting `run-sensors` costs the per-write pass only.
6. **The team and pipeline receipts**, where the work uses them:
   `PIPELINE_EVIDENCE_MISSING`, `UNIT_COMPLETION_MISSING`.

Presenting a gate (`report --result awaiting-approval`) needs items 3–6; the
**decision** recorded at it needs 1 and 2 as well.

---

## What a host may leave out, and what it hears when it does

Ordered by how much the omission costs. The quoted lines are the shipped text.

**The prompt event — not optional.** Without it the workflow runs, artifacts
are written, and every gate shuts:

- At an approval:
  `Cannot approve "<stage>" because no new human reply has been received for this approval question. Wait for the human to type their choice, then retry the approval.` — followed by the missed-reply sentence below.
- At a stage gate whose start has no reply behind it:
  `Cannot <verb> "<stage>" because no reply from the person is on record since this stage started, so nothing they said answers what it made. Show the gate and end your turn; their next reply answers it.`
- With a turn but no choice passed:
  `Cannot approve "<stage>" because no choice was passed. The person has replied since the last decision: report the choice their reply makes with --user-input (for example "Approve"), or ask them if their reply is unclear.`
- The missed-reply sentence a host with no harness declaration gets:
  `If the person already replied, that reply was not recorded for this question. Tell them exactly this, with nothing about why: "Your answer didn't reach AI-DLC. Please give it once more. If it happens again, type /aidlc --doctor."`
- When the prompt hook ran recently and the workflow has not moved since, the
  same refusal instead says
  `The person has not answered yet: end your turn; their next reply answers it.`
  — the difference between "not answered" and "the answer was lost" is the
  hook's heartbeat (`promptHookRanRecently` in `core/tools/aidlc-lib.ts`).
- A harness that declares an `agentStep` in its manifest gets the agent's own
  step in place of the generic sentence; a host with no manifest gets the
  generic one, by design (`hooksOffAgentStep` returns null when the tree is a
  guess).
- **Doctor fails once work advances.** "Hook heartbeats" fails when a stage or
  gate event exists and no heartbeat does, and fails as *stopped* when the
  newest heartbeat is more than five minutes behind the newest stage or gate
  event ([CLI Commands](../guide/12-cli-commands.md#aidlc-doctor-health-check)). A registered
  hook that throws adds a "Hook drops" row naming it.

**A driver that is not a person must say so.** `AIDLC_UNATTENDED=1` withholds
the mint and keeps the conversational marker; the refusal then carries
`AIDLC_UNATTENDED=1 is set, so automated prompt submissions cannot count as a human reply. Unset AIDLC_UNATTENDED before returning to interactive mode, then submit a new human response.`
The flag can only ever withhold authority, never grant it — leaking it into an
interactive shell refuses real approvals, which is the safe direction, because
the ledger is append-only (`aidlc-record-human-turn.ts`).

**The pre-tool guards.** Leave them out and nothing stops a write any more; the
guards are the only deterministic enforcement of the plan-before-generation
order, the reviewer's read scope, and the review freeze. Their prose bounds
stay in the stage protocol, so the flow still *asks* — it no longer refuses.
`state-transition-guard` also protects the audit shard from direct writes, and
the engine's own lifecycle commands remain refused by the state tool itself
(a direct lifecycle call that bypasses `report` is refused there, not by the
hook).

**`write-audit-log`.** Without the artifact rows, a decision cannot tell what a
reply had already seen: the gate-shown-after-reply bound reads the last
`ARTIFACT_CREATED`/`ARTIFACT_UPDATED` row for the gate's outputs
(`shownLastWrittenAt`), and a summary confirmation with no recorded write is
refused under every policy.

**`Stop`.** An outside host already owns the loop — it calls `next` — so the
forwarding-loop hook adds nothing. Keep it out unless you also want the loop
enforced for an agent that forgets to call back.

**`SessionStart`.** Losing it costs the resume context and the pre-workflow
heartbeat, and a chat binds later, at its first hook payload carrying a
session. Doctor's `notRunYet` line is the one that names it.

**The subagent events.** Without them no `SUBAGENT_DISPATCHED` /
`SUBAGENT_COMPLETED` row exists, so a verdict recorded with no completion row
of its reviewer is marked and said once
([Porting to a New Harness](09-porting-to-a-new-harness.md) §Step 1,
`agentFinishRecorded`).

---

## Registering your host's name

You cannot stamp a project with a distribution the engine does not know. The
name is declared in `core/` (`ModelHarness`), the manifest carries it into
`aidlc-stamp.json` as `distribution`, and `aidlc config --harness <name>`
refuses anything else. [Porting to a New Harness](09-porting-to-a-new-harness.md)
is the complete list of the places that name goes, including the doctor arm a
tree needs before it can report on its own install.

If your host is a distinct product that happens to drive an existing CLI, the
`choiceName`/`choiceNote` pair in the manifest exists for exactly that: two
manifests may share one product and one engine directory while `aidlc config`
shows each by its own name.

## Next

- [Porting to a New Harness](09-porting-to-a-new-harness.md) — the distribution
  contract, if you want the stamp and the doctor arm rather than a subprocess.
- [Hooks and Tools](../reference/06-hooks-and-tools.md) — each hook's own
  contract, including the four guard registration.
- [State Machine](../reference/12-state-machine.md) — the refusal codes and the
  remedy operations this page lists.
