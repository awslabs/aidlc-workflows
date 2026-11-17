# Summary Protocol Module

Load this module when the engine lists `summary` in `directive.protocol_modules`: the step asks for the summary confirmation (`directive.ceremony.summary_confirmation` is `on`). It is the checkpoint stage-protocol.md section 3 names in Step 3a, and Steps 3b and 3c use it the same way.

- **Consolidated summary before generation**: The checkpoint below applies only when the step asks for the summary confirmation. When it does not, generate directly from the answers with no confirmation prompt, confirmation entry, or receipt. With it on, after all questions have been
  answered, present a consolidated summary of all answers as unordered bullets (never a numbered list). The person confirms what they can read: the bullets sit in the question itself, or right above it in the same message, as the question-rendering annex shows; never only in a tool's output or a file. Then run
  `bun {{HARNESS_DIR}}/tools/aidlc-review-brief.ts summary --stage "<directive.stage>" --questions-file "<questions-path>"`;
  add `--unit "<directive.unit>"` on a per-unit stage. Print its compact
  decision brief verbatim before presenting this structured question. The brief
  names the stage, the questions file and artifacts being confirmed, and the
  exact effect of both choices:
  ```question
  prompt: "Does this all look correct before I generate the artifact?"
  header: Confirm
  multiSelect: false
  options:
    - label: Looks correct
      description: Generate the artifact from these answers
    - label: Request changes
      description: Revise one or more answers before generation
  ```
  Before presenting it, append or update a dedicated **Consolidated Summary Confirmation**
  entry in `<slug>-questions.md` with this prompt, both options **without
  file-letter prefixes**, and a blank `[Answer]:` tag:
  ```markdown
  - Looks correct
  - Request changes

  [Answer]:
  ```
  This confirmation entry is the exception to ordinary file-backed {{OPTION_LETTERS}}/X
  labels. Fill its tag only after the user responds, storing exactly
  `[Answer]: Looks correct` or `[Answer]: Request changes`. Strip any source
  letter, chat number, punctuation, or option description before writing;
  `[Answer]: A. Looks correct` and `[Answer]: 1. Looks correct` are invalid.
  Before presenting it, record the checkpoint prompt:
  `{{INVOKE}} engine log decision --stage <slug>
  --checkpoint summary-confirmation --questions-file "<questions-path>"
  --decision "Does this all look correct before I generate the artifact?"
  --options "Looks correct,Request changes"`; add `--unit "<directive.unit>"`
  for a per-unit stage and `--single` for an isolated run. Never ask for this confirmation as bare prose: the harness must render an answerable structured
  question before the turn ends.

  After the person responds, read their reply, write the choice they made to the
  confirmation `[Answer]:` tag (`Looks correct` or `Request changes`), then
  record the human-backed receipt with
  `{{INVOKE}} engine log answer --stage <slug>
  --checkpoint summary-confirmation --questions-file "<questions-path>"
  --details "Looks correct"` (or `--details 'Request changes: <what they asked
  to change>'`, single-quoted as below) using the same `--unit` / `--single`
  identity (see "Reading the person's reply at a checkpoint" in stage-protocol.md section 1). The tool refuses a
  self-selected answer, a response without a matching prompt record or with no
  reply of theirs since you recorded it, or a questions file whose stored
  choice differs from the one you record. When they replied before you recorded
  the prompt (you showed the summary first), add `--message <id>` naming the
  message that answered it, without asking them again.
  An **Other** selection with no words of their own follows the Other-escape
  rule in stage-protocol.md section 1: discuss it, re-present the confirmation, and leave the tag
  and receipt untouched. Every other reply follows the reply-reading rule there.

  If the choice is **Request changes**, append a sibling
  `## Requested Changes Feedback` question with a blank `[Answer]:`. When their
  reply already says what should change (the receipt output repeats it as
  `feedback`), those words are the feedback: write them to the follow-up tag
  without asking again. Otherwise ask the direct free-text question
  **"What should change?"**, and END THE TURN. Do not revise anything until the
  human provides that feedback. Record feedback you asked for through the
  ordinary `aidlc-log.ts decision` / `answer` pair, write it to the follow-up tag, update
  the relevant answer tags, reset the confirmation entry to a blank `[Answer]:`,
  and re-present the summary. Only proceed to artifact generation after the
  human explicitly chooses **Looks correct** and the receipt command succeeds.
  Each later Request Changes cycle appends another sibling feedback section;
  retain those sections in chronological order. If the stage has an
  `Assumption Confirmation` section, replace its post-summary body and answer
  when follow-up questions are converted; do not append a duplicate heading.
  Follow-up questions change the confirmed semantic content, so present the
  consolidated summary again and record a new confirmation receipt before
  re-saving artifacts or requesting review.
  A later round of questions in a file whose summary was already confirmed (a
  revision, or a step reopened after its approval) takes the same shape: its
  questions are new `## Q<n>` sections after the summary, numbered on from the
  last one, never a section of their own or a second summary. Rewrite the
  bullets of the one Consolidated Summary Confirmation section to cover every
  answer, old and new, blank its `[Answer]:` line, and confirm it again as above.
