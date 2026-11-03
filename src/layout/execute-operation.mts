import type { APIRole } from "discord.js";
import { discordTypes } from "./inventory.mts";
import { rolePermissions } from "./permissions.mts";
import type { LayoutState, LockedState, UncertainCreate } from "./state.mts";
import type { DiscordPort, Target } from "./transport.mts";
import {
  decodeTags,
  fetchSnapshot,
  wireOverwrites,
  wireTags,
} from "./transport.mts";
import type {
  CompiledOverwrite,
  Operation,
  Overwrite,
  Snapshot,
} from "./types.mts";

function requiredId(entries: Record<string, string>, key: string): string {
  const id = entries[key];
  if (!id) throw new Error(`Missing binding: ${key}`);
  return id;
}
function compiled(
  entries: CompiledOverwrite[],
  state: LayoutState,
): Overwrite[] {
  return entries.map(({ roleKey, ...entry }) => ({
    ...entry,
    id: requiredId(state.ids.roles, roleKey),
  }));
}
function retainTags(
  state: LayoutState,
  channelKey: string,
  tags: { key: string; name: string; id?: string }[],
  response: unknown,
) {
  const live = decodeTags(
    (response as { available_tags: Parameters<typeof decodeTags>[0] })
      .available_tags,
  );
  state.ids.tags[channelKey] = Object.fromEntries(
    tags.map((tag) => {
      const matches = live.filter((entry) =>
        tag.id ? entry.id === tag.id : entry.name === tag.name,
      );
      if (matches.length !== 1)
        throw new Error(`Missing or ambiguous returned tag: ${tag.key}`);
      return [tag.key, matches[0].id];
    }),
  );
}

