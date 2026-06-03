# Reverse Engineering

## Description

Analyse an existing codebase to produce structured design artifacts that describe what already exists — its architecture, components, APIs, data models, technology stack, dependencies, and quality posture. These artifacts become context for all downstream stages (requirements, design, code generation) so the team understands what they're working with before deciding what to change.

## Inputs

- **Required:** Accessible source code (in workspace or via path reference)
- **Optional context:** intent.md, prior RE artifacts to validate/refresh, human guidance on focus areas

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant for this codebase. Additional artifacts may be produced if the codebase warrants them.

- `business-overview.md` — business context, transactions, domain dictionary
- `architecture.md` — system overview, component descriptions, data flow, integration points
- `code-structure.md` — build system, modules, design patterns, file inventory, critical dependencies
- `api-documentation.md` — system contracts, internal interfaces, data models
- `component-inventory.md` — categorised package/module inventory with counts
- `technology-stack.md` — languages, frameworks, infrastructure, build tools, test tools
- `dependencies.md` — internal dependency graph and external dependency catalogue

## Owner

systems-architect

## Contributors

- security-architect

## Reviewer

architecture-reviewer
