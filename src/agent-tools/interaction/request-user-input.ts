import type { ToolDefinition, UserInputQuestion } from "../../types";
import { assertObject, asString } from "../../utils";

export const requestUserInputTool: ToolDefinition = {
  name: "request_user_input",
  description: "Ask 1-3 questions with required defaults; timeout is 120 seconds.",
  inputSchema: {
    type: "object",
    required: ["questions"],
    properties: {
      timeoutSeconds: { type: "integer" },
      questions: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "question", "recommended"],
          properties: {
            id: { type: "string" },
            header: { type: "string" },
            question: { type: "string" },
            recommended: { type: "string" },
            choices: {
              type: "array",
              items: { type: "object", required: ["label"], properties: {
                label: { type: "string" },
                description: { type: "string" }
              }, additionalProperties: false }
            }
          },
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 86_400_000,
  parallel: true,
  concurrencyScope: "session",
  renderHuman: (result) => result.output ?? result.summary,
  renderModel: (result) => result.output ?? result.summary,
  run: async (args, context) => {
    assertObject(args, "args");
    if (!context.requestUserInput) throw new Error("interactive user input is unavailable in this runtime");
    if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) throw new Error("questions must contain one to three items");
    const timeoutSeconds = args.timeoutSeconds === undefined ? 120 : args.timeoutSeconds;
    if (!Number.isInteger(timeoutSeconds) || (timeoutSeconds as number) < 10 || (timeoutSeconds as number) > 3_600) {
      throw new Error("timeoutSeconds must be an integer from 10 to 3600");
    }
    const seen = new Set<string>();
    const questions = args.questions.map((raw, index): UserInputQuestion => {
      assertObject(raw, `questions[${index}]`);
      const id = asString(raw.id, `questions[${index}].id`).trim();
      const question = asString(raw.question, `questions[${index}].question`).trim();
      const recommended = asString(raw.recommended, `questions[${index}].recommended`).trim();
      if (!id || seen.has(id)) throw new Error(`question id must be unique: ${id || "(empty)"}`);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error(`question id must be 1-64 safe identifier characters: ${id}`);
      if (!question || question.length > 1_000) throw new Error(`questions[${index}].question must contain 1-1000 characters`);
      seen.add(id);
      if (raw.choices !== undefined && (!Array.isArray(raw.choices) || raw.choices.length < 2 || raw.choices.length > 4)) {
        throw new Error(`questions[${index}].choices must contain two to four items`);
      }
      const choices = Array.isArray(raw.choices)
        ? raw.choices.map((choice, choiceIndex) => {
            assertObject(choice, `questions[${index}].choices[${choiceIndex}]`);
            const label = asString(choice.label, `questions[${index}].choices[${choiceIndex}].label`).trim();
            if (!label || label.length > 256) throw new Error(`choice label must contain 1-256 characters`);
            const description = typeof choice.description === "string" ? choice.description.trim() : undefined;
            if (description && description.length > 1_000) throw new Error(`choice description must not exceed 1000 characters`);
            return { label, ...(description ? { description } : {}) };
          })
        : undefined;
      if (!recommended || recommended.length > 1_000) throw new Error(`questions[${index}].recommended must contain 1-1000 characters`);
      if (choices?.length && !choices.some((choice) => choice.label === recommended)) {
        throw new Error(`questions[${index}].recommended must exactly match one choice label`);
      }
      const header = typeof raw.header === "string" ? raw.header.trim() : undefined;
      if (raw.header !== undefined && (!header || header.length > 64)) throw new Error(`questions[${index}].header must contain 1-64 characters`);
      return { id, question, recommended, ...(header ? { header } : {}), ...(choices?.length ? { choices } : {}) };
    });
    const answer = await context.requestUserInput({ questions, timeoutSeconds: timeoutSeconds as number }, context.signal);
    const output = questions.map((question) => `${question.id}: ${answer.answers[question.id] ?? ""}`).join("\n");
    const timedOut = answer.resolution === "timeout";
    return {
      ok: true,
      summary: timedOut
        ? `auto-selected recommended answer${questions.length === 1 ? "" : "s"} after timeout`
        : `answered ${questions.length} question${questions.length === 1 ? "" : "s"}`,
      output,
      metadata: { answers: answer.answers, resolution: answer.resolution ?? "user" }
    };
  }
};
