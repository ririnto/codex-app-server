import { on } from "node:events";

import { z } from "zod";

import { nativeNotification } from "./native-schema.mjs";

const startedTurn = z.looseObject({
  turn: z.looseObject({ id: z.string() })
});

/**
 * Wait for the turn's completion and collect its final agent message until the deadline.
 * @param {Awaited<ReturnType<typeof import("./connection.mjs").openClient>>} client - Native client.
 * @param {AsyncIterable<unknown[]>} notifications - Buffered notifications.
 * @param {string} turnId - Turn identifier.
 * @param {number} waitSeconds - Completion deadline.
 * @param {AbortController} waiting - Wait lifetime.
 */
const awaitTurn = async (
  client,
  notifications,
  turnId,
  waitSeconds,
  waiting
) => {
  /** @type {{finalMessage: string | null, status: string, turnId: string}} */
  const result = { finalMessage: null, status: "waitTimedOut", turnId };
  const timer = setTimeout(() => {
    waiting.abort();
  }, waitSeconds * 1000);
  try {
    for await (const [event] of notifications) {
      if (!(event instanceof CustomEvent)) {
        continue;
      }
      const parsed = nativeNotification.safeParse(event.detail);
      if (!parsed.success) {
        continue;
      }
      const note = parsed.data;
      const params = note.params ?? {};
      if (
        note.method === "item/completed" &&
        (params.turnId ?? turnId) === turnId &&
        params.item?.type === "agentMessage"
      ) {
        result.finalMessage = params.item.text ?? null;
      }
      if (note.method === "turn/completed" && params.turn?.id === turnId) {
        return {
          ...result,
          ...(params.turn.error ? { error: params.turn.error } : {}),
          status: params.turn.status
        };
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
  return client.signal.aborted
    ? { ...result, status: "connectionClosed" }
    : result;
};

/**
 * Start one turn with completion notifications buffered before the request is sent.
 * Release the caller's optional writer after acknowledgment, before waiting for completion.
 * @param {Awaited<ReturnType<typeof import("./connection.mjs").openClient>>} client - Native client.
 * @param {string} threadId - Thread identifier.
 * @param {string} text - Authorized message.
 * @param {number} [waitSeconds] - Completion deadline.
 * @param {(() => void) | null} [onStarted] - Acknowledgement callback.
 */
export const startTurn = async (
  client,
  threadId,
  text,
  waitSeconds = 0,
  onStarted = null
) => {
  const waiting = new AbortController();
  const notifications =
    waitSeconds > 0
      ? on(client.events, "notification", {
          signal: AbortSignal.any([waiting.signal, client.signal])
        })
      : null;
  try {
    const started = startedTurn.parse(
      await client.request("turn/start", {
        input: [{ text, type: "text" }],
        threadId
      })
    );
    const turnId = started.turn.id;
    onStarted?.();
    return notifications
      ? await awaitTurn(client, notifications, turnId, waitSeconds, waiting)
      : { finalMessage: null, status: "started", turnId };
  } finally {
    await notifications?.return?.();
  }
};
