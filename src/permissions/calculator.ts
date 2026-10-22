import { Channel, Client, Server, ServerMember } from "../index.js";

import {
  ALLOW_IN_TIMEOUT,
  DEFAULT_PERMISSION_DIRECT_MESSAGE,
  DEFAULT_PERMISSION_VIEW_ONLY,
  Permission,
  UserPermission,
} from "./definitions.js";

/**
 * Check whether `b` is present in `a`
 * @param a Input A
 * @param b Inputs (OR'd together)
 */
export function bitwiseAndEq(a: bigint, ...b: bigint[]): boolean {
  const value = b.reduce((prev, cur) => prev | cur, 0n);
  return (value & a) === value;
}

type AllowDeny = { a: bigint; d: bigint };

/**
 * Lay one override over another: wherever `top` allows or denies a permission
 * it wins, every other permission shows `base` through. Mirrors the backend's
 * `layer_override`, used to put a channel's own overrides over its category's.
 */
export function layerOverride(base: AllowDeny, top: AllowDeny): AllowDeny {
  const touched = top.a | top.d;
  return {
    a: (base.a & ~touched) | top.a,
    d: (base.d & ~touched) | top.d,
  };
}

/**
 * Category overrides as sent by the API (plain numbers) as `AllowDeny`.
 */
export function toAllowDeny(raw?: { a: number | bigint; d: number | bigint }) {
  return raw ? { a: BigInt(raw.a), d: BigInt(raw.d) } : undefined;
}

/**
 * Blend a class default underneath a role's own explicit override, the same way
 * the backend's `resolve_role_base_override` does: any bit the role has
 * explicitly allowed or denied wins, every other bit inherits from the class.
 */
export function blendClassOverride(
  classOverride: AllowDeny,
  explicit: AllowDeny,
): AllowDeny {
  const touched = explicit.a | explicit.d;
  return {
    a: (classOverride.a & ~touched) | explicit.a,
    d: (classOverride.d & ~touched) | explicit.d,
  };
}

/**
 * Calculate permissions against a given object
 * @param target Target object to check permissions against
 * @param options Additional options to use when calculating
 */
export function calculatePermission(
  client: Client,
  target: Channel | Server,
  options?: {
    /**
     * Pretend to be another ServerMember
     */
    member?: ServerMember;
  },
): bigint {
  const user = options?.member ? options?.member.user : client.user;
  if (user?.privileged) {
    return Permission.GrantAllSafe;
  }

  if (target instanceof Server) {
    // 1. Check if owner.
    if (target.ownerId === user?.id) {
      return Permission.GrantAllSafe;
    } else {
      // 2. Get ServerMember.
      const member = options?.member ??
        client.serverMembers.getByKey({
          user: user!.id,
          server: target.id,
        }) ?? { roles: null, timeout: null };

      if (!member) return 0n;

      // 3. Apply allows from default_permissions.
      let perm = BigInt(target.defaultPermissions);

      // 4. If user has roles, iterate in order.
      if (member.roles && target.roles) {
        // 5. Apply allows and denies from roles.
        for (const role of member.orderedRoles) {
          const explicit: AllowDeny = {
            a: BigInt(role.permissions?.a ?? 0),
            d: BigInt(role.permissions?.d ?? 0),
          };

          const resolved = role.class
            ? blendClassOverride(
                target.getClassDefault(role.class).permissions,
                explicit,
              )
            : explicit;

          perm = (perm | resolved.a) & ~resolved.d;
        }
      }

      // 5. Revoke permissions if ServerMember is timed out.
      if (member.timeout && member.timeout > new Date()) {
        perm = perm & BigInt(ALLOW_IN_TIMEOUT);
      }

      return perm;
    }
  } else {
    // 1. Check channel type.
    switch (target.type) {
      case "SavedMessages":
        return Permission.GrantAllSafe;
      case "DirectMessage": {
        // 2. Determine user permissions.
        const user_permissions = target.recipient?.permission || 0;

        // 3. Check if the user can send messages.
        if (user_permissions & UserPermission.SendMessage) {
          return DEFAULT_PERMISSION_DIRECT_MESSAGE;
        } else {
          return DEFAULT_PERMISSION_VIEW_ONLY;
        }
      }
      case "Group": {
        // 2. Check if user is owner.
        if (target.ownerId === user!.id) {
          return Permission.GrantAllSafe;
        } else {
          // 3. Pull out group permissions.
          return target.permissions ?? DEFAULT_PERMISSION_DIRECT_MESSAGE;
        }
      }
      case "TextChannel":
      case "ForumChannel": {
        // 2. Get server.
        const server = target.server;
        if (typeof server === "undefined") return 0n;

        // 3. If server owner, just grant all permissions.
        if (server.ownerId === user?.id) {
          return Permission.GrantAllSafe;
        } else {
          // 4. Get ServerMember.
          const member = options?.member ??
            client.serverMembers.getByKey({
              user: user!.id,
              server: server.id,
            }) ?? { roles: null, timeout: null };

          if (!member) return 0n;

          // 5. Calculate server base permissions.
          let perm = BigInt(calculatePermission(client, server, options));

          // 6. Apply default allows and denies for channel, laid over its
          // category's (the channel wins for anything it sets itself).
          const category = target.category;
          const defaults =
            category && target.defaultPermissions
              ? layerOverride(
                  toAllowDeny(category.default_permissions) ?? { a: 0n, d: 0n },
                  {
                    a: BigInt(target.defaultPermissions.a),
                    d: BigInt(target.defaultPermissions.d),
                  },
                )
              : target.defaultPermissions
                ? {
                    a: BigInt(target.defaultPermissions.a),
                    d: BigInt(target.defaultPermissions.d),
                  }
                : toAllowDeny(category?.default_permissions);
          if (defaults) {
            perm = (perm | defaults.a) & ~defaults.d;
          }

          // 7. If user has roles, iterate in order.
          if (member.roles && server.roles) {
            // 5. Apply allows and denies from roles - including a classed
            // role's per-channel class template, even with no explicit entry.
            for (const role of member.orderedRoles) {
              const raw = target.rolePermissions?.[role.id];
              const own: AllowDeny | undefined = raw
                ? { a: BigInt(raw.a), d: BigInt(raw.d) }
                : undefined;
              const inherited = toAllowDeny(
                target.category?.role_permissions?.[role.id],
              );
              let override: AllowDeny | undefined =
                inherited && own
                  ? layerOverride(inherited, own)
                  : (own ?? inherited);

              const template = role.class
                ? server
                    .getClassDefault(role.class)
                    .channelOverrides.get(target.id)
                : undefined;
              if (template) {
                override = blendClassOverride(
                  template,
                  override ?? { a: 0n, d: 0n },
                );
              }

              if (override) {
                perm = (perm | override.a) & ~override.d;
              }
            }
          }

          // 8. Revoke permissions if ServerMember is timed out.
          if (member.timeout && member.timeout > new Date()) {
            perm = perm & BigInt(ALLOW_IN_TIMEOUT);
          }

          return perm;
        }
      }
    }

    return 0n;
  }
}
