# Artifact Repository — Markdown / Filesystem Backend

The active **adapter** implementing `conventions/repository-interface.md`. This is the only steering file that knows *where* and *how* artifacts are stored. It stores artifacts as markdown, YAML, JSON, and HTML files in a directory tree alongside the project.

To switch backends (e.g. to a graph database), replace this file with that backend's adapter and its paired verifier — the interface, the skills, and the stage definitions do not change.

## Physical Layout

The runtime tree for an intent execution, created at the **workspace root**. Intent artifacts live alongside the project, not inside the framework installation directory.

```
<workspace-root>/
└── org-ai-kb/
    └── aidlc-docs/
        └── intent-<nnn>-<slug>/     ← intent artifacts live HERE (the intent root)
        │
        ├── intent.md                    intent
        ├── workflow.json                workflow (machine-parseable)
        │
        ├── state/
        │   └── state.json               state (machine-parseable)
        │
        ├── audit/
        │   └── audit.json               audit (machine-parseable, append-only)
        │
        └── stages/
            ├── inception/
            │   ├── reverse-engineering/
            │   ├── requirements-analysis/
            │   ├── story-generation/
            │   ├── wireframe-design/
            │   ├── domain-design/
            │   ├── contract-design/
            │   └── units-generation/
            │
            ├── construction/
            │   ├── <unit-name>/
            │   │   ├── functional-design/
            │   │   ├── nfr-design/
            │   │   ├── infrastructure-design/
            │   │   └── code-generation/
            │
            └── operations/
                └── (future stages)
```

## Address Resolution

How an `ArtifactAddress` maps to a location in the tree:

| `container` | Resolves to |
|---|---|
| `intent-root` | `org-ai-kb/aidlc-docs/intent-<nnn>-<slug>/` |
| `state` | `<intent-root>/state/` |
| `audit` | `<intent-root>/audit/` |
| `stage` | `<intent-root>/stages/<phase>/<stage>/` for inception/operations; `<intent-root>/stages/construction/<unit>/<stage>/` when `unit` is set; append `/<scope>/` when `scope` is set |

A **stage scope** `(phase, stage, unit?, scope?)` therefore resolves to the stage directory. The full file path for an artifact is the resolved scope directory joined with the filename from the representation map below.

## Type → Representation Map

Each artifact `type` maps to a filename (and, where one exists, a content template). The intent slug, intent number, unit names, and scope names come from the address; everything else is fixed here.

### Meta (container ≠ stage)

| Type | Container | Filename | Template |
|---|---|---|---|
| `intent` | intent-root | `intent.md` | `stages/workspace-setup/templates/intent.md` |
| `workflow` | intent-root | `workflow.json` | `stages/workflow-composition/templates/workflow.json` |
| `state` | state | `state.json` | `stages/workspace-setup/templates/state.json` |
| `audit` | audit | `audit.json` | `stages/workspace-setup/templates/audit.json` |

### Stage working artifacts (container = stage)

| Type | Filename | Template |
|---|---|---|
| `plan` | `plan.md` | — |
| `questions` | `questions.md` | — (format in `conventions/question-format.md`) |
| `<persona>-contribution` | `<persona>-contribution.md` | — |
| `<persona>-review` | `<persona>-review.md` | — |

### Stage output artifacts (container = stage)

