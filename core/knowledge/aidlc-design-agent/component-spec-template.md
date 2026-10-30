# Component Specification Template

Use this template for experience decisions and component-level specifications in
`interaction-spec.md` (Stage 2.5 Refined Mockups) and any stage requiring
detailed UI component definitions, and its Design System Mapping table for
`design-system-mapping.md`.

---

## Experience Decisions

Give each decision a story-keyed ID: `UX{x}.{y}.{n}` belongs to story
`US{x}.{y}`.

| ID | Decision | Component | States | Source |
|---|---|---|---|---|
| UX1.1.1 | [the interaction or layout the build must preserve] | [component or pattern] | [default, loading, empty, error, success, partial] | `[Q1]`, a document's `knowledge show` citation, memory rule, or `[assumption]` |

Use one row per decision. A component observed in the existing code records
what the product uses; it is a company standard only when a document or memory
rule says so. Turn a conflict between sources into a question.

---

## Design System Mapping

| Component or token | Used for | Observed in code | Standard because |
|---|---|---|---|
| FormLayout | [screen or decision, such as UX1.1.1] | [file, or `none`] | [a document's citation, memory rule, `[Q1]`, or `[assumption]`] |

Keep the two columns apart: use in the code is not endorsement, and a standard
the code does not use yet is a new dependency to name.

---

## [Component Name]

| Field | Value |
|---|---|
| Component | [name] |
| Description | [one-line purpose] |
| Category | [input / display / layout / navigation / feedback] |

### States

| State | Description | Trigger |
|---|---|---|
| default | Initial render state | page load |
| hover | Cursor over element | mouseover |
| focus | Keyboard focus | Tab key / click |
| disabled | Non-interactive | prop disabled=true |
| loading | Async operation pending | async op in progress |
| error | Validation or system error | validation failure |
| empty | No data to display | no data |

### Props / Inputs

| Prop | Type | Required | Default | Description |
|---|---|---|---|---|
| [prop-name] | [string \| boolean \| number \| object] | [yes/no] | [value or —] | [what it controls] |

### Responsive Behaviour

| Breakpoint | Behaviour |
|---|---|
| mobile (<768px) | [layout/visibility changes] |
| tablet (768–1024px) | [layout/visibility changes] |
| desktop (>1024px) | [default layout] |

### Accessibility

| Requirement | Implementation |
|---|---|
| ARIA role | [role — e.g. button, listbox, dialog] |
| Keyboard interaction | [Tab to focus, Enter/Space to activate, Escape to dismiss] |
| Label / aria-label | [visible label, aria-label, or aria-labelledby approach] |
| Contrast ratio | WCAG AA (4.5:1 text, 3:1 UI components) |
| Screen reader | [what is announced and when] |
| Focus management | [where focus goes on open/close/activate] |

### Usage Example

```
<ComponentName
  prop="value"
  onAction={handler}
/>
```

---
