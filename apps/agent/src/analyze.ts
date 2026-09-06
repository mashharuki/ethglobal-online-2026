import Anthropic from "@anthropic-ai/sdk";

/**
 * The `analyze` leg (tasks.md T120, FR-021 / FR-026): the decrypted dataset and the question go
 * to Claude with ONE tool, `answer`, forced via tool_choice, so the reply is structured and
 * every claim carries the numbers it rests on. Real inference every time (constitution III /
 * SC-009): there is no fallback answer and nothing is cached.
 */
export type Evidence = { label: string; value: string };

export type Analysis = {
  answer: string;
  evidence: Evidence[];
  confidence: "high" | "medium" | "low";
};

const DEFAULT_MODEL = "claude-sonnet-5";

/** Characters of dataset handed to the model; larger payloads are cut and the cut is reported. */
export const DATASET_CHAR_LIMIT = 200_000;

export const ANSWER_TOOL = {
  name: "answer",
  description:
    "Deliver the final answer to the question about the dataset. Every number in `answer` must appear in `evidence`, copied from the dataset (not computed loosely).",
  input_schema: {
    type: "object" as const,
    properties: {
      answer: {
        type: "string",
        description: "The answer, 1-3 sentences, with the figures.",
      },
      evidence: {
        type: "array",
        description: "The dataset values the answer rests on, verbatim.",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "row / column / segment the value belongs to",
            },
            value: {
              type: "string",
              description: "the value exactly as it appears in the dataset",
            },
          },
          required: ["label", "value"],
        },
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["answer", "evidence", "confidence"],
  },
};

export function truncateDataset(
  content: string,
  limit = DATASET_CHAR_LIMIT,
): { content: string; truncated: boolean } {
  if (content.length <= limit) return { content, truncated: false };
  return { content: content.slice(0, limit), truncated: true };
}

type ContentBlock = { type: string; name?: string; input?: unknown };

/** The `answer` tool call out of a Messages response; throws when the model did not answer. */
export function extractAnswer(message: { content: ContentBlock[] }): Analysis {
  const block = message.content.find(
    (c) => c.type === "tool_use" && c.name === ANSWER_TOOL.name,
  );
  if (block === undefined)
    throw new Error("model returned no `answer` tool call");
  const input = (
    typeof block.input === "object" && block.input !== null ? block.input : {}
  ) as {
    answer?: unknown;
    evidence?: unknown;
    confidence?: unknown;
  };
  if (typeof input.answer !== "string" || input.answer.trim() === "") {
    throw new Error("`answer` tool call has no answer text");
  }
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.flatMap((e: unknown): Evidence[] => {
        const item = (typeof e === "object" && e !== null ? e : {}) as {
          label?: unknown;
          value?: unknown;
        };
        return typeof item.label === "string" && typeof item.value === "string"
          ? [{ label: item.label, value: item.value }]
          : [];
      })
    : [];
  const confidence =
    input.confidence === "high" ||
    input.confidence === "medium" ||
    input.confidence === "low"
      ? input.confidence
      : "low";
  return { answer: input.answer, evidence, confidence };
}

/**
 * Evidence values that are not literally in the dataset: the grounding check the harness runs
 * on the model's own citations (SC-007 asks for an answer *about the decrypted data*).
 */
export function ungroundedEvidence(
  analysis: Analysis,
  dataset: string,
): Evidence[] {
  return analysis.evidence.filter((e) => !dataset.includes(e.value));
}

export async function analyzeDataset(input: {
  question: string;
  dataset: { format: string; content: string };
  client?: Anthropic;
  model?: string;
}): Promise<{ analysis: Analysis; model: string; truncated: boolean }> {
  const client = input.client ?? new Anthropic();
  const model = input.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const { content, truncated } = truncateDataset(input.dataset.content);
  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    system:
      "You are analysing a dataset an autonomous agent just bought and decrypted. Answer only from the dataset provided; if it cannot answer the question, say so in `answer` with confidence low.",
    tools: [ANSWER_TOOL],
    tool_choice: { type: "tool", name: ANSWER_TOOL.name },
    messages: [
      {
        role: "user",
        content: `Dataset (${input.dataset.format}${truncated ? ", truncated" : ""}):\n\n${content}\n\nQuestion: ${input.question}`,
      },
    ],
  });
  return { analysis: extractAnswer(message), model, truncated };
}
