# HTML Artifact Protocol Module

Load this module from `{{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol-html.md` when `directive.protocol_modules` lists `html`. Apply it to every HTML artifact in `directive.produces`; Markdown artifacts keep the ordinary stage protocol unchanged.

## Document contract

Author each artifact as one self-contained HTML file. It MUST open and remain useful offline without another file, a server, or a build step. Use this shell:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="aidlc-artifact" content="artifact-name">
  <meta name="aidlc-stage" content="stage-slug">
  <title>Descriptive artifact title</title>
</head>
<body>
  <section data-aidlc="summary" aria-label="Summary">
    <p>Concise linear summary.</p>
  </section>
  <!-- authored sections -->
</body>
</html>
```

Replace every placeholder with the directive's exact artifact name, stage slug, language, and a useful title. The summary section MUST be the body's first element and MUST summarize the artifact in ordinary text before any other body content.

## Heading mapping

Resolve the artifact's Markdown template and required headings using the ordinary stage protocol before authoring HTML. Preserve that H2 set and order exactly:

- Map every Markdown `## Heading` to one semantic `<section>` whose first element is `<h2>Heading</h2>`.
- Put the content governed by that heading inside the same section; lower Markdown headings become the corresponding `h3`–`h6` descendants.
- If `## Summary` belongs to the resolved H2 set, its mapped section is the leading `data-aidlc="summary"` section. Otherwise label the leading summary with `aria-label="Summary"` and do not add an H2 to it.
- Do not rename, omit, merge, or invent required H2 headings. The reviewer-owned Review appendix is the sole reserved exception.

## Self-contained and safe authoring

Inline `<style>`, `<svg>`, and `<script>` are allowed when they materially improve the artifact. Embed all required data in the file. Do not reference or fetch external URLs or assets from `src`, `href`, CSS `url(...)`, imports, scripts, or runtime code. Fragment links such as `href="#risks"` are allowed. Parent traversal (`..`) is prohibited in every path.

Do not use `<form>`, `<iframe>`, `<object>`, or `<embed>`. Scripts MUST be optional enhancement: the document's complete meaning remains available as semantic HTML when scripting is disabled, and scripts do not perform network or filesystem access.

## Reviewer reservation

`<section data-aidlc="review">` is reserved for the reviewer. Stage authors MUST NOT create, edit, style around, or depend on it. If present, it MUST be the body's final element, with `<h2>Review</h2>` as its first element child. Nothing may follow it.

## Accessibility and determinism

Use semantic landmarks, sections, headings, lists, tables, and buttons rather than layout-only elements. Supply meaningful image `alt` text; associate every control with a visible label; give each informative SVG a `<title>` and an accessible name (`aria-labelledby` or `aria-label`). Decorative images and SVGs must be hidden from assistive technology. Maintain readable contrast and visible keyboard focus, and keep reading and tab order aligned with visual order.

Write deterministic source: stable section and item ordering, stable IDs, no current timestamps, randomness, environment-dependent output, or network-dependent content. Prefer static HTML and CSS; use inline SVG or script only when the same offline file renders the same information on repeated opens.
