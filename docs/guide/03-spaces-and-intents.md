# Spaces and Intents

[Your First Workflow](02-your-first-workflow.md) walked through one run from start
to finish. But real work is rarely one thing at a time: you have a feature in
flight, an urgent bug lands, a second team shares the repo. This chapter explains
how AI-DLC organizes **many** pieces of work in **one** place — the *workspace* —
and the two concepts you use to navigate it: **spaces** and **intents**.

The short version: an **intent** is one piece of work (one run of the lifecycle);
a **space** is one team's world of intents, knowledge, and practices. Most people
work in a single space (called `default`) and never think about spaces at all —
they just start intents and switch between them. The rest of this chapter shows
how that works and where everything lives.

---

## One workspace, organized by what you're working on

When you run `aidlc config`, it projects the selected engine into your
harness's own directory (`.claude/` on Claude Code, `.kiro/` on Kiro, `.codex/`
on Codex, `.cursor/` on Cursor, `.aidlc/` on opencode and GitHub Copilot), plus
the folders that harness itself reads (`.agents/skills/` on Codex, `.opencode/`
on opencode, `.github/` on GitHub Copilot). Those are the *only* parts of the
layout that differ by harness. From then on, everything AI-DLC produces lives under one
neutral `aidlc/` directory at your project root — organized by *what you're
working on*, not by which harness you happen to run. You browse `aidlc/`; you
never need to open the engine directory.

Here is a complete workspace with two teams and a few intents in flight (the
engine directory is shown as `.claude/` — read it as `.kiro/` or `.codex/` on
those harnesses). Read it top to bottom — it is the mental model the rest of
this chapter builds on:

```
my-project/
│
├── .claude/                      THE ENGINE — tools, hooks, skills, agents.
│                                 (or .kiro/ / .codex/ — the one harness-specific dir)
│                                 You never browse this; it just runs /aidlc.
│
├── aidlc/                        EVERYTHING AI-DLC — neutral, browsable, committed to git
│   ├── active-space              ← cursor: which space you're in (gitignored, per-user)
│   └── spaces/
│       ├── default/              ★ the only space most people ever see
│       │   ├── memory/           THE METHOD — how this team works (committed)
│       │   │   ├── org.md          framework defaults
│       │   │   ├── team.md         your team's practices  (adds to org)
│       │   │   ├── project.md      project-specific practices (adds to org and team)
│       │   │   ├── phases/         phase-scoped rules
│       │   │   └── templates/      your output-format overrides, one per artifact
│       │   │
│       │   ├── knowledge/        DOMAIN KNOWLEDGE — standards an agent reads (committed)
│       │   │   │                   free-form; empty until you add files
│       │   │   ├── documents/      YOUR ORIGINALS — PDFs, Word, Markdown (you own this)
│       │   │   │                     nest them however you like; never reorganised
│       │   │   └── documentkb/     THE CATALOG — derived from documents/ (tool-owned)
│       │   │       ├── index.json     every indexed document, with its state
│       │   │       └── <doc-id>/      metadata.json + extracted content.md
│       │   ├── codekb/           CODE KNOWLEDGE — what each repo is (committed, per-repo)
│       │   │   └── <repo>/          architecture, component inventory, freshness marker
│       │   │
│       │   └── intents/          THE RECORD — one subdir per piece of work
│       │       ├── active-intent   ← cursor: which intent is current (gitignored)
│       │       ├── intents.json    the registry: every intent + its scope/repos/status
│       │       ├── 260620-inventory-api/        ✓ a completed intent
│       │       └── 260624-export-bug/           ◷ an in-flight intent
│       │           ├── aidlc-state.md             where this intent is in the lifecycle
│       │           ├── audit/                     the decision trail
│       │           └── inception/requirements-analysis/requirements.md   …artifacts
│       │
│       └── payments-team/        another SPACE (another team) — identical shape
│           └── memory/  knowledge/  codekb/  intents/
│
├── repo-a/                       YOUR CODE REPOS live as siblings (each its own git)
└── repo-b/                       an intent can span more than one
```

