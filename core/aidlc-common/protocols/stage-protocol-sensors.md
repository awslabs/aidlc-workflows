# Sensors Protocol Module

Load this module when the engine lists `sensors` in `directive.protocol_modules`: `directive.ceremony.sensors` is `on`.

### A blocking gate sensor at the approval gate

At stage-protocol.md section 2, Part 0 step 2:
- When `directive.ceremony.sensors === "on"`, if the report instead refuses because a blocking gate sensor found issues or could not produce a verified pass, the approval gate is NOT open. In interactive mode, run `{{INVOKE}} engine log decision --stage <slug> --decision "Blocking gate sensor failure" --options "Fix findings,Override blocking sensors"` and present those two options as a separate structured question. END YOUR TURN.
- **Fix findings**: after the human selects it, record `aidlc-log.ts answer --stage <slug> --details "Fix findings"`, fix the named findings or evaluation failure, then retry the ordinary report with no override.
- **Override blocking sensors**: after the human selects it, record `aidlc-log.ts answer --stage <slug> --details "Override blocking sensors"`, then retry the same report with `--override-blocking-sensors --user-input "Override blocking sensors"`. The state tool requires the exact offered option, a `HUMAN_TURN`, and the matching decision/answer receipt; a bare flag fails. Never offer or attempt this option under `Construction Autonomy Mode: autonomous` — unattended runs halt loudly.

### Sensor Imports

The instructions in this section apply only when `directive.ceremony.sensors === "on"`. When it is `"off"`, `sensors_applicable` is empty: no sensor correction, rerun, gate-blocking, or sensor-override instructions apply. Ordinary artifact verification and approval gates remain required.

A stage's `sensors:` frontmatter list is its complete set of imported checks.
Each named manifest defines its file match, command, time budget, `fire_on`
timing, and `default_severity`; only sensors imported by the stage are eligible
to run. `fire_on: write` runs during matching writes and remains advisory in
this release, even when the manifest declares `blocking`. `fire_on: gate` runs
against matching declared deliverables when the stage enters or re-enters its
approval gate. Advisory outcomes emit their audit rows but do not stop the
gate; a gate the engine approves itself under Construction autonomy runs only
its blocking sensors, since advisory evidence has no reader there. A blocking gate sensor requires a verified pass: findings, unavailable
evaluation, malformed output, and timeouts refuse gate entry until the issue
is fixed or the human-backed override flow above completes. Autonomous mode
cannot override a blocking sensor.

Failed checks emit a `SENSOR_FAILED` audit row and write findings to
`<record>/.aidlc-engine/sensors/<stage-slug>/<sensor>-<fire-id>.md`.

When a gate opens, or is shown again, the engine's reply names each check that
still fails on a declared output in its `narration`
on its own line after what the stage produced: say it to the person with the
approval question, never claim coverage a
check reports against (every requirement traced, every section present), and
when they ask for changes, correct from that detail file and run the check
again. A Unit's own gate names that Unit's outputs only; with Sensors off,
nothing is said about checks.

`required-sections` applies to markdown outputs. Unless a stage declares a
more specific contract, it enforces the registry default of at least two H2
headings. A stage's `## Sensors` compartment may retain extra requirements for
particular files. Timestamp markers (`<slug>-timestamp.md`) are run records
and always pass.

`upstream-coverage` compares output prose with the stage's `consumes:`
frontmatter. Every required artefact that exists must be referenced so the
output shows which upstream inputs informed it; an optional one
(`required: false`) is not checked unless the stage lists it under `cites:`. Stages with no required or cited `consumes:` pass
this check trivially. The compact `Imports:` and `Upstream targets:` lines in
each stage file are the local summary; frontmatter remains authoritative when
checks are resolved.
