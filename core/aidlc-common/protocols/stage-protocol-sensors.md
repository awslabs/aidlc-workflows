# Sensors Protocol Module

Load this module when the engine lists `sensors` in `directive.protocol_modules`: `directive.ceremony.sensors` is `on`.

### A blocking gate sensor at the approval gate

At stage-protocol.md section 2, Part 0 step 2:
- When `directive.ceremony.sensors === "on"`, if the report (or a Unit checkpoint's `verify`) instead refuses because a blocking gate sensor found issues or could not produce a verified pass, the approval gate is NOT open. At a checkpoint the refusal names the `--unit` for `log decision` and `log answer` and the `verify` to retry, and, when the person overrode the same check at an earlier Unit, a line to say just before the question; use those as written, with `<check>` filled as the refusal says. In interactive mode, run `{{INVOKE}} engine log decision --stage <slug> --decision "Blocking gate sensor failure" --options "Fix findings,Override blocking sensors"` and present those two options as a separate structured question. END YOUR TURN.
- **Fix findings**: after the human selects it, record `aidlc-log.ts answer --stage <slug> --details "Fix findings"` (with the refusal's `--unit` at a checkpoint), fix the named findings or evaluation failure, then retry what the refusal named with no override.
- **Override blocking sensors**: after the human selects it, record `aidlc-log.ts answer --stage <slug> --details "Override blocking sensors"` (with the refusal's `--unit` at a checkpoint), then run the retry the refusal names, with `--override-blocking-sensors --user-input "Override blocking sensors"`. The state tool requires the exact offered option, a `HUMAN_TURN`, and the matching decision/answer receipt; a bare flag fails. Never offer or attempt this option under `Construction Autonomy Mode: autonomous`: unattended runs halt loudly.
- **One check named to switch off**: there is no switch for one check, only all of the work's checks (`{{INVOKE}} engine orchestrate next --sensors off`). When the person asks to switch one check off, ask once which they mean: log the check's question again with a third option, `--options "Fix findings,Override blocking sensors,Switch all checks off for this work"`, say that an Override covers this stage's findings (at a checkpoint, this Unit's), and take their pick as above; for the switch, run `next --sensors off` and follow its step. Never ask which they meant a second time: a request to switch this check off again at a later Unit takes their earlier pick, as that Unit's refusal says.

### Sensor Imports

The instructions in this section apply only when `directive.ceremony.sensors === "on"`. When it is `"off"`, `sensors_applicable` is empty: no sensor correction, rerun, gate-blocking, or sensor-override instructions apply. Ordinary artifact verification and approval gates remain required.

A stage's `sensors:` frontmatter list is its complete set of imported checks.
Each named manifest defines its file match, command, time budget, `fire_on`
timing, and `default_severity`; only sensors imported by the stage are eligible
to run. `fire_on: write` runs during matching writes and remains advisory in
this release, even when the manifest declares `blocking`. `fire_on: gate` runs
against matching declared deliverables when the stage enters or re-enters its
approval gate, and its advisory checks run once before that, when the
documents are written and handed on: the review request, or the report that
opens the gate when no review took them first, comes back as a `print` that
names what a check found and the same command. That step is yours: fix what
is yours in those documents, then run the command again. It goes on without
checking again; the gate checks again and says what is left.
Advisory outcomes emit their audit rows but do not stop the
gate; a gate the engine approves itself under Construction autonomy runs only
its blocking sensors, since advisory evidence has no reader there. A blocking gate sensor requires a verified pass: findings, unavailable
evaluation, malformed output, and timeouts refuse gate entry until the issue
is fixed or the human-backed override flow above completes. Autonomous mode
cannot override a blocking sensor.

Failed checks emit a `SENSOR_FAILED` audit row and write findings to
`<record>/.aidlc-engine/sensors/<stage-slug>/<sensor>-<fire-id>.md`. A check
whose script crashed or could not start emits `SENSOR_COULD_NOT_RUN`: it checked
nothing.

When a gate opens, or is shown again, the engine's reply names each check that
still fails on a declared output, and in one line the checks that could not run,
in its `narration`
on its own line after what the stage produced: say it to the person with the
approval question, never claim coverage a
check reports against or could not run (every requirement traced, every section
present, the code type-checks), and
when they ask for changes, correct from that detail file. A Unit's own gate
names that Unit's outputs and writes only; with Sensors off,
nothing is said about checks.

`required-sections` requires the `##` headings of a markdown output's
template when one applies (stage-protocol.md, Template overrides), and nothing
without one.

`upstream-coverage` compares output prose with the stage's `consumes:`
frontmatter. Every required artefact that exists must be referenced so the
output shows which upstream inputs informed it; an optional one
(`required: false`) is not checked unless the stage marks it `cited: true`. Stages with no required or cited `consumes:` pass
this check trivially. The compact `Imports:` and `Upstream targets:` lines in
each stage file are the local summary; frontmatter remains authoritative when
checks are resolved.