That tree shows a project with several code repos. A project with one repo is the
same thing with the repo as the workspace itself
([Where `aidlc/` lives](#where-aidlc-lives)).

Three things are worth pulling out of that tree, because they are the whole idea:

- **`aidlc/spaces/<space>/`** is one team's self-contained world: its method
  (`memory/`), its knowledge, its code knowledge, and its record of every intent.
  You get `spaces/default/` for free and, as a solo developer or single team,
  never look past it.
- **`intents/<YYMMDD>-<label>/`** is one piece of work — the per-run record that
  [Your First Workflow](02-your-first-workflow.md) filled in. The `<YYMMDD>` is a
  compact UTC date so records sort chronologically; the `<label>` is a short,
  human-readable name. Identity itself is carried by a UUIDv7 in the registry, not
  the dir name, so two same-day same-label intents stay distinct.
- **Two cursors** — `active-space` and `active-intent` — record *where you are
  right now*. They are per-user (gitignored), so two teammates can sit in
  different intents at the same time without fighting over a shared file.

> **Upgrading from an older version?** Earlier releases kept a single workflow in
> one flat directory at the project root, which a new run would overwrite. The
> workspace model replaces that with the per-intent record dirs above, so you can
> keep many pieces of work side by side without one clobbering another.

---

## Intents — one per piece of work

An **intent** is a single run of the AI-DLC lifecycle, scoped to one task. Every
intent owns a row in the space's `intents.json` registry — `{uuid, slug, dirName,
scope, repos, status}` — and a **record dir** holding that run's state, audit
trail, and artifacts. A team's build of one Unit keeps that row in its own
record dir, as `aidlc-intent.json`, so two builds started at once in one space
share no file ([Take a Unit](workshop-mode.md#take-a-unit-as-your-teams-own-work)). The `uuid` (a UUIDv7) is the canonical, collision-proof
identity; `dirName` records the human-readable record-dir name verbatim.

The row's `status` is the intent's lifecycle: `in-flight` from creation,
`complete` once the last in-scope gate closes, or `archived` when you retire
work you will not finish or hide work you finished (`/aidlc intent archive
<name>`). Archiving never deletes anything: the record dir, audit trail, and
any Bolt worktrees stay put, the default listing just stops showing the row
(`/aidlc intent list --all` still does), and `/aidlc intent unarchive <name>`
puts it back the way it was, in flight or complete.

You never create an intent with a special command. The first time you describe
work, the agent proposes a plan for it:

```
/aidlc Build a REST API for inventory management
```

Once you confirm the plan, AI-DLC creates the intent and its record dir (in the
[Getting Started](01-getting-started.md) run,
`aidlc/spaces/default/intents/261013-inventory-rest-api/`), makes it the active
intent, and starts the first stage, as in the previous chapter.

### Starting a second piece of work

Here is where the workspace earns its keep. Say you're mid-feature and an
unrelated bug needs attention. You don't archive anything or run an init command —
you just describe the new work:

```
/aidlc Fix the timeout on the export endpoint
```

When an intent is already active, AI-DLC recognizes that this may be *new,
unrelated* work rather than a continuation of the current feature, and **asks**
before starting a second intent alongside the first:

```text
 New request
 Work is already in progress on: "Build a REST API for inventory management". You said: "Fix the
 timeout on the export endpoint". What should I do?
 > 1. Part of the active work
      Continue the current workflow
   2. Separate new piece of work
      Yes, set it up alongside the current one without changing it; you pick its plan next
   3. Reshape the active work
      Change how the remaining plan is shaped
   4. Type something.
   5. Chat about this
```

- Choose **2** and you pick the new work's plan next (here the agent proposed
  `bugfix`); then AI-DLC creates a second intent beside the first. In that run
  the agent said: "I've set up the export timeout fix as a separate piece of
  work using the bug-fix plan, and it's waiting at Requirements Analysis. Your
  inventory API work is unchanged at the feasibility stage." The first intent's
  record dir, state, and progress are all preserved exactly where you left them.
- Choose **1** and AI-DLC treats your message as part of the active intent.
- Choose **3** and AI-DLC works out how to reshape the active intent's
  remaining plan with you.

Saying only that the work should go on (`/aidlc carry on`, "proceed", "keep
going", in your own words) asks nothing: AI-DLC reads your words and carries on
with the active work. With work in the project but none selected yet, it asks
which piece to pick up; name the piece with your words (`/aidlc continue auth`)
and it picks that piece up and carries on with it at once.

Settings you type with the new work go with the work you choose.
`/aidlc --depth minimal --learnings off Fix the timeout on the export endpoint`
asks the same question: choose **2** and the new intent starts with that depth
and learnings off; choose **1** or **3** and they apply to the active intent
(for **3**, before its plan is reshaped). A Guard Policy you lower this way goes
with the work you choose too, and AI-DLC says so once; when your team holds
Guard Policy strict, the new intent is created at strict. Naming the plan first
(`/aidlc bugfix Fix the timeout`) asks the same question, proposing that plan.
When a plan's name is also your own first word (`classic car rental website`),
the assistant reads which you meant and may ask you once, so your word is never
spent on a plan you did not choose.
So does a scope that differs from the active intent's, typed with a
description (`/aidlc --scope express "add a health endpoint"`), with new work
first: choose **1** and the description starts new express work, the active
intent kept as it is, or **2** and the active intent changes to express. A
scope with no description changes the active intent's scope without asking.

AI-DLC never creates a second intent without asking. If a prompt is genuinely a
follow-up to the current work — answering a gate, correcting a requirement — it
stays in the active intent; the offer only appears when the work is clearly
distinct.

### Switching between intents

List the intents in your space, then switch to one by name (its slug). From the
same run, with the export fix active:

```text
> /aidlc intent
Intents in space "default":
  261013-inventory-rest-api  [in-flight]
* 261013-export-timeout-fix  [in-flight]

> /aidlc intent inventory-rest-api
Now working on inventory-rest-api. You were on export-timeout-fix: /aidlc intent export-timeout-fix goes back.
```

The `*` marks the active intent.

Switching updates the invoking session's binding and writes through to the
`active-intent` cursor. The next `/aidlc` in that session resumes the intent
right where it stopped - same stage, same state, same audit trail. You can carry
any number of intents at once and move between them freely; each is an independent
run.

> Bare `/aidlc intent` is read-only — it just lists. Add `--json` for
> machine-readable output. See [CLI Commands](12-cli-commands.md) for the full
> flag reference.

### Concurrent sessions in one checkout

Each live session keeps a machine-local binding at
`aidlc/.aidlc-sessions/<session-id>.binding.json`. The binding records the
session's space and intent, so another terminal or IDE window can move the shared
cursors without silently moving this session's workflow.

A binding also records how its intent was chosen. Finding a record is not the same
as joining it: in a fresh clone, where a teammate's intent record is committed but
your `active-intent` cursor is not, the lone record resolves but no session has
joined it. The first `/aidlc` asks which intent to work on, and AI-DLC's hooks leave
that record alone until the session runs `/aidlc intent <slug>` (or creates its own
intent), or until this machine chooses that record (your `active-intent` cursor
names it, from another chat or your terminal): then the chat joins it on its next
turn, silently, as a chat opened after the choice would. What you type in a chat
that has not joined is still kept, on that chat's own message record outside the
intent record. A session bound by an earlier version keeps working its intent when your
cursor names the same record; otherwise it is offered a rebind to that intent. A
session an earlier version stamped but never bound follows its stamp when it
resumes, so a chat left open across an upgrade continues its own intent.
A plain `git worktree` created without AI-DLC's worktree command has no local
evidence either, so it also selects its intent with `/aidlc intent <slug>`. A Unit
claimed on this machine counts for that Unit's intent; the Unit participant marker
is checkout-wide and names no intent, so it does not count as joining a
particular record.

Session identity follows one order:

1. The host session id delivered to a hook.
2. A valid `AIDLC_SESSION_OVERRIDE` inherited from the harness process, or the
   one AI-DLC's opencode plugin gives each shell command for the chat it runs
   in (opencode's `shell.env` hook), so two chats in one opencode window each
   act on their own work.
3. The chat the host names in the agent's own shell: Codex's `CODEX_THREAD_ID`,
   Claude Code's `CLAUDE_CODE_SESSION_ID` while the process its `CLAUDE_PID`
   names is alive, or Kiro CLI's `KIRO_SESSION_ID`. A shell kept open after its
   chat ended still carries the variable, which is why Claude Code's id is read
   only while that chat's process is alive; a dead or absent pid leaves it
   unread. Kiro CLI puts no pid in the shell, so its id stands on its own, as
   Codex's does. Other harnesses name no chat there.
4. The nearest live PID ancestry entry.
5. No session identity.

Every id found this way, and every hook payload's session id, passes through one
door before any chat or work record is read. A helper's own id (a spawned Codex
agent's or review thread's, a Kiro CLI delegation's, a Copilot subagent's) maps
to the chat it belongs to: the adapter notes the pair from the first hook payload
that shows both, the one fact the engine cannot learn by itself. That chat's
binding is then read, and a chat with no binding yet (a host that never ran
SessionStart for it, or hooks installed after the chat opened) is bound at first
contact by the same rule SessionStart applies to a new chat: to the work the
shared cursor names when this machine has joined it, else to no record, silently.
From then on the chat stays on that work; a switch typed in another window moves
the cursor, not the chat. A chat bound to no record only because the lone record
here had not been chosen yet is read again at every entry: once the cursor names
a record, it joins that work the same way, silently. A command with no session
identity at all (your own terminal) keeps following the cursor.

Once identity is known, an explicit space or intent selector wins, followed by
that session's binding, then the shared `active-space` and `active-intent`
cursors with the existing lone-intent and empty-workspace fallbacks.

For headless automation, set `AIDLC_SESSION_OVERRIDE` on the harness process,
not on individual tool commands. Every spawned tool then inherits the same
identity. If that override disagrees with a session found through PID ancestry,
AI-DLC refuses before writing either workflow and points you to the owning
conversation or the intent and space switch verbs for rebinding.
`AIDLC_SESSION_OVERRIDE_SOURCE=payload` is an internal same-user contract, not
an authenticated security boundary; deliberately setting both variables is
treated like an intentional sanctioned session switch.

The cursors remain write-through compatibility state. Older or unsupported
environments with no binding therefore behave exactly as before.

Session bindings isolate workflow selection across spaces, but the
harness-native method include is still one checkout-wide surface: every
include reads one git-ignored copy of the active space's memory files,
`aidlc/active-memory/`, which SessionStart and the space switch verb
write for the selected space. So two simultaneous sessions in different spaces
can overwrite which space's ambient rules the harness delivers next. This
increment supports concurrent intents within one space; concurrent
multi-space ambient method delivery remains future work.

A space switch changes no tracked file: the includes are the same for every
teammate, and `aidlc config` refreshes them like any other shipped file. An
install whose includes an earlier release's switch pointed at another space
is brought to the shipped files by the next refresh, with no conflict.

The Codex adapter pins the validated hook payload session into every core-hook
child, and Codex gives every command it runs the session as `CODEX_THREAD_ID`
(0.145.0 and later, the minimum AI-DLC supports; the hooks do not receive it),
so the tools read the id from there and every command keeps the words the agent
wrote: macOS sandbox denial of `ps` does not weaken Codex workflow selection, and
the shipped `.codex/rules/default.rules` prefixes match what the agent runs. On
Windows x64 and arm64, native process handles,
creation times, and parent PIDs identify the owning session within the same
2-second / 64-ancestor limit as Linux and macOS. Reused PID generations and unverified ancestry do not
select a session.
Shared-process harnesses still cannot distinguish chats that use one process,
including Kiro IDE multi-chat. In multi-session opencode the shell commands carry
their chat (item 2), but a file write's audit row and sensors, and the to-do
list sync, still go by the process. Children of payload-bearing hooks follow
the payload session; tools without that parent still fall back to the shared
cursors when ancestry is unavailable unless the harness process has a valid
`AIDLC_SESSION_OVERRIDE`.

Known limitation: hook writes and the intent and space switch verbs in those
shared-process chats retain the pre-existing v2 shared-cursor and `.current-session`
behavior. One chat can therefore affect another chat's navigation or hook
attribution. Per-session isolation for those paths is future work. The exception
is an intent or space switch typed into a Kiro IDE chat, in either form
(`/aidlc intent switch <name>` or `/aidlc intent <name>`, and the same for
`space`): the prompt hook runs it with that chat's session, so it binds only
that chat.

---

## Spaces — one per team

A **space** is one team's complete world: its own `memory/` (method), `knowledge/`,
`codekb/`, and `intents/`. Everything in this chapter so far happened inside a
single space named `default`, which is created for you automatically. **If you're a
solo developer or a single team, that's the end of the story — you never name a
space and everything just works.**

Spaces exist for the case where **more than one team shares one project** and each
wants its own method, knowledge, and record without colliding. Adding a team is
purely additive: a new `spaces/<name>/` of the identical shape appears beside
`default/` — nothing moves, nothing migrates.

Create, list, and switch spaces with verbs that mirror the intent verbs exactly:

```
/aidlc space                      List all spaces
/aidlc space create payments-team Create a new space, starting from the default space's org rules
/aidlc space switch payments-team Switch the active space to "payments-team"
```

Creating one prints what it set up:

```text
> /aidlc space create payments-team
Space created: payments-team
  memory/org.md (copied from default), team.md, project.md, phases/, templates/, codekb/, knowledge/
Switch to it with /aidlc space payments-team.
```

The shorter `/aidlc space-create <name>` and bare `/aidlc space <name>` forms
work too.

A newly created space starts with a copy of the default space's
`aidlc/spaces/default/memory/org.md` (with any changes your team made there), the
framework's own phase rules, and fresh, empty `team.md` / `project.md` practice
files — a new team earns its own practices rather than inheriting another team's.
Its `knowledge/` and `codekb/` start empty too. The copy is made once: later
changes to the default space's `org.md` do not reach the new space.
[What carries over, and what doesn't](#what-carries-over-and-what-doesnt) lists
what is shared and what is not.

When you switch spaces, two things follow the cursor automatically:

1. **AI-DLC's own resolvers** — the next intent you start, and the practices and
   knowledge agents load, all come from the space you switched into.
2. **The rules your harness loads into context**: switching writes the new
   space's `memory/` files into `aidlc/active-memory/`, the git-ignored
   copy your harness's native rule include reads (Claude's `@`-import, Kiro CLI
   resources, Cursor rules, opencode's instructions, Copilot's `AGENTS.md`;
   Kiro IDE's steering file carries the text itself, and on Codex the engine
   hands each step its rules), so the next turn works under that team's method.

No tracked file changes, so a switch never churns the committed tree and
teammates who pull never pick up your space. The copy is checkout-global
rather than session-local, so simultaneous sessions in different spaces can
race on ambient method delivery even though their workflow record selection
stays bound.

### Knowing which space you're in

On Claude Code with AI-DLC's status line on, the line starts with the piece of
work you are in, and once more than one space exists, with the space before it,
as a persistent "you are here", the same way a shell prompt shows your current
directory (the bar and the separator dot shown in plain text; the line is cut at
the window's edge):

```text
[AIDLC] default - inventory-rest-api - IDEATION [##--------] 1/4 > Feasibility -- Architect Age...
```

A single-team user, having only `default`, sees no space name at all. On any
harness, `/aidlc space` and `/aidlc intent` list where you are, marked with `*`.

---

## Where `aidlc/` lives

**`aidlc/` goes in the folder `aidlc config` installs into, and that folder is
your workspace.** That is the folder you run it in, or the one you name with
`--project-dir`. AI-DLC does not look upward for a git root. Install into a
subfolder and that subfolder gets its own harness folder and its own `aidlc/`,
with its own spaces and intents. Open your harness in the same folder.

Two layouts cover most teams.

### One repo, or a monorepo

```
inventory-api/        ← run `aidlc config` here; this is the git repo
├── .claude/          the harness files (committed)
├── aidlc/            rules, knowledge, and the record of each piece of work (committed)
├── .gitignore        AI-DLC adds its own marked block
└── src/              your code
```

Everything travels with the code, in the same repo and the same pull requests.
A monorepo is the same layout: run `aidlc config` at the repo root and every
package shares one `aidlc/`. Work in this layout records no repos, so generated
code and git operations stay in the folder itself, as long as the repo has no
immediate child folder with its own `.git` (an initialized submodule or a
nested repo does). If it has one, AI-DLC treats those folders as the repos, as
in the next layout. Put the install in one
package's subfolder instead and that package gets a separate `aidlc/`, with its
own records. Git is not separated: branches and worktrees still belong to the
whole repo, because git resolves the repo from the subfolder. If several teams
share the repo, a space per team (see Spaces, above) is the better fit;
use a subfolder install only when a package is really its own project.

### Several repos beside one `aidlc/`

```
my-project/           ← run `aidlc config` here
├── .claude/          the harness files
├── aidlc/            records for work that spans the repos
├── repos.json        optional: the repos to clone (see below)
├── .gitignore
├── checkout-api/     its own git repo
└── checkout-web/     its own git repo
```

The code repos are the folders next to `aidlc/` that have their own `.git`.
AI-DLC finds them itself ([Multiple repos in one intent](#multiple-repos-in-one-intent)).
They can also live anywhere else on disk, beside the workspace folder or on
another drive, when `repos.json` gives each its `path`
([Declaring the repo set](#declaring-the-repo-set-optional-manifest)): the
workspace then holds only AI-DLC and its records, and code pull requests carry
only code.
The record of the work lives once, in `aidlc/`, not once per repo, so a change
that touches both repos has one set of requirements and one audit trail.

The folder holding them does not have to be a git repo, and AI-DLC does not
make it one. Because it holds no `.git` or project file, `aidlc config` can ask you
to confirm the folder (in a script, pass `--project-dir`). What that means for
`aidlc/`:

- **Just you:** nothing to do. `aidlc/` stays on your disk, untracked.
- **A team:** run `git init` in the folder and push it as its own small
  workspace repo. The code repos stay separate repos with their own remotes, and
  the workspace repo must not track them, so keep them out first: for the repos
  listed in `repos.json`, the
  [`aidlc-workspace-sync`](12-cli-commands.md#aidlc-workspace-sync-clone-and-reconcile-the-declared-repo-set)
  tool does it for you; otherwise add an ignore line for each. Then run
  `git status` and commit what it lists (everything `aidlc config` wrote that git
  does not ignore, plus `repos.json`); the exact files differ by harness, so
  don't pick paths by hand. A teammate clones the workspace repo and runs the
  sync tool to clone the code repos beside it.
- **Codex CLI and Cursor:** Codex finds its hooks only in a git repo, and
  Cursor may skip them outside one
  ([Getting Started](01-getting-started.md)), so run `git init` in the folder
  whichever way you share it.

### Which layout

| Your situation | Use |
|---|---|
| The code is in one repo | One repo: install in it |
| One piece of work changes several repos | Several repos beside one `aidlc/` |
| Several teams share the same repos | One workspace, with a space per team (see Spaces, above) |
| Unrelated projects | A separate folder and `aidlc/` for each. They share no records, rules, or knowledge; only machine-wide settings and the active release reach both ([what carries over](#what-carries-over-and-what-doesnt)) |

What to commit in each layout is in [What's committed and what's not](#whats-committed-and-whats-not).

---

## Multiple repos in one intent

An intent isn't limited to a single repository. Because your code repos sit
beside `aidlc/` in the workspace folder (not nested inside any one of them), an
intent can span as many as it needs.

The repo set is captured **when the intent is created** — you don't type anything
extra. By default AI-DLC auto-discovers every sibling repo (each immediate child
of the workspace root that has its own `.git`) and records the set in the intent's
`intents.json` row. During Construction, each git operation is then anchored to
the right repo automatically.

```
my-project/
├── aidlc/          # AI-DLC's records
├── checkout-api/   # repo-a   ┐ both auto-discovered as siblings;
└── checkout-web/   # repo-b   ┘ an intent here can touch either or both
```

An intent that records no repos is the ordinary single-repo case. See
[Artifacts Reference](14-artifacts-reference.md) for the record-dir details and
[Multi-repo intent](glossary.md) in the glossary.

### Declaring the repo set (optional manifest)

Auto-discovery needs the sibling repos to already be cloned. On a fresh checkout
of a shared workspace they are not, so a teammate would have to know which repos
to clone and where. An **optional** `repos.json` manifest at the workspace root
records that expected set so it can be reproduced with one command:

```json
{
  "org": "your-github-org",
  "repos": [
    { "name": "checkout-api", "branch": "main" },
    { "name": "checkout-web" },
    { "name": "billing", "url": "https://gitlab.example.com/platform/billing.git", "path": "../billing" }
  ]
}
```

- `path` says where a repo's checkout lives: relative to the workspace (it may
  point outside it, as `../billing` does), absolute, or `"."` for the workspace
  folder itself. With no `path` the repo is the workspace's child folder of the
  same name. A checkout already at `path` is used as it is; an empty or missing
  folder there is cloned from `url`. A repo's folder may sit inside the
  workspace (`"src/billing"`), also when the workspace is a repo of its own that
  records that folder as a gitlink; each file then counts once, under its own
  repo. When the workspace folder holds files of its own that the work changes
  (a `docs/` folder, say), list the workspace too, as `"."`: with only the repos
  inside it listed, the reviews and change checks leave its folders out.
- `url` is any address git clones (GitHub https or SSH, GitLab, anything else).
  A blank `url` counts as not set.
- `org` is optional. With it, a repo with no `url` clones from
  `git@github.com:<org>/<name>.git`; without it, such a repo is not cloned, and
  the sync tool says how to add its `url`.
- `branch` selects the checkout for a new clone and is an advisory expectation
  for a repo already on disk; omit it to use the repo's own default.
- Repo names must be safe single path segments.

**Your own paths: `repos.local.json`.** When your disk differs from the team's
layout (your clones live in `C:/src`, say), put a `repos.local.json` beside
`repos.json`. It has the same shape and is read only for `path`, `url` and
`branch` of repos `repos.json` lists; a name `repos.json` does not list is
ignored, and `--doctor` and the sync tool say so in one line. It is never
committed: AI-DLC's own block in `.gitignore` lists it.

```json
{ "repos": [ { "name": "checkout-api", "path": "C:/src/checkout-api" },
             { "name": "billing", "path": "C:/src/billing" } ] }
```

On Windows, write paths with forward slashes; a path may carry a drive letter
or sit on another drive.

Wherever a repo lives, AI-DLC treats it as part of the project: a build waits
for its approved plan before writing there, and a Code Generation target in it
is spelled `<repo>/<path>`. When a repo is not where the files say, AI-DLC says
where it looked and the way forward: "billing is not at ../billing, where
repos.json puts it. Clone it there, or give its path in repos.local.json."

**Writing it from what is here.** When work built by teams records repos, in a
workspace with no `repos.json`, AI-DLC offers once, at a stage boundary, to
write it from the repos it finds: each one's folder, and the address its own
`origin` points to (read, never changed), blank when it has none. Your answer
is kept; it does not ask again in this clone.

The
[CLI Commands](12-cli-commands.md#aidlc-workspace-sync-clone-and-reconcile-the-declared-repo-set)
guide documents the `aidlc-workspace-sync` tool that reads this file to clone
missing repos, keep the gitignore block current, and generate a VSCode
multi-root workspace.

The manifest is a convenience, not a second source of truth. **Disk wins at
runtime**: intent creation records the declared repos that are on disk,
wherever their `path` puts them, plus every other child repo actually present,
so a repo works the moment it is cloned, and a declared repo that was never
cloned simply is not part of the set. A workspace whose only repo is itself
(`"path": "."`) records none, as a one-repo workspace always has. The manifest
also drives the sync tool and the advisory `--doctor` rows that flag when the
declared set and the disk have drifted apart. (This "workspace manifest" is
unrelated to a harness `manifest.ts`, which is a packaging file.)

---

## What carries over, and what doesn't

Everything AI-DLC knows lives in files, so sharing follows the folders: a space
is a boundary, a workspace is a boundary, and git carries files between people
and machines.

| What | Between intents in a space | Between spaces | Between projects (separate `aidlc/` folders) |
|---|---|---|---|
| Rules: `org.md`, `team.md`, `project.md`, `phases/` | Shared. Each stage reads the current files | A new space gets a one-time copy of the default space's `org.md` and the framework's phase rules; its `team.md` and `project.md` start empty. After that, nothing flows | Copy the files, or start from a template repo (below) |
| Learnings you keep | Land in the active space's `project.md`, or `team.md` when you promote them | Not shared. Each space has its own | Copy the lines you want |
| Your documents (`knowledge/`) | Shared. `associate` adds an intent to a document's list and can be repeated; a document with no intent is space-wide | Not shared. Each space has its own folder | `onboard` copies a file in and refuses a path outside the project, so copy the file into the other project |
| Code knowledge (`codekb/`) | Shared, per repo. A current scan can be reused by your choice | Not shared. Another space scans again | Each project scans its own. A teammate's clone of the same repo can reuse a scan |
| Saved scopes (`aidlc/scopes/`) | Shared | Shared by every space in the workspace | Copy the file |
| Output-format overrides (`memory/templates/`) | Shared | Per space. Not copied into a new space | Copy the files |
| Agents you add (in the harness folder) | Shared | Shared by every space | Copy the files |
| Repo list (`repos.json`) | One per workspace | One per workspace | Per project |
| Model and flag policy | Shared | Shared | Set once in the machine settings file and applied to every project on the machine. A project's own `aidlc.settings.json` overrides it value by value, except bypasses, which add up across the files ([the hierarchy](18-install-and-lifecycle.md)). Model and effort policy does not apply on Cursor and GitHub Copilot, where every agent uses the model you pick in the tool. On Kiro IDE only one agent's own model and effort apply; a preset or group effort does not. |
| Kiro CLI's session model, and the effort a preset sets | Shared | Shared | Saved in your personal Kiro settings, so every Kiro CLI project uses them. Changes to agent or group policy do not do this |
| Update, offline, mirror, and CA-bundle settings | Shared | Shared | Machine-only. A project file cannot set them |
| Kiro IDE's Workflows switch and, on Windows, its default terminal | Shared | Shared | Kept in Kiro's user settings, outside the project. Setup asks once (`aidlc config --yes` takes the recommended answer), and `aidlc config trust` changes them on request. They apply to every project you open in that IDE |
| Kiro CLI's Workflows switch | Shared | Shared | Kept in your own Kiro CLI settings, outside the project. In a Kiro IDE project, setup asks once, with an answer kept apart from Kiro IDE's (`aidlc config --yes` takes the recommended answer), and `aidlc config trust --kiro-cli-workflows off|on --yes` changes it on request. It applies to every project you run Kiro CLI in |
| The AI-DLC release itself | Shared | Shared | A native project with no pinned release (`.aidlc-version`) runs the release the machine has active, so `aidlc update` changes it for every such project (its own files catch up at its next `aidlc config`). A copied project runs its own copied release |

Apart from those machine-wide settings, IDE choices, and the active release, nothing in
AI-DLC links two projects.
Teammates get the shared files by pulling the repo, and the per-user files in
[What's committed and what's not](#whats-committed-and-whats-not) never travel.

### Standards for many projects

To give many projects the same starting rules, keep a template repo that holds
an `aidlc/` with the `org.md`, `team.md`, and knowledge files your organization
wants everywhere. A new project starts from a copy of it and adds its own
`project.md`. To roll out a change, change the template and bring the change into
each project the way you bring any other change, through a pull request.

If you refresh a project by copying a new release over it, the copy replaces the
default space's `org.md` and `phases/` rules with the shipped ones and keeps
`team.md` and `project.md`. Check the git diff before you commit
([Copy Channel](18-install-and-lifecycle.md#copy-channel)). A native
`aidlc config` refresh keeps every space's memory files
([Configure or Refresh a Project](18-install-and-lifecycle.md#configure-or-refresh-a-project)).

---

## What's committed and what's not

`aidlc/` is checked into git so a team **shares** its work — the method, the intent
registry, each intent's state, audit trail, and artifacts all travel with the
repo. Two kinds of file are deliberately **gitignored** instead:

| Gitignored (per-user, machine-local) | Why |
|---|---|
| `aidlc/active-space`, `…/intents/active-intent` | Cursors — "where am I right now." Committing them would turn per-user navigation into shared repository state and have teammates fight over intent creates and cursor switches. |
| `.../intents/<id>/runtime-graph.json`, `.aidlc-*`, `aidlc/.aidlc-sessions/`, `aidlc/.aidlc-active-space-*.tmp` | Derived, machine-local runtime state, including per-session bindings and PID ancestry entries. |
| `aidlc/.aidlc-request-text/` | A request the agent wrote to a file for the engine to read. Removed once the command goes ahead; one left there when it did not is your words, not shared work. |
| `repos.local.json` | Where *your* clones of the workspace's repos live, when your disk differs from the team's layout in `repos.json` (see [Declaring the repo set](#declaring-the-repo-set-optional-manifest)). It is yours alone. |
| `…/knowledge/documentkb/.journal/` | One directory per in-flight document transaction. Transient and per-clone; a committed journal would be a merge conflict on every concurrent `sync`. |
| `…/knowledge/.sources.local.json` | Where *this machine* finds documents that live outside the repo. The path is machine-specific by definition, so committing it would break every teammate's checkout. No command creates such a link today (`onboard` copies a file into `documents/`), so you will not normally see this file. |

Everything else under a space — `memory/**`, `knowledge/**`, `codekb/**`,
`intents.json`, each record's `aidlc-state.md`, `audit/` shards, and artifacts — is
committed. The rule of thumb: **cursors and runtime scratch are local; the shared
work is committed.**

`knowledge/documents/` and `knowledge/documentkb/` are both committed, but they are
owned by different parties and that difference is the whole design. `documents/`
holds your originals: you add, move, and delete files there, and the framework never
reorganises them. `documentkb/` is the catalog the tool derives, written
transactionally under the workspace lock. Its **index** is reconstructible: delete
`documentkb/index.json` alone and `/aidlc knowledge sync` rebuilds it from the
surviving per-document `metadata.json` files, tombstones included. Deleting the
whole `documentkb/` tree is a different, non-recoverable operation — it destroys
every `metadata.json` too, so document ids and tombstones are lost; `sync` then
re-onboards the surviving originals as new rows with new ids. That is also why
hand-editing `documentkb/` is a mistake rather than a shortcut: the next `sync`
reconciles it back to what `documents/` actually contains.

---

## Next Steps

- [Phases and Stages](04-phases-and-stages.md) — what happens inside one intent's run
- [Knowledge](08-knowledge.md) — adding your team's standards to a space's `knowledge/`
- [Rules and the Learning Loop](09-rules-and-the-learning-loop.md) — how a space's `memory/` method is authored and learned
- [Artifacts Reference](14-artifacts-reference.md) — the per-intent record dir in detail
- [CLI Commands](12-cli-commands.md) — the full `space` / `intent` verb reference
- [Glossary](glossary.md) — Space, Intent, Record dir, and Multi-repo intent defined
```
