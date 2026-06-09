# Reverse Engineering

## Description

Analyse an existing codebase to produce structured design artifacts that describe what already exists — its architecture, components, APIs, data models, technology stack, dependencies, and quality posture. These artifacts become context for all downstream stages (requirements, design, code generation) so the team understands what they're working with before deciding what to change.

## Inputs

- **Required:** Accessible source code (in workspace or via path reference)
- **Optional context:** `intent`, prior RE artifacts to validate/refresh, human guidance on focus areas

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant for this codebase. Additional artifacts may be produced if the codebase warrants them.

- `business-overview` — business context, transactions, domain dictionary
- `architecture` — system overview, component descriptions, data flow, integration points
- `code-structure` — build system, modules, design patterns, file inventory, critical dependencies
- `api-documentation` — system contracts, internal interfaces, data models
- `component-inventory` — categorised package/module inventory with counts
- `technology-stack` — languages, frameworks, infrastructure, build tools, test tools
- `dependencies` — internal dependency graph and external dependency catalogue

## Owner

aidlc-systems-architect-agent

## Contributors

(none)

## Reviewer

aidlc-architecture-reviewer-agent
