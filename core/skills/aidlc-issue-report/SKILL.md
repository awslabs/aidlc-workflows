---
name: aidlc-issue-report
description: >
  When something went wrong while running AI-DLC, gather what the run left
  behind on this machine (AI-DLC's audit record and state, hook health,
  AI-DLC doctor, the chat logs of Kiro, Claude Code, Codex or Copilot for this
  project) into one folder, with personal, company and project details
  replaced by labels, for the person to send to the AI-DLC team, who analyse
  it. It does not diagnose anything itself. Use it when the person says
  "이슈 보고서 만들어줘", "AI-DLC 가 이상했어 정리해줘", "aidlc 문제 리포트",
  "에러 난 거 모아줘", "report an AI-DLC issue", "AI-DLC bug report", "what went
  wrong with aidlc", even long after the run and even when they cannot say
  what the problem was.
---

# AI-DLC issue report

The person ran AI-DLC and something went wrong. Their part ends when they send a folder to the AI-DLC team; the
team analyses it on their own machines. Your job is to gather that folder — **as much of the run's records as
possible, with nothing that could identify a person, a company or a project.** You do not diagnose, rank or explain
what went wrong: the scripts gather and filter, the team reads. You never fix the workflow, never run `/aidlc` or any
AI-DLC command except the one doctor run below, and never send anything anywhere.

The output is files in a folder, nothing else. Do not open a GitHub issue, a pull request or a comment, do not run
`gh`, `git push` or any upload, and do not post to Slack or email — not even when the person asks you to "just file
it". Sending the folder is their decision, made outside this skill.

Speak to the person in short plain sentences. They are not expected to know AI-DLC commands; do not ask them to run any.

**Language.** This skill is written in English, but you speak the person's language. Detect it from what they wrote
to you in this conversation (the request that started the skill, then each reply); if they switch, switch with them.
When nothing they wrote shows a language, use English. Every line this skill gives you to say is written here in
English: say it in their language, keeping its meaning, not word for word. The folder's files stay in English.

## Why the care about privacy

The folder leaves the company. AI-DLC's records are full of the person's own words (requests, answers, feedback),
file paths with their name in them, and project content. So the scripts write two layers:

- `safe.json` — the data that is sent. Every value is AI-DLC's own word where its field holds only AI-DLC's words (an
  event, a stage, an agent, a status), a number, a time or a version; any name the person chose (a Unit, an intent, a
  file) and anything a person or an agent wrote is a label such as `<custom-text-12>`, the same value the same label.
  `references/data.md` says what each part holds.
- `local/` — what the labels stand for, and what the check needs. It is never sent and is deleted at the end.

Before anything is handed over, a check reads every file in the folder as written and refuses any value that is not
what its field's rule writes, and any line of the cover that holds something which could identify a person, a company
or a machine. It does not guess what is safe; it refuses.

## Steps

The scripts are in this skill's `scripts/` folder (`<skill>` below is this skill's folder). Each command below starts
with `<run>`, which runs one of them from any folder:

- `bun`, when it is found;
- otherwise (a native AI-DLC install brings no Bun) AI-DLC's own `aidlc` command, with `BUN_BE_BUN` set for that one
  command:
  - macOS, Linux, WSL: `BUN_BE_BUN=1 aidlc <script> …`
  - Windows PowerShell: `& { $env:BUN_BE_BUN = '1'; try { aidlc <script> … } finally { Remove-Item Env:BUN_BE_BUN } }`
  - Windows cmd: `cmd /c "set BUN_BE_BUN=1&& aidlc <script> …"`

Never leave `BUN_BE_BUN` set in the shell: any `aidlc` run with it starts Bun instead of AI-DLC. If `aidlc` is
not found either (an editor opened before AI-DLC was installed), use the executable named in
`~/.local/share/aidlc/active-executable` (Windows: `%LOCALAPPDATA%\aidlc\active-executable`) in its place.

### 1. When

Ask once: "Roughly when did it happen? It's fine if you don't know." If they already said it, do not ask again.
Turn a time they give ("yesterday afternoon", "this morning") into `--since`/`--until` in **UTC with `Z`**
(`2026-10-17T08:00:00Z`), computed from the date you already know — do not run `date`. Kiro refuses a command whose
argument looks like `host:port`, and an offset such as `+09:00` does (measured on Kiro CLI 2.32.0). Otherwise the
window is the last 7 days before the last AI-DLC activity. What they said does not go into the folder.

### 2. Collect

Tell them in one line first: "I'll run AI-DLC's diagnostics once. It adds one line to the project's record and
refreshes AI-DLC's memory copy. It does not change your code." Then run (always pass the project folder — the one that
holds `aidlc/`; when unsure, the folder open in the tool):

```bash
<run> <skill>/scripts/collect.ts --project <project folder> [--since <ISO>] [--until <ISO>]
```

