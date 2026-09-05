# RFC: Review UI redesign — a document you review, not a form you fill

Status: proposal · Consolidated design: [`review-ui-redesign/mock-v10.html`](review-ui-redesign/mock-v10.html) (ten screens in journey order, toggle bottom-centre; every element audited in the table below) · Minimal reference: [`review-ui-redesign/mock-v3.html`](review-ui-redesign/mock-v3.html) · Exploration mocks: [`review-ui-redesign/mock.html`](review-ui-redesign/mock.html) (icon rail; **review** / **suggest edit** / **questions**; click **Edit** in the menu bar for a menu) · [`review-ui-redesign/mock-v2.html`](review-ui-redesign/mock-v2.html) (workflow sidebar with intents, stages, artifacts, record; **review** / **questions**)

## Ten variations (gallery)

[`review-ui-redesign/variations/index.html`](review-ui-redesign/variations/index.html)
collects ten alternative experiences built on the same content (the to-do app
requirements at r1, the four threads, the four questions with the full Q1
explainer, FR2 in suggest-edit mode) so only the experience differs. Each mock
opens with a hypothesis comment and shows its own states plus `questions` and
`editing`.

| # | Variation | Hypothesis | Best for |
|---|---|---|---|
| v05 | Reader | Nothing on screen but the document; everything else summoned by a keystroke (`⌘K` palette, `⌘.` comments) | One reviewer, one artifact |
| v06 | Timeline | Review is a story in time — a chronological ledger of writes, remarks, replies, decisions | Returning to a revised gate |
| v07 | Diff-first | After r0, start from what changed and what happened to each remark | r1+ re-review |
| v08 | Guided | One section / thread / question per card with Next; a summary before the decision | Completeness on short artifacts |
| v09 | Workbench | IDE-dense: tabs, explorer, comments pane, drawer, status bar | Power users all day |
| v10 | Inbox | The unit is “a thing that needs me” across intents, not a document | Leads running several intents |
| v11 | Margin notes | Comments float beside their line; no comments panel | Linear review of anchored replies |
| v12 | Conversation | Talk to the agent about the document; quotes are messages | Discussion-heavy reviews |
| v13 | Paper | A printed draft: serif sheet, highlighter, pen, stamps | Long documents read end-to-end |
| v14 | Mobile companion | Read, comment, answer, approve from a phone in the gap between gates | Away from the desk |

Working lineage after the gallery: `mock-v5.html` — v10 Inbox taken forward. The review screen has **no edit mode**: FR2 is being edited in place (markers visible in the active block, tracked change inline, contextual formatting row, pending suggestion card whose reason is the former comment). The question round is a single reading column where each question's explainer (Why now, a diagram, trade-offs with the recommended row tinted, Recommendation, Related decisions linking earlier answers) sits **above** its answer card.

`mock-v6.html` — v5 plus the **workflow sidebar** that replaces the inbox list
(the inbox becomes a tab beside it, badge intact). Top: two selectors,
**Workspace** (`default ▾`) and **Intent** (`260904-todo-app ▾` with `express ·
Minimal · Inception · 2 / 7 stages`); the intent popover groups the workspace's
intents into *Needs you* / *In progress* / *Done* with each one's stage and a
status word, plus *New intent…*. Below: every stage, grouped by phase with
per-phase counts, as a disclosure row (status glyph · name · status word and
time) whose children are that stage's **Questions** (answered count or an
`N open` pill) and **artifacts** (filename · revision · thread count; memory
diary), the open one marked with an accent bar. Done stages are collapsed to
one line; the current stage is open; skipped stages say why and show nothing
produced; upcoming stages say what they will ask and produce; conditional
stages read *if deploying*. In a question round the same tree shows
*Questions · 4 open* selected and *requirements.md · written after your
answers*, so the sidebar always tells you where the stage is. Footer: agent
state, *All files*, *Audit log*. Screens: review, intent switcher, questions,
collapsed.

`mock-v7.html` — v6 made navigable, and the product is now titled **AI-DLC
Workflows** (top-left). Every stage row has a chevron; every phase header is a
toggle that folds its stages to one summary line (*Inception · 1 skipped · 1 in
review · 0 / 1*); a `Stages · 7 · 3 done` bar offers **Collapse all / Expand
all**; `‹` still folds the whole sidebar. Clicking a stage's child opens it in
the middle, whatever the stage's state: the *past artifact* screen shows
Workspace Detection's `workspace-report.md` read-only with a banner (*Done stage
· no gate · comments become notes on the record*), an empty threads column that
says why, and a footer that leads back to the current stage; the *answered
questions* screen shows the Requirements Analysis round after saving with the
**same layout and the same reasoning on screen** as the live round — Why now,
diagram, trade-offs, recommendation, related decisions — so anyone can see why
each decision was made; only the answers differ: the chosen option tinted green
with *Chosen · recommended*, an *Answered · on the recommendation · 09:31* line,
no note field, and an action bar that offers *Reopen round (terminal)* and
*Open requirements.md →*. Screens: review, intent
switcher, questions, answered questions, past artifact, all collapsed,
collapsed.

