# Implementation Map

> Trace generated code back to the copied-forward blueprint. Every source, test, config, and data artifact should map to at least one stable design ID.

## Source Mapping

| Blueprint ID | Type | Design Source | Implementation Files | Tests |
|---|---|---|---|---|
| CMP-001 | component | components.yaml | [path/to/source] | [path/to/test] |
| ENT-001 | entity | entities.yaml | [path/to/source] | [path/to/test] |
| BR-001 | rule | rules.yaml | [path/to/source] | [path/to/test] |
| API-001 | API | api-specification.md | [path/to/source] | [path/to/test] |

## Configuration Mapping

| Blueprint ID | Config / Script | Purpose | Source Decision |
|---|---|---|---|
| UNIT-001 | [path/to/config] | [what it configures] | [nfr/infrastructure decision] |

## Copied Blueprint Expansions

| Blueprint ID | Expansion Target | Implementation Detail Added |
|---|---|---|
| CMP-001 | components.yaml | [source/test references added] |
| UNIT-001 | unit.md | [implementation status and config references added] |

## Coverage Gaps

| Blueprint ID | Gap | Resolution |
|---|---|---|
| [ID] | [what was not implemented or tested] | [fix, defer, or rationale] |
