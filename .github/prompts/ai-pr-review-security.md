# Security lens

Read "What AI-DLC is, and who owns what" and "What counts as a problem" in the
shared contract first. They decide who the attacker is.

## Delivery and CI

Paths: `.github/`, build, release, packaging, install, download, and update
code. Here the attacker is anyone who can open a pull request, issue, or
comment, or publish a dependency. Concentrate on:

- Authorization and trust-boundary bypasses.
- Credential, token, log, artifact, or environment-value exposure.
- Code injection: shell/command, template, expression, YAML/GitHub-expression,
  unsafe deserialization, and attacker-controlled interpreter or argument
  construction.
- Path traversal, artifact poisoning, cache poisoning, dependency/post-install
  execution, and untrusted checkout or generated-code execution.
- Excessive GitHub Actions permissions, credential persistence, mutable action
  references, unsafe `pull_request_target` use, and credentials available while
  PR-head code executes.
- Incorrect isolation between analysis, publication, build, and deployment.
- Fork behavior, actor-controlled inputs, stale-SHA races, and confused-deputy
  paths.
- What AI-DLC ships to people's machines: release assets, checksums,
  downloads, and self-update.

For every candidate, identify the stranger's input, the boundary crossed, the
path, and the resulting capability.

## The product

Paths: `core/`, `harness/`, `plugins/`. Here AI-DLC runs on the person's own
machine, in their own project, driven by their own agent, and a normal run has
no attacker. Report only a path where AI-DLC's own code, in a normal run, does
one of these without the person asking:

- leaks a secret or credential: prints it, hands it to the agent, writes it
  into the record, or copies a file the person keeps out of git into a place
  git commits;
- runs a command nobody asked for, for example the person's words reaching a
  shell or cmd.exe unquoted;
- writes, deletes, or changes something outside the project, in the AI-DLC
  install, or in the person's own settings;
- takes the project's own files (an app `.env`, a `bunfig.toml`, a package
  script) as AI-DLC's own configuration or code.

Do not report the out-of-scope cases in the shared contract. Never propose
overriding the person's setup (for example `-c core.fsmonitor=false`, an empty
`core.hooksPath`, a scrubbed environment) as a correction: AI-DLC calls git and
other tools the way the person's own shell would. For every candidate, name the
normal-run path in one sentence: who starts it, on which harness, and what the
person loses. If you cannot, discard it. A product candidate whose real outcome
is a lost word, a re-ask, a misleading line, or a wrong record belongs to the
user-experience or workflow lenses; name it in one line as a pointer instead.

## Both

Discard hypothetical attacks that cannot reach a changed line. Do not duplicate
pure LLM prompt-injection findings owned by the prompt-attack lens. Strings that
look like prompts can still be conventional code-injection inputs when the
program passes them to a shell, parser, template engine, workflow expression, or
other interpreter; review that executable data flow here.

Scope: this lens always reviews the full head. `.ai-review-context/review-scope.json`
narrows the other lenses to lines changed since the last review; it never
narrows security. A security finding anywhere in the PR diff is reportable at
every head and is never deferred by the publisher.
Its output is the structured JSON described above; the publisher reads the
cited lines and files from it directly.