**The stage tree is scope-driven, not a fixed list.** v7's *classic scope*
screen renders the same sidebar component for `260903-billing-api` (scope
`classic`, depth `Standard`): Ideation collapses to one greyed line (*not in
classic scope · 7 skipped*), Inception lists all nine stages with four done
and Domain Design in its question round, Construction and Operation list their
conditional stages with the condition that activates them (*if NFRs*, *per
unit*, *if deploying*). Data contract for the sidebar, all of it already on
disk and already watched by the daemon:

| Sidebar element | Source |
|---|---|
| Workspace / intent selectors | `aidlc/spaces/<space>/intents/intents.json`, `active-intent`, `active-space` |
| Scope, depth, phase, `N / M stages` | `aidlc-state.md` header (`Scope`, `Depth`, `Lifecycle Phase`) |
| Which stages exist and in what order; SKIP vs CONDITIONAL vs unconditional | the compiled `stage-graph.json` (per-scope grid from `aidlc-graph.ts compile`) |
| Each stage's state (done / current / skipped-with-reason / next / conditional) | `## Stage Progress` checklist + `Current Stage` in `aidlc-state.md`; skip reasons from the audit ledger (`STAGE_SKIPPED`) |
| Questions per stage and answered count | `<stage>/<slug>-questions.md` (parsed `[Answer]:` tags), `answers-NNN.json` receipts |
| Artifacts per stage, revision, thread count | the stage directory (`produces[]` from the graph names the expected files, so unwritten ones can be shown as placeholders), `.review-ui/` manifests and feedback files |
| Approval / decision per stage | audit ledger (`DECISION_RECORDED`, `STAGE_AWAITING_APPROVAL`) |

