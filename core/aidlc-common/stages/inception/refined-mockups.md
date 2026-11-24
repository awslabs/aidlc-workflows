---
slug: refined-mockups
phase: inception
execution: CONDITIONAL
condition: Execute when user-facing UI exists; for APIs, refine interaction diagrams
lead_agent: aidlc-design-agent
support_agents:
  - aidlc-product-agent
mode: inline
summary_confirmation: required
reviewer: aidlc-product-lead-agent
review_artifact: mockups
reviewer_max_iterations: 2
review_class: advisory
produces:
  - mockups
  - interaction-spec
  - design-system-mapping
  - accessibility-checklist
  - refined-mockups-questions
optional_produces:
  - mockups-preview
consumes:
  - artifact: wireframes
    required: true
  - artifact: user-flow
    required: true
  - artifact: stories
    required: false
  - artifact: requirements
    required: true
  - artifact: team-practices
    required: false
  - artifact: component-inventory
    required: false
    conditional_on: brownfield
requires_stage:
  - user-stories
sensors:
  - required-sections
  - upstream-coverage
  - traceability
scopes:
  - enterprise
  - feature
  - mvp
  - classic
  - workshop
inputs: Rough mockups from rough-mockups stage, user stories from user-stories stage, requirements from requirements-analysis stage, RE component-inventory.md (if brownfield), the team's documents (the documents card)
outputs: mockups.md, interaction-spec.md, design-system-mapping.md, accessibility-checklist.md, refined-mockups-questions.md, and mockups-preview.html when the work has screens to show (under this stage's record dir, engine-resolved)
---

# Refined Mockups & UX Design

## Steps

### Step 1: Load Prior Context

- Read rough mockups from `<record>/ideation/rough-mockups/` (if exists)
- Read user stories from `<record>/inception/user-stories/`
- Read requirements from `<record>/inception/requirements-analysis/`
- The design sources: the team's documents (the `documents.md` card in your reading list), the design and brand rules in memory, and, if brownfield, the `## User Interface` section of `component-inventory.md` in `aidlc/spaces/<active-space>/codekb/<repo>/` (the directory `codekb-path --repo <repo>` prints) when it has one: the UI library, shared components, screen patterns and theme tokens the code uses today. A design-system guide in shared or design-agent knowledge is a company standard too.

The classic scope skips rough-mockups by design (no Ideation phase); when the wireframes and user-flow inputs are absent, design the refined mockups directly from the user stories and requirements — never invent the content of a missing artifact.

### Step 2: Generate Clarifying Questions

Ask only what needs the person's judgement. A question the team's documents answer goes into the stage protocol's first question, "What your documents already answer", for the person to confirm. What memory rules and the existing code settle (the UI library, components, theme tokens, the accessibility baseline) is not a question: state it in the artifacts with its source. When two sources disagree (the code uses one component, a company document names another), that conflict is a question.

Create `<record>/inception/refined-mockups/refined-mockups-questions.md` with questions on what remains open:
- For each user story whose interaction has more than one reasonable shape, which layout fits what the person meant? Offer two or three options built from the components the sources name, such as an inline table row, a guided form page or a side drawer, each with what it fits.
- What must each screen do in its states (loading, empty, error, success, partial), such as what a failed save keeps?
- Which design-system or brand choice is still open, and what accessibility level applies, when no source settles it?
- What responsive breakpoints are needed?
- For APIs: what does the developer experience look like?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Validate design decisions against user stories and requirements for consistency.

### Step 4: Generate Artifacts

Create mid-to-high fidelity mockups (per user story/screen), interaction specification document (use `{{HARNESS_DIR}}/knowledge/aidlc-design-agent/component-spec-template.md` as the format for component-level specifications), design system mapping, responsive behavior specification, and accessibility compliance checklist.

In `interaction-spec.md`, give every experience decision its own story-keyed ID, `UX{x}.{y}.{n}` for a story `US{x}.{y}` in `stories.md` (the way `AC{x}.{y}.{n}` is keyed), or `UX0.0.{n}` for an app-wide decision that belongs to no single story (the breakpoints, the accessibility level), which every UI Unit then owes, on one line with the decision, the component it uses, the states it covers, and its source: the person's answer (`[Q<n>]`), a company document, a memory rule, or `[assumption]`. Code Generation traces these IDs to code. A company document's source is its name as the documents card shows it, such as `[brand-guide.pdf]`. A component seen in the existing code shows use, not that it is the company standard; record a conflict between sources as a question, never a silent choice.

In `design-system-mapping.md`, use the template's Design System Mapping table: each component and token row gives where it is observed (a file in the existing code, or `none`) apart from the standard it follows (a company document, a memory rule, the person's answer, or `[assumption]`).

When the work has screens to show, also write `<record>/inception/refined-mockups/mockups-preview.html` with your file-writing tool: one self-contained HTML file, with inline CSS and SVG, no scripts and nothing loaded from elsewhere, labelled with the `UX` IDs it shows. Its `<head>` opens with this tag (after an optional `<meta charset="utf-8">`; a formatter may break its attributes onto lines or close it with `/>`), so the browser enforces that; the review request refuses a preview without it:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
```

It shows each decided screen in each state its decisions cover, drawn with the components and tokens of `design-system-mapping.md`, and lets the person click through them without a script: each screen and state is a `<section id="sign-in-error">`, each control that leads somewhere is an `<a href="#sign-in-error">` to its target, and CSS `:target` shows the selected section, with the first screen shown when none is selected. The person judges the experience by looking at it; it is approved with the other outputs, and Build and Test's final gate compares the build with it. API-only work has no preview: the example requests and responses in the Markdown outputs, success and each error shape, are what the person reads.

For non-UI: create API developer experience specification.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`{{INVOKE}} engine orchestrate report --stage refined-mockups --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :art:
Review path: `<record>/inception/refined-mockups/`
When `mockups-preview.html` was written, tell the person to open it in a browser and click through the experience in its states before they decide.
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/refined-mockups/`, plus the HTML preview when it is written.

Imports: `required-sections`, `upstream-coverage`, `traceability` (fired on `interaction-spec.md`: every `UX` ID names a story `stories.md` has, or is app-wide).

Upstream targets: `wireframes`, `user-flow`, `stories`, `requirements`, `team-practices`, `component-inventory`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working, and take the learnings step before the approval gate; that module says
when it asks the person anything. When the module is absent, skip both the diary
and the step.
