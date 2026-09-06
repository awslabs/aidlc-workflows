# Browser Question Guide Protocol Module

Load this module from `.codex/aidlc-common/protocols/stage-protocol-guide.md` when `directive.protocol_modules` lists `guide`. It governs only the explainer written for **Guide me in the browser**; the Markdown questions file remains authoritative.

## Start from the scaffold

Do not write the file from memory. Generate a skeleton that already satisfies the
check, then fill in the prose:

`bun .codex/tools/aidlc-html.ts scaffold --guide <stage-dir>/<slug>-questions.md --out <stage-dir>/<slug>-questions-guide.html [--depth minimal]`

It writes the head identity, the summary section, and one section per `Q<n>`
with the real option letters and texts already in place; every
`data-aidlc-recommend=""` and every empty `<p>` is yours to complete. Pass
`--depth minimal` when `aidlc-state.md` says **Depth**: Minimal. If the scaffold
reports a question with no parsable options, the questions file is malformed
(§3 exact line shape) — fix that file first; the browser form reads it the same way.

## File and identity

The result is one self-contained `<stage-dir>/<slug>-questions-guide.html` file that follows the HTML artifact protocol's offline, safety, accessibility, and deterministic-source rules. The head MUST contain:

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

**Depth sets the shape.** At **Minimal** depth (the `--depth minimal` scaffold) each
section carries only **Why now** and **Recommendation** — two or three sentences
each, no table, no related-decisions block; a Minimal round is a handful of
essentials and the human wants the pick and the reason, not a matrix. At
Standard and Comprehensive depth write the full shape above.

## Explanation content

- Copy the question title faithfully into its `h2` (the scaffold already did).
- Under **Why now**, name the concrete downstream work affected by the answer.
- Under **Trade-offs** (Standard/Comprehensive), fill every option row the scaffold laid out; the columns are exactly **Option**, **You get**, **You give up**, **Cost / risk**.
- Under **Recommendation**, set `data-aidlc-recommend` to a real option letter offered by that question and explain why it fits the current project. Never invent a letter or recommend an unlisted answer.
- Under **Related decisions** (Standard/Comprehensive), quote relevant prior `[Answer]:` values or record content and cite project-relative file paths. Leave the scaffold's `None found` when there is no grounded related decision.
- An optional `<figure>` may clarify architecture or flow. Give it an accessible name and a useful `<figcaption>`; it never replaces the required prose.

## Follow-ups

A follow-up (contradiction, ambiguity, re-ask) stays in the browser: append its
`## Q<n>.` section to the questions file, then append one matching
`<section data-aidlc-question="Q<n>" id="Q<n>">` to the guide in the same shape
(same depth, letters from the file, `data-aidlc-recommend` filled), leaving
earlier sections untouched. Never re-run the scaffold — it discards your prose.
Run the check again and end the turn as Step 3d describes.

## Required check

Before pointing the human to the browser, run:

`bun .codex/tools/aidlc-html.ts check --guide <file> --questions <slug>-questions.md`

Fix every finding. Do not present a guide that fails the base HTML artifact contract, lacks a question section, has an extra section, recommends a letter absent from its question, or still has empty prose.

The review UI enforces the same check: it shows the human a browser round only
once the guide passes, and until then the tab says "Preparing your questions".
So the human never sees an unfilled scaffold or a form without recommendations —
but it also means nothing appears in their browser until you have filled every
paragraph and every `data-aidlc-recommend`. Write the whole explainer in ONE
write after the scaffold, then check once.
