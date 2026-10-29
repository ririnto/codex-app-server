import { on, once } from "node:events";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { WebSocket } from "ws";
import { z } from "zod";

const REQUEST_TIMEOUT_MS = 300_000;
const rawFrame = z.union([
  z.instanceof(Buffer),
  z.instanceof(ArrayBuffer),
  z.array(z.instanceof(Buffer))
]);

/**
 * @param {import("ws").RawData} data - WebSocket frame data.
 * @returns {unknown} Parsed frame data.
 */
const parseMessage = (data) => {
  try {
    let bytes;
    if (Buffer.isBuffer(data)) {
      bytes = data;
    } else if (Array.isArray(data)) {
      bytes = Buffer.concat(data);
    } else {
      bytes = Buffer.from(data);
    }
    return JSON.parse(bytes.toString());
  } catch {
    return null;
  }
};

/**
 * Connect over the Unix control socket, perform the initialize handshake, and return a JSON-RPC client.
 * An optional abort signal closes the socket even while initialization is pending.
 * An optional notification handler receives broadcasts during initialization as well as afterward.
 * An optional ingress observer records notification metadata before serialized dispatch.
 * @param {{observeNotification?: (message: object) => unknown, onNotification?: (message: object, observation: unknown) => void | Promise<void>, signal?: AbortSignal}} [options] - Connection options.
 */
