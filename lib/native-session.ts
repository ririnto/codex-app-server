import { z } from "zod";

import { openClient, withClient } from "#lib/connection";

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
 * Command output remains in its result.
 * Watch changes use standard MCP logging without retaining history.
 */
export const createNativeSessions = (
  server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer["server"]
) => {
  const commands = new Map<
    string,
    Promise<Awaited<ReturnType<typeof openClient>>>
  >();
  const watches = new Map<
    string,
    Promise<Awaited<ReturnType<typeof openClient>>>
  >();
  const lifetime = new AbortController();
  const connect = async (signal?: AbortSignal) => {
    lifetime.signal.throwIfAborted();
    return await openClient({ signal });
  };
  const command = async (
    method: string,
    params: z.infer<typeof commandParams>,
    extra?: { signal?: AbortSignal }
  ) => {
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
    const notifications: z.infer<typeof commandOutput>[] = [];
    let response;
    const receive = (event: Event) => {
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
  const watch = async (
    method: string,
    params: z.infer<typeof watchParams>,
    extra?: { signal?: AbortSignal }
  ) => {
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
        const receive = async (detail: object) => {
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
     */
    request: async (
      method: string,
      params: unknown,
      extra?: { signal?: AbortSignal }
    ) => {
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
