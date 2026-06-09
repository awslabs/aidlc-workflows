# Repository Interface

The **port** between the AI-DLC methodology and artifact storage. Every skill, persona, and stage speaks only this vocabulary — logical artifact **types** and repository **operations**. None of them know whether an artifact is a markdown file, a YAML document, or a node in a graph.

The **adapter** for the active backend (see `conventions/artifact-repository.md`) is the only place that knows *where* and *how* artifacts are physically stored. To switch storage backends, you replace the adapter — never this interface, the skills, or the stage definitions.

## How operations are performed

The operations below are a **vocabulary** — a set of named responsibilities. This interface deliberately says nothing about the *mechanism* by which they are carried out. **The active adapter (`conventions/artifact-repository.md`) decides the mechanism, and it varies by backend:**

- For the default **markdown-fs** backend, you perform them yourself with your ordinary read/write/shell tools (e.g. `saveArtifact` = write a file at the path the adapter resolves).
- For other backends, the adapter may direct you to **specific tools or an MCP server** — for example, a **graph backend reached through MCP**, where `saveArtifact` means calling a particular MCP tool to create or update a node.

So when this interface or a skill says "perform `saveArtifact`", read it as: *do what the active adapter says saving an artifact means on this backend* — whether that is a file write or an MCP/tool call. **Always read the adapter to learn the mechanism. Do not assume one.** Equally, do not assume a tool or MCP must exist: if the adapter describes plain file I/O, the absence of a repository tool or `tools/` entry point is expected, not an error.

> If you are about to write a file path, a filename, or an extension while executing the methodology, stop. That decision belongs to the adapter. Identify the artifact by its **type**, then read `conventions/artifact-repository.md` to learn both *how this backend stores that type* and *which mechanism (file tools, a specific tool, or MCP)* to use, and perform the operation that way.

## Artifact Address

Every artifact is addressed by its logical identity, never by a path:

```
ArtifactAddress {
  container:  intent-root | state | audit | stage   # which logical store
  phase?:     inception | construction | operations  # when container = stage
  stage?:     <stage-name>                            # when container = stage
  unit?:      <unit-name>                             # construction-phase stage instances
  scope?:     <scope-name>                            # multi-instance stages
  type:       <artifact-type>                         # see catalog below
}
```

- `container` selects the logical store. `intent-root`, `state`, and `audit` hold the meta artifacts. `stage` holds everything a stage produces.
- `phase` + `stage` (+ `unit` for construction, `+ scope` for multi-instance stages) locate the **stage scope** — the logical bucket an artifact belongs to. The adapter maps a stage scope to a directory, a set of nodes, or whatever its backend uses.
- `type` is the logical artifact identity from the catalog below. It carries no format and no extension.

A **stage scope** is the `(phase, stage, unit?, scope?)` tuple. Operations that act on a whole stage (list, create, copy-forward target) take a stage scope rather than a full address.

## Artifact Type Catalog

The canonical artifact types. Each entry is *what the artifact is* — never where it lives or what format it takes. The adapter maps every type to a representation (and, where relevant, to a content template).

### Meta

| Type | What it is |
|---|---|
| `intent` | The structured intent — verbatim prompt, summary, slug, type |
| `workflow` | The composed workflow for this intent (machine-parseable) |
| `state` | Current progress through the workflow (machine-parseable) |
| `audit` | Append-only log of human decisions (machine-parseable) |

### Stage working artifacts

| Type | What it is |
|---|---|
| `plan` | The owner's plan for producing a stage's outputs, with per-substep checkboxes |
| `questions` | Clarification questions (and their answers) for a stage |
| `<persona>-contribution` | A contributor's findings on the owner's artifact |
| `<persona>-review` | A reviewer's verdict and findings on a stage's artifact |

### Stage output artifacts

