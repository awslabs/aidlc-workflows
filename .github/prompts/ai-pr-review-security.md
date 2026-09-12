# Security lens

Concentrate on reachable software and workflow security defects:

- Authorization and trust-boundary bypasses.
- Credential, token, log, artifact, or environment-value exposure.
- Traditional code injection: shell/command, SQL/NoSQL, template, expression,
  header, log, path, regex, YAML/GitHub-expression, unsafe deserialization, and
  attacker-controlled interpreter or argument construction.
- Path traversal, artifact poisoning, cache poisoning, dependency/post-install
  execution, and untrusted checkout or generated-code execution.
- Excessive GitHub Actions permissions, credential persistence, mutable action
  references, unsafe `pull_request_target` use, and credentials available while
  PR-head code executes.
- Incorrect isolation between analysis, publication, build, and deployment.
- Fork behavior, actor-controlled inputs, stale-SHA races, and confused-deputy
  paths.

For every candidate, identify the attacker-controlled input, the privilege or
boundary crossed, the concrete path, and the resulting capability. Discard
hypothetical attacks that cannot reach a changed line. Do not duplicate pure
LLM prompt-injection findings owned by the prompt-attack lens. Strings that look
like prompts can still be conventional code-injection inputs when the program
passes them to a shell, parser, template engine, workflow expression, or other
interpreter; review that executable data flow here.
