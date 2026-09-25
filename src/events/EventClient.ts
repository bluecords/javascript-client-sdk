import type { Accessor, Setter } from "solid-js";
import { createSignal } from "solid-js";

import { AsyncEventEmitter } from "@vladfrangu/async_event_emitter";
import { JSONParse, JSONStringify } from "json-with-bigint";
import type { Error } from "stoat-api";

import type { ProtocolV1 } from "./v1.js";

/**
 * Available protocols to connect with
 */
export type AvailableProtocols = 1;

/**
 * Protocol mapping
 */
type Protocols = {
  1: ProtocolV1;
};

/**
 * Select a protocol by its key
 */
export type EventProtocol<T extends AvailableProtocols> = Protocols[T];

/**
 * All possible event client states.
 */
export enum ConnectionState {
  Idle,
  Connecting,
  Connected,
  Disconnected,
}

/**
 * Event client options object
 */
export interface EventClientOptions {
  /**
   * Whether to log events
   * @default false
   */
  debug: boolean;

  /**
   * Time in seconds between Ping packets sent to the server
   * @default 30
   */
  heartbeatInterval: number;

  /**
   * Maximum time in seconds between Ping and corresponding Pong
   * @default 10
   */
  pongTimeout: number;

  /**
   * Maximum time in seconds between init and first message
   * @default 10
   */
  connectTimeout: number;
}

/**
 * Events provided by the client.
 */
type Events<T extends AvailableProtocols, P extends EventProtocol<T>> = {
  error: [error: Error];
  event: [event: P["server"]];
  state: [state: ConnectionState];
};

/**
 * Simple wrapper around the Revolt websocket service.
 */
export class EventClient<
  T extends AvailableProtocols,
