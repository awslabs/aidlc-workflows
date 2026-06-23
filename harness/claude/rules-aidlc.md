<!--
  .claude/rules/aidlc.md — the AIDLC method @-import stub (NOT a copy).

  The AIDLC method (the layered practice files: org/team/project + phase rules)
  is authored ONCE at the workspace root under aidlc/spaces/default/memory/ —
  the single hand-editable source of truth, identical on every harness. This
  file is a REFERENCE, not a copy: it pulls that method into Claude's ambient
  context via @-imports so casual chat (outside an AIDLC stage) sees the
  standing practices. AIDLC's own stage resolver reads the same tree directly
  (it never needs this stub).

  Claude @-imports name an EXPLICIT file each (no glob support — verified
  against code.claude.com/docs memory.md), resolve relative paths from THIS
  file's location, and follow a nested chain up to four hops. From
  .claude/rules/ the workspace root is ../../, so the method tree is
  ../../aidlc/spaces/default/memory/. The @-lines below ship pointed at the
  always-present `default` space; this file stays committed (it carries this
  load-bearing wiring beyond the pointer), and `/aidlc space <name>` re-points
  these @-lines IN PLACE so the next turn's ambient context follows the active
  space. At `default` the re-point is a byte-identical no-op. (AIDLC's own stage
  resolver follows the active-space cursor directly and never needs this stub.)

  Edit the METHOD at aidlc/spaces/default/memory/*, never here. If a new method
  file is added there, add a matching @-line below.
-->

@../../aidlc/spaces/default/memory/org.md
@../../aidlc/spaces/default/memory/team.md
@../../aidlc/spaces/default/memory/project.md
@../../aidlc/spaces/default/memory/phases/ideation.md
@../../aidlc/spaces/default/memory/phases/inception.md
@../../aidlc/spaces/default/memory/phases/construction.md
@../../aidlc/spaces/default/memory/phases/operation.md
