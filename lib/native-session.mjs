import { openClient, withClient } from "./connection.mjs";

/**
 * Own connection-scoped command and watch resources until their native operation or MCP session ends.
 * Command output remains in its result; watch changes use standard MCP logging without retaining history.
 */
export const createNativeSessions = (server) => {
  const commands = new Map();
  const watches = new Map();
  const lifetime = new AbortController();
  const connect = (signal) => {
    lifetime.signal.throwIfAborted();
    return openClient({ signal });
  };
  const command = async (method, params, extra) => {
    if (method !== "command/exec") {
      const pending = commands.get(params.processId);
      if (!pending) {
        throw new Error("No active command connection for this processId");
      }
      const client = await pending;
      return client.request(method, params, { signal: extra?.signal });
    }
    if (params.processId && commands.has(params.processId)) {
      throw new Error("A command already owns this processId");
    }
    const pending = connect(extra?.signal);
    if (params.processId) {
      commands.set(params.processId, pending);
    }
    let client;
    const notifications = [];
    let response;
    const receive = ({ detail }) => {
      if (
        detail.method === "command/exec/outputDelta" &&
        detail.params.processId === params.processId
      ) {
        notifications.push(detail);
      }
    };
    try {
      client = await pending;
      client.events.addEventListener("notification", receive);
      const result = await client.request(method, params, {
        signal: extra?.signal
      });
      response = notifications.length ? { ...result, notifications } : result;
    } finally {
      if (commands.get(params.processId) === pending) {
        commands.delete(params.processId);
      }
      client?.events.removeEventListener("notification", receive);
      client?.close();
    }
    return response;
  };
  const watch = async (method, params, extra) => {
    let pending = watches.get(params.watchId);
    if (!pending && method === "fs/unwatch") {
      throw new Error("No active filesystem connection for this watchId");
    }
    const created = !pending;
    if (created) {
      pending = connect(extra?.signal);
      watches.set(params.watchId, pending);
    }
    let client;
    let result;
    try {
      client = await pending;
      if (created) {
        const receive = async (detail) => {
          if (
            detail.method === "fs/changed" &&
            detail.params.watchId === params.watchId
          ) {
            try {
              await server.sendLoggingMessage({
                data: detail,
                level: "info",
                logger: "codex-app-server"
              });
            } catch (error) {
              console.error(
                `codex-app-server: watch notification failed: ${error.message}`
              );
            }
          }
        };
        const unsubscribe = client.listenNotifications(receive);
        client.signal.addEventListener(
          "abort",
          () => {
            unsubscribe();
            if (watches.get(params.watchId) === pending) {
              watches.delete(params.watchId);
            }
          },
          { once: true }
        );
      }
      result = await client.request(method, params, {
        signal: extra?.signal
      });
      if (method === "fs/unwatch") {
        watches.delete(params.watchId);
        client.close();
      }
    } catch (error) {
      if (created) {
        watches.delete(params.watchId);
        client?.close();
      }
      throw error;
    }
    return result;
  };
  return {
    close: () => {
      lifetime.abort(new Error("Native MCP session is closed"));
      commands.clear();
      watches.clear();
    },
    request: async (method, params, extra) => {
      const context = {
        signal: AbortSignal.any([
          lifetime.signal,
          ...(extra?.signal ? [extra.signal] : [])
        ])
      };
      context.signal.throwIfAborted();
      let result;
      if (
        [
          "command/exec",
          "command/exec/write",
          "command/exec/resize",
          "command/exec/terminate"
        ].includes(method)
      ) {
        const value = await command(method, params, context);
        result = {
          content: [
            { text: JSON.stringify(value ?? null, null, 1), type: "text" }
          ]
        };
      } else if (method === "fs/watch" || method === "fs/unwatch") {
        const value = await watch(method, params, context);
        result = {
          content: [
            { text: JSON.stringify(value ?? null, null, 1), type: "text" }
          ]
        };
      } else {
        result = withClient((client) =>
          client.request(method, params, { signal: context.signal })
        )(undefined, context);
      }
      return result;
    }
  };
};
