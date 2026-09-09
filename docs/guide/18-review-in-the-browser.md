# Review in the Browser

The Review UI is an optional local browser surface named **AI-DLC Workflows**.
It mirrors the file-backed workflow: you can navigate intents and stages, answer
questions, read artifacts, leave anchored feedback, compare revisions, and
choose **Approve** or **Request changes**. Every browser act has the same
terminal path and engine behavior; the terminal remains complete when the
daemon is disabled or unavailable.

## Enable the Review UI

Set `AIDLC_REVIEW_UI=1` in the environment that starts your harness:

```bash
export AIDLC_REVIEW_UI=1
```

At session start, AI-DLC ensures that the project-local review daemon is running,
normally at **http://localhost:4765/** (the next free port upward if another
project already holds it). It is detached from the session and stops after its
idle timeout. You do not need a session at all: from the project root,

```bash
aidlc ui start
```

starts the daemon detached, prints the URL and whether an agent runner is
available for this harness, and opens the tab. From there every intent is
started, driven, and reviewed in the browser (see *Start an intent from the
browser*). `serve --project-dir "$PWD"` runs the daemon in the foreground with
its log in the terminal; `status`, `stop`, and `open` do what they say.

`<harnessDir>` is the installed harness directory, such as `.claude`, `.kiro`,
`.codex`, `.cursor`, or `.aidlc`.

## Review an approval gate

When a stage reaches an approval gate, the completion message includes a line
like:

```text
**Browser:** http://localhost:4765/
```

That address just opens — type it, bookmark it, or click it. The daemon
recognises a browser's own navigation and starts your session on arrival; no
token is printed anywhere. `/aidlc --status` and `/aidlc --doctor` print the
same address. On a desktop you rarely need it: when a gate opens or a browser
question round begins and no review tab is connected, the daemon opens one for
you (`AIDLC_REVIEW_OPEN=0` disables this). An open tab follows watched workflow
files over its live connection and shows the connection dot in the header.

On a shared multi-user machine set `AIDLC_REVIEW_STRICT=1` before starting the
harness. The bare address then never opens; gates, `--status`, and `--doctor`
print single-use links instead:

```text
**Browser:** http://localhost:4765/open/0123456789abcdef0123456789abcdef
```

A link under `/open/` is a single-use capability and expires after 30 minutes.
Opening it exchanges the nonce for an `HttpOnly` browser cookie; the daemon's
long-lived token is never printed. Run `/aidlc --status` whenever you need a
fresh one.

Every gated stage reviews in the browser, including Reverse Engineering, whose
knowledge base lives in the space-level `aidlc/spaces/<space>/codekb/<repo>/`
rather than the intent record: its artifacts list, render, take remarks, and
decide exactly like a record stage. The document header names the stage's lead
persona (Developer Agent, Product Agent, …) as the author of each revision.
Plan Approval in Code Generation is the one human checkpoint that stays in the
terminal; the browser shows the plan for reading only.

### Find your place

