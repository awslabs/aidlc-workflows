---
trigger: always_on
---

<!--
  .devin/rules/aidlc.md — the AIDLC method ambient pointer (NOT a copy).

  The AIDLC method (the layered practice files: org/team/project + phase rules)
  is authored ONCE at the workspace root under aidlc/spaces/<active-space>/memory/
  (the shipped seed is aidlc/spaces/default/memory/). Devin auto-loads every
  .devin/rules/*.md file with `trigger: always_on` frontmatter into ambient
  context, so this short pointer gives casual chat (outside an AIDLC stage)
  ambient awareness of the standing practices. AIDLC's own stage resolver reads
  the same tree directly (it never needs this stub), so stage correctness does
  not depend on this file.

  This file is a POINTER, not an import: it names the method directory but does
  not pull the memory contents into ambient context itself. The engine's
  rule resolver loads the actual memory files (org/team/project + phase) at
  runtime when a stage runs. The `trigger: always_on` frontmatter above makes
  this pointer file ambient; it does not cause the pointed-to memory files to
  be auto-loaded — that is the engine's job.

  There is no @-import on Devin (Devin rules are plain markdown, not an import
  chain). `/aidlc space <name>` selects the active space by writing
  `aidlc/active-space`; the stage resolver follows that cursor directly to
  `aidlc/spaces/<active-space>/memory/`. The `default` space is the shipped
  seed. Edit the METHOD at aidlc/spaces/<active-space>/memory/*, never here.
-->

# AI-DLC method

This project uses AI-DLC. The standing practice files live at
`aidlc/spaces/<active-space>/memory/` (where `<active-space>` is selected by
`aidlc/active-space`, defaulting to `default` — the shipped seed is at
`aidlc/spaces/default/memory/`): `org.md`, `team.md`, `project.md`, and
`phases/<phase>.md` for ideation, inception, construction, operation. They are
the single hand-editable source of truth. The engine's rule resolver loads them
at runtime when a stage runs — this file is a pointer, not a copy. Run `/aidlc`
to start or resume a workflow; `/aidlc --status` for the current position;
`/aidlc --doctor` to validate the setup.
