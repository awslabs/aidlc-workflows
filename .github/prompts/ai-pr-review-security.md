# Security lens

Concentrate on reachable software and workflow security defects:

- Authorization and trust-boundary bypasses.
- Credential, token, log, artifact, or environment-value exposure.
- Injection, path traversal, unsafe deserialization, command construction,
  artifact poisoning, cache poisoning, and untrusted checkout execution.
- Excessive GitHub Actions permissions, credential persistence, mutable action
  references, unsafe `pull_request_target` use, and credentials available while
  PR-head code executes.
- Incorrect isolation between analysis, publication, build, and deployment.
- Fork behavior, actor-controlled inputs, stale-SHA races, and confused-deputy
  paths.

For every candidate, identify the attacker-controlled input, the privilege or
boundary crossed, the concrete path, and the resulting capability. Discard
hypothetical attacks that cannot reach a changed line. Do not duplicate pure
prompt-injection findings owned by the prompt-attack lens.
