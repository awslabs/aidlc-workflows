import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, TruncatedText } from "@earendil-works/pi-tui";
import { AskUserQuestionComponent } from "./component.ts";
import { InputSchema, type Question, type Result } from "./schema.ts";
import { validateUniqueness } from "./validate.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description: `Ask the user 1–4 clarifying questions before proceeding.
Use this tool to:
1. Clarify ambiguous instructions
2. Get the user's preference between valid approaches
3. Make decisions on implementation choices
4. Offer choices about what direction to take
Each question must have 2–4 options. Users can always select "Other" to type a free-text answer, so do not include an "Other" option yourself.
Option labels should be concise (1–5 words).
Set multiSelect: true when more than one option can validly apply at the same time.
The header field is a short label (max 12 characters) used in the tab bar when showing multiple questions.
If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.
Always use this tool instead of asking questions in plain text — it provides a structured, interactive UI.`,

    parameters: InputSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Reject duplicate question texts or duplicate option labels
      const validationError = validateUniqueness(params.questions);
      if (validationError) {
        return {
          content: [{ type: "text", text: `Error: ${validationError}` }],
          details: {
            questions: params.questions,
            answers: {},
            cancelled: true,
          } satisfies Result,
        };
      }

      if (!ctx.hasUI) {
        // Non-interactive session — deregister so the LLM won't try again
        pi.setActiveTools(
          pi.getActiveTools().filter((name) => name !== "ask_user_question"),
        );
        return {
          content: [
            {
              type: "text",
              text: "Error: ask_user_question requires an interactive session. The tool has been disabled for this session.",
            },
          ],
          details: {
            questions: params.questions,
            answers: {},
            cancelled: true,
          } satisfies Result,
        };
      }

      const result = await ctx.ui.custom<Result | null>(
        (tui, theme, _kb, done) =>
          new AskUserQuestionComponent(params.questions, tui, theme, done),
      );

      if (result === null || result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled" }],
          details: {
            questions: params.questions,
            answers: {},
            cancelled: true,
          } satisfies Result,
        };
      }

      const summaryLines = result.questions.map(
        (q) =>
          `"${q.question}" = "${result.answers[q.question] ?? "(no answer)"}"`,
      );

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details: result satisfies Result,
      };
    },

    renderCall(args, theme) {
      const questions = (args.questions ?? []) as Question[];
      const topics = questions.map((q) => q.header).join(", ");
      return new TruncatedText(
        theme.fg("toolTitle", theme.bold("ask user ")) +
          theme.fg("muted", topics),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as Result | undefined;

      if (!details) {
        const t = result.content[0];
        return new TruncatedText(t?.type === "text" ? t.text : "", 0, 0);
      }

      if (details.cancelled) {
        return new TruncatedText(theme.fg("warning", "Cancelled"), 0, 0);
      }

      // One TruncatedText per question — each line item truncated independently
      const box = new Box(0, 0);
      for (const q of details.questions) {
        const answer = details.answers[q.question] ?? "(no answer)";
        box.addChild(
          new TruncatedText(
            theme.fg("success", "✓ ") +
              theme.fg("accent", `${q.header}: `) +
              theme.fg("text", answer),
            0,
            0,
          ),
        );
      }
      return box;
    },
  });
}