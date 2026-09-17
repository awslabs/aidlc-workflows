# Question Rendering — Devin Cloud harness annex

This annex binds the shared question specs to Devin Cloud. Before rendering any
question, read and follow [Structured questions]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#structured-questions-harness-neutral-contract)
and the applicable method sections below.

## Method references

- [Approval Gates]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#1-approval-gates): **Naming the next stage** and **Non-matching checkpoint replies**.
- [Question Format]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#3-question-format): Step 1 for file formatting; Step 3a for option coverage, Other, and answer recording; Steps 3b/3c for self-guided and chat modes.
- [Critical Compliance Checklist]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#critical-compliance-checklist-most-commonly-missed-steps): exact user input and stage ordering.
- [Conversation event logging checklist]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#mandatory-conversation-event-logging-checklist): question logging and human-wait boundaries.

## Mandatory consolidated-summary checkpoint

Read and follow [Question Format]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#3-question-format),
**Step 3a**, including its application to Steps 3b/3c, and the
[Conversation event logging checklist]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#mandatory-conversation-event-logging-checklist).
Apply the native mapping below to its normative confirmation spec.

## Mechanism

Devin Cloud has no structured-question tool. A structured question is a
**blocking chat message**: render the question in the session chat exactly as
specified below, then END YOUR TURN. A Cloud session natively waits for the
human's reply — ending the turn is the block. Never proceed on silence.

Map each neutral spec to plain chat text:

| Spec field | Chat rendering |
|------------|----------------|
| `prompt` | The question text, verbatim |
| `header` | A bolded label line above the prompt (e.g. `**Approval**`) |
| `multiSelect` | Append "(choose one)" or "(choose all that apply)" to the prompt |
| `options[].label` | One numbered line per option, the label in bold |
| `options[].description` | ` — ` + description after the label |

Example — this spec:

```question
prompt: "[Stage Name] complete. How would you like to proceed?"
header: Approval
multiSelect: false
options:
  - label: Approve
    description: Continue to [next stage]
  - label: Request Changes
    description: Provide revision feedback
```

renders as the chat message:

```
**Approval**

[Stage Name] complete. How would you like to proceed?

1. **Approve** — Continue to [next stage]
2. **Request Changes** — Provide revision feedback
3. **Other** — anything else you'd like instead
```

Then END YOUR TURN. The reply is the human's next message.

## Native limits and Other

- **Option count**: chat has no native cap, but keep the 2–4 explicit options
  discipline of the shared contract — a fifth option is signal the question is
  malformed, not something to list.
- **Other**: there is no built-in Other escape; write `Other` as the last
  numbered option yourself (as in the example). An Other reply is discussion
  input, not a substitute option label: route it through the Other rules in
  [Approval Gates]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#1-approval-gates)
  or [Question Format]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#3-question-format),
  as applicable.
- **Question identity**: render one question per message. Do not batch
  questions — a human answering "yes" to two questions at once is ambiguous.

## Answer recording

The human's reply arrives as the next chat message — there is no typed answer
envelope. Match the reply against the offered labels semantically, then record
it through the engine command the protocol names (`aidlc-log.ts answer`,
`report --user-input`, plan-approval `answer`), passing the session id you
minted at session start as `--session` where the command accepts it. A reply
matching no offered choice is handled by the non-matching-reply rules in the
shared contract: do not record it, re-present the question, and end the turn
again.