| Type | Filename(s) | Template |
|---|---|---|
| `requirements` | `requirements.md` | `stages/requirements-analysis/templates/requirements.md` |
| `stories` | `stories.md` | `stages/story-generation/templates/stories.md` |
| `personas` | `personas.md` | `stages/story-generation/templates/personas.md` |
| `screen-data-map` | `screen-data-map.md` | `stages/wireframe-design/templates/screen-data-map.md` |
| `screen-structure` | `screen-structure.md` | `stages/wireframe-design/templates/screen-structure.md` |
| `wireframes` | `wireframes/<screen>.html` (collection, one file per screen) | — |
| `components` | `components.yaml` + `components.md` | `stages/domain-design/templates/components.yaml`, `stages/domain-design/templates/components.md` |
| `units` | `units.md` | `stages/units-generation/templates/units.md` |
| `unit` | `unit.md` | — |
| `unit-dependencies` | `unit-dependencies.md` | `stages/units-generation/templates/unit-dependencies.md` |
| `unit-story-map` | `unit-story-map.md` | `stages/units-generation/templates/unit-story-map.md` |
| `contracts` | `contracts/<boundary>.<fmt>` (collection, one spec per inter-unit boundary; `<fmt>` per the chosen mechanism, e.g. `.yaml`, `.proto`, `.graphql`) | — |
| `contract-summary` | `contract-summary.md` | `stages/contract-design/templates/contract-summary.md` |
| `entities` | `entities.yaml` | `stages/functional-design/templates/entities.yaml` |
| `rules` | `rules.yaml` | `stages/functional-design/templates/rules.yaml` |
| `api-specification` | `api-specification.md` | `stages/functional-design/templates/api-specification.md` |
| `functional-spec` | `functional-spec.md` | `stages/functional-design/templates/functional-spec.md` |
| `nfr-specification` | `nfr-specification.md` | `stages/nfr-design/templates/nfr-specification.md` |
| `infrastructure-specification` | `infrastructure-specification.md` | `stages/infrastructure-design/templates/infrastructure-specification.md` |
| `implementation-map` | `implementation-map.md` | `stages/code-generation/templates/implementation-map.md` |
| `business-overview` | `business-overview.md` | `stages/reverse-engineering/templates/business-overview.md` |
| `architecture` | `architecture.md` | `stages/reverse-engineering/templates/architecture.md` |
| `code-structure` | `code-structure.md` | `stages/reverse-engineering/templates/code-structure.md` |
| `api-documentation` | `api-documentation.md` | `stages/reverse-engineering/templates/api-documentation.md` |
| `component-inventory` | `component-inventory.md` | `stages/reverse-engineering/templates/component-inventory.md` |
| `technology-stack` | `technology-stack.md` | `stages/reverse-engineering/templates/technology-stack.md` |
| `dependencies` | `dependencies.md` | `stages/reverse-engineering/templates/dependencies.md` |

Template paths are relative to the framework installation root (`.kiro/`). Code generation also writes source, tests, configuration, and data scripts into the project itself; those are project files, not addressed artifacts.

## Operation Implementations

- **`initIntent(intent)`** — Determine the slug (kebab-case) and the next `<nnn>` by scanning existing `org-ai-kb/aidlc-docs/intent-*` directories. Create `intent-<nnn>-<slug>/` with `state/`, `audit/`, and `stages/` subdirectories. Write the initial `state` and `audit` artifacts from their templates.
- **`createStageScope(phase, stage, unit?, scope?)`** — `mkdir -p` the resolved stage directory. Create the phase directory if absent.
- **`saveArtifact(address, content)`** — Resolve the scope directory and the filename(s) for `address.type`; write the file(s), creating parent directories as needed. For collection types, write each member under the type's subdirectory.
- **`readArtifact(address)`** — Read the resolved file(s); return nothing if absent.
- **`listArtifacts(stageScope)`** — Enumerate the files in the resolved stage directory and map each back to its address.
- **`copyForwardArtifact(fromAddress, toStageScope)`** — Copy the source file(s) into the target stage directory under the same type's filename(s), so the artifact can be expanded in place while the source is preserved.
- **`resolveTemplate(type)`** — Return the template file's content per the map above, or nothing if the type has no template.
- **`readState` / `saveState`** — Read/write `<intent-root>/state/state.json`.
- **`registerOutput(intent, stageRef, output)`** — Add `{type, address}` to the stage entry's `outputs` array in `state.json` (see the State Write Contract in `skills/common/aidlc-work-method/SKILL.md`).
- **`setStageStatus(intent, stageRef, status)`** — Update the stage's `status` in `state.json`.
- **`appendAuditEntry(intent, entry)`** — Append one entry to the `entries` array in `<intent-root>/audit/audit.json`.
- **`verifyStage(intent)`** — Implemented out-of-band by the paired verifier `tools/process-checker.js` (built from `repository/markdown-fs/verifier.js`). Reads `state.json`, resolves each declared output's address to a path, and checks the file exists and is non-empty; checks declared contributions are present once the stage is past the contribution step.

## Notes

- Use forward slashes in any path written into a markdown file. Backslashes can break path resolution on Windows.
- Files are UTF-8.
