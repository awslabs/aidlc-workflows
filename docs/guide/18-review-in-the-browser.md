# Review in the Browser

The Review UI is an optional local browser surface for reading stage artifacts,
leaving precise feedback, comparing revisions, exporting a copy, and answering a
stage's questions. The terminal remains the workflow control surface: the
browser prepares feedback or answers, while **Approve**, **Request Changes**, and
other decisions still happen in the harness conversation.

## Enable the Review UI

Set `AIDLC_REVIEW_UI=1` in the environment that starts your harness:

```bash
export AIDLC_REVIEW_UI=1
```

At session start, AI-DLC ensures that the project-local review daemon is running.
It is detached from the session and stops after its idle timeout. If your harness
does not run the session-start hook, start it directly from the project root:

```bash
bun <harnessDir>/tools/aidlc-review-ui.ts serve --project-dir "$PWD"
```

`<harnessDir>` is the installed harness directory, such as `.claude`, `.kiro`,
`.codex`, `.cursor`, or `.aidlc`.

## Review an approval gate

When a stage reaches an approval gate, the completion message includes one of
these lines:

```text
**Browser:** http://localhost:4765/open/0123456789abcdef0123456789abcdef
```

or, when the previous link was used or expired:

```text
**Browser:** http://localhost:4765/ — run /aidlc --status for a fresh link
```

A link under `/open/` is a single-use capability and expires after 30 minutes.
Opening it exchanges the nonce for an `HttpOnly` browser cookie; the daemon's
long-lived token is never printed. Run `/aidlc --status` whenever you need a
fresh link.

The browser flow does not replace the gate:

1. Open the **Browser** link and select the artifact under review.
2. Select Markdown text and choose **Comment**, **Delete**, **Looks good**, or
   **Label**. For HTML, select text or Alt-click a point, then confirm the anchor
   before it becomes an annotation. Use the editor when the feedback is an exact
   replacement.
3. Add a general note or decision hint, then choose **Send feedback**. The UI
   writes a numbered feedback file; it does not approve or reject the stage.
4. Return to the terminal and answer **Approve** or **Request Changes** at the
   existing gate. AI-DLC ingests pending browser feedback with that decision.

On **Request Changes**, the agent receives the feedback body as part of the gate
reason and revises the artifact. On **Approve**, the feedback is carried forward
as non-blocking approval notes. Either path emits a `REVIEW_UI_FEEDBACK` audit
row with the stage, revision, result, files, and digest, and records the consumed
feedback files so they are not applied twice.

### Compare revisions and export

The daemon snapshots every existing declared artifact when a gate opens. The
**Revisions** action compares any saved revision with the current artifact or a
second saved revision and shows both structured hunks and a unified diff.

**Export** downloads a self-contained HTML copy. Markdown is rendered with
inline styling (and an inline Mermaid runtime when needed); authored HTML is
exported with local sibling assets inlined where possible. The export does not
need the review daemon to display later.

## Answer questions in the browser

When the active stage has a `*-questions.md` file, the sidebar shows
**Questions**. The questions form presents each answerable `Q<n>` section as a
radio group or checkbox group, supports **Other** text and a note, and shows the
consolidated-summary confirmation read-only. Unsaved choices remain in that
browser tab's session storage.

The browser never edits `*-questions.md`. **Save answers** writes a numbered
`answers-NNN.json` submission against the current questions-file digest. If the
file changed while the form was open, the save is refused; reload before trying
again. After a successful save, return to the terminal and send **done**. The
agent runs `aidlc-log.ts answers-apply`, which applies unconsumed submissions
under the audit lock, writes `[Answer]:` and optional `[Note]:` lines, emits one
human-turn-backed `QUESTION_ANSWERED` row in `Mode: browser`, and marks the
submissions consumed. The ordinary consolidated summary and **Looks correct** /
**Request changes** confirmation then continue in the terminal.

### Guide me in the browser

When the Review UI is available, the interaction-mode prompt also offers
**Guide me in the browser** — “Read an explainer with trade-offs and answer in
the browser.” Choose it when you want the form and an agent-authored explainer
side by side.

The agent writes `<stage>-questions-guide.html`, with a **Why now** section,
option-by-option trade-offs, a recommendation, and related prior decisions for
each question. In the Questions view, selecting a question scrolls the explainer
to the matching section. A recommendation may preselect a still-unanswered
option and is visibly marked as recommended; it never overwrites your selection.
Save the form, return to the terminal, send **done**, and review the consolidated
summary as above.

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

The supported deployment is loopback-only. Keep `AIDLC_REVIEW_HOST` on a
loopback address and use SSH port forwarding rather than binding the review UI
to a LAN interface. A fixed port makes the tunnel predictable, and disabling
auto-open avoids trying to launch a browser on the remote host:

```bash
# On the remote host, before starting the harness
export AIDLC_REVIEW_UI=1
export AIDLC_REVIEW_HOST=127.0.0.1
export AIDLC_REVIEW_PORT=4765
export AIDLC_REVIEW_OPEN=0

# On your workstation
ssh -L 4765:127.0.0.1:4765 user@remote-host
```

Use the single-use link printed at the remote gate in your local browser. The
daemon chooses an ephemeral port when `AIDLC_REVIEW_PORT` is unset. Set
`AIDLC_REVIEW_OPEN=0` for any environment where automatic browser launch is
undesirable.

## Privacy and security

- The supported server bind is loopback; there is no hosted service or LAN
  sharing mode.
- Printed links contain a random, single-use, 30-minute nonce. The bearer token
  stays in an owner-readable `server.json` file and an `HttpOnly`,
  `SameSite=Strict` cookie.
- Project paths are confined beneath the project's `aidlc/` tree, reject `..`
  and symlink escapes, and never expose the rest of the workspace through the
  API.
- Markdown is sanitized before rendering. Authored HTML runs in a sandboxed
  iframe with a restrictive Content Security Policy; artifacts cannot fetch
  network resources, embed browsing contexts, or submit forms.
- Daemon discovery, logs, and nonces live under `~/.aidlc/review-ui/` (or
  `AIDLC_REVIEW_HOME`). Project directories there are owner-only (`0700`), and
  token and nonce files are owner-readable only (`0600`). Record-side manifests,
  snapshots, feedback, answers, and consumed receipts live under the active
  intent's `.review-ui/` directories.

For environment-variable details and implementation schemas, see
[Review UI and HTML Artifacts](../reference/19-review-ui-and-html-artifacts.md).
