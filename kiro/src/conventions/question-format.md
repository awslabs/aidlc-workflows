# Question Format

When asking clarification questions, use this format for each question:

```
### Q<n>: <question text>

a) Option A
b) Option B
c) Option C
d) Other

**Trade Offs:** <explain the trade-offs between options, if applicable>

**Recommendation:** <AI's recommended option with brief reasoning>

[Answer]:
```

## Rules

- Present questions one at a time in chat, using the same format above
- If two questions are closely related, present them together
- Show progress: "Q1 of N", "Q2 of N", etc.
- Wait for the human's answer before presenting the next question
- Trade Offs and Recommendation sections are optional per question — include them when the choice has meaningful implications, skip for straightforward questions
- All questions are persisted to `questions.md` in the stage output directory
