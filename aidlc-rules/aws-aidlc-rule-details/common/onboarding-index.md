# Onboarding Index Files

## MANDATORY: Recommended-Reading Index Generation

**CRITICAL**: AI-DLC generates a large number of documentation files across stages and phases. A teammate who is new to the project, or returning after time away, has no way to tell where to start or in what order to read them. Every documentation folder under `aidlc-docs/` that contains more than one artifact MUST have a `000-index.md` that orients the reader and proposes a reading order.

## When to Create or Update an Index

As part of a stage's file-creation step (alongside `common/content-validation.md`), before presenting stage completion, create or update the relevant `000-index.md` file(s):

1. **Stage-artifact folder** (e.g. `aidlc-docs/inception/reverse-engineering/`, `aidlc-docs/inception/requirements/`, `aidlc-docs/construction/{unit-name}/functional-design/`): index the files the stage just wrote, in the order they were produced.
2. **Phase folder** (`aidlc-docs/inception/`, `aidlc-docs/construction/`, `aidlc-docs/operations/`): index the stage subfolders that currently exist, in workflow execution order (see the stage lists in `core-workflow.md`). Skip subfolders whose stage was skipped or not yet reached.
3. **Root folder** (`aidlc-docs/`): index the phase folders that currently exist, in phase order (Inception → Construction → Operations), plus `aidlc-state.md` and `audit.md`.

**Do not** create an index for a folder that has only one file, or for `{unit-name}/code/` (code artifacts are self-evident from the code-generation stage).

Indexes are living documents: update them at every stage completion that adds, removes, or renames files in a folder. An index must never reference a file that no longer exists or omit one that does.

## Index File Format

For a stage-artifact folder, listing files:

```markdown
## Objective

The order below is an **orientation guide** to help you understand [what this folder covers]. You are **not required** to follow it in full — open only the files you need.

## Index

0. **000-index.md** (this file)
1. [file-one.md](file-one.md) — one-line description of what it covers
2. [file-two.md](file-two.md) — one-line description of what it covers
```

For a phase or root folder, listing subfolders (each linking to that subfolder's own index):

```markdown
## Objective

The order below is an **orientation guide** to help you understand what this [phase/project] covers. You are **not required** to follow it in full — open only the sections you need.

## Index

0. **000-index.md** (this file)
1. [reverse-engineering/](reverse-engineering/000-index.md) — existing-codebase analysis (brownfield only)
2. [requirements/](requirements/000-index.md) — functional and non-functional requirements
```

## Description Rules

- Keep each description to one short line: what the artifact tells the reader, not a restatement of its filename.
- Order reflects when the artifact was produced / when it is most useful to read, not alphabetical order.
- Reflect only what actually exists in the current run — a skipped or not-yet-reached stage or folder has no entry.
- Do not rename the underlying artifact files to add number prefixes; the ordering lives in the index, not the filenames.
