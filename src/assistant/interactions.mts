import {
  type Interaction,
  message,
  type Route,
} from "../interactions/core.mts";

export function createAskRoutes(
  answer: (
    interaction: Interaction,
    question: string,
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
      ],
      async handler(interaction, signal) {
        const options = interaction.data?.options;
        if (!Array.isArray(options)) return message("You forgot the question.");
        const question = options.find(
          (option) => option?.name === "question",
        )?.value;
        if (typeof question !== "string")
          return message("You forgot the question.");
        return {
          type: 4,
          data: {
            content: await answer(interaction, question, signal),
            flags: 64 | 4,
          },
        };
      },
    },
  ];
}
