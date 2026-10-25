import { on, once } from "node:events";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { WebSocket } from "ws";

const REQUEST_TIMEOUT_MS = 300_000;

/** Parse a native frame, treating malformed JSON as an ignored message. */
const parseMessage = (data) => {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
};

/**
 * Connect over the Unix control socket, perform the initialize handshake, and return a JSON-RPC client.
 * An optional abort signal closes the socket even while initialization is pending.
 * An optional notification handler receives broadcasts during initialization as well as afterward.
 * Synchronous notification ingress observers return metadata passed to serialized notification handlers.
 */
export const openClient = async ({ onNotification, signal } = {}) => {
  signal?.throwIfAborted();
  const ws = new WebSocket("ws://localhost/", {
    createConnection: () =>
      createConnection({
        path:
          process.env.CODEX_APP_SERVER_SOCKET ||
          path.join(
            process.env.CODEX_HOME || path.join(homedir(), ".codex"),
            "app-server-control",
            "app-server-control.sock"
          )
      }),
    maxPayload: 0
  });
  const events = new EventTarget();
  const closed = new AbortController();
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
  const ingress = new WeakMap();
  const messages = on(ws, "message", {
    highWaterMark: 1,
    lowWaterMark: 1,
    signal: closed.signal
  });
  const receive = async () => {
    try {
      for await (const [data] of messages) {
        const message = parseMessage(data);
        if (message !== null && typeof message === "object") {
          if ("id" in message && ("result" in message || "error" in message)) {
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
            await notify?.(message, ingress.get(data));
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
  receive();
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
    let result;
    try {
      const [[{ detail: message }]] = await Promise.all([
        once(events, `response:${id}`, { signal: requestSignal }),
        send({
          id,
          method,
          ...(params === undefined ? {} : { params })
        })
      ]);
      if (message.error) {
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
      close: () => ws.close(),
      events,
      listenNotifications: (handler, observe) => {
        const capture = (data) => {
          const message = parseMessage(data);
          if (
            message !== null &&
            typeof message === "object" &&
            !("id" in message)
          ) {
            ingress.set(data, observe(message));
          }
        };
        if (observe) {
          ws.on("message", capture);
        }
        notify = handler;
        return () => {
          ws.removeListener("message", capture);
          notify = undefined;
        };
      },
      request,
      signal: closed.signal
    };
  } catch (error) {
    ws.terminate();
    throw closed.signal.aborted ? closed.signal.reason : error;
  }
};

/**
 * Wrap a tool handler so it runs with its own app-server connection and returns MCP text content.
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
      content: [{ text: error.message, type: "text" }],
      isError: true
    };
  } finally {
    client?.close();
  }
  return result;
};
