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
                                     │ writes feedback + answer submissions
                                     ▼
                                  browser
                                     │
engine report <── ingests files ─────┘
   │ publishes current pointer, manifest, snapshots
   │ emits audit rows and owns gate transition
   ▼
conductor presents the terminal gate
```

- `aidlc-session-start.ts` ensures the daemon is alive when
  `AIDLC_REVIEW_UI=1`. It never mints an open link or adds a link to session
  context. Failure is swallowed and recorded as a hook drop, so Review UI
  availability cannot break the workflow.
- `aidlc-orchestrate.ts report` is the mutating publication and feedback
  ingestion seam. `awaiting-approval` and `revised` publish the current review;
  `approved` and `rejected` consume pending feedback with the terminal decision.
  Read-only `next` and hook probes never mint capabilities.
- `aidlc-review-ui.ts` serves one project, reads workflow state through
  `aidlc-lib.ts`, renders artifacts, and writes append-only feedback or answer
  submissions. It never advances state, approves a gate, rejects a gate, or
  edits a questions file. A saved answers submission is a human act observed by
  framework code, so alongside `answers-NNN.json` the daemon appends a
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
  turn during a browser question round (blank `[Answer]:` tag, a
  `<slug>-questions-guide.html` beside it, a live daemon) until a submission
  lands, then answers `{"decision":"block"}` with the `answers-apply` command,
  so the conductor resumes without a human prompt. The wait is bounded by
  `AIDLC_REVIEW_WAIT_SECONDS` (default 1200; `settings.json` grants the hook
  1500) and expires to the plain allow. Off by default on other harnesses, whose
  hook timeouts are seconds; `AIDLC_REVIEW_WAIT_SECONDS` opts one in after its
  timeout has been raised.

The browser is deliberately **not a decision authority**. Its Approve / Request
Changes value is a `decision_hint` for the feedback file. A human still answers
the actual terminal gate, and the engine records that outcome.

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

### Record pointer

#### `<record>/.review-ui/current.json`

```json
{
  "version": 1,
  "state": "awaiting-approval",
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
independently of the held review manifest.

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

### Comment — Functional requirements › FR3 (element: main > section:nth-of-type(2))
> the export must finish within 5 minutes

Make this 2 minutes; the SLA changed.

### Edit (unified diff)
```diff
--- a/requirements.html
+++ b/requirements.html
@@ ...
```

## General notes

Free text.
````

Artifact sections use the artifact basename. Annotation headings are `Comment`,
`Delete`, `Looks good`, `Label`, or `Edit`; they may carry a heading breadcrumb,
approximate line range, and (for HTML) a CSS element path. Edit annotations
contain the daemon-computed unified diff. `decision_hint` is `approve`,
`request-changes`, or `none` and does not commit a decision.

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

#### `<stage-dir>/.review-ui/consumed.json`

Shared engine/log-tool receipt for feedback and answer submissions:

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
    }
  ]
}
```

Feedback results are `approved` or `rejected`; browser answers use
`answers-applied`. Identity is the `(file, sha256)` pair.

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
| `GET /api/state` | Cookie/header | Active project, space, intent, record, current pointer, manifest, `current_stage` (the workflow's stage even before a gate has published a pointer), stage marker, revision, HTML setting, and the `questions` pointer with its readiness: `guide` is published only once the explainer passes `checkGuideArtifact`; `ready: true` then; `preparing: true` while a guide file exists but fails (an unfilled scaffold, empty prose or recommendations); neither for a terminal round. The app steers, auto-opens, badges, and renders the form only on `ready`; while `preparing` it shows a holding message |
| `GET /api/tree` | Cookie/header | Recursive record entries `{path,type,size,mtime}` for reviewable files only: `aidlc-state.md`, `project-description.json`, `audit/`, and every dot-directory (`.review-ui/`, `.aidlc-sensors/`, …) are omitted |
| `GET /api/artifact?path=` | Cookie/header | Markdown `{path,format:"md",source,raw_url,sha256,mtime}` or HTML `{path,format:"html",raw_url,sha256,mtime}`; the app never receives rendered HTML. Paths outside the active record or naming a hidden file are 403 |
| `GET /api/raw?path=` | Cookie/header | A full HTML document for the artifact sandbox: HTML artifacts verbatim, Markdown rendered server-side inside `<article data-aidlc="markdown">` (Mermaid loaded from `/assets/vendor/`); the trusted bridge is injected and the artifact CSP applied. Other extensions are 404, hidden files 403 |
| `POST /api/feedback` | Cookie/header | Validate current stage/unit/revision, write `feedback-NNN.md`, return `{file,path}` |
| `GET /api/snapshots?stage_dir=` | Cookie/header | `{revisions:[0,1,...]}` |
| `GET /api/snapshot?stage_dir=&revision=&file=` | Cookie/header | `{source}` from one saved revision |
| `GET /api/diff?path=&from=&to=current\|<revision>` | Cookie/header | `{hunks,unified}` for manifest artifact revisions |
| `GET /api/export?path=` | Cookie/header | Self-contained HTML attachment |
| `GET /api/questions?path=` | Cookie/header | Parsed questions, answers, notes, confirmation flags, and source digest |
| `POST /api/answers` | Cookie/header | Validate submission/digest, write `answers-NNN.json`, return `{file}`; stale digest is 409 `{error:"questions file changed; reload"}` |
| `WS /ws` | Cookie plus exact own `Origin` | Server pushes `{type:"state"}` after debounced state, pointer, manifest, artifact, feedback, or answer changes |

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

Every artifact document — authored HTML and rendered Markdown alike — is served
by `/api/raw` with CSP
`default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src
'unsafe-inline' 'self'; font-src data:; frame-ancestors 'self'` and
`X-Content-Type-Options: nosniff`, and the app embeds it in an iframe sandboxed
with `allow-scripts` (no `allow-same-origin`). Rendered Markdown therefore never
enters the privileged app document; the server-side sanitizer is defence in
depth, not the trust boundary. The app shell itself is served with
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.
The bridge emits `aidlc-anchor` messages for trusted selection or Alt-click
events and one `aidlc-guide` message containing schema-checked recommendations.
The parent accepts only the current iframe's `event.source`; the artifact's
opaque sandbox origin is not trusted. For Markdown anchors the app estimates
source lines by matching the reported selection against the artifact source.

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
- `report --result revised` publishes the revised manifest/snapshot and another
  `awaiting-approval` pointer using the state's current Revision Count.
- `report --result rejected --reason <terminal text>` reads all pending feedback
  in sequence order and appends `## Browser review feedback` plus each filename
  and body verbatim to the rejection reason. It records `GATE_REJECTED`, then
  one `REVIEW_UI_FEEDBACK` row (`Stage`, optional `Unit`, `Revision`,
  `Result: rejected`, `Files`, `Digest`), marks the files consumed, and writes a
  `revising` pointer.