Do not pass `--out`: the script picks the folder. It prints a short JSON with `out` (the folder,
`<project>/aidlc/diagnostics/issue-reports/<time>/`, in AI-DLC's own diagnostics folder, which git ignores), what it
gathered, and `safeJsonHits`: the `safe.json` fields the check refuses (normally none). Replace each named value in
`safe.json` with `<redacted>` — a label always passes — or, where the reason says to remove it, delete that field (that key, for a key a part does not have). When `safe.json` `window.notes` says a time was left out, the
default window was used: tell the person in one line. When `found.aidlcWords` is 0, AI-DLC's own words could not be read
from this install, so every AI-DLC name in the folder is a label: tell the person in one line. If it says `no-aidlc-project`, ask which folder they ran AI-DLC in.

### 3. Missing tool versions

`safe.json` `environment.versionsMissing` lists the tools this run used whose version could not be found — neither in
the tool's own chat log nor on this machine now. For each one, ask the person once to read it off their screen — never
ask them to run a command. Tell them where it is: Kiro IDE in the Kiro menu → About Kiro (Windows and Linux: Help →
About); a CLI tool in the banner it shows when it starts (Claude Code also in `/status`). Always offer "I don't know".
If `environment.toolsUsed` is empty, no chat log showed which tool the run used (one may have held only this report, or could not be read), so ask which AI tool they used together with its version.
Record each answer: write the version as they gave it to `<out>/local/version-<key>.json` (the `<key>` of the command)
with your file-writing tool, never in a command (`{ "version": "1.4.13" }`), then run

```bash
<run> <skill>/scripts/set-version.ts --out <out> --tool <key>
```

It accepts only a version-shaped value; when it refuses the value (`not-a-version`), or the person does not know, move
on — do not ask twice. When it refuses the file itself, write it again and run it again.
When they name the tool but not its version, run it without writing the file: the tool is recorded, its version unknown.

When the person names a company, customer, product or person they want kept out, hide it. Write the names to
`<out>/local/hide-names.json` with your file-writing tool, never in a command, since a shell would read a name's `&` or
apostrophe as its own syntax (`[{ "kind": "customer", "name": "<name>" }, …]`, kind `customer`, `org`, `product`,
`person` or `other`), then run

```bash
<run> <skill>/scripts/hide.ts --out <out>
```

When it refuses, correct what it names in the file (`entries` are places in it) and run it again; a name of one
character cannot be hidden, so take it out and tell the person.
When it lists `notHidden`, those names (by their place in the file) were not hidden: `aidlc-word`, the name
is part of AI-DLC's own words (`Bolt` in `BOLT_FAILED`) or of an AI-DLC message's fixed text, or
`ordinary-word`, it is an everyday word (`Will`). Tell the person in one line each, and ask once whether to hide them
anyway: each of AI-DLC's words or messages holding the name, or each value holding that word, then becomes a label, and
the team reads less of the run. If they say yes, write only those names to `<out>/local/hide-everywhere.json` and run

```bash
<run> <skill>/scripts/hide.ts --out <out> --everywhere
```

then collect a new report from this one (the folder it prints in `from`):

```bash
<run> <skill>/scripts/collect.ts --from <from>
```

It makes a new folder with the same window, the names already hidden, the versions the person gave and doctor's result
(doctor is not run twice), with the words holding those names no longer read as AI-DLC's. Read its result as in step 2,
and from then on use its `out`. If it says `project-not-found`, the project moved: add `--project <its folder now>`.
Then remove the earlier folder, which is not sent:

```bash
<run> <skill>/scripts/finish.ts --discard --out <the earlier out>
```

`emptyFolderLeft`: only the empty folder could not be removed (a window or shell has it open); tell the person they can
delete it. `folder-in-use`: close what has it open (a window, a shell in it) and run it again; when its hint says the
folder holds no report any more, tell the person they can delete it.

The report's own field names, the same in every report, stay as they are. If they say no, leave them, and do not ask
again.

### 4. Cover, check, hand over

```bash
<run> <skill>/scripts/cover.ts --out <out>
<run> <skill>/scripts/check.ts --out <out>
```

`cover.ts` writes `aidlc-issue-report.md` from `safe.json`: the window, the versions, what the folder holds and what
was replaced by labels. Do not edit it; run it again after any change to `safe.json`. `check.ts` prints, for each hit,
the file, the line or the `safe.json` field, and the reason — never the value. In `safe.json`, replace the named value
with `<redacted>`; `refused`: only the cover and `safe.json` are sent, so move any other file out of the folder;
`pending`: an answer you wrote is not applied yet (the run stopped before its script), so run the command it names, or
delete its file when the person took the answer back. Run
`cover.ts` and `check.ts` again until `ok: true`. Do not hand over anything until the check passes.

**Then the person reads the cover.** "Please open `<out>/aidlc-issue-report.md` and read it once. It says what is in
the folder. Is there anything you would not send?" Hide what they name (step 3), run `cover.ts` and `check.ts` again,
and go on only when they say it can go. Do not ask twice.

Then:

```bash
<run> <skill>/scripts/finish.ts --out <out>
```

It runs the same check once more, then deletes `local/` and opens the folder. Pass the same `<out>` collect printed: it
refuses (`ok: false`) a folder collect did not make, or one whose check finds anything, and deletes nothing; fix what
it names and rerun it, never delete `local/` by hand. Tell the person, briefly: what the folder holds (in one line, from
the cover), that names, paths and anything they typed were replaced by labels (and, if they chose to leave a name in
step 3, that it was left), and "Please send the files in this folder to your AI-DLC contact", with the folder path.
