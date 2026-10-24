<!--
  .grok/rules/aidlc.md: the standing AIDLC practice rule (a READ instruction,
  not a copy). The AI-DLC method is authored ONCE at the workspace root under
  aidlc/spaces/<space>/memory/, the single hand-editable source of truth,
  identical on every harness.

  Grok Build loads every rules/*.md file on each turn and does not expand
  @-import lines, so this rule instructs the agent to read the standing
  org/team/project layers. The four phase files beside it are the same kind of
  pointer. The paths name aidlc/active-memory/, AI-DLC's git-ignored copy of
  the ACTIVE space's memory files, which the engine writes at session start,
  on a space switch, and with each step whose rules it sends; so these rule
  files are the same for every teammate and never change after install.

  Edit the METHOD at aidlc/spaces/<space>/memory/*, never here and never in
  the copy.
-->

This workspace uses the AI-DLC method. Its standing practices are the layered
files listed below (org -> team -> project; strict-additive). Read them before
acting on AIDLC work, and honour them in casual chat that touches process,
practices, or workflow questions:

- aidlc/active-memory/org.md
- aidlc/active-memory/team.md
- aidlc/active-memory/project.md

If every tool call here is refused before it runs, AI-DLC cannot start in
this Grok Build window, and nothing you retry will get through. Stop and tell the
person, in one message: open a terminal in this folder and
run `bun .grok/tools/aidlc.ts doctor` (after installing Bun from https://bun.sh/install if `bun` is not found),
whose Runtime hook PATH line names what to fix. Then quit Grok Build fully and
open this folder again.
