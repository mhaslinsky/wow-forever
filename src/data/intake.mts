import type { Application } from "./application.mts";
import type { CharacterDeclaration, Source } from "./recruiting.mts";

export type IntakePayload = {
  name: string;
  source: Source;
  actorId: string;
  changedAt: string;
  nextActionAt: string;
  owner?: string;
  discordUserId?: string;
  characters?: CharacterDeclaration[];
  application?: Application;
  content: string;
  submission: string;
};
export type IntakeState =
  | "pending"
  | "uncertain"
  | "created"
  | "done"
  | "blocked";
export type IntakeFields = {
  state: IntakeState;
  attemptId: string;
  startedAt: string;
  ref: string;
  payload?: IntakePayload;
  threadId?: string;
  noticeSent?: boolean;
  outcome?: "expired" | "uncertain";
};