export const openClient = async ({
  observeNotification,
  onNotification,
  signal
} = {}) => {
  signal?.throwIfAborted();
  const ws = new WebSocket("ws://localhost/", {
    createConnection: () =>
      createConnection({
        path:
          (process.env.CODEX_APP_SERVER_SOCKET === undefined ||
          process.env.CODEX_APP_SERVER_SOCKET === ""
            ? undefined
            : process.env.CODEX_APP_SERVER_SOCKET) ??
          path.join(
            (process.env.CODEX_HOME === undefined ||
            process.env.CODEX_HOME === ""
              ? undefined
              : process.env.CODEX_HOME) ?? path.join(homedir(), ".codex"),
            "app-server-control",
            "app-server-control.sock"
          )
      }),
    maxPayload: 0
  });
  const events = new EventTarget();
  const closed = new AbortController();
  /**
   * @param {string} name - Event name.
   * @param {unknown} detail - Event payload.
   */
  const emit = (name, detail) =>
    events.dispatchEvent(new CustomEvent(name, { detail }));
  const fail = (error) => {
    if (!closed.signal.aborted) {
      closed.abort(error);
    }
  };
  const send = async (message) => {
    try {
      await promisify(ws.send.bind(ws))(JSON.stringify(message));
    } catch (error) {
      fail(error);
      ws.terminate();
      throw error;
    }
  };
  ws.on("error", (error) => {
    fail(error);
    ws.terminate();
  });
  const abort = () => {
    fail(signal.reason);
    ws.terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  ws.on("close", () => {
    signal?.removeEventListener("abort", abort);
    fail(new Error("App-server connection closed"));
  });
  let nextId = 0;
  let notify = onNotification;
  /** @type {WeakMap<object, unknown>} */
  const ingress = new WeakMap();
  /**
   * @param {import("ws").RawData} data - Original frame data.
   * @param {(message: object) => unknown} observe - Ingress observer.
   */
  const capture = (data, observe) => {
    const message = parseMessage(data);
    if (message !== null && typeof message === "object" && !("id" in message)) {
      ingress.set(data, observe(message));
    }
  };
  /** @param {(message: object) => unknown} [observe] - Ingress observer. */
  const subscribeIngress = (observe) => {
    let unsubscribe;
    if (observe !== undefined) {
      /** @param {import("ws").RawData} data - WebSocket frame. */
      const listener = (data) => {
        capture(data, observe);
      };
      ws.on("message", listener);
      unsubscribe = () => {
        ws.removeListener("message", listener);
      };
    }
    return unsubscribe;
  };
  const removeInitialObserver = subscribeIngress(observeNotification);
  const messages = on(ws, "message", {
    highWaterMark: 1,
    lowWaterMark: 1,
    signal: closed.signal
  });
  const receive = async () => {
    try {
      for await (const [data] of messages) {
        /** @type {unknown} */
        const original = data;
        const frame = rawFrame.safeParse(original);
        if (
          frame.success &&
          original !== null &&
          typeof original === "object"
        ) {
          const message = parseMessage(frame.data);
          if (message === null || typeof message !== "object") {
            continue;
          }
          if (
            "id" in message &&
            (typeof message.id === "string" ||
              typeof message.id === "number") &&
            ("result" in message || "error" in message)
          ) {
            emit(`response:${message.id}`, message);
          } else if ("id" in message && "method" in message) {
            try {
              await send({
                error: { code: -32_601, message: "not handled by this client" },
                id: message.id
              });
            } catch (error) {
              fail(error);
            }
          } else {
            emit("notification", message);
            await notify?.(message, ingress.get(original));
          }
        }
      }
    } catch (error) {
      if (!closed.signal.aborted) {
        fail(error);
        ws.terminate();
      }
    }
  };
  void receive();
  /**
   * @param {string} method - Native method.
   * @param {unknown} params - Native method parameters.
   * @param {{signal?: AbortSignal}} [options] - Request cancellation.
   */
  const request = async (method, params, { signal: requestAbort } = {}) => {
    closed.signal.throwIfAborted();
    requestAbort?.throwIfAborted();
    nextId += 1;
    const id = nextId;
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      closed.signal,
      ...(requestAbort ? [requestAbort] : [])
    ]);
    /** @type {unknown} */
    let result;
    try {
      const [response] = await Promise.all([
        once(events, `response:${id}`, { signal: requestSignal }),
        send({
          id,
          method,
          ...(params === undefined ? {} : { params })
        })
      ]);
      const [event] = z.tuple([z.instanceof(CustomEvent)]).parse(response);
      const message = z
        .looseObject({
          error: z.looseObject({}).nullish(),
          result: z.unknown().optional()
        })
        .parse(event.detail);
      if (message.error !== undefined && message.error !== null) {
        throw new Error(`${method}: ${JSON.stringify(message.error)}`);
      }
      ({ result } = message);
    } catch (error) {
      throw closed.signal.aborted ? closed.signal.reason : error;
    }
    return result;
  };
  try {
    await once(ws, "open", { signal: closed.signal });
    await request("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "orchestrator-codex-app-server-mcp",
        title: "Orchestrator MCP client",
        version: "1"
      }
    });
    await send({ method: "initialized" });
    return {
      close: () => {
        removeInitialObserver?.();
        ws.close();
      },
      events,
      /** @param {(message: object, observation: unknown) => void | Promise<void>} handler - Notification handler.
       * @param {(message: object) => unknown} [observe] - Ingress observer.
       */
      listenNotifications: (handler, observe) => {
        const removeObserver = subscribeIngress(observe);
        notify = handler;
        return () => {
          removeObserver?.();
          notify = undefined;
        };
      },
      request,
      signal: closed.signal
    };
  } catch (error) {
    removeInitialObserver?.();
    ws.terminate();
    throw closed.signal.aborted ? closed.signal.reason : error;
  }
};

/**
 * Wrap a tool handler so it runs with its own app-server connection and returns MCP text content.
 * @template T
 * @param {(client: Awaited<ReturnType<typeof openClient>>, args: T) => unknown} handler - Native request handler.
 * @returns {(args: T, extra?: {signal?: AbortSignal}) => Promise<{content: {text: string | undefined, type: string}[], isError?: boolean}>} Wrapped MCP handler.
 */
export const withClient = (handler) => async (args, extra) => {
  let client;
  let result;
  try {
    client = await openClient({ signal: extra?.signal });
    const value = await handler(client, args);
    result = {
      content: [{ text: JSON.stringify(value ?? null, null, 1), type: "text" }]
    };
  } catch (error) {
    result = {
      content: [
        {
          text:
            error instanceof Error ? error.message : "Native request failed",
          type: "text"
        }
      ],
      isError: true
    };
  } finally {
    client?.close();
  }
  return result;
};
