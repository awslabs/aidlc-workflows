# Workflow Profiles

AI-DLC does not force every task through the same lifecycle. It ships a set of
**workflow profiles** for common kinds of work: a full feature, a quick bugfix,
an infrastructure change, a lightweight Express run, and others.

The engine calls a workflow profile a **scope**. The two terms describe the same
choice from different perspectives:

- **Workflow profile** is the user-facing experience: what kind of work you are
  doing and how much ceremony it needs.
- **Scope** is the engine setting stored in `aidlc-state.md`: the exact stage
  route, depth, test strategy, and review ceiling used for that workflow.

Choose a profile explicitly with `/aidlc <profile>` or describe the work and let
AI-DLC suggest one. A keyword match or compose offer confirms the route before
starting; an explicitly named profile starts immediately and prints its stage
and gate counts.

## Quick chooser

| Workflow profile | Best for | Stages | Depth | Test strategy | Start with |
|------------------|----------|--------|-------|---------------|------------|
| **Classic** | General work using the established lifecycle without Ideation | 26 / 33 | Standard | Standard | `/aidlc classic` |
| **Express** | The lightest requirements-to-code-and-test path | 10 / 33 | Minimal | Minimal | `/aidlc express` |
| **Feature** | A production feature using the complete lifecycle | 33 / 33 | Standard | Standard | `/aidlc feature` |
| **Enterprise** | Regulated or high-assurance work with full traceability | 33 / 33 | Comprehensive | Comprehensive | `/aidlc enterprise` |
| **MVP** | A real first product increment without the Operation phase | 23 / 33 | Standard | Standard | `/aidlc mvp` |
| **Proof of concept** | Testing feasibility with the smallest useful implementation path | 8 / 33 | Minimal | Minimal | `/aidlc poc` |
| **Bugfix** | A known defect that needs a focused fix and regression test | 9 / 33 | Minimal | Minimal | `/aidlc bugfix` |
| **Refactor** | Improving existing code without changing product behavior | 10 / 33 | Minimal | Minimal | `/aidlc refactor` |
| **Infrastructure** | Environments, IaC, deployment foundations, or cost work | 13 / 33 | Standard | Standard | `/aidlc infra` |
| **Security patch** | A CVE or focused vulnerability response | 10 / 33 | Minimal | Minimal | `/aidlc security-patch` |
| **Workshop** | A facilitated training or group delivery session | 26 / 33 | Standard | Minimal | `/aidlc workshop` |

