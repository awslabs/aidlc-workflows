# Testing Contract JSON compatibility repair and retirement

**Finding:** DEVIN-12. **Status:** Temporary shared workaround; vendor fix version unconfirmed. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

Development runs encountered Testing Contract text with raw control characters inside JSON strings. The contract reader needed a narrowly bounded compatibility path for existing artifacts without accepting malformed or tampered contracts as approved content.

## Current implementation

parseTestingContract first attempts strict JSON parsing. Only a syntax error triggers repairJsonControlChars, which escapes raw LF, CR, and tab characters inside strings. A repair that makes no change is rejected; parsing, version 1, digest shape, and body-hash equality still have to succeed. Syntax-valid invalid/tampered contracts do not receive a repair retry.

An optional source argument supplies projectDir and planPath. Successful file-backed repairs append a best-effort testing-contract-repair.drops record containing an escaped project-relative filename, not plan text or contract values. Production callsites include approval consumption, fingerprinting, and the candidate-commit reader in aidlc-unit.

Read-only observer probes suppress repair telemetry and filesystem creation while retaining the same parser result. Text-only parsing stays free of persistent telemetry. Log-write failure cannot change acceptance. The parser does not rewrite the source plan.

Doctor warns about historical repair reads, affected filenames, count, and retained log. Repeated reads are not unique corruption incidents. A retained warning does not prove a file is still corrupt, that the current host wrote it, or that a host bug persists.

The workaround stays in shared core because artifacts may be consumed by another harness. Its removal condition is explicit: establish the vendor-confirmed fixed version, retain a captured write/read escape regression, include that version in the supported baseline, and regenerate affected stored plans through normal approval before removing the fallback.

## Evidence and limits

The branch attributed the original problem to Devin write behavior, but this audit does not independently reproduce that causal mechanism. The code's fixed-version TODO remains UNCONFIRMED as of 2026-09-12. Raising the CLI floor to 3000.10.21 is not evidence that escaping was fixed.

Parser tests prove behavior for supplied text; they are not a live test of Devin's write tool. Missing repair logs also cannot prove the workaround is unused, because logs are best-effort and observer reads deliberately do not write them.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Strict valid contract | Parse without repair or repair telemetry | t299-testing-posture-wiring |
| Supported control-character corruption | Repair LF/CR/tab narrowly and still validate version/digest/body hash | t299 repair cases |
| Unsupported or tampered content | Return rejection; emit no successful-repair record | t299 invalid and tampered cases |
| Telemetry boundaries | Escape hostile filenames, avoid contents, tolerate log failure, suppress writes in both observer modes | t299 repair telemetry and read-only cases |
| Doctor warning | Report historical successful repair reads as non-failing warning, not current corruption proof | t37 doctor coverage |
| Retirement | Meet vendor/version, real write/read, baseline, and stored-artifact migration conditions together | OPEN; no fixed host version established |

## Superseded approaches and history

`becbc89d` added the compatibility transformer. `a1181ad9` made it lazy, source-aware, observable, and explicitly temporary.

Retired: eager repair of already-valid JSON; a parser test proves a host write fix; every log row is a unique corruption; absence of warnings proves retirement is safe; updating AI-DLC automatically repairs old plan files.

## Sources

- `core/tools/aidlc-testing-posture.ts` — repairJsonControlChars, parseTestingContract
- `core/tools/aidlc-unit.ts` — candidate-commit contract reader
- `core/tools/aidlc-utility.ts` — historical repair warning
- `tests/unit/t299-testing-posture-wiring.test.ts`
- `tests/unit/t37.test.ts`
- `docs/guide/15-troubleshooting.md`

[Back to findings index](index.md)
