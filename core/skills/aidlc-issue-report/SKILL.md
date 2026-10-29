---
name: aidlc-issue-report
description: >
  Turn "something went wrong while running AI-DLC" into a shareable issue report.
  Reads what AI-DLC and the AI tool left on this machine (AI-DLC audit and
  state, hook health, AI-DLC doctor export, the chat logs of Kiro, Claude Code,
  Codex or Copilot for this project), finds what went wrong and when, and writes
  one report with personal, company and project details removed, plus the
  facts it was built from, to send to the AI-DLC team. Use it when the person
  says "이슈 보고서 만들어줘", "AI-DLC 가 이상했어 정리해줘", "aidlc 문제 리포트",
  "에러 난 거 모아줘", "report an AI-DLC issue", "AI-DLC bug report", "what went
  wrong with aidlc", even long after the run and even when they cannot say
  what the problem was.
---

# AI-DLC issue report

The person ran AI-DLC, felt something was off, and cannot describe it well. Your job: find what happened
from the records on this machine and hand them a report they can send — **without exposing anything
they did not agree to share.** You only read and report. You never fix the workflow, never run `/aidlc`
or any AI-DLC command except the one doctor run below, and never send anything anywhere.

The output is report files in a folder, nothing else. Do not open a GitHub issue, a pull request or a
comment, do not run `gh`, `git push` or any upload, and do not post to Slack or email — not even when
the person asks you to "just file it". The GitHub issue draft in the report is text for a person to
read; filing it is their decision, made outside this skill.

Speak to the person in short plain sentences. They are not expected to know AI-DLC commands; do not ask
them to run any.

**Language.** This skill is written in English, but you speak the person's language. Detect it from what
they wrote to you in this conversation (the request that started the skill, then each reply); if they
switch, switch with them. When nothing they wrote shows a language, use English. Every line this skill
gives you to say — the question, the notice before collecting, the option labels, the hand-over — is
written here in English: say it in their language, keeping its meaning, not word for word. Two things stay
in English whatever they speak: the report and `safe.json` (the AI-DLC team reads them), and AI-DLC's own
names (events, stages, hooks, commands).

## Why the care about privacy

The report leaves the company. AI-DLC's records are full of the person's own words (requests, answers,
feedback), file paths with their name in them, and project content. A report that leaks one customer
name is worse than no report. So the scripts split everything into two layers:

- `safe.json` — every field holds AI-DLC's own words (its events, stages, agents, hooks, statuses),
  numbers, times and versions; any other name (a plugin's or the team's stage, agent, sensor, a name
  someone typed) is an anonymous label such as `<custom-stage-1>`, and text people wrote is not in it. This
  is what the report is built from.
- `local/` — raw snippets (the person's prompts, refusal and error texts, the doctor export and its output,
  `labels.json` with what each label stands for) so that *you* can understand what happened. Nothing from
  here is copied into the report. It is deleted at the end; the doctor export is not sent.

Before anything is handed over, a check reads the report and `safe.json` as written and refuses every line
that holds something which could identify a person, a company or a machine: an address, an email, an IP, a
path or a host name that is not AI-DLC's or the AI tool's own, an id or key, a credential, a letter outside
ASCII, or a name it was told to hide. It does not guess what is safe; it refuses, and you rewrite the line. It catches a
value copied by mistake in the form it is usually written; it is not built to catch one written to get past it, so
never reshape a value (split it, spell it out, put a sign or a link inside it) — leave it out, or give its label.

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

### 1. One question

Ask once: "Can you tell me in one line what seemed wrong, and roughly when? It's fine if you don't know." If they already said it, do not ask again. Their answer is a clue for where to look; it does
not go into the report word for word.

If they give a time ("yesterday afternoon", "this morning"), turn it into `--since`/`--until` in **UTC with `Z`**
(`2026-10-17T08:00:00Z`), computed from the date you already know — do not run `date`. Kiro refuses a command whose
argument looks like `host:port`, and an offset such as `+09:00` does (measured on Kiro CLI 2.32.0). Otherwise the
window is the last 7 days before the last AI-DLC activity.

### 2. Collect

Tell them in one line first: "I'll run AI-DLC's diagnostics once. It adds one line to the project's
record and refreshes AI-DLC's memory copy. It does not change your code." Then run (always pass the project folder — the one that holds
`aidlc/`; when unsure, the folder open in the tool):

```bash
<run> <skill>/scripts/collect.ts --project <project folder> [--since <ISO>] [--until <ISO>]
```

