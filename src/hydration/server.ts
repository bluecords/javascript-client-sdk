import { ReactiveMap } from "@solid-primitives/map";
import { ReactiveSet } from "@solid-primitives/set";
import type {
  Server as APIServer,
  Category,
  SystemMessageChannels,
} from "stoat-api";

import type { Client } from "../Client.js";
import { File } from "../classes/File.js";
import { ServerRole, type RoleClass } from "../classes/ServerRole.js";
import {
  DEFAULT_PERMISSION,
  DEFAULT_PERMISSION_VIEW_ONLY,
  Permission,
} from "../permissions/definitions.js";

import type { Hydrate } from "./index.js";

export type ClassDefault = {
  permissions: { a: bigint; d: bigint };
  channelOverrides: Map<string, { a: bigint; d: bigint }>;
  maxMessageLength?: number;
};

/**
 * Sane built-in defaults for a class, mirroring `ClassDefault::built_in` on the
 * backend exactly - used whenever a server hasn't customised `classDefaults` for
 * this class yet, so new/unconfigured servers behave consistently between the
 * client's own resolution (e.g. the compose box's character limit) and what the
 * server will actually enforce.
 */
export function builtInClassDefault(roleClass: RoleClass): ClassDefault {
  switch (roleClass) {
    case "admin":
      return {
        permissions: { a: 0x000f_ffff_ffff_ffffn, d: 0n },
        channelOverrides: new Map(),
        maxMessageLength: undefined, // unlimited - enforced separately, not via a number
      };
    case "member":
      return {
        permissions: { a: DEFAULT_PERMISSION, d: 0n },
        channelOverrides: new Map(),
        maxMessageLength: 5000,
      };
    case "free":
      return {
        permissions: {
          a: DEFAULT_PERMISSION_VIEW_ONLY + Permission.SendMessage,
          d: 0n,
        },
        channelOverrides: new Map(),
        maxMessageLength: 2000,
      };
  }
}

// `class_defaults` is newer than the generated `stoat-api` package - see the
// matching comment in ServerRole.ts.
type APIServerWithClassDefaults = APIServer & {
  class_defaults?: Record<
    RoleClass,
    {
      permissions: { a: number; d: number };
      channel_overrides?: Record<string, { a: number; d: number }>;
      max_message_length?: number;
    }
  >;
};

export type HydratedServer = {
  id: string;
  ownerId: string;

  name: string;
  description?: string;

  icon?: File;
  banner?: File;

  channelIds: ReactiveSet<string>;
  categories?: Category[];

  systemMessages?: SystemMessageChannels;
  roles: ReactiveMap<string, ServerRole>;
  defaultPermissions: bigint;
  classDefaults: Map<RoleClass, ClassDefault>;

  flags: ServerFlags;
  analytics: boolean;
  discoverable: boolean;
  nsfw: boolean;
};

export const serverHydration: Hydrate<APIServer, HydratedServer> = {
  keyMapping: {
    _id: "id",
    owner: "ownerId",
    channels: "channelIds",
    system_messages: "systemMessages",
    default_permissions: "defaultPermissions",
  },
  functions: {
    id: (server) => server._id,
    ownerId: (server) => server.owner,
    name: (server) => server.name,
    description: (server) => server.description!,
    channelIds: (server) => new ReactiveSet(server.channels),
    categories: (server) => server.categories ?? [],
    systemMessages: (server) => server.system_messages ?? {},
    roles: (server, ctx) =>
      new ReactiveMap(
        Object.keys(server.roles!).map((id) => [
          id,
          new ServerRole(ctx as Client, server._id, id, server.roles![id]),
        ]),
      ),
    defaultPermissions: (server) => BigInt(server.default_permissions),
    classDefaults: (server) => {
      const raw = (server as APIServerWithClassDefaults).class_defaults ?? {};
      return new Map(
        (Object.entries(raw) as [RoleClass, (typeof raw)[RoleClass]][]).map(
          ([roleClass, classDefault]) => [
            roleClass,
            {
              permissions: {
                a: BigInt(classDefault.permissions.a),
                d: BigInt(classDefault.permissions.d),
              },
              channelOverrides: new Map(
                Object.entries(classDefault.channel_overrides ?? {}).map(
                  ([channelId, override]) => [
                    channelId,
                    { a: BigInt(override.a), d: BigInt(override.d) },
                  ],
                ),
              ),
              maxMessageLength: classDefault.max_message_length,
            },
          ],
        ),
      );
    },
    icon: (server, ctx) => new File(ctx as Client, server.icon!),
    banner: (server, ctx) => new File(ctx as Client, server.banner!),
    flags: (server) => server.flags!,
    analytics: (server) => server.analytics || false,
    discoverable: (server) => server.discoverable || false,
    nsfw: (server) => server.nsfw || false,
  },
  initialHydration: () => ({
    channelIds: new ReactiveSet(),
    roles: new ReactiveMap(),
    classDefaults: new Map(),
  }),
};

/**
 * Flags attributed to servers
 */
export enum ServerFlags {
  Official = 1,
  Verified = 2,
}