The left rail has **Inbox**, **Workflow**, and **Search**. **Workflow** opens or
hides the workflow panel; `⌘\` does the same. The panel starts with the active
intent selector. Its popover groups the workspace's intents under **Needs
you**, **In progress**, and **Done**, and shows the active scope, depth, phase,
and stage count.

The stage tree is grouped by phase. A stage row opens its overview; expanding
the row reveals **Questions** and the produced artifacts — the files you act
on. The stage's diary (`memory.md`, the agent's own interpretations, deviations,
trade-offs, and open questions, which the approval gate offers back as candidate
learnings) is a folded **Diary** section at the foot of the stage overview, read
on demand; it is not a row. Current stages open by default, done stages stay folded, phase headings
fold a whole phase, and **Collapse all** / **Expand all** folds or opens the
tree. Skipped stages name the reason and show that nothing was produced;
upcoming stages say what they will ask and produce. The footer holds **All
files** — the files you review or answer, grouped by stage: each stage's
questions and produced artifacts, every row opening the same view the tree
does. The stage diary (folded on the stage overview) and
engine bookkeeping (graph caches, tokens, the explainer rendered inside
Questions) are not listed, and neither is the audit ledger, which stays in the
terminal record and is never served. What the agent is doing is stated once, in
the header. Use the rail's Workflow icon to hide the panel for a wider document
view.

The header keeps the current workspace, intent, phase, and stage path beside a
file-name dropdown. The dropdown switches among the stage's questions,
artifacts, and overview even when the workflow panel is hidden. A short
state label (*4 questions for you*, *Awaiting your review · r1*, *Answered*,
*Done · 11:15*) says where the stage stands; the dot reports the daemon
connection. On an artifact, **Threads · History · Outline** select the one
right-hand panel. At a live gate the same header carries **Request changes** and
**Approve**.

The workflow panel is a browser projection of `aidlc-state.md`, the compiled
stage graph, the audit ledger, and stage files. In the terminal, `/aidlc
--status`, the ordinary gate, and the files under the active intent provide the
same navigation and authority.

### Read, comment, and suggest

Markdown is a reading surface with one bubble per commented line in the left
gutter, showing how many threads sit on that line. Clicking a
bubble focuses its threads. Select text — with the mouse or with Shift and the
arrow keys — and a speech-bubble button appears beside that line; choose it to
open a dashed pending card in **Threads**. The card's kind selector is **Comment · Suggestion
· Delete · Looks good**. Add the remark and choose **Post**; the pending card
remains editable or removable and persists in that browser tab's session
storage. It is not sent yet.

There is no separate editing mode. At a live Markdown gate every paragraph,
heading, list, and table is editable in place: click into it and type. The
first keystroke switches that block to its Markdown source, in the reading
face with the markers (`**`, `-`, `|`, `##`) shown in muted type, and the caret
stays on the word you clicked. Nothing changes on focus alone, so selecting
text to comment never disturbs the document. While a block is being edited the
formatting row above the document is live — **Paragraph ▾**, bold, italic,
strike, code, lists, quote, link, table, and diagram insert Markdown syntax at
the caret — and it reads *Editing FR2 · a suggestion — the file is untouched
until you decide*. Highlight text and press Delete to remove it, or type to
replace it. **Undo and redo** (↶ ↷ at the left of the formatting row, `⌘Z` /
`⇧⌘Z`) work as in any document editor: while you are typing they step through your
keystrokes (toolbar actions included); once you have clicked away they take
back whole suggestions, most recent first, and bring them back again. The
*Undo* on a suggestion's pill and *Undo edit* on its card feed the same stack.
`Esc` abandons the typing in progress without touching an earlier suggestion
on that block.

Clicking elsewhere finishes the edit, and the document shows it **as tracked
changes in place**: the block re-renders with your new text, inserted words
highlighted and removed words struck through, a pencil in the gutter, and a
pill beneath it — *Your edit · not sent yet · Undo*. Clicking back into the
block edits the suggested text, so successive edits compose; typing it back to
the file's text withdraws the suggestion. The Threads card for an edit is an
index entry (*Suggested edit · Functional requirements · +6 words −1 word ·
"…"*, with **Undo edit**; clicking the card scrolls the document to the
change), not a second copy of the change. After you send, the block keeps showing your change in a muted style
(*Your edit · sent in r1 · awaiting the agent*) until the agent's revision
replaces the file. Browser suggestions become `edit` remarks in
`feedback-NNN.md`; the terminal equivalent is to describe the exact change in
your **Request Changes** gate feedback.

Authored HTML remains read-only in a sandbox. Selecting text or Alt-clicking a
point opens the same pending **Comment** card, anchored by the bridge's selected
text, heading path, and optional element path.

### Decide

