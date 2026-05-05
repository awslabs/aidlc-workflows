# Security Baseline — Default Enabled (Opt-Out)

**Extension**: Security Baseline
**Default**: Enabled — rules are enforced unless the user explicitly opts out.

## Opt-Out Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Security Extensions
Security baseline rules (OWASP-based) are **enabled by default** for this project. No action is needed to keep them active.

If you want to disable security rules (e.g., for a throwaway PoC or experimental prototype), type "disable" below. Otherwise, leave blank or type "keep".

[Answer]: 
```

## Loading Behavior

Unlike standard opt-in extensions, this extension's full rules file (`security-baseline.md`) is loaded immediately at workflow start — before the user answers the opt-out question. This ensures security rules are enforced from the earliest stages.

If the user types "disable" during Requirements Analysis, the extension is marked as disabled in `aidlc-docs/aidlc-state.md` and enforcement stops from that point forward.

If the user leaves the answer blank, types "keep", or does not answer the question, enforcement continues unchanged.
