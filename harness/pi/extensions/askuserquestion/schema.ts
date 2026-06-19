import { type Static, Type } from "typebox";

// ── Input (what the LLM sends) ────────────────────────────────────────────────

export const OptionSchema = Type.Object({
  label: Type.String({
    description:
      "Display label shown to the user and returned as the answer value",
  }),
  description: Type.Optional(
    Type.String({
      description: "Optional clarifying text shown below the label",
    }),
  ),
});

export const QuestionSchema = Type.Object({
  question: Type.String({
    description: "Full question text displayed to the user",
  }),
  header: Type.String({
    description:
      "Short label used in the tab bar when multiple questions are shown. Max 12 characters.",
  }),
  options: Type.Array(OptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: "Between 2 and 4 choices for the user to select from",
  }),
  multiSelect: Type.Boolean({
    description:
      "When true the user may select multiple options. Answers are joined with ', '.",
  }),
});

export const InputSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: "1 to 4 questions to ask the user",
  }),
});

export type Option = Static<typeof OptionSchema>;
export type Question = Static<typeof QuestionSchema>;

// ── Output (details returned to the LLM and used in renderResult) ─────────────
//
// Answer encoding rules:
//   Single-select:       { [question]: "Label" }
//   Multi-select joined: { [question]: "Label A, Label C" }  (sorted by option index)
//   Free-text:           { [question]: "user typed text" }
//   Cancelled:           key absent from answers; cancelled: true

export const ResultSchema = Type.Object({
  // Pass-through so renderResult has headers + option descriptions without
  // re-parsing the LLM input.
  questions: Type.Array(QuestionSchema),

  // Maps question text → selected label(s).
  // Multi-select: labels joined with ", " e.g. "Option A, Option C"
  // Free-text: the user's typed string verbatim
  // Cancelled: key absent (see cancelled flag)
  answers: Type.Record(Type.String(), Type.String()),

  // True when the user pressed Esc before submitting
  cancelled: Type.Boolean(),
});

export type Result = Static<typeof ResultSchema>;