# Folder Structure

The runtime folder structure for an intent execution. Created by the workspace-setup stage at the **workspace root**. Intent artifacts live alongside the project, not inside the framework installation directory.

```
<workspace-root>/
└── org-ai-kb/
    └── aidlc-docs/
        └── intent-<nnn>-<slug>/     ← intent artifacts live HERE
        │
        ├── intent.md                    structured intent
        ├── workflow.json                composed workflow (machine-parseable)
        │
        ├── state/
        │   └── state.json               current progress (machine-parseable)
        │
        ├── audit/
        │   └── audit.json               participation log (machine-parseable, append-only)
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
            │   │   ├── nfr-requirements/
            │   │   ├── nfr-design/
            │   │   ├── infrastructure-design/
            │   │   └── code-generation/
            │   └── build-and-test/
            │
            └── operations/
                └── (future stages)
```

## Rules

1. Stages are grouped by phase: `inception/`, `construction/`, `operations/`.
2. Each stage gets its own subdirectory under its phase.
3. Construction stages are scoped per-unit: `construction/<unit-name>/<stage-name>/`.
4. `contract-design` sits at the inception level because it defines cross-unit boundary agreements before per-unit construction begins.
5. `build-and-test` sits at the construction level (not per-unit) — it runs after all units.
6. Output artifacts live in the stage's directory.
7. Questions asked during clarification are recorded in `questions.md` within the stage directory.
8. `state.json` and `audit.json` are machine-parseable — see their respective schemas in `conventions/`.
9. `workflow.json` records the composed workflow for this intent — see `workflow-schema.json`.
10. The workspace-setup stage creates the phase directories. Per-unit directories are created when units-generation completes.
