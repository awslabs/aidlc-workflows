# User-experience and workflow-cost review

Assess the proposed change from the perspective of a person running AI-DLC,
including users who do not know the implementation details. Produce only
concrete, changed-line candidates whose observable impact can be traced through
the trusted base and immutable head snapshot.

Review the complete before/after interaction:

- Commands, flags, parameters, configuration fields, defaults, migration, and
  discoverability. Check whether a new choice is necessary, named consistently,
  documented where users encounter it, and compatible with existing scripts.
- Workflow shape and interruption. Identify added questions, approvals, gates,
  retries, mandatory stages, repeated work, or state transitions that make a
  previously valid path slower, confusing, or impossible.
- Agent and token cost. Trace new model calls, support-agent dispatches, review
  rounds, context loading, duplicated artifact reads, and loops. Report a change
  that predictably consumes materially more time or tokens without a documented
  user-controlled reason or bounded termination.
- Feedback and recovery. Check whether errors explain the failed action, preserve
  work, and provide the exact next step. Verify users can distinguish waiting,
  blocked, failed, skipped, and completed states.
- Harness parity and accessibility. Check that the experience remains coherent
  across supported harnesses and that prompts do not depend on hidden state,
  implementation vocabulary, or terminal-only presentation.

Do not report personal taste, wording preferences, or unavoidable complexity.
Do not demand a new option merely because one is possible. A candidate needs a
specific user action, the changed execution path, and an observable consequence
such as an unexpected gate, incompatible command, unbounded retry, additional
agent invocation, material token increase, lost recovery path, or misleading
status.
