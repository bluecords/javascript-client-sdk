import { batch } from "solid-js";
import { ReactiveSet } from "@solid-primitives/set";

import type { ChannelUnread as APIChannelUnread } from "stoat-api";

import { ChannelUnread } from "../classes/ChannelUnread.js";
import { Channel } from "../classes/index.js";
import type { HydratedChannelUnread } from "../hydration/channelUnread.js";

import { ClassCollection } from "./Collection.js";

/**
 * Collection of Channel Unreads
 */
export class ChannelUnreadCollection extends ClassCollection<
  ChannelUnread,
  HydratedChannelUnread
> {
  /**
   * Load unread information from server
   *
   * This runs on every "Ready" event, i.e. every websocket (re)connect --
   * not just initial load. Channel.ack() updates local state immediately
   * but debounces the actual PUT to the server by ~1.5s. If a reconnect
   * happens in that window (flaky connection, tab backgrounded/resumed,
   * etc.), the previous reset()-then-rebuild-from-server logic here
   * clobbered the optimistic local "read" state with the server's
   * momentarily-stale snapshot, making a channel the user just read look
   * unread again -- repeatedly, until enough time passed (e.g. a full page
   * reload, by which point the debounced ack had landed) for the server's
   * own data to catch up. Merge instead of reset: never let a resync
   * regress a channel from read back to unread.
   */
  async sync(): Promise<void> {
    const unreads = await this.client.api.get("/sync/unreads");
    batch(() => {
      for (const unread of unreads) {
        const id = unread._id.channel;
        const incomingLastMessageId = unread.last_id ?? undefined;
        const existing = this.get(id);

        if (existing) {
          if (
            incomingLastMessageId &&
            (existing.lastMessageId ?? "0").localeCompare(
              incomingLastMessageId,
            ) >= 0
          ) {
            // Local state is already at least as "read" as the server
            // thinks -- keep it, don't regress.
            continue;
          }

          this.updateUnderlyingObject(
            id,
            "lastMessageId",
            incomingLastMessageId,
          );
          this.updateUnderlyingObject(
            id,
            "messageMentionIds",
            new ReactiveSet(unread.mentions ?? []),
          );
        } else {
          this.getOrCreate(id, unread);
        }
      }
    });
  }

  /**
   * Clear all unread data
   */
  reset(): void {
    this.updateUnderlyingObject({});
  }

  /**
   * Get or create
   * @param id Id
   * @param data Data
   */
  getOrCreate(id: string, data: APIChannelUnread): ChannelUnread {
    if (this.has(id)) {
      return this.get(id)!;
    } else {
      const instance = new ChannelUnread(this, id);
      this.create(id, "channelUnread", instance, this.client, data);
      return instance;
    }
  }

  /**
   * Get channel unread data for a specific Channel
   * @param channel Channel
   * @returns Unread
   */
  for(channel: Channel): ChannelUnread {
    return this.getOrCreate(channel.id, {
      _id: {
        channel: channel.id,
        user: this.client.user!.id,
      },
      last_id: null,
      mentions: [],
    });
  }
}