Nothing you write in the browser reaches the agent until you send, and the
header's verbs say what sending does. With no pending edits or comments the
buttons are **Request changes** and **Approve**. As soon as you have a pending
edit, delete, or comment, the primary button becomes **Send N changes — the
agent revises**: the agent applies your edits to the file, replies to each
remark, and reopens the gate. **Approve anyway** stays available, but its
confirmation warns that approving does *not* apply your edits — the file stays
as it is and they are recorded as notes — and offers **Send N changes instead**.
Looks-good remarks and a general note ride along with either decision. Both
paths confirm in the Threads rail before anything is written, because the Stop
hook applies a decision the moment it lands. Under the hood, both write any
pending annotations and note to the next `feedback-NNN.md` and the decision to
the next `decision-NNN.json`. Once sent, the header reads **Approved ·
rN** or **Changes requested · rN** and the document locks until the daemon
reports the next state — **Revising · rN** while the agent addresses your
remarks, then **Awaiting your review · rN+1** when the gate reopens on the
artifact your threads are on.

A browser decision is an append-only pre-answer to the ordinary gate, not a
second state machine: the
Stop hook resumes the held conductor turn and supplies the matching
`aidlc-orchestrate.ts report --result approved|rejected` command. `report`
performs the transition and records both inputs as consumed.

The terminal path is identical and remains available: answer **Approve** or
**Request Changes** at the existing gate. `report` ingests any pending browser
feedback with that decision; if no browser files exist, your terminal feedback
is the complete input. A fresh terminal prompt releases a browser gate hold,
and a timeout falls back to the ordinary terminal wait.

On **Request changes**, the agent receives the feedback body as part of the gate
reason and revises the artifact. On **Approve**, feedback is carried forward as
non-blocking approval notes. Either path emits `REVIEW_UI_FEEDBACK` when there
was browser feedback, and the decision receipt is consumed as
`decision-applied`.

### Threads, replies, history, and outline

**Threads** shows the thread count, **Show resolved**, sorting by **In document
order** or **Recent**, and an optional general note. Pending, open, addressed,
and resolved cards carry their quote, kind, body or diff, and status. Clicking a
gutter bubble focuses its card; clicking a card scrolls to and flashes its mark.
A sent thread offers **Reply** — a nested pending comment on the same passage,
recorded in the next `feedback-NNN.md` as `### Comment · a9 · reply to a7` so the
agent answers it as part of that thread — and **Resolve**, a reviewer-side
receipt kept in the browser tab (hidden by **Show resolved**; **Reopen** undoes
it). Resolving never writes to the record.

After a revision, the agent's completion message includes **Feedback
addressed**. The agent also records the same per-remark dispositions in
`responses-NNN.md`; the browser joins them to stable remark ids and renders
replies such as **Applied**, **Kept**, or **Answered**, with statuses such as
**Addressed in r1**. The terminal message and record file are authoritative;
the browser is their projection.

**History** is the record timeline: saved revisions, feedback, answers,
decisions, and responses appear newest first. Its **Compare** control opens a
saved revision, and **Diff** shows what changed between the earlier snapshot
and the current file *inline*: each changed block gets an accent bar and an
`r0 → r1` panel beneath it with the old text struck through and the new text
highlighted, and the rail lists the changes so you can jump to each one
(**Hide changes** restores the plain view). The equivalent terminal evidence is
the numbered files and snapshots under the stage's `.review-ui/` directory.

**Outline** lists the Markdown headings and pending-thread counts by section.
Choose a heading to jump to it. It is derived from the same server-rendered
Markdown blocks; the Markdown file remains the terminal source of truth.

### Stage overview and completed stages

Choose a stage name for its overview: **Asks first**, **Will produce**, **Builds
on**, and **Then** explain its place in the compiled workflow. When a question
round is live, the primary action opens it; when an artifact exists, the action
opens that file.

You can also expand a done stage and open its questions or artifacts. Completed
artifacts show a read-only banner; their empty Threads panel explains that the
live review is elsewhere, and the primary action returns to the current stage.
Answered questions retain the same explainer-and-answer layout with the chosen
options locked. A completed round is not reopened; to change a decision it
produced, ask for it at the stage's approval gate with **Request changes** (or,
before generation, at the consolidated-summary confirmation). The browser never
rewrites the canonical questions file.

### Start an intent from the browser

