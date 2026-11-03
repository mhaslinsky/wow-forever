import type { Route } from "../src/interactions/core.mts";

export const fixtures: Route[] = [
  {
    type: 2,
    name: "fixture-fast",
    description: "Fast fixture",
    mode: "fast",
    visibility: "ephemeral",
    handler: async () => ({ type: 4, data: { content: "Done", flags: 64 } }),
  },
  {
    type: 2,
    name: "fixture-slow",
    description: "Slow fixture",
    mode: "slow",
    visibility: "ephemeral",
    cooldownSeconds: 10,
    handler: async () => ({ type: 4, data: { content: "Completed" } }),
  },
  {
    type: 3,
    name: "fixture-component",
    mode: "slow",
    visibility: "public",
    handler: async () => ({ type: 4, data: { content: "Updated" } }),
  },
  {
    type: 5,
    name: "fixture-modal",
    mode: "fast",
    visibility: "ephemeral",
    handler: async () => ({ type: 4, data: { content: "Submitted" } }),
  },
  {
    type: 3,
    name: "fixture-open-modal",
    mode: "fast",
    visibility: "ephemeral",
    handler: async () => ({
      type: 9,
      data: {
        custom_id: "fixture-modal:form",
        title: "Fixture",
        components: [],
      },
    }),
  },
  {
    type: 4,
    name: "fixture-fast",
    mode: "fast",
    visibility: "public",
    handler: async () => ({
      type: 8,
      data: { choices: [{ name: "Choice", value: "choice" }] },
    }),
  },
];
