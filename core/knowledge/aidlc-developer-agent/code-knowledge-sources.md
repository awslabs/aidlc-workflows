# Reading an Existing Code-Knowledge Source

A code-knowledge source is a folder of machine-readable facts about the
repository that a tool outside AI-DLC built before this scan: a code graph of
files, symbols and the edges between them, an inventory of packages and CI
jobs, the analyses computed from them. The team registers it once, and the
Reverse Engineering brief hands you each registered source with its `kind`,
its folder (`dir`), the commit it was built from, a verdict, and a `guide`
when the team wrote one for that kind. This file is the method that holds for
every kind; the guide is the part that knows the files.

## What the verdict means for your scan

- **CURRENT**: the source was built from the commit checked out. Read it
  first. Take from it everything it states as fact (the file inventory and
  roles, languages and sizes, packages and versions, imports and calls,
  entry points, test files and what they test, CI jobs, churn), then open
  code for two things only: to confirm a fact you will state that the source
  derived rather than read (an edge matched by name, a role guessed from a
  path), and to fill in what no graph holds (what the code is for, how a
  request is handled, the quality of the error handling).
- **STALE** or **UNKNOWN**: the source was built from another commit, or from
  one you cannot tell. Use it as a map of an older build to find the areas,
  the hubs and the entry points quickly; read the code for every fact you
  record, because the map may be out of date where it matters.

Uncommitted changes in the working tree are invisible to any source; the
snapshot the stage took covers them, and your scan reads the code as it is.

## How to read a source

1. Open the `guide` first when the brief names one: it says which files hold
   which facts, how to read them, and what the kind cannot say. Without a
   guide, start from any summary or report file the folder has, then its
   machine-readable files.
2. Prefer facts the tool resolved exactly over facts it matched by name.
   A graph usually marks each edge's resolution or tier; draw diagrams from
   the exact and bound edges and treat name-matched ones as leads.
3. Read a very large file by its header and by filtering, never whole: a
   graph's node file can be hundreds of megabytes. Your file tools and a
   line-oriented filter are enough; run none of the source tool's own
   commands unless the person asked for that.
4. The source describes the repository as the tool saw it. AI-DLC's own
   install and the folders the "What to Skip" section of
   `code-analysis-guide.md` leaves out stay out of your scan even when the
   source lists them, and a folder the source left out (its exclusions, code
   it marked as vendored) is yours to skim or leave out as that section says.

## What you record

- In Scan Coverage, under **Sources read**: each source as `<kind>` at
  `<dir>`, built at commit `<commit>`, `<verdict>`. The **Analyzed deeply**,
  **Skimmed only** and **Left out** lists still say what you did with the
  code; a source does not widen them.
- Beside a finding you took from the source and did not confirm in the code,
  say so: `(from <kind>)`. A reader of the nine artifacts can then tell a
  measured fact from a read one.
- In the Handoff Summary, one line on how far the source carried the scan and
  what it left for the code, so the architect weighs the two the same way.

The Scope of Analysis block and the store's fingerprint are minted by AI-DLC's
own tools over the working tree, exactly as on a scan with no source.