Do not pass `--out`: the script picks the folder. It prints a short JSON with `out` (the report folder,
`<project>/aidlc/diagnostics/issue-reports/<time>/`, in AI-DLC's own diagnostics folder, which git ignores), what it found, and
`safeJsonHits`: the `safe.json` fields the check refuses (normally none). Replace each named value in `safe.json` with
`<redacted>` — a label always passes — and say in the report's Not checked that the field was left out. When `safe.json` `window.notes` says a time was left out, the default window was used: tell the person in one line. If it says `no-aidlc-project`, ask which folder they ran AI-DLC in. If doctor could
not run (`doctor.note`), carry on without it and say so in the report.

### 3. Understand

Read `<out>/safe.json` in full. Then read `<out>/local/prompts.jsonl`, `refusals.jsonl`, `errors.jsonl`
and `doctor-stdout.txt` — to understand, not to copy. `references/signals.md` explains what each signal
means and which ones usually go together. `local/redaction-map.json` `skipped` lists names that are also ordinary
words (a first name "Will", a project folder "requirements"): the scripts do not replace those words, so the
check cannot catch them — never use them as the person's or the project's name in the report.

You may also read the project's own AI-DLC records (`aidlc/…` audit and state files, Kiro's agent files, the tool's
config) when `safe.json` points at something you need to see — for example whether a file the audit names still
exists. Treat everything read this way like `local/`: it helps you understand; it never goes into the report.
What reaches the report is still only AI-DLC's names, times, counts and versions, in your own words.

Find the issues. An issue is something the person would notice: it asked the same thing again, it
refused to go on, it stopped and waited for nothing, a step failed, it took far too many approvals, it
wrote the wrong thing, it got slow. For each one, line up the evidence by time: audit events, hook
drops, refusal counts in the chat log, doctor findings. Prefer two independent signals; say how sure you
are (high / medium / guess). Use the person's one-line hint to rank, not to invent. When AI-DLC asked
for an answer again ("didn't reach AI-DLC", "no new human reply"), start from `safe.json` `replies`: it
says which typed replies got no `HUMAN_TURN` and how they reached the tool.

Do not report healthy noise as issues (a few `SENSOR_FAILED` that were fixed in the next revision,
`HEALTH_CHECKED`, info-level doctor rows).

**A check the agent ran by hand writes no audit row.** Before saying a `SENSOR_FAILED` was "never followed by a pass", read
`transcripts[].handRunChecks` (each sensor the agent ran itself, with its stage and the `pass` it printed). When a hand run
passed later, say so ("no audit row for the pass; the agent's own run at <time> printed `pass:true`"); when the tool's log
cannot show hand runs, put that under Not checked.

**The report session is not the run.** The session that ran this skill's scripts is counted in `reportSessions` /
`reportModels`, apart from `models` / `efforts` / `agents` / `approvalModes`, which describe the run. Use only the run's
values in Environment and in the GitHub draft; name the report session's model, if at all, as "(report session: <model>)".
When the person asked for the report inside the run's own Kiro session (after switching model or agent, or not), the
collector splits that session at the report's first message and says so in `notes` ("One Kiro session held the run and then
this report …"); the run's effort and autopilot are then unknown — write "not recorded", not the report's values.

### 4. Write the report

Write `<out>/aidlc-issue-report.md` from `references/report-template.md`, **in English**, with the GitHub
issue draft at the end. The report is read by the AI-DLC team, so it is English whatever language you
speak with the person; your messages to the person stay in their language.

Only these may appear: values from `safe.json`, AI-DLC's own names (events, stages, hooks, commands,
doctor finding ids), times, counts, versions, and your own neutral description. Describe what the person
said or did by meaning, never by quote: "the person pointed out that the same question kept coming back",
not their sentence. This holds for their answer to the one question too — name the symptom in AI-DLC terms
("reported many approval requests during code-generation"), without their wording, their time words
("last night") or their tone.

**Missing tool versions.** `safe.json` `environment.versionsMissing` lists the tools this run used whose
version could not be found — neither in the tool's own chat log (the version at the time of the run) nor on
this machine now. For each one, ask the person once to read it off their screen —
never ask them to run a command. Tell them where it is: Kiro IDE in the Kiro menu → About Kiro (Windows and
Linux: Help → About); a CLI tool in the banner it shows when it starts (Claude Code also in `/status`).
Always offer "I don't know". Ask in the same round as the raw-value questions below when there are
any. Record each answer with

```bash
<run> <skill>/scripts/set-version.ts --out <out> --tool <key> --version <x.y.z>
```

