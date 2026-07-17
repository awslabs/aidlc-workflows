# Customer-Delivery PoC Playbook

## Purpose

Use this playbook for a 3–5 working-day customer PoC that proves one business
flow and leaves a runnable demo, CDK deployment package, architecture evidence,
and a clear extension path. It is not a production-readiness checklist.

## Eight-step cadence

1. **Requirements capture (about 2h):** agree the one-page problem statement,
   exclusions, acceptance criteria, data posture, and customer approver.
2. **Solution design (about 2h):** choose the smallest AWS architecture and
   TypeScript CDK stack plan that can demonstrate the accepted outcome.
3. **Environment readiness (about 1h):** establish the non-production account,
   region, CDK bootstrap, and baseline deployment.
4. **Walking skeleton (about 4h):** demo one real vertical slice early; stop or
   change direction before expanding if it invalidates the value hypothesis.
5. **Feature expansion (1–2d):** implement only customer-approved core behavior.
6. **Test validation (about 4h):** map each criterion to repeatable evidence.
7. **CDK deployment (about 2h):** deploy and smoke test only through CDK.
8. **Demo and handoff (about 2h):** obtain acceptance, document the
   production-extension backlog, and deliver the cost projection (PoC running
   cost plus a production-scale estimate with explicit assumptions) so the
   customer sees the full business case, not just a working demo.

## CDE alignment

- Steps 1–2 support **Scope Agreement**.
- Steps 3–6 support **Iterative Build**; the Step 4 demo and Step 5 review are
  the **Pair Review** moments.
- Steps 7–8 support **Handoff**.

## Data and customer safety

Never handle real customer production data as a default. Use synthetic or masked
samples. If real customer data is essential, pause and use the approved
GenAIIC (Generative AI Innovation Center) co-creation path; record only the
approval reference and data owner, not data
values. Do not state or imply that a passing PoC is production ready.

## Completion definition

A completed PoC has: a customer-visible demo, TypeScript CDK source and deployed
stack evidence, test evidence, a diagram, explicit limitations, an extension
recommendation, a cost projection (PoC running cost and a production-scale
estimate, every figure labeled with its assumptions), and an owner for value
tracking. Do not fabricate pipeline, MRR, CloudFormation, or SFDC metrics;
cost figures are estimates with cited pricing sources, never quotes.