export async function executeOperation(
  operation: Operation,
  port: DiscordPort,
  target: Target,
  state: LayoutState,
  locked: LockedState,
): Promise<void> {
  const roleId = (key: string) => requiredId(state.ids.roles, key);
  const channelId = (key: string) => requiredId(state.ids.channels, key);
  const guildRoute = `/guilds/${target.guildId}` as const;
  let pending: UncertainCreate | undefined;
  if (operation.kind === "createRole")
    pending = {
      kind: "role",
      key: operation.role.key,
      name: operation.role.name,
    };
  if (operation.kind === "createChannel" || operation.kind === "createCategory")
    pending = {
      kind: "channel",
      key: operation.channel.key,
      name: operation.channel.name,
      type: operation.channel.type,
      parentKey: operation.channel.parent,
    };
  if (pending) {
    state.uncertainCreates = state.uncertainCreates.filter(
      (entry) => entry.kind !== pending.kind || entry.key !== pending.key,
    );
    state.uncertainCreates.push(pending);
    // A lost response must remain distinguishable from a request never sent.
    locked.write(state);
  }
  switch (operation.kind) {
    case "createRole":
    case "updateRole": {
      const creating = operation.kind === "createRole";
      const live = creating
        ? undefined
        : (await fetchSnapshot(port, target)).roles.find(
            (entry) => entry.id === roleId(operation.role.key),
          );
      if (!creating && !live) throw new Error("Missing role");
      const { allow, managed } = rolePermissions(operation.role);
      const body = {
        ...(operation.role.kind === "everyone"
          ? {}
          : {
              name: operation.role.name,
              color: operation.role.color,
              hoist: operation.role.hoist,
              mentionable: operation.role.mentionable,
            }),
        permissions: (
          (BigInt(live?.permissions ?? "0") & ~managed) |
          allow
        ).toString(),
      };
      const response = (await port.request(
        creating ? "POST" : "PATCH",
        creating
          ? `${guildRoute}/roles`
          : `${guildRoute}/roles/${roleId(operation.role.key)}`,
        body,
      )) as APIRole;
      if (creating) {
        if (!response.id) throw new Error("Missing created role ID");
        state.ids.roles[operation.role.key] = response.id;
      }
      break;
    }
    case "createCategory":
    case "createChannel": {
      const channel = operation.channel;
      const response = (await port.request("POST", `${guildRoute}/channels`, {
        name: channel.name,
        type: discordTypes[channel.type],
        topic: channel.topic,
        parent_id: channel.parent ? channelId(channel.parent) : null,
        permission_overwrites: wireOverwrites(
          compiled(operation.overwrites, state),
        ),
        ...(channel.type === "forum"
          ? { available_tags: wireTags(channel.tags) }
          : {}),
      })) as { id: string };
      if (!response.id) throw new Error("Missing created channel ID");
      state.ids.channels[channel.key] = response.id;
      state.ids.tags[channel.key] = {};
      locked.write(state);
      if (channel.tags.length)
        retainTags(state, channel.key, channel.tags, response);
      break;
    }
    case "updateChannel": {
      const channel = operation.channel;
      await port.request("PATCH", `/channels/${channelId(channel.key)}`, {
        name: channel.name,
        topic: channel.topic,
        parent_id: channel.parent ? channelId(channel.parent) : null,
        lock_permissions: false,
      });
      break;
    }
    case "protectOverwrites":
    case "replaceOverwrites": {
      const entries =
        operation.kind === "protectOverwrites"
          ? operation.overwrites
          : operation.overwrites.flatMap((entry) =>
              entry.kind === "preserved"
                ? [entry.overwrite]
                : compiled([entry], state),
            );
      await port.request(
        "PATCH",
        `/channels/${channelId(operation.channelKey)}`,
        { permission_overwrites: wireOverwrites(entries) },
      );
      break;
    }
    case "setForumTags": {
      const response = await port.request(
        "PATCH",
        `/channels/${channelId(operation.channelKey)}`,
        { available_tags: wireTags(operation.tags) },
      );
      retainTags(state, operation.channelKey, operation.tags, response);
      break;
    }
    case "reorderRoles":
    case "reorderChannels": {
      const snapshot = await fetchSnapshot(port, target);
      const entries =
        operation.kind === "reorderRoles"
          ? operation.roleKeys.map((key) =>
              snapshot.roles.find((entry) => entry.id === roleId(key)),
            )
          : operation.channelKeys.map((key) =>
              snapshot.channels.find((entry) => entry.id === channelId(key)),
            );
      const positions = entries
        .map((entry) => {
          if (!entry) throw new Error("Missing reorder target");
          return entry.position;
        })
        .sort((left, right) => left - right);
      const body = entries.map((entry, index) => ({
        id: entry?.id,
        position: positions[index],
      }));
      await port.request(
        "PATCH",
        `${guildRoute}/${operation.kind === "reorderRoles" ? "roles" : "channels"}`,
        body,
      );
      break;
    }
    case "removeOverwrite":
      await port.request(
        "DELETE",
        `/channels/${channelId(operation.channelKey)}/permissions/${operation.id}`,
      );
      break;
    case "deleteRole":
      await port.request("DELETE", `${guildRoute}/roles/${operation.id}`);
      if (state.ids.roles[operation.key] === operation.id)
        delete state.ids.roles[operation.key];
      break;
    case "deleteChannel":
    case "deleteCategory":
      await port.request("DELETE", `/channels/${operation.id}`);
      if (state.ids.channels[operation.key] === operation.id) {
        delete state.ids.channels[operation.key];
        delete state.ids.tags[operation.key];
      }
      break;
  }
  locked.write(state);
  if (pending) {
    state.uncertainCreates = state.uncertainCreates.filter(
      (entry) => entry.kind !== pending.kind || entry.key !== pending.key,
    );
    locked.write(state);
  }
}

export function pendingCandidates(
  state: LayoutState,
  snapshot: Snapshot,
): string[] {
  return state.uncertainCreates
    .filter((entry) =>
      entry.kind === "role"
        ? snapshot.roles.some((role) => role.name === entry.name)
        : snapshot.channels.some(
            (channel) =>
              channel.name === entry.name &&
              channel.type === discordTypes[entry.type] &&
              channel.parent ===
                (entry.parentKey ? state.ids.channels[entry.parentKey] : null),
          ),
    )
    .map((entry) => `Adoption required after uncertain create: ${entry.key}`);
}
