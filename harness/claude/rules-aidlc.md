<!--
  .claude/rules/aidlc.md: the AIDLC method @-import stub (NOT a copy to edit).

  The AIDLC method (the layered practice files: org/team/project + phase rules)
  is authored ONCE at the workspace root under aidlc/spaces/<space>/memory/,
  the single hand-editable source of truth, identical on every harness. This
  file is a REFERENCE: it pulls the method into Claude's ambient context via
  @-imports so casual chat (outside an AIDLC stage) sees the standing
  practices. AIDLC's own stage resolver reads the space's tree directly (it
  never needs this stub).

  The @-lines name aidlc/active-memory/: AI-DLC's git-ignored copy of the
  ACTIVE space's memory files, which the engine writes at session start, on a
  space switch, and with each step whose rules it sends. So this file is the
  same for every teammate and never changes after install, while each person's
  copy follows their own active space.

  Claude @-imports name an EXPLICIT file each (no glob support, verified
  against code.claude.com/docs memory.md), resolve relative paths from THIS
  file's location, and follow a nested chain up to four hops. From
  .claude/rules/ the workspace root is ../../.

  Edit the METHOD at aidlc/spaces/<space>/memory/*, never here and never in
  the copy. If a new method file is added there, add a matching @-line below.
-->

@../../aidlc/active-memory/org.md
@../../aidlc/active-memory/team.md
@../../aidlc/active-memory/project.md
@../../aidlc/active-memory/phases/ideation.md
@../../aidlc/active-memory/phases/inception.md
@../../aidlc/active-memory/phases/construction.md
@../../aidlc/active-memory/phases/operation.md