| Type | What it is |
|---|---|
| `requirements` | Structured FRs, NFRs, assumptions, scope boundaries |
| `stories` | User stories |
| `personas` | User personas |
| `screen-data-map` | What data each screen shows/collects, sourced from stories |
| `screen-structure` | Screen inventory, navigation map, shared components |
| `wireframes` | The wireframes themselves — a collection, one per screen |
| `components` | The domain model — entities and their shapes |
| `units` | The units of work the system decomposes into (all units) |
| `unit` | A single unit's definition, copied forward into a construction stage scope and expanded |
| `unit-dependencies` | Which units depend on / talk to which |
| `unit-story-map` | Mapping of stories to units |
| `contracts` | Inter-unit boundary contracts — a collection, one per boundary |
| `contract-summary` | Human-readable overview of the contracts |
| `entities` | Per-unit entity definitions |
| `rules` | Per-unit business rules |
| `api-specification` | Per-unit API specification |
| `functional-spec` | Per-unit functional specification |
| `nfr-specification` | Per-unit non-functional requirements specification |
| `infrastructure-specification` | Per-unit infrastructure specification |
| `implementation-map` | Mapping of design to the code that implements it |
| `business-overview` | Reverse-engineering: what the system does, for whom |
| `architecture` | Reverse-engineering: how the system is structured |
| `code-structure` | Reverse-engineering: the code layout |
| `api-documentation` | Reverse-engineering: the existing APIs |
| `component-inventory` | Reverse-engineering: the components that exist |
| `technology-stack` | Reverse-engineering: languages, frameworks, services |
| `dependencies` | Reverse-engineering: external and internal dependencies |

Types marked as collections (`wireframes`, `contracts`) hold many items under one type; the adapter decides how the members are represented and named.

## Operations

These are the named responsibilities you perform when executing the methodology (see "How operations are performed" above). Each description below says *what* the operation must achieve; the active adapter (`conventions/artifact-repository.md`) says *how* to achieve it on this backend — file I/O, a specific tool, or an MCP call, depending on the backend. The function-style signatures (e.g. `saveArtifact(address, content)`) are just a shorthand for naming each responsibility and its inputs, not a function to import or call.

### Lifecycle

- **`initIntent(intent)`** — Create the logical home for a new intent: its root, its `state` store (initialised per `state-schema.json`), and its `audit` store (initialised per `audit-schema.json`). Returns the intent handle later operations address into.
- **`createStageScope(phase, stage, unit?, scope?)`** — Create the logical bucket for a stage's artifacts. Called when a stage is about to run (inception stages after composition; per-unit construction scopes after units-generation).

### Artifacts

- **`saveArtifact(address, content)`** — Persist `content` as the artifact identified by `address`. Creates or replaces. The adapter chooses the representation for `address.type`.
- **`readArtifact(address)`** — Return the content of the addressed artifact, or nothing if it does not exist.
- **`listArtifacts(stageScope)`** — Return the addresses of every artifact in a stage scope. Used by reviewers, who must see everything a stage produced.
- **`copyForwardArtifact(fromAddress, toStageScope)`** — Bring an upstream artifact into a later stage scope so it can be expanded in place, preserving its stable IDs. The adapter decides whether this is a copy, a reference, or an edge — the methodology only requires that the artifact is now addressable in `toStageScope` and can be expanded without mutating the source.
- **`resolveTemplate(type)`** — Return the content scaffold for an artifact type, if one exists. Templates describe artifact **content shape** and are backend-neutral: a file backend renders the template into a file, a graph backend renders the same content into a node body.

### State

- **`readState(intent)`** / **`saveState(intent, state)`** — Read and write the intent's progress record (conforms to `state-schema.json`).
- **`registerOutput(intent, stageRef, output)`** — Record that a stage produced an artifact, by `{type, address}`. See the State Write Contract in `skills/common/aidlc-work-method/SKILL.md`.
- **`setStageStatus(intent, stageRef, status)`** — Update a stage's status in state. Each actor sets only the status for what they did.

### Audit

- **`appendAuditEntry(intent, entry)`** — Append one human-decision record to the audit log (conforms to `audit-schema.json`). Only the orchestrator calls this.

### Verification

- **`verifyStage(intent)`** — Deterministically check the current active stage: declared outputs exist, declared contributions are present when due. Runs out-of-band (a process hook), implemented by the adapter's paired verifier. It checks process, never content quality.

## Rules

1. The methodology addresses artifacts by **type**, never by filename, extension, or path. Producing a path is the adapter's job alone.
2. Every read and write of an artifact, state, or audit entry goes through an operation above. Nothing is "written to disk" or "read from the file system" directly.
3. The adapter for the active backend is `conventions/artifact-repository.md`. It is the single swappable steering file; its paired verifier is the single swappable code module.
4. Templates are content scaffolds, not storage decisions. `resolveTemplate(type)` is backend-neutral.
5. This interface is stable. Adding a backend never edits this file — it adds an adapter.
