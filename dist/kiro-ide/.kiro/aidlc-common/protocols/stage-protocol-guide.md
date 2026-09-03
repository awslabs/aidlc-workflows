# Browser Question Guide Protocol Module

Load this module from `.kiro/aidlc-common/protocols/stage-protocol-guide.md` when `directive.protocol_modules` lists `guide`. It governs only the explainer written for **Guide me in the browser**; the Markdown questions file remains authoritative.

## File and identity

Write one self-contained `<stage-dir>/<slug>-questions-guide.html` file. Follow the HTML artifact protocol's offline, safety, accessibility, and deterministic-source rules. The head MUST contain:

```html
<meta name="aidlc-artifact" content="<slug>-questions-guide">
<meta name="aidlc-stage" content="<slug>">
```

The body's first element MUST be `<section data-aidlc="summary">` with one paragraph explaining what this question round decides.

## One section per question

For every ordinary `Q<n>` H2 in `<slug>-questions.md`, in file order, write exactly one:

```html
<section data-aidlc-question="Q1" id="Q1">
  <h2>Question title</h2>
  <h3>Why now</h3>
  <p>What depends on this decision, naming downstream stages or artifacts.</p>
  <h3>Trade-offs</h3>
  <table>
    <thead><tr><th>Option</th><th>You get</th><th>You give up</th><th>Cost / risk</th></tr></thead>
    <tbody><!-- one row per option --></tbody>
  </table>
  <h3>Recommendation</h3>
  <p data-aidlc-recommend="B">Recommendation and project-specific rationale.</p>
  <h3>Related decisions</h3>
  <p>Quoted prior answers or record facts with their file paths.</p>
</section>
```

The `data-aidlc-question` and `id` values MUST equal the question id. Do not add, omit, merge, or reorder question sections. The Consolidated Summary Confirmation is not an ordinary question section and MUST NOT appear.

## Explanation content

- Copy the question title faithfully into its `h2`.
- Under **Why now**, name the concrete downstream work affected by the answer.
- Under **Trade-offs**, include every offered option in a table with exactly these columns: **Option**, **You get**, **You give up**, **Cost / risk**.
- Under **Recommendation**, set `data-aidlc-recommend` to a real option letter offered by that question and explain why it fits the current project. Never invent a letter or recommend an unlisted answer.
- Under **Related decisions**, quote relevant prior `[Answer]:` values or record content and cite project-relative file paths. Write `None found` when there is no grounded related decision.
- An optional `<figure>` may clarify architecture or flow. Give it an accessible name and a useful `<figcaption>`; it never replaces the required prose or table.

## Required check

Before pointing the human to the browser, run:

`bun .kiro/tools/aidlc-html.ts check --guide <file> --questions <slug>-questions.md`

Fix every finding. Do not present a guide that fails the base HTML artifact contract, lacks a question section, has an extra section, or recommends a letter absent from its question.
