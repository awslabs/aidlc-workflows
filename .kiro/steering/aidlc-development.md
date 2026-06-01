---
inclusion: auto
---

# AI-DLC Framework Development

Welcome to the AI-DLC Workflows repository. This is the source for the multi-agent development lifecycle framework.

When you start a session, display:

```
AI-DLC Framework — Development Mode

You are working on the framework itself, not a target project.
Available actions: add/modify stages, personas, skills, templates, tools.
Ask me what you'd like to do.
```

## Structure Reference

- `src/stages/` — stage definitions + templates
- `src/personas/` — agent persona YAMLs
- `src/skills/` — domain skills (SKILL.md per agentskills.io)
- `src/skills/common/` — skills auto-included in all personas
- `src/tools/` — computational scripts
- `src/conventions/` — schemas and format definitions
- `src/target-config/` — target-specific source (hooks, augments)
- `build/kiro-ide/build.js` — Kiro IDE build script
- `dist/` — generated output (never edit directly)

## Workflows

### Add New Stage

1. Ask: name, description, inputs (any of), outputs, owner persona, contributors, reviewer
2. Create `src/stages/<name>/definition.md`
3. Create `src/stages/<name>/templates/` with output templates
4. Update `src/stages/stage-graph.md` with dependencies
5. Rebuild: `node build/kiro-ide/build.js`

### Modify Existing Stage

1. Ask: which stage, what's changing (inputs, outputs, owner, contributors, reviewer)
2. Edit `src/stages/<name>/definition.md`
3. Update templates if outputs changed
4. Update `src/stages/stage-graph.md` if dependencies changed
5. Rebuild

### Add New Persona

1. Ask: name, description, behaviour (worldview + constraints), associated-skills, stages-owned, contributor-at, reviewer-at
2. Create `src/personas/<name>.yaml`
3. Rebuild

### Modify Existing Persona

1. Ask: which persona, what's changing
2. Edit `src/personas/<name>.yaml`
3. Rebuild

### Add New Skill

1. Ask: name, description, purpose, principles, application
2. Determine: domain skill (`src/skills/<name>/SKILL.md`) or common skill (`src/skills/common/<name>/SKILL.md`)
3. Create the SKILL.md with agentskills.io frontmatter (name + description in `---` block)
4. If domain skill: add to relevant persona(s) `associated-skills` in their YAML
5. Rebuild

### Modify Existing Skill

1. Ask: which skill, what's changing
2. Edit the SKILL.md
3. Rebuild

### Add Template

1. Ask: which stage, what output format
2. Create `src/stages/<stage>/templates/<name>.md`
3. Rebuild

### Add Tool

1. Ask: name, purpose, which persona uses it, at which stages
2. Create `src/tools/<name>.js`
3. Add to relevant persona's `associated-tools` in their YAML
4. Rebuild

## Rules

- Always edit `src/` — never edit `dist/` directly
- Always rebuild after changes: `node build/kiro-ide/build.js`
- Skills follow the agentskills.io spec (frontmatter with name + description)
- Personas are YAML with: name, description, behaviour, associated-skills, stages-owned, contributor-at
- Stage definitions are markdown with: Description, Inputs, Outputs, Owner, Contributors, Reviewer
- Common skills go in `src/skills/common/` — they're auto-included in all personas during build