> extends AsyncEventEmitter<Events<T, EventProtocol<T>>> {
  readonly options: EventClientOptions;

  #protocolVersion: T;
  #transportFormat: "json" | "msgpack";

  readonly ping: Accessor<number>;
  #setPing: Setter<number>;

  readonly state: Accessor<ConnectionState>;
  #setStateSetter: Setter<ConnectionState>;

  #socket: WebSocket | undefined;
  #heartbeatIntervalReference: number | undefined;
  #pongTimeoutReference: number | undefined;
  #connectTimeoutReference: number | undefined;

  /**
   * Why the previous connection ended. Sent as query parameters on the next
   * connect so the server's access log records it - there is no other way to
   * learn why a member's client dropped (added 2026-09-25: members were seeing
   * "Reconnecting" up to ~177 times an hour and every drop reached the server
   * as a plain close with no reason attached). Holds no user data.
   */
  #lastDrop: Record<string, string> | undefined;
  #openedAt: number | undefined;
  #lastMessageAt: number | undefined;

  #lastError: // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { type: "socket"; data: any } | { type: "revolt"; data: Error } | undefined;

  /**
   * Create a new event client.
   * @param protocolVersion Target protocol version
   * @param transportFormat Communication format
   * @param options Configuration options
   */
  constructor(
    protocolVersion: T,
    transportFormat: "json" = "json",
    options?: Partial<EventClientOptions>,
  ) {
    super();

    this.#protocolVersion = protocolVersion;
    this.#transportFormat = transportFormat;

    this.options = {
      heartbeatInterval: 30,
      pongTimeout: 10,
      connectTimeout: 10,
      debug: false,
      ...options,
    };

    const [state, setState] = createSignal(ConnectionState.Idle);
    this.state = state;
    this.#setStateSetter = setState;

    const [ping, setPing] = createSignal(-1);
    this.ping = ping;
    this.#setPing = setPing;

    this.disconnect = this.disconnect.bind(this);
  }

  /**
   * Set the current state
   * @param state state
   */
  private setState(state: ConnectionState): void {
    this.#setStateSetter(state);
    this.emit("state", state);
  }

  /**
   * Connect to the websocket service.
   * @param uri WebSocket URI
   * @param token Authentication token
   */
  connect(uri: string, token: string): void {
    this.disconnect("reconnect");
    this.#lastError = undefined;
    this.setState(ConnectionState.Connecting);

    this.#connectTimeoutReference = setTimeout(
      () => this.disconnect("connect_timeout"),
      this.options.connectTimeout * 1e3,
    ) as never;

    const url = new URL(uri);
    url.searchParams.set("version", this.#protocolVersion.toString());
    url.searchParams.set("format", this.#transportFormat);
    url.searchParams.set("token", token);

    const drop = this.#lastDrop;
    this.#lastDrop = undefined;
    if (drop) {
      for (const [key, value] of Object.entries(drop)) {
        url.searchParams.set(key, value);
      }
    }
    this.#openedAt = undefined;
    this.#lastMessageAt = undefined;

    // todo: pass-through ts as a configuration option
    // todo: then remove /settings/fetch from web client
    // todo: do the same for unreads
    // url.searchParams.append("ready", "users");
    // url.searchParams.append("ready", "servers");
    // url.searchParams.append("ready", "channels");
    // url.searchParams.append("ready", "members");
    // url.searchParams.append("ready", "emojis");
    // url.searchParams.append("ready", "voice_states");
    // url.searchParams.append("ready", "user_settings[ordering]");
    // url.searchParams.append("ready", "user_settings[notifications]");
    // url.searchParams.append("ready", "unreads or something");
    // url.searchParams.append("ready", "policy_changes");

    this.#socket = new WebSocket(url);

    this.#socket.onopen = () => {
      this.#openedAt = Date.now();
      this.#heartbeatIntervalReference = setInterval(() => {
        const sentAt = Date.now();
        this.send({ type: "Ping", data: sentAt });
        // Never leave an earlier pong timeout running unreferenced.
        clearTimeout(this.#pongTimeoutReference);
        this.#pongTimeoutReference = setTimeout(
          () =>
            this.disconnect("pong_timeout", {
              // How long after the Ping this timer actually ran (10s if on
              // time; a background tab can run it much later).
              dc_waited: String(Math.round((Date.now() - sentAt) / 1e3)),
              // Whether ANY message arrived after the Ping. If yes, the
              // connection was alive and the timeout was a false alarm.
              dc_heard: String(
                this.#lastMessageAt !== undefined &&
                  this.#lastMessageAt >= sentAt,
              ),
            }),
          this.options.pongTimeout * 1e3,
        ) as never;
      }, this.options.heartbeatInterval * 1e3) as never;
    };

    this.#socket.onerror = (error) => {
      this.#lastError = { type: "socket", data: error };
      this.emit("error", error as never);
    };

    this.#socket.onmessage = (event) => {
      clearInterval(this.#connectTimeoutReference);
      this.#lastMessageAt = Date.now();

      if (this.#transportFormat === "json") {
        if (typeof event.data === "string") {
          this.handle(JSONParse(event.data));
        }
      }
    };

    let closed = false;
    const socket = this.#socket;
    socket.onclose = (event) => {
      if (closed) return;
      closed = true;
      // A late close from an OLD socket, after connect() already opened a
      // new one, must not tear down the new connection's state or timers.
      if (this.#socket !== undefined && this.#socket !== socket) return;
      // Only a close we did not start ourselves: disconnect() detaches the
      // socket first, so this.#socket no longer points at it.
      if (this.#socket === socket) {
        this.#recordDrop("closed", { dc_code: String(event.code) });
      }
      this.#socket = undefined;
      this.setState(ConnectionState.Disconnected);
      this.disconnect("closed");
    };
  }

  /**
   * Remember why the current connection ended, for the next connect.
   * @param reason Short machine-readable reason
   * @param extra Additional query parameters
   */
  #recordDrop(reason: string, extra: Record<string, string> = {}): void {
    const now = Date.now();
    this.#lastDrop = {
      dc: reason,
      // Seconds the connection had been open (empty if it never opened).
      dc_up:
        this.#openedAt === undefined
          ? ""
          : String(Math.round((now - this.#openedAt) / 1e3)),
      dc_vis: typeof document === "undefined" ? "" : document.visibilityState,
      dc_online:
        typeof navigator === "undefined" ? "" : String(navigator.onLine),
      ...extra,
    };
  }

  /**
   * Disconnect the websocket client.
   * @param reason Why (recorded for diagnostics); "client" when the app asks
   * @param extra Additional diagnostic query parameters
   */
  disconnect(
    reason: string = "client",
    extra: Record<string, string> = {},
  ): void {
    // Timers are cleared BEFORE the early return. They used to be cleared
    // only when a socket was still attached - but onclose detaches the
    // socket first, so every connection the SERVER or network ended left its
    // heartbeat interval running forever. After the reconnect that orphan
    // kept pinging on the new socket alongside the new interval, and in a
    // background tab (where Chrome runs timers together at one wake-up a
    // minute) the two pings overwrote each other's pong timeout, so a
    // healthy connection "timed out" and was dropped - the Reconnecting
    // banner, up to ~177 times an hour on a computer left open (2026-09-25).
    clearInterval(this.#heartbeatIntervalReference);
    clearTimeout(this.#connectTimeoutReference);
    clearTimeout(this.#pongTimeoutReference);
    this.#heartbeatIntervalReference = undefined;
    this.#connectTimeoutReference = undefined;
    this.#pongTimeoutReference = undefined;

    if (!this.#socket) return;
    // disconnect is bound in the constructor so it can be passed around as a
    // callback; if an event object arrives here, it was the app asking.
    if (typeof reason !== "string") reason = "client";
    if (reason !== "closed") this.#recordDrop(reason, extra);
    const socket = this.#socket;
    this.#socket = undefined;
    socket.close();
  }

  /**
   * Send an event to the server.
   * @param event Event
   */
  send(event: EventProtocol<T>["client"]): void {
    if (this.options.debug) console.debug("[C->S]", event);
    if (!this.#socket) throw "Socket closed, trying to send.";
    this.#socket.send(JSONStringify(event));
  }

  /**
   * Handle events intended for client before passing them along.
   * @param event Event
   */
  handle(event: EventProtocol<T>["server"]): void {
    if (this.options.debug) console.debug("[S->C]", event);
    switch (event.type) {
      case "Ping":
        this.send({
          type: "Pong",
          data: event.data,
        });
        return;
      case "Pong":
        clearTimeout(this.#pongTimeoutReference);
        this.#setPing(+new Date() - event.data);
        if (this.options.debug) console.debug(`[ping] ${this.ping()}ms`);
        return;
      case "Error":
        this.#lastError = {
          type: "revolt",
          data: event.data,
        };
        this.emit("error", event as never);
        this.disconnect("server_error", {
          dc_error: String((event.data as { type?: string })?.type ?? ""),
        });
        return;
    }

    switch (this.state()) {
      case ConnectionState.Connecting:
        if (event.type === "Authenticated") {
          // no-op
        } else if (event.type === "Ready") {
          this.emit("event", event);
          this.setState(ConnectionState.Connected);
        } else {
          throw `Unreachable code. Received ${event.type} in Connecting state.`;
        }
        break;
      case ConnectionState.Connected:
        if (event.type === "Authenticated" || event.type === "Ready") {
          throw `Unreachable code. Received ${event.type} in Connected state.`;
        } else {
          this.emit("event", event);
        }
        break;
      default:
        throw `Unreachable code. Received ${event.type} in state ${this.state()}.`;
    }
  }

  /**
   * Last error encountered by events client
   */
  get lastError():
    | {
        type: "socket";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: any;
      }
    | {
        type: "revolt";
        data: Error;
      }
    | undefined {
    return this.#lastError;
  }
}
