# Stage Protocol: Phase Boundary Verification

Load this file at phase transitions (end of Ideation, Inception, Construction). Note: The Initialization→Ideation transition has no governance boundary check.
This is a supplement to `stage-protocol.md` — the main protocol still applies.

> Capturing corrections as durable rules is handled by the conditional §13 Learnings Ritual in `stage-protocol-learnings.md`, loaded only when `directive.protocol_modules` lists `learnings` (the tool-as-actor loop via `aidlc-learnings.ts`), not here. This file covers only phase-boundary traceability verification.

---

## 13. Phase Boundary Verification

`PHASE_VERIFIED` is emitted by the engine when the phase boundary is crossed (the state tool pairs it with `PHASE_COMPLETED` on the final gate approval); do not append it yourself

### Phase boundary checks
**Ideation → Inception**: Intent captured, scope defined, feasibility confirmed, initiative approved
**Inception → Construction**: All requirements traced to designs, units defined, delivery plan approved
**Construction → Operation**: All units built and tested, CI pipeline configured, infrastructure designed
