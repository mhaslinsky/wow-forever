import {
  type Interaction,
  message,
  type Route,
} from "../interactions/core.mts";

export function createAskRoutes(
  answer: (
    interaction: Interaction,
    question: string,
    web: boolean,
    signal: AbortSignal,
  ) => Promise<string>,
): Route[] {
  return [
    {
      type: 2,
      name: "ask",
      description: "Ask AutoGM a question",
      mode: "slow",
      visibility: "ephemeral",
      options: [
        {
          type: 3,
          name: "question",
          description: "Your question",
          required: true,
          min_length: 1,
          max_length: 2000,
        },
        {
          type: 5,
          name: "web",
          description: "Send your question to a web search service",
          required: false,
        },
      ],
      async handler(interaction, signal) {
        const options = interaction.data?.options;
        if (!Array.isArray(options)) return message("Enter a question.");
        const question = options.find(
          (option) => option?.name === "question",
        )?.value;
        const web = options.find((option) => option?.name === "web")?.value;
        if (
          typeof question !== "string" ||
          (web !== undefined && typeof web !== "boolean")
        )
          return message("Enter a question.");
        return message(
          await answer(interaction, question, web === true, signal),
        );
      },
    },
  ];
}
