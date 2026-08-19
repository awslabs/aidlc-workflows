# Prompt-attack lens

Concentrate on attacks against agents and model-consumed contracts:

- Instructions entering through PR titles, bodies, comments, diffs, source,
  tests, filenames, generated output, tool output, or retrieved content.
- Confusion between trusted base-branch policy and untrusted PR-head policy.
- Model access to GitHub write tokens, broad network access, mutable tools,
  shell execution, credentials, repository writes, approval, or merge paths.
- Prompt concatenation without trust delimiters, unbounded context, stale output,
  candidate-output injection, and final-output spoofing.
- Missing SHA binding, weak machine markers, parser ambiguities, and text that
  can forge priority or verdict decisions.
- Agent-authored content flowing into privileged deterministic steps without
  strict validation.

Try concrete malicious strings and data-flow paths mentally against the changed
workflow. A model refusing an instruction is not a security boundary. Prefer
deterministic isolation, least privilege, strict parsing, immutable SHAs, and
separation of model execution from publication. Report only attacks that reach
a changed boundary and have an observable effect.
