import type { ChannelType as DiscordChannelType } from "discord.js";

export const channelTypes = [
  "category",
  "text",
  "news",
  "forum",
  "voice",
] as const;
export type ChannelType = (typeof channelTypes)[number];
export type Access = {
  view: boolean;
  send: boolean;
  connect: boolean;
  manageThreads: boolean;
};
export type Role = {
  key: string;
  name: string;
  kind: "everyone" | "operator" | "managed" | "observed";
  permissions: Record<string, boolean>;
  color: number;
  hoist: boolean;
  mentionable: boolean;
};
export type Tag = {
  key: string;
  name: string;
  moderated: boolean;
  emoji?: string;
};
export type Channel = {
  key: string;
  name: string;
  type: ChannelType;
  parent?: string;
  topic: string;
  access: Record<string, Access>;
  tags: Tag[];
};
/** Ignore entries are live role names, channel names, and overwrite role names. */
export type Ignore = {
  roles: string[];
  channels: string[];
  overwrites: string[];
};
export type Layout = {
  roles: Role[];
  channels: Channel[];
  ignore: Ignore;
};
export type Overwrite = {
  id: string;
  type: "role" | "member";
  allow: string;
  deny: string;
};
export type LiveRole = {
  id: string;
  name: string;
  permissions: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number;
  managed: boolean;
  applicationId?: string;
};
export type LiveChannel = {
  id: string;
  name: string;
  type: DiscordChannelType;
  parent: string | null;
  topic: string;
  position: number;
  overwrites: Overwrite[];
  tags: (Omit<Tag, "key"> & { id: string })[];
};

/** Normalized guild inventory excludes threads, messages, and members. */
export type Snapshot = {
  guildId: string;
  applicationId: string;
  roles: LiveRole[];
  channels: LiveChannel[];
};
/** Stable layout keys bind identities; tag keys are scoped by channel key. */
export type IdMap = {
  roles: Record<string, string>;
  channels: Record<string, string>;
  tags: Record<string, Record<string, string>>;
};
/** Persisted identity bindings use an explicit format version. */
export type State = { schemaVersion: 1; guildId: string; ids: IdMap };
export type CompiledOverwrite = Omit<Overwrite, "id"> & { roleKey: string };

/** The executor writes preserved entries byte for byte. */
export type ReplacementOverwrite =
  | ({ kind: "compiled" } & CompiledOverwrite)
  | { kind: "preserved"; overwrite: Overwrite };

/** Stable keys resolve after creates; reorder targets contain managed siblings only. */
export type Operation =
  | { kind: "createRole" | "updateRole"; role: Role }
  | {
      kind: "createCategory" | "createChannel";
      channel: Channel;
      overwrites: CompiledOverwrite[];
    }
  | { kind: "updateChannel"; channel: Channel; lockPermissions: false }
  | { kind: "protectOverwrites"; channelKey: string; overwrites: Overwrite[] }
  | {
      kind: "replaceOverwrites";
      channelKey: string;
      overwrites: ReplacementOverwrite[];
    }
  | {
      kind: "setForumTags";
      channelKey: string;
      tags: (Tag & { id?: string })[];
      destructive: boolean;
    }
  | { kind: "reorderRoles"; roleKeys: string[] }
  | { kind: "reorderChannels"; channelKeys: string[]; parentKey?: string }
  | {
      kind: "deleteChannel" | "deleteCategory" | "deleteRole";
      key: string;
      id: string;
      destructive: true;
    }
  | {
      kind: "removeOverwrite";
      channelKey: string;
      id: string;
      destructive: true;
    };