Stage counts describe the static route. A stage marked conditional can still
self-skip when its condition does not apply, such as Reverse Engineering in a
greenfield project. For the exact stage-by-profile matrix, see
[Scopes, Depth, and Test Strategy](05-scopes-and-depth.md#stage-by-scope-matrix).

## `classic`

**Choose Classic when:** you want the established AI-DLC lifecycle and the work
does not need an Ideation phase. It starts with Inception, then moves through
Construction and the applicable Operation stages.

Classic is the implicit engine default when neither you nor
`AWS_AIDLC_DEFAULT_SCOPE` names another profile. In the conversational cold-start
flow, a rich task description may still receive an adaptive compose offer before
anything is created. Classic uses Standard artifacts and tests, and caps normal
stage reviews at one advisory pass.

Do not choose Classic when the problem itself is still unclear and would benefit
from market research, feasibility analysis, or explicit scope discovery; choose
Feature or Enterprise instead.

## `express`

**Choose Express when:** the requirements are already understood and you want
the shortest supported path through requirements, implementation, tests, and an
optional deploy tail.

Express skips Ideation, the design pass, Unit decomposition, Delivery Planning,
and CI Pipeline. It disables stage reviewer dispatch and uses Minimal artifacts
and requirement-driven tests. Reverse Engineering and deployment stages remain
conditional.

Do not choose Express for ambiguous, cross-team, regulated, or architecture-heavy
work. Its speed comes from intentionally removing those decision surfaces.

## `feature`

**Choose Feature when:** you are building a production feature and want the
complete lifecycle at practical depth.

Feature runs all 33 stages at Standard depth, from intent discovery through
design, implementation, deployment, and feedback. It gives the workflow the
widest opportunity to surface unknowns without the heavier documentation floor
of Enterprise.

## `enterprise`

**Choose Enterprise when:** the work is regulated, high risk, audit-sensitive,
or requires formal compliance and operational evidence.

Enterprise runs all 33 stages at Comprehensive depth. It retains market,
compliance, security, design, observability, incident-response, and performance
work because the cost of an undocumented decision is higher than the cost of
the additional ceremony.

## `mvp`

**Choose MVP when:** you are shipping a real first product increment, not merely
testing whether an idea is possible.

MVP keeps the full Inception and Construction design/build path at Standard
depth. It trims selected Ideation ceremony and skips the Operation phase. Move
to Feature or Enterprise when the product needs production operations and the
full feedback lifecycle.

## `poc`

**Choose Proof of Concept when:** the primary question is whether an approach can
work.

PoC uses 8 stages at Minimal depth. It gets to requirements, code, and tests
quickly while omitting most product, design, and operational ceremony. A PoC is
evidence for a later decision; it is not the production-readiness profile.

## `bugfix`

**Choose Bugfix when:** the defect is known and the desired outcome is a focused
repair with verification.

Bugfix uses 9 stages at Minimal depth. It preserves workspace understanding,
requirements, Code Generation, Build and Test, and the deployment path while
dropping discovery, broad design, and unrelated Operation work.

## `refactor`

**Choose Refactor when:** behavior should stay stable while internal structure,
maintainability, or technical debt improves.

Refactor uses 10 stages at Minimal depth. It emphasizes understanding the
existing code, defining the internal change, implementing it, proving behavior
did not regress, and carrying the verified result through deployment. Use
Feature instead if the work changes user-visible behavior.

## `infra`

**Choose Infrastructure when:** the outcome is an environment, IaC change,
deployment foundation, platform capability, or cost optimization.

Infrastructure uses 13 stages at Standard depth. It removes user-facing product
ceremony and concentrates on requirements, NFRs, infrastructure design, CI/CD,
deployment, and observability.

## `security-patch`

**Choose Security Patch when:** you are responding to a known CVE, vulnerability,
or narrowly scoped security defect.

Security Patch uses 10 stages at Minimal depth. It keeps the security-relevant
requirements, verification, implementation, and deployment path while avoiding
unrelated product ceremony. Use Enterprise for a broader security or compliance
program rather than a focused patch.

## `workshop`

**Choose Workshop when:** a facilitator is leading a training lab or coordinated
group session.

Workshop skips Ideation because the facilitator supplies the exercise, then runs
the Inception-through-Operation lifecycle at Standard depth. It deliberately
uses a Minimal test strategy to keep a teaching session moving and caps normal
reviews at one advisory pass. The multi-participant operating recipe is in
[Workshop Mode](workshop-mode.md).

## Let AI-DLC choose or compose

You do not need to memorize the profiles. Describe the work:

```
/aidlc Fix the login timeout bug
/aidlc Build a regulated payment approval service
/aidlc Create a lightweight prototype for the new search flow
```

A clear keyword match proposes a stock profile and shows its stage and gate
count for confirmation. Rich or ambiguous work receives an offer to use the
adaptive composer, which proposes a tailored stage route and waits for approval
before creating it.

You can force that path with:

```
/aidlc compose "harden the deployment pipeline and add observability"
```

## Related controls

The workflow profile chooses the route and defaults. You can independently tune:

- **Depth** with `--depth minimal|standard|comprehensive`.
- **Test strategy** with `--test-strategy minimal|standard|comprehensive`.
- **Review cap** with `--review adversarial|advisory|none`. The effective class
  is the lowest of the stage declaration, profile cap, and this per-run cap, so
  it can never raise review intensity.

These overrides do not turn one profile into another; they adjust the selected
profile. See [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) for the
normative routing matrix and override semantics.
