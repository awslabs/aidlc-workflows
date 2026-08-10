# Workflow Planning Guide

Domain-specific guidance for the Workflow Planning stage. Use this alongside `product-guide.md` when leading execution plan creation.

## Stage Configuration Heuristics

Derive stage configuration from the work breakdown analysis. For each conditional stage, evaluate whether it adds value based on the identified work streams, their complexity, and dependencies.

### INCEPTION stages

| Stage | EXECUTE when | SKIP when |
|-------|-------------|-----------|
| Application Design | Work streams introduce new components/services, new architectural boundaries, greenfield projects | All streams modify existing components only, no new service boundaries |
| Units Generation | Multiple independent work streams, cross-cutting concerns requiring sequenced delivery | Single stream or tightly coupled streams that form one natural unit |

### CONSTRUCTION stages (per-unit)

| Stage | EXECUTE when | SKIP when |
|-------|-------------|-----------|
| Functional Design | Streams involve complex business logic, state machines, multi-step workflows, domain modeling | Simple CRUD, config changes, straightforward data transformations |
| NFR Requirements | Streams handle security-sensitive data, performance SLAs, public-facing APIs, regulatory compliance | Internal tools, prototypes, low-risk utility functions |
| NFR Design | NFR Requirements produced non-trivial requirements | NFR Requirements skipped or produced only basic constraints |
| Infrastructure Design | Streams require new deployment targets, CI/CD changes, infrastructure-as-code | Existing infrastructure unchanged, deploying to established pipeline |

### Configuration rationale format

For each stage decision, tie the rationale to specific work streams:
- "EXECUTE — Streams 1 and 3 introduce new service boundaries requiring architectural design"
- "SKIP — All streams modify existing components within established architecture"

## Work Stream Identification Patterns

### Grouping strategies
- **By domain area**: Group requirements/stories that share domain entities and business rules
- **By user persona**: Group requirements serving the same user type
- **By dependency chain**: Group requirements where one enables another
- **By risk profile**: Isolate high-risk work into its own stream for focused attention
- **By delivery boundary**: Group work that can be independently delivered and tested

### Stream sizing guidance
- **Simple projects** (1-2 streams): Single feature additions, bug fixes, focused refactoring
- **Standard projects** (2-4 streams): Multi-feature work with some cross-cutting concerns
- **Complex projects** (4-6 streams): Distributed changes, multiple integration points, significant architectural work

### Sequencing strategies
1. **Foundation first**: Infrastructure and shared services before dependent features
2. **High-risk early**: Tackle uncertainty before investing in dependent work
3. **Value delivery**: Arrange so partial delivery still provides user value
4. **Test isolation**: Each stream should be independently testable where possible
5. **Critical path optimization**: Identify the longest dependency chain and prioritize unblocking it

## Economic vs topological sequencing (for Bolt Planning in Stage 2.8)

Unit dependency analysis (Stage 2.7) produces the DAG — topological order falls out of it mechanically. That's geometry: what the system is.

Bolt sequencing (Stage 2.8) is different work. It chooses a path through the DAG weighted by human value judgment — which Bolt ships first, which proves what, which surfaces the biggest risk early. AI can topologically sort; it cannot decide what validates the market hypothesis fastest.

Per the canonical Glossary (`stage-protocol.md` line 657), a **Bolt** is "a deployable unit of work within Construction — one pass through stages 3.1–3.7." Bolts are not MMFs and not sprints.

Heuristics for Bolt sequencing:

- **Walking skeleton first** (Cockburn, *Crystal Clear*) — the first Bolt is a minimal end-to-end implementation that proves the architecture works, before adding features.
- **WSJF / Cost of Delay ÷ Duration** (Reinertsen, *Principles of Product Development Flow*; SAFe) — order Bolts by (value + time criticality + risk reduction) divided by job size.
- **Risk-first** (Boehm, Spiral Model) — sequence the highest-uncertainty Bolts early so decisions are calibrated before dependent work commits.
- **Value-first** — ship Bolts in value order when risk is low and value delivery is the dominant constraint.

The chosen heuristic is captured in `risk-and-sequencing-rationale.md`, alongside any deviation from 2.7's topological order.

## Execution Plan Structure

Every execution plan MUST include these sections:

1. **Work Streams** — identified streams with scope, deliverables, complexity, dependencies, requirements coverage, review expertise
2. **Implementation Sequence** — ordered stream execution with critical path
3. **Detailed Analysis Summary** — scope metrics, change impact, component relationships
4. **Risk Assessment** — risk register with likelihood, impact, and mitigation
5. **Workflow Visualization** — Mermaid flowchart of stage execution flow
6. **Stage Configuration** — checkbox list of stages with EXECUTE/SKIP decisions and rationale tied to work streams
7. **Success Criteria** — measurable outcomes for project completion

Optional sections (include when applicable):
- **Transformation Scope** — for brownfield projects with significant refactoring
- **Package Change Sequence** — for multi-unit projects with dependency ordering
- **Multi-Module Coordination** — for brownfield projects touching multiple packages

## Risk Assessment Criteria

### Severity Levels

| Level | Description | Indicators | Example |
|-------|-------------|------------|---------|
| **Low** | Well-understood, minimal dependencies | Standard patterns, established tech, isolated changes | Adding a new REST endpoint to an existing API |
| **Medium** | Some unknowns, moderate dependencies | New library adoption, moderate cross-component impact | Integrating a third-party auth provider |
| **High** | Significant unknowns, complex dependencies | New technology, data migration, multiple integration points | Migrating from SQL to NoSQL for a core domain |
| **Critical** | Architectural changes, breaking changes | Fundamental pattern changes, data schema overhaul, API contract changes | Rewriting monolith services into microservices |

### Risk Documentation Pattern

For each identified risk, document:
- **Risk**: What could go wrong
- **Likelihood**: Low / Medium / High
- **Impact**: Low / Medium / High / Critical
- **Mitigation**: Specific actions to reduce likelihood or impact

## Unit Decomposition Heuristics

### When to use single-unit delivery
- Fewer than 5 user stories
- All stories share the same components
- No independent deploy/test boundaries
- Simple feature addition or bug fix

### When to use multi-unit delivery
- 5+ user stories spanning different domains
- Independent feature groups that can be delivered and tested separately
- Different risk profiles across feature groups (ship low-risk first)
- Cross-cutting concerns (e.g., auth, logging) that should be built before dependent features

### Unit ordering principles
1. **Foundation first**: Infrastructure and shared services before dependent features
2. **High-risk early**: Tackle uncertainty before investing in dependent work
3. **Value delivery**: Arrange so partial delivery still provides user value
4. **Test isolation**: Each unit should be independently testable

## Depth Calibration

### Simple project indicators
- Single page or single API endpoint
- No external integrations
- Single user role
- Straightforward CRUD operations
- Internal tool or prototype

### Standard project indicators
- Multi-page application or multi-endpoint API
- 1-3 external integrations
- 2-4 user roles with different permissions
- Some business logic beyond CRUD
- Production-grade with moderate traffic expectations

### Complex project indicators
- Distributed system or microservice architecture
- 4+ external integrations or real-time data flows
- Complex authorization model (RBAC, ABAC, multi-tenancy)
- Domain-specific algorithms, state machines, or workflow engines
- High availability requirements, data migration, regulatory compliance
