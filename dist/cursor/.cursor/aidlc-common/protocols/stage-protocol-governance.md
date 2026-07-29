# Stage Protocol: Phase Boundary Verification

Load this file at phase transitions (end of Ideation, Inception, Construction). Note: The Initialization→Ideation transition has no governance boundary check.
This is a supplement to `stage-protocol.md` — the main protocol still applies.

> Capturing corrections as durable rules is handled by the §13 Learnings Ritual in `stage-protocol.md` (the tool-as-actor loop via `aidlc-learnings.ts`), not here. This file covers only phase-boundary traceability verification.

---

## 13. Phase Boundary Verification

At each phase transition (Ideation→Inception (approval-handoff→reverse-engineering), Inception→Construction (delivery-planning→functional-design), Construction→Operation (ci-pipeline→deployment-pipeline)), run traceability verification.

### When to verify
- After the last stage of each phase is approved
- Before the first stage of the next phase begins
- On demand if the user requests verification via `/aidlc --status`

### Verification process
1. Read the verification methodology from `.cursor/knowledge/aidlc-shared/verification.md`
2. Run the phase-specific traceability checks
3. Write results to `<record>/verification/[phase-boundary]-verification.md`
4. If verification fails, present issues to the user before proceeding:
   - Missing traceability links (e.g., requirement without a design)
   - Orphaned artifacts (design without a requirement)
   - Inconsistencies between phase outputs
5. Log a `PHASE_VERIFIED` event to `<record>/audit/<host>-<clone>.md`

### Phase boundary checks
**Ideation → Inception**: Intent captured, scope defined, feasibility confirmed, initiative approved
**Inception → Construction**: All requirements traced to designs, units defined, delivery plan approved
**Construction → Operation**: All units built and tested, CI pipeline configured, infrastructure designed
