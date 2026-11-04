# The Command Center

The Command Center is a local web page that shows your AI-DLC work as it
happens: every project on your machine, each piece of work in it, which stage
it is at, what was decided, what was produced, what was reviewed, what the team
learned, and what went wrong. It updates on its own while a workflow runs, so
you can keep it open in a browser tab beside your coding agent.

It is read-only and private to your machine. It listens on `127.0.0.1` only,
makes no AI calls and no outbound network requests, and changes nothing in
your projects.

## Opening it

In your coding agent:

```
/aidlc dashboard
```

The agent starts the Command Center in the background and gives you its link.
Your browser opens to it. In a terminal, the same thing is:

```
aidlc dashboard
```

On a copy-channel install, run `bun .claude/tools/aidlc.ts dashboard` (with your
harness directory in place of `.claude`).

When you open it from inside an AI-DLC project, that project is added
automatically, including a fresh clone. The link includes a one-time code, and
usually a new port, every time it starts, so a bookmark stops working after a
restart. To come back to it, run `/aidlc dashboard` again and use the link it
prints.

## What you see

- **Home**: one card per piece of work across your projects, with its phase,
  current stage, whether it is waiting for you, and when it last moved. A strip
  at the top lists what needs your attention.
- **A piece of work**: its timeline of stages and units, then tabs for
  **Decisions** (the questions asked and the answers given), **Artifacts** (the
  documents each stage produced), **Reviews** (reviewer verdicts and findings),
  **Learnings** (corrections that became rules), **Issues** (refusals, failed
  checks and recoveries, each with its recorded cause), and **Tokens**.
- **Health**: issues across every project, with the evidence AI-DLC recorded
  and, where there is one, the fix.

Every number comes from AI-DLC's own records. A value the records do not
support shows as `—` and names what is missing; nothing is estimated. Token
figures come from Claude Code's usage records, so other harnesses show `—`
there.

## Adding projects

Open **Workspaces & settings** to add folders. A folder that holds AI-DLC
projects in its subfolders is scanned for them; a single project can be pinned
on its own. From the terminal:

```
aidlc dashboard --root ~/code          # scan this folder for AI-DLC projects
aidlc dashboard --pin ~/code/my-app    # add one project
```

A project you create later under a folder you added shows up within about 15
seconds. Folders you add are remembered in `~/.aidlc/dashboard.json`. Set
`AIDLC_DASHBOARD_CONFIG` to keep that file somewhere else.

Reading Claude Code transcripts to find hook failures is off by default. Turn
it on in **Workspaces & settings** if you want those issues too.

## Options

| Option | Meaning |
|---|---|
| `--port <n>` | Port to listen on, on `127.0.0.1` (default: any free port) |
| `--no-open` | Do not open a browser; just print the link |
| `--json` | Print `{"url": ..., "port": ...}` as one line, then keep serving |
| `--root <dir>` | Add a folder to scan for AI-DLC projects (repeatable, remembered) |
| `--pin <dir>` | Add one AI-DLC project (repeatable, remembered) |
| `--config <file>` | Settings file to use instead of `~/.aidlc/dashboard.json` |

## Stopping it

Press **Ctrl-C** in the terminal that runs it. When your agent started it, ask
the agent to stop it, or stop the background command. Closing the browser tab
does not stop it.

## Privacy and security

- It listens on `127.0.0.1` only. Other machines cannot reach it, and there is
  no option to change that.
- Requests must carry the one-time code from the link, and requests addressed
  to any other host name are refused. A web page in another tab therefore
  cannot read your work through it.
- It only reads AI-DLC records (`aidlc/` folders, audit logs, stage
  documents) and, when you turn it on, Claude Code transcripts. The only file
  it writes is its own settings file.
- It makes no AI calls and sends nothing anywhere, so running it costs nothing.

## Troubleshooting

| You see | What to do |
|---|---|
| `the Command Center UI bundle is missing from this install` | Reinstall or update AI-DLC (`aidlc update`), then try again. |
| `Could not start the Command Center: ...` with a port in use | Leave out `--port` to use any free port, or pick another one. |
| `401 Unauthorized`, or the page does not load | The link is from an earlier run. Run `/aidlc dashboard` again and use the link it prints. |
| A project is missing | Add its folder in **Workspaces & settings**, or start the Command Center from inside the project. |

---

## Navigation

← [Install and Lifecycle](18-install-and-lifecycle.md) | [User Guide](00-introduction.md)
