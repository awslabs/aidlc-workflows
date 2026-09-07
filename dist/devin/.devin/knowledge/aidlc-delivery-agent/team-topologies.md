# Team Topologies

Organising teams for fast flow of change using the Team Topologies framework by Matthew Skelton and Manuel Pais.

## The Four Fundamental Team Types

### 1. Stream-Aligned Team
- **Purpose**: Delivers value along a single stream of work (a product, a feature set, a user journey, or a business domain).
- **Characteristics**: Cross-functional (dev, test, ops, UX). Owns the full lifecycle from ideation to production. Has clear ownership boundaries.
- **Size**: 5-9 people (two-pizza rule). Enough to own a meaningful slice of the product without excessive coordination.
- **This is the primary team type.** Most teams in the organisation should be stream-aligned. Other team types exist to reduce the cognitive load on stream-aligned teams.

### 2. Platform Team
- **Purpose**: Provides internal services that accelerate stream-aligned teams. Reduces cognitive load by abstracting away infrastructure complexity.
- **Examples**: Internal developer platform (IDP), CI/CD pipeline team, observability platform, shared authentication service.
- **Operates as a product team**: Treats stream-aligned teams as customers. Publishes a clear API/interface. Prioritises usability and self-service.
- **Anti-pattern**: A platform team that requires tickets and manual intervention is a bottleneck, not a platform.

### 3. Enabling Team
- **Purpose**: Helps stream-aligned teams acquire new capabilities. Coaches, mentors, and researches — does not build features.
- **Examples**: Cloud adoption team helping migrate from on-premise. Security enablement team coaching secure coding practices. SRE team teaching observability patterns.
- **Time-boxed engagement**: Works with a stream-aligned team for weeks or months, then moves on. Success means the stream-aligned team no longer needs the enabling team.

### 4. Complicated-Subsystem Team
- **Purpose**: Owns a component that requires deep specialist knowledge that most stream-aligned teams cannot reasonably maintain.
- **Examples**: ML model training pipeline, video codec optimization, cryptography module, real-time data processing engine.
- **Rare**: Only create this team type when the subsystem's complexity truly justifies specialist ownership. Over-use leads to silos.

## Three Interaction Modes

| Mode | Description | When to Use |
|------|-------------|-------------|
| **Collaboration** | Two teams work closely together on a shared goal. High communication bandwidth. | Discovery phases, building a new capability, exploring uncertainty. Time-box to avoid permanent coupling. |
| **X-as-a-Service** | One team provides a service; the other consumes it via a well-defined API. Low communication overhead. | Stable, well-understood capabilities. The providing team's interface is mature. |
| **Facilitating** | One team (typically enabling) helps another team learn or adopt a new practice. | Skill transfer, technology adoption, practice improvement. |

Interaction modes should evolve over time. A platform team might start in collaboration mode with a stream-aligned team and transition to X-as-a-service once the interface stabilises.

## Cognitive Load Assessment

Cognitive load is the primary constraint on team effectiveness. Three types:

- **Intrinsic**: Complexity of the domain itself (financial regulations, distributed systems).
- **Extraneous**: Unnecessary complexity from tooling, process, or poor documentation. Reduce this.
- **Germane**: Productive learning related to the domain. Increase this.

**Assessment questions for each team**:
1. How many services/components does this team own? (If > 3-5 significant services, the team is overloaded.)
2. How many different technology stacks must the team maintain?
3. How much time is spent on operational toil vs feature development?
4. How often does the team need to coordinate with other teams to deliver?
5. Can a new team member become productive within 2-4 weeks?

If cognitive load is too high, split the team's responsibilities, create a platform team to absorb shared concerns, or simplify the architecture.

## Team API Concept

Each team should publish a "Team API" that describes:
- **What the team owns**: Services, data stores, APIs, domains.
- **How to interact**: Preferred communication channels, office hours, request processes.
- **What the team provides**: Interfaces, SLOs, documentation, support expectations.
- **What the team needs**: Dependencies on other teams, expected SLOs from dependencies.

The Team API makes boundaries explicit and reduces ad-hoc interruptions.

## Conway's Law Implications

"Organizations which design systems are constrained to produce designs which are copies of the communication structures of these organizations." — Melvin Conway

**Practical implications**:
- If you want a microservices architecture, organise teams around services. A monolithic team structure will produce a monolith.
- If two teams must collaborate to deploy a feature, the architecture has an implicit coupling that should be addressed.
- Use the "Inverse Conway Manoeuvre": design the team structure to match the desired architecture, and the architecture will follow.

## Team Sizing — The Two-Pizza Rule

- A team should be small enough that two pizzas can feed it (5-9 people).
- Below 5: insufficient breadth of skills; high bus factor risk.
- Above 9: communication overhead grows quadratically; decision-making slows.
- If a team is growing beyond 9, look for a natural boundary to split along (a subdomain, a component, a user journey).
