# Evidence Record

<!-- Framework default template. The ## headings below are the required
     sections the required-sections sensor checks. A team override at
     aidlc/spaces/<space>/memory/templates/evidence-record.md wins. -->

## Entries

Append-only, one entry per tested assumption per cycle: the assumptions-record
id, the verdict, the fidelity level, the sample and setting, the source, and
the artifacts the executed test-plans steps left behind. A test's setting
names what it ran against — the confirmed current-state, the future-state
option under test, and the design-language-record skin where one applies —
so a verdict is never read out of context.

| Assumption | Verdict | Fidelity | Sample and setting | Source | Artifacts |
|------------|---------|----------|--------------------|--------|-----------|

## How to read this record

Verdicts are capped by fidelity and by source. An invalidation is a success
of the process, recorded identically to a confirmation. Nothing here is ever
edited — later entries supersede earlier ones.
