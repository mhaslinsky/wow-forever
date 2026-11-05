import type { Principal } from "../auth/index.mts";
import { authority } from "../auth/index.mts";

export type IntakeResolution = {
  ref: string;
  thread?: string;
  release?: boolean;
};

export function resolutionThread(
  actor: Principal<"user">,
  input: IntakeResolution,
  guildId: string,
): string | undefined {
  if (!authority(actor).roles.includes("Officer"))
    throw new Error("WRITE_DENIED");
  if (
    !/^[a-f0-9]{64}$/.test(input.ref) ||
    (input.thread === undefined
      ? input.release !== true
      : input.release !== undefined)
  )
    throw new Error("INVALID_INTAKE_RESOLUTION");
  if (input.thread === undefined) return;
  let link: URL;
  try {
    link = new URL(input.thread);
  } catch {
    throw new Error("INVALID_INTAKE_LINK");
  }
  const parts = link.pathname.split("/");
  if (
    link.protocol !== "https:" ||
    !["discord.com", "ptb.discord.com", "canary.discord.com"].includes(
      link.host,
    ) ||
    link.username ||
    link.password ||
    link.search ||
    link.hash ||
    (parts.length !== 4 && parts.length !== 5) ||
    parts[1] !== "channels" ||
    parts[2] !== guildId ||
    !parts.slice(2).every((part) => /^[0-9]+$/.test(part))
  )
    throw new Error("INVALID_INTAKE_LINK");
  return parts.at(-1);
}