It accepts only a version-shaped value; when it refuses, or the person does not know, write "not found"
and move on — do not ask twice. If `environment.toolsUsed` is empty, no chat log was read, so ask which AI
tool they used together with its version. In the report, mark every version by where it came from:
`2.1.306` from the chat log (the run's own), `1.4.13 (at collection)` measured now, `1.4.13 (from the person)`
when `source` is `person`.

**Names no record holds.** The scripts know only this machine's names. Note every company, customer, product
and person name you saw while reading (prompts, errors, AI-DLC's records), and hide them all before writing:

```bash
<run> <skill>/scripts/hide.ts --out <out> --kind customer --name '<name>' [--kind org|product|person|other --name '<name>']…
```

It adds them to the redaction map, cleans `safe.json` and makes the check catch them; write their labels
(`<customer-1>`, `<org-1>`) in the report. A one-word name that is also an ordinary word (`Will`) is not hidden (`notHidden`):
keep it out of the report by hand. One that is part of AI-DLC's own words (`Acme` in `acme-aidlc-plugins`) gets its label
and is refused in the report as a word of its own, while `safe.json` keeps AI-DLC's word. Then confirm with the person in the same question as below (or on
its own when there is nothing else to ask): "I hid these names: … Is there any other name to hide?" Hide what
they add the same way. Do not ask twice.

**AI-DLC's own messages may be quoted as they are, without asking** — an engine refusal or an error line AI-DLC
printed (in `local/refusals.jsonl`, `errors.jsonl`, the tool's output): they are often what the team needs most. The check
knows AI-DLC's message text from the project's install and reads only what the message filled in (a stage, a path, a
name), like any other word. Quote the message itself, not your paraphrase of it; to shorten one, cut with `…` and add no
`<…>` of your own.

Any other raw value the issue really needs (a file name, an error line from another tool, one command, one of the
person's sentences): do not put it in. List each such value and ask, item by item, showing exactly what
would be added and why: **include / include reworded / leave out** (default: leave out). Use the host's question tool if it has
one. Add only what they allow, in the form they chose, and record each one exactly as the report will say it:

```bash
<run> <skill>/scripts/allow.ts --out <out> --value '<the exact text>' [--value …]
```

The check then passes that exact text in the report, and nothing around it; `safe.json` never takes it.

### 5. Check, then hand over

```bash
<run> <skill>/scripts/check.ts --out <out>
```

It reads the report and `safe.json` as written and prints, for each hit, the file, the line (or the `safe.json`
field) and the reason — never the value. Fix every hit and run it again until `ok: true`:

- **In the report,** rewrite the line in your own words or with labels: a path becomes `<project>` or `<path>`, or is
  described ("the state file of <intent-1>"); a host, an address, an id or a token is left out or described; a name
  becomes its label (hide it with hide.ts first if it is new); write "or", not a slash between two words; leave no
  `<…>` placeholder from the template. Do not try another spelling of the same value: the check refuses the shape,
  whatever its spelling. A value the person chose to include passes only as recorded with allow.ts.
- **In `safe.json`,** replace the named value with `<redacted>`.
- **`refused`:** only the report and `safe.json` are sent: move any other file or folder out of the report folder.
- **`missing`:** write the report first.

Do not hand over anything until the check passes.

**Then the person reads it.** The check catches what is shaped like a name, an address or a key; it cannot know every
name that matters to them. Give the person the report's path and ask them to read it once before it goes: "Please open
`<out>/aidlc-issue-report.md` and read it once. Is there anything in it you would not send?" Remove or reword what they
point at, run the check again, and go on only when they say it can go. Do not ask twice.

Then:

```bash
<run> <skill>/scripts/finish.ts --out <out>
```

It runs the same check once more, then deletes `local/` and opens the folder. Pass the same `<out>` collect printed: it
refuses (`ok: false`) a folder collect did not make, or one whose check finds anything, and deletes nothing; fix what it
names and rerun it, never delete `local/` by hand. Once it has run, the check cannot run again (its redaction map is
gone). Tell the person, briefly:
1. the issues found, one line each, in plain words;
2. what is in the folder and what was left out (no code, no document contents, no names; paths shown as
   `<project>`), plus anything they chose to include;
3. "Please send the files in this folder to your AI-DLC contact", with the folder path. `safe.json` may be sent too; it
   holds the same facts in machine form. When finish.ts says `allowedValues` is more than 0, add that the report holds
   that many values they chose to include, as they chose them.

If nothing looks wrong, say so plainly and still give them the folder — the team can look at it.