- `report --result approved` emits the same audit event with
  `Result: approved`, marks pending files consumed, and returns their combined
  bodies as `approval_notes` in the report JSON. Those notes are downstream
  guidance, not a request to revise the approved artifact.

Feedback bodies are not reinterpreted or normalized by the engine. The digest
is SHA-256 over their concatenated bodies.

## Directive and format contract

Markdown entries preserve the historical directive bytes as bare path strings.
HTML entries are explicit:

```ts
type ArtifactProduceEntry = string | { path: string; format: "html" };
type ArtifactConsumeEntry = string | {
  path: string;
  format: "html";
  text_command: string;
};
```

For an HTML consume, `text_command` is
`bun <harnessDir>/tools/aidlc-html.ts text <path>`. Agents use that deterministic
projection unless markup inspection is necessary.

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
| `bun <harnessDir>/tools/aidlc-html.ts check --guide <file> --questions <md>` | Apply the base HTML checks plus the questions-explainer contract: matching ordered `Q<n>` sections, IDs, and one valid recommendation per answerable question. Findings are actionable: a question whose options the parser cannot read is reported once (`Q1 has no parsable options … options must be bare lines "A. text"…`) instead of once per recommendation; an out-of-range letter names the offered letters; an empty `data-aidlc-recommend` is called out; the summary finding points at the scaffold |
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

## Environment variables

Boolean variables use the exact string `"1"` unless a row says otherwise.

| Variable | Default | Effect |
|---|---|---|
| `AIDLC_REVIEW_UI` | unset | `1` enables daemon startup, review publication, directive field, browser gate line, and feedback/questions UI; unset preserves legacy behavior |
| `AIDLC_REVIEW_PORT` | `0` | TCP port; `0` asks the OS for an ephemeral port |
| `AIDLC_REVIEW_HOST` | `127.0.0.1` | Bind host; keep the default loopback address for the supported security posture |
| `AIDLC_REVIEW_OPEN` | enabled | `0` disables automatic browser launch. Otherwise the daemon opens a browser when a gate opens (transition into awaiting-approval) or a browser question round begins (the `<slug>-questions-guide.html` explainer lands) and no review tab is present (no live WebSocket and no authenticated request within the last 10 s); never over `SSH_CONNECTION`. A connected tab is never duplicated: the state push steers it — to Questions when a new round appears and nothing of the human's is in flight there, to the review artifact at a gate — and its title carries a `(1)` badge while something awaits them |
| `AIDLC_REVIEW_IDLE_MINUTES` | `240` | Exit after this many minutes with no WebSocket client and no observed state change |
| `AIDLC_REVIEW_STRICT` | unset | `1` disables browser-navigation trust for `GET /`: the bare origin never opens and every printed URL is a single-use `/open/<nonce>` link. For shared multi-user hosts. Set it in the harness environment so the daemon and the CLI agree |
| `AIDLC_REVIEW_WAIT_SECONDS` | `1200` on Claude Code, `0` elsewhere | How long the Stop hook holds a browser question round waiting for the human's Save before falling back to the plain release. Must stay below the hook's own timeout (`settings.json` grants 1500 s on Claude Code). `0` disables the hold |
| `AIDLC_REVIEW_HOME` | `~/.aidlc/review-ui` | Override private daemon discovery/log/nonce root; primarily useful for tests and isolated installations |
| `AIDLC_HTML_ARTIFACTS` | unset | `1` seeds new intents with `HTML Artifacts: on`; the state field, not the environment, controls the intent thereafter |

Auto-open is also suppressed when `SSH_CONNECTION` is present. The daemon opens
only on a supported desktop (`open`, `xdg-open`, or `cmd /c start`) and ignores
launcher failures.

## Non-goals and extension seams

- The browser does not own the approval decision, write audit rows, or advance
  workflow state.
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
