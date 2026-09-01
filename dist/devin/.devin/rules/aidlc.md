<!--
  .devin/rules/aidlc.md — the AIDLC method ambient pointer (NOT a copy).

  The AIDLC method (the layered practice files: org/team/project + phase rules)
  is authored ONCE at the workspace root under aidlc/spaces/default/memory/ —
  the single hand-editable source of truth, identical on every harness. Devin
  auto-loads every .devin/rules/*.md file as an always-on rule, so this short
  pointer gives casual chat (outside an AIDLC stage) ambient awareness of the
  standing practices. AIDLC's own stage resolver reads the same tree directly
  (it never needs this stub), so stage correctness does not depend on this file.

  There is no @-import on Devin (Devin rules are plain always-on markdown, not
  an import chain). `/aidlc space <name>` does not re-point this file — the
  active-space cursor lives at aidlc/active-space and the stage resolver follows
  it directly. Edit the METHOD at aidlc/spaces/default/memory/*, never here.
-->

# AI-DLC method

This project uses AI-DLC. The standing practice files live at
`aidlc/spaces/default/memory/` (`org.md`, `team.md`, `project.md`, and
`phases/<phase>.md` for ideation, inception, construction, operation). They are
the single hand-editable source of truth, identical on every harness. Run
`/aidlc` to start or resume a workflow; `/aidlc --status` for the current
position; `/aidlc --doctor` to validate the setup.
