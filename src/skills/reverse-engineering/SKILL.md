---
name: reverse-engineering
description: |
  The ability to systematically analyse an existing codebase — discovering its structure, architecture, APIs, data models, dependencies, and quality posture — and produce structured design artifacts that make the system understandable to downstream stages. Applied by the Systems Architect as the primary skill at the reverse-engineering stage.
---

# Reverse Engineering

## Purpose

Systematically analyse an existing codebase to produce structured, accurate design artifacts that describe what exists. These artifacts become the shared understanding the team works from.

## Principles

- Discover everything, then organise — scan broadly before structuring. Miss nothing at package level.
- Business context first — understand *why* the system exists before cataloguing *how* it's built. A file list without business context is useless.
- Separate fact from inference — state what you observed versus what you inferred. Mark inferences explicitly so the human can correct them.
- Freshness matters — reverse-engineering artifacts have a shelf life. If the codebase has changed significantly since last analysis, re-analyse.
- Depth adapts to scope — if the intent only touches one service, the full-system analysis can be lighter on unrelated services, but must still map boundaries and integration points.
- One repo, one invocation — for multi-repo systems, each repo gets its own analysis pass. Cross-repo relationships are captured in dependencies.

## Approach

### 1. Discovery (breadth-first)

Scan the workspace for signals in this order:

1. **Package manifest** — `package.json`, `pom.xml`, `build.gradle`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `*.csproj`. These define the unit boundaries.
2. **Infrastructure-as-Code** — CDK, Terraform, CloudFormation, Pulumi, SAM. These reveal deployment topology.
3. **API definitions** — OpenAPI specs, Smithy models, GraphQL schemas, Protobuf files. These reveal contracts.
4. **Entry points** — handlers, controllers, main files, CLI commands. These reveal runtime shape.
5. **Config and CI** — `.env`, CI/CD pipelines, Docker files, deployment scripts. These reveal operational context.
6. **Tests** — test directories, fixtures, mocks. These reveal what's considered critical.

### 2. Business context synthesis

From what you discovered, answer:
- What domain does this system operate in?
- What are the key business transactions (end-to-end user flows)?
- What terminology does the codebase use (domain dictionary)?

### 3. Architecture extraction

From the discovered components, build:
- Component relationship diagram (who calls who, data flow direction)
- Integration point catalogue (external APIs, databases, third-party services)
- Infrastructure topology (what runs where)

### 4. Quality assessment

Without running tools (unless available), assess:
- Test coverage posture (by presence/absence/ratio of test files to source files)
- Code style consistency (linting configs present? multiple conflicting styles?)
- Documentation quality (READMEs, inline docs, API docs)
- Dependency health (outdated versions, abandoned packages, licence risks)

## Definitions

- **Package** — a buildable/deployable unit (has its own manifest and build config)
- **Component** — a logical grouping within a package (module, service class, handler group)
- **Integration point** — where this system talks to something outside its boundary
- **Business transaction** — an end-to-end flow that delivers business value (e.g., "user places an order")

## Application

When applied at the reverse-engineering stage, this skill produces the seven output artifacts defined in the stage definition: business-overview.md, architecture.md, code-structure.md, api-documentation.md, component-inventory.md, technology-stack.md, and dependencies.md.

When applied as a contributor to other stages (e.g., requirements-analysis on a brownfield project), this skill manifests as: validating that stated requirements align with the existing system's actual architecture, flagging requirements that conflict with current system boundaries, and identifying existing capabilities that may already satisfy requirements.