The box above the Inbox starts a new intent. Choose the **Workspace** (the
space it lives in; **New workspace…** creates one), describe what you want to
build, pick a **Workflow** — a named scope, or *Adaptive*, which
proposes one from your words and asks once — and, with a runner, the
**Effort** (see below). **Start** (or ⌘↵) starts it.

With the harness's CLI installed, Start does the whole thing: the daemon creates
the record (the same `intent-create` the conductor runs, with the chosen
workflow) and launches the
harness's own agent, bound to that intent, prompting it with the words you would
have typed. You never touch a terminal. With *Adaptive*, Start
first shows what the composer would pick from your words (or the default
workflow) and starts on your confirm. The tab opens the intent with the **Agent**
panel beside it.

Every harness the framework ships to speaks the Agent Client Protocol, so the
daemon drives each one the same way:

| Harness | Agent the daemon launches | Needs on this machine | First prompt |
|---|---|---|---|
| Claude Code | `claude-agent-acp` (Zed's adapter over the Agent SDK; fetched with `bunx` on first use) | `claude` | `/aidlc` |
| Kiro CLI, Kiro IDE | `kiro-cli acp --agent aidlc` | `kiro-cli` | `/aidlc` |
| Codex CLI | `codex-acp` (bundles Codex; fetched with `bunx`) | a Codex login (`~/.codex`) or `codex` | `$aidlc` |
| Cursor | `agent acp` | the Cursor CLI (`agent` / `cursor-agent`) | `/aidlc` |
| opencode | `opencode acp` | `opencode` | `/aidlc` |
| GitHub Copilot | `copilot --acp` (public preview) | `copilot` | `/aidlc` |

`AIDLC_ACP_<HARNESS>_COMMAND` (for example `AIDLC_ACP_KIRO_COMMAND`) replaces the
launch command line — a pinned version, extra flags.

**Hosts without a package registry.** The Claude and Codex agents are published
adapters that `bunx` fetches on first use. Once, on a machine with registry
access, run

```bash
aidlc ui vendor-agent
```

It installs the pinned adapter (without the bundled agent binaries, which the
runner never uses — about 50 MB) under `<harnessDir>/tools/vendor/acp/`, and the
runner prefers that copy from then on. The directory is part of the install (the
shipped `.gitignore` re-includes it), so copying or committing the tree carries it
to hosts that cannot reach a registry. The other harnesses' agents are their own
CLIs; there is nothing to vendor.

**Effort.** The Effort menu has one dial: the effort the agent session runs at
(the same thing `/effort` sets in a terminal; Kiro's `--effort`). The conductor
thinks at that level, and so does every agent that inherits the session.
*Default (level)* leaves it to your own settings and names what that is — the
`effortLevel` your Claude settings resolve to, or Kiro's `cli.json` model
default. Codex,
Cursor, opencode, and Copilot expose no such dial over ACP; the control is hidden
there.

Which effort each *agent* runs at is not a per-intent choice. It is the project's
model policy — `aidlc config models` (a preset, per-group dials for Deciding /
Reviewing / Writing up, or per-agent exceptions), committed with the project and
shared by every intent. A pin is never capped by the session's effort, and the
session's effort never moves a pin: they are two separate controls. Settings
shows that policy — each group with its agents and effort (*inherits the
session* when nothing pins it), any exceptions — so what you see there is what
the run will use.

### Settings

The cog at the bottom of the left rail opens Settings. **Models & effort** reads
top to bottom: the **default effort** — your own harness setting, what *inherit*
means; on Claude the browser edits it in place (`effortLevel` in
`.claude/settings.local.json`, the same value `/effort` sets), elsewhere it names
the file — the **preset**, then each **group**
of agents — the select names what applies without a dial of its own (*Inherit
from default*, *Preset thorough (xhigh)*, *Shipped default (medium)*) or the
level you pin — and the **exceptions** — one agent pinned to its
own effort or model (*Add…*). Every change is applied immediately through the
same `aidlc config models` command the terminal uses, so the transaction,
refresh guard, and doctor checks are identical, and it applies to runs started
afterwards. The browser edits the **team's** policy — the committed
`aidlc.settings.json` and agent files (commit them); a personal override for
your machine is a terminal move (`aidlc config models … --local`), and when one
exists the page says what it pins and greys out those groups. **Reset** clears
the team's layer. There is no per-dial undo:
`config models` has no unset and `--reset` cannot be combined with other flags,
so removing one dial would mean reset-then-replay across processes, which is not
atomic for your settings; the browser offers the no-dial option only while it is
true, and Reset otherwise. **About** lists this review UI's version,
address, and runner.

**Several intents at once.** Each run is bound to its own intent (the
SessionStart hook binds the agent's session), so you can Start a second intent
while the first is working, and every read and write in the tab — questions,
feedback, decisions — targets the intent you are viewing. A harness whose session
does not bind (Codex through its adapter, whose hooks do not fire) holds the
project: Start is refused until that run ends.

**When the agent just stops.** If a turn ends mid-stage with nothing open for you
— no question round, no gate — the daemon sends the resume prompt itself, up to
twice; then it parks and the panel says so. This is the terminal's forwarding
loop (the Stop hook) done daemon-side, for harnesses whose hooks do not fire
under their ACP agent.

### The Agent panel

The panel (the flow icon in the header; also from ⌘K) follows the intent's run:

- **State** — *Agent working* with a spinner, *Waiting for you* when it needs an
  answer, *Agent stopped* when a turn ended, *Run ended* / *Run failed*.
- **Questions** — everything the agent would have asked in the terminal arrives
  here as a card: Plan Approval in Code Generation, the learnings prompt at a
  gate, clarifying questions, the compose offer. Pick an option or type your
  own answer; **Skip** leaves it unanswered. The header badge counts what is
  waiting, and the panel opens itself when something arrives. On Claude these
  are the `AskUserQuestion` widget; on Cursor its own question and plan
  requests. A harness that asks in prose (Kiro, Codex, opencode, Copilot) ends
  its turn instead — the question is the last thing in the log, and the
  **Reply** box at the foot of the panel sends your answer as the next prompt.
- **Permissions** — a tool call the harness's own allow rules do not settle
  waits here with the tool's input (the command, the path) and the agent's
  options: *Allow*, *Always allow*, *Deny*. Everything the install's
  `settings.json` already allows runs without asking, exactly as in a terminal.
- **Log** — what the agent said, the tools it ran, when each turn started and
  stopped.
- **Continue** sends the harness's resume prompt (`/aidlc`, `$aidlc` on Codex)
  to a stopped session; **Reply** sends whatever you type; **Stop** cancels the
  turn. A daemon restart re-attaches the run to the same session.

Question rounds and approval gates work as before — the Questions form and
**Approve** / **Request changes** in the header — and the agent resumes on its
own after you save or decide: on Claude the Stop hook holds the turn for you;
elsewhere the turn ends and the daemon sends the continuation itself, opening
the question round for you when the agent left it prepared. The terminal remains
a full equivalent: open the harness in the same project and `/aidlc` shows the
same record. Set `AIDLC_REVIEW_RUNNER=0` to turn the runner off.

Without a runner (the harness's CLI is not on this machine, or the runner is
turned off), Start records the request instead. It appears in the Inbox under
**Requested** with *Waiting · type `/aidlc` in the terminal*; the next bare
`/aidlc` in a session with no active workflow picks the oldest request up exactly
as if you had typed its words there, and a request with *Adaptive*
goes through the same inference and compose asks a typed description would. The
**×** on a requested row withdraws it. Requests are kept per workspace in
`aidlc/spaces/<space>/intents/pending-intents.json` (gitignored).

### Inbox and search

**Inbox** groups every intent in the workspace by what is requested, what needs
you, what is in progress, and what is done. Choosing an intent opens its current
item. The terminal equivalent is `/aidlc intent` plus `/aidlc --status` for the
selected intent.

Choose the rail's **Search or jump · ⌘K** control or press `⌘K` to search
intents, stages, files, and actions.

The palette can also hide or show **Workflow** and open **Threads** or
**History**. It navigates only; it does not mutate workflow state.

## Answer questions in the browser

A question round reaches the browser only once its `*-questions-guide.html`
explainer exists and passes its check. Until then the round is **preparing**:
the Questions view shows a spinner ("the agent is writing the explainer and its
recommendations"), the header reads **Preparing your questions**, the stage row
says *preparing* instead of *N open*, nothing counts as needing you, and there
is no form and no **Save** - a submission before the terminal is holding for it
would have nowhere to go. When the explainer passes, the workflow panel selects
**Questions** and the header shows **Save**; the tab updates on its own. Each question appears in one reading column: its agent-authored
explainer — **Why now**, optional figure, trade-offs, **Recommendation**, and
**Related decisions** — is immediately above its answer card. The recommended
option is preselected and marked **Recommended**; multi-select, **Other** with
**Describe your answer** (choosing it puts the caret in the field — just type),
and an optional **Note for the agent** follow the question file's schema.
Inline `code`, **bold**, and _italic_ in option and explainer text render as
such. Your draft answers survive a reload of the tab until you save.

The browser never edits `*-questions.md`. **Save** writes `answers-NNN.json` against the questions-file digest; the header then
reads **Answers sent** and the form locks while the agent applies them. If the
file changed while the form was open, the save is refused with **Questions
changed — reload**. On Claude Code the Stop hook holds the conductor's turn until the file
lands; other harnesses can use `aidlc-log.ts answers-wait`. The conductor then
runs `answers-apply`, the only browser path that writes `[Answer]:` and optional
`[Note]:` lines into the canonical questions file. The terminal equivalents are
**Guide Me**, **Edit File**, or **Chat**, all of which converge on that file.

After apply, the answered view keeps each explainer visible and locks the chosen
option with **Chosen · recommended** or **Chosen** and an **Answered** line. The
header can open the stage artifact; changing an answer starts from **Reopen
round (terminal)**. The consolidated-summary confirmation still happens in the
terminal.

### Guide me in the browser

With `AIDLC_REVIEW_UI=1` and the daemon alive, the browser is the mode — the
agent does not ask how you want to answer. It writes `<slug>-questions-guide.html`
and tells you the questions are waiting in the browser; the daemon waits until
the guide passes its checks before exposing the round, so an unfinished
explainer is never shown. The round stays in the browser for its follow-ups
(a contradiction to resolve, an ambiguity to probe): each is appended to the
questions file and the guide, and the agent ends its turn again for your save.
To answer in the terminal instead, say so there — the agent continues as
**Guide me** and does not switch back on its own.

Saving writes only the append-only answer submission described above. Without
the daemon or guide, the agent offers the terminal modes and you continue
normally.

## HTML stage artifacts

Review UI can display Markdown and HTML regardless of how an intent was created.
To ask AI-DLC to author eligible stage artifacts as HTML, set the following
**before creating the intent**:

```bash
export AIDLC_HTML_ARTIFACTS=1
```

Intent creation records `HTML Artifacts: on` in `aidlc-state.md`. That state is
a locked per-intent setting: later sessions follow it even when the environment
variable is absent. Pre-existing intents without the field read as `off`.

In this release, only artifacts classified as `document` or `visual` and
produced during **Ideation** or **Inception** are HTML-capable. Questions files,
traceability and other tool-parsed files, configuration, evidence, and every
other `machine` artifact remain in their native format. Construction, Operation,
Initialization, and Reverse Engineering outputs remain Markdown or their
existing machine format.

The current HTML-capable set is: `accessibility-checklist`, `bolt-plan`, `build-vs-buy`, `competitive-analysis`, `components`, `constraint-register`, `contract-summary`, `decision-log`, `decisions`, `design-system-mapping`, `external-dependency-map`, `feasibility-assessment`, `initiative-brief`, `intent-backlog`, `intent-statement`, `interaction-spec`, `market-trends`, `mob-composition`, `mockups`, `personas`, `raid-log`, `requirements`, `risk-and-sequencing-rationale`, `scope-document`, `skill-matrix`, `stakeholder-map`, `stories`, `team-allocation`, `team-assessment`, `unit-of-work-story-map`, `user-flow`, `user-stories-assessment`, and `wireframes`. The compiled stage graph is authoritative; an artifact appears as HTML only when its producing stage also runs in an eligible phase and has not excluded it.

Before authoring or review begins, you may change the active intent explicitly:

```text
/aidlc --html-artifacts on
/aidlc --html-artifacts off
```

AI-DLC refuses the change after any HTML-capable artifact for that intent exists
in either `.md` or `.html` form, or while any stage is awaiting approval (`[?]`)
or revising (`[R]`). It names the blocking files or stages. There is no implicit
converter and no extension fallback.

HTML authoring and the optional questions explainer can use more model input and
output tokens than concise Markdown. The local daemon, rendering, annotations,
diffs, and exports do not make model calls.

## Remote and SSH sessions

The supported deployment uses the default loopback bind. Keep
`AIDLC_REVIEW_HOST` on a loopback address and use SSH port forwarding rather
than binding the review UI to a LAN interface. A fixed port makes the tunnel
predictable, and disabling auto-open avoids trying to launch a browser on the
remote host:

```bash
# On the remote host, before starting the harness
export AIDLC_REVIEW_UI=1
export AIDLC_REVIEW_HOST=127.0.0.1
export AIDLC_REVIEW_PORT=4765
export AIDLC_REVIEW_OPEN=0

# On your workstation
ssh -L 4765:127.0.0.1:4765 user@remote-host
```

Use the single-use link printed at the remote gate in your local browser. With
`AIDLC_REVIEW_PORT` unset the daemon listens on **4765** when that port is free
(a second project's daemon takes 4766, and so on up to 4774, before falling back
to an ephemeral port), so the address is the same from one session to the next;
`/aidlc --status` and `/aidlc --doctor` always print the one in use. Set
`AIDLC_REVIEW_PORT=<n>` to pin a port exactly, or `0` to force an ephemeral one.
The daemon always listens on localhost; `AIDLC_REVIEW_HOST=<address>` makes it
listen on that address **too** (same port, same session cookie) — for a browser
on another machine on a trusted network — and `--status` / `--doctor` list it
as *also listening*. `0.0.0.0` binds every interface. Anything beyond loopback
exposes the review daemon to that network; prefer the SSH tunnel above when you
can. Set `AIDLC_REVIEW_OPEN=0` for any environment where automatic browser
launch is undesirable.

## Privacy and security

- The default server bind is loopback; there is no hosted service or supported
  LAN sharing mode.
- Printed strict-mode links contain a random, single-use, 30-minute nonce. The
  bearer token stays in an owner-readable `server.json` file and an `HttpOnly`,
  `SameSite=Strict` cookie.
- Project paths are confined beneath the selected intent's record in the
  project's `aidlc/` tree, reject `..` and symlink escapes, and do not expose
  workflow state, audit shards, or dot-directories as reviewable files.
- Markdown is split into blocks, rendered and sanitized on the server, and then
  inlined into the Review UI's document surface. The app receives the source as
  well so it can record suggestions, but the browser never writes the artifact.
- Authored HTML artifacts are not inlined into the privileged app document.
  They remain inside a sandboxed iframe with a restrictive Content Security
  Policy; they cannot fetch network resources, embed browsing contexts, or
  submit forms. The parent accepts bridge messages only from the current frame.
- Daemon discovery, logs, and nonces live under `~/.aidlc/review-ui/` (or
  `AIDLC_REVIEW_HOME`). Project directories there are owner-only (`0700`), and
  token and nonce files are owner-readable only (`0600`). Record-side manifests,
  snapshots, feedback, answers, decisions, responses, and consumed receipts
  live under the active intent's `.review-ui/` directories.

For environment-variable details and implementation schemas, see
[Review UI and HTML Artifacts](../reference/19-review-ui-and-html-artifacts.md).