Clicking a stage *name* opens a **stage overview** page in the middle (shown
for Domain Design): what it asks first, what it will produce, what it builds
on (with those artifacts' approval state), and what comes next — with the
primary action being the live thing (*Answer 4 questions →*, or the gate).

`mock-v8.html` — **the consolidated design.** v7 with one consistency layer
over every screen, so the same anatomy carries the whole journey (the mock's
toggles are ordered as that journey: *pick intent → stage overview → answer →
answered → review → look back → folded → rail*):

- **Top bar**: brand *AI-DLC Workflows* · one global *Search or jump…* (`⌘K`)
  · Live. Nothing screen-specific lives here (the inbox filter moved into the
  Inbox tab).
- **Context bar** (62 px, every screen): breadcrumb `default › intent › phase ›
  **stage**` on the left, one status on the right — blue when it needs you
  (*Awaiting your review · r1*, *4 questions for you*), green when settled
  (*Done · 09:10*, *Answered · 09:31*) — with a one-line detail beneath. The
  scope/depth/phase chips are gone from here; they live once, in the intent
  selector.
- **View bar** (40 px, every middle view): the menus that apply · the file or
  view name (`requirements.md ▾`, `requirements-analysis-questions.md ▾`,
  `Domain Design · overview ▾`) · on the right a segment for revisions or round
  (`r0 | r1 | Diff`, `Round 1`, `r0`). The Markdown formatting row appears under
  it only while the caret is in a document.
- **Action bar** (54 px, every middle view): left a status summary in the same
  voice (*1 suggestion pending · 1 open · 2 settled*, *4 of 4 answered · all on
  the recommendation*, *4 questions ready*, *Done · 09:10 · nothing to decide*),
  right a secondary and a primary action. The primary is always the live next
  step: *Approve*, *Save answers — the agent continues*, *Answer 4 questions →*,
  *Open requirements.md →*, *Back to Requirements Analysis →*.
- **Right column** rule: a *Threads* column exists exactly when the middle is
  an artifact (live or past); question rounds and stage overviews take the full
  width.
- **Rail** (`‹`): the collapsed sidebar mirrors the stage tree — an intent
  monogram, then one dot per stage in phase groups (green done, dashed skipped,
  blue current with a bar, hollow next, faint conditional), each with a tooltip.
- **Sidebar**: unchanged structure, plus a three-item legend (● needs you ·
  ● done · ○ later) under the *Stages* bar; the question icon is neutral grey
  and only the accent says "needs you", so blue means one thing everywhere.
- **Vocabulary**: kinds are *Comment · Suggestion · Delete · Looks good*;
  statuses *Pending · Open · Addressed in rN · Resolved*; stage words *done ·
  in review · questions · next · skipped · if …*.

`mock-v9.html` — **v8 rebuilt on Bunsho's shell**, after a second look at
Bunsho at its real size (1728 px). What Bunsho does that v8 did not:

| Bunsho | v8 had | v9 does |
|---|---|---|
| A 53 px **app rail** of monochrome icons — logo, Search, Notifications; Contact/integrations/Settings at the bottom. App destinations only, no document state. | A rail of coloured stage dots | Rail = logo · Inbox (badge) · Workflow · Search · Notifications · … · Audit · Help · Settings · you. The workflow tree is a **panel** the Workflow icon toggles (screen *10 panel hidden*), never dots. |
| Header = document title + ☆, then right: *Connected*, access, collaborator avatars, panel icons (Comments · Edit with AI · Media · History · Attribution · View Raw), one primary (*Share*). | A brand bar + a context bar + a bottom action bar | One 52 px header per screen: small path + **file name** ☆ · state · *Connected* · avatars (PA, you) · panel icons (**Threads · History · Outline · Raw**) · the primary decision (*Approve* with *Request changes* beside it; *Save answers…*; *Answer 4 questions →*). No bottom action bars. |
| One right slot: Comments **or** Version History **or** Outline, swapped by the header icons | A fixed Threads column | Same: *Threads* (screen 5), *Version history* (6: r1 revised · your Request changes · r0 written · answers — with a Compare r0/r1/Diff control), *Outline* (7: the document's headings with thread counts). |
| Comments header: `Comments · 18 threads · ×`, a **Show resolved** switch, `Sort: Appearance / Recent`, `Style: Sidebar / Popover`, jump-to-top | Filter chips | Adopted verbatim, plus a dashed *1 pending · sends with your decision* line so the decision's whereabouts are explained where the pending work is. |
| Amber comment-count bubbles in the **left** margin | same | same |
| Menus `File Edit Format Insert View Doc Settings` then a full formatting toolbar incl. Insert Diagram / Math / HTML, block `⋮` options | menus + contextual toolbar | unchanged (toolbar still contextual to the caret) |

`mock-v10.html` — **v9 with every element audited.** Rule: an element stays
only if a named user, at a named moment, does a named thing with it, from data
we have. The review screen, element by element:

| Element | Who uses it, when, for what | Verdict |
|---|---|---|
| Rail · logo | Click → the inbox / home; identifies the app in a tab strip | keep |
| Rail · **Inbox** (badge) | A lead with several intents: "what needs me?" — gates, question rounds, sensor findings | keep |
| Rail · **Workflow** | Toggles the stage panel; the only way to get the document full-width | keep |
| Rail · **Search** `⌘K` | Jump to an intent, stage, or file without the tree | keep |
| Rail · Notifications | Would only re-list what Inbox already lists | **cut** |
| Rail · Audit log · Help · Settings · avatar | No accounts, no settings worth a rail slot; audit and shortcuts belong in the panel footer / Help menu | **cut** |
| Panel · Workspace selector | Almost everyone has one workspace; a whole control for a rare switch | **merged** into the intent popover (*Switch workspace · default · 1 other*) |
| Panel · **Intent selector** + popover | Switch intent; see which ones need you | keep |
| Panel · Stages bar (`7 · 3 done`) + Collapse/Expand all | Orientation; fold a long classic-scope tree | keep, one toggle button instead of two |
| Panel · legend | Three colours a first-time user reads once | **cut** (tooltips carry it) |
| Panel · phase headers, stage rows, chevrons | Where am I; open a stage; fold a phase | keep |
| Panel · Questions / artifacts under a stage | Open the round or the file; see counts and revision | keep |
| Panel · footer *Agent idle · All files · Audit log* | Live agent state; the two rare destinations, out of the way | keep |
| Header · path | Which workspace / intent / phase / stage; click to go up | keep |
| Header · **file name** | What you are looking at; the dropdown switches files when the panel is hidden | keep |
| Header · ☆ favourite | No favourites concept in the record | **cut** |
| Header · **state** (*Awaiting your review · r1* + counts) | Why this tab exists right now | keep |
| Header · *Connected* | Daemon reachable; the one thing that must be visible when it fails | keep, as a dot with a tooltip |
| Header · collaborator avatars | One human, one agent; the agent is named in the doc meta | **cut** |
| Header · **Threads · History · Outline** | Swap the right slot | keep |
| Header · Raw | Same as *View › Source* | **cut** |
| Header · **Request changes · Approve** | The decision | keep |
| Menus · File · Edit · View | Export / download / open in editor; undo / find; source / diff / panels | keep |
| Menus · Comment · Review | Comment duplicates selecting text; Review duplicates the two header buttons | **cut** |
| Toolbar (contextual) + *Editing FR2…* | Only while the caret is in the text; says what typing will do | keep |
| Doc meta · file name · questions answered | Header names the file; the panel counts the questions | **cut** |
| Doc meta · *Product Agent · revision 1 · revised 2 min ago* · *Type anywhere…* | Provenance and the one hint that explains no-modes | keep |
| Gutter bubbles ①–④ | Click → the thread; count per line | keep |
| Threads · title · count · × | Orientation; close the slot | keep |
| Threads · **Show resolved** | Hide settled threads during a re-review | keep |
| Threads · Sort *In document order / Recent* | Long reviews: newest replies first | keep |
| Threads · Style *Sidebar / Popover* · jump-to-top | Preference without a job yet | **cut** |
| Threads · *1 pending · sends with your decision* | Explains where the send is | keep |
| Thread cards · quote · author · kind · body · reply · status · actions | The review itself | keep |

Also in the folder: `mock.html` (v1, exploration), `mock-v2.html` (workflow
sidebar), `mock-v3.html` (minimal), `mock-v4.html` (v2 with the menu bar and
Markdown toolbar scoped to the document column, collapsible sidebar sections
and a collapse-to-rail; screens review / editing / questions).

## Recommended direction: v3, minimal

[`review-ui-redesign/mock-v3.html`](review-ui-redesign/mock-v3.html) is the
design I'd build. v1/v2 explored the full surface; v3 keeps only what a
reviewer needs in the moment, at Bunsho's register. Rules it follows:

- **One accent, one mark.** Blue for the single primary action; Bunsho's amber
  for a commented span. Kinds are words in the card (`Delete`, `Suggestion`),
  not colours in the page: a deletion is a strike-through, a suggestion a
  dotted underline, a looks-good a grey ✓ in the margin. No numbered coloured
  bubbles, no kind-coloured card bars, no chips, no badges, no progress bars.
- **Status is a sentence, not a pill.** Under the title: *Product Agent ·
  revised 2 min ago · waiting for your review*. In the menu row's right corner:
  *Revision 1 · Saved by the agent*. Nothing blinks.
- **The decision lives in the title row.** `3 comments to send · Request
  changes · [Approve]` — one filled button on the whole screen. No sticky
  decision bar over the text.
- **Comments are written where they are read.** Selecting text shows a single
  `+` in the margin; the draft opens as a dashed card in the comments column,
  aligned with the line, with a quiet `Comment ▾` kind selector and *Post*.
  Nothing is inserted into the document.
- **The outline is the workflow.** Left column, 240 px, plain text: intent name
  with a `▾`, `express · inception`, phases as small grey labels, stages as
  rows — grey (upcoming), ink with ✓ (done), bold with a blue dot (current),
  struck (skipped). The current stage's files hang under it as a tree
  (`requirements 4`, `questions 4 / 4`, `memory`). *All files* and *Audit log*
  are links at the bottom. Counts are the only numbers on the screen.
- **Questions are a document.** One column: title, one-sentence lead, each
  question as a heading with its options as a radio list, the recommendation
  pre-selected with the grey word *Recommended*, and the explainer folded
  under it as *› Why the web app* (the first one open). One `Save answers` in
  the title row and one at the end. No second column, no cards, no progress
  strip.
- **Menu bar, no toolbar.** `File Edit View Comment Review Help` in a quiet
  row; the Markdown formatting bar appears only when a block is in
  suggest-edit mode and disappears with it.

v1 (`mock.html`) remains useful for the suggest-edit interaction and the menu
contents; v2 (`mock-v2.html`) for the fuller workflow sidebar. Everything
below describes the shared model; where v3 differs, v3 wins.

## Why

The current review UI is a dashboard: header, three panels, a form, a drawer, a
floating four-button toolbar, and a "decision hint". It shows the machinery. The
person using it is doing one of two things — **answering a few questions** or
**reading a document and reacting to it** — and both are better served by the
shape every good document tool has converged on: a wide reading column, comments
anchored to the text, and one clear action. Bunsho (the internal Markdown
editor) is the reference: white page, 14–15 px system type, ~880 px measure,
amber comment highlights with margin bubbles, a quiet threads sidebar, a single
comment affordance on selection, and almost no chrome.

What is different from Bunsho: the author is an **agent**, the reader is a
**reviewer with a decision to make**, the document moves through **revisions**
in response to the comments, and the whole thing is a step in a workflow that
also asks **questions**. So the design is Bunsho's reading and commenting
model plus a review layer: comment kinds, revisions, agent replies, and a
decision.

## Invariant: the terminal is complete without the browser

The review UI is an optional mirror of a file-based protocol, and stays one.
Every state the browser can show must be reachable, readable, and answerable
from the terminal alone, with the same engine behaviour:

- Questions live in `<slug>-questions.md`; the browser form writes
  `answers-NNN.json` that `answers-apply` folds back into that file. A terminal
  user answers via **Guide me** / **I'll edit the file** / **Chat** and the file
  ends up identical. The explainer is optional reading, never the only place a
  recommendation exists: the always-recommend rule puts `(Recommended)` on the
  terminal option too.
- Review feedback lives in `feedback-NNN.md`, which `report --result
  rejected|approved` ingests. A terminal user gives the same feedback as gate
  prose. The engine cannot tell which door it came through.
- The decision is the terminal gate (`Approve` / `Request Changes`). Anything
  the browser adds must converge on the same `report` call; the terminal
  question is never removed, only optionally pre-answered.
- The agent's response to feedback must be in the **record**, not only in a
  browser payload: a revised gate's completion message lists how each remark
  was addressed, and the same list is what the browser renders as thread
  replies. One source, two renderings.
- No auto-open, no daemon, no `AIDLC_REVIEW_UI`: nothing in the workflow waits
  on, mentions, or degrades without the browser. Every "browser" branch in the
  protocol is guarded by `directive.review_ui` being present.

Design decisions below are checked against this list; where a phase adds an
engine capability it is specified as a record/protocol change first and a
browser rendering second.

## Principles

0. **Reviewing is editing.** No modes. Read, and when a sentence is wrong,
   change it; the change is a suggestion the agent answers. A selection is a
   comment; a keystroke is a suggestion; both are threads; the file is untouched
   until the decision.
1. **The document is the product.** Full-width reading column with Bunsho's
   type scale; every panel earns its pixels or collapses. No "No artifact
   available" — the zero state shows what the agent is doing right now.
2. **One act per moment.** The screen is in exactly one of three modes, driven
   by the workflow: *answer* (questions), *review* (document + comments),
   *wait* (agent working). The UI changes with the state; the human never
   hunts for the right panel.
3. **Comments are threads, anchored to text.** Not a toolbar of verbs. A
   comment has a quote, a kind, a body, and a life: pending → sent → agent
   replied → addressed → resolved.
4. **The agent is a participant.** Its revision shows up as a reply on each
   thread ("Kept the confirmation: …", "Applied in r1"), so the reviewer sees
   what happened to every remark instead of re-reading the whole document.
5. **Decide from evidence, at the bottom.** A sticky decision bar summarises
   open threads and offers **Request changes** / **Approve**, weighted by the
   evidence (open comments → request is primary; none → approve is primary).
6. **Nothing half-built reaches the human.** Already true for question rounds
   (readiness gate); the redesign keeps every intermediate state behind a
   status line, never in the content area.

## Layout

```
┌ title row 44px ────────────────────────────────────────────────────────┐
│ A  todo-app › Requirements Analysis  [● Awaiting your review · r1]      │
│                                        r0 | r1 | Diff   ⤓   ● Live      │
├ menu bar 28px ─────────────────────────────────────────────────────────┤
│ File  Edit  View  Comment  Review  Help        Markdown · saved by agent │
├ toolbar 40px ──────────────────────────────────────────────────────────┤
│ ↶ ↷ │ Paragraph ▾ │ B I S <> │ • 1. ☑ " │ 🔗 ▦ 🖼 ⧉ │ 💬 Comment   Mode ▸ │
├─ rail 56 ─┬─ document (max 860, centred, 88px side padding) ─┬ threads 320 ┐
│ Documents │ requirements.md · Product Agent · r1 · agent idle │ Comments  4 │
│ Questions │                                                    │ [Open 3]    │
│ Revisions │ # Requirements — To-Do Application                │ [Resolved]  │
│ Record    │ ...                                                │ ┌ card ───┐ │
│           │ ①  FR1 — … ‾‾looks-good highlight‾‾                │ │ quote   │ │
│           │ ②  FR2 — … ‾‾comment highlight‾‾  (+)              │ │ You r0  │ │
│           │      ┌ composer: Comment|Suggest edit|Delete|LG ┐  │ │ body    │ │
│           │      └ text… ─────────────── [Add comment] ┘  │ │ agent ↵ │ │
│           │ ③  FR3 — … ~~delete strike~~                        │ │ status  │ │
│           ├─ decision bar (sticky) ───────────────────────────┤ └─────────┘ │
│           │ 3 open · 1 edit   [Add note] [Request changes R] [Approve A] │
└───────────┴───────────────────────────────────────────────────┴─────────────┘
```

- **Top bar**: crumb `project › stage`, a live status pill (`Awaiting your
  review · r1`, `Agent writing requirements.md…`, `Preparing questions`,
  `4 questions for you`), revision segmented control (`r0 · r1 · Diff`),
  export, connection dot. The status pill *is* the agent status the daemon
  already knows; it replaces the "Current stage / Nothing is under review"
  sidebar block.
- **Rail** (icon-only, 56 px): Documents · Questions (badge) · Revisions ·
  Record. Expands on hover to labels. Replaces the left sidebar; the record
  tree becomes a drawer, not a permanent column.
- **Document**: Bunsho's measure and type — `#1a202c` on white, 15/1.65 body,
  h1 30/700, h2 20/700, system font stack, borders `#eef2f7`, panel `#f7f9fc`.
  Left gutter carries numbered **bubbles** coloured by kind (amber comment,
  violet suggested edit, rose delete, green looks-good). The highlight in the
  text uses the same kind colour: amber fill + 2 px underline for comments
  (Bunsho's exact treatment), violet for edits, strike-through for deletes,
  green underline for looks-good. Clicking a bubble or highlight focuses its
  thread; clicking a thread scrolls and pulses its highlight.
- **Menu bar + toolbar**: Bunsho's three chrome rows — title, `File Edit
  View Comment Review Help`, and the Markdown formatting toolbar with a
  **Mode** switch (Review · Suggest edits · Source). See *Chrome* below.
- **Selection → one affordance.** A `+` in the right margin of the selected
  line (Bunsho puts it left; ours sits right because the left gutter holds the
  bubbles) opens the inline composer. See *Adding a comment* and *Editing*.
- **Threads sidebar** (320 px, `#f7f9fc`): header with count and filter chips
  (Open · Resolved · Agent replies · r0). Cards: kind-coloured left bar, quoted
  anchor in italic grey (Bunsho), author/avatar/time, kind tag, body, **agent
  replies indented** with the agent avatar, and a status line — `Pending ·
  sends with your decision`, `Open`, `Addressed in r1`, `Resolved · kept in
  r1` — with `Reply` / `Resolve` / `View change`. Pending cards are dashed.
  Suggested edits render their diff inline in the card.
- **Decision bar** (sticky, bottom of the document column): `3 open comments ·
  1 suggested edit · 1 resolved` · `Add general note` · `Request changes` ·
  `Approve`. Primary emphasis follows the evidence. Sending posts pending
  threads plus the note as today's `feedback-NNN.md` with the chosen decision;
  the terminal gate ingests it exactly as now. In a later phase the conductor
  may pre-answer its gate question from that file when a browser decision is
  present — the terminal question stays, and stays authoritative, for anyone
  not using the browser.
- **Revisions**: `r0 · r1 · Diff` in the top bar. `Diff` renders word-level
  insertions/deletions **inside the document** (green/red inline) instead of a
  separate `<pre>` panel; threads from earlier revisions show "addressed in
  r1" and jump to the changed text.

### Chrome: title row, menu bar, toolbar

- **File** — Export self-contained HTML, Download Markdown, Copy link to this
  review, Show record folder (path only; the agent owns the file).
- **Edit** — Undo / Redo, Suggest edit to selection `E`, Suggest edits mode
  `⇧E`, View Markdown source `⇧S`, Find `⌘F`, Copy as Markdown. *Edit the file
  directly* is listed but disabled — "agent-owned". The browser never writes
  the artifact.
- **View** — r0 / r1 / Diff, Show resolved, Comments as sidebar or popover
  (Bunsho's Style switch), Reading width, Rendered / Source.
- **Comment** — Comment on selection `C`, Looks good `G`, Delete `D`, Add
  general note `N`, Next / previous thread `J` / `K`, Resolve `⌘↩`.
- **Review** — Approve `A`, Request changes `R`, Send pending comments, Reload.
- **Help** — Keyboard shortcuts `⌘/`, "What the agent sees" (comments become
  `feedback-NNN.md`; answers become `answers-NNN.json`).

The toolbar is the Markdown bar Bunsho users know: block type, bold / italic /
strike / code, bullet / numbered / task list, quote, link, table, image,
Mermaid, and a **Comment** button. In Review mode the formatting buttons are
inert; in Suggest-edits mode they act on the block under the caret by inserting
Markdown (`**`, `_`, `` ` ``, `- `, `1. `, `> `, `| |`). **Mode** on the right
is the single state switch: Review (read + comment) · Suggest edits (blocks
editable) · Source (raw Markdown, read-only, same anchors).

### Adding a comment — four doors, one composer

1. **Select text** → `+` in the right margin → click or `C` → composer opens
   *under the line*.
2. **Hover a paragraph** → faint `+` in the margin → whole-block comment, no
   precise selection needed.
3. **Toolbar Comment / Comment menu / `C`** with a selection active.
4. **Add general note** (decision bar, or `N`) — unanchored; today's
   `general_notes`.

Same composer everywhere: kind chips **Comment · Suggest edit · Delete · Looks
good** (Comment default; Delete and Looks good need no text), a body, **Add
comment** (`⌘↩`). Nothing is sent yet — the card appears in the sidebar as
*Pending · sends with your decision*, editable and removable, like a Bunsho
draft. Sending happens once, from the decision bar, into `feedback-NNN.md`.

Highlight ↔ card are linked both ways (click either; the other scrolls and
outlines); margin bubbles carry the thread count per line (Bunsho's `4`).
Cards read the Bunsho way — quoted anchor, who/when, body, replies indented —
plus our kind tag and status line.

### Editing the document — suggestions, in Markdown

**There is no edit mode. Reviewing is editing.** The document is always
editable: click into any paragraph and type. A change is recorded as a
*suggestion* — struck red / inserted green inline the moment you type, with a
pending card in the threads column — exactly as a selection becomes a comment.
Nothing is written to the file until you decide; on Request changes the
suggestions travel in `feedback-NNN.md` as `edit` annotations and the agent
applies or answers each. The earlier design's `Review · Suggest edits · Source`
switch is gone: a mode switch made people decide *how* they were going to
review before they had read anything, and it split one act into two screens.
Source (raw Markdown) remains as a read-only alternate view under **View**.

Consequences for the chrome: the Markdown formatting row appears under the
menu bar only while the caret is in the document (it names the block being
edited: *Editing FR2 · your change is a suggestion — the file is untouched
until you decide*), and disappears when you click out. The active block shows
its Markdown markers (`**`) in muted mono while the caret is in it, as Bunsho
does; other blocks render clean. A comment and an edit on the same span are one
thread: the comment text becomes the suggestion's reason.

Superseded detail kept for reference — how suggesting worked as a mode:


The artifact is Markdown and the agent owns the file, so browser editing is
**suggesting**: a diff the agent applies on Request changes. Three doors:

- Select text → **Suggest edit** chip or `E`: that block opens.
- **Suggest edits** mode (`⇧E`, toolbar Mode): every block editable; each
  changed block gets a violet bar and a pending card.
- A comment card's *Turn into edit*.

An editing block shows its **Markdown source with visible markers** as Bunsho
does — `**FR2 — Complete a task.**` renders bold while the `**` show in muted
mono — so users see and type Markdown, and the toolbar inserts it. Deletions
and insertions render red/green inside the block as you type (character diff
against the current revision), so the suggestion and its effect are one thing.
Leaving the block re-renders it; the card carries the diff plus an optional
reason; **Keep suggestion** / **Discard** sit under the block. On Request
changes the diffs go into `feedback-NNN.md` as `edit` annotations (today's
`original` / `replacement`), and the agent's revision applies or answers each.

### Questions mode

Same shell, two columns: **questions** (cards; the current one outlined in
accent) and the **explainer** as a proper reading column on the right, scrolled
to the focused question. Each option is a row; the recommended option is
pre-selected and carries a `Recommended` tag (from `data-aidlc-recommend`);
`Other → describe` expands inline; an optional note per question. The sticky
**save bar** shows a segmented progress strip (`4 of 4 answered · all on the
recommendation`) and one button: **Save answers — the agent continues**. The
consolidated-summary confirmation is not shown here at all (it happens in the
terminal after apply); the current read-only card for it goes.

### Wait mode

When nothing needs the human — agent writing, preparing an explainer, between
gates — the document column shows the last artifact if there is one, greyed
with the status pill live ("Agent writing requirements.md…"), or a single
centred status line. Nothing else. The tab title badges `(1)` only when a
round or gate awaits.

## Visual system

| Token | Value | From |
|---|---|---|
| ink / muted / faint | `#1a202c` / `#8792a2` / `#b6bfcc` | Bunsho |
| line / panel | `#eef2f7` / `#f7f9fc` | Bunsho |
| accent | `#2d7ff9` (+ `#edf4ff` soft) | Bunsho |
| comment | `#f59e0b`, fill `rgba(245,158,11,.15)`, 2 px underline | Bunsho |
| suggested edit | `#7c3aed` | ours |
| delete | `#e11d48`, strike-through | ours |
| looks good | `#16a34a` | ours |
| type | system stack; body 15/1.65; h1 30/1.2/700; h2 20/700; h3 16/600 | Bunsho scale, one step larger for reading |
| radius / shadow | 8–12 px; `0 1px 2px rgba(26,32,44,.04)` cards, `0 8px 24px .10` popovers | |

Dark mode: same tokens inverted (`#0f1419` page, `#e6e9ef` ink); kind colours
keep hue, drop saturation 10%.

## Workflow sidebar (mock v2)

[`review-ui-redesign/mock-v2.html`](review-ui-redesign/mock-v2.html) is the
same design with the icon rail replaced by a 280 px **workflow sidebar** — the
context the current UI's left column carries (current stage, artifacts,
record), made legible:

- **Intent switcher** — `260904-todo-app` with space and intent count; a
  dropdown lists the other intents (`intents.json`). Under it: scope, depth,
  phase chips and a `2 / 7 stages` progress bar.
- **Stages** — the `## Stage Progress` checklist from `aidlc-state.md`, grouped
  by phase with per-phase counts: done ✓, current ● with its status
  (*awaiting review*, *4 questions*, *writing…*), upcoming ○, skipped (dashed,
  with the reason), conditional `?`. Clicking a done stage opens its artifacts
  read-only with their threads; the current stage is highlighted in accent.
- **Current stage** — its artifacts with kind keys (document, questions with a
  `4/4` / `4 open` badge, memory diary) and their review state; this is the
  manifest the daemon already serves.
- **Record** — the file tree (`/api/tree`), current stage directory in accent,
  audit folder collapsed.
- **Footer** — agent state, daemon version, port.

Everything here is already in the daemon's state payload (`space`, `intent`,
`current_stage`, `stage_status`, `revision_count`, `questions`, `manifest`)
except the parsed progress list and the intent roster, both cheap reads of
files the daemon already watches. The sidebar collapses to the icon rail
(mock v1) below 1280 px and on demand (`⌘\`).

## What the mock shows

Three static screens at 1440×900 in [`review-ui-redesign/mock.html`](review-ui-redesign/mock.html):

- **Review**: title row, menu bar (click **Edit** to open its menu), the
  Markdown toolbar with Mode = Review; `requirements.md` at r1 with four
  threads across all kinds — a resolved looks-good, a pending comment with the
  inline composer open, a delete the agent pushed back on (with its reply), and
  a suggested edit the agent applied (diff inline, "Addressed in r1") — the
  hover `+` on FR1, and the decision bar.
- **Suggest edit**: Mode = Suggest edits; FR2 open as Markdown source with
  visible `**` markers, the old sentence struck red and the replacement green
  inside the block, **Keep suggestion / Discard** under it, and the pending
  edit card carrying the diff in the sidebar.
- **Questions**: the four to-do-app questions with recommendations
  pre-selected, the explainer for Q1 alongside (Why now / Trade-offs /
  Recommendation / Related decisions), and the save bar.

## Mapping to what exists

Every interaction has a backend already:

| Design element | Existing seam |
|---|---|
| Comment / Delete / Looks good / Label kinds | `ReviewAnnotation.kind` |
| Suggested edit with diff | `edit` annotation (unified diff) |
| Pending → sent | client-side list → `POST /api/feedback` → `feedback-NNN.md` |
| Agent reply per thread | new, record-first: a revised gate's completion message MUST carry a **Feedback addressed** list (one line per remark: applied / kept, with the reason); `report --result revised --responses <file>` persists the same list beside the stage's `feedback-NNN.md` as `responses-NNN.md`. Terminal users read it in the gate message; the daemon joins it to threads by annotation id |
| Addressed / Resolved | new: thread status derived from `responses-NNN.md` (applied → addressed; kept → open with the agent's reason); Resolve is a browser-side receipt and never affects the engine |
| Revisions, inline diff | `/api/snapshots`, `/api/diff` (word-level output added) |
| Status pill | `/api/state` (`current`, `current_stage`, `questions.ready/preparing`) + a new `agent_activity` field the daemon derives from the newest write under the stage dir |
| Decision from the bar | today: `decision_hint` in feedback + the terminal gate. Next: the browser click writes the decision into the feedback file and the conductor's gate question is pre-answered from it (`report --result approved|rejected --user-input …`), the terminal question remaining the fallback and the authority. The terminal path is never removed |
| Questions + explainer, recommendations, save | unchanged: `/api/questions`, `data-aidlc-recommend`, `POST /api/answers` |

## Phasing

1. **Shell + document + threads** (the look): new `index.html`/`app.css`,
   Bunsho type and tokens, rail, top bar with status pill, threads sidebar
   replacing the feedback drawer, gutter bubbles, inline composer replacing the
   floating toolbar, decision bar replacing decision-hint + send. No engine
   change. This alone removes most of the "dashboard" feel.
2. **Feedback addressed, record-first**: the revised-gate completion message
   gains a mandatory **Feedback addressed** list and `report --result revised
   --responses` persists it; terminal users see it in the gate message, the
   sidebar renders it as thread replies; Resolve; "Addressed in rN".
3. **Inline diff and revision switcher** in the document.
4. **Decision from the browser**: Approve / Request changes write the decision
   into the feedback file; the conductor pre-answers its gate from it when
   present. The terminal gate question is unchanged for everyone else.
5. **Suggest-edit in place** (replace the source textarea).

Phase 1 is a pure front-end rewrite against the existing API and is the one
that changes how the tool *feels*; I'd start there.
