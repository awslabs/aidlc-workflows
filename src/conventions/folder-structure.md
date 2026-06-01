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
            ├── requirements-analysis/
            │   ├── requirements.md
            │   └── questions.md
            ├── story-generation/
            │   ├── stories.md
            │   ├── personas.md
            │   └── questions.md
            ├── wireframe-design/
            │   ├── screen-data-map.md
            │   ├── screen-structure.md
            │   ├── wireframe-guidance.md
            │   └── questions.md
            └── <stage-name>/
                ├── <output-artifacts>
                └── questions.md
```

## Rules

1. Each stage gets its own subdirectory under `stages/`.
2. Output artifacts live in the stage's directory.
3. Questions asked during clarification are recorded in `questions.md` within the stage directory.
4. `state.json` and `audit.json` are machine-parseable — see their respective schemas in `conventions/`.
5. `workflow.json` records the composed workflow for this intent — see `workflow-schema.json`.
6. The workspace-setup stage creates this entire structure. No other stage creates directories.
