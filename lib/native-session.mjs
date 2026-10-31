import { z } from "zod";

import { openClient, withClient } from "./connection.mjs";

const commandParams = z.looseObject({ processId: z.string().nullish() });
const watchParams = z.looseObject({ watchId: z.string() });
const commandOutput = z.looseObject({
  method: z.string(),
  params: z.looseObject({ processId: z.string().optional() })
});
const watchChange = z.looseObject({
  method: z.string(),
  params: z.looseObject({ watchId: z.string() })
});

/**
 * Own connection-scoped command and watch resources until their native operation or MCP session ends.
 * Command output remains in its result; watch changes use standard MCP logging without retaining history.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer["server"]} server - MCP server.
 */
export const createNativeSessions = (server) => {
  /** @type {Map<string, Promise<Awaited<ReturnType<typeof openClient>>>>} */
  const commands = new Map();
  /** @type {Map<string, Promise<Awaited<ReturnType<typeof openClient>>>>} */
  const watches = new Map();
  const lifetime = new AbortController();
  /** @param {AbortSignal} [signal] - Native operation cancellation. */
  const connect = async (signal) => {
    lifetime.signal.throwIfAborted();
    return await openClient({ signal });
  };
  /**
   * @param {string} method - Command method.
   * @param {z.infer<typeof commandParams>} params - Command parameters.
   * @param {{signal?: AbortSignal}} [extra] - Operation context.
   */
  const command = async (method, params, extra) => {
    if (method !== "command/exec") {
      const pending =
        typeof params.processId === "string"
          ? commands.get(params.processId)
          : undefined;
      if (!pending) {
        throw new Error("No active command connection for this processId");
      }
      const client = await pending;
      return await client.request(method, params, { signal: extra?.signal });
    }
    if (
      typeof params.processId === "string" &&
      params.processId !== "" &&
      commands.has(params.processId)
    ) {
      throw new Error("A command already owns this processId");
    }
    const pending = connect(extra?.signal);
    if (typeof params.processId === "string" && params.processId !== "") {
      commands.set(params.processId, pending);
    }
    let client;
    /** @type {z.infer<typeof commandOutput>[]} */
    const notifications = [];
    let response;
    /** @param {Event} event - Native notification event. */
    const receive = (event) => {
      const parsed = commandOutput.safeParse(
        event instanceof CustomEvent ? event.detail : undefined
      );
      if (
        parsed.success &&
        parsed.data.method === "command/exec/outputDelta" &&
        parsed.data.params.processId === params.processId
      ) {
        notifications.push(parsed.data);
      }
    };
    try {
      client = await pending;
      client.events.addEventListener("notification", receive);
      const result = await client.request(method, params, {
        signal: extra?.signal
      });
      response = notifications.length
        ? { ...z.record(z.string(), z.unknown()).parse(result), notifications }
        : result;
    } finally {
      if (
        typeof params.processId === "string" &&
        commands.get(params.processId) === pending
      ) {
        commands.delete(params.processId);
      }
      client?.events.removeEventListener("notification", receive);
      client?.close();
    }
    return response;
  };
  /**
   * @param {string} method - Watch method.
   * @param {z.infer<typeof watchParams>} params - Watch parameters.
   * @param {{signal?: AbortSignal}} [extra] - Operation context.
   */
  const watch = async (method, params, extra) => {
    let pending = watches.get(params.watchId);
    if (!pending && method === "fs/unwatch") {
      throw new Error("No active filesystem connection for this watchId");
    }
    const created = !pending;
    if (!pending) {
      pending = connect(extra?.signal);
      watches.set(params.watchId, pending);
    }
    let client;
    let result;
    try {
      client = await pending;
      if (created) {
        /** @param {object} detail - Native notification. */
        const receive = async (detail) => {
          const parsed = watchChange.safeParse(detail);
          if (
            parsed.success &&
            parsed.data.method === "fs/changed" &&
            parsed.data.params.watchId === params.watchId
          ) {
            try {
              await server.sendLoggingMessage({
                data: parsed.data,
                level: "info",
                logger: "codex-app-server"
              });
            } catch (error) {
              console.error(
                `codex-app-server: watch notification failed: ${error instanceof Error ? error.message : String(error)}`
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
    /**
     * Dispatch a native request on its connection-scoped lifecycle.
     * @param {string} method - Native method.
     * @param {unknown} params - Validated method parameters.
     * @param {{signal?: AbortSignal}} [extra] - Operation context.
     */
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
        const value = await command(
          method,
          commandParams.parse(params),
          context
        );
        result = {
          content: [
            { text: JSON.stringify(value ?? null, null, 1), type: "text" }
          ]
        };
      } else if (method === "fs/watch" || method === "fs/unwatch") {
        const value = await watch(method, watchParams.parse(params), context);
        result = {
          content: [
            { text: JSON.stringify(value ?? null, null, 1), type: "text" }
          ]
        };
      } else {
        result = withClient(
          async (client) =>
            await client.request(method, params, { signal: context.signal })
        )(undefined, context);
      }
      return await result;
    }
  };
};
