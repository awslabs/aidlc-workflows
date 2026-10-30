# Report template

Write in English, whatever language you speak with the person. Keep every value to what `safe.json`
holds, AI-DLC's own names, or what the person agreed to include. Labels like `<project>`, `<user>`,
`<intent-1>` stay as they are. Join two values with a word ("project v3 and home v3"), not a slash: the check reads
`a/b` as a path.

```markdown
# AI-DLC issue report — <YYYY-MM-DD>

## At a glance
- Issues found: N. The biggest: <one plain line>.
- What the person said (meaning only): <one line, or "nothing specific">

## Environment
| Item | Value |
|---|---|
| OS | … |
| AI tool | <tool> <version> — the transcript `tool` label in `safe.json` (not the row name: `kiro-ide` serves Kiro CLI too). Version: `transcripts[].toolVersions` when there is one (the run's), else `environment.tools` marked "(at collection)", "(from the person)" when `source` is `person`, "not found" when null |
| Model · effort | the run's main agent `models` / `efforts` with session counts (not `reportModels` — the session making this report); approval mode from `approvalModes`; Kiro agent from `agents` |
| Kiro engine | configured: project `…` / home `…`; ran: `v3` / `v2` (see signals.md) |
| AI-DLC | stamp `…` · build `…` · `native` / `copy` |
| Harness row | `kiro-ide` |
| Scope · depth | scope `…`, depth `…`, test strategy `…` |
| Window | <since> – <until> (UTC) |

## Issues

### 1. <what the person would call it, e.g. "kept asking for the same approval">
- Trying to: <stage / step, e.g. "approve the code-generation plan in Construction">
- What happened: <plain description>
- Evidence: <time range> · <event names and counts> · <hook / refusal counts> · doctor `<finding-id>`
- Confidence: high / medium / guess — <why>

### 2. …

## Not checked
- <from `knownGaps` and anything you could not read, e.g. "Cursor chat history is not read by this version">

## What is in this report and what is not
- Included: AI-DLC event names, times and counts, stage names, versions, doctor finding ids
- Left out: source code, document and answer contents, names of people, companies and projects
  (→ `<user>`, `<org>`, `<project>`), user names in paths
- AI-DLC's own messages quoted: <count, or "none">
- Values the person chose to include: <list, or "none">
- Files sent with it: `safe.json` (the facts this report was built from). AI-DLC's own diagnostic export is
  not included: it can carry text people wrote; if the AI-DLC team asks for it, `/aidlc --doctor --export`
  makes one, which this report's check has not read

---

## Appendix — GitHub issue draft

**Title:** <short symptom, e.g. "kiro-ide: plan approval asked again after Approve (Construction, code-generation)">

**Environment:** AI-DLC stamp <stamp> build <build>, <native or copy>, row `<row>`, engine configured project `<v>` and home `<v>` · ran `<v3>`, <tool + version>, model `<the run's model>`, <OS>.

**What happened:** <2–4 sentences, neutral>

**Evidence (from the person's machine, redacted):**
- <event / count / time lines>
- doctor findings: `<ids>`

**Expected:** <one line>

**Not checked:** <one line>
```
