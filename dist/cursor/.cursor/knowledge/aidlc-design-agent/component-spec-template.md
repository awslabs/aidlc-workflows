# Component Specification Template

Use this template for component-level specifications in `interaction-spec.md` (Stage 1.5 Refined Mockups) and any stage requiring detailed UI component definitions.

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
