# Changes to AI-DLC

This document explains what's different when you run AI-DLC with these operations rules installed. It covers what you'll experience at each phase and why the changes were made.

---

## Inception — What's Different

**You'll be asked additional questions** about operational domains (observability, recovery, runbooks, deployment). These determine which domains apply to your project and at what level — AWS best-practice, custom, or both.

**A second round of questions** follows, informed by the domains you opted into. These clarify domain-specific details (e.g. recovery objectives, deployment strategy) that the AI needs before it can design and build the right operational artifacts.

**The execution plan will include Operations** as an active phase. Previously it was a placeholder that never ran.

**Operations Retrofit detects existing projects.** If the workspace already has code and a completed Construction phase but Operations was never run (still a placeholder), the AI detects this and asks whether you'd like to retrofit. If you say yes, it re-runs the standard opt-in questions for all available extensions, resets Construction, and re-enters the workflow with extensions loaded. This means you can install these rules on a project that was previously built without them and get the full Operations treatment without starting from scratch.

**Why**: Without these questions upfront, Construction has to guess what operational standards apply. By capturing this during Inception, every subsequent stage has unambiguous instructions. The retrofit path ensures existing projects aren't left behind — they get the same trust-and-verify treatment as new ones.

---

## Construction — What's Different

**Extension rules are treated as first-class requirements.** The AI will explicitly map each rule to each component in your architecture, producing a visible matrix of what applies where. You'll see this in the generated artifacts.

**Code Generation produces operational artifacts alongside application code.** Expect to see IaC for alarms, dashboards, canaries, runbooks, deployment pipelines — not just application logic. Each rule × resource combination gets its own implementation task.

**A completeness check runs before Construction finishes.** The AI scans its own plan for anything it missed and goes back to complete it.

**Build and Test discovers available tools first.** Rather than assuming what's installed, it checks — reducing skipped verification steps.

**Why**: In standard AI-DLC, extensions are passively available but not enforced. These changes ensure every applicable rule produces a concrete implementation task that can't be silently skipped.

---

## Operations — What's New

This is an entirely new phase with three stages that run after Build and Test.

### Rules Validation

The AI independently re-assesses which rules apply to your architecture (it does not trust what Construction decided). For each applicable rule, it reads the generated code and IaC to verify the rule's criteria are met. You'll receive a per-domain compliance report.

If gaps are found, you'll be asked to approve a rework — the AI classifies each gap, presents them for your decision, and loops back to Construction to fix only what's needed. This repeats until all approved gaps are resolved or the iteration limit is reached.

### Deployment

Deploys the pipeline, triggers it, monitors execution through pre-production, and verifies all components are present in the live environment. Triggers rework if the pipeline fails.

**With Deployment extension active**: The full pipeline-first model applies — pipeline deployed as IaC, pipeline deploys everything else, human approval gates production.

**Without Deployment extension** (opted out or not present): The stage still runs but asks the user whether to proceed. If yes, it deploys directly without pipeline requirements — a simpler "deploy and verify presence" flow.

Only runs if cloud credentials are available.

### Post-Deployment Testing

Reviews pipeline test results, runs additional verification that requires model reasoning (operational readiness, functional correctness), and presents results to a human for the production approval decision.

**With Deployment extension active**: Reviews pipeline test stage results, assesses coverage adequacy, runs functional correctness and operational readiness checks.

**Without Deployment extension**: Runs model-driven tests against the deployed environment without pipeline result review.

Only runs if Deployment completed successfully.

---

## Cross-Cutting — What's Different Throughout

**Step execution accountability** — every stage now maintains an audit log of which steps were executed, skipped, or partially completed. If something goes wrong, you can trace exactly where the AI deviated from the expected process.

**Blocking rules cannot be skipped** — AI-DLC normally adapts its detail level to problem complexity. Extension rules are excluded from this — a MUST rule must be satisfied regardless of how simple the project appears.

**Rework loop** — when Operations finds gaps, it sends them back to Construction rather than just reporting them. You approve which gaps to fix, and the AI re-executes only the necessary stages. This can iterate multiple times.

---

## Evaluator — What's Different

The evaluator has been modified to support the Operations phase and the rework loop.

### Executor Agent

**Operations phase is in the stage sequence.** The executor knows about Rules Validation, Deployment, and Post-Deployment Testing — it won't stop after Build and Test.

**Context recovery after handoffs.** The evaluator's Swarm architecture resets conversation history when control passes between agents. The executor now follows a recovery procedure after every handoff — reading state, loading the appropriate stage file, and determining what to do next based on the handoff message content.

**Scenario-specific recovery for rework.** When the executor returns from a rework approval handoff, it explicitly loads `design-rework.md` and follows the rework plan procedure. This prevents the model from taking shortcuts (fixing code directly instead of following the formal rework mechanism).

**Step execution tracking persists across handoffs.** The executor loads `step-execution-accountability.md` after every handoff, ensuring the step-decision-log is maintained throughout the run rather than only during the first turn.

**Why**: The Swarm's context reset means the model loses all previously loaded rules on every handoff. Without these changes, the model would skip the Operations phase, ignore the rework procedure, and stop tracking steps after the first approval gate.

### Simulator Agent

The simulator (human stakeholder role) has been modified to ensure extension rules are fully tested during the Operations phase.

**Gap approval hardening.** The simulator approves all Rules Validation gaps for rework. Its role during the Operations phase is to support full testing of the extension rules — rejecting a gap means the rule is never validated. The only valid rejection is a documented architectural constraint where the compute platform physically cannot support what the rule requires. This prevents the simulator from accepting "nice-to-have" or "post-launch" justifications that would leave rules untested.

**Environment BLOCKED distinction.** The simulator understands the difference between Construction gaps (approve for rework) and environment constraints (accept BLOCKED status). It will not force rework on issues outside the workflow's control (expired credentials, service unavailability).
