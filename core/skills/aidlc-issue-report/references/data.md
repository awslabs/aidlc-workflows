# What safe.json holds

For whoever reads a folder this skill made. `safe.json` is the run's records as they were, with what could identify a
person, a company or a project replaced by labels. Nothing in it is a judgement: which events matter is the reader's call.

## Labels

A label stands for a value that was not AI-DLC's own word: `<custom-unit-3>`, `<custom-file-12>.ts`, `<custom-text-40>`.
Within one folder, the same value of one kind always gets the same label, so a repeat shows as the same label (the
same reply twice, the same file written nine times); a call's `input` label stands for the tool and its input together,
and a label from the redaction map can stand for a name's variants (an intent's folder and its short name). Labels from
two folders are unrelated.

| Kind | Stands for |
|---|---|
| `unit`, `intent`, `space` | a Unit's, an intent's or a space's name (`<unit-N>`, `<intent-N>` are the same, from the redaction map) |
| `file` | a project file, by its path; a common extension is kept beside it (`.ts`, `.md`) |
| `text` | anything a person or an agent wrote: a reply, a request, feedback, an agent's message, a question's option |
| `value` | a word in a field that holds names, which is not AI-DLC's (a plugin's stage, an unknown status) |
| `hash`, `id`, `session` | a digest or fingerprint, a record or call id, a session id (the same session id in `audit` and `transcripts`) |
| `field` | the name of an audit field AI-DLC's tools do not write |
| `stage`, `agent`, `hook`, `sensor`, `tool`, `model`, … | a name of that kind that is not AI-DLC's own (a plugin's, the team's) |
| `<project>`, `<aidlc-install>`, `<user>` | the project folder, the install folder, the machine's user |

## Sections

- `window`: the time span read (`since`, `until`, UTC) and `lastAidlcActivity`; `notes` when a given time was not used.
- `environment`: the OS line, Bun, the AI-DLC native install, each AI tool's version and where it was read
  (`path`, `known-location`, `app` = measured at collection; `person` = the person read it off the screen; a version
  from the tool's own log is under `transcripts[].toolVersions`), `toolsUsed`, `versionsMissing`.
  `kiroHomeEngine`: `chat.agentEngine` in the home folder's Kiro settings file (`file: false` = no such file). Which of
  the two decides has changed across Kiro CLI versions: on 2.21.1 the project's, on 2.33.1 only the home one
  (measured 2026-10-22: project `v3` alone gave a v2 session; home `v3` with project `v2` gave v3); between them it is
  not measured. What ran is `transcripts[].engine`.
- `trees`: each AI-DLC tree in the project.
  - `row`: `kiro-ide` = "Kiro" (Kiro IDE, and Kiro CLI on its v3 engine; the Kiro transcript's `tool` says which:
    `kiro (v3: Kiro CLI)`, `kiro (v3: Kiro IDE)`), `kiro` = "Kiro CLI (V2)", `claude`, `codex`, `copilot`, `cursor`,
    `opencode`.
  - `stampVersion`, `buildVersion`: a build made from AI-DLC's `main` stamps the plain release number; a `-preview.`
    build id is a nightly preview.
  - `channel`: `native` (the AI-DLC installer, command `aidlc`) or `copy` (files copied into the project, run by Bun).
  - `kiroEngine`: `chat.agentEngine` in the project's Kiro settings file.
- `intents`: each intent's state now (phase, current and next stage, status, scope, depth, Guard Policy, guards on and
  off, sensors, plan approval, each stage's mark).
- `audit`:
  - `rowsTotal`, `rowsInWindow`; `counts`: rows per event.
  - `rows`: every row of the run in time order: `seq`, `ts`, `event`, `intent`, and `fields`, each `[name, value]` in
    the order the record writes them. A value is kept as written where its field holds only AI-DLC's own words (an
    event, a stage, a phase, an agent, a sensor, a hook, a tool, a status), a number or a time. AI-DLC's own sentences
    (an error, a refusal, a command of its tools, a `phase > Unit > stage > file` context) keep their fixed text and
    label what was filled in. A path keeps AI-DLC's and the AI tool's own folders (`aidlc/spaces/default/intents/…`,
    `.aidlc-engine/reviews/…`, Kiro's steering folder) with the names in it labelled; any other path is a `file` label. A list
    (stages, changed files, options, languages) is a JSON array.
  - The rows written while this report was being made are not in `rows` or `counts`.
- `hooks`: each AI-DLC hook's last heartbeat (`last`) and the rows a hook dropped (`drops`: time, hook, reason).
- `sessionsFolder`: AI-DLC's sessions folder: open questions, approvals not yet bound, Kiro IDE requests pending,
  transcript cursors.
- `transcripts`: one entry per AI tool whose log names this project.
  - `events`: what happened, in time order: `seq`, `ts`, `session`, `kind`, and by kind `tool`, `input` (the call's
    input as a label: equal labels are the same input), `verb` (an AI-DLC command, AI-DLC's words only), `hook` and
    `owner` (`aidlc`, `other`, `unknown`) of a refusal, `detail` of a denial, `reply` (what the person typed, as a
    label). Kinds: `person-turn`, `call`, `aidlc-command`, `tool-error`, `tool-denied`, `approval-prompt`,
    `stop-hook-feedback`, `aidlc-hook-block`, `other-hook-block`, `hook-block` (a refusal whose record does not say
    whose). `noTime`: the tool logged no time of its own for it (Kiro CLI v2), so `ts` is its session's.
  - Counts over the same records: `sessions`, `prompts`, `toolCalls`, `toolErrors`, `denials`, `aidlcHookBlocks`,
    `otherHookBlocks`, `unattributedHookBlocks`, `stopFeedback`, `approvalPrompts`, `questionsAsked`, `aidlcCommands`,
    `repeats` (the same call input three times or more), `subagents`, `handRunChecks` (an AI-DLC check the agent ran
    itself, with the `pass` it printed; such a run writes no audit row).
  - The run as it was: `engine` (Kiro), `toolVersions` (from the tool's own log), `models`, `efforts`, `agents`,
    `approvalModes`. `reportSessions`, `mixedSessions`, `reportModels`: the sessions that made this report, kept out of
    the run's counts and events.
  - `notes`: what a reader could not tell from the records.
- `replies`: the typed replies checked against AI-DLC's `HUMAN_TURN` rows (by time, within ten seconds, and by session
  where both name one): `checked`, `recorded`, `notRecorded` (time and how each reached the tool), `inRunningTurn`,
  `noTime`.
- `otherStores`: chat stores on this machine that are not read (VS Code Copilot Chat, Cursor).
- `doctor`: whether AI-DLC's doctor ran, its exit, each finding of the export's own report (or of the lines doctor
  printed when there is none) with its id (a label when the id is not AI-DLC's) and severity, `checksFailed`; its export
  archive is not in the folder.
- `secretRules`: which installed AI-DLC file the secret rules came from.
- `knownGaps`: what the records cannot show.
