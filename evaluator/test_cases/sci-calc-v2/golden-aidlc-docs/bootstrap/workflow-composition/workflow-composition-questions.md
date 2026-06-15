# Workflow Composition Questions

Skill: workflow-composition
Status: auto-answered
Date: 2025-01-21T15:43:00Z

---

## Q1: Should reverse-engineering run?

[Question]: Should the reverse-engineering skill be included?
[Recommendation]: No. This is a greenfield project with no existing codebase and no integration targets. Bootstrap context confirms codekb is n/a and reverse-engineering is not needed.
[Answer]: No — greenfield, no existing code or integration targets.

## Q2: Should user-stories run?

[Question]: Should the user-stories skill be included?
[Recommendation]: No. This is a single-component utility API with one obvious actor (the API consumer) performing straightforward math operations. The requirements document will capture the operations sufficiently. Per the right-sizing principle, user stories add no meaningful value for a calculator API.
[Answer]: No — single actor, operations are self-evident from requirements.

## Q3: Should application-design run?

[Question]: Should the application-design skill be included?
[Recommendation]: No. This is a single-component stateless API with no orchestration, no inter-service communication, and no component boundaries to define. The service is the component.
[Answer]: No — single component, no orchestration needed.

## Q4: Should units-generation run?

[Question]: Should the units-generation skill be included?
[Recommendation]: No. There is exactly one unit (the calculator API service). Units-generation is for multi-component systems that need work decomposed into independent units.
[Answer]: No — single unit (sci-calc), trivially determined.

## Q5: Should functional-design run?

[Question]: Should the functional-design skill be included?
[Recommendation]: No. For a calculator API, the business logic IS the requirements — mathematical operations with well-defined inputs and outputs. There are no complex domain entities or business rules that warrant a separate functional design document. Per Example B: "logic is the requirements."
[Answer]: No — math operations are fully specified by requirements; no complex domain logic.

## Q6: Should nfr-assessment or nfr-design run?

[Question]: Should NFR skills be included?
[Recommendation]: No. This is a stateless utility API. Default NFR posture (correctness, reasonable error handling) is adequate. No special performance, scalability, or security concerns beyond standard FastAPI defaults.
[Answer]: No — defaults are sufficient for a stateless utility API.

## Q7: Should infrastructure-design run?

[Question]: Should infrastructure-design be included?
[Recommendation]: No. The intent doesn't mention deployment, cloud infrastructure, or container orchestration. The project is a single FastAPI service run locally with uvicorn. Infrastructure can be added later if needed.
[Answer]: No — no deployment infrastructure specified; local development only.

## Q8: Should wireframes run?

[Question]: Should the wireframes skill be included?
[Recommendation]: No. This is a pure HTTP API with no user interface.
[Answer]: No — API only, no UI.

## Q9: Any per-skill flag overrides?

[Question]: Should any per-skill flags be overridden from their defaults?
[Recommendation]: No overrides needed. The three selected skills (requirements-analysis, code-generation, build-and-test) should use their default flags (human-clarification: true, plan-creation: true, plan-verification: true, artefact-verification: true) since the user requested driving the full workflow.
[Answer]: No overrides — use default flags for all selected skills.
