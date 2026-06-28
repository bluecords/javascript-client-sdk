import type { Role as APIRole } from "stoat-api";

import type { Client } from "../Client.js";

import { File } from "./File.js";

/** The three built-in permission tiers - see Role.class on the backend. */
export type RoleClass = "admin" | "member" | "free";

// `class`/`max_message_length` are newer than the generated `stoat-api` package
// (it's regenerated from the OpenAPI spec separately from this codebase, and
// hasn't caught up yet) - read them defensively rather than waiting on that.
type APIRoleWithClass = APIRole & {
  class?: RoleClass;
  max_message_length?: number;
};

/**
 * Server Role
 */
export class ServerRole {
  protected client: Client;
  protected serverId: string;

  readonly id: string;
  readonly name: string;
  readonly icon?: File;
  readonly permissions: {
    a: bigint;
    d: bigint;
  };
  readonly colour?: string;
  readonly hoist: boolean;
  readonly rank: number;
  readonly class?: RoleClass;
  readonly maxMessageLength?: number;

  /**
   * Construct server role
   * @param client Client
   * @param serverId Server ID
   * @param id Role ID
   * @param data Role data
   */
  constructor(client: Client, serverId: string, id: string, data: APIRole) {
    this.client = client;
    this.serverId = serverId;

    this.id = id;
    this.name = data.name;
    this.icon = data.icon ? new File(client, data.icon) : undefined;
    this.permissions = {
      a: BigInt(data.permissions.a),
      d: BigInt(data.permissions.d),
    };
    this.colour = data.colour ?? undefined;
    this.hoist = data.hoist || false;
    this.rank = data.rank ?? 0;

    const withClass = data as APIRoleWithClass;
    this.class = withClass.class;
    this.maxMessageLength = withClass.max_message_length;
  }

  /**
   * Write to string as a role mention
   * @returns Formatted String
   */
  toString(): string {
    return `<%${this.id}>`;
  }

  /**
   * Server attached to this role
   */
  get server() {
    return this.client.servers.get(this.serverId);
  }

  /**
   * Whether this role is assigned to our server member
   */
  get assigned() {
    return this.server?.member?.roles.includes(this.id) || false;
  }

  /**
   * Delete this role
   */
  delete() {
    return this.server!.deleteRole(this.id);
  }
}
