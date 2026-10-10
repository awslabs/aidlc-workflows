---
id: xref-links
kind: deterministic
command: {{INVOKE}} engine sensor-xref-links
default_severity: advisory
description: Flags a stable-ID cross-reference left as a bare token when the same file defines an anchor it could link to
category: document-traceability
matches: "**/*.md"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  unlinked:
    - id: string
      line: integer
      anchor: string
  findings_count: integer
  reason: string
timeout_seconds: 5
---

# xref-links sensor

Advisory. Enforces the cross-reference convention in `memory/org.md`: a stable
ID (`FR1.2`, `NFR3`, `US1.1`, `AC1.1.1`, `BR1.1`, `ENT-001`, `ADR-001`,
`unit-4`) used as a cross-reference to the artifact that defines it should be a
relative Markdown link to that definition's anchor, not a bare token, so a
reader can click through.

For each Markdown artifact:

1. Collect the anchors the file **defines** — a portable HTML anchor
   `<a id="fr1-2"></a>` (recommended; renders on GitHub/CommonMark) or a
   Kramdown `{#fr1-2}` heading attribute, in canonical form (the ID lower-cased,
   non-alphanumeric runs collapsed to single hyphens: `FR1.2` → `fr1-2`,
   `ADR-001` → `adr-001`).
2. Find every **bare** ID token — not inside a fenced code block, an
   inline-code span, an inline or reference-style Markdown link, or an HTML tag
   — whose canonical anchor **this same file defines**.
3. Report each as an advisory finding: it has a resolvable in-file target but
   was written unlinked.

Two convention exceptions never fire:

- **Definition point** — the token on its own defining heading line (the anchor
  lives there; it is not a link to itself).
- **No target** — a token whose anchor this file does not define (a forward
  reference whose target does not exist yet stays bare).

Cross-file linking (`requirements.md#fr1-2` cited from another artifact) is out
of scope for this deterministic sensor; it only reports a token it can prove has
a target in the same file.

**What it deliberately does NOT flag** (each needs a record-wide anchor index
this same-file sensor does not build, so flagging them would be guesswork): a
reference whose anchor is **missing** (no `<a id>` authored yet), a reference to
the **wrong** id, and a **cross-file** reference. It is an advisory drift-catcher
for the one case it can prove — a bare token beside an anchor that already exists
in the same file (an ADR-to-ADR `Supersedes`, an FR-to-FR reference) — not a
completeness check that every reference is linked. Treat a clean run as "no
provable same-file omission," not "every cross-reference is a link."

## Expected JSON output

```json
{
  "pass": false,
  "unlinked": [{ "id": "ADR-001", "line": 42, "anchor": "adr-001" }],
  "findings_count": 1
}
```
