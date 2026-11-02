# Command Center integration: `/aidlc dashboard`

Status: approved design, pending RFC acceptance
Date: 2026-11-02

## 1. Goal

An engineer running AI-DLC on their machine types `/aidlc dashboard` (or runs
`aidlc dashboard` in a terminal) and a local web page opens showing live
activity for their AI-DLC workflows: intents, current phase and stage, stage
history, decisions, artifacts, reviews, learnings, issues, and token usage.
Updates arrive as the workflow writes its records, with no manual refresh.

The view already exists as the Engineering view of the standalone
`aidlc-command-center` project. This work moves that view into
`aidlc-workflows` so it ships in every install and every harness.

## 2. Scope

In scope:

- The Engineering view only (live local work).
- A new public utility `aidlc dashboard` and the `/aidlc dashboard` verb in all
  seven harness orchestrator skills.
- Packaging the server and a prebuilt UI into every `dist/<harness>/` tree.
- Tests and documentation for the above.
- One RFC issue on GitHub and one linked draft PR.

Out of scope:

- The Portfolio view (cross-repository, OAuth/SSO, GitHub App sign-in). It can
  be proposed in a separate RFC.
- Any change to the standalone `aidlc-command-center` repository. Its future
  is decided later.
- Any AI or model call, outbound network request, or telemetry.
- Remote access. The page is reachable from the engineer's own machine only.

## 3. Source layout

