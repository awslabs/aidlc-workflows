# Design Language Record

<!-- Framework default template. The ## headings below are the required
     sections the required-sections sensor checks. A team override at
     aidlc/spaces/<space>/memory/templates/design-language-record.md wins. -->

## Component inventory

Every recurring interface component, as the product names it.

| Component | Variants | States | Source reference |
|-----------|----------|--------|------------------|

## Design tokens

The typed visual values, named by role, each with its provenance — kept
machine-readable so a generated mock-up can be checked against them
deterministically.

```yaml
# role-named token: value   # provenance
```

## UX patterns and principles

Navigation model, layout, feedback, error handling, voice — each stated only
when observed on more than one screen or attested in a guideline.

## Source registry

Every source consulted — starting from the materials the source-inventory
lists — what it yielded, and the conflicts encountered with how each was
resolved.

## Gaps

What remains unknown — recorded rather than guessed, because nothing in this
record is invented. A gap a person could still close belongs in the
open-questions-record too; a gap in the product surface the intent-statement
describes is worth naming explicitly.
