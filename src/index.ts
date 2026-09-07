export * as API from "stoat-api";
export { Client } from "./Client.js";
export type { ClientOptions, Session as PrivateSession } from "./Client.js";
export * from "./classes/index.js";
export * from "./collections/index.js";
export { ConnectionState, EventClient } from "./events/EventClient.js";
// REST payloads rather than protocol events, but they live in v1.ts beside
// ConsentState for the same reason: they belong to the consent gate. Exported
// by name because the client imports them directly rather than through
// ProtocolV1["types"], which only carries things that arrive over the socket.
export type {
  DiscordIdentityClaim,
  DiscordMemberSearch,
  DiscordMemberSuggestion,
} from "./events/v1.js";
export { BotFlags } from "./hydration/bot.js";
export { ServerFlags } from "./hydration/server.js";
export { UserBadges, UserFlags } from "./hydration/user.js";
export * from "./lib/regex.js";
export * from "./permissions/definitions.js";