Shipped files live in `core/`, as every other framework part does, and reach
each `dist/<harness>/` through a `coreDirs` entry. Development-only files (UI
sources, the app's own tests, its dev dependencies) live in a separate
dev package at the repository root, so no install carries React sources.

```text
core/command-center/            shipped (coreDirs: command-center -> command-center)
  server/                       Bun HTTP server, discovery, parsers, lenses, live hub
                                (from aidlc-command-center/engineering/server, behaviour unchanged)
  ui/                           prebuilt UI bundle (index.html + assets/), committed
core/tools/aidlc-dashboard.ts   launcher: argument parsing, config load/save, auto-pin,
                                in-process server start, browser open

command-center/                 dev-only package, never projected
  package.json, bun.lock        React, Vite, happy-dom dev dependencies
  ui/src/, ui/index.html        React sources
  vite.config.ts                builds into ../core/command-center/ui/
  tests/                        the app's own server and UI tests
```

The launcher imports the server in-process
(`../command-center/server/index.ts`), so the compiled native binary bundles
it and no separate `bun` is needed at runtime. The launcher finds the UI
bundle on disk with the existing `resolveHarnessPath(["command-center", "ui"])`.

### 3.1 Why a committed UI bundle

Installed AI-DLC runs through the self-contained `aidlc` runtime. Engineers do
not have Vite, React, or a `node_modules` tree, and must not need one to open
the page. The UI is therefore built once by contributors and committed under
`core/command-center/ui/`.

Staleness guard: the dev package's CI job rebuilds the UI from `ui/src` and
fails when `git diff --exit-code core/command-center/ui` shows a change, naming
the rebuild command. React and Vite are dev dependencies of the dev package
only; nothing is added to the runtime.

## 4. Command surface

### 4.1 `aidlc dashboard`

```text
aidlc dashboard [--port <n>] [--no-open] [--root <dir>]... [--pin <dir>]... [--json] [--config <file>]
```

| Flag | Meaning |
|---|---|
| `--port <n>` | Port to bind; `0` (default) picks a free port |
| `--no-open` | Do not open a browser; print the URL only |
| `--root <dir>` | Add a folder to scan for AI-DLC projects (remembered) |
| `--pin <dir>` | Add one AI-DLC project (remembered) |
| `--json` | Print `{"url": ..., "port": ...}` on one line, then keep serving |
| `--config <file>` | Settings file; default `~/.aidlc/dashboard.json`, or `AIDLC_DASHBOARD_CONFIG` |

On start the launcher auto-pins the current directory when it holds an AI-DLC
workspace (`aidlc/active-space` exists) and is not already covered by a saved
root or pin. It prints `AI-DLC Command Center → <url>` and `Press Ctrl-C to
stop.`, opens the browser unless `--no-open`, and stops cleanly on SIGINT or
SIGTERM.

Exit codes: `2` for a bad argument (with a usage line), `1` when the server
cannot start, `0` on a clean stop.

### 4.2 Route registration

`core/tools/aidlc.ts` gains a route entry:

- `id: "top-dashboard"`, `namespace: "public"`, `verbs: ["dashboard"]`,
  `tool: "aidlc-dashboard.ts"`, `visibility: "public"`.
- `projectRequirement: "optional"`: it works from any directory.
- `networkPolicy: "forbidden"`: no outbound network.
- `mutationScope: "machine"`: the only write is the settings file under
  `~/.aidlc/`.
- A long-lived process marker, so the dispatcher does not apply the
  short-command timeout. If the route type has no such field yet, add one
  (`processLifetime: "long-lived"`) with the default `"short"` for every
  existing route.
- `outputModes: ["human", "json"]`.

### 4.3 `/aidlc dashboard`

`/aidlc dashboard` does not go through `next`. Each harness skill gets one
short paragraph, placed before the `Each \`next\` returns` paragraph:

> **Opening the Command Center (`/aidlc dashboard`).** When the arguments
> begin with the word `dashboard`, this is not workflow input and is the one
> exception to passing the arguments to `next`: do not run `next` and do not
> touch the workflow. Run `{{INVOKE}} dashboard` with any flags that followed
> the word in the background, wait for its first line, and tell the person the
> printed URL. It serves until stopped. If it exits instead, relay its error
> line, then STOP.

The paragraph goes in all seven harness `SKILL.md` files. `dashboard` is
added to each harness's argument hint or command utility list where that
harness lists utilities. Routing it in the skill keeps the engine's directive
contract unchanged.

The dashboard never advances the workflow, never changes state, and emits no
audit events.

## 5. Data flow

1. **Discovery**: from the saved roots and pins, find AI-DLC workspaces
   (`aidlc/spaces/*/intents/*`).
2. **Parse**: read `aidlc-state.md`, the audit shards, stage `memory.md`
   files, artifacts, learnings, and the compiled stage graph. Claude
   transcripts are read only when the engineer turns on the opt-in scan.
3. **Model**: build per-intent snapshots. Any value the files do not support
   renders as `—` with the missing source named, never as an estimate.
4. **Live**: file watchers feed a hub that pushes change events to the UI
   over Server-Sent Events (`/api/live`). The UI shows a live badge that turns
   stale when the stream stops.
5. **Lenses**: `/api/intent`, `/api/artifact`, and `/api/lens/{decisions,
   artifacts, reviews, learnings, tokens, issues}` serve the detail tabs.

All access is read-only, except the settings file written by Workspaces &
settings and by `--root`/`--pin`.

## 6. Security

The server keeps the posture it has today:

- **Bind**: `127.0.0.1` only. Never `0.0.0.0`, and no flag to change that.
- **Host check**: requests whose `Host` is not `127.0.0.1:<port>` or
  `localhost:<port>` get `421`, which blocks DNS rebinding.
- **Token**: a per-run 24-byte random token (base64url) is required on `/`
  and `/api/*`, as `?t=` or the `x-cc-token` header, and compared in
  constant time. `/assets/*` is deliberately not gated: browsers do not append
  the page's query to subresource requests, and the assets hold no data.
- **Headers**: a Content-Security-Policy limited to the page's own origin
  (`default-src 'self'; connect-src 'self'; frame-ancestors 'none';
  base-uri 'none'`, with inline styles and `data:` images allowed for the UI),
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- **File serving**: `/api/file` and artifact reads are confined to discovered
  workspace records after `realpath`. Anything outside them gets `404`.
- **No network, no AI**: no model calls, outbound requests, or telemetry. A
  unit test scans the server sources and the committed bundle for network APIs
  and model SDK imports, and fails on any hit.

The token is CSRF and DNS-rebinding hardening for a loopback-only tool (the
same pattern Jupyter uses), not an authentication gate for a wider audience.
The loopback bind is the access boundary, and there is no option to widen it.
ARCC was checked (no guidance for loopback dev servers), and the
`builder-security` policy was applied: loopback bind, no published port, and a
pre-finish sweep for wildcard binds plus an `lsof` check that the live listener
is on `127.0.0.1`.

## 7. Error handling

- Port in use when `--port` is explicit: exit `1` with the port named. With
  the default `0`, the OS picks a free port, so this cannot happen.
- No browser opener available: the URL is still printed, and the open failure
  is ignored.
- Unreadable or malformed record files: the affected intent shows a named
  issue in its Issues tab. The server does not crash, and other intents
  render normally.
- Settings file not writable: the server still starts, and one line on
  stderr says the settings were not saved.

## 8. Testing

Test files follow the repository convention (`tests/<level>/t<N>-*.test.ts`,
run by `bash tests/run-tests.sh`).

- **Unit**: port the Engineering view's existing server, parser, lens, and
  UI tests. Add:
  - launcher argument parsing and auto-pin;
  - the no-AI/no-network scan over sources and bundle;
  - the route-table entry (public, `forbidden` network, long-lived).
- **Integration**: start `aidlc dashboard --json --no-open --port 0` against
  a fixture workspace, then assert:
  - the first stdout line parses to `{url, port}`;
  - `/` with the token returns 200, and without it 401;
  - a foreign `Host` gets 421;
  - `/api/live` streams an event after a fixture record is appended;
  - a path outside the workspace gets 404;
  - SIGTERM exits 0.
- **Packaging**: `bun scripts/package.ts --check` stays byte-identical, and
  every `dist/<harness>/` contains the server, the bundle, and the tool.
- Fixtures use synthetic data only: no real paths, user names, or client
  project names.

## 9. Documentation

Per the Documentation Policy, in the same PR:

- `docs/guide/`: a Command Center page (what it shows, how to open it, the
  flags, where settings live, how to stop it), plus a link from the guide
  index.
- `README.md`: the tool count goes up by one, and the dashboard gets a
  mention.
- `docs/reference/`: the route entry and the long-lived marker, if added.
- Each harness onboarding template that lists `/aidlc` utilities gains
  `/aidlc dashboard`.

Per the Release Metadata Policy, this PR does not bump
`core/tools/aidlc-version.ts`, the README badge, or `CHANGELOG.md`.

## 10. Delivery on GitHub

1. **RFC issue** on `awslabs/aidlc-workflows` from the `rfc.yml` template,
   titled `[RFC]: Command Center — a live local view of AI-DLC workflows
   (/aidlc dashboard)`. It fills Summary, Motivation, Detailed Proposal
   (§3–§6 condensed), Alternatives Considered (§11), Drawbacks (§12), and
   Additional Context (synthetic-data screenshots).
2. **Draft PR** from branch `feat/command-center-rfc` (based on `origin/main`)
   with `Implements #<rfc>` in its body and the repository PR template filled
   in. It stays draft during the RFC discussion, and goes ready for review and
   merges after the RFC is accepted.
3. The branch history is clean and new. No commit from the older local
   dashboard branches is reused. Before every push, check that no real local
   path, user name, or client project name appears in the diff or the
   history.
4. Both texts are shown to the author before anything is posted.

## 11. Alternatives considered

- **Optional plugin (`plugins/command-center/`)**: keeps core lean, but the
  plugin seam today covers stages, agents, sensors, and prose, not a public
  CLI verb plus an orchestrator utility. It would also make `/aidlc dashboard`
  fail until an install enables it. Rejected for now. It could be revisited if
  the seam grows a utility contribution point.
- **Keep it external and fetch it on demand**: the standalone repository is
  not publicly reachable, and fetching code at runtime would break the
  no-network posture. Rejected.
- **Server-rendered HTML instead of React**: smaller, but it would be a
  rewrite of a working, tested UI. Rejected.

## 12. Drawbacks

- The install grows by the server sources and the UI bundle (a few hundred KB).
- Contributors who touch the UI need the dev toolchain to rebuild the bundle.
  The staleness guard makes forgetting this visible.
- A long-lived local server is a new kind of process for AI-DLC. Its posture
  (§6) and its tests (§8) are what keep it safe.
