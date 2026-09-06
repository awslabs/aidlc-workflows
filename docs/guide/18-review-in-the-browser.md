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
idle timeout. If your harness
does not run the session-start hook, start it directly from the project root:

```bash
bun <harnessDir>/tools/aidlc-review-ui.ts serve --project-dir "$PWD"
```

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
the row reveals **Questions**, produced artifacts, and the stage memory when
present. Current stages open by default, done stages stay folded, phase headings
fold a whole phase, and **Collapse all** / **Expand all** folds or opens the
tree. Skipped stages name the reason and show that nothing was produced;
upcoming stages say what they will ask and produce. The footer shows the agent
state read from the record (*Agent working*, *Agent waiting for you*, *Agent
revising*, *Workflow complete*), an **All files** list of the intent's
reviewable files, and a note pointing at the audit ledger, which stays in the
terminal record and is never served. Use the rail's Workflow icon to hide the
panel for a wider document view.

The header keeps the current workspace, intent, phase, and stage path beside a
file-name dropdown. The dropdown switches among the stage's questions,
artifacts, memory, and overview even when the workflow panel is hidden. The
state sentence explains why the item needs you; the dot reports the daemon
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
"…"*, with **Show in document** and **Undo edit**), not a second copy of the
change. After you send, the block keeps showing your change in a muted style
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
options locked. To change a completed round, use **Reopen round (terminal)**;
the browser never rewrites its canonical questions file.

### Inbox and search

**Inbox** groups every intent in the workspace by what needs you, what is in
progress, and what is done. Choosing an intent opens its current item. The
terminal equivalent is `/aidlc intent` plus `/aidlc --status` for the selected
intent.

Choose the rail's **Search or jump · ⌘K** control or press `⌘K` to search
intents, stages, files, and actions.

The palette can also hide or show **Workflow** and open **Threads** or
**History**. It navigates only; it does not mutate workflow state.

## Answer questions in the browser

When the current stage publishes a valid `*-questions-guide.html`, the workflow
panel selects **Questions** and the header shows **Save answers — the agent
continues**. Each question appears in one reading column: its agent-authored
explainer — **Why now**, optional figure, trade-offs, **Recommendation**, and
**Related decisions** — is immediately above its answer card. The recommended
option is preselected and marked **Recommended**; multi-select, **Other** with
**Describe your answer** (choosing it puts the caret in the field — just type),
and an optional **Note for the agent** follow the question file's schema.
Inline `code`, **bold**, and _italic_ in option and explainer text render as
such. Your draft answers survive a reload of the tab until you save.

The browser never edits `*-questions.md`. **Save answers — the agent continues**
writes `answers-NNN.json` against the questions-file digest; the header then
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
